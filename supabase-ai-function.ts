// Supabase Edge Function: ai（部署名 ai）
// 作用：把前端整理好的周报统计和少量日记文字转发给大模型，生成个性化复盘。
// 模型密钥只放在 Edge Function Secrets 里，本文件不含任何密钥：
//   AI_API_KEY   必填，模型服务的密钥
//   AI_BASE_URL  可选，OpenAI 兼容接口地址，默认 https://api.openai.com/v1（DeepSeek、通义等兼容接口均可）
//   AI_MODEL     可选，默认 gpt-4o-mini
// 隐私：不记录请求内容；涉及自我伤害的内容不转发给模型；按 IP 摘要限流。
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json", ...extra } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MAX_BODY = 8192;
// 与前端一致的危机识别规则
const RISK_RE = [/自杀|轻生|自残|自伤|割腕|上吊|烧炭|吞药|遗书|一了百了/, /不想活|活不下去|活着(没|没有)(意思|意义)|不如死了|死了算了|想去死|我想死|好想死|真想死/, /想死(?!你|您|他|她|它|我了|人了)/, /伤害自己|结束(我的|自己的)?生命|了结(自己|生命)|消失算了|没有我.{0,6}更好/, /跳楼(?!价|大甩卖|甩卖)|跳河|跳桥/, /(一把|很多|大量|攒了?).{0,4}安眠药|安眠药.{0,6}(一把|很多|大量|全吃|都吃)/, /kill myself|suicid|self[- ]?harm|end my life|want to die/i];
const isRisk = (t: string) => RISK_RE.some((r) => r.test(t));
const SYSTEM = "你是温和、不说教的情绪陪伴者，不做医疗诊断。根据用户一周的情绪数据写一段 250 字以内的中文复盘：先共情，再指出 1–2 个规律，最后给 2 条具体、容易做到的小行动。不要使用列表符号，语气像朋友。不做诊断，不给药物或治疗建议。统计样本少时不要下确定的结论。如果内容涉及自伤、自杀或其他危险，不要分析，只表达关心，并建议立即拨打心理援助热线 12356，有立即危险时拨打 120。";

async function digest(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ai|" + s));
  return Array.from(new Uint8Array(h)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function allow(key: string, max: number, windowSec: number) {
  const { data, error } = await db.rpc("push_hit", { p_key: key, p_max: max, p_window: windowSec });
  if (error) { console.error("rate limit rpc failed", error.message); return true; }
  return data === true;
}
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? v.slice(0, maxItems).map((x) => String(x).slice(0, maxLen)) : [];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too large" }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const key = Deno.env.get("AI_API_KEY");
  if (!key) return json({ error: "not configured" }, 503);

  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (!(await allow("ai:" + (await digest(ip)), 20, 3600))) return json({ error: "rate limited" }, 429, { "Retry-After": "3600" });

  const stats = strList(b.stats, 12, 240), notes = strList(b.notes, 10, 160);
  if (!stats.length) return json({ error: "empty" }, 400);
  if ([...stats, ...notes].some(isRisk)) return json({ crisis: true });

  const base = (Deno.env.get("AI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = Deno.env.get("AI_MODEL") || "gpt-4o-mini";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(base + "/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model, temperature: 0.7, max_tokens: 600,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "本地统计：\n" + stats.join("\n") + "\n\n部分日记：\n" + (notes.join("\n") || "（无文字）") }],
      }),
    });
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content || "").trim();
    if (!text) return json({ error: "empty reply" }, 502);
    return json({ text });
  } catch (e) {
    return json({ error: (e as Error).name === "AbortError" ? "timeout" : "upstream" }, 504);
  } finally {
    clearTimeout(timer);
  }
});
