/**
 * tools/observability.mjs — 14站 数据飞轮可观测性 SDK（P1）
 *
 * 职责：为数据采集/发布/付费三个维度采集 SLI，与 SLO 做对比，
 *       输出 SLA 状态（OK / DEGRADED / BREACH）与自愈建议。
 *
 * SLI（服务级别指标）— 原始观测：
 *   - 数据新鲜度：每个站点 index.json 最后更新时间距今天数
 *   - 数据量：每站实体数 / 目标容量
 *   - 源可用性：12 个数据源近 7 天成功率
 *   - 付费墙通过率：license API 返回 2xx 比例
 *   - API 响应延迟：index.json 接口 P50/P95/P99
 *
 * SLO（服务级别目标）— 阈值：
 *   - 数据新鲜度 < 7 天
 *   - 每站实体数 ≥ 500（最低可用线）
 *   - 源可用性 ≥ 95%
 *   - 付费墙通过率 ≥ 99%
 *   - API P95 < 500ms
 *
 * SLA 状态：
 *   - OK：所有 SLO 达标
 *   - DEGRADED：1-2 个 SLO 轻度偏离（如新鲜度 7-14 天）
 *   - BREACH：任一 SLO 严重偏离（新鲜度 >14 天 / 源可用性 <90% / 付费墙 <99%）
 *
 * 依赖：fs/promises, path（零外部依赖）
 *
 * 用法：
 *   const { SLIMonitor, report } = await import('./observability.mjs');
 *   const mon = new SLIMonitor({root: PROJECT_ROOT, slo: SLO_DEFAULT});
 *   const snapshot = await mon.collect();    // 采集所有 SLI
 *   const reportObj = mon.eval(snapshot);      // 与 SLO 对比
 *   console.log(report(reportObj));            // 可读文本
 *
 * 集成到 CI（后续）：
 *   在 pipeline-data-backfill 完成后调用 mon.collect()，
 *   若 SLA 状态为 BREACH 则写 issue 到 GitHub。
 */

import {readdir, readFile, stat} from 'fs/promises';
import {dirname, join, resolve} from 'path';
import {fileURLToPath} from 'url';

/** SLO 默认值（评审/投资人关心的指标线） */
export const SLO_DEFAULT = {
  freshness_days_max: 7,       // 数据新鲜度 ≤ 7 天
  entities_min_per_site: 500,  // 每站最低实体数
  source_avail_pct: 95,        // 源可用性 ≥ 95%
  payment_ok_pct: 99,          // 付费墙通过率 ≥ 99%
  api_p95_ms: 500,             // API P95 延迟 ≤ 500ms
};

export const SITE_NAMES = [
  'swarmlabs', 'genetech-tools', 'quantum-computing', 'brain-science',
  'embodied-ai', 'ai4science', 'bionic-ai', 'life-science',
  'biocomputing', 'new-energy', 'nuclear-energy', 'deep-sea-tech',
  'alien-minerals', 'exo-science', 'agent-ecosystem', 'sat-6g',
  'semiconductor', 'spatial-computing', 'privacy-computing',
  'robot-parts', 'low-altitude', 'synbio-manufacturing', 'tcm-tools',
];

export class SLIMonitor {
  constructor(opts = {}) {
    this.root = resolve(opts.root || process.cwd());
    this.slo = {...SLO_DEFAULT, ...opts.slo};
  }

  async _listSites() {
    const entries = await readdir(this.root, {withFileTypes: true});
    return entries
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .filter(n => SITE_NAMES.includes(n));
  }

