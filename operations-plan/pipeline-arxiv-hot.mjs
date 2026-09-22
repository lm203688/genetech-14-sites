/**
 * Sprint 2: External Source Scanner
 * 拉取 arXiv 近 N 天新论文，按关键词匹配写入 data/arxiv-hot.json
 * 由 GitHub Actions scheduled workflow 每 4h 触发
 *
 * 用法:
 *   node operations-plan/pipeline-arxiv-hot.mjs
 *
 * 输出:
 *   data/arxiv-hot.json  - 结构化论文列表
 *     {
 *       generatedAt, window_days, keywords,
 *       papers: [{ id, title, authors, abstract, primaryCategory, publishedAt, url, matched_keywords }]
 *     }
 *
 * arXiv API: http://export.arxiv.org/api/query
 * 限速: 10s 间隔（arXiv 官方要求），本脚本单次拉取，符合限频
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 覆盖 14 站 + 通用 AI/quantum 主题
const KEYWORDS = [
  'CRISPR', 'gene editing', 'large language model', 'LLM agent',
  'multi-agent system', 'quantum computing', 'quantum error correction',
  'foundation model', 'diffusion model', 'retrieval augmented generation',
  'AI safety', 'neurosymbolic', 'protein design', 'genomics AI',
  'reinforcement learning', 'chain of thought', 'tool use',
];

const WINDOW_DAYS = parseInt(process.env.ARCHIV_WINDOW_DAYS || '30', 10);
const MAX_PAPERS_PER_KEYWORD = 20;
const SLEEP_MS = 3000; // arXiv 限速

const OUTPUT_PATH = join(ROOT, 'data', 'arxiv-hot.json');

function log(...args) { console.log(`[arxiv-hot ${new Date().toISOString()}]`, ...args); }

async function fetchArxiv(query, maxResults) {
  // arXiv API 返回 Atom XML；把空格换成 OR 提升命中，避免 all:"..." 短语过窄
  const q = encodeURIComponent(query.split(/\s+/).map((t) => `all:${t}`).join(' OR '));
  const url = `http://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  log(`fetch: ${query}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`arXiv ${r.status} for "${query}"`);
  const xml = await r.text();
  return parseAtom(xml);
}

function parseAtom(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml))) {
    const body = m[1];
    const pick = (re) => { const mm = body.match(re); return mm ? unescapeXml(mm[1]) : ''; };
    const id = pick(/<id>(.*?)<\/id>/);
    const title = pick(/<title>([\s\S]*?)<\/title>/).replace(/\s+/g, ' ').trim();
    const published = pick(/<published>(.*?)<\/published>/);
    const updated = pick(/<updated>(.*?)<\/updated>/);
    const summary = pick(/<summary>([\s\S]*?)<\/summary>/).replace(/\s+/g, ' ').trim();
    const primaryCatMatch = body.match(/<arxiv:primary_category[^/]*term="([^"]+)"/);
    const primaryCategory = primaryCatMatch ? primaryCatMatch[1] : '';
    const authors = [];
    const authorRegex = /<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/g;
    let am;
    while ((am = authorRegex.exec(body))) authors.push(unescapeXml(am[1]));
    if (id) {
      // http://arxiv.org/abs/2609.25002v1 → 2609.25002v1
      const arxivMatch = id.match(/arxiv\.org\/abs\/([^\/\s]+)/);
      const shortId = arxivMatch ? arxivMatch[1] : id.replace(/^arxiv:/, '').replace(/^https?:\/\/[^\/]+/, '').trim();
      entries.push({ id: shortId, title, authors, abstract: summary, primaryCategory, publishedAt: published, url: id });
    }
  }
  return entries;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function main() {
  log(`window=${WINDOW_DAYS}d, keywords=${KEYWORDS.length}, strategy=single OR query with dedup+time filter`);
  const all = new Map(); // id -> entry
  const startCutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const kwPatterns = KEYWORDS.map((k) => new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|s)`, 'i'));

  // 单次大 OR 查询 + 分页，比逐关键词查询快得多且覆盖更全
  const maxPerPage = 100;
  const pages = parseInt(process.env.ARCHIV_PAGES || '5', 10);
  for (let page = 0; page < pages; page++) {
    const start = page * maxPerPage;
    let xml = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`http://export.arxiv.org/api/query?search_query=all:paper&start=${start}&max_results=${maxPerPage}&sortBy=submittedDate&sortOrder=descending`, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`arXiv ${r.status} on page ${page}`);
        xml = await r.text();
        break;
      } catch (e) {
        log(`  retry ${attempt + 1} page ${page}: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    if (!xml) { log(`  SKIP page ${page} after 3 retries`); continue; }
    const entries = parseAtom(xml);
    let kept = 0;
    for (const p of entries) {
      if (!p.publishedAt) continue;
      const t = new Date(p.publishedAt);
      if (isNaN(t) || t < startCutoff) continue;
      // 匹配 keywords（检查 title+abstract）
      const text = `${p.title} ${p.abstract}`.toLowerCase();
      const matched = [];
      for (let i = 0; i < KEYWORDS.length; i++) {
        if (kwPatterns[i].test(text)) matched.push(KEYWORDS[i]);
      }
      if (!matched.length) continue;
      if (all.has(p.id)) {
        const prev = all.get(p.id);
        for (const m of matched) if (!prev.matched_keywords.includes(m)) prev.matched_keywords.push(m);
      } else {
        all.set(p.id, { ...p, matched_keywords: matched });
      }
      kept++;
    }
    log(`  page ${page} (start=${start}): fetched=${entries.length}, kept_in_window+kw_match=${kept}, total=${all.size}`);
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }

  const papers = Array.from(all.values()).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const out = {
    generatedAt: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    keywords: KEYWORDS,
    strategy: 'general_recent_scan + keyword_filter',
    total: papers.length,
    papers,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  log(`DONE. wrote ${papers.length} papers → ${OUTPUT_PATH.replace(ROOT + '/', '')}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
