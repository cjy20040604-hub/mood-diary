// 第 1 步：读文档 → 切块 → 向量化 → 存成 index.json
// 用法：DASHSCOPE_API_KEY=... node rag-demo/ingest.mjs
import fs from "node:fs";
import path from "node:path";
import { CONFIG, DIR, ROOT, embed } from "./lib.mjs";

const DOCS = [
  { file: "privacy.html", name: "隐私政策" },
  { file: "README.md", name: "产品说明" },
  { file: "eval/README.md", name: "AI 设计与评测说明" },
];

// HTML 转成带标题的纯文本：标题变成 ##，列表项变成 -，表格每行用 | 连接
function htmlToText(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<tr[^>]*>/gi, "\n")
    .replace(/<\/(p|div|ul|table|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// Markdown 去掉对回答没用的部分：流程图代码、命令行代码、徽章和图片
function cleanMarkdown(md) {
  return md
    .replace(/```mermaid[\s\S]*?```/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\[!\[.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "");
}

// 一段太长时先按行（列表项、表格行）拆；单行仍然太长，再按句子拆并尽量合并到 chunkSize 以内
function units(t) {
  if (t.length <= CONFIG.chunkSize) return [t];
  const out = [];
  for (const line of t.split("\n")) {
    if (line.length <= CONFIG.chunkSize) { out.push(line); continue; }
    let cur = "";
    for (const s of line.split(/(?<=[。；！？])/)) {
      if (cur && (cur + s).length > CONFIG.chunkSize) { out.push(cur); cur = ""; }
      cur += s;
    }
    if (cur) out.push(cur);
  }
  return out;
}

// 按标题分章节，章节内按段落合并到约 chunkSize 字
function chunk(text, docName) {
  const out = [];
  let section = docName;
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body.length < 20) return;
    out.push({ doc: docName, section, text: `【${docName} › ${section}】\n${body}` });
  };
  const paras = [];
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^(#{1,4})\s+(.+)$/m);
    if (h && b.startsWith(h[0])) { paras.push({ heading: h[2].trim() }); const rest = b.slice(h[0].length).trim(); if (rest) paras.push({ text: rest }); }
    else paras.push({ text: b });
  }
  for (const p of paras) {
    if (p.heading) { flush(); section = p.heading; continue; }
    for (const piece of units(p.text)) {
      if (buf.join("\n").length + piece.length > CONFIG.chunkSize) flush();
      buf.push(piece.trim());
    }
  }
  flush();
  return out;
}

const chunks = [];
for (const d of DOCS) {
  const raw = fs.readFileSync(path.join(ROOT, d.file), "utf8");
  const text = d.file.endsWith(".html") ? htmlToText(raw) : cleanMarkdown(raw);
  const cs = chunk(text, d.name);
  console.log(`${d.name}：${cs.length} 块`);
  chunks.push(...cs);
}
console.log(`共 ${chunks.length} 块，开始向量化…`);
const t0 = Date.now();
const vectors = await embed(chunks.map((c) => c.text));
chunks.forEach((c, i) => { c.id = i + 1; c.vector = vectors[i]; });
fs.writeFileSync(path.join(DIR, "index.json"), JSON.stringify({ model: CONFIG.embedModel, builtAt: new Date().toISOString(), chunks }));
console.log(`完成：${chunks.length} 块，每块 ${vectors[0].length} 维，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，已存到 rag-demo/index.json`);
