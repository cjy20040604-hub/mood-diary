// Supabase Edge Function: push（部署名 push）
// 作用：保存浏览器推送订阅、按用户设定的本地时间发送每日提醒（Web Push）。
// 密钥放在数据库表 push_config（仅服务端可读），本文件不含任何密钥。
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
// tz = 浏览器 getTimezoneOffset()：本地时间 = UTC - tz 分钟
const localOf = (tz: number) => {
  const d = new Date(Date.now() - tz * 60000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const clamp = (n: unknown, lo: number, hi: number, d: number) =>
  Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.trunc(Number(n)))) : d;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const c = await config();
  webpush.setVapidDetails(c.subject, c.vapid_public, c.vapid_private);

  if (b.action === "subscribe") {
    const s = b.sub || {};
    const ep = String(s.endpoint || ""), k = s.keys || {};
    if (!ep.startsWith("https://") || ep.length > 700 || !k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100)
      return json({ error: "invalid subscription" }, 400);
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
    const { data } = await db.from("push_subs").select("*").eq("endpoint", String(b.endpoint || "")).maybeSingle();
    if (!data) return json({ error: "not subscribed" }, 404);
    try {
      await webpush.sendNotification({ endpoint: data.endpoint, keys: { p256dh: data.p256dh, auth: data.auth } },
        JSON.stringify({ title: "晴一日记", body: "这是一条服务器推送测试，说明提醒已经接通。" }), { TTL: 600 });
      return json({ ok: true });
    } catch (e) { return json({ error: "push failed", status: (e as any).statusCode || 0 }, 502); }
  }
  if (b.action === "cron") {
    if (!c.cron_secret || req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "forbidden" }, 403);
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
  return json({ error: "unknown action" }, 400);
});
