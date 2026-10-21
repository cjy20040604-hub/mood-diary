// 命令行提问：DASHSCOPE_API_KEY=... node rag-demo/ask.mjs "我的日记会上传吗？"
// 加 --trace 显示检索到的每一块和相似度
import { ask } from "./rag.mjs";

const args = process.argv.slice(2);
const trace = args.includes("--trace");
const q = args.filter((a) => a !== "--trace").join(" ");
if (!q) { console.log('用法：node rag-demo/ask.mjs "你的问题" [--trace]'); process.exit(1); }

const r = await ask(q);
console.log(`\n问：${r.question}\n路径：${r.route}　用时 ${Math.round(r.ms)} ms\n\n${r.answer}\n`);
if (r.cited?.length) console.log("出处：\n" + r.cited.map((h) => `  · ${h.doc} › ${h.section}`).join("\n"));
if (r.flags?.length) console.log("⚠ " + r.flags.join("；"));
if (trace && r.hits.length) {
  console.log("\n检索结果：");
  r.hits.forEach((h, i) => console.log(`  [${i + 1}] ${h.score.toFixed(3)}  ${h.doc} › ${h.section}`));
}
