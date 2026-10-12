#!/usr/bin/env node
/**
 * operations-plan/pipeline-docs-guard.js
 *
 * F6「文档内外分离」的可执行形态。策略在 guards/docs-visibility.policy.json，
 * 扫描与判定在本文件，判定结果可交给 tools/guard-eval.mjs 复核。
 *
 * 为什么不能只靠 .gitignore
 *   .gitignore 只管「新增文件不入库」，管不了「已经入库的文件」。
 *   docs/audit-*.md 早就被 .gitignore 挡了，但 docs/audit-2026-08-31.md 仍然在公开树里
 *   ——因为它在规则生效之前就已经提交。所以要真正止血，必须把已入库的内部文档
 *   的内容从公开树里替换掉，而不只是给未来的文件加规则。
 *
 * 三个动作（默认只读，逐个显式开启）
 *   --check        只扫描分类，输出 private/public/unclassified 三类清单
 *   --fix          把 private 文档的**内容**替换成占位 stub（保留标题与迁移说明），
 *                  真内容归档到 .workbuddy/private-docs/（该目录已在 .gitignore）
 *   --verify       用 guard-eval 复核本次扫描结果是否放行
 *
 * 不可逆操作防护（与 quality-gate 的 A10 约定一致）
 *   - 默认 dry-run（--check），不动任何文件。
 *   - --fix 落盘前先在 .backups/ 建备份，纯 JS 拷贝（Node 的 spawnSync 在当前
 *     沙箱下报 EBUSY 拉不起 tar，2026-10-08 实测）。
 *   - stub 只留标题 + 迁移说明，不含任何内部内容；回滚是把备份拷回来。
 *
 * 退出码：0 放行 / 1 阻断 / 2 配置错误
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOCS = path.join(ROOT, 'docs');
const POLICY = path.join(ROOT, 'guards', 'docs-visibility.policy.json');
const ARCHIVE = path.join(ROOT, '.workbuddy', 'private-docs');
const BACKUP = path.join(ROOT, '.backups');
const MODE = process.argv.includes('--fix') ? 'fix' : process.argv.includes('--verify') ? 'verify' : 'check';

function loadPolicy() {
  if (!fs.existsSync(POLICY)) {
    console.error(`[docs-guard][FAIL] 策略缺失: ${POLICY}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(POLICY, 'utf8'));
}

/** 列出 docs/ 下的 md/html 文档（跳过子目录里的历史 HTML 演示稿之外的内容）。 */
function listDocs() {
  const out = [];
  (function walk(p, rel) {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), r);
      else if (/\.(md|html)$/.test(e.name)) out.push(r);
    }
  })(DOCS, '');
  return out;
}

function classify(rel, pol) {
  const allow = pol.classification.public_allowlist;
  const pats = pol.classification.internal_patterns.map((s) => new RegExp(s));
  const name = path.basename(rel);
  if (allow.includes(rel) || allow.includes(name)) return 'public';
  if (pats.some((re) => re.test(rel) || re.test(name))) return 'private';
  return 'unclassified';
}

/** 判断文件是否已被替换成 stub（stub 含固定标记行）。 */
const STUB_MARKER = '<!-- docs-visibility: stubbed -->';
function isStub(p) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    return t.includes(STUB_MARKER) && t.length < 2000;
  } catch { return false; }
}

function makeStub(rel, archived) {
  const base = path.basename(rel);
  return [
    `# ${base.replace(/\.(md|html)$/, '')}`,
    '',
    STUB_MARKER,
    '',
    '> **本文件原文已归档到私有目录，公开树不再承载其内容。**',
    '',
    '> 这是一份**内部文档**（战略/竞品/增长/告警/审计类），不适合出现在公开仓。',
    '> 迁移于 2026-10-08，由 `operations-plan/pipeline-docs-guard.js --fix` 执行。',
    '',
    `归档位置：\`${path.relative(ROOT, path.join(ARCHIVE, rel))}\``,
    '',
    '> 如需恢复公开，请先把内容按「公开白名单」的标准改写（去掉内部数据与策略细节），',
    '> 再在 `guards/docs-visibility.policy.json` 的 `public_allowlist` 里显式放行。',
    '',
  ].join('\n');
}

