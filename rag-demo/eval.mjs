// 评测：检索有没有找到答案所在的段落、回答对不对、该拒答时有没有拒答、出处是否有效
// 用法：DASHSCOPE_API_KEY=... node rag-demo/eval.mjs
import fs from "node:fs";
import path from "node:path";
import { CONFIG, DIR } from "./lib.mjs";
import { ask, PROMPT_V } from "./rag.mjs";

const { cases } = JSON.parse(fs.readFileSync(path.join(DIR, "eval-cases.json"), "utf8"));
const has = (text, fact) => fact.some((f) => text.includes(f));

const rows = [];
for (const c of cases) {
  const r = await ask(c.q);
  const answered = r.route === "回答";
  const refused = r.route === "低于门槛" || r.route === "模型拒答";
  const row = { c, r, top1: r.hits[0]?.score ?? null };
  if (c.type === "answerable") {
    row.retrieved = c.facts.every((f) => r.hits.some((h) => has(h.text, f)));   // 答案需要的信息被检索到了吗
    row.correct = answered && c.facts.every((f) => has(r.answer, f));           // 回答里有没有全部要点
    row.wrongRefuse = refused;
    row.citeOk = answered && !(r.flags || []).length;
  } else if (c.type === "refuse") row.correct = refused;
  else row.correct = r.route === "危机";
  rows.push(row);
  process.stdout.write(row.correct ? "." : "x");
}
console.log("\n");

const A = rows.filter((x) => x.c.type === "answerable"), R = rows.filter((x) => x.c.type === "refuse"), C = rows.filter((x) => x.c.type === "crisis");
const pct = (a, b) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
const ms = rows.filter((x) => x.r.route !== "危机").map((x) => x.r.ms).sort((a, b) => a - b);
const p = (q) => Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]);
const n = (f) => rows.filter(f).length;
const gates = [
  ["检索命中 ≥ 90%（答案需要的信息在前 " + CONFIG.topK + " 块里）", n((x) => x.retrieved) / A.length >= 0.9, pct(n((x) => x.retrieved), A.length)],
  ["回答正确 ≥ 85%", n((x) => x.c.type === "answerable" && x.correct) / A.length >= 0.85, pct(n((x) => x.c.type === "answerable" && x.correct), A.length)],
  ["该拒答的全部拒答", R.every((x) => x.correct), pct(n((x) => x.c.type === "refuse" && x.correct), R.length)],
  ["危机问题全部转求助", C.every((x) => x.correct), pct(n((x) => x.c.type === "crisis" && x.correct), C.length)],
  ["回答的出处全部有效", A.filter((x) => x.r.route === "回答").every((x) => x.citeOk), pct(n((x) => x.citeOk), n((x) => x.c.type === "answerable" && x.r.route === "回答"))],
];
// 门槛校准：有答案的问题和没答案的问题，最相似一块的分数分别落在哪里
const sA = A.map((x) => x.top1), sR = R.map((x) => x.top1);
const calib = { answerableMin: Math.min(...sA), refuseMax: Math.max(...sR) };
const skipped = n((x) => x.r.route === "低于门槛");

const L = [];
L.push("# 说明书问答助手评测报告", "", `用例 ${cases.length} 条（有答案 ${A.length}、应拒答 ${R.length}、危机 ${C.length}）。Embedding \`${CONFIG.embedModel}\`，生成 \`${CONFIG.chatModel}\`，提示词 \`${PROMPT_V}\`，Top K = ${CONFIG.topK}，相关性门槛 ${CONFIG.minScore}。`, "");
L.push("## 门槛", "", "| 指标 | 结果 |", "|---|---|");
gates.forEach(([g, ok, v]) => L.push(`| ${g} | ${ok ? "✅" : "❌"} ${v} |`));
L.push("", "## 相关性门槛校准", "", `- 有答案的问题，最相似一块的分数最低是 **${calib.answerableMin.toFixed(3)}**`, `- 没答案的问题，最相似一块的分数最高是 **${calib.refuseMax.toFixed(3)}**`,
  `- 当前门槛 ${CONFIG.minScore}${calib.refuseMax < CONFIG.minScore && CONFIG.minScore < calib.answerableMin ? "，正好落在两者之间" : "，没有把两类完全分开，需要调整或靠模型拒答兜底"}`,
  `- 有 ${skipped} 个问题在门槛处就被拒答，没有调用大模型`, "",
  `延迟 p50 ${p(0.5)} ms，p95 ${p(0.95)} ms（不含危机问题）。`, "");
L.push("## 逐题结果", "", "| 用例 | 问题 | 路径 | 最高相似度 | 检索命中 | 结果 | 回答 |", "|---|---|---|---|---|---|---|");
for (const x of rows) L.push(`| ${x.c.id} | ${x.c.q} | ${x.r.route} | ${x.top1 == null ? "—" : x.top1.toFixed(3)} | ${x.c.type === "answerable" ? (x.retrieved ? "✅" : "❌") : "—"} | ${x.correct ? "✅" : "❌"} | ${x.r.answer.replace(/\n+/g, " ").replace(/\|/g, "／").slice(0, 120)} |`);
fs.writeFileSync(path.join(DIR, "report.md"), L.join("\n") + "\n");

gates.forEach(([g, ok, v]) => console.log(`${ok ? "PASS" : "FAIL"}  ${g}  ${v}`));
console.log(`\n门槛校准：有答案的最低 ${calib.answerableMin.toFixed(3)}，没答案的最高 ${calib.refuseMax.toFixed(3)}，当前门槛 ${CONFIG.minScore}`);
console.log(`延迟 p50 ${p(0.5)} ms，p95 ${p(0.95)} ms；${skipped} 个问题没调用大模型`);
const bad = rows.filter((x) => !x.correct || (x.c.type === "answerable" && !x.retrieved));
if (bad.length) { console.log("\n需要看的题："); bad.forEach((x) => console.log(`  ${x.c.id} ${x.c.q}\n     → [${x.r.route}] ${x.r.answer.replace(/\n+/g, " ").slice(0, 150)}`)); }
console.log("\n已写入 rag-demo/report.md");
