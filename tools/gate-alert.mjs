#!/usr/bin/env node
/**
 * tools/gate-alert.mjs — 门禁失败触达告警（F2）
 * ─────────────────────────────────────────────────────────────────────────
 * 目的
 *   报告 v2 §6 F2「告警必须有触达」。此前 quality-gate / docs-guard / guard-eval
 *   门禁失败只会在 CI 里挂红，但 CI 红本身不会主动推到人眼前；本次补一条 Issue
 *   层面的告警轨，让"最近一次门禁判定"永远能在仓库首页看到。
 *
 * 行为
 *   1. 读最新的 reports/quality-metrics-*.json 与 reports/docs-guard-*.json（若存在）
 *   2. 判断是否有站点被 deny / private_leaks 非零
 *   3. 通过 gh CLI：
 *      - 若已有 open 的 [Gate Alert] Issue → 更新 body 到最新判定
 *      - 若没有 → 新建一条 Issue，label: gate-alert
 *      - 若全部通过 → 若存在 open Issue 则关闭
 *
 * 为什么走 gh CLI 而不是 REST
 *   走 gh 可以直接用 GitHub Actions 里默认的 GITHUB_TOKEN，不用额外配 PAT。
 *   CI 里 gh 会自动读 GH_TOKEN / GITHUB_TOKEN 环境变量。
 *
 * 幂等
 *   用固定 label "gate-alert" 作为锁，最多同时存在 1 条。
 *   多次运行不会创建重复 Issue。
 *
 * 用法
 *   node tools/gate-alert.mjs                        # 读本地 reports/ 建 Issue
 *   node tools/gate-alert.mjs --local                # 只生成 JSON 报告，不发 Issue（本地开发用）
 *   node tools/gate-alert.mjs --dry-run              # 打印将做的动作，不实际调用 gh
 *
 * 退出码：0=无告警或告警已发出 / 1=门禁判定 fail（供 CI 决定是否阻断）
 *        2=配置错误 / 3=gh 调用失败
 *
 * 与 ops-extra.yml 的关系
 *   workflow_dispatch task=gate-alert 会显式跑本脚本；同时 notify-on-failure job
 *   保留作为「工作流级失败」的兜底告警（本脚本是「门禁级」告警，两者独立）。
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPORTS = resolve(ROOT, 'reports');

const DRY_RUN = process.argv.includes('--dry-run');
const LOCAL_ONLY = process.argv.includes('--local');
const LABEL = 'gate-alert';
const ISSUE_TITLE = '[Gate Alert] 质量/可见性门禁判定';

// ==================== 1. 收集门禁结果 ====================

function latestReport(pattern) {
  if (!existsSync(REPORTS)) return null;
  const files = readdirSync(REPORTS)
    .filter(f => f.startsWith(pattern))
    .sort()
    .reverse();
  if (!files.length) return null;
  return readFileSync(resolve(REPORTS, files[0]), 'utf-8');
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function collectGateStates() {
  const states = [];

  // quality-gate
  // 关键：产物里的字段是 `decision: "allow" | "deny"`（不是 `allowed: true`）。
  // 早期版本误用 `v.allowed === true`，结果 15 站被拒却报「全放行」，等于把红线判成绿线——
  // 这是最典型的"门禁静默失效"，本次一并修掉。
  const qmRaw = latestReport('quality-metrics-');
  if (qmRaw) {
    const qm = parseJson(qmRaw);
    if (qm) {
      const verdicts = qm.sites || qm.verdicts || [];
      // 同时兼容两种字段命名（decision 是新版，allowed 是旧版兜底）
      const isAllowed = v => v.allowed === true || v.decision === 'allow';
      const isDenied = v => v.allowed === false || v.decision === 'deny';
      const allowed = verdicts.filter(isAllowed).length;
      const denied = verdicts.filter(isDenied);
      const pass = verdicts.length > 0 && denied.length === 0;
      states.push({
        name: 'quality-gate',
        file: `quality-metrics-${new Date().toISOString().slice(0, 10)}.json`,
        pass,
        summary: pass
          ? `全放行（${allowed}/${verdicts.length}）`
          : `被拒 ${denied.length}/${verdicts.length}`,
        details: denied.slice(0, 30).map(v => ({
          site: v.site,
          reason: v.rule_id || v.reason || '未分类',
          summary: typeof v.summary_rate === 'number'
            ? `摘要 ${(v.summary_rate * 100).toFixed(1)}% 标签 ${(v.tag_rate * 100).toFixed(1)}% DOI ${(v.doi_rate * 100).toFixed(1)}% 错配 ${(v.off_domain_rate * 100).toFixed(1)}%`
            : '',
        })),
      });
    }
  }

  // docs-visibility
  const dvRaw = latestReport('docs-guard-');
  if (dvRaw) {
    const dv = parseJson(dvRaw);
    if (dv) {
      const leaks = dv.private_leaks || dv.privateLeaks || 0;
      const pass = leaks === 0;
      states.push({
        name: 'docs-visibility',
        file: `docs-guard-${new Date().toISOString().slice(0, 10)}.json`,
        pass,
        summary: pass ? '无内部文档泄露' : `${leaks} 份内部文档仍出现在公开树`,
        details: dv.leaked_files || [],
      });
    }
  }

  // guard-eval（tools/guard-eval.mjs 冒烟）
  const geRaw = latestReport('guard-eval-');
  if (geRaw) {
    const ge = parseJson(geRaw);
    if (ge) {
      const total = ge.total || (ge.results || []).length;
      const passed = ge.passed || ge.results?.filter(r => r.passed).length;
      const pass = passed === total && total > 0;
      states.push({
        name: 'guard-eval',
        file: `guard-eval-${new Date().toISOString().slice(0, 10)}.json`,
        pass,
        summary: `${passed}/${total}`,
        details: (ge.results || []).filter(r => !r.passed).slice(0, 10),
      });
    }
  }

  return states;
}

// ==================== 2. 生成 body ====================

function renderBody(states, generatedAt) {
  if (!states.length) {
    return [
      '> ⚠️ 未找到任何门禁产物。这可能是首次运行，或 reports/ 目录被清空。',
      '',
      `- 生成时间：${generatedAt}`,
      '- 请跑 `node operations-plan/pipeline-quality-gate.js` 生成一次。',
    ].join('\n');
  }

  const header = states.filter(s => s.pass).length === states.length
    ? '## ✅ 全部门禁通过'
    : `## 🔴 ${states.filter(s => !s.pass).length}/${states.length} 门禁失败`;

  const lines = [
    header,
    '',
    `- 生成时间：${generatedAt}`,
    '',
    '| 门禁 | 状态 | 摘要 | 报告 |',
    '|---|---|---|---|',
  ];
  for (const s of states) {
    const icon = s.pass ? '✅' : '🔴';
    lines.push(`| ${s.name} | ${icon} | ${s.summary} | [\`${s.file}\`](../blob/master/reports/${s.file}) |`);
  }
  lines.push('');

  for (const s of states.filter(x => !x.pass)) {
    lines.push(`### ${s.name} 失败明细`);
    if (!s.details || !s.details.length) {
      lines.push('_（无明细）_');
    } else {
      for (const d of s.details) {
        if (d.site) lines.push(`- \`${d.site}\`：${d.reason || ''}`);
        else if (typeof d === 'string') lines.push(`- ${d}`);
        else lines.push(`- ${JSON.stringify(d).slice(0, 200)}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_本 Issue 由 `tools/gate-alert.mjs` 自动生成 / 更新。请勿手动编辑正文，否则下次运行会被覆盖。_');
  lines.push('_标签 `gate-alert` 用于锁定位——同一时间最多 1 条。_');

  return lines.join('\n');
}

// ==================== 3. gh CLI 封装 ====================

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: 30000 });
  return {
    code: r.status,
    stdout: r.stdout?.trim() || '',
    stderr: r.stderr?.trim() || '',
    ok: r.status === 0,
  };
}

function findExistingIssue() {
  const r = gh([
    'issue', 'list',
    '--label', LABEL,
    '--state', 'open',
    '--json', 'number,title,url',
    '--limit', '1',
  ]);
  if (!r.ok) return { error: r.stderr || r.stdout };
  try {
    const arr = JSON.parse(r.stdout);
    return arr[0] || null;
  } catch {
    return null;
  }
}

function createIssue(title, body) {
  if (DRY_RUN) {
    console.log(`[dry-run] 将创建 Issue：${title}`);
    console.log('--- body ---');
    console.log(body);
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'create', '--title', title, '--body', body, '--label', LABEL]);
  return { ok: r.ok, url: r.stdout, stderr: r.stderr };
}

function updateIssue(number, body) {
  if (DRY_RUN) {
    console.log(`[dry-run] 将更新 Issue #${number}`);
    console.log('--- body ---');
    console.log(body);
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'edit', String(number), '--body', body]);
  return { ok: r.ok, stderr: r.stderr };
}

function closeIssue(number, reason) {
  if (DRY_RUN) {
    console.log(`[dry-run] 将关闭 Issue #${number}：${reason}`);
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'close', String(number), '--comment', reason]);
  return { ok: r.ok, stderr: r.stderr };
}

// ==================== 4. 主流程 ====================

function main() {
  const generatedAt = new Date().toISOString();
  const states = collectGateStates();
  const allPass = states.length > 0 && states.every(s => s.pass);
  const anyFail = states.some(s => !s.pass);

  const body = renderBody(states, generatedAt);

  if (LOCAL_ONLY) {
    console.log(body);
    process.exit(anyFail ? 1 : 0);
  }

  const existing = findExistingIssue();

  if (allPass && existing) {
    const reason = `全部门禁通过（${generatedAt}）。关闭原因：CI 中 gate-alert 任务检测到所有门禁产物为绿。`;
    const r = closeIssue(existing.number, reason);
    if (!r.ok) {
      console.error(`[gate-alert] 关闭 Issue 失败：${r.stderr}`);
      process.exit(3);
    }
    console.log(`[gate-alert] 已关闭 Issue #${existing.number}`);
    process.exit(0);
  }

  if (anyFail) {
    if (existing) {
      const r = updateIssue(existing.number, body);
      if (!r.ok) {
        console.error(`[gate-alert] 更新 Issue 失败：${r.stderr}`);
        process.exit(3);
      }
      console.log(`[gate-alert] 已更新 Issue #${existing.number}（${states.filter(s => !s.pass).length} 门禁失败）`);
    } else {
      const r = createIssue(ISSUE_TITLE, body);
      if (!r.ok) {
        console.error(`[gate-alert] 创建 Issue 失败：${r.stderr}`);
        process.exit(3);
      }
      console.log(`[gate-alert] 已创建 Issue：${r.url || '(dry-run)'}`);
    }
    process.exit(1);
  }

  // 无告警（allPass 且无既有 Issue，或找不到任何门禁产物但不算 fail）
  if (states.length === 0) {
    console.log('[gate-alert] 未找到任何门禁产物，跳过。请先运行 pipeline-quality-gate.js 生成 reports/quality-metrics-*.json。');
    process.exit(0);
  }

  console.log('[gate-alert] 全部通过，无既有 Issue，无动作。');
  process.exit(0);
}

main();
