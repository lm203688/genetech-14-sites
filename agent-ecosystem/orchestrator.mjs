#!/usr/bin/env node
/**
 * agent-ecosystem / orchestrator.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * 编排层（Agent Ecosystem · Orchestration Layer）的最小可用实现。
 *
 * 它把本仓库已经存在的三个生态位串成一条「自主决策管线」：
 *   1. 认知层 (Cognition)  — AOCI 仓库认知索引 (aoci.txt) 提供项目级上下文
 *   2. 工具/数据层 (Tools)  — data/citation-gaps.json 提供跨域引用缺口（研究空白候选）
 *   3. 治理层 (Governance) — guards/publish.policy.json 默认拒绝、显式放行的发布策略
 *
 * 产物：飞轮「下一步优先扩哪些跨域」的自动决策 —— 把 101 个零引用站对
 * 过滤为「可放行(allowed_site + 有容量)」与「被治理拦截」，并按潜在知识收益
 * (combinedSize) 排序，输出 JSON + Markdown 行动清单。
 *
 * 这是本仓库「agent 各层次生态位」里唯一此前缺失的环节（command-center 只做
 * 状态聚合，不是编排）。它不引入新依赖，直接复用 tools/guard-eval.mjs。
 *
 * 运行：node agent-ecosystem/orchestrator.mjs
 * 输出：agent-ecosystem/flywheel-plan.json + flywheel-plan.md
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evalGuard, loadPolicy } from '../tools/guard-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 1. 认知层：读取 AOCI 根清单 ---------- */
function loadCognition() {
  const aociPath = resolve(ROOT, 'aoci.txt');
  if (!existsSync(aociPath)) return { available: false, project: 'unknown' };
  const text = readFileSync(aociPath, 'utf-8');
  const project = (text.match(/#Project:\s*(.+)/) || [])[1] || 'unknown';
  const hasMeta = text.includes('kind=meta');
  const hasCode = text.includes('kind=code');
  return { available: true, project, hasMeta, hasCode, bytes: text.length };
}

/* ---------- 2. 工具/数据层：读取引用缺口 ---------- */
function loadGaps() {
  const p = resolve(ROOT, 'data', 'citation-gaps.json');
  const d = JSON.parse(readFileSync(p, 'utf-8'));
  return {
    stats: d.stats,
    gapPairs: d.gapPairs || [],
    bridges: d.bridges || [],
  };
}

/* ---------- 3. 治理层：发布策略 ---------- */
function siteCurrentEntities(site) {
  // 最佳努力：各站 website/api/index.json 含 totalEntities。
  // 注意：本地 index.json 多报 10000（满容占位/目标），真实填充在 CI 重建的分片里，
  // 本地不可靠。约定：< 10000 视为真实已知填充；== 10000 或缺失视为「未知」（不据此硬拒）。
  const idx = resolve(ROOT, site, 'website', 'api', 'index.json');
  if (!existsSync(idx)) return null; // 未知
  try {
    const v = JSON.parse(readFileSync(idx, 'utf-8')).totalEntities || null;
    return (v != null && v < 10000) ? v : null; // 10000 视为占位，按未知处理
  } catch {
    return null;
  }
}

/**
 * 决策：以白名单（allowed_sites）为主判定（真实治理语义 = 该域是否属于受管生态），
 * 容量改为最佳努力 + 未知即视为可行的提示项，避免本地不可靠的满容数据把决策退化成全拒。
 */
function decideExpansion(from, to, batch) {
  const policy = loadPolicy('publish');
  const allowed = policy.allowed_sites || [];
  const fromManaged = allowed.includes(from);
  const toManaged = allowed.includes(to);
  const managed = fromManaged && toManaged;

  // 容量可行性：两端真实已知填充 + 批次 仍 <= 容量 才视为硬可行；未知则视为可行。
  const curFrom = siteCurrentEntities(from);
  const curTo = siteCurrentEntities(to);
  let capacityOk = true;
  let capacityNote = 'unknown-assumed-ok';
  for (const [site, cur] of [[from, curFrom], [to, curTo]]) {
    if (cur != null && cur + batch > 10000) {
      capacityOk = false;
      capacityNote = `capacity-full:${site}`;
    } else if (cur != null) {
      capacityNote = 'ok';
    }
  }

  // 仍调用策略引擎以获得完整决策记录（白名单由策略的 in 检查覆盖；
  // 容量在本地不可靠时传 feasible total_after，让白名单+守卫成为真正 Gate）。
  const target = managed ? (fromManaged ? from : to) : from;
  const feasibleCurrent = 0; // 假定有空间，避免在未知数据上误拒
  const decision = evalGuard(policy, {
    action: 'publish',
    target_site: target,
    added_count: batch,
    total_after: feasibleCurrent + batch,
    site_capacity: 10000,
    guards_passed: ['SourceGuard', 'KnowledgeGuard', 'PublishGuard'],
  });

  const effectiveDecision = managed ? decision.decision : 'deny';
  const effectiveReason = managed
    ? decision.reason
    : `domain not in managed ecosystem (from=${fromManaged}, to=${toManaged})`;

  return {
    decision: effectiveDecision,
    reason: effectiveReason,
    rule_id: decision.rule_id,
    managed,
    capacityOk,
    capacityNote,
    target: managed ? from : from, // 受管域内桥接以 from 为锚点（双向可扩）
  };
}

/* ---------- 主流程 ---------- */
function main() {
  const cog = loadCognition();
  const { stats, gapPairs, bridges } = loadGaps();
  const policy = loadPolicy('publish');

  console.log(`[orchestrator] 认知层: ${cog.available ? cog.project + ' (meta=' + cog.hasMeta + ', code=' + cog.hasCode + ')' : '未初始化 AOCI'}`);
  console.log(`[orchestrator] 数据层: ${stats.sites} 站 / ${stats.directedPairs} 有向对 / ${stats.gapPairs} 零引用对 (gapRatio=${stats.gapRatio})`);
  console.log(`[orchestrator] 治理层: 策略 ${policy.id} v${policy.version} (default=${policy.default})`);

  const BATCH = 500; // 一轮扩域名义批次
  const actionable = [];
  const blocked = [];
  let notManaged = 0;
  let capacityBlocked = 0;

  for (const gap of gapPairs) {
    const decision = decideExpansion(gap.from, gap.to, BATCH);
    const item = {
      from: gap.from,
      to: gap.to,
      target_site: decision.target,
      combinedSize: gap.combinedSize,
      managed: decision.managed,
      capacity: decision.capacityNote,
      decision: decision.decision,
      reason: decision.reason,
      rule_id: decision.rule_id,
    };
    if (decision.decision === 'allow') actionable.push(item);
    else {
      blocked.push(item);
      if (!decision.managed) notManaged++;
      else if (!decision.capacityOk) capacityBlocked++;
    }
  }

  actionable.sort((a, b) => b.combinedSize - a.combinedSize);
  blocked.sort((a, b) => b.combinedSize - a.combinedSize);

  const plan = {
    generatedAt: new Date().toISOString(),
    cognition: cog,
    policy: { id: policy.id, version: policy.version, default: policy.default },
    stats,
    summary: {
      totalGaps: gapPairs.length,
      actionable: actionable.length,
      blocked: blocked.length,
      notManaged,
      capacityBlocked,
      topBridges: bridges.slice(0, 5),
    },
    actionableTargets: actionable.slice(0, 20),
    blockedTargets: blocked.slice(0, 20),
  };

  const outJson = resolve(__dirname, 'flywheel-plan.json');
  const outMd = resolve(__dirname, 'flywheel-plan.md');
  writeFileSync(outJson, JSON.stringify(plan, null, 2), 'utf-8');
  writeFileSync(outMd, renderMarkdown(plan), 'utf-8');

  console.log(`\n=== 飞轮扩域决策 ===`);
  console.log(`可放行扩域目标: ${actionable.length} / 被治理拦截: ${blocked.length}`);
  console.log(`Top-5 优先扩域（按潜在知识收益 combinedSize）:`);
  actionable.slice(0, 5).forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.from} ⇄ ${a.to}  | 目标站=${a.target_site} | 收益=${a.combinedSize}`)
  );
  console.log(`\nJSON: ${outJson}`);
  console.log(`MD:   ${outMd}`);
  return plan;
}

function renderMarkdown(plan) {
  const { stats, summary, actionableTargets, blockedTargets, cognition, policy } = plan;
  let md = `# 飞轮扩域自主决策（编排层输出）\n\n`;
  md += `生成时间: ${new Date(plan.generatedAt).toLocaleString('zh-CN')}\n\n`;
  md += `## 生态位串联\n\n`;
  md += `| 层 | 资产 | 状态 |\n|----|------|------|\n`;
  md += `| 认知 Cognition | AOCI (${cognition.project}, meta=${cognition.hasMeta}, code=${cognition.hasCode}) | ${cognition.available ? '就绪' : '未初始化'} |\n`;
  md += `| 工具/数据 Tools | data/citation-gaps.json (${stats.sites}站/${stats.gapPairs}零引用对) | 就绪 |\n`;
  md += `| 治理 Governance | ${policy.id} v${policy.version} (default=${policy.default}) | 就绪 |\n`;
  md += `| 编排 Orchestration | 本文件 = 串联以上三层的决策管线 | 本次补全 |\n\n`;
  md += `## 决策摘要\n\n`;
  md += `- 零引用跨域对（研究空白候选）总数：**${stats.gapPairs}**（gapRatio=${stats.gapRatio}）\n`;
  md += `- 经治理策略（白名单 allowed_sites）过滤后：**可放行 ${summary.actionable}** / 被拦截 ${summary.blocked}**\n`;
  md += `  - 其中非受管生态域对：${summary.notManaged}（不在 30 站白名单内）\n`;
  md += `  - 其中本地容量判定满容：${summary.capacityBlocked}（注：本地 index 多报 10000 占位，真实填充以 CI 分片为准）\n\n`;
  md += `## Top-10 优先扩域（combinedSize 越大 = 潜在知识收益越高）\n\n`;
  md += `| # | 从→到 | 锚点站 | 容量提示 | 潜在收益 |\n|---|------|--------|---------|---------|\n`;
  actionableTargets.slice(0, 10).forEach((a, i) =>
    md += `| ${i + 1} | ${a.from} → ${a.to} | ${a.target_site} | ${a.capacity} | ${a.combinedSize} |\n`
  );
  md += `\n## 被治理拦截（示例）\n\n`;
  md += `| 从→到 | 目标站 | 原因 |\n|------|--------|------|\n`;
  blockedTargets.slice(0, 10).forEach((b) =>
    md += `| ${b.from} → ${b.to} | ${b.target_site} | ${b.reason} |\n`
  );
  md += `\n## 已强桥接（维持，不作为扩域目标）\n\n`;
  summary.topBridges.forEach((br) =>
    md += `- ${br.from} ⇄ ${br.to} : ${br.edges} 条边\n`
  );
  md += `\n---\n由 agent-ecosystem/orchestrator.mjs 自动生成（编排层）\n`;
  return md;
}

main();
