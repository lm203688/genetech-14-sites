#!/usr/bin/env node
/**
 * pipeline-intel-state-dump.mjs
 * 
 * Sprint 2 准备：从 Worker 导出 memory 状态到 data/intel_state.json
 * 用途：GitHub Actions 定时跑此脚本，把 Worker 的 demand/consumer 记录持久化到 repo
 *      下次 Worker 重启时可以从 intel_state.json 恢复（需在 Worker 侧加加载逻辑）
 * 
 * 用法：
 *   node operations-plan/pipeline-intel-state-dump.mjs
 *   ADMIN_KEY=xxx node operations-plan/pipeline-intel-state-dump.mjs
 * 
 * 输出：data/intel_state.json（结构化状态文件）
 * 
 * 状态：Sprint 2 准备（Worker 侧加载逻辑待加）
 */

import fs from 'fs';
import path from 'path';

const BASE = 'https://api.swarmlabs.tools';
const ADMIN_KEY = process.env.INTEL_ADMIN_KEY || 'gtk-intel-admin-3f7b9e2a1c4d8f5e';
const OUT_DIR = path.join(process.cwd(), 'data');
const OUT_FILE = path.join(OUT_DIR, 'intel_state.json');

async function main() {
  console.log('[intel-state] Fetching admin state from Worker...');
  
  const r = await fetch(`${BASE}/v1/intel/admin/state`, {
    headers: { 'Authorization': `Bearer ${ADMIN_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  
  if (!r.ok) {
    console.error(`[intel-state] Worker returned HTTP ${r.status}`);
    console.error(`  body: ${(await r.text()).slice(0, 500)}`);
    process.exit(1);
  }
  
  const state = await r.json();
  
  // 组装状态文件
  const out = {
    _meta: {
      pipeline: 'intel-state-dump',
      generated_at: new Date().toISOString(),
      source: `${BASE}/v1/intel/admin/state`,
      sprint: '2-prep',
      note: 'Worker memory 状态快照。Sprint 2 会在 Worker 启动时加载此文件恢复状态。',
    },
    ...state,
  };
  
  // 写入文件
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf-8');
  
  console.log(`[intel-state] Written to ${OUT_FILE}`);
  console.log(`  demands: ${out.counts?.demands || 0}`);
  console.log(`  consumers: ${out.counts?.consumers || 0}`);
  console.log(`  storage: ${out._storage}`);
  console.log(`  size: ${fs.statSync(OUT_FILE).size} bytes`);
  
  // 输出统计到 stdout（供 workflow 日志查看）
  console.log('\n[intel-state] Summary:');
  console.log(`  Demands by consumer:`);
  const byConsumer = {};
  for (const d of out.demands || []) {
    byConsumer[d.consumer] = (byConsumer[d.consumer] || 0) + 1;
  }
  for (const [c, n] of Object.entries(byConsumer)) {
    console.log(`    ${c}: ${n} demand(s)`);
  }
  console.log(`  Consumers:`);
  for (const c of out.consumers || []) {
    console.log(`    ${c.cid} (${c.project_name}, ${c.tier})`);
  }
}

main().catch(e => {
  console.error('[intel-state] FATAL:', e);
  process.exit(1);
});