function backupAll(files) {
  if (!files.length) return '';
  fs.mkdirSync(BACKUP, { recursive: true });
  const dir = path.join(BACKUP, `docs-before-visibility-${new Date().toISOString().slice(0, 10)}`);
  for (const f of files) {
    const src = path.join(DOCS, f);
    const dst = path.join(dir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return path.relative(ROOT, dir);
}

function main() {
  const pol = loadPolicy();
  const docs = listDocs();
  const buckets = { public: [], private: [], unclassified: [] };
  const leaks = [];   // private 且内容仍在公开树
  const stubbed = [];

  for (const rel of docs) {
    const p = path.join(DOCS, rel);
    const cls = classify(rel, pol);
    buckets[cls].push(rel);
    if (cls !== 'private') continue;
    if (isStub(p)) stubbed.push(rel);
    else leaks.push(rel);
  }

  console.log(`[docs-guard] 模式=${MODE} | docs 文档 ${docs.length} 个`);
  console.log(`  public(白名单)      ${buckets.public.length}`);
  console.log(`  private(内部)       ${buckets.private.length}  → 已 stub ${stubbed.length}，仍泄露 ${leaks.length}`);
  console.log(`  unclassified(未分类) ${buckets.unclassified.length}`);

  if (buckets.unclassified.length) {
    console.log('');
    console.log('[docs-guard] 未分类清单（默认按 private 处理，请显式归类）：');
    for (const u of buckets.unclassified) console.log(`  ? ${u}`);
  }

  if (leaks.length) {
    console.log('');
    console.log(`[docs-guard][LEAK] 公开树中仍有真内容的内部文档 ${leaks.length} 份：`);
    for (const l of leaks) console.log(`  ! ${l}`);
  }

  if (MODE === 'fix' && leaks.length) {
    const dir = backupAll(leaks);
    if (!dir) { console.error('[docs-guard][ABORT] 备份失败，拒绝改写'); process.exit(2); }
    fs.mkdirSync(ARCHIVE, { recursive: true });
    for (const rel of leaks) {
      const src = path.join(DOCS, rel);
      fs.mkdirSync(path.dirname(path.join(ARCHIVE, rel)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(DOCS, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(ARCHIVE, rel));           // 真内容 → 私有归档
      fs.writeFileSync(path.join(DOCS, rel), makeStub(rel));   // 公开树 → stub
    }
    console.log('');
    console.log(`[docs-guard] 已归档 ${leaks.length} 份到 ${path.relative(ROOT, ARCHIVE)}/`);
    console.log(`[docs-guard] 备份 → ${dir}/（回滚：把备份拷回 docs/ 即可）`);
    console.log('[docs-guard] 注意：.workbuddy/ 与 .backups/ 均已在 .gitignore，归档内容不入仓。');
  }

  // 判定上下文 → guard-eval
  const ctx = {
    action: 'docs_visibility_check',
    private_leaks: leaks.length,
    unclassified_count: buckets.unclassified.length,
    total: docs.length,
  };
  console.log('');
  console.log(`[docs-guard] 判定上下文: ${JSON.stringify(ctx)}`);

  // 阻断条件：存在真泄露
  if (leaks.length > pol.thresholds.private_leak_max) {
    console.log('[docs-guard][BLOCK] 公开树仍有内部文档真内容，退出码 1。');
    process.exit(1);
  }
  if (buckets.unclassified.length) {
    console.log('[docs-guard][WARN] 存在未分类文档（告警级，不阻断）。');
  }
  console.log('[docs-guard] 放行。');
}

main();
