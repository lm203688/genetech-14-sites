#!/usr/bin/env node
/**
 * 闭环六：引文完整性核验（cite-check）—— pipeline-cite-check.js
 *
 * 借鉴 HyperResearch 的 cite-checker（逐条核对引文是否原文存在 + 查 DOI 撤回），
 * 作为「报告出厂前的最后一道关」接入飞轮：扫描本仓所有对外/对内 Markdown 报告，
 * 逐条核验其引文（URL 存活性 / DOI 撤回 / 引号逐条核验），产出 JSON + Markdown 台账。
 *
 * 核验对象：
 *   - content/blog/*.md      GEO 博客（对外发布，最高优先级）
 *   - docs/ 及其子目录下的 .md    分析 / 洞察 / 调研文档
 *   - reports/*.md           飞轮周报 / 日报台账
 *
 * 门禁策略（默认非阻断，避免破坏现有绿色运行）：
 *   - 默认 flag 模式：恒 exit 0，死链/撤回以 ::warning:: 形式提示
 *   - STRICT_CITE=1：存在 dead 或 retracted → exit 1（可挂 CI 硬门禁）
 *
 * 用法：node pipeline-cite-check.js [--dry-run]
 * 环境变量：STRICT_CITE(0|1), CITE_CONCURRENCY, CITE_CURL_TIMEOUT, CITE_CLAIM_LIMIT
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const CITE_CHECKER = path.join(PROJECT_ROOT, 'tools', 'cite-checker.mjs');

const STRICT = process.env.STRICT_CITE === '1';
// Cloudflare Worker 默认域兜底（*.workers.dev）：已知国内被墙、海外 runner 直连返回 404，
// 属基础设施 URL 而非对外引文，不计入 STRICT 门禁（避免误杀 license/api 兜底端点文档）。
const INFRA_URL_ALLOW = /\.workers\.dev$/;
const SCAN_TARGETS = [
  path.join(PROJECT_ROOT, 'content', 'blog'),
  path.join(PROJECT_ROOT, 'docs'),
  REPORTS_DIR,
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const today = new Date().toISOString().slice(0, 10);

  if (!fss.existsSync(CITE_CHECKER)) {
    console.error(`[cite-check] 缺少核验器 ${CITE_CHECKER}`);
    process.exit(1);
  }

  // 动态导入 ESM 核验器（本仓 pipeline 为 CommonJS）
  const { checkPaths } = await import(pathToFileURL(CITE_CHECKER).href);

  const targets = SCAN_TARGETS.filter((t) => fss.existsSync(t));
  if (!targets.length) {
    console.log('[cite-check] 无可扫描目录，跳过');
    process.exit(0);
  }

  console.log(`[cite-check] 模式 ${STRICT ? 'STRICT（硬门禁）' : 'flag（仅提示，非阻断）'} · 扫描 ${targets.length} 个目录`);

  let report;
  try {
    // 忽略本工具自身的台账，避免自指噪声
    report = await checkPaths(targets, {
      strict: STRICT,
      checkClaims: true,
      ignore: /cite-check-\d{4}-\d{2}-\d{2}\.md$/,
    });
  } catch (e) {
    console.error('[cite-check] 核验器异常：', e && e.message ? e.message : String(e));
    process.exit(STRICT ? 1 : 0);
  }

  const S = report.summary;
  console.log(`[cite-check] 文件 ${S.filesChecked} / 引文 ${S.totalCitations} → ok ${S.ok} · redirect ${S.redirect} · dead ${S.dead} · blocked ${S.blocked} · unresolved ${S.unresolved} · server-error ${S.serverError} · unreachable ${S.unreachable} · retracted ${S.retracted}`);
  console.log(`[cite-check] 逐条核验 ${S.claimsChecked} → verified ${S.claimsVerified} · mismatch ${S.claimsFailed} · unverified ${S.claimsUnverified}`);

  const problems = report.items.filter(
    (r) => (r.status === 'dead' || r.status === 'retracted') && !INFRA_URL_ALLOW.test(r.target)
  );
  if (problems.length) {
    for (const p of problems.slice(0, 20)) {
      console.log(`[cite-check] ⚠ ${p.file} :: ${p.kind} ${p.target} → ${p.status}${p.httpStatus ? ` (HTTP ${p.httpStatus})` : ''}`);
    }
    if (problems.length > 20) console.log(`[cite-check] ⚠ 另有 ${problems.length - 20} 条，详见 JSON 台账`);
  }

  // 门禁判定先于 dry-run 计算：dry-run 也反映 STRICT 结论，便于 CI 试跑验证门禁本身
  const gateBlocked = problems.length > 0;
  if (STRICT) {
    console.log(`[cite-check] STRICT 门禁判定：${gateBlocked ? '❌ FAIL' : '✅ PASS'}（dead=${S.dead} retracted=${S.retracted}）`);
  }

  if (dryRun) {
    console.log('[cite-check] --dry-run，不写台账');
    process.exit(STRICT && gateBlocked ? 1 : 0);
  }

  // 台账落盘
  const jsonPath = path.join(REPORTS_DIR, `cite-check-${today}.json`);
  const mdPath = path.join(REPORTS_DIR, `cite-check-${today}.md`);

  const lines = [];
  lines.push(`# 引文完整性核验台账 — ${today}`);
  lines.push('');
  lines.push(`> 模式：${STRICT ? '**STRICT 硬门禁**' : 'flag 仅提示（非阻断）'} · 生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 扫描文件数 | ${S.filesChecked} |`);
  lines.push(`| 引文总数 | ${S.totalCitations} |`);
  lines.push(`| ✅ 存活（ok） | ${S.ok} |`);
  lines.push(`| ↪ 重定向（redirect） | ${S.redirect} |`);
  lines.push(`| ❌ 死链（dead, 404/410） | ${S.dead} |`);
  lines.push(`| 🚫 出版商拦截（blocked, 401/403/429/451） | ${S.blocked} |`);
  lines.push(`| ❓ 索引查无（unresolved） | ${S.unresolved} |`);
  lines.push(`| 🔧 上游故障（server-error, 5xx） | ${S.serverError} |`);
  lines.push(`| ⚠ 本次不可达（unreachable） | ${S.unreachable} |`);
  lines.push(`| 🔴 已撤回（retracted） | ${S.retracted} |`);
  lines.push(`| 引用逐条核验 | ${S.claimsVerified}/${S.claimsChecked} verified · ${S.claimsFailed} mismatch · ${S.claimsUnverified} unverified |`);
  lines.push('');

  if (problems.length) {
    lines.push('## ❌ 需处理：死链 / 已撤回');
    lines.push('');
    lines.push('| 文件 | 类型 | 目标 | 状态 | HTTP | 备注 |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of problems) {
      const note = p.reason ? p.reason : (p.error || '');
      lines.push(`| \`${path.relative(PROJECT_ROOT, p.file)}\` | ${p.kind} | ${p.target} | **${p.status}** | ${p.httpStatus || '—'} | ${note.replace(/\|/g, '\\|').slice(0, 80)} |`);
    }
    lines.push('');
  } else {
    lines.push('## ✅ 无死链、无撤回文献');
    lines.push('');
  }

  const mismatch = report.claims.filter((r) => r.claimVerified === 'mismatch');
  if (mismatch.length) {
    lines.push('## ⚠ 引文逐条核验未通过（引号文本未在原文中逐字命中）');
    lines.push('');
    lines.push('| 文件:行 | 目标 | 引文片段 |');
    lines.push('|---|---|---|');
    for (const c of mismatch) {
      lines.push(`| \`${path.relative(PROJECT_ROOT, c.file)}:${c.line}\` | ${c.url} | ${String(c.claim).replace(/\|/g, '\\|').slice(0, 120)} |`);
    }
    lines.push('');
    lines.push('> 说明：此项为 best-effort 建议项（advisory），受目标页正文抓取限制，未通过≠引文有误，需人工复核。');
    lines.push('');
  }

  const redirects = report.items.filter((r) => r.status === 'redirect');
  if (redirects.length) {
    lines.push('## ↪ 重定向目标（建议更新为最终 URL）');
    lines.push('');
    lines.push('| 文件 | 原目标 | 最终目标 |');
    lines.push('|---|---|---|');
    for (const r of redirects) {
      lines.push(`| \`${path.relative(PROJECT_ROOT, r.file)}\` | ${r.target} | ${r.effectiveUrl || '—'} |`);
    }
    lines.push('');
  }

  const unreachable = report.items.filter((r) => r.status === 'unreachable');
  if (unreachable.length) {
    lines.push('## ⚠ 本次不可达（网络/代理/超时，非死链）');
    lines.push('');
    lines.push(`共 ${unreachable.length} 条，多为网络受限或目标超时，**不判定为死链**；下次运行会重试。`);
    lines.push('');
  }

  const unresolved = report.items.filter((r) => r.status === 'unresolved');
  if (unresolved.length) {
    lines.push('## ❓ 索引查无此 DOI（需人工确认，可能为新文献/预印本/录入笔误）');
    lines.push('');
    lines.push('| 文件 | DOI | 备注 |');
    lines.push('|---|---|---|');
    for (const u of unresolved) {
      lines.push(`| \`${path.relative(PROJECT_ROOT, u.file)}\` | ${u.target} | OpenAlex 无记录 |`);
    }
    lines.push('');
  }

  const blocked = report.items.filter((r) => r.status === 'blocked');
  if (blocked.length) {
    lines.push('## 🚫 出版商/反爬拦截（blocked，非死链，不需处理）');
    lines.push('');
    lines.push(`共 ${blocked.length} 条。多为出版商对 bot 返回 401/403/429/451（如 ScienceDirect、Wiley、Hindawi 对自动化请求恒 403），`);
    lines.push('DOI 已通过 OpenAlex 索引确认真实存在，**不判定为引文失效，门禁不阻断**。');
    lines.push('');
  }

  lines.push('## 口径说明');
  lines.push('');
  lines.push('- **dead（死链）**：仅指 HTTP 404/410，即目标不存在或已永久移除。这是唯一会阻断门禁的 HTTP 问题。');
  lines.push('- **blocked（拦截）**：401/403/429/451。出版商对 bot 拦截极常见，**不等于引文失效**，不阻断。');
  lines.push('- **unresolved**：OpenAlex 索引中查无该 DOI，可能为新文献/预印本/录入笔误，需人工确认。');
  lines.push('- **server-error**：5xx 上游临时故障，重试可能恢复，不阻断。');
  lines.push('- **unreachable**：网络/代理/超时导致的取不到响应，**不判死**；下次运行会重试。');
  lines.push('- **DOI 存活性主判据 = OpenAlex 是否有记录**（索引有记录即判 ok），不走 doi.org 浏览器路径（该路径对 bot 恒 403，会造成大面积假阳性）。');
  lines.push('- **撤回判定**：OpenAlex `is_retracted`；retracted 会阻断门禁。');
  lines.push('- **逐条核验**：仅当引文所在行含「…」或 "…" 引号时执行，每文件上限 `CITE_CLAIM_LIMIT`（默认 3）条；best-effort 建议项，未通过≠引文有误。');
  lines.push('- **借鉴来源**：HyperResearch（jordan-gibbs/hyperresearch，MIT）的 cite-checker 机制，已本地化为零依赖 curl 实现。');
  lines.push('');

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(mdPath, lines.join('\n'), 'utf8');
  console.log(`[cite-check] 台账 → reports/cite-check-${today}.json / .md`);

  if (STRICT && gateBlocked) {
    console.log(`[cite-check] STRICT 门禁未通过：dead=${S.dead} retracted=${S.retracted}`);
    process.exit(1);
  }
  console.log(`[cite-check] 完成`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[cite-check] 未捕获异常：', e && e.stack ? e.stack : String(e));
  process.exit(process.env.STRICT_CITE === '1' ? 1 : 0);
});
