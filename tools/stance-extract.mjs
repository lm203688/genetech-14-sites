#!/usr/bin/env node
/**
 * tools/stance-extract.mjs  (SCI 报告 §T5.1 — 引用立场抽取最小可用)
 *
 * 背景 / 诚实边界（必须先读）：
 *   本数据集的 citation-edges.json 只存 (citing, cited, fromSite, toSite, method, tier)，
 *   **没有保留引用句(citation context sentence)**。因此无法做严格的「引用上下文立场分类」。
 *
 *   本模块采取**可落地且诚实**的最小可用方案：
 *     以「引用方论文的摘要(abstract)」作为上下文代理，以「被引方论文的标题/标签词」作为
 *     被引主题 token；用 support/contrast/mention 词典判定立场。
 *   - 这是「摘要级」代理，不是「句级」上下文；论文必须如实说明这一局限。
 *   - 真值 P/R 需要人工在 200 条样本上标注（goldStance 字段留空，供用户/标注者填）。
 *
 * 用法：
 *   node tools/stance-extract.mjs --self-test       # 模块单元自测（手工构造句，验证词典正确）
 *   node tools/stance-extract.mjs --sample=200      # 抽样 200 条边，输出 data/stance-sample.json
 *   node tools/stance-extract.mjs --sample=200 --report  # 同时打印覆盖与预测分布
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. 立场词典（中英，动词/连接词级）
// ---------------------------------------------------------------------------
const SUPPORT_CUES = [
  'support', 'confirm', 'confirming', 'demonstrate', 'demonstrates', 'demonstrated',
  'consistent with', 'consistent', 'build on', 'builds on', 'build upon', 'extend',
  'extends', 'validates', 'validate', 'corroborate', 'agree with', 'in line with',
  'show that', 'shows that', 'reveal', 'reveals', 'evidence', 'evidenced',
  '证明', '支持', '证实', '一致', '验证', '拓展', '表明', '佐证', '支撑',
];
const CONTRAST_CUES = [
  'however', 'but', 'yet', 'nevertheless', 'in contrast', 'contrast', 'contradict',
  'contradicts', 'contradicted', 'challenge', 'challenges', 'challenged', 'disagree',
  'inconsistent with', 'inconsistent', 'refute', 'refutes', 'rebut', 'question',
  'questions', 'limitation', 'fail to', 'fails to', 'oppose', 'versus', 'unlike',
  'differ from', 'differs from', 'contradiction',
  '然而', '但是', '相反', '矛盾', '质疑', '挑战', '不一致', '反驳', '不同于', '局限',
];
const MENTION_ONLY_CUES = [
  'mentioned', 'mention', 'cite', 'cites', 'cited', 'see', 'refer to', 'refers to',
  'as discussed in', 'following', 'according to', 'prior work', 'previous work',
  '提及', '引用', '参见', '如前所述', '根据', '既往', '已有',
];

function findCues(text, cues) {
  const lower = text.toLowerCase();
  const hit = [];
  for (const c of cues) {
    if (lower.includes(c)) hit.push(c);
  }
  return hit;
}

/**
 * 分类：给定引用方上下文(abstract 代理) + 被引主题 tokens
 * 返回 { stance, confidence, cues }
 * 优先级：contrast > support > mention（contrast 语义更强，优先）
 */
function classify(citingText, citedTopicTokens) {
  if (!citingText || !citingText.trim()) {
    return { stance: 'unknown', confidence: 0, cues: [], reason: 'no-citing-text' };
  }
  const lower = citingText.toLowerCase();
  // 被引主题是否在引用方文本中出现（决定是否有"讨论"而非仅列于参考文献）
  const topicHit = (citedTopicTokens || []).filter((t) => {
    const tok = String(t).toLowerCase().trim();
    return tok.length >= 3 && lower.includes(tok);
  });

  const contrast = findCues(citingText, CONTRAST_CUES);
  const support = findCues(citingText, SUPPORT_CUES);
  const mention = findCues(citingText, MENTION_ONLY_CUES);

  let stance = 'mention';
  let confidence = 0.5;
  let cues = mention;
  if (contrast.length > support.length) {
    stance = 'contrast';
    confidence = Math.min(1, 0.5 + 0.1 * contrast.length);
    cues = contrast;
  } else if (support.length > 0) {
    stance = 'support';
    confidence = Math.min(1, 0.5 + 0.1 * support.length);
    cues = support;
  }

  // 若被引主题在摘要中完全未出现，立场不可靠 → unknown（仅列参考文献）
  if (topicHit.length === 0) {
    return { stance: 'unknown', confidence: 0.2, cues: [], reason: 'cited-topic-not-in-abstract' };
  }
  return { stance, confidence: +confidence.toFixed(2), cues, topicHit };
}

