// 问答工作流：安全检查 → 检索 → 相关性门槛 → 生成 → 校验出处
// 步骤由代码固定；模型只负责“根据给定资料组织回答”这一步
import { CONFIG, embed, chat, cosine, loadIndex, isRisk } from "./lib.mjs";

export const PROMPT_V = "rag-1";
const SYSTEM = `你是“晴一日记”的说明书助手，只回答关于晴一日记这个产品的问题。
你会收到编号的【资料】和用户的【问题】。规则：
1. 只用资料里的信息回答，不补充资料以外的内容，不猜测。
2. 每个关键结论后面用 [编号] 标出出处，编号必须是资料里出现过的编号。
3. 资料不足以回答时，只回答这一句：资料里没有找到这个问题的答案。
4. 用中文，简洁，一般 2 到 5 句话。不要寒暄，不要角色扮演。`;

export const REFUSAL = "资料里没有找到这个问题的答案。";
const HOTLINE = "你提到的内容让人有些担心。这里只能回答产品问题，如果你有伤害自己的想法，请现在就拨打全国心理援助热线 12356；有立即危险时拨打 120 或 110。";

let INDEX = null;

export async function ask(question, { topK = CONFIG.topK, minScore = CONFIG.minScore } = {}) {
  INDEX = INDEX || loadIndex();
  const q = String(question || "").trim();
  const t0 = performance.now();
  const trace = { question: q, prompt: PROMPT_V };

  // ① 安全检查：命中危机表达，不进入问答
  if (isRisk(q)) return { ...trace, route: "危机", answer: HOTLINE, hits: [], ms: performance.now() - t0 };
  if (q.length < 2 || q.length > 300) return { ...trace, route: "无效问题", answer: "请用一句话描述你的问题（300 字以内）。", hits: [], ms: performance.now() - t0 };

  // ② 检索：问题向量和每一块算相似度，取前 topK
  const [qv] = await embed([q]);
  const hits = INDEX.chunks.map((c) => ({ id: c.id, doc: c.doc, section: c.section, text: c.text, score: cosine(qv, c.vector) }))
    .sort((a, b) => b.score - a.score).slice(0, topK);

  // ③ 相关性门槛：最相似的一块都不够相关，直接拒答，不调用大模型
  if (hits[0].score < minScore) return { ...trace, route: "低于门槛", answer: REFUSAL, hits, ms: performance.now() - t0 };

  // ④ 生成：只给模型这几块资料，用资料自己的编号 1..k
  const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");
  const { text, usage } = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: `【资料】\n${context}\n\n【问题】${q}` }]);

  // ⑤ 校验出处：编号必须在 1..k 内；不是拒答却一个出处都没有，标记出来
  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]))];
  const invalid = cited.filter((n) => n < 1 || n > hits.length);
  const refused = text.includes("资料里没有找到");
  const flags = [];
  if (invalid.length) flags.push("出处编号不存在：" + invalid.join("、"));
  if (!refused && !cited.length) flags.push("回答没有标出处");
  return { ...trace, route: refused ? "模型拒答" : "回答", answer: text, cited: cited.filter((n) => !invalid.includes(n)).map((n) => hits[n - 1]), hits, flags, usage, ms: performance.now() - t0 };
}
