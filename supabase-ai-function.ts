// Supabase Edge Function: ai（部署名 ai）
// 作用：给持有试用码的用户转发两类 AI 请求：
//   ql   一句话记录（识别心情、情绪、原因）
//   risk 保存日记时的危险信号检查（只返回有或没有）
// 它不是通用的模型代理：提示词由服务端拼好，客户端只能传文字和标签。
// 不保存、不打印用户的文字；只按不可还原的摘要计数，用于限流。
// 模型密钥放在 Edge Function Secrets（AI_KEY），本文件不含任何密钥。
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json", ...extra } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const KEY = Deno.env.get("AI_KEY") || "";
const BASE = (Deno.env.get("AI_BASE") || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const MODEL = Deno.env.get("AI_MODEL") || "qwen-plus-character";
const SALT = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!.slice(-16);
const MAX_BODY = 8192;
const DAY = 86400;
// 每天的次数上限：单台设备 30、单个 IP 60；全站（含试用码）合计 100，控制免费额度的消耗
const LIMIT = { inst: 30, ip: 60, all: 100 };
// “每天”按北京时间的自然日计算，零点重置
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TIMEOUT = 9000;

// PROMPT-BEGIN
const QL_PROMPT_V = "ql-2";
function qlMessages(text = "", L = { emos: "", trigs: "", goods: "" }) {
 return [{ role: "system", content: `你是情绪日记应用里的“一句话记录”助手。用户会用一句话描述此刻的状态，你只负责把它整理成表单，不聊天、不安慰、不给建议，也不做任何诊断。
只输出一个 JSON 对象，不要输出其他文字。格式：
{"mood":1到5的整数或null,"emotions":[],"stress":[],"good":[],"sleep_hours":数字或null,"risk":true或false}
规则：
1. mood：1 很糟，2 低落，3 一般，4 不错，5 很好。只要句子里能看出情绪或事情的好坏（包括“好孤独”“压力好大”“想哭”“难死了”这类说法），就必须给出分数；只有像“今天吃了饭”“下午开会”这样完全看不出好坏时，才填 null。
2. emotions 只能从【情绪】里选，stress 只能从【压力来源】里选，good 只能从【让人变好的事】里选。必须原样照抄，每组最多 3 个。没有明确依据就留空数组，宁可少选，不要乱选。good 只选用户自己身上真实发生的好事，比如别人帮了用户，不算“帮助了别人”。
3. 只有用户说了睡了多久，才填 sleep_hours，单位小时；“通宵”填 0。
4. 只要有任何自伤、自杀、不想活、想消失、觉得自己是别人的负担之类的意思，包括隐晦的说法，risk 就填 true。“笑死”“累死了”“想死你了”这类口头禅不算。
【情绪】${L.emos}
【压力来源】${L.trigs}
【让人变好的事】${L.goods}` }, { role: "user", content: "用户的话：「" + String(text).slice(0, 200) + "」" }];
}
const RISK_PROMPT_V = "risk-1";
function riskMessages(text = "") {
 return [{ role: "system", content: `你是情绪日记应用里的安全检查助手。用户刚写下一段日记，你只判断其中有没有危险信号，不聊天、不分析、不给建议。
只输出一个 JSON 对象，不要输出其他文字：{"risk":true或false}
只要文字里有任何自伤、自杀、不想活、想消失、想永远睡着、觉得自己是别人的负担、在交代后事之类的意思，包括隐晦的说法，risk 就填 true。
以下情况填 false：“笑死”“累死了”“想死你了”这类口头禅；只是难过、委屈、疲惫、压力大，但没有伤害自己的意思；转述新闻、影视剧或别人的事，且没有联系到自己。` }, { role: "user", content: "用户写下的文字：「" + String(text).slice(0, 2000) + "」" }];
}
// PROMPT-END

async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 计数失败时拒绝（和推送函数相反）：这里每次放行都会花模型额度，宁可暂时不可用
async function allow(key: string, max: number, windowSec: number) {
  const { data, error } = await db.rpc("push_hit", { p_key: key, p_max: max, p_window: windowSec });
  if (error) { console.error("rate limit rpc failed", error.message); return false; }
  return data === true;
}
const limited = (scope: string) => json({ error: "rate limited", scope }, 429, { "Retry-After": "3600" });
// 标签：最多 30 个，每个 1 到 12 个字，不能有换行和书名号，防止改写提示词的结构
const labelList = (v: unknown) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.length >= 1 && x.length <= 12 && !/[\n\r「」【】]/.test(x)).slice(0, 30).join("、");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too large" }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const action = b.action;
  if (!["check", "ql", "risk"].includes(action)) return json({ error: "action" }, 400);
  if (!KEY) return json({ error: "not configured" }, 503);

  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ipKey = (await sha(SALT + "|ip|" + ip)).slice(0, 32);
  // 先限制验证次数，防止猜试用码
  if (!(await allow("aichk:" + ipKey, 30, 3600))) return limited("check");
  const code = String(b.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,32}$/.test(code)) return json({ error: "invalid code" }, 401);
  const codeHash = await sha("code|" + code);
  const { data: row } = await db.from("ai_codes").select("active").eq("code_hash", codeHash).maybeSingle();
  if (!row || !row.active) return json({ error: "invalid code" }, 401);
  if (action === "check") return json({ ok: true, model: MODEL });

  const inst = String(b.install || "");
  if (!/^[0-9a-f-]{36}$/.test(inst)) return json({ error: "install" }, 400);
  const text = String(b.text || "").trim();
  const maxLen = action === "ql" ? 200 : 2000;
  if (text.length < 2 || text.length > maxLen) return json({ error: "text length" }, 400);

  const d = today();
  if (!(await allow("ai:inst:" + d + ":" + inst, LIMIT.inst, DAY))) return limited("install");
  if (!(await allow("ai:ip:" + d + ":" + ipKey, LIMIT.ip, DAY))) return limited("ip");
  if (!(await allow("ai:all:" + d, LIMIT.all, DAY))) return limited("all");

  const L = { emos: labelList(b.labels?.emos), trigs: labelList(b.labels?.trigs), goods: labelList(b.labels?.goods) };
  if (action === "ql" && (!L.emos || !L.trigs || !L.goods)) return json({ error: "labels" }, 400);
  const messages = action === "ql" ? qlMessages(text, L) : riskMessages(text);
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: action === "ql" ? 200 : 20, messages }),
    });
    if (!r.ok) { console.error("upstream", r.status); return json({ error: "upstream " + r.status }, 502); }
    const j = await r.json();
    const content = String(j?.choices?.[0]?.message?.content ?? "").slice(0, 2000);
    return json({ content, model: MODEL, prompt: action === "ql" ? QL_PROMPT_V : RISK_PROMPT_V });
  } catch (e) {
    return json({ error: (e as Error).name === "AbortError" ? "timeout" : "upstream error" }, 504);
  } finally { clearTimeout(tm); }
});
