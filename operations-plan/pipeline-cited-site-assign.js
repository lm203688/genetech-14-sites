#!/usr/bin/env node
/**
 * pipeline-cited-site-assign.js —— 给补齐的「被引文档」推断所属站点（可审计，不回填图）
 *
 * 背景（2026-10-04）：
 *   引用边要求「被引文档在某个站内」。但被引文档有 96.2% 不是站点实体，
 *   而 30 站实体表全部满容（30×10,000），塞不进去。
 *   唯一能让它变成图节点的办法，是用 OpenAlex 的 concepts 把它归属到某一站。
 *
 * ⚠️ 这不是免费的：早期一版用「concepts 里含站点标签的子串就判给该站」，
 * 结果 200 条样本里 92% 都判出了站，但错得很离谱 ——
 *   「A Markovian Decision Process」（纯数学）→ biomed-ai
 *   「visual servoing in robotics」         → sat-6g
 * 覆盖率好看、精度为零。用这种归属建出来的「跨站引用缺口」是假的，
 * 而「缺口」是我们对外卖的第一结论，错了就是负资产。
 *
 * 所以这一版做三件事：
 *   1) 打分改用「词边界 + 概念带权重」，并用**与次名的分差（margin）**卡阈值，
 *      而不是「只要匹配到 1 个标签就算命中」；
 *   2) 每条归属都带 score / margin / confidence，下游可以自己按阈值筛；
 *   3) 跑完强制打印**随机抽样的可人工复核样本**——不看样本就说"精度不错"是自欺。
 *
 * 产出：data/cited-site-assign.json（默认 dry-run 语义：只打印不写盘，--write 才写）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __file = fileURLToPath(import.meta.url);

// ⚠️ 真正的 main() 调用放在**文件末尾**（见文件尾）。
// 守卫不能写在顶部：下面的 SITE_DOMAIN 是 const，模块顶层是从上往下执行的，
// 在它之前调 main() 会撞 TDZ（Cannot access 'SITE_DOMAIN' before initialization）。
// 本文件里已经栽过一次（pipeline-academic-datasets 的 academicAll），这里是同一个坑的第三例：
// 「被 import 复用的脚本 + 顶层 const」的组合下，把 CLI 入口放在声明之前必然炸。
const SITE_DOMAIN = {
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

// 站点标签 → 同义词。
// 必须有这张表：单用词边界硬匹配会把缩写卡死 ——
// `cs` 永远匹配不到 "Computer science"、`env` 永远匹配不到 "environmental"、
// `ML` 匹配不到 "machine learning"。结果 digital-twin / carbon-neutral / agritech /
// deep-sea-tech 这些站**永远归不到任何文档**，覆盖率直接塌到 1.8%。
// 但也不能反过来：早一版做裸子串匹配，"ai" 命中 "chain"、"neuro" 命中
// "neuromorphic"（这俩其实是同一件事，不算跨站），错得很离谱。
// 折中：固定同义词 + 词边界，宁可漏判也不乱判（漏判只是少一条候选边，乱判会写错结论）。
const TAG_SYN = {
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
const SYN_OF = (tag) => TAG_SYN[tag] || [tag];

// 权重：标题是最高信号；概念按 OpenAlex 自己的 score 加权；topic 次之。
const W_TITLE = 3;
const W_CONCEPT = 1;
const W_TOPIC = 1;

async function main() {
  const ARGV = process.argv.slice(2);
  const WRITE = ARGV.includes('--write');
  const getArg = (k, d) => {
    const a = ARGV.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
    return a ? a.slice(`--${k}=`.length) : d;
  };
  const MIN_SCORE = Number(getArg('min-score', '2')) || 2;   // 命中站点至少几个加权点
  const MIN_MARGIN = Number(getArg('min-margin', '1')) || 1; // 必须压过第二名
  const AUDIT_N = Number(getArg('audit', '25')) || 25;
  const SAMPLE_N = Number(getArg('sample', '2000')) || 2000; // 给自己打分用多少条抽样（不写盘）

  const ROOT = path.resolve(path.dirname(__file), '..');
  const DATA = path.join(ROOT, 'data');
  const OUT = path.join(DATA, 'cited-site-assign.json');

  const citedPath = path.join(DATA, 'cited-entities.json');
  if (!fs.existsSync(citedPath)) {
    // 2026-10-04：这个文件 78MB 是工作资产、不入库，CI（以及换了台机器的任何人）上必然没有。
    // 缺它就跳过并退出 0 —— 它不是门禁（真门禁是 verify-shard-fidelity.mjs），
    // 在这里 exit 2 只会让「手动派发一次补充任务」这种正常用法永远红。
    console.warn('[skip] 没有 data/cited-entities.json（78MB 工作资产，不入库）→ 跳过归属推算，先跑 pipeline-cited-backfill.js');
    return;
  }
  const wrap = JSON.parse(fs.readFileSync(citedPath, 'utf8'));
  const items = Array.isArray(wrap) ? wrap : (wrap.entities || []);
  console.log(`候选被引文档 ${items.length} 条（取前 ${Math.min(SAMPLE_N, items.length)} 条打分）`);

  // 同义词逐条编译成「词边界」正则：同义词本身允许带空格，
  // 外层用非字母包住，这样 "ai" 不会命中 "chain"（裸子串那个坑）。
  const reCache = new Map();
  const re = (token) => {
    if (!reCache.has(token)) {
      const body = token.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const esc = /^[a-z]+$/.test(body) ? body : body.replace(/\s+/g, '\\s+');
      reCache.set(token, new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i'));
    }
    return reCache.get(token);
  };

  // 必须**跨距抽样**，不能取前 N 条：产物按抓取完成顺序排列，前 N 条就是最早那一批，
  // 拿它们审计等于只审计了第一批的域名分布，然后拿结论去推断全量精度。
  const stride = items.length / SAMPLE_N;
  const sample = Array.from({ length: Math.min(SAMPLE_N, items.length) }, (_, i) => items[Math.floor(i * stride)]);
  const rows = [];
  let unassigned = 0;
  const perSite = {};
  // 产物瘦身：55k 条如果连 evidence 全量写进去，文件会到几十 MB。
  // evidence 的价值是「可解释 / 可复核」，而复核本来就是跑的时候看 stdout 的抽样审计，
  // 产物里留不下反而干净；score/margin/confidence 三个数足够下游自己再筛。
  const slim = (r) => ({ doi: r.doi, site: r.site, score: r.score, margin: r.margin, confidence: r.confidence });
  for (const it of sample) {
    const title = String(it.title || '');
    const concepts = (it.concepts || []).map((c) => ({ n: String(c.name || ''), s: c.score || 0 }));
    const topics = (it.topics || []).map((t) => String(t || ''));
    const scores = {};
    for (const [site, tags] of Object.entries(SITE_DOMAIN)) {
      let sc = 0; const hits = [];
      for (const tag of tags) {
        const syns = SYN_OF(tag);
        const rOf = syns.map((s) => re(s));
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
    const list = Object.entries(scores).sort((a, b) => b[1].sc - a[1].sc);
    if (!list.length || list[0][1].sc < MIN_SCORE) { unassigned++; continue; }
    const best = list[0], second = list[1];
    const margin = second ? +(best[1].sc - second[1].sc).toFixed(2) : best[1].sc;
    if (margin < MIN_MARGIN) { unassigned++; continue; }
    rows.push({
      doi: it.doi, site: best[0], score: +best[1].sc.toFixed(2), margin: +margin.toFixed(2),
      confidence: margin >= 2 ? 'high' : margin >= MIN_MARGIN ? 'medium' : 'low',
      title: title.slice(0, 70),
      evidence: best[1].hits.slice(0, 4),
      concepts: concepts.slice(0, 5).map((c) => c.n),
    });
    perSite[best[0]] = (perSite[best[0]] || 0) + 1;
  }

  const rate = (100 * rows.length) / Math.max(1, sample.length);
  console.log(`\n--- 抽样 ${sample.length} 条 → 归属成功 ${rows.length}（${rate.toFixed(1)}%），未归属 ${unassigned} ---`);
  console.log(`阈值：score ≥ ${MIN_SCORE} 且 margin ≥ ${MIN_MARGIN}`);
  console.log('站点分布 top12:', Object.entries(perSite).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => x[0] + ':' + x[1]).join(' '));

  // ---- 精度审计：不看样本就说"精度不错"是自欺 ----
  const audit = [];
  const pool = [...rows];
  for (let i = 0; i < AUDIT_N && pool.length; i++) {
    audit.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  console.log(`\n=== 人工复核样本（随机抽 ${audit.length} 条，请逐条看「标题 → 归属站」对不对）===`);
  for (const a of audit) {
    console.log(` [${a.confidence}] ${a.site} (score=${a.score} margin=${a.margin})\n   标题: ${a.title}\n   证据: ${a.evidence.join(' | ')}`);
  }

  console.log(`\n[${WRITE ? 'WRITE' : 'DRY'}] 归属 ${rows.length} 条` + (WRITE ? ' → data/cited-site-assign.json' : '（加 --write 才写盘）'));
  if (WRITE) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      method: 'SITE_DOMAIN 标签 × (标题/概念/主题) 词边界匹配，概念按 OpenAlex score 加权',
      thresholds: { minScore: MIN_SCORE, minMargin: MIN_MARGIN },
      sampled: sample.length, assigned: rows.length, rate: +rate.toFixed(1),
      auditSampleSize: audit.length,
      // 完整 evidence（含命中哪几个 concept）见 pipeline 跑完后的 stdout 抽样审计；
      // 产物里只留可再筛选的分数三元组，避免几十 MB 的冗余
      assignments: rows.map(slim),
    }, null, 2), 'utf-8');
  }
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
