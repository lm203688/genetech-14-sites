/**
 * tools/audit-logger.mjs — opt-in 审计日志工具
 *
 * 用法（不接入 CI，pipeline 显式 require 即可）：
 *   import {AuditLogger} from './tools/audit-logger.mjs';
 *   const log = new AuditLogger({actor: 'collector_agent'});
 *   log.emit({stage:'fetch', action:'source_request', status:'ok'});
 *   await log.flush();
 *
 * 输出：audit/YYYY-MM-DD.jsonl（每行一条 JSON）
 * 文档：docs/competition-2026/AUDIT-LOG.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VALID_STATUS = new Set(['ok', 'warn', 'error', 'skip']);
const VALID_STAGE = new Set(['fetch', 'parse', 'normalize', 'validate', 'enrich', 'bridge', 'publish', 'audit']);

export class AuditLogger {
  constructor({actor = 'unknown', runId = null, outDir = path.join(ROOT, 'audit')}) {
    this.actor = actor;
    this.runId = runId || `run_${Date.now()}`;
    this.outDir = outDir;
    this._buffer = [];
    fs.mkdirSync(this.outDir, {recursive: true});
  }

  get filePath() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    return path.join(this.outDir, `${day}.jsonl`);
  }

  emit({stage, action, status, site, input, output, error, guards, provenance, latency_ms}) {
    const rec = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      actor: this.actor,
      stage: stage || 'unknown',
      action: action || 'unknown',
      site: site || null,
      status: VALID_STATUS.has(status) ? status : 'ok',
      latency_ms: latency_ms ?? null,
      input: input || null,
      output: output || null,
      error: status === 'error' ? (error || 'unknown error') : null,
      guards: guards || [],
      provenance: provenance || null,
    };

    if (VALID_STAGE.has(rec.stage) === false && rec.stage !== 'unknown') {
      // 不报错，允许扩展
      void 0;
    }

    this._buffer.push(JSON.stringify(rec));
    if (this._buffer.length >= 50) this._flushSync();
  }

  _flushSync() {
    if (this._buffer.length === 0) return;
    fs.appendFileSync(this.filePath, this._buffer.join('\n') + '\n');
    this._buffer = [];
  }

  async flush() {
    if (this._buffer.length === 0) return;
    return new Promise((resolve, reject) => {
      try {
        fs.appendFileSync(this.filePath, this._buffer.join('\n') + '\n');
        this._buffer = [];
        resolve();
      } catch (e) { reject(e); }
    });
  }

  dailySummary() {
    const file = this.filePath;
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const byStatus = {}, byAgent = {}, byStage = {}, topErrors = {};
    for (const e of events) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      byAgent[e.actor] = (byAgent[e.actor] || 0) + 1;
      byStage[e.stage] = (byStage[e.stage] || 0) + 1;
      if (e.status === 'error') {
        const k = `${e.actor} / ${e.error || 'unknown'}`;
        topErrors[k] = (topErrors[k] || 0) + 1;
      }
    }

    return {
      date: new Date().toISOString().slice(0, 10),
      total_events: events.length,
      by_status: byStatus,
      by_agent: byAgent,
      by_stage: byStage,
      top_errors: Object.entries(topErrors)
        .map(([msg, count]) => ({msg, count}))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    };
  }
}

// 方便 script 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = new AuditLogger({actor: 'cli_test'});
  log.emit({stage:'fetch', action:'test', status:'ok', site:'swarmlabs'});
  log.emit({stage:'publish', action:'write', status:'error', error:'EACCES'});
  log.emit({stage:'validate', action:'check', status:'warn'});
  log.flush().then(() => {
    console.log(`[audit-logger] wrote ${log.filePath}`);
    console.log(`[audit-logger] summary: ${JSON.stringify(log.dailySummary(), null, 2)}`);
  });
}
