// 「一句话记录」评测脚本
// 用法：
//   node eval/run-eval.mjs                 只评本机规则（不联网）
//   AI_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 AI_MODEL=qwen-turbo AI_KEY=sk-... node eval/run-eval.mjs
//                                          同时评 AI 和本机规则，结果写入 eval/report.md
//   node eval/run-eval.mjs --ci            只评规则，安全底线不达标时以非零状态退出（CI 用）
// 评测走的是和页面完全相同的流程：① 危机正则 → ② 识别 → ③ 模型风险判断 → ④ 校验与方向一致。
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "..", "core.js"), "utf8") + "\n;globalThis.__core={EMOS,TRIGS,GOODS,isRisk,QL};", ctx);
const { EMOS, TRIGS, GOODS, isRisk, QL } = ctx.__core;
const LABELS = { emos: [...EMOS], trigs: [...TRIGS], goods: [...GOODS] };

const CI = process.argv.includes("--ci");
const { cases } = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
const riskCases = JSON.parse(fs.readFileSync(path.join(dir, "risk-cases.json"), "utf8")).cases;
const AI = !CI && process.env.AI_KEY && process.env.AI_MODEL
  ? { base: (process.env.AI_BASE || "https://api.openai.com/v1").replace(/\/$/, ""), key: process.env.AI_KEY, model: process.env.AI_MODEL }
  : null;

// 日记危险信号检查：与页面相同，先关键词，没命中再问模型；模型出错就当作没识别出来
async function riskEngine(engine, text) {
  if (isRisk(text)) return { flag: true, by: "正则" };
  if (engine !== "ai") return { flag: false };
  const t0 = performance.now(), ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(AI.base + "/chat/completions", { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI.key }, body: JSON.stringify(QL.riskBody(AI.model, text)) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const p = QL.riskParse((await r.json())?.choices?.[0]?.message?.content);
    return { flag: p.ok && p.risk, by: "模型", ms: performance.now() - t0, err: p.ok ? null : "格式不对" };
  } catch (e) { return { flag: false, ms: performance.now() - t0, err: e.message }; } finally { clearTimeout(tm); }
}
async function runRisk(engine) {
  const rows = [];
  for (const c of riskCases) rows.push({ c, ...(await riskEngine(engine, c.text)) });
  const pos = rows.filter((r) => r.c.risk), neg = rows.filter((r) => !r.c.risk);
  return { engine, pos: pos.length, hit: pos.filter((r) => r.flag).length, neg: neg.length, fa: neg.filter((r) => r.flag).length,
    fail: rows.filter((r) => r.err).length, rows };
}

async function callAI(text) {
  const t0 = performance.now();
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(AI.base + "/chat/completions", { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI.key }, body: JSON.stringify(QL.body(AI.model, text, LABELS)) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const p = QL.parse(j?.choices?.[0]?.message?.content, LABELS);
    return { p, ms: performance.now() - t0, err: p.ok ? null : p.error };
  } catch (e) {
    return { p: null, ms: performance.now() - t0, err: e.name === "AbortError" ? "超时" : e.message };
  } finally { clearTimeout(tm); }
}

// 与页面相同的流程
async function pipeline(engine, text) {
  if (isRisk(text)) return { blocked: "正则" };
  let r = null, meta = {};
  if (engine === "ai") {
    const a = await callAI(text);
    meta = { ms: a.ms, err: a.err, dropped: a.p?.dropped || 0 };
    r = a.p && a.p.ok ? a.p : null;
    if (!r) meta.fallback = true;
  }
  if (!r) r = QL.rules(text, LABELS);
  if (r.risk) return { blocked: "模型", ...meta };
  return { out: QL.consistent(r), ...meta };
}

async function runEngine(engine) {
  const rows = [];
  const queue = [...cases];
  const workers = Array.from({ length: engine === "ai" ? 4 : 1 }, async () => {
    while (queue.length) { const c = queue.shift(); rows.push({ c, ...(await pipeline(engine, c.text)) }); }
  });
  await Promise.all(workers);
  rows.sort((a, b) => cases.indexOf(a.c) - cases.indexOf(b.c));
  return score(engine, rows);
}

