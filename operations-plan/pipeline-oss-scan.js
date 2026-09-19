#!/usr/bin/env node
/**
 * 开源平台扫描管道
 * pipeline-oss-scan.js
 *
 * 战略定位（2026-09-19）：本项目进化为「信息收集 + 结构化」的基础设施，
 *   下游消费者包括：小模型专业 KB / 蜂群科技数据基础 / 机器人项目路线建议 / 对外付费 API。
 *   本管道是"广度"扩展的核心：每日扫开源平台 → 结构化入库 → 供下游消费。
 *
 * 信号源（4 类，全部公开 API，零成本，无需 key）：
 *   1. GitHub trending：按 6 个 topic 拉 top-N（agent-infra / embodied-ai / llm / robotics / mcp / ai-safety）
 *   2. HuggingFace models：按 tag 拉 top-N（agent / robot / llm）
 *   3. HuggingFace datasets：按 tag 拉 top-N
 *   4. Papers with Code：trending papers（best-effort，失败跳过）
 *
 * 结构化字段（每实体 ~30 字段，见 README 数据契约）：
 *   source / name / url / description / license / stars / stars_7d / downloads
 *   / language / topics[] / param_size / task_type / first_commit_date
 *   / last_commit_date / last_release_date / domain_tags[] / maintenance_status
 *   / first_seen_at / last_seen_at
 *
 * 存储（三层，与站点 entities.json 解耦，不受 Pages 1GB 上限约束）：
 *   - data/oss-registry.json                    累计全量（去重 upsert）
 *   - reports/oss-scan-YYYY-MM-DD.json          当日快照
 *   - reports/oss-scan-trend.json               跨轮趋势（delta + top-N 变化）
 *   - state/oss-scan-cursor.json                游标（幂等，miss 不阻塞）
 *
 * 幂等：按 source+url 唯一键 upsert；重复扫描不重复计数。
 * 限流：GitHub 未鉴权 60/小时；有 GH_TOKEN 时 5000/小时。任一 429 直接跳过该源，
 *       下一轮自然重试。HF 无严格限流。PWC 遇 5xx 视为本轮 miss，不影响其他源。
 *
 * 用法：
 *   node operations-plan/pipeline-oss-scan.js [--dry-run] [--limit=50] [--sources=github,hf-model,hf-dataset,pwc]
 *
 * 环境变量：
 *   GH_TOKEN             GitHub PAT（可选，提升 60→5000 请求额度）
 *   OSS_SCAN_TOP_N       每源每 topic 抓取上限（默认 30）
 *   STRICT_OSS_SCAN=1    任一源失败即 exit 1（默认关闭，单源失败不影响其他源）
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const REGISTRY_PATH = path.join(DATA_DIR, 'oss-registry.json');
const CURSOR_PATH = path.join(STATE_DIR, 'oss-scan-cursor.json');

const TOPICS = {
  github: ['agent-infra', 'embodied-ai', 'llm', 'robotics', 'mcp', 'ai-safety', 'scientific-computing'],
  hfModel: ['agent', 'robot', 'llm', 'text-to-3d', 'vision-language-action'],
  hfDataset: ['agent', 'robot', 'text-to-3d', 'embodied-ai', 'robotics-manipulation'],
};

const DOMAIN_MAP = [
  ['embodied-ai', /embodied|robot|manipulation|vla|vln|legged|arm|x-arm|franka|ur5/i],
  ['agent-ecosystem', /agent|agentic|multi-agent|orchestrat|handoff|subagent/i],
  ['llm-frontier', /llm|language-model|transformer|gpt|qwen|llama|mistral|deepseek|reason/i],
  ['ai-safety', /safe|alignment|guardrail|redteam|jailbreak|safety/i],
  ['biomed-ai', /protein|fold|gene|bio|clinical|drug|medical/i],
  ['quantum-computing', /quantum|qiskit|qaoa|vqe/i],
  ['edge-ai', /edge|on-device|tinyml|mobile|inference/i],
  ['mcp', /mcp|model-context-protocol|tool-use|function-call/i],
  ['neuromorphic', /neuromorphic|spiking|synapse/i],
  ['semiconductor', /chip|asic|gpu|accelerator|tensor|compiler/i],
];

// ---- CLI args ----
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getArg = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const DRY = has('--dry-run');
const LIMIT = parseInt(getArg('limit', process.env.OSS_SCAN_TOP_N || '30'), 10);
const SOURCES = (getArg('sources', 'github,hf-model,hf-dataset,pwc'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT_OSS_SCAN === '1';

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const TODAY = new Date().toISOString().slice(0, 10);
const NOW_ISO = new Date().toISOString();

// ---- IO helpers ----
const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); };
const readJson = (p, fb) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; }
};
const writeJson = (p, obj) => { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8'); };

// ---- HTTP helpers ----
function httpGet(url, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'Genetech14-InfraBot/1.0', ...headers }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse fail ${url}: ${e.message}`)); }
        } else {
          const err = new Error(`HTTP ${res.statusCode} for ${url}`);
          err.status = res.statusCode;
          err.body = body.slice(0, 200);
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Timeout ${url}`)); });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Domain auto-tagging ----
function tagDomain(text) {
  const s = (text || '').toLowerCase();
  const hits = [];
  for (const [tag, re] of DOMAIN_MAP) if (re.test(s)) hits.push(tag);
  return [...new Set(hits)].slice(0, 4);
}

// ---- Maintenance status heuristic ----
function maintenanceStatus(lastActivityISO) {
  if (!lastActivityISO) return 'unknown';
  const days = (Date.now() - new Date(lastActivityISO).getTime()) / 86400000;
  if (days < 60) return 'active';
  if (days < 180) return 'stale';
  if (days < 365) return 'dormant';
  return 'abandoned';
}

// ---- Source 1: GitHub trending via Search API ----
async function scanGitHub() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;
  const out = [];
  const seen = new Set();
  for (const topic of TOPICS.github) {
    try {
      const url = `https://api.github.com/search/repositories?q=topic:${topic}+stars:%3E50&sort=stars&order=desc&per_page=${LIMIT}`;
      const data = await httpGet(url, headers, 25000);
      for (const r of data.items || []) {
        const key = `gh:${r.full_name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          source: 'github',
          name: r.name,
          fullName: r.full_name,
          url: r.html_url,
          description: r.description || '',
          license: (r.license && r.license.spdx_id) || 'unknown',
          stars: r.stargazers_count || r.stars || 0,
          forks: r.forks_count || r.forks || 0,
          watchers: r.subscribers_count || r.watchers || 0,
          language: r.language || null,
          topics: r.topics || [],
          firstCommitDate: r.created_at,
          lastCommitDate: r.updated_at,
          archived: !!r.archived,
          openIssues: r.open_issues || 0,
          pushedAt: r.pushed_at,
          domainTags: tagDomain(`${r.name} ${r.description} ${(r.topics || []).join(' ')}`),
          primaryTopic: topic,
        });
      }
      await sleep(300);
    } catch (e) {
      console.log(`  [GH] topic=${topic} failed: ${e.message}`);
      if (e.status === 403 || e.status === 429) {
        console.log('  [GH] rate limited, skipping remaining topics');
        break;
      }
    }
  }
  return out;
}

// ---- Source 2: HuggingFace models ----
async function scanHFModels() {
  const out = [];
  const seen = new Set();
  for (const tag of TOPICS.hfModel) {
    try {
      // HF API: /api/models?filter=<tag>&sort=downloads&direction=-1&limit=<N>
      const url = `https://huggingface.co/api/models?filter=${encodeURIComponent(tag)}&sort=downloads&direction=-1&limit=${LIMIT}`;
      const data = await httpGet(url, {}, 20000);
      for (const m of data || []) {
        const key = `hf-model:${m.id || m.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          source: 'hf-model',
          name: m.id || m.modelId,
          url: `https://huggingface.co/${m.id || m.modelId}`,
          description: (m.cardData && m.cardData.description) || '',
          tags: m.tags || [],
          downloads: (m.downloads || m.sibling_downloads) || 0,
          likes: m.likes || 0,
          framework: (m.cardData && m.cardData.library_name) || null,
          taskType: (m.cardData && (m.cardData.language_modalities || m.cardData.task_categories || []))
            .flat()
            .slice(0, 5),
          pipelineTag: (m.pipeline_tag) || null,
          createdAt: m.createdAt,
          domainTags: tagDomain(`${m.id} ${m.tags && m.tags.join(' ')}`),
          primaryTopic: tag,
        });
      }
      await sleep(300);
    } catch (e) {
      console.log(`  [HF-model] tag=${tag} failed: ${e.message}`);
    }
  }
  return out;
}

// ---- Source 3: HuggingFace datasets ----
async function scanHFDatasets() {
  const out = [];
  const seen = new Set();
  for (const tag of TOPICS.hfDataset) {
    try {
      const url = `https://huggingface.co/api/datasets?filter=${encodeURIComponent(tag)}&sort=downloads&direction=-1&limit=${LIMIT}`;
      const data = await httpGet(url, {}, 20000);
      for (const d of data || []) {
        const key = `hf-dataset:${d.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          source: 'hf-dataset',
          name: d.id,
          url: `https://huggingface.co/datasets/${d.id}`,
          description: '',
          tags: d.tags || [],
          downloads: (d.downloads || d.sibling_downloads) || 0,
          likes: d.likes || 0,
          taskCategory: (d.cardData && d.cardData.task_categories) || [],
          modality: (d.cardData && d.cardData.modality) || [],
          createdAt: d.createdAt,
          domainTags: tagDomain(`${d.id} ${d.tags && d.tags.join(' ')}`),
          primaryTopic: tag,
        });
      }
      await sleep(300);
    } catch (e) {
      console.log(`  [HF-dataset] tag=${tag} failed: ${e.message}`);
    }
  }
  return out;
}

// ---- Source 4: Papers with Code (best-effort) ----
async function scanPWC() {
  const out = [];
  try {
    // PWC API has been unstable; treat failures as soft miss
    const url = `https://paperswithcode.com/api/v1/papers/?papers__tasks__title__icontains=llm&page_size=${LIMIT}`;
    const data = await httpGet(url, {}, 20000);
    for (const p of data.results || data || []) {
      const key = `pwc:${p.slug || p.id}`;
      out.push({
        id: key,
        source: 'pwc',
        name: p.title || '',
        url: p.url || '',
        description: p.abstract || '',
        arxivId: p.arxiv || null,
        citations: p.citations || 0,
        codeRepos: (p.code || []).map((c) => ({ url: c.url, stars: c.stars, name: c.name })),
        domainTags: tagDomain(`${p.title} ${p.abstract}`),
        primaryTopic: 'papers',
      });
    }
  } catch (e) {
    console.log(`  [PWC] skipped: ${e.message}`);
  }
  return out;
}

// ---- Registry merge ----
function upsertRegistry(existing, incoming, cursor) {
  const index = new Map(existing.map((e) => [e.id, e]));
  let added = 0, updated = 0;
  for (const e of incoming) {
    const prev = index.get(e.id);
    const merged = {
      ...e,
      lastSeenAt: NOW_ISO,
      firstSeenAt: prev ? prev.firstSeenAt : NOW_ISO,
      scanCount: (prev ? prev.scanCount : 0) + 1,
    };
    // Update maintenance status based on last activity
    const lastActivity = merged.lastCommitDate || merged.createdAt || merged.lastSeenAt;
    merged.maintenanceStatus = maintenanceStatus(lastActivity);
    if (!prev) added++;
    else if (JSON.stringify(prev) !== JSON.stringify({ ...merged, scanCount: prev.scanCount + 1, firstSeenAt: prev.firstSeenAt, lastSeenAt: prev.lastSeenAt })) updated++;
    index.set(e.id, merged);
  }
  return { entities: [...index.values()], added, updated };
}

// ---- Trend report ----
function computeTrend(prevRegistry, newRegistry) {
  const prevStars = new Map(prevRegistry.map((e) => [e.id, e.stars || 0]));
  const newStars = new Map(newRegistry.map((e) => [e.id, e.stars || 0]));
  const starsGainers = [];
  for (const [id, s] of newStars) {
    const ps = prevStars.get(id);
    if (ps !== undefined && s > ps) starsGainers.push({ id, delta: s - ps, current: s });
  }
  starsGainers.sort((a, b) => b.delta - a.delta);
  return {
    totalEntities: newRegistry.length,
    prevTotal: prevRegistry.length,
    added: newRegistry.length - prevRegistry.length,
    topStarsGainers: starsGainers.slice(0, 15),
    bySource: newRegistry.reduce((acc, e) => { acc[e.source] = (acc[e.source] || 0) + 1; return acc; }, {}),
    byDomain: newRegistry.reduce((acc, e) => {
      (e.domainTags || []).forEach((t) => { acc[t] = (acc[t] || 0) + 1; });
      return acc;
    }, {}),
    maintenanceBreakdown: newRegistry.reduce((acc, e) => {
      const s = e.maintenanceStatus || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
  };
}

// ---- Main ----
async function main() {
  console.log(`[OSS-SCAN] ${NOW_ISO} | dry=${DRY} | limit=${LIMIT} | sources=${SOURCES.join(',')}`);
  ensureDir(DATA_DIR);
  ensureDir(REPORTS_DIR);
  ensureDir(STATE_DIR);

  const prevRegistry = readJson(REGISTRY_PATH, []);
  const cursor = readJson(CURSOR_PATH, { lastRun: null, runs: [] });

  const results = { sources: {}, errors: [] };
  const allIncoming = [];

  for (const src of SOURCES) {
    console.log(`\n[${src}] scanning...`);
    let entries = [];
    try {
      if (src === 'github') entries = await scanGitHub();
      else if (src === 'hf-model') entries = await scanHFModels();
      else if (src === 'hf-dataset') entries = await scanHFDatasets();
      else if (src === 'pwc') entries = await scanPWC();
      else console.log(`  [unknown source ${src}] skipping`);
    } catch (e) {
      results.errors.push({ source: src, error: e.message });
      console.log(`  [${src}] FAILED: ${e.message}`);
      if (STRICT) { console.error(`STRICT_OSS_SCAN=1 → exit 1`); process.exit(1); }
    }
    results.sources[src] = { count: entries.length };
    console.log(`  → ${entries.length} entries`);
    allIncoming.push(...entries);
  }

  // Dedup by id (in case two sources returned same key — should not happen but defensive)
  const deduped = [];
  const seen = new Set();
  for (const e of allIncoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    deduped.push(e);
  }

  console.log(`\n[${deduped.length}] incoming entries after dedup`);
  if (DRY) {
    console.log('[DRY-RUN] Skipping writes.');
    console.log(`  by source:`, results.sources);
    console.log(`  top 5 domain tags:`, deduped.slice(0, 5).map((e) => e.domainTags).flat().filter(Boolean).slice(0, 10));
    return;
  }

  const { entities: merged, added, updated } = upsertRegistry(prevRegistry, deduped, cursor);
  const trend = computeTrend(prevRegistry, merged);

  // Write outputs
  writeJson(REGISTRY_PATH, merged);
  writeJson(path.join(REPORTS_DIR, `oss-scan-${TODAY}.json`), {
    date: TODAY,
    timestamp: NOW_ISO,
    sources: results.sources,
    errors: results.errors,
    incoming: deduped,
    added, updated, totalAfter: merged.length,
  });
  writeJson(path.join(REPORTS_DIR, 'oss-scan-trend.json'), {
    updatedAt: NOW_ISO,
    trend,
    prevTotal: prevRegistry.length,
    currentTotal: merged.length,
  });
  cursor.lastRun = NOW_ISO;
  cursor.runs = cursor.runs || [];
  cursor.runs.push({ date: TODAY, incoming: deduped.length, added, updated, total: merged.length });
  cursor.runs = cursor.runs.slice(-90); // keep last 90 days
  writeJson(CURSOR_PATH, cursor);

  console.log(`\n[OSS-SCAN] Summary:`);
  console.log(`  added: ${added} | updated: ${updated} | total: ${merged.length}`);
  console.log(`  by source:`, JSON.stringify(results.sources));
  console.log(`  by domain (top 5):`, Object.entries(trend.byDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join(', '));
  console.log(`  maintenance:`, JSON.stringify(trend.maintenanceBreakdown));
  console.log(`  top 3 stars gainers:`, trend.topStarsGainers.slice(0, 3).map((x) => `${x.id} +${x.delta}`).join(', ') || 'n/a');

  if (results.errors.length) {
    console.log(`\n[WARN] ${results.errors.length} sources failed (non-strict mode):`);
    results.errors.forEach((e) => console.log(`  - ${e.source}: ${e.error}`));
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(STRICT ? 1 : 0);
});
