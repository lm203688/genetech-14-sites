// phase8/query-decomposer.mjs
// Query Decomposer - 查询分解器
//
// 目标：把自然语言查询拆成多个子查询 + 排序 + 权重
//
// 策略：
//   - 显式分解符: " AND " / " OR " / " AND-NOT " / " vs " / " and "
//   - 隐式拆分:  名词短语（连续实义词）、限定词（in/of/by/via 之后）
//   - 权重:      核心名词 > 修饰词；子查询长度越短权重越高
//
// 使用:
//   node phase8/query-decomposer.mjs --query "AI safety and autonomous agents"
//   node phase8/query-decomposer.mjs --query "retrieval vs BM25 in scientific literature"

import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'to', 'for', 'at', 'by',
  'with', 'from', 'into', 'via', 'using', 'about', 'between', 'among',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'should', 'will',
  'would', 'may', 'might', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'not', 'no', 'nor', 'also', 'than', 'then', 'such',
  'very', 'much', 'more', 'most', 'too', 'just', 'only', 'still', 'even',
  'its', 'our', 'your', 'my', 'his', 'her', 'their', 'they', 'we', 'he', 'she',
  'me', 'him', 'them',
]);

// 分解符（显式）
const EXPLICIT_OPS = [
  { op: 'AND-NOT', pattern: /\band[\s-]+not\b/gi, weight: 1.0 },
  { op: 'OR', pattern: /\bor\b/gi, weight: 0.5 },
  { op: 'VS', pattern: /\bvs(?:\.|us\.|us)\b/gi, weight: 0.8 },
  { op: 'AND', pattern: /\band\b/gi, weight: 0.9 },
];

// 限定词（隐式边界）
const QUALIFIER_PREFIXES = ['in', 'of', 'by', 'via', 'with', 'using', 'through', 'from', 'under', 'over'];

export function decomposeQuery(query) {
  if (!query || !query.trim()) return [];

  const trimmed = query.trim();

  // 1. 先按显式运算符切分
  let segments = [trimmed];
  const operators = [];
  for (const { op, pattern } of EXPLICIT_OPS) {
    const tempSegs = [];
    for (const seg of segments) {
      const parts = seg.split(pattern);
      if (parts.length > 1) {
        operators.push({ op, index: tempSegs.length });
        tempSegs.push(...parts.map(p => p.trim()).filter(Boolean));
      } else {
        tempSegs.push(seg);
      }
    }
    segments = tempSegs;
  }

  // 2. 每个 segment 再按名词短语拆
  const subQueries = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const phrases = splitNounPhrases(seg);
    for (const p of phrases) {
      if (!p || p.length < 3) continue;
      subQueries.push({
        text: p,
        weight: computeWeight(p, trimmed),
        operator: i < operators.length ? operators[i].op : null,
        source: phrases.length > 1 ? 'implicit-noun-phrase' : 'explicit-segment',
      });
    }
  }

  // 3. 排序: 权重降序
  subQueries.sort((a, b) => b.weight - a.weight);

  return subQueries;
}

function splitNounPhrases(text) {
  // 按空格切分，剔除 stopword 后组合成短语（连续实义词）
  const tokens = text.split(/\s+/).filter(Boolean);
  const phrases = [];
  let current = [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (STOPWORDS.has(lower) || QUALIFIER_PREFIXES.includes(lower)) {
      if (current.length) { phrases.push(current.join(' ')); current = []; }
    } else {
      current.push(tok);
    }
  }
  if (current.length) phrases.push(current.join(' '));
  return phrases;
}

function computeWeight(phrase, originalQuery) {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(t => !STOPWORDS.has(t));
  // 基础分：词数 * 长度
  let w = 0.3;
  w += Math.min(0.4, tokens.length * 0.1);
  w += Math.min(0.2, phrase.length / originalQuery.length);
  // 稀有词加分（长词）
  const avgLen = tokens.reduce((a, b) => a + b.length, 0) / Math.max(1, tokens.length);
  if (avgLen >= 8) w += 0.1;
  return Math.min(1.0, Math.round(w * 100) / 100);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { query: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query') opts.query = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.query) {
    console.error('Usage: node phase8/query-decomposer.mjs --query "text"');
    process.exit(1);
  }
  const subs = decomposeQuery(opts.query);
  const out = {
    originalQuery: opts.query,
    subQueryCount: subs.length,
    subQueries: subs,
  };
  if (opts.out) {
    const fs = await import('fs');
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(1); });
}
