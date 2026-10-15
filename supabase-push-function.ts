// Supabase Edge Function: push（部署名 push）
// 作用：保存浏览器推送订阅、按用户设定的本地时间发送每日提醒（Web Push），以及删除云端账号。
// 防滥用：请求体积上限、按 IP 摘要和订阅地址的频率限制、订阅总量上限。
// 密钥放在数据库表 push_config（仅服务端可读），本文件不含任何密钥。
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json", ...extra } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MAX_BODY = 4096;      // 字节
const MAX_SUBS = 5000;      // 免费计划下的订阅总量上限
const TEXTS = [
  "花一分钟，记下此刻的心情吧。",
  "今天过得怎么样？不用写很多，一个表情也行。",
  "给自己一点安静的时间，看看现在的感受。",
  "如果今天有点累，也可以只记一句话。",
];

async function config() {
  const { data } = await db.from("push_config").select("k,v");
  const m: Record<string, string> = {};
  (data || []).forEach((r: { k: string; v: string }) => (m[r.k] = r.v));
  return m;
}
const localOf = (tz: number) => {
  const d = new Date(Date.now() - tz * 60000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const clamp = (n: unknown, lo: number, hi: number, d: number) =>
  Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.trunc(Number(n)))) : d;

// 只保存不可还原的摘要，不保存原始 IP 或推送地址
async function digest(s: string, salt: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + s));
  return Array.from(new Uint8Array(h)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 返回 true 表示允许；数据库函数异常时放行（可用性优先），并记录日志
async function allow(key: string, max: number, windowSec: number) {
  const { data, error } = await db.rpc("push_hit", { p_key: key, p_max: max, p_window: windowSec });
  if (error) { console.error("rate limit rpc failed", error.message); return true; }
  return data === true;
}
const limited = (sec: number) => json({ error: "rate limited" }, 429, { "Retry-After": String(sec) });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too large" }, 413);
  let b: any;
  try { b = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const c = await config();
  webpush.setVapidDetails(c.subject, c.vapid_public, c.vapid_private);

  if (b.action === "cron") return cron(req, c);

  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ipKey = await digest(ip, c.cron_secret || "");
  if (!(await allow("ip:" + ipKey, 300, 3600))) return limited(3600);

  if (b.action === "subscribe") {
    if (!(await allow("sub:" + ipKey, 10, 3600))) return limited(3600);
    const s = b.sub || {};
    const ep = String(s.endpoint || ""), k = s.keys || {};
    if (!ep.startsWith("https://") || ep.length > 700 || !k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100)
      return json({ error: "invalid subscription" }, 400);
    const { count } = await db.from("push_subs").select("endpoint", { count: "exact", head: true });
    const { data: existing } = await db.from("push_subs").select("endpoint").eq("endpoint", ep).maybeSingle();
    if (!existing && (count || 0) >= MAX_SUBS) return json({ error: "capacity" }, 503);
    const tz = clamp(b.tz, -840, 840, -480);
    const min = clamp(b.min, 0, 1439, 1260);
    const mode = b.mode === "random" ? "random" : "fixed";
    const winEnd = mode === "random" ? clamp(b.winEnd, min, 1439, min) : null;
    const L = localOf(tz);
    const { error } = await db.from("push_subs").upsert({
      endpoint: ep, p256dh: k.p256dh, auth: k.auth, remind_min: min, mode, win_end: winEnd, tz,
      rnd_date: null, rnd_min: null, last_sent: L.min >= min ? L.date : null, // 已过点则今天不补发
    });
    return error ? json({ error: "db" }, 500) : json({ ok: true });
  }
  if (b.action === "unsubscribe") {
    await db.from("push_subs").delete().eq("endpoint", String(b.endpoint || ""));
    return json({ ok: true });
  }
  if (b.action === "done") { // 今天已经记录过：当天不再提醒
    const { data } = await db.from("push_subs").select("tz").eq("endpoint", String(b.endpoint || "")).maybeSingle();
    if (data) await db.from("push_subs").update({ last_sent: localOf(data.tz).date }).eq("endpoint", String(b.endpoint));
    return json({ ok: true });
  }
  if (b.action === "test") {
    const ep = String(b.endpoint || "");
    if (!(await allow("test-ip:" + ipKey, 10, 3600))) return limited(3600);
    if (!(await allow("test-ep:" + (await digest(ep, c.cron_secret || "")), 3, 600))) return limited(600);
    const { data } = await db.from("push_subs").select("*").eq("endpoint", ep).maybeSingle();
    if (!data) return json({ error: "not subscribed" }, 404);
    try {
      await webpush.sendNotification({ endpoint: data.endpoint, keys: { p256dh: data.p256dh, auth: data.auth } },
        JSON.stringify({ title: "晴一日记", body: "这是一条服务器推送测试，说明提醒已经接通。" }), { TTL: 600 });
      return json({ ok: true });
    } catch (e) { return json({ error: "push failed", status: (e as any).statusCode || 0 }, 502); }
  }
  if (b.action === "delete_account") { // 删除全部数据：校验用户令牌后删除云端数据与账号
    if (!(await allow("del:" + ipKey, 5, 3600))) return limited(3600);
    const { data, error } = await db.auth.getUser(String(b.token || ""));
    if (error || !data?.user) return json({ error: "unauthorized" }, 401);
    await db.from("vaults").delete().eq("user_id", data.user.id);
    const { error: e2 } = await db.auth.admin.deleteUser(data.user.id);
    return e2 ? json({ error: "delete failed" }, 500) : json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
});

async function cron(req: Request, c: Record<string, string>) {
  if (!c.cron_secret || req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "forbidden" }, 403);
  await db.from("push_rl").delete().lt("reset_at", new Date(Date.now() - 86400000).toISOString());
  const { data: subs } = await db.from("push_subs").select("*");
  let sent = 0, removed = 0;
  for (const s of subs || []) {
    const L = localOf(s.tz);
    if (s.last_sent === L.date) continue;
    let target = s.remind_min;
    if (s.mode === "random" && s.win_end != null && s.win_end > s.remind_min) {
      if (s.rnd_date !== L.date) {
        target = s.remind_min + Math.floor(Math.random() * (s.win_end - s.remind_min + 1));
        await db.from("push_subs").update({ rnd_date: L.date, rnd_min: target }).eq("endpoint", s.endpoint);
      } else target = s.rnd_min;
    }
    if (L.min < target) continue;
    if (L.min - target > 180) { await db.from("push_subs").update({ last_sent: L.date }).eq("endpoint", s.endpoint); continue; } // 错过太久不补发
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "晴一日记", body: TEXTS[Math.floor(Math.random() * TEXTS.length)] }), { TTL: 3600 });
      sent++;
      await db.from("push_subs").update({ last_sent: L.date }).eq("endpoint", s.endpoint);
    } catch (e) {
      const st = (e as any).statusCode;
      if (st === 404 || st === 410) { await db.from("push_subs").delete().eq("endpoint", s.endpoint); removed++; }
    }
  }
  return json({ ok: true, sent, removed });
}
