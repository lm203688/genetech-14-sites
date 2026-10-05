/**
 * lib/site-domain-tags.mjs —— 30 站「站点 → 学科标签」的单一真源（2026-10-04 抽出来）
 *
 * 为什么要抽：
 *   pipeline-cited-site-assign.js（给被引文档推断归属到第几站）和
 *   pipeline-library-expand.js（把被引文档填进站点空位）用的是**同一套判断**——
 *   「这篇论文本来属于哪个站」。两份表各抄一份，改动时必然漂移，
 *   而漂移的后果很实在：一份是按「归属」口径算的推断边，另一份按「扩库」口径算的填充，
 *   两边口径不一致时，飞轮环环相扣的数字就对不上了。
 *
 *   SITE_DOMAIN 表本身的价值/风险见 assign.js 顶部注释：
 *   早期「子串包含即判给该站」的版本 92% 覆盖率、精度接近零，
 *   用这种归属建出来的「跨站引用缺口」是假的，而缺口是我们对外卖的第一结论。
 *   所以这一版保留原来的三件事：词边界 + 概念按 OpenAlex score 加权 +
 *   用「与次名的分差（margin）」卡阈值，而不是「命中 1 个标签就算」。
 */

/** 站点 → 它认的学科标签 */
export const SITE_DOMAIN = {
  'quantum-computing': ['quantum', 'ML'], 'quantum-materials': ['quantum', 'materials'],
  'brain-science': ['neuro', 'psych'], 'embodied-ai': ['robotics', 'ai'],
  'robot-parts': ['robotics'], 'ai4science': ['ai', 'ML'], 'biomed-ai': ['medicine', 'ai'],
  'biocomputing': ['biology', 'cs'], 'bionic-ai': ['biology', 'ai'], 'biotechnology': ['biotech'],
  'agritech': ['biology', 'env'], 'ai-safety': ['ai', 'psych'], 'edge-ai': ['ai', 'ML'],
  'neuromorphic': ['neuro', 'materials'], 'digital-twin': ['cs', 'env'],
  'privacy-computing': ['cs', 'ML'], 'deep-sea-tech': ['biology', 'env'],
  'carbon-neutral': ['env', 'materials'], 'new-energy': ['env', 'materials'],
  'low-altitude': ['robotics', 'materials'], 'synbio-manufacturing': ['biotech', 'cs'],
  'genetech-tools': ['ai', 'cs'], 'agent-ecosystem': ['ai', 'nlp'],
  'life-science': ['biology', 'biotech'], 'semiconductor': ['materials', 'cs'],
  'alien-minerals': ['materials'], 'sat-6g': ['cs', 'robotics'],
  'exo-science': ['biology', 'env'], 'tcm-tools': ['medicine', 'psych'],
  'nuclear-energy': ['env', 'materials'],
};

/** 学科标签 → 同义词。必须有这张表：`cs` 永远匹配不到 "Computer science"，
 *  `env` 匹配不到 "environmental"，digital-twin/carbon-neutral/agritech/deep-sea-tech
 *  这些站会永远归不到任何文档（覆盖率塌到 1.8%）。 */
export const TAG_SYN = {
  quantum: ['quantum', 'qubit'],
  ML: ['machine learning', 'deep learning', 'neural', 'ml'],
  materials: ['material', 'nanostructure', 'perovskite', 'thin film', 'photonic'],
  neuro: ['neuroscience', 'neural', 'brain', 'neurology'],
  psych: ['psychology', 'psychological', 'psychiatric', 'behaviour', 'behavior'],
  robotics: ['robot', 'robotics', 'robotic', 'actuator', 'manipulator', 'drone'],
  ai: ['artificial intelligence', 'ai ', 'intelligent', 'agent'],
  medicine: ['medicine', 'medical', 'clinical', 'patient', 'therapeutic', 'hospital'],
  biology: ['biology', 'biological', 'bioinformatics', 'gene', 'protein', 'genome', 'cell '],
  cs: ['computer science', 'computing', 'computer', 'informatics', 'software', 'algorithm'],
  biotech: ['biotechnology', 'biotech', 'synthetic biology', 'fermentation'],
  env: ['environmental', 'ecology', 'ecosystem', 'sustainability', 'climate', 'greenhouse'],
  nlp: ['natural language', 'nlp', 'language model', 'text mining'],
};

export const SYN_OF = (tag) => TAG_SYN[tag] || [tag];

// 权重：标题是最高信号；概念按 OpenAlex 自己的 score 加权；topic 次之。
export const W_TITLE = 3;
export const W_CONCEPT = 1;
export const W_TOPIC = 1;

/**
 * 把同义词逐条编译成「词边界」正则。
 * 同义词本身允许带空格，外层用非字母包住 ——
 * 这样 "ai" 不会命中 "chain"（裸子串那个坑），
 * 但 "artificial intelligence" 这种带空格的照样能匹配。
 */
export function compileMatcher() {
  const cache = new Map();
  return (token) => {
    if (!cache.has(token)) {
      const body = token.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const esc = /^[a-z]+$/.test(body) ? body : body.replace(/\s+/g, '\\s+');
      cache.set(token, new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i'));
    }
    return cache.get(token);
  };
}

/**
 * 给一篇文档对所有站打分，返回排序后的 [site, {sc, hits}] 列表。
 * doc 需要：{ title, concepts:[{name,score}], topics:[] }
 * 概念 score < 0.3 的忽略（OpenAlex 给低分概念就是"沾边不算"）。
 */
export function scoreSites(doc, matcher) {
  const title = String(doc.title || '');
  const concepts = (doc.concepts || []).map((c) => ({ n: String(c.name || ''), s: c.score || 0 }));
  const topics = (doc.topics || []).map((t) => String(t || ''));
  const scores = {};
  for (const [site, tags] of Object.entries(SITE_DOMAIN)) {
    let sc = 0;
    const hits = [];
    for (const tag of tags) {
      const rOf = SYN_OF(tag).map((s) => matcher(s));
      const matched = (text) => rOf.some((r) => r.test(text));
      if (matched(title)) { sc += W_TITLE; hits.push(tag + '@title'); }
      for (const c of concepts) {
        if (c.s < 0.3) continue;
        if (matched(c.n)) { sc += W_CONCEPT * c.s; hits.push(tag + '@' + c.n); }
      }
      for (const t of topics) if (matched(t)) { sc += W_TOPIC; hits.push(tag + '@topic'); }
    }
    if (sc > 0) scores[site] = { sc, hits };
  }
  return Object.entries(scores).sort((a, b) => b[1].sc - a[1].sc);
}

/**
 * 挑出最像的那一站。返回 { site, score, margin, confidence, evidence }，
 * 或 null（没过阈值）。
 *   MIN_SCORE 命中站点至少几个加权点
 *   MIN_MARGIN 必须压过第二名 —— 这是防止「跨学科论文被随便塞给一个站」的关键，
 *   跨学科论文是最典型的误报（早期版本 92% 覆盖率、精度接近零）。
 */
export function pickBestSite(doc, matcher, minScore = 2, minMargin = 1) {
  const list = scoreSites(doc, matcher);
  if (!list.length || list[0][1].sc < minScore) return null;
  const best = list[0], second = list[1];
  const margin = second ? +(best[1].sc - second[1].sc).toFixed(2) : best[1].sc;
  if (margin < minMargin) return null;
  return {
    site: best[0],
    score: +best[1].sc.toFixed(2),
    margin: +margin.toFixed(2),
    confidence: margin >= 2 ? 'high' : margin >= minMargin ? 'medium' : 'low',
    evidence: best[1].hits.slice(0, 4),
  };
}
