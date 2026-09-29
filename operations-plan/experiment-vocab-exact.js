#!/usr/bin/env node
/**
 * experiment-vocab-exact.js — 分离「作用域噪声」与「词表自污染」
 *
 * 前置（experiment-vocab-scope.js，2026-09-29）已确认作用域是问题之一：
 *   A 线上(多词=标题+摘要/单词=标题)  precision 0.0598   185,370 pred  151.8s
 *   B 全部仅标题                      precision 0.0823    69,575 pred   20.3s
 *   C 全部仅标题前80字                precision 0.0823    （与 B 相同，80 字后无边际信息）
 *   E 全部标题+摘要（基线）            precision 0.0453   365,770 pred
 *   → 收紧作用域 +38% precision、7.5x 更少预测、7.5x 更快。
 *
 * 但同一次实验的逐标签表暴露了另一个问题：
 *   artificial intelligence                          6,467 pred   2,354 TP  0.364
 *   artificial intelligence and image processing    6,610 pred       0 TP  0.000
 *   artificial intelligence and robotics            6,548 pred       4 TP  0.0006
 *   generative artificial intelligence              6,468 pred       0 TP  0.000
 *   artificial intelligence (cs.ai)                 6,467 pred       3 TP  0.0005
 *   applications of artificial intelligence         6,467 pred      17 TP  0.0026
 *   edge artificial intelligence                    6,467 pred       1 TP  0.0002
 *   frugal artificial intelligence                  6,467 pred       0 TP  0.000
 * 这 8 个变体预测次数几乎相同（6,467–6,610）而只有规范形有 TP。
 * 怀疑来源不是语料，而是 build-vocab.js 的 phrasesOf() 给每个标签追加
 * 「最长 3 词子串」——artificial intelligence and image processing 因此携带
 * 子短语 artificial intelligence，与规范形一起被触发，属**词表自污染**。
 *
 * 本脚本同时排除一个必须先排除的干扰：前 30,000 条样本是按站点字母序
 * 顺序取的，不是随机抽样。某标签在样本里 gold 可能为 0，那时 TP=0 是
 * 无信息量而非低精度。所以每标签都报 gold（样本内真实出现次数），
 * 并只把 gold >= 20 的标签列为可评判对象。
 *
 * 用法：node operations-plan/experiment-vocab-exact.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, 'operations-plan', 'lib', 'vocab.json'), 'utf8'));

function discoverSites() {
  return fs.readdirSync(ROOT)
    .filter(d => { try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; } })
    .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
    .sort();
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 词边界正则：与线上 LF 完全一致，保证对照可比 */
const reOf = ph => new RegExp('(?:^|[^a-z0-9])' + esc(ph) + '(?:[^a-z0-9]|$)');

/**
 * 建「首词 → 候选」索引（与线上 LF 的 byFirst 同构）。
 * 30k 实体 × 2,200 标签全量笛卡尔正则测试要几分钟，索引后是秒级。
 * 入参是「标签 → 短语字符串数组」；正则与首词都在此一次算好。
 * 注意：不事后从 RegExp.source 反解短语（会把字面量 (?: 前缀当正则符号，
 * 导致整表被跳过、pred 恒 0），直接从短语字符串取首词。
 */
function buildIndex(phraseMap) {
  const idx = new Map();
  let phrases = 0;
  for (const [tag, phs] of phraseMap) {
    for (const ph of phs) {
      const head = ph.split(/[^a-z0-9]+/)[0];
      if (!head) continue;
      if (!idx.has(head)) idx.set(head, []);
      idx.get(head).push({ re: reOf(ph), tag });
      phrases++;
    }
  }
  return { idx, phrases };
}

/**
 * 三组短语集
 *   variants — 含 2 词子串扩展（=线上现状）
 *   exact    — 只用标签串本身
 *   guarded  — 含 2 词子串扩展，但**剔除「子短语本身也是词表标签」的那些**
 *
 * guarded 的依据：`artificial intelligence and image processing` 展开出的子短语
 * `artificial intelligence` 自己就是一个词表标签。子短语命中却把功劳记给
 * 更长的标签，等于偷走短标签的证据 —— 这是变体式扩展唯一真正的缺陷，
 * 不是「子串扩展」本身有害（`convolutional neural network` 的召回要靠它）。
 */
