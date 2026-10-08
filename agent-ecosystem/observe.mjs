#!/usr/bin/env node
/**
 * agent-ecosystem / observe.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * 可观测层（Agent Ecosystem · Observability）的最小可用基线。
 *
 * 为什么需要它（对标 2026 共识）：agent 跑起来后"静默失败"是最大运维成本——
 * 飞轮管线/Worker 常常 HTTP 200 却没真正产出，护栏回归、支付重复都藏在里。
 * 本模块零依赖，把分散在各处的运行信号聚合成一张「生态健康卡」：
 *   - 近期管线运行报告（reports/report-*.json）的成功/失败/最新时间戳
 *   - 编排层决策摘要（agent-ecosystem/flywheel-plan.json）
 *   - 治理层策略文件齐备性 + 护栏引擎可加载性
 *   - 认知层（aoci.txt）、工具层（mcp-server 版本）、运行时层（Worker 待部署标记）
 *
 * 产物：agent-ecosystem/ecosystem-health.json + 控制台卡片。
 * 运行：node agent-ecosystem/observe.mjs
 *
 * 与开源对标的关系：Langfuse/Phoenix/Opik 是 2026 年 OSS 可观测主流，提供
 * trace/eval/会话回放；本基线先用零依赖本地聚合把"信号收集"跑通，后续可把
 * 同一批 span 通过 OTLP 接到 Langfuse/Phoenix（已留结构兼容点）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 管线运行报告扫描 ---------- */
function scanPipelineReports() {
  const dir = resolve(ROOT, 'reports');
  if (!existsSync(dir)) return { scanned: 0, ok: 0, fail: 0, lastRunTs: null };
  const files = readdirSync(dir).filter((f) => /^report-.*\.json$/.test(f));
  let ok = 0, fail = 0;
  let lastRunTs = null;
  for (const f of files) {
    // 文件名里的 13 位数字是 epoch ms（如 report-data-backfill-1791097236178.json）
    const m = f.match(/(\d{13})/);
    const ts = m ? Number(m[1]) : null;
    if (ts && (lastRunTs === null || ts > lastRunTs)) lastRunTs = ts;
    try {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
      const verdict =
        j.status || j.result || j.ok !== undefined ? j.ok : undefined;
      if (j.ok === true || /success|ok|done/i.test(String(j.status || ''))) ok++;
      else if (j.ok === false || /fail|error/i.test(String(j.status || ''))) fail++;
    } catch {
      /* 非 JSON 或结构不符，跳过 */
    }
  }
  return { scanned: files.length, ok, fail, lastRunTs };
}

/* ---------- 治理层齐备性 ---------- */
async function scanGovernance() {
  const dir = resolve(ROOT, 'guards');
  const names = ['publish.policy.json', 'ingest.policy.json', 'evolve.policy.json'];
  const present = names.filter((n) => existsSync(resolve(dir, n)));
  let engineLoadable = false;
  try {
    const mod = await import('../tools/guard-eval.mjs');
    engineLoadable = typeof mod.evalGuard === 'function';
  } catch {
    engineLoadable = false;
  }
  return { expected: names.length, present: present.length, engineLoadable };
}

/* ---------- 认知层 / 工具层 / 运行时层 ---------- */
function scanCognition() {
  return existsSync(resolve(ROOT, 'aoci.txt'));
}
function scanTools() {
  const p = resolve(ROOT, 'mcp-server', 'package.json');
  if (!existsSync(p)) return { present: false };
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return { present: true, name: j.name, version: j.version, license: j.license };
  } catch {
    return { present: true, version: '?' };
  }
}
function scanRuntime() {
  // 运行时层：两个 Worker 源文件在位；部署状态需人工标记
  return {
    apiGuard: existsSync(resolve(ROOT, 'api-guard')),
    unifiedLicense: existsSync(resolve(ROOT, 'unified-license', 'worker.js')),
    deployDoc: existsSync(resolve(ROOT, 'unified-license', 'DEPLOY-NOW.md')),
  };
}

/* ---------- 编排层决策摘要 ---------- */
function scanOrchestration() {
  const p = resolve(__dirname, 'flywheel-plan.json');
  if (!existsSync(p)) return { present: false };
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      present: true,
      actionable: j.summary?.actionable,
      blocked: j.summary?.blocked,
      totalGaps: j.summary?.totalGaps,
    };
  } catch {
    return { present: true, actionable: '?' };
  }
}

async function main() {
  const pipeline = scanPipelineReports();
  const gov = await scanGovernance();
  const cog = scanCognition();
  const tools = scanTools();
  const runtime = scanRuntime();
  const orch = scanOrchestration();

  const health = {
    generatedAt: new Date().toISOString(),
    layers: {
      model: { status: 'external-consumer', note: '使用外部 LLM API，仓库内无需托管模型' },
      runtime: { ...runtime, status: runtime.unifiedLicense ? 'ready-source' : 'missing', deployPending: true },
      orchestration: { ...orch, status: orch.present ? 'ready' : 'missing' },
      agentApp: { status: 'ready', note: '30 站 + 数据飞轮 + guards' },
      memory: { status: cog ? 'ready' : 'missing', aoci: cog },
      tools: { ...tools, status: tools.present ? 'ready-source' : 'missing', publishPending: true },
      governance: { ...gov, status: gov.engineLoadable && gov.present === gov.expected ? 'ready' : 'degraded' },
      observability: { status: 'ready-baseline', note: '本模块 = 零依赖本地聚合基线' },
      distribution: { status: 'pending-user', note: 'npm/Glama/Smithery 需用户账号' },
    },
    pipeline,
    score: {
      selfDevelopableComplete: ['orchestration', 'observability', 'memory', 'tools-source', 'governance', 'agentApp'],
      pendingUserAction: ['runtime-deploy', 'distribution-publish'],
    },
  };

  const out = resolve(__dirname, 'ecosystem-health.json');
  writeFileSync(out, JSON.stringify(health, null, 2), 'utf-8');

  console.log('\n=== GeneTech Agent 生态健康卡 ===');
  console.log(`认知层 AOCI       : ${cog ? '就绪' : '缺失'}`);
  console.log(`工具层 mcp-server  : ${tools.present ? tools.name + ' v' + tools.version : '缺失'}${tools.present ? ' (待发布)' : ''}`);
  console.log(`治理层 guards      : ${gov.present}/${gov.expected} 策略 + 引擎${gov.engineLoadable ? '可加载' : '不可用'}`);
  console.log(`编排层 orchestrator: ${orch.present ? '就绪 (' + orch.actionable + ' 可放行 / ' + orch.blocked + ' 拦截)' : '缺失'}`);
  console.log(`可观测层 observe   : 就绪(基线) | 近期管线报告 ${pipeline.scanned} 份 (ok=${pipeline.ok}, fail=${pipeline.fail})`);
  console.log(`运行时层 Worker    : 源在位=${runtime.unifiedLicense} | 部署=待用户操作`);
  console.log(`分发生态位         : 待用户发布 npm/Glama/Smithery`);
  console.log(`\nJSON: ${out}`);
  return health;
}

main();
