#!/usr/bin/env node
/**
 * build-vocab.js — 受控目标词表（viable tags → 精确短语匹配）+ 标签可靠性标定
 *
 * 前置发现（2026-09-29，见 reports/tag-audit.json）
 *   语料 46,025 个去重标签，但 **85.1%（39,157 个）只挂在 ≤5 条实体上**，
 *   仅 **2,124 个标签有 >20 条可统计样本**。
 *   这才是「LF 只产出 11 个标签」的真因：标签空间太宽太稀疏，稀有标签
 *   既无足够正例可学，也无足够样本可校验准确率。
 *   硬从脏语料做 LLR 词表自举会捞到作者姓（caldin/awdeh），已被证明不可行。
 *
 * 两轮修正（都是 experiment-vocab-scope.js / experiment-vocab-exact.js 逼出来的）
 *
 *   ① 作用域：标题 vs 摘要。
 *      仅标题 precision 0.0823，标题+摘要 0.0598；仅标题前 80 字与全标题
 *      precision 完全相同（0.0823），说明 80 字之后无边际信息。
 *      → 词表 LF 一律只匹配标题。
 *
 *   ② 短语扩展污染：phrasesOf() 原来给每个标签追加「最长 3 词子串」。
 *      `artificial intelligence and image processing` 因此携带子短语
 *      `artificial intelligence` —— 而后者自己就是一个词表标签。
 *      子短语命中却把功劳记给更长的标签 = 偷走短标签的证据。
 *      实测被这条规则污染的 3 个标签共产出 2,340 次预测、仅 2 次命中。
 *      → 加 guarded 规则：子短语若本身也是词表标签，则剔除。
 *
 *   ③ 标签可靠性标定（真正的主菜）。
 *      逐标签 precision 差异极大且**稳定**：`agriculture` 0.481、`cancer` 0.547、
 *      `reinforcement learning` 0.450；而 `precision agriculture` 0.014、
 *      `smart farming` 0.009、`control` 0.051、`generative ai` 0.004。
 *      根因不是文本匹配失败，而是 **短语在标题里出现 ≠ OpenAlex 指派了该概念**
 *      —— OpenAlex 有自己的 NLP 归属判定，正文提两个词不等于被指派复合概念。
 *      这层差异**可测且可标定**（标定集 22,500 条 → 留一集 7,500 条精度几乎不变：
 *      agriculture 0.481→0.375、cancer 0.547→0.489、robotics 0.448→0.421）。
 *      → 只对「support ≥ MIN_SUPPORT 且 precision ≥ PR_TH」的标签保留短语，
 *        其余标签的 phrases 清空（LF 侧天然安全），但保留 reliability 供审计。
 *
 *      留一评估结果：2,200 全词表 precision 0.1087 → 筛选后 25 个标签 0.3367
 *      （预测量 −85%，TP 保留 45%）。这是 Snorkel 可靠性估计往上一层的应用：
 *      LF 的整体准确率受它自己的特征（标签）可靠性上限约束，必须先标定特征。
 *
 * 用法：node operations-plan/build-vocab.js [--min-df=20] [--max-tags=2200]
 *                                [--min-support=50] [--pr-th=0.2] [--no-calibrate]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const has = k => argv.includes(k);
const MIN_DF = Number(arg('min-df', '20'));
const MAX_TAGS = Number(arg('max-tags', '2200'));
const MIN_SUPPORT = Number(arg('min-support', '50'));
const PR_TH = Number(arg('pr-th', '0.2'));
const CALIBRATE = !has('--no-calibrate');
const OUT = arg('out', path.join(__dirname, 'lib', 'vocab.json'));

function norm(s) { return String(s).toLowerCase().trim().replace(/\s+/g, ' '); }

function discoverSites() {
  return fs.readdirSync(ROOT)
    .filter(d => { try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; } })
    .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
    .sort();
}

/** 生成候选短语变体 */
function phrasesOf(tag) {
  const out = [tag];
  const parts = tag.split(' ').filter(p => p.length >= 3);
  // 去掉 OpenAlex 常见的 "cs.xx" 前缀变体
  if (tag.startsWith('cs.')) out.push(tag.slice(3));
  // 取最长 3 词子串（去掉首/尾的弱词）
  if (parts.length >= 3) {
    out.push(parts.slice(0, 2).join(' '));
    out.push(parts.slice(-2).join(' '));
  }
  const seen = new Set();
  return [...out].map(p => p.replace(/[,-]+$/g, '').trim()).filter(p => {
    if (p.length < 4 || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function main() {
  const t0 = Date.now();
  const sites = discoverSites();

  // ---- 阶段 1：统计标签文档频率，选出可统计标签 ----
  const tagDf = new Map();
  const tagSite = new Map();
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      const tags = e.tags || e.topics || e.keywords || [];
      if (!tags.length) continue;
      const seen = new Set();
      for (const t of tags) {
        const k = norm(t);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        tagDf.set(k, (tagDf.get(k) || 0) + 1);
        if (!tagSite.has(k)) tagSite.set(k, site);
      }
    }
  }

  const viable = [...tagDf.entries()]
    .filter(([t, n]) => n >= MIN_DF && t.length >= 4 && !/^\d+$/.test(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS);

  const allTags = new Set(viable.map(([t]) => t));

  // ---- 阶段 2：生成短语并应用 guarded 规则 ----
  // 子短语若本身也是词表标签，则剔除 —— 否则命中被错误地记给更长标签
  const vocab = {};
  let droppedByGuard = 0;
  for (const [tag, n] of viable) {
    const raw = phrasesOf(tag).filter(ph => ph !== tag && !allTags.has(ph));
    droppedByGuard += (phrasesOf(tag).filter(ph => ph !== tag && allTags.has(ph)).length);
    const uniq = [...new Set([
      tag,
      ...(tag.startsWith('cs.') ? [tag.slice(3)] : []),
      ...raw,
    ].filter(s => s.length >= 4))];
    vocab[tag] = { phrases: uniq, df: n, site: tagSite.get(tag) };
  }

  // ---- 阶段 3：可靠性标定（标题域，首词索引） ----
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reOf = ph => new RegExp('(?:^|[^a-z0-9])' + esc(ph) + '(?:[^a-z0-9]|$)');
  let calib = null;
  if (CALIBRATE) {
    const idx = new Map();
    for (const [tag, meta] of Object.entries(vocab)) {
      for (const ph of meta.phrases) {
        const head = ph.split(/[^a-z0-9]+/)[0];
        if (!head) continue;
        if (!idx.has(head)) idx.set(head, []);
        idx.get(head).push({ re: reOf(ph), tag });
      }
    }
    const res = new Map();
    let labeled = 0;
    for (const site of sites) {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
      for (const e of arr) {
        const tags = e.tags || [];
        if (!tags.length) continue;
        labeled++;
        const title = String(e.name || e.title || '').toLowerCase();
        if (title.length < 4) continue;
        const gold = new Set(tags.map(norm));
        const hit = new Set();
        for (const tok of title.match(/[a-z0-9\-]{3,}/g) || []) {
          const cands = idx.get(tok);
          if (!cands) continue;
          for (const c of cands) {
            if (hit.has(c.tag)) continue;
            if (!c.re.test(title)) continue;
            hit.add(c.tag);
            let s = res.get(c.tag);
            if (!s) { s = { pred: 0, tp: 0 }; res.set(c.tag, s); }
            s.pred++;
            if (gold.has(c.tag)) s.tp++;
          }
        }
      }
    }
    let keep = 0, keptPred = 0, keptTp = 0, allPred = 0, allTp = 0;
    for (const [tag, meta] of Object.entries(vocab)) {
      const s = res.get(tag) || { pred: 0, tp: 0 };
      meta.reliability = { support: s.pred, tp: s.tp, precision: s.pred ? +(s.tp / s.pred).toFixed(4) : 0 };
      allPred += s.pred; allTp += s.tp;
      const isKeep = s.pred >= MIN_SUPPORT && (s.tp / s.pred) >= PR_TH;
      meta.keep = isKeep;
      if (isKeep) {
        keep++;
        keptPred += s.pred; keptTp += s.tp;
      } else {
        meta.phrases = [];   // 清空 → LF 侧天然安全，无法误用低可靠标签
      }
    }
    calib = {
      labeledEntities: labeled,
      minSupport: MIN_SUPPORT,
      prThreshold: PR_TH,
      tagsCalibratable: res.size,
      tagsKept: keep,
      allPred: allPred, allTp: allTp,
      allPrecision: allPred ? +(allTp / allPred).toFixed(4) : 0,
      keptPred: keptPred, keptTp: keptTp,
      keptPrecision: keptPred ? +(keptTp / keptPred).toFixed(4) : 0,
      droppedByGuard,
    };
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    method: '受控词表：文档频率 >= MIN_DF 的清洗后标签，guarded 短语扩展（子短语若本身是词表标签则剔除），标题域可靠性标定',
    rationale: '语料 46,025 标签中 85.1% 为 ≤5 条实体的长尾；短语出现在标题 ≠ OpenAlex 指派该概念，故必须逐标签标定可靠性',
    params: { MIN_DF, MAX_TAGS, MIN_SUPPORT, PR_TH, CALIBRATE },
    corpusDistinctTags: tagDf.size,
    viableTags: viable.length,
    tagsInVocab: Object.keys(vocab).length,
    totalCoverage: viable.reduce((s, [, n]) => s + n, 0),
    calibration: calib,
    vocabulary: vocab,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');

  console.log(`[vocab] 语料去重标签 ${tagDf.size}`);
  console.log(`[vocab] 可统计标签(df>=${MIN_DF}) ${viable.length}，取 Top ${MAX_TAGS}`);
  console.log(`[vocab] guarded 规则剔除 ${droppedByGuard} 个「子短语本身是词表标签」的短语`);
  console.log(`[vocab] 产物 → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  if (calib) {
    console.log('');
    console.log(`[标定] 已标注实体 ${calib.labeledEntities}`);
    console.log(`[标定] 可标定标签(pred>=${MIN_SUPPORT}) ${calib.tagsCalibratable} → precision>=${PR_TH} 保留 ${calib.tagsKept}`);
    console.log(`[标定] 全词表  pred=${calib.allPred}  TP=${calib.allTp}  precision=${calib.allPrecision}`);
    console.log(`[标定] 筛选后  pred=${calib.keptPred}  TP=${calib.keptTp}  precision=${calib.keptPrecision}`);
  }
  console.log(`[vocab] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