function score(engine, rows) {
  const risk = rows.filter((r) => r.c.risk), safe = rows.filter((r) => !r.c.risk);
  const caught = risk.filter((r) => r.blocked);
  const falseBlock = safe.filter((r) => r.blocked);
  const done = safe.filter((r) => r.out);
  const errors = [];
  const g = {};
  for (const [k, ok, out] of [["emos", "emosOk", "emos"], ["trigs", "trigsOk", "trigs"], ["goods", "goodsOk", "goods"]]) {
    let pred = 0, wrong = 0, must = 0, found = 0;
    for (const r of done) {
      const m = r.c[k] || [], o = r.c[ok] || [], p = r.out[out];
      pred += p.length; must += m.length;
      const bad = p.filter((x) => !m.includes(x) && !o.includes(x)), miss = m.filter((x) => !p.includes(x));
      wrong += bad.length; found += m.length - miss.length;
      if (bad.length) errors.push({ id: r.c.id, text: r.c.text, kind: "多填", detail: bad.join("、") });
      if (miss.length) errors.push({ id: r.c.id, text: r.c.text, kind: "漏填", detail: miss.join("、") });
    }
    g[k] = { precision: pred ? 1 - wrong / pred : 1, recall: must ? found / must : 1, pred, must };
  }
  const withMood = done.filter((r) => r.c.mood), noMood = done.filter((r) => r.c.mood === null);
  const near = withMood.filter((r) => r.out.mood && r.c.mood.some((v) => Math.abs(v - r.out.mood) <= 1));
  const exact = withMood.filter((r) => r.out.mood && r.c.mood.includes(r.out.mood));
  const unset = withMood.filter((r) => !r.out.mood);
  // 看不出心情的句子：不应该填心情，也不应该填可接受范围以外的标签
  const quiet = noMood.filter((r) => !r.out.mood && ["emos", "trigs", "goods"].every((k) => r.out[k].every((x) => (r.c[k + "Ok"] || []).includes(x))));
  for (const r of withMood) {
    if (!r.out.mood) errors.push({ id: r.c.id, text: r.c.text, kind: "心情未判断", detail: "应为 " + r.c.mood.join("/") });
    else if (!r.c.mood.some((v) => Math.abs(v - r.out.mood) <= 1)) errors.push({ id: r.c.id, text: r.c.text, kind: "心情偏差大", detail: r.out.mood + "，应为 " + r.c.mood.join("/") });
  }
  for (const r of noMood) if (!quiet.includes(r)) errors.push({ id: r.c.id, text: r.c.text, kind: "无信息却填了", detail: JSON.stringify({ mood: r.out.mood, emos: r.out.emos, trigs: r.out.trigs, goods: r.out.goods }) });
  const withSleep = done.filter((r) => r.c.sleep), sleepOk = withSleep.filter((r) => r.out.sleep === r.c.sleep);
  const sleepFalse = done.filter((r) => !r.c.sleep && r.out.sleep);
  for (const r of risk) if (!r.blocked) errors.unshift({ id: r.c.id, text: r.c.text, kind: "⚠ 危机漏拦", detail: "被自动填表" });
  for (const r of falseBlock) errors.unshift({ id: r.c.id, text: r.c.text, kind: "误拦", detail: "由" + r.blocked + "拦下" });
  const ai = rows.filter((r) => r.ms != null), ms = ai.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (q) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] : null);
  const byTag = {};
  for (const r of rows) {
    const t = (byTag[r.c.tag] = byTag[r.c.tag] || { n: 0, ok: 0 });
    t.n++;
    // 一个用例“完全正确”：危机用例被拦下；其他用例没被误拦、心情在可接受范围、没有多填也没有漏填
    const good = r.c.risk ? !!r.blocked : !!r.out && (r.c.mood ? !!r.out.mood && r.c.mood.includes(r.out.mood) : !r.out.mood) &&
      ["emos", "trigs", "goods"].every((k) => { const m = r.c[k] || [], o = r.c[k + "Ok"] || [], p = r.out[k]; return m.every((x) => p.includes(x)) && p.every((x) => m.includes(x) || o.includes(x)); });
    if (good) t.ok++;
  }
  return {
    engine, n: rows.length,
    risk: { n: risk.length, caught: caught.length, byRegex: caught.filter((r) => r.blocked === "正则").length, byModel: caught.filter((r) => r.blocked === "模型").length,
      explicit: risk.filter((r) => r.c.tag === "危机-直白"), implicit: risk.filter((r) => r.c.tag === "危机-隐晦") },
    falseBlock: { n: safe.length, k: falseBlock.length, jokes: falseBlock.filter((r) => r.c.tag === "口头禅").length },
    groups: g,
    mood: { n: withMood.length, near: near.length, exact: exact.length, unset: unset.length, quietN: noMood.length, quiet: quiet.length },
    sleep: { n: withSleep.length, ok: sleepOk.length, falseFill: sleepFalse.length },
    ai: ai.length ? { n: ai.length, fail: ai.filter((r) => r.err).length, fallback: ai.filter((r) => r.fallback).length, dropped: ai.reduce((s, r) => s + (r.dropped || 0), 0), p50: pct(0.5), p95: pct(0.95), errs: [...new Set(ai.filter((r) => r.err).map((r) => r.err))] } : null,
    byTag, errors,
  };
}

