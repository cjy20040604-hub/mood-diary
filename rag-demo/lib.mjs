// 晴一日记说明书问答助手 · 公共部分：配置、调用模型、向量相似度
// 密钥从环境变量 DASHSCOPE_API_KEY 读取，不写进任何文件。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(DIR, "..");
export const CONFIG = {
  base: process.env.DASHSCOPE_BASE || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  embedModel: "qwen3.7-text-embedding",
  chatModel: "qwen-plus-character",
  chunkSize: 400,   // 每块最多约 400 字
  topK: 4,          // 每次取最相似的 4 块
  minScore: 0.45,   // 最相似的一块低于这个分数，就认为资料里没有，直接拒答（在评测里校准）
};

function key() {
  const k = process.env.DASHSCOPE_API_KEY;
  if (!k) throw new Error("请先设置环境变量 DASHSCOPE_API_KEY");
  return k;
}
async function post(route, body) {
  const r = await fetch(CONFIG.base + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key() }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${route} 返回 ${r.status}：${t.slice(0, 200)}`);
  return JSON.parse(t);
}

// 文字 → 向量。接口一次最多处理 10 段，所以分批
export async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 10) {
    const j = await post("/embeddings", { model: CONFIG.embedModel, input: texts.slice(i, i + 10) });
    j.data.sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
  }
  return out;
}

export async function chat(messages, { maxTokens = 500 } = {}) {
  const j = await post("/chat/completions", { model: CONFIG.chatModel, temperature: 0, max_tokens: maxTokens, messages });
  return { text: String(j.choices?.[0]?.message?.content || "").trim(), usage: j.usage };
}

// 余弦相似度：两个向量方向越接近，值越接近 1
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function loadIndex() {
  const f = path.join(DIR, "index.json");
  if (!fs.existsSync(f)) throw new Error("还没有知识库，请先运行 node rag-demo/ingest.mjs");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// 复用晴一日记线上的危机识别规则，和应用保持一致
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "core.js"), "utf8") + "\n;globalThis.__isRisk = isRisk;", ctx);
export const isRisk = ctx.__isRisk;