const variantPhrases = new Map();
const exactPhrases = new Map();
const guardedPhrases = new Map();
const allTags = new Set(Object.keys(vocab.vocabulary || {}));
for (const [tag, meta] of Object.entries(vocab.vocabulary || {})) {
  const raw = (meta.phrases || []).filter(ph => typeof ph === 'string' && ph.length >= 4);
  variantPhrases.set(tag, raw);
  const ex = [tag];
  if (tag.startsWith('cs.')) ex.push(tag.slice(3));
  const uniq = [...new Set(ex.filter(s => s.length >= 4))];
  exactPhrases.set(tag, uniq);
  guardedPhrases.set(tag, [...new Set([
    ...uniq,
    ...raw.filter(ph => ph !== tag && !allTags.has(ph)),
  ])]);
}
const VB = buildIndex(variantPhrases);
const EB = buildIndex(exactPhrases);
const GB = buildIndex(guardedPhrases);
const variants = VB.idx;
const exact = EB.idx;
const guarded = GB.idx;

function main() {
  const sites = discoverSites();
  const labeled = [];
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      if (!(e.tags || []).length) continue;
      labeled.push(e);
      if (labeled.length >= 30000) break;
    }
    if (labeled.length >= 30000) break;
  }

  const norm = t => String(t).toLowerCase().trim().replace(/\s+/g, ' ');
  // 先扫一遍：样本内每标签的 gold 出现次数（用于判断哪些标签可评判）
  const goldDf = new Map();
  for (const e of labeled) {
    const seen = new Set();
    for (const t of e.tags || []) {
      const k = norm(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      goldDf.set(k, (goldDf.get(k) || 0) + 1);
    }
  }
  const vocabTags = new Set(variantPhrases.keys());
  const goldInVocab = [...goldDf.entries()].filter(([t]) => vocabTags.has(t));
  const goldTotal = goldInVocab.reduce((s, [, n]) => s + n, 0);
  console.log(`[样本] 已标注实体 ${labeled.length}｜词表标签 ${vocabTags.size}`);
  console.log(`[索引] variants ${VB.phrases} 短语｜exact ${EB.phrases} 短语｜guarded ${GB.phrases} 短语`);
  console.log(`[样本] 其中在样本内出现 gold 的词表标签 ${goldInVocab.length} 个，累计 ${goldTotal} 条`);
  console.log(`[样本] gold >= 20 可评判标签 ${(goldInVocab.filter(([, n]) => n >= 20).length)} 个`);
  console.log('');

  const MODES = [
    ['variants', variants],
    ['exact', exact],
    ['guarded', guarded],
  ];
  const SPLIT = 22500;   // 前 22,500 做标定，后 7,500 做留一评估（避免既筛又评的乐观偏差）
  const stat = Object.fromEntries(MODES.map(([k]) => [k, { calib: { pred: 0, tp: 0 }, eval: { pred: 0, tp: 0 } }]));
  const perTag = Object.fromEntries(MODES.map(([k]) => [k, { calib: new Map(), eval: new Map() }]));
  const t0 = Date.now();
  for (let i = 0; i < labeled.length; i++) {
    const e = labeled[i];
    const split = i < SPLIT ? 'calib' : 'eval';
    const title = String(e.name || e.title || '').toLowerCase();
    const gold = new Set((e.tags || []).map(norm));
    // 首词索引遍历：只在标题词命中候选首词时才做完整正则测试
    const toks = title.match(/[a-z0-9\-]{3,}/g) || [];
    for (const [mode, idx] of MODES) {
      const m = perTag[mode][split];
      const hit = new Set();
      for (const tok of toks) {
        const cands = idx.get(tok);
        if (!cands) continue;
        for (const c of cands) {
          if (hit.has(c.tag)) continue;
          if (!c.re.test(title)) continue;
          hit.add(c.tag);
          stat[mode][split].pred++;
          let s = m.get(c.tag);
          if (!s) { s = { pred: 0, tp: 0 }; m.set(c.tag, s); }
          s.pred++;
          if (gold.has(c.tag)) { stat[mode][split].tp++; s.tp++; }
        }
      }
    }
  }
  console.log(`[耗时] 三组配置 × 两个划分共 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[划分] 标定 ${SPLIT} 条｜留一评估 ${labeled.length - SPLIT} 条`);
  console.log('');

  const NAMES = {
    variants: 'variants  2 词子串扩展（线上现状）',
    exact:    'exact     仅标签串本身',
    guarded:  'guarded   子串扩展但剔除「子短语本身是词表标签」',
  };
  for (const [mode] of MODES) {
    for (const sp of ['calib', 'eval']) {
      const p = stat[mode][sp].pred ? stat[mode][sp].tp / stat[mode][sp].pred : 0;
      const label = `${NAMES[mode]} · ${sp === 'calib' ? '标定集' : '留一评估'}`;
      console.log(`${label.padEnd(46)} pred=${String(stat[mode][sp].pred).padStart(7)}  TP=${String(stat[mode][sp].tp).padStart(6)}  precision=${p.toFixed(4)}`);
    }
  }
  console.log('');

  // 只评判样本内 gold >= 20 的标签：这些标签的 TP 才有信息量
  const judgable = new Set(goldInVocab.filter(([, n]) => n >= 20).map(([t]) => t));
  const pr = (s) => (s.pred ? s.tp / s.pred : 0);
  const cell = (s) => (s && s.pred ? `${s.pred}/${s.tp}/${pr(s).toFixed(3)}` : '-');

  // 逐标签标定精度（calib），只有 pred>=50 才敢据此筛词表
  const MIN_SUPPORT = 50;
  const PR_TH = 0.2;
  const tagPr = new Map();
  for (const [tag, s] of perTag.guarded.calib) {
    if (s.pred >= MIN_SUPPORT) tagPr.set(tag, s.tp / s.pred);
  }
  const keep = new Set([...tagPr.entries()].filter(([t, p]) => p >= PR_TH).map(([t]) => t));
  console.log(`[词表筛选] 标定集有 ${tagPr.size} 个标签 pred>=${MIN_SUPPORT} 可标定，其中 precision>=${PR_TH} 的 ${keep.size} 个入选`);

  console.log('\n可评判标签逐标签 pred/TP/precision（标定为筛词表依据，留一为诚实评估）');
  console.log('标签'.padEnd(40) + 'gold'.padStart(5) + '  ' + 'guarded·标定'.padStart(14) + '  ' + 'guarded·留一'.padStart(14));
  console.log('-'.repeat(86));
  console.log('（标签前 · = 标定 precision < ' + PR_TH + '，被筛出词表）');
  const rows = [...perTag.variants.calib.entries()]
    .filter(([t]) => judgable.has(t))
    .sort((a, b) => b[1].pred - a[1].pred)
    .slice(0, 24);
  for (const [tag] of rows) {
    const sc = perTag.guarded.calib.get(tag) || { pred: 0, tp: 0 };
    const se = perTag.guarded.eval.get(tag) || { pred: 0, tp: 0 };
    const g = goldDf.get(tag) || 0;
    const kept = keep.has(tag);
    const nm = (kept ? '' : '·') + tag.slice(0, 39);
    console.log(
      `${nm.padEnd(40)}` +
      `${String(g).padStart(5)}` +
      `  ${cell(sc).padStart(14)}` +
      `  ${cell(se).padStart(14)}`
    );
  }

  // 最终裁决：筛选后的词表在**留一评估集**上的表现
  let fp = 0, ftp = 0;
  for (const [tag, s] of perTag.guarded.eval) {
    if (!keep.has(tag)) continue;
    fp += s.pred; ftp += s.tp;
  }
  const totalEvalPred = stat.guarded.eval.pred, totalEvalTp = stat.guarded.eval.tp;
  console.log('');
  console.log('最终裁决（留一评估集，2,200 全词表 vs 筛选后）');
  console.log(`  guarded 全词表   pred=${String(totalEvalPred).padStart(6)}  TP=${String(totalEvalTp).padStart(5)}  precision=${(totalEvalTp / totalEvalPred).toFixed(4)}`);
  console.log(`  guarded 筛选后   pred=${String(fp).padStart(6)}  TP=${String(ftp).padStart(5)}  precision=${fp ? (ftp / fp).toFixed(4) : 0}`);
}

main();