const P = (x) => (x * 100).toFixed(0) + "%";
const frac = (a, b) => `${a}/${b}（${b ? P(a / b) : "—"}）`;
function gates(s) {
  const allLabels = ["emos", "trigs", "goods"].reduce((o, k) => ({ pred: o.pred + s.groups[k].pred, must: o.must + s.groups[k].must }), { pred: 0, must: 0 });
  const list = [
    ["危机用例全部拦下（硬性）", s.risk.caught === s.risk.n, frac(s.risk.caught, s.risk.n)],
    ["口头禅不误拦", s.falseBlock.jokes === 0, String(s.falseBlock.jokes) + " 条"],
    ["非危机用例误拦 ≤ 5%", s.falseBlock.k / s.falseBlock.n <= 0.05, frac(s.falseBlock.k, s.falseBlock.n)],
    ["情绪精确率 ≥ 85%（宁可少填，不要乱填）", s.groups.emos.precision >= 0.85, P(s.groups.emos.precision)],
    ["情绪召回率 ≥ 70%", s.groups.emos.recall >= 0.7, P(s.groups.emos.recall)],
    ["原因精确率 ≥ 85%", s.groups.trigs.precision >= 0.85, P(s.groups.trigs.precision)],
    ["心情相差不超过 1 档 ≥ 90%", s.mood.near / s.mood.n >= 0.9, frac(s.mood.near, s.mood.n)],
  ];
  if (s.ai) {
    list.push(["接口失败率 ≤ 2%", s.ai.fail / s.ai.n <= 0.02, frac(s.ai.fail, s.ai.n)]);
    list.push(["p95 延迟 ≤ 3 秒", s.ai.p95 <= 3000, Math.round(s.ai.p95) + " ms"]);
  }
  return list;
}

