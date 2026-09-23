#!/usr/bin/env node
/**
 * 能力域④-学术实体扩库：pipeline-openalex-expand.js
 *
 * 从 OpenAlex（免费、无需 key、全球最大开放学术知识图谱）批量拉取与 14 站主题
 * 相关的科研著作（works），结构化、去重、归类后写入 data/academic-entities.json。
 *
 * 设计约束（2026-09-23）：
 *   - 落点仅在 data/，不写入 sites/<site>/_data/entities.json，避免撑爆 CF Pages（已 955MB/1GB）。
 *   - 体积受控：单实体精简字段，总量封顶 MAX_TOTAL，确保 data/ 复制进 _site/data/ 不超 60MB 余量。
 *   - 幂等：按 openalex_id / doi 去重；重跑只 upsert 不重复计数。
 *   - 限流：per-page=200，请求间隔 120ms，无 key 也远低于 OpenAlex 限流。
 *
 * 用法：
 *   node operations-plan/pipeline-openalex-expand.js [--dry-run] [--max-total=5000]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'academic-entities.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'reports', `report-openalex-expand-${Date.now()}.json`);

const DRY = process.argv.includes('--dry-run');
const getArg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const MAX_TOTAL = parseInt(getArg('max-total', '5000'), 10);
const PAGES_PER_TERM = parseInt(getArg('pages', '3'), 10);
const PER_PAGE = 200;
const DELAY_MS = 120;

// 14 站主题 → OpenAlex 检索词（title_and_abstract.search 高召回）
const TERMS = [
  ['ai-agents', 'autonomous AI agent'],
  ['mcp', 'model context protocol'],
  ['quantum-computing', 'quantum computing'],
  ['brain-science', 'neuroscience brain'],
  ['biomed-ai', 'biomedical artificial intelligence'],
  ['biocomputing', 'biocomputing'],
  ['bionic-ai', 'bionic prosthesis AI'],
  ['embodied-ai', 'embodied AI robotics'],
  ['edge-ai', 'edge AI inference'],
  ['ai4science', 'AI for science'],
  ['digital-twin', 'digital twin'],
  ['carbon-neutral', 'carbon neutral climate'],
  ['agritech', 'agriculture AI'],
  ['deep-sea-tech', 'deep sea technology'],
  ['exo-science', 'exobiology'],
  ['alien-minerals', 'astrobiology mineral'],
];

// 简易归类（与 TERMS 站名对齐，命中即归入对应站）
function classifySite(text) {
  const t = text.toLowerCase();
  const hits = [];
  for (const [site, kw] of TERMS) {
    if (t.includes(kw.split(' ')[0]) || t.includes(kw)) hits.push(site);
  }
  if (hits.length === 0) hits.push('papers');
  return [...new Set(hits)];
}

// 由 abstract_inverted_index 重建摘要文本
function rebuildAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const pos = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = w;
  return Object.keys(pos).sort((a, b) => a - b).map((i) => pos[i]).join(' ').trim();
}

function httpGetJson(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Genetech14-InfraBot/1.0 (mailto:ops@swarmlabs.tools)' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); }
        } else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 退避重试：OpenAlex 对共享出口 IP 限流严格，遇到 429 指数退避后重试
async function fetchWithRetry(url, maxRetry = 6) {
  let wait = 1500;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await httpGetJson(url);
    } catch (e) {
      if (String(e.message).includes('429') && i < maxRetry) {
        console.warn(`  [429] 退避 ${wait}ms 后重试 (${i + 1}/${maxRetry})`);
        await sleep(wait);
        wait = Math.min(wait * 2, 20000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('retry exhausted');
}

async function fetchTerm(term, site) {
  const out = [];
  let cursor = '*';
  for (let p = 0; p < PAGES_PER_TERM; p++) {
    const url = `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(term)}&per-page=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}&sort=publication_date:desc`;
    try {
      const j = await fetchWithRetry(url);
      for (const w of j.results || []) {
        const doi = w.doi || '';
        const oaId = (w.id || '').replace('https://openalex.org/', '');
        const title = (w.title || w.display_name || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const abstract = rebuildAbstract(w.abstract_inverted_index);
        const concepts = (w.concepts || []).map((c) => c.display_name).filter(Boolean).slice(0, 8);
        const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean).slice(0, 10);
        const text = `${title} ${abstract} ${concepts.join(' ')}`;
        out.push({
          id: `oa:${oaId}`,
          source: 'openalex',
          openAlexId: oaId,
          doi,
          title,
          abstract: abstract.slice(0, 1200),
          url: doi ? `https://doi.org/${doi.replace('https://doi.org/', '')}` : (w.landing_page_url || w.id || ''),
          authors,
          year: w.publication_year || null,
          concepts,
          tags: classifySite(text),
          sites: classifySite(text),
          referencedBy: w.cited_by_count || 0,
          confidence: 0.7,
          fetchedAt: new Date().toISOString(),
        });
      }
      cursor = j.meta?.next_cursor || '';
      if (!cursor) break;
    } catch (e) {
      console.error(`[OpenAlex][${site}] page ${p} 失败: ${e.message}`);
      break;
    }
    await sleep(DELAY_MS);
  }
  return out;
}

(async () => {
  const existing = (() => { try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return []; } })();
  const byKey = new Map();
  for (const e of existing) byKey.set(e.doi || e.openAlexId || e.id, e);
  let added = 0, updated = 0;

  for (const [site, term] of TERMS) {
    if (byKey.size >= MAX_TOTAL) { console.log(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止`); break; }
    console.log(`[OpenAlex] 拉取 term="${term}" (站=${site}) ...`);
    const items = await fetchTerm(term, site);
    for (const it of items) {
      const k = it.doi || it.openAlexId || it.id;
      if (byKey.has(k)) { updated++; continue; }
      byKey.set(k, it); added++;
    }
    console.log(`  → 累计 ${byKey.size} 条 (本轮 +${items.length})`);
  }

  const all = Array.from(byKey.values());
  const report = {
    pipeline: 'openalex-expand',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    added, updated, total: all.length,
    bySite: all.reduce((m, e) => { for (const s of (e.sites || [])) m[s] = (m[s] || 0) + 1; return m; }, {}),
    maxTotal: MAX_TOTAL,
  };

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(all, null, 2), 'utf-8');
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[openalex-expand] total=${all.length} added=${added} updated=${updated}` + (DRY ? ' (dry-run)' : ''));
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
