/**
 * tests/docs-claims-regression.test.mjs — T7 对外数字治理回归测试
 * ============================================================================
 * 覆盖 §7 M4 对外口径漂移机制的「双向回归」：
 *   1. 注入一个错误的数字到 README anchor 内 → --verify 必须 exit 1（CI 会红）
 *   2. 恢复 README → --verify 必须 exit 0（绿灯回归）
 *
 * 不变量（血泪教训）：
 *   - 只测「绿→红→绿」闭环，绝不只测绿灯；
 *   - 用 tmpfile + fs.rename 备份 README，测试结束必须恢复，即使子进程异常；
 *   - 用 execFileSync + encoding:'utf8' 拿到 exit code + stderr（console.error 走 stderr）；
 *   - 单次测试 ~3-5s（脚本冷启动 + 扫 30 站 entities.json），可接受。
 *
 * 前置：
 *   - README.md 内必须有 `<!-- GENETECH:CLAIMS:BEGIN/END -->` 锚注
 *   - data/metrics.json、data/claims.json、data/citation-edges.json、data/knowledge-graph.json 齐全
 *
 * 运行：`npm test -- tests/docs-claims-regression.test.mjs` 或 `node --test tests/docs-claims-regression.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'operations-plan', 'pipeline-docs-claims.js');
const TARGET = path.join(ROOT, 'README.md');
const BEGIN = '<!-- GENETECH:CLAIMS:BEGIN -->';
const END = '<!-- GENETECH:CLAIMS:END -->';

/** 用 tmpfile + rename 做原子备份，避免测试中途崩溃留半成品 */
function backup(file, tag) {
  const dst = file + `.__bak_${tag}__`;
  fs.copyFileSync(file, dst);
  return dst;
}

function restore(src, dst) {
  fs.copyFileSync(src, dst);
}

/** 跑 pipeline-docs-claims.js --verify，返回 { status, stderr } */
function runVerify() {
  try {
    execFileSync(process.execPath, [SCRIPT, '--verify'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30000,
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    return {
      status: e.status ?? -1,
      stderr: (e.stderr || '').toString(),
      stdout: (e.stdout || '').toString(),
    };
  }
}

/** 在 anchor 之间找到一个数字单元格并替换，制造漂移 */
function injectStaleClaim(text) {
  const idxBegin = text.indexOf(BEGIN);
  const idxEnd = text.indexOf(END);
  if (idxBegin === -1 || idxEnd === -1) {
    throw new Error(`README.md 缺 CLAIMS 锚注，无法注入`);
  }
  const before = text.slice(0, idxBegin);
  const anchor = text.slice(idxBegin, idxEnd + END.length);
  const after = text.slice(idxEnd + END.length);
  // 找第一个 `| **数字** |` 单元并把数字改大 1000000
  const replaced = anchor.replace(/\| \*\*([0-9,]+)\*\* \|/u, (m, n) => {
    const num = Number(n.replace(/,/g, ''));
    const stale = (num + 1_000_000).toLocaleString('en-US');
    return `| **${stale}** |`;
  });
  if (replaced === anchor) {
    throw new Error('注入失败：anchor 内没找到 `| **数字** |` 单元格');
  }
  return before + replaced + after;
}

// ---- 前置自检 ----

test('T7-0: 前置条件（README anchor + 依赖数据文件齐全）', () => {
  assert.ok(fs.existsSync(SCRIPT), `pipeline-docs-claims.js 缺失：${SCRIPT}`);
  assert.ok(fs.existsSync(TARGET), `README.md 缺失`);
  const text = fs.readFileSync(TARGET, 'utf8');
  assert.ok(text.includes(BEGIN), 'README 缺 BEGIN 锚注');
  assert.ok(text.includes(END), 'README 缺 END 锚注');
  for (const p of [
    'data/metrics.json',
    'data/claims.json',
    'data/citation-edges.json',
    'data/knowledge-graph.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `缺失依赖数据：${p}`);
  }
});

// ---- 绿灯：--verify 无漂移时 exit 0 ----

test('T7-1 绿灯：未注入时 --verify 应 exit 0', () => {
  const r = runVerify();
  assert.strictEqual(r.status, 0, `--verify 应绿灯，实际 ${r.status}。stderr:\n${r.stderr}`);
});

// ---- 红绿回归：注入错误数字 → exit 1 → 恢复 → exit 0 ----

test('T7-2 红→绿双向回归：注入错误数字后 --verify 应 exit 1，恢复后回绿', (t) => {
  const original = fs.readFileSync(TARGET, 'utf8');
  const backupPath = backup(TARGET, 't7-2');

  t.after(() => {
    try {
      restore(backupPath, TARGET);
    } finally {
      try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
      assert.strictEqual(
        fs.readFileSync(TARGET, 'utf8'),
        original,
        'T7-2 结束后 README 应完全恢复原文'
      );
    }
  });

  // 1) 注入错误数字
  const stale = injectStaleClaim(original);
  fs.writeFileSync(TARGET, stale, 'utf8');

  // 2) --verify 应 exit 1
  const red = runVerify();
  assert.strictEqual(red.status, 1, `注入后 --verify 应红灯 exit 1，实际 ${red.status}`);
  assert.ok(
    /DRIFT|anchor/.test(red.stderr),
    `--verify stderr 应包含 DRIFT/anchor 关键字，实际：\n${red.stderr}`
  );

  // 3) 恢复原文
  fs.writeFileSync(TARGET, original, 'utf8');

  // 4) --verify 应 exit 0
  const green = runVerify();
  assert.strictEqual(green.status, 0, `恢复后 --verify 应回绿，实际 ${green.status}。stderr:\n${green.stderr}`);
});

// ---- Anchor 内容真源比对：README 内数字 == claims.json 单一真源 ----

test('T7-3 anchor 数字与 claims.json 单一真源逐一对齐', () => {
  const claims = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'claims.json'), 'utf8'));
  const readme = fs.readFileSync(TARGET, 'utf8');
  const idxBegin = readme.indexOf(BEGIN);
  const idxEnd = readme.indexOf(END);
  const anchor = readme.slice(idxBegin, idxEnd + END.length);

  const mustAppear = [
    claims.claims.siteCount.toLocaleString('en-US'),
    claims.claims.totalEntities.toLocaleString('en-US'),
    claims.claims.entitiesWithDoiOrPmid.toLocaleString('en-US'),
    (claims.claims.uniqueDoi ?? 0).toLocaleString('en-US'),
    claims.claims.knowledgeGraphNodes.toLocaleString('en-US'),
    claims.claims.knowledgeGraphEdges.toLocaleString('en-US'),
  ];
  for (const num of mustAppear) {
    assert.ok(anchor.includes(num), `anchor 应包含真源数字 ${num}`);
  }
});
