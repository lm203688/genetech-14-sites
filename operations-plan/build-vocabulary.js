#!/usr/bin/env node
/**
 * build-vocabulary.mjs — 从语料反推标签关键词词表（LLR 判别性）
 *
 * 为什么需要（2026-09-29）
 *   LF 引擎手写 KW_MAP 只产出 11 个标签，而语料实际有 8,418 个去重标签。
 *   结果是 lf_era_marker / lf_language 等准确率恒为 0（其产出标签不在语料词表、
 *   永远无法校验），而 biology / quantum computing 等具体领域标签又大多过不了阈值。
 *   词表窄 → LF 准确率不可评判 → 整个 LabelModel 的标定维度形同虚设。
 *
 * 做法：对语料 Top-N 标签，统计"该标签实体中出现、而整体语料中罕见"的词元，
 *   用对数似然比（LLR）衡量判别性，取高分词元生成 data-driven 关键词映射。
 *   产物是静态 JSON，随仓库版本化，LF 运行时加载。
 *
 * 用法：node operations-plan/build-vocabulary.js [--top=300] [--min-llr=1.5] [--out=path]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const TOP_N = Number(arg('top', '300'));
const MIN_LLR = Number(arg('min-llr', '1.5'));
const MIN_TOTAL = Number(arg('min-total', '300'));
const MAX_TOKENS_PER_TAG = Number(arg('max-tokens', '12'));
const MIN_TOKENS_PER_TAG = Number(arg('min-tokens', '3'));
const OUT = arg('out', path.join(__dirname, 'lib', 'vocab.json'));

// 英文停用词（含常见冠词/介词/连接词 + 学术论文高频虚词）
const STOP = new Set(String.raw`the a an and or but if then else of in on at to for from by with without into onto within across through over under above below between among during before after since until while as is are was were be been being have has had do does did will would shall should can could may might must not no nor so that this these those it its they them their we our he she his her you your who whom which what when where why how all any both each few more most other some such only own same than too very s t don just now also also up down out off here there very`.split(/\s+/));

function tokenize(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).toLowerCase().matchAll(/[a-z][a-z\-]{3,30}/g)) {
    let w = m[0];
    if (STOP.has(w)) continue;
    // 去掉单侧短连字符残段
    if (w.endsWith('-')) w = w.slice(0, -1);
    if (w.startsWith('-')) w = w.slice(1);
    if (w.length < 4) continue;
    out.push(w);
  }
  return out;
}

function discoverSites() {
  return fs.readdirSync(ROOT)
    .filter(d => { try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; } })
    .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
    .sort();
}

/**
 * 作者名排除集（2026-09-29 关键修复）
 *   语料标签混入了 OpenAlex 把**人名当 concept** 的噪声：`caldin`、`stewart`、
 *   `awdeh`、`dingman` 等作者姓被当作可判别词元返回。
 *   实体自带 `authors` 字段，据此建全局排除集，人名一律不作关键词。
 */
function buildAuthorStopword(sites) {
  const set = new Set();
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      const authors = Array.isArray(e.authors) ? e.authors : [];
      for (const a of authors) {
        for (const tok of tokenize(typeof a === 'string' ? a : JSON.stringify(a))) set.add(tok);
      }
    }
  }
  return set;
}

function main() {
  const sites = discoverSites();
  console.log(`[vocab] 扫描 ${sites.length} 个站点`);
  const t0 = Date.now();

  // 背景词频（全部实体）
  const bg = new Map();
  const entities = [];   // { tags:Set, tokens:Set }
  const tAuth = Date.now();
  const authorStop = buildAuthorStopword(sites);
  console.log(`[vocab] 作者名排除集 ${authorStop.size}（${((Date.now() - tAuth) / 1000).toFixed(1)}s）`);
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      const tags = new Set((e.tags || e.topics || e.keywords || []).map(t => String(t).toLowerCase()));
      const text = `${e.name || e.title || ''} ${e.abstract || e.summary || ''}`;
      const tokens = new Set([...tokenize(text)].filter(t => !authorStop.has(t)));
      if (!tokens.size) continue;
      entities.push({ tags, tokens });
      for (const t of tokens) bg.set(t, (bg.get(t) || 0) + 1);
    }
  }
  const N = entities.length;
  console.log(`[vocab] 实体 ${N}，背景词元 ${bg.size}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // 标签 → 词元文档频率
  const tagTok = new Map();   // tag -> Map<token, df>
  const tagDf = new Map();    // tag -> 拥有该标签的实体数
  for (const { tags, tokens } of entities) {
    for (const tag of tags) {
      if (!tagTok.has(tag)) tagTok.set(tag, new Map());
      if (!tagDf.has(tag)) tagDf.set(tag, 0);
      tagDf.set(tag, tagDf.get(tag) + 1);
      const m = tagTok.get(tag);
      for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    }
  }

  // 按标签文档频率取 Top-N
  const topTags = [...tagDf.entries()]
    .filter(([, n]) => n >= 20)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);

  console.log(`[vocab] 候选标签 ${topTags.length}`);

  // LLR 判别性：ln(P(t|tag) / P(t|¬tag))
  const result = {};
  let kept = 0;
  for (const [tag, nTag] of topTags) {
    const m = tagTok.get(tag);
    const cand = [];
    for (const [tok, df] of m) {
      const bgDf = bg.get(tok) || 0;
      if (bgDf < MIN_TOTAL) continue;
      if (df / nTag < 0.3) continue;                 // 必须在该标签实体中较常见
      if (df / bgDf < 0.5) continue;                 // 必须比背景更集中
      const pTag = (df + 1) / (nTag + 2);
      const pNot = (bgDf - df + 1) / (N - nTag + 2);
      const llr = Math.log(Math.max(pTag, 1e-9) / Math.max(pNot, 1e-9));
      if (llr < MIN_LLR) continue;
      cand.push({ token: tok, llr: +llr.toFixed(3), df, share: +(df / nTag).toFixed(3) });
    }
    cand.sort((a, b) => b.llr - a.llr);
    if (cand.length < MIN_TOKENS_PER_TAG) continue;
    result[tag] = cand.slice(0, MAX_TOKENS_PER_TAG).map(c => c.token);
    kept++;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    method: 'LLR (tag doc-freq vs corpus background doc-freq)，threshold >= MIN_LLR',
    params: { TOP_N, MIN_LLR, MIN_TOTAL, MAX_TOKENS_PER_TAG, MIN_TOKENS_PER_TAG },
    corpusEntities: N,
    corpusBackgroundTokens: bg.size,
    candidateTags: topTags.length,
    tagsWithKeywords: kept,
    vocabulary: result,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');

  console.log(`[vocab] 生成 ${kept} 个标签的关键词 → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  console.log(`[vocab] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const sample = Object.entries(result).slice(0, 8);
  for (const [t, toks] of sample) console.log(`  ${t.padEnd(34)} n=${tagDf.get(t).toString().padStart(5)}  ${toks.slice(0, 7).join(', ')}`);
}

main();
