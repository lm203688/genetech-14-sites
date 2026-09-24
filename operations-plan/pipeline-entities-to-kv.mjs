#!/usr/bin/env node
// pipeline-entities-to-kv.mjs — 把 _site 各站的 website/api/entities.json 迁移到 Cloudflare KV
//
// 背景：GitHub Pages 上限 ~1014MB，30 站 × entities.json ~458MB 是主要占用。
//       迁到 KV 后 Pages 只留 HTML 壳，Worker 从 KV 读返回给前端。
//
// 目标 KV namespace：GENETECH_ENTITIES（ID: 2ff4966803cc47389dbdf862216bf9ac）
// Key 格式：site:<station>:entities
// Value：entities.json 原始 JSON（text/plain）
//
// 用法：
//   node operations-plan/pipeline-entities-to-kv.mjs                # dry-run
//   node operations-plan/pipeline-entities-to-kv.mjs --apply        # 真上传
//
// 输出：
//   - 控制台逐站报告
//   - state/kv-migration-<ts>.json 快照
//   - state/flow/ledger.jsonl append
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  Dag, Operator, Ledger, RunContext,
  parseArgs,
  PROJECT_ROOT, STATE_DIR, writeJsonAtomic, sha256,
} from './flow.mjs';

const CF_ACCOUNT = '8162aa3b2241c132e43a81f526d7f758';
const KV_NAMESPACE = '2ff4966803cc47389dbdf862216bf9ac'; // GENETECH_ENTITIES
const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${KV_NAMESPACE}/values`;
const SITE_DIR = path.join(PROJECT_ROOT, '_site');

function getCFToken() {
  // 从 probe 目录找 cfut_ 令牌
  const probeDir = path.join(PROJECT_ROOT, '.workbuddy', 'probe');
  if (!fs.existsSync(probeDir)) throw new Error('找不到 .workbuddy/probe 目录');
  for (const f of fs.readdirSync(probeDir)) {
    if (!f.endsWith('.mjs')) continue;
    try {
      const c = fs.readFileSync(path.join(probeDir, f), 'utf8');
      const m = c.match(/cfut_[A-Za-z0-9_-]+/);
      if (m) return m[0];
    } catch { /* ignore */ }
  }
  throw new Error('probe 目录里找不到 cfut_ 令牌');
}

function listStations() {
  try {
    return fs.readdirSync(SITE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => !name.startsWith('.') && name !== 'topic' && name !== 'api' && name !== 'assets' && name !== 'blog');
  } catch (e) {
    throw new Error(`无法列出 ${SITE_DIR}: ${e.message}`);
  }
}

function findEntityFile(stationName) {
  return path.join(SITE_DIR, stationName, 'website', 'api', 'entities.json');
}

async function uploadToKV(token, key, content) {
  const url = `${KV_URL}/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
      'cf-types': 'json',
    },
    body: content,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  return { ok: j.success, id: j.result?.id, error: j.errors?.[0] };
}

// ===== 算子 1：扫描 =====
const scanOp = new Operator({
  name: 'scan',
  describe: '扫描 30 站 entities.json，检查大小是否在 KV 25MB 限内',
  run: (stations, ctx) => {
    const results = stations.map((name) => {
      const f = findEntityFile(name);
      if (!fs.existsSync(f)) return { station: name, exists: false };
      const stat = fs.statSync(f);
      return {
        station: name,
        exists: true,
        size: stat.size,
        sizeMB: (stat.size / 1024 / 1024).toFixed(2),
        overLimit: stat.size > 25 * 1024 * 1024, // 25MB
        sha256: sha256(fs.readFileSync(f)),
      };
    });
    const valid = results.filter((r) => r.exists && !r.overLimit);
    const over = results.filter((r) => r.exists && r.overLimit);
    ctx.log(`扫描完成：${results.length} 站，${valid.length} 个可上传，${over.length} 个超 25MB 限`);
    if (over.length > 0) ctx.warn(`${over.length} 个 entities.json 超过 KV 25MB 限，需压缩或分片`);
    return [{ results, valid, over }];
  },
});