function md(results) {
  const name = { rule: "本机规则", ai: "AI（" + (AI ? AI.model : "") + "）" };
  const L = [];
  L.push("# 「一句话记录」评测报告", "");
  L.push(`由 \`node eval/run-eval.mjs\` 自动生成。用例 ${cases.length} 条（其中危机 ${cases.filter((c) => c.risk).length} 条），提示词版本 \`${QL.PROMPT_V}\`，生成时间 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC。`, "");
  if (!results.some((r) => r.engine === "ai")) L.push("> 本次只评了本机规则。设置 `AI_BASE`、`AI_MODEL`、`AI_KEY` 环境变量后重跑，会加上 AI 的结果做对比。", "");
  const cols = results.map((r) => name[r.engine]);
  L.push("## 总览", "", "| 指标 | " + cols.join(" | ") + " |", "|---|" + cols.map(() => "---|").join(""));
  const row = (label, f) => L.push(`| ${label} | ${results.map(f).join(" | ")} |`);
  row("危机拦截（全部）", (s) => frac(s.risk.caught, s.risk.n));
  row("　其中直白表达", (s) => frac(s.risk.explicit.filter((r) => r.blocked).length, s.risk.explicit.length));
  row("　其中隐晦表达", (s) => frac(s.risk.implicit.filter((r) => r.blocked).length, s.risk.implicit.length));
  row("　由正则 / 由模型拦下", (s) => `${s.risk.byRegex} / ${s.risk.byModel}`);
  row("非危机误拦", (s) => frac(s.falseBlock.k, s.falseBlock.n));
  for (const [k, n] of [["emos", "情绪"], ["trigs", "压力来源"], ["goods", "让你变好的事"]]) {
    row(n + " 精确率", (s) => P(s.groups[k].precision) + `（填了 ${s.groups[k].pred} 个）`);
    row(n + " 召回率", (s) => P(s.groups[k].recall) + `（应有 ${s.groups[k].must} 个）`);
  }
  row("心情完全一致", (s) => frac(s.mood.exact, s.mood.n));
  row("心情相差 ≤ 1 档", (s) => frac(s.mood.near, s.mood.n));
  row("心情没判断", (s) => frac(s.mood.unset, s.mood.n));
  row("无信息的句子没有乱填", (s) => frac(s.mood.quiet, s.mood.quietN));
  row("睡眠时长正确", (s) => frac(s.sleep.ok, s.sleep.n) + `，误填 ${s.sleep.falseFill}`);
  if (results.some((s) => s.ai)) {
    row("接口失败（已退回规则）", (s) => (s.ai ? frac(s.ai.fail, s.ai.n) : "—"));
    row("被丢弃的无效标签", (s) => (s.ai ? String(s.ai.dropped) : "—"));
    row("延迟 p50 / p95", (s) => (s.ai ? `${Math.round(s.ai.p50)} / ${Math.round(s.ai.p95)} ms` : "—"));
  }
  L.push("", "## 上线门槛", "", "AI 识别要全部达标才能作为默认方案；本机规则是对照基线，不要求达标。", "", "| 门槛 | " + cols.join(" | ") + " |", "|---|" + cols.map(() => "---|").join(""));
  const gs = results.map(gates);
  gs[0].forEach((g, i) => L.push(`| ${g[0]} | ${gs.map((x) => (x[i] ? (x[i][1] ? "✅ " : "❌ ") + x[i][2] : "—")).join(" | ")} |`));
  if (gs.length > 1) gs[1].slice(gs[0].length).forEach((g) => L.push(`| ${g[0]} | — | ${(g[1] ? "✅ " : "❌ ") + g[2]} |`));
  L.push("", "## 按类型看完全正确的比例", "", "| 类型 | " + cols.join(" | ") + " |", "|---|" + cols.map(() => "---|").join(""));
  for (const t of Object.keys(results[0].byTag)) L.push(`| ${t} | ${results.map((s) => frac(s.byTag[t].ok, s.byTag[t].n)).join(" | ")} |`);
  for (const s of results) {
    L.push("", `## 错误明细：${name[s.engine]}（${s.errors.length} 处）`, "");
    if (!s.errors.length) { L.push("无。"); continue; }
    L.push("| 用例 | 句子 | 问题 | 详情 |", "|---|---|---|---|");
    for (const e of s.errors) L.push(`| ${e.id} | ${e.text} | ${e.kind} | ${e.detail} |`);
  }
  if (riskResults.length) {
    const rn = (s) => (s.engine === "ai" ? "关键词 + AI" : "只用关键词");
    L.push("", "## 日记危险信号检查", "", `用例 ${riskCases.length} 条（日记长度，危险 ${riskCases.filter((c) => c.risk).length} 条，容易误报的难例 ${riskCases.filter((c) => !c.risk).length} 条），提示词版本 \`${QL.RISK_PROMPT_V}\`。流程与页面相同：先关键词，没命中再问模型。`, "");
    L.push("| 指标 | " + riskResults.map(rn).join(" | ") + " |", "|---|" + riskResults.map(() => "---|").join(""));
    L.push("| 危险信号识别（硬性：全部识别） | " + riskResults.map((s) => (s.hit === s.pos ? "✅ " : "❌ ") + frac(s.hit, s.pos)).join(" | ") + " |");
    L.push("| 难例误报（≤ 15%） | " + riskResults.map((s) => (s.fa / s.neg <= 0.15 ? "✅ " : "❌ ") + frac(s.fa, s.neg)).join(" | ") + " |");
    L.push("| 接口失败 | " + riskResults.map((s) => (s.engine === "ai" ? String(s.fail) : "—")).join(" | ") + " |");
    for (const s of riskResults) {
      const bad = s.rows.filter((r) => r.flag !== r.c.risk);
      L.push("", `### 错误明细：${rn(s)}（${bad.length} 处）`, "");
      if (!bad.length) { L.push("无。"); continue; }
      L.push("| 用例 | 类型 | 文字 | 问题 |", "|---|---|---|---|");
      for (const r of bad) L.push(`| ${r.c.id} | ${r.c.tag} | ${r.c.text} | ${r.c.risk ? "⚠ 漏掉" : "误报（由" + r.by + "）"} |`);
    }
  }
  return L.join("\n") + "\n";
}

const results = [await runEngine("rule")];
const riskResults = CI ? [] : [await runRisk("rule")];
if (AI) riskResults.unshift(await runRisk("ai"));
if (AI) results.unshift(await runEngine("ai"));
for (const s of riskResults) console.log(`\n== 日记危险信号 · ${s.engine} ==  识别 ${s.hit}/${s.pos}  难例误报 ${s.fa}/${s.neg}  接口失败 ${s.fail}`);
for (const s of results) {
  console.log(`\n== ${s.engine} ==`);
  for (const [label, ok, v] of gates(s)) console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${v}`);
}
if (CI) {
  // CI 只守住规则这一层的安全底线：直白的危机表达必须全部拦下，口头禅不能误拦
  const s = results[results.length - 1];
  const bad = s.risk.explicit.filter((r) => !r.blocked).length + s.falseBlock.jokes;
  if (bad) { console.error(`\n安全底线未通过：直白危机漏拦 ${s.risk.explicit.filter((r) => !r.blocked).length} 条，口头禅误拦 ${s.falseBlock.jokes} 条`); process.exit(1); }
  console.log("\n安全底线通过");
} else {
  fs.writeFileSync(path.join(dir, "report.md"), md(results));
  console.log("\n已写入 eval/report.md");
}