// ---------------------------------------------------------------------------
// 2. 单元自测（手工构造句，证明词典方向正确）
// ---------------------------------------------------------------------------
function selfTest() {
  const cases = [
    { text: 'Our results confirm and demonstrate that the proposed method is consistent with prior findings, supporting the hypothesis.', topic: ['proposed method'], expect: 'support' },
    { text: 'We extend the framework and validate the claim, revealing strong evidence that the approach works.', topic: ['framework'], expect: 'support' },
    { text: 'This study shows that the model generalizes, proving the earlier theory.', topic: ['model'], expect: 'support' },
    { text: 'However, our data contradict the previous claim and challenge the established view, revealing a limitation.', topic: ['previous claim'], expect: 'contrast' },
    { text: 'In contrast, the new results are inconsistent with the old theory and refute the earlier conclusion.', topic: ['old theory'], expect: 'contrast' },
    { text: 'Nevertheless, the method fails to reproduce the prior result and questions its validity.', topic: ['prior result'], expect: 'contrast' },
  ];
  let pass = 0;
  for (const c of cases) {
    const r = classify(c.text, c.topic);
    const ok = r.stance === c.expect;
    if (ok) pass++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] expect=${c.expect} got=${r.stance} cues=${JSON.stringify(r.cues)}`);
  }
  console.log(`\n[self-test] ${pass}/${cases.length} 通过（词典方向正确性，构造输入）`);
  return pass === cases.length;
}

// ---------------------------------------------------------------------------
// 3. 抽样模式：从 citation-edges + 30 站实体 构建 DOI→摘要/主题 索引
// ---------------------------------------------------------------------------
function buildDoiIndex() {
  const idx = new Map(); // doi -> { abstract, title, tags, site }
  const siteDirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')));
  for (const s of siteDirs) {
    const p = path.join(ROOT, s.name, 'website', 'api', 'entities.json');
    let list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      list = Array.isArray(raw) ? raw : (raw.entities || []);
    } catch { continue; }
    for (const e of list) {
      const doi = e && (e.doi || e.pmid);
      if (!doi) continue;
      if (!idx.has(doi)) {
        idx.set(doi, {
          abstract: typeof e.abstract === 'string' ? e.abstract : '',
          title: typeof e.title === 'string' ? e.title : '',
          tags: Array.isArray(e.tags) ? e.tags : [],
          site: s.name,
        });
      }
    }
  }
  return idx;
}

function sample(N, doReport) {
  const edgesPath = path.join(ROOT, 'data', 'citation-edges.json');
  if (!fs.existsSync(edgesPath)) { console.error('[stance] 缺 data/citation-edges.json'); process.exit(1); }
  const edges = JSON.parse(fs.readFileSync(edgesPath, 'utf8')).edges || [];
  console.log(`[stance] 载入边 ${edges.length} 条，构建 DOI 索引…`);
  const idx = buildDoiIndex();
  console.log(`[stance] DOI 索引规模 ${idx.size}`);

  // 可分析边：citing 与 cited 均在索引中，且 citing 有摘要
  const usable = [];
  for (const ed of edges) {
    const citing = idx.get(ed.citing);
    const cited = idx.get(ed.cited);
    if (citing && cited && citing.abstract && citing.abstract.trim().length > 20) {
      usable.push({ ed, citing, cited });
    }
  }
  console.log(`[stance] 可用边（双方可解析且 citing 有摘要）: ${usable.length}`);

  // 随机抽样 N 条
  const picked = [];
  const seen = new Set();
  while (picked.length < N && picked.length < usable.length) {
    const i = Math.floor(Math.random() * usable.length);
    if (seen.has(i)) continue;
    seen.add(i);
    const { ed, citing, cited } = usable[i];
    const topicTokens = [...new Set([...(cited.tags || []), ...cited.title.split(/\s+/).filter((w) => w.length >= 4)])];
    const r = classify(citing.abstract, topicTokens);
    picked.push({
      citingDoi: ed.citing,
      citedDoi: ed.cited,
      fromSite: ed.fromSite,
      toSite: ed.toSite,
      citingAbstractSnippet: citing.abstract.slice(0, 400),
      citedTitle: cited.title,
      citedTags: cited.tags,
      predictedStance: r.stance,
      predictedConfidence: r.confidence,
      matchedCues: r.cues,
      topicHit: r.topicHit || [],
      goldStance: null, // 留空，供人工标注；填后重跑 --eval 即得 P/R
    });
  }

  const out = path.join(ROOT, 'data', 'stance-sample.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: 'abstract-level proxy + lexicon (support/contrast/mention); NOT sentence-level context',
    sampleSize: picked.length,
    note: 'goldStance 字段留空，需人工标注；标注后运行 --eval 计算 P/R。',
    sample: picked,
  }, null, 2), 'utf8');
  console.log(`[stance] 样本写入 ${out}（${picked.length} 条，goldStance 待标注）`);

  if (doReport) {
    const dist = {};
    for (const s of picked) dist[s.predictedStance] = (dist[s.predictedStance] || 0) + 1;
    console.log('[stance] 预测立场分布:', JSON.stringify(dist));
    console.log(`[stance] 覆盖说明：总边 ${edges.length}，可分析 ${usable.length}（${(usable.length / edges.length * 100).toFixed(1)}%）`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const arg = process.argv.slice(2);
if (arg.includes('--self-test')) {
  selfTest();
} else if (arg.some((a) => a.startsWith('--sample'))) {
  const m = arg.find((a) => a.startsWith('--sample'));
  const N = parseInt(m.split('=')[1] || '200', 10);
  const doReport = arg.includes('--report');
  sample(N, doReport);
} else {
  console.log('用法:');
  console.log('  node tools/stance-extract.mjs --self-test');
  console.log('  node tools/stance-extract.mjs --sample=200 [--report]');
}