// ===== 算子 2：上传 =====
const uploadOp = new Operator({
  name: 'upload',
  describe: '上传 entities.json 到 KV（key=site:<station>:entities）',
  run: async ([{ results, valid, over }], ctx) => {
    const token = getCFToken();
    const report = {
      ts: new Date().toISOString(),
      dryRun: ctx.dryRun,
      namespace: KV_NAMESPACE,
      namespaceTitle: 'GENETECH_ENTITIES',
      stations: [],
      totals: { uploaded: 0, bytesUploaded: 0, errors: 0, skipped: 0 },
    };
    const ledger = new Ledger();
    for (const r of results) {
      if (!r.exists) { report.stations.push({ ...r, action: 'skipped-no-file' }); report.totals.skipped++; continue; }
      if (r.overLimit) { report.stations.push({ ...r, action: 'skipped-over-limit' }); report.totals.skipped++; continue; }
      const key = `site:${r.station}:entities`;
      if (ctx.dryRun) {
        report.stations.push({ station: r.station, action: 'would-upload', size: r.size, sizeMB: r.sizeMB, key, sha256: r.sha256.slice(0, 16) });
        report.totals.uploaded++;
        report.totals.bytesUploaded += r.size;
        continue;
      }
      try {
        const content = fs.readFileSync(findEntityFile(r.station), 'utf8');
        const resp = await uploadToKV(token, key, content);
        report.stations.push({ station: r.station, action: resp.ok ? 'uploaded' : 'error', size: r.size, sizeMB: r.sizeMB, key, cfId: resp.id, error: resp.error });
        if (resp.ok) {
          report.totals.uploaded++;
          report.totals.bytesUploaded += r.size;
          ledger.record({ op: 'kv-upload', station: r.station, key, size: r.size, cfId: resp.id });
        } else {
          report.totals.errors++;
          ledger.record({ op: 'kv-upload-fail', station: r.station, key, error: resp.error });
        }
      } catch (e) {
        report.stations.push({ station: r.station, action: 'error', error: e.message, key });
        report.totals.errors++;
      }
    }
    ctx.log(`完成：${report.totals.uploaded} 上传，${(report.totals.bytesUploaded / 1024 / 1024).toFixed(1)} MB，${report.totals.errors} 错误`);
    const reportPath = path.join(PROJECT_ROOT, 'state', `kv-migration-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
    writeJsonAtomic(reportPath, report);
    ctx._reportPath = reportPath;
    return [report];
  },
});

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const apply = flags['apply'] === true;
  const dryRun = !apply;
  console.log(`[${dryRun ? 'DRY-RUN' : 'APPLY'}] entities.json → KV (GENETECH_ENTITIES)`);

  const stations = listStations();
  console.log(`站点数：${stations.length}`);

  const dag = new Dag().add(scanOp).add(uploadOp);
  const report = await dag.run(stations, {
    pipelineName: 'entities-to-kv',
    args: { dryRun },
    dryRun,
  });

  const last = report[report.length - 1];
  if (last && last.totals) {
    console.log(`\n===== 摘要 =====`);
    console.log(`模式：${dryRun ? 'DRY-RUN' : 'APPLY'}`);
    console.log(`KV namespace：GENETECH_ENTITIES (${KV_NAMESPACE})`);
    console.log(`上传：${last.totals.uploaded} 文件`);
    console.log(`体积：${(last.totals.bytesUploaded / 1024 / 1024).toFixed(2)} MB`);
    console.log(`跳过：${last.totals.skipped}`);
    console.log(`错误：${last.totals.errors}`);
    console.log(`报告：${path.relative(PROJECT_ROOT, last._reportPath || '')}`);
  }
  process.exitCode = last && last.totals && last.totals.errors > 0 ? 2 : 0;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}
