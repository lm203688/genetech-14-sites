#!/usr/bin/env node
/**
 * pipeline-crossref-fill.js
 * 
 * 用 Crossref API 按标题搜索无 DOI 实体的 DOI，批量并发填充。
 * Crossref 免费、无需 key、限流 10 req/s。
 * 
 * 用法：
 *   node operations-plan/pipeline-crossref-fill.js [--dry-run] [--concurrency=8] [--max-fill=0]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const getArg = (k, d) => {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
  return a ? a.slice(`--${k}=`.length) : d;
};
const CONCURRENCY = parseInt(getArg('concurrency', '8'), 10);
const MAX_FILL = parseInt(getArg('max-fill', '0'), 10);
const SIM_THRESHOLD = parseFloat(getArg('threshold', '0.55'));

const CROSSREF_API = 'https://api.crossref.org/works';
const UA = 'GeneTech/1.0 (mailto:research@genetech.tools)';

function httpGet(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: null }); });
    req.end();
  });
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleSim(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  const sa = new Set(na.split(' '));
  const sb = new Set(nb.split(' '));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

async function searchCrossref(title) {
  const enc = encodeURIComponent(title.slice(0, 150));
  const url = `${CROSSREF_API}?query.bibliographic=${enc}&rows=3&select=DOI,title`;
  const res = await httpGet(url);
  if (res.status !== 200 || !res.data?.message) return [];
  return (res.data.message.items || []).map((it) => ({
    doi: it.DOI || '',
    title: Array.isArray(it.title) ? it.title[0] : (it.title || ''),
  }));
}

async function matchOne(entity) {
  const title = entity.name || entity.title || '';
  if (!title || title.length < 10) return null;
  const candidates = await searchCrossref(title);
  if (!candidates.length) return null;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (!c.doi) continue;
    const sim = titleSim(title, c.title);
    if (sim > bestScore) { bestScore = sim; best = c; }
  }
  return best && bestScore >= SIM_THRESHOLD ? { doi: best.doi, score: bestScore } : null;
}

async function processBatch(items, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await matchOne(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function listSiteDirs() {
  return fs.readdirSync(ROOT).filter((d) => {
    try {
      return fs.statSync(path.join(ROOT, d)).isDirectory() &&
        fs.existsSync(path.join(ROOT, d, 'website/api/entities.json'));
    } catch { return false; }
  });
}

function readEntities(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(j) ? j : (j.entities || []);
}

function writeEntities(file, arr) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(j)) fs.writeFileSync(file, JSON.stringify(arr), 'utf-8');
  else { j.entities = arr; fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf-8'); }
}

async function main() {
  const siteDirs = listSiteDirs();
  console.log(`[${siteDirs.length} 站] Crossref 并发填充 DOI`);
  console.log(`模式: ${DRY ? 'DRY' : 'WRITE'} | 并发: ${CONCURRENCY} | 阈值: ${SIM_THRESHOLD}`);

  let totalNoDoi = 0, totalFilled = 0, totalFailed = 0;
  const report = { generatedAt: new Date().toISOString(), mode: DRY ? 'DRY' : 'WRITE', perSite: {} };

  for (const site of siteDirs) {
    const file = path.join(ROOT, site, 'website/api/entities.json');
    const arr = readEntities(file);
    const noDoi = [];
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i].doi || !String(arr[i].doi).trim()) noDoi.push(i);
    }
    if (!noDoi.length) { report.perSite[site] = { noDoi: 0, filled: 0 }; continue; }
    totalNoDoi += noDoi.length;

    console.log(`\n${site}: ${noDoi.length} 无 DOI`);
    let filled = 0;
    const entities = noDoi.map((i) => arr[i]);
    const matches = await processBatch(entities, CONCURRENCY);

    if (!DRY) {
      for (let i = 0; i < matches.length; i++) {
        if (matches[i]) {
          arr[noDoi[i]].doi = matches[i].doi;
          arr[noDoi[i]].source = 'crossref';
          arr[noDoi[i]].updatedAt = new Date().toISOString();
          filled++;
          totalFilled++;
        } else {
          totalFailed++;
        }
      }
      writeEntities(file, arr);
    } else {
      filled = matches.filter(Boolean).length;
      totalFilled += filled;
      totalFailed += noDoi.length - filled;
    }

    report.perSite[site] = { noDoi: noDoi.length, filled };
    console.log(`  填充: ${filled}/${noDoi.length} (${(filled/noDoi.length*100).toFixed(1)}%)`);

    if (MAX_FILL && totalFilled >= MAX_FILL) {
      console.log(`  [cap] 已达 MAX_FILL=${MAX_FILL}`);
      break;
    }
  }

  const rate = totalNoDoi ? (totalFilled / totalNoDoi * 100).toFixed(1) : 0;
  console.log(`\n=== 汇总: ${totalFilled}/${totalNoDoi} (${rate}%) ===`);
  report.totalNoDoi = totalNoDoi;
  report.totalFilled = totalFilled;
  report.fillRate = totalNoDoi ? totalFilled / totalNoDoi : 0;
  fs.writeFileSync(path.join(ROOT, 'data', 'crossref-fill.json'), JSON.stringify(report, null, 2), 'utf-8');
}

main().catch((e) => { console.error(e); process.exit(1); });
