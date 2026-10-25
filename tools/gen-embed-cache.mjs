#!/usr/bin/env node
/**
 * tools/gen-embed-cache.mjs
 *
 * 预生成 BGE-M3 语义向量缓存（分片：每站独立文件）
 *
 * 输入：{site}/website/api/entities.json（30 站，294,330 实体）
 * 输出：data/state/embed-cache-{site}.json（每站一个，key=entity.id → value=1024d 向量）
 *
 * 模型：Ollama /api/embed (BGE-M3, 566.70M, dim=1024)
 *       通过 http://127.0.0.1:11434/api/embed 批量调用
 *
 * 幂等：已存在的 cache entry 自动跳过，支持断点续跑
 * 分片：批量 32，串行（Ollama 单次并发足够）
 *
 * 文本格式与 mcp-server/src/search.mjs 的 SearchIndex._embed 严格一致：
 *   `${name}. ${tags}. ${abstract}`
 *   其中 name = e.name || e.title || ''，tags = Array(e.tags).join(' ')
 *
 * 用法：
 *   node tools/gen-embed-cache.mjs                             # 全部 30 站
 *   node tools/gen-embed-cache.mjs --sites=agent-ecosystem,ai-safety,quantum-computing
 *   node tools/gen-embed-cache.mjs --limit=1000                 # 每站最多 1000 条（pilot）
 *   node tools/gen-embed-cache.mjs --dry-run                     # 只统计不落盘
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'data', 'state');
const OLLAMA_BASE = process.env.GENETECH_EMBED_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.GENETECH_EMBED_MODEL || 'bge-m3';
const BATCH = 32;

function parseArgs() {
  const a = process.argv.slice(2);
  const args = { sites: null, limit: 0, dryRun: false, force: false };
  for (const s of a) {
    if (s === '--dry-run') args.dryRun = true;
    else if (s === '--force') args.force = true;
    else if (s.startsWith('--limit=')) args.limit = parseInt(s.slice(8), 10);
    else if (s.startsWith('--sites=')) args.sites = s.slice(8).split(',').map(x => x.trim()).filter(Boolean);
  }
  return args;
}

function listSites() {
  const out = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (!fs.statSync(path.join(ROOT, d)).isDirectory()) continue;
    const p = path.join(ROOT, d, 'website', 'api', 'entities.json');
    if (fs.existsSync(p)) out.push(d);
  }
  return out.sort();
}

function loadEntities(site) {
  const p = path.join(ROOT, site, 'website', 'api', 'entities.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.entities || []);
  for (const e of list) if (!e._site) e._site = site;
  return list;
}

// 与 SearchIndex._embed 一致：name, tags, abstract（含作者/来源可加，但保持一致优先）
// 截断到 2000 字符（BGE-M3 上下文 8192 tokens ≈ 30K+ 字符，2000 已足够且一致）
const MAX_TEXT = 2000;
function buildText(e) {
  const name = e.name || e.title || '';
  const tags = Array.isArray(e.tags) ? e.tags.join(' ') : '';
  const abstract = e.abstract || '';
  const text = `${name}. ${tags}. ${abstract}`.trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function entityId(e) {
  return e.id || `${e._site}:${e.name || e.title}`;
}

async function batchEmbed(texts) {
  const url = `${OLLAMA_BASE}/api/embed`;
  const payload = JSON.stringify({ model: MODEL, input: texts, stream: false });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  if (!j.embeddings || j.embeddings.length !== texts.length) {
    throw new Error(`embed response mismatch: got ${j.embeddings?.length || 0}, want ${texts.length}`);
  }
  return j.embeddings;
}

async function genSite(site, opts) {
  const cachePath = path.join(CACHE_DIR, `embed-cache-${site}.json`);
  const entities = loadEntities(site);

  // 幂等：载入已有 cache
  const cache = new Map();
  if (!opts.force && fs.existsSync(cachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [id, v] of Object.entries(raw)) cache.set(id, v);
    } catch (e) {
      console.error(`  [warn] cache 损坏，重置: ${e.message}`);
    }
  }

  // 只嵌入有 title+abstract 的实体（tags 可为空，但至少要有 name）
  const toEmbed = [];
  for (const e of entities) {
    const id = entityId(e);
    if (cache.has(id)) continue;
    const text = buildText(e);
    // 至少要有 name + 有 abstract 或有 tags 之一，且总长度 >30
    if (!text || text.length < 30) continue;
    toEmbed.push({ id, text });
  }

  if (opts.limit > 0 && toEmbed.length > opts.limit) {
    toEmbed.length = opts.limit;
  }

  console.log(`[${site}] total=${entities.length} cached=${cache.size} to-embed=${toEmbed.length}`);

  if (toEmbed.length === 0) return { cached: cache.size, embedded: 0, skipped: entities.length - cache.size };

  // 分批（BATCH=32）
  const embedded = [];
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const slice = toEmbed.slice(i, i + BATCH);
    const texts = slice.map(s => s.text);
    try {
      const vecs = await batchEmbed(texts);
      for (let k = 0; k < slice.length; k++) {
        cache.set(slice[k].id, vecs[k]);
        embedded.push(slice[k].id);
      }
    } catch (e) {
      console.error(`  [batch ${i/BATCH}] 失败: ${e.message}`);
      // 跳过整批，继续下一批
    }
    done += slice.length;
    if (done % (BATCH * 10) === 0 || done === toEmbed.length) {
      const pct = (done / toEmbed.length * 100).toFixed(0);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
      const eta = toEmbed.length > done ? ((toEmbed.length - done) / (done / ((Date.now() - t0) / 1000)) / 60).toFixed(1) : '0';
      console.log(`  [${site}] ${done}/${toEmbed.length} (${pct}%) ${elapsed}s elapsed ${rate}/s ETA=${eta}min`);
    }
  }

  if (!opts.dryRun) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
  }

  const dim = cache.size ? cache.values().next().value.length : 0;
  return { cached: cache.size, embedded: embedded.length, dim };
}

// --- Main ---
const args = parseArgs();
const allSites = listSites();
const targetSites = args.sites || allSites;

console.log(`Model: ${MODEL}`);
console.log(`Embed endpoint: ${OLLAMA_BASE}/api/embed`);
console.log(`Batch size: ${BATCH}`);
console.log(`Sites: ${targetSites.length}/${allSites.length} ${args.sites ? '(filtered)' : '(all)'}`);
if (args.limit) console.log(`Per-site limit: ${args.limit}`);
if (args.dryRun) console.log('** DRY RUN — 不落盘 **');

const t0 = Date.now();
let totalCached = 0, totalEmbedded = 0;
for (const site of targetSites) {
  const r = await genSite(site, args);
  totalCached += r.cached;
  totalEmbedded += r.embedded;
  if (r.dim) console.log(`  dim=${r.dim}`);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== Summary ===`);
console.log(`Sites processed: ${targetSites.length}`);
console.log(`Total cache entries (in-memory union): ${totalCached}`);
console.log(`Newly embedded: ${totalEmbedded}`);
console.log(`Elapsed: ${elapsed}s`);
if (totalEmbedded) console.log(`Throughput: ${(totalEmbedded / (elapsed || 1)).toFixed(1)} ent/s`);