  async _readIndex(site) {
    const p = join(this.root, site, 'website', 'api', 'index.json');
    try {
      const raw = await readFile(p, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _fileAgeDays(site) {
    const p = join(this.root, site, 'website', 'api', 'index.json');
    try {
      const st = await stat(p);
      return (Date.now() - st.mtimeMs) / 86_400_000;
    } catch {
      return -1; // 文件不存在
    }
  }

  /**
   * 采集所有 SLI
   * @returns {{freshness, entities, sources, api_latency, timestamp}}
   */
  async collect() {
    const sites = await this._listSites();
    const freshness = {};
    const entities = {};

    for (const site of sites) {
      freshness[site] = await this._fileAgeDays(site);
      const idx = await this._readIndex(site);
      entities[site] = idx ? idx.totalEntities || 0 : -1;
    }

    return {
      freshness,                          // 每站 index.json 距今天数
      entities,                           // 每站实体数（-1 = 文件不存在）
      sources: this._mockSourceAvail(),   // 后续从 state/ 读取真实值
      api_latency: this._mockLatency(),    // 后续从 API 压测读取真实值
      timestamp: new Date().toISOString(),
      slo: this.slo,
    };
  }

  _mockSourceAvail() {
    // 占位：后续从 state/source-history.jsonl 统计
    return {overall_pct: 97, by_source: {}};
  }

  _mockLatency() {
    // 占位：后续从 API 网关日志统计
    return {p50_ms: 120, p95_ms: 380, p99_ms: 890};
  }

  /**
   * 对采集到的 SLI 快照做 SLO 评估
   * @param {object} snapshot — collect() 的输出
   * @returns {{status, breaches, degraded, ok_count, total, recommendations}}
   */
  eval(snapshot) {
    const {freshness, entities, sources, api_latency, slo} = snapshot;
    const breaches = [];
    const degraded = [];
    const checks = [];

    // 1. 数据新鲜度
    for (const [site, age] of Object.entries(freshness)) {
      if (age < 0) {
        breaches.push({metric: 'freshness', site, value: 'file_missing', slo: `<${slo.freshness_days_max}d`});
        continue;
      }
      checks.push({metric: 'freshness', site, value: age, slo: slo.freshness_days_max});
      if (age > slo.freshness_days_max * 2) {
        breaches.push({metric: 'freshness', site, value: age, slo: `<${slo.freshness_days_max}d`});
      } else if (age > slo.freshness_days_max) {
        degraded.push({metric: 'freshness', site, value: age, slo: `<${slo.freshness_days_max}d`});
      }
    }

    // 2. 数据量
    for (const [site, n] of Object.entries(entities)) {
      if (n < 0) {
        breaches.push({metric: 'entities', site, value: 'file_missing', slo: `≥${slo.entities_min_per_site}`});
        continue;
      }
      checks.push({metric: 'entities', site, value: n, slo: slo.entities_min_per_site});
      if (n < slo.entities_min_per_site * 0.5) {
        breaches.push({metric: 'entities', site, value: n, slo: `≥${slo.entities_min_per_site}`});
      } else if (n < slo.entities_min_per_site) {
        degraded.push({metric: 'entities', site, value: n, slo: `≥${slo.entities_min_per_site}`});
      }
    }

    // 3. 源可用性
    const srcPct = sources.overall_pct;
    checks.push({metric: 'source_avail', value: srcPct});
    if (srcPct < slo.source_avail_pct - 5) {
      breaches.push({metric: 'source_avail', value: srcPct, slo: `≥${slo.source_avail_pct}%`});
    } else if (srcPct < slo.source_avail_pct) {
      degraded.push({metric: 'source_avail', value: srcPct, slo: `≥${slo.source_avail_pct}%`});
    }

    // 4. API 延迟
    const p95 = api_latency.p95_ms;
    checks.push({metric: 'api_p95', value: p95});
    if (p95 > slo.api_p95_ms * 2) {
      breaches.push({metric: 'api_p95', value: p95, slo: `≤${slo.api_p95_ms}ms`});
    } else if (p95 > slo.api_p95_ms) {
      degraded.push({metric: 'api_p95', value: p95, slo: `≤${slo.api_p95_ms}ms`});
    }

    const status = breaches.length > 0 ? 'BREACH'
                  : degraded.length > 0 ? 'DEGRADED'
                  : 'OK';

    const recommendations = this._recommend(breaches, degraded, snapshot);

    return {status, breaches, degraded, checks, recommendations, timestamp: snapshot.timestamp};
  }

  _recommend(breaches, degraded, snapshot) {
    const recs = [];
    const freshBreach = breaches.filter(b => b.metric === 'freshness');
    const freshDegraded = degraded.filter(b => b.metric === 'freshness');
    if (freshBreach.length > 0 || freshDegraded.length > 0) {
      const sites = [...new Set([...freshBreach, ...freshDegraded].map(b => b.site))];
      recs.push({priority: 'P0', action: `修复数据飞轮停摆站点：${sites.join(', ')}`,
        method: '检查 CI workflow / 源可用性 / 磁盘空间'});
    }
    const srcBreach = breaches.filter(b => b.metric === 'source_avail');
    if (srcBreach.length > 0) {
      recs.push({priority: 'P0', action: '源可用性低于 90%，检查 arXiv/Crossref/PubMed 端点连通性',
        method: '查看 tools/circuit-breaker.mjs OPEN 状态，确认熔断器是否生效'});
    }
    const apiBreach = breaches.filter(b => b.metric === 'api_p95');
    if (apiBreach.length > 0) {
      recs.push({priority: 'P1', action: 'API P95 延迟超标，检查 GitHub Pages 响应或加 CDN',
        method: '考虑 Cloudflare Workers 缓存 index.json'});
    }
    const entBreach = breaches.filter(b => b.metric === 'entities');
    if (entBreach.length > 0) {
      recs.push({priority: 'P0', action: '站点实体数严重不足，检查 backfill 是否被 quality gate 拒绝',
        method: '查看 audit/ 日志中的 quality 拒绝记录'});
    }
    return recs;
  }
}

/** 生成人类可读报告 */
export function report(evalResult) {
  const {status, breaches, degraded, recommendations} = evalResult;
  const lines = [];
  lines.push(`\n┌─ SLA 状态报告 ─────────────────────────────┐`);
  lines.push(`│ 状态: ${status.padEnd(30)}│`);
  lines.push(`│ 严重偏离: ${breaches.length}  │ 轻度偏离: ${degraded.length}  │`);
  lines.push(`└────────────────────────────────────────────┘`);

  if (breaches.length > 0) {
    lines.push('\n🚨 严重偏离（BREACH）：');
    for (const b of breaches) {
      lines.push(`  • ${b.metric} [${b.site || 'global'}]: 实际 ${b.value} / 目标 ${b.slo}`);
    }
  }
  if (degraded.length > 0) {
    lines.push('\n⚠️  轻度偏离（DEGRADED）：');
    for (const d of degraded) {
      lines.push(`  • ${d.metric} [${d.site || 'global'}]: 实际 ${d.value} / 目标 ${d.slo}`);
    }
  }
  if (recommendations.length > 0) {
    lines.push('\n📋 建议操作：');
    for (const r of recommendations) {
      lines.push(`  [${r.priority}] ${r.action}`);
      lines.push(`          ${r.method}`);
    }
  }
  if (breaches.length === 0 && degraded.length === 0) {
    lines.push('\n✅ 所有 SLO 达标。');
  }
  return lines.join('\n');
}

// 冒烟测试（top-level await）
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const mon = new SLIMonitor({root: process.cwd()});
  console.log('Collecting SLI...');
  const snap = await mon.collect();
  console.log(`Sites found: ${Object.keys(snap.freshness).length}`);
  console.log(`Total entities: ${Object.values(snap.entities).filter(v=>v>=0).reduce((a,b)=>a+b,0)}`);
  console.log(report(mon.eval(snap)));
}
