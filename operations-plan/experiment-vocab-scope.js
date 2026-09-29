#!/usr/bin/env node
/**
 * experiment-vocab-scope.js — 定向实验：词表 LF 的匹配作用域对准确率的影响
 *
 * 动机（2026-09-29）
 *   lf_corpus_vocab 全量 accuracy 只有 0.061。已修掉单词标签的摘要噪声
 *   （human 25,098 → 4,985），但准确率几乎没动。
 *   假设：问题不在作用域（标题 vs 摘要），而在**概念粒度**——
 *   OpenAlex 概念标签由它自己的 NLP 管线指派，"artificial intelligence and
 *   image processing" 这类复合概念要求论文的主题归属，而正文提到两个词
 *   并不等于被指派该概念。若如此，收紧作用域也救不了。
 *
 * 修正记录（2026-09-29，第一批结果作废）
 *   早先 runEntity 里写 `if (gold.has(tag)) continue;` —— 把真实标签整体剔出
 *   候选预测空间，而 TP 又按「预测 ∩ gold」计算。两者自相矛盾，5 组配置的
 *   TP 因此结构性恒为 0、precision 全 0.0000。已删除该行，重跑得有效结果。
 *   那一批里**只有覆盖率与耗时两列仍有效**（与预测无关），已被本轮复算取代。
 *
 * 做法：只在 30,000 条已标注实体上做五组对照（不需要全量重跑）
 *   A. 多词→标题+摘要，单词→标题        （当前线上配置）
 *   B. 全部→仅标题
 *   C. 全部→仅标题首 80 字符
 *   D. 全部→标题+摘要前 300 字符
 * 每组合并所有短语为单个投票，算 precision / recall / coverage。
 *
 *   precision = TP / pred         （预测里有多少是真标签）
 *   recall    = TP / goldSpace    （goldSpace = 真实标签中落在词表内的部分；
 *                                  词表外标签不可召回，不计分母，避免稀释）
 *
 * 用法：node operations-plan/experiment-vocab-scope.js
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

// 建立"标签 → 短语正则"（与线上 LF 相同的正则构造）
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tagPatterns = new Map();   // tag -> [{re, phrase, multi}]
for (const [tag, meta] of Object.entries(vocab.vocabulary || {})) {
  const ps = meta.phrases || [];
  tagPatterns.set(tag, ps.map(ph => ({ re: new RegExp('(?:^|[^a-z0-9])' + esc(ph) + '(?:[^a-z0-9]|$)'), phrase: ph, multi: ph.includes(' ') })));
}

/**
 * 预测一条实体的标签集。
 *
 * 注意（2026-09-29 修 bug）：早先这里写 `if (gold.has(tag)) continue;`，
 * 把真实标签整体剔出候选预测空间，而 TP 又按「预测 ∩ gold」算 ——
 * 两者自相矛盾，导致 5 组配置的 TP 结构性恒为 0、precision 全 0.0000，
 * 那一批结果无效。正确做法是保留完整候选空间，直接算 out ∩ gold。
 */
function runEntity(e, scope) {
  const title = String(e.name || e.title || '').toLowerCase();
  const abs = String(e.abstract || e.summary || '').toLowerCase();
  const gold = new Set((e.tags || []).map(t => String(t).toLowerCase().trim().replace(/\s+/g, ' ')));
  const out = new Set();
  for (const [tag, pats] of tagPatterns) {
    for (const p of pats) {
      let hay;
      if (scope === 'A') hay = p.multi ? title + ' ' + abs : title;
      else if (scope === 'B') hay = title;
      else if (scope === 'C') hay = title.slice(0, 80);
      else if (scope === 'D') hay = title + ' ' + abs.slice(0, 300);
      else hay = title + ' ' + abs;
      if (p.re.test(hay)) { out.add(tag); break; }
    }
  }
  let tp = 0, goldSpace = 0;
  for (const t of gold) {
    if (!tagPatterns.has(t)) continue;   // 词表外的真实标签不可召回，不计分母
    goldSpace++;
    if (out.has(t)) tp++;
  }
  return { pred: out.size, tp, goldSpace, out, gold };
}

function main() {
  const sites = discoverSites();
  const labeled = [];
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      const tags = e.tags || [];
      if (!tags.length) continue;
      if (!String(e.abstract || '').length) continue;   // 无摘要无法参与对照
      labeled.push(e);
      if (labeled.length >= 30000) break;
    }
    if (labeled.length >= 30000) break;
  }
  console.log(`[实验] 语料已标注实体 ${labeled.length}，词表 ${tagPatterns.size} 个标签`);

  const scopes = {
    'A 多词=标题+摘要 / 单词=标题（线上）': 'A',
    'B 全部仅标题': 'B',
    'C 全部仅标题前80字': 'C',
    'D 标题+摘要前300字': 'D',
    'E 全部标题+摘要（基线）': 'E',
  };

  console.log('\n配置                                    pred     TP  precision  recall  覆盖率  耗时');
  console.log('-'.repeat(110));
  // 同时为线上配置(A)与最保守配置(B)累积逐标签统计，用于判定是否「概念粒度」问题
  const perTag = { A: new Map(), B: new Map() };
  for (const [name, code] of Object.entries(scopes)) {
    let pred = 0, tp = 0, goldSpace = 0, covered = 0, total = 0;
    const t0 = Date.now();
    for (const e of labeled) {
      const r = runEntity(e, code);
      total++;
      pred += r.pred;
      tp += r.tp;
      goldSpace += r.goldSpace;
      if (r.pred > 0) covered++;
      if (code === 'A' || code === 'B') {
        const m = perTag[code];
        for (const t of r.out) {
          let s = m.get(t);
          if (!s) { s = { pred: 0, tp: 0 }; m.set(t, s); }
          s.pred++;
          if (r.gold.has(t)) s.tp++;
        }
      }
    }
    const precision = pred ? tp / pred : 0;
    const recall = goldSpace ? tp / goldSpace : 0;
    const coverage = total ? covered / total : 0;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${name.padEnd(38)} ${String(pred).padStart(7)} ${String(tp).padStart(6)} ${precision.toFixed(4).padStart(10)} ${recall.toFixed(4).padStart(8)} ${(coverage * 100).toFixed(1).padStart(7)}% ${secs.padStart(6)}s`);
  }

  // 逐标签 precision：只看预测量最大的标签，判断错误是否集中在复合概念上
  console.log('\n逐标签 precision（预测量 Top 12，A=线上作用域 / B=仅标题）');
  console.log('-'.repeat(96));
  for (const code of ['A', 'B']) {
    const top = [...perTag[code].entries()]
      .sort((a, b) => b[1].pred - a[1].pred)
      .slice(0, 12);
    console.log(`\n[${code}]`);
    for (const [tag, s] of top) {
      const p = s.pred ? (s.tp / s.pred) : 0;
      console.log(`  ${tag.slice(0, 46).padEnd(46)} ${String(s.pred).padStart(6)} ${String(s.tp).padStart(5)} ${p.toFixed(4)}`);
    }
  }
}

main();
