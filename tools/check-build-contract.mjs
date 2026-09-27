#!/usr/bin/env node
/**
 * tools/check-build-contract.mjs
 *
 * 构建期静态契约校验 —— DataFlow compile() 的对应物。
 *
 * 背景（2026-09-27）：insights-narrate.mjs 曾在模块顶层无条件执行 main()，
 * 其 process.exit(0) 在 build-site.mjs 里被 import 时杀掉了整个构建进程。
 * 退出码是 0，GitHub Actions 判 success，[data] 与 [ok] 日志行全缺失，
 * syncAggregatedData() 从未执行，_site/data/data-requests.json 从未发布。
 * 部署期契约校验（pages-deploy.yml 的 Verify data contract）是第一次
 * 抓住它的，但那已经跑完 80 秒构建 + 传完 _site 之后。
 *
 * 本脚本把这道门禁前移到构建开始之前，一次报全所有问题。
 *
 * 设计约束（与 scripts/check_engine_contract.py 同源）：
 *   - 纯静态分析，只读文本，**不 import 任何 tools/*.mjs**
 *   - 零依赖（仅 node:fs / node:path / node:process）
 *   - 因此 Actions 里跑它不会因任何构建工具的缺失而误判
 *
 * 检查项：
 *   P0  被 import 的模块无 CLI 守卫      —— insights-narrate 类故障的核心防线
 *   P0  被 import 的模块有顶层副作用     —— 库文件被 import 即执行重操作
 *   P1  数据产物缺生产者                 —— build-site 复制的 data/*.json 无源文件
 *   P1  聚合数据双路径不一致             —— AGGREGATED_DATA_FILES 与遗留复制列表的交集漂移
 *   P2  纯 CLI 脚本无守卫（防御性建议）   —— 现在安全，一旦被 import 就会炸
 *
 * 用法：
 *   node tools/check-build-contract.mjs [--verbose]
 *   exit 0 = 契约完整；exit 2 = 存在 P0/P1；exit 3 = 存在 P2 且 --strict
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 注意：不能直接用 new URL(import.meta.url).pathname —— Windows 上它会返回
// URL-encoded 的 /C:/Users/... 形式，path.resolve 会拼成 C:\C:\Users\... 并报
// ENOENT。必须走 fileURLToPath 才能拿到真正的绝对路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const LIB = path.join(TOOLS, 'lib');
const VERBOSE = process.argv.includes('--verbose');
const STRICT = process.argv.includes('--strict');

const issues = [];
const add = (severity, check, file, message) =>
  issues.push({ severity, check, file, message });

/* ── 工具函数 ─────────────────────────────────────────────────────────── */

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/** 顶层语句：行首无空白、非注释、非空。与 Python AST 顶层判定同构。 */
function topLevel(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || /^\s/.test(raw) || /^\s*\/\//.test(raw) || /^\s*\/\*/.test(raw) || /^\s*\*/.test(raw)) continue;
    out.push({ line: i + 1, text: raw.trim() });
  }
  return out;
}

/** 顶层是否是 main() / 顶层调用 main() 的形态 */
const MAIN_CALL = /^(?:await\s+)?(?:main|run)\s*\(\s*\)/;
const MAIN_CALL_ANY = /^(?:await\s+)?\w+\s*\(\s*\)/;

/** 顶层 process.exit 的两种形态：裸 exit 与 .catch(() => process.exit()) */
const EXIT_BARE = /^process\.exit\s*\(/;
const EXIT_IN_CATCH = /process\.exit\s*\(/;

/** CLI 守卫关键字：import.meta.url 与 argv[1] 的常见比较形态 */
const GUARD_TOKEN = /import\.meta\.url|process\.argv\[1\]|require\.main/;

/** 判断某个顶层入口调用行是否被 CLI 守卫保护。
 *
 *  关键：不能用「文件里是否出现守卫令牌」做判定 —— insights-narrate.mjs 的
 *  第 29 行 `const __dirname = path.dirname(fileURLToPath(import.meta.url))`
 *  与第 31 行 `const argv = process.argv.slice(2)` 都在顶层且都含守卫令牌，
 *  但它们是取值不是控制流。若用「文件级出现即算有守卫」，守卫 if 块被删掉
 *  后仍会误判为有守卫（假阴性）。
 *
 *  正确做法：从入口调用行向上回溯，找到最近的 `if (...)` 条件行，检查**该
 *  条件本身**是否含守卫令牌。找不到 if 条件就是裸调用（无守卫）。
 */
function guardedAt(lines, idx) {
  // 从 idx 向上找最近的非空、非注释的 if 条件行（允许多行条件：括号未闭合时继续上溯）
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || /^\s*\//.test(t)) continue;
    if (/\{\s*$/.test(t) || /^\}/.test(t)) return false; // 跨函数体/作用域，不属于该守卫
    if (/^(?:await\s+)?(?:main|run)\s*\(/.test(t)) continue; // 跳过年内的入口调用本身
    if (/^if\s*\(/.test(t)) {
      let cond = t.slice(2);
      let j = i;
      // 多行条件：向上拼到括号闭合
      while ((cond.match(/\(/g) || []).length > (cond.match(/\)/g) || []).length && j > 0) {
        j--;
        const pt = lines[j].trim();
        if (!pt || /^\s*\//.test(pt)) continue;
        cond = pt + ' ' + cond;
      }
      return GUARD_TOKEN.test(cond);
    }
    if (/^(?:const|let|var|function|export|import|class)\b/.test(t) && !/\{\s*$/.test(t)) {
      // 越过一个完整的声明语句，继续向上
      continue;
    }
    // 其他形态（顶层赋值、孤立语句）—— 保守：不算守卫
    return false;
  }
  return false;
}

/** 入口调用的行索引（从 0 开始）是否被守卫保护 */
function bareMainCalls(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /^\s/.test(lines[i]) || /^\s*\//.test(lines[i])) continue;
    if (EXIT_BARE.test(t) || MAIN_CALL.test(t) ||
        (EXIT_IN_CATCH.test(t) && /\.\s*catch\s*\(/.test(t))) {
      const kind = EXIT_BARE.test(t) ? 'process.exit'
        : MAIN_CALL.test(t) ? 'main()' : 'main().catch';
      hits.push({ line: i + 1, idx: i, kind, text: t, guarded: guardedAt(lines, i) });
    }
  }
  return hits;
}

/* ── 第 1 步：构建 import 依赖图 ──────────────────────────────────────── */

const allFiles = fs.readdirSync(TOOLS)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join(TOOLS, f));


/** moduleFile -> Set<被谁 import（相对 tools/ 的路径）> */
const importedBy = new Map();

for (const f of allFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(TOOLS, f);
  // 静态 import ... from './a.mjs' 与动态 await import('./a.mjs') 都必须覆盖。
  // 只匹配静态形态会漏掉动态导入 —— insights-narrate.mjs 正是被 build-site.mjs
  // 用 await import() 引入的；这是本校验器最初的假阴性来源。
  for (const m of src.matchAll(/(?:from|import\s*\(\s*)['"](\.\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    const key = path.relative(TOOLS, target);
    if (!importedBy.has(key)) importedBy.set(key, new Set());
    importedBy.get(key).add(rel);
  }
}

// lib/ 下的文件：它们是库，被 import 即加载，天然属于「被 import 的模块」
for (const f of fs.readdirSync(LIB).filter((f) => f.endsWith('.mjs'))) {
  const key = path.join('lib', f);
  if (!importedBy.has(key)) importedBy.set(key, new Set());
}

/* ── 第 2 步：逐文件静态检查 ─────────────────────────────────────────── */

// 统一成绝对路径。注意：importedBy 的 key 是相对 tools/ 的路径（如
// 'lib/llm-bridge.mjs'），需要 join(TOOLS, key) 还原；allFiles 本身已是绝对路径。
const allTargets = [...new Set([
  ...allFiles,
  ...[...importedBy.keys()].map((k) => path.join(TOOLS, k)),
])];

for (const abs of allTargets) {
  if (!fs.existsSync(abs)) continue;
  const lines = readLines(abs);
  if (!lines) { add('P0', 'syntax', abs, '文件不可读'); continue; }
  const rel = path.relative(ROOT, abs);
  const imports = importedBy.get(path.relative(TOOLS, abs));
  const isLib = abs.startsWith(LIB);
  // lib/ 文件视为「被 import」；tools/*.mjs 有真实 import 边才算
  const imported = isLib || (imports && imports.size > 0);

  const bare = bareMainCalls(lines);

  if (bare.length === 0) continue;

  for (const b of bare) {
    if (imported && !b.guarded) {
      add('P0', 'cli-guard', rel,
        `第 ${b.line} 行顶层裸 ${b.kind}（${b.text.slice(0, 60)}），` +
        `且该调用未被 CLI 守卫控制 —— 被 ${[...imports][0]} import 时会杀掉宿主进程`);
    } else if (!imported && !b.guarded) {
      add('P2', 'cli-guard', rel,
        `第 ${b.line} 行顶层裸 ${b.kind}，当前为纯 CLI 未被 import —— ` +
        `安全，但一旦被 import 即会杀掉宿主进程，建议补 import.meta.url 守卫`);
    }
  }

  // 库文件的顶层重副作用（独立于 main/exit）
  if (isLib) {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^\s/.test(lines[i]) || !t || /^\s*\//.test(lines[i])) continue;
      if (/(?:^|\.)\s*(execSync|spawnSync|fork)\s*\(/.test(t) ||
          /\bunref\s*\(\s*\)|\bsetInterval\s*\(/.test(t)) {
        add('P0', 'lib-sideeffect', rel,
          `第 ${i + 1} 行顶层调用 ${t.slice(0, 60)} —— 库文件被 import 即产生副作用`);
      }
    }
  }
}

/* ── 第 3 步：数据产物生产者校验 ─────────────────────────────────────── */

const DATA = path.join(ROOT, 'data');
const STATE = path.join(ROOT, 'state');

// 从 build-site.mjs 解析遗留复制列表（第 2089 行的 for (const rel of [...])）
const bsLines = readLines(path.join(TOOLS, 'build-site.mjs')) || [];
const bsSrc = bsLines.join('\n');

const relList = (bsSrc.match(/for\s*\(const\s+rel\s+of\s*\[([^\]]+)\]/) || [])[1] || '';
const legacy = [...relList.matchAll(/['"]((?:data|state)\/[^'"]+)['"]/g)].map((m) => m[1]);

// AGGREGATED_DATA_FILES 常量块
const aggBlock = (bsSrc.match(/AGGREGATED_DATA_FILES\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
const agg = [...aggBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).map((f) => f.replace(/^/, 'data/'));

// ── 克隆过期识别 ──────────────────────────────────────────────────────
// 本仓库 data/ 目录的大文件（academic-entities 13MB、pubmed-entities 6MB、
// knowledge-graph-entities 18MB 等）由每日 CI 写入。开发机上的克隆常常过期，
// 缺这些文件不代表配置错了，而是本地没跟上远端。若把这种情况报成 P1，
// 门禁会在克隆过期时全线误报，反而让人忽略真问题。
//
// 判定：本地 data/ 存在的数据文件数少于 legacy 声明的一半，判为克隆过期，
// 把 data-producer 降级为 INFO。混合情况（部分有、部分缺）才是真配置错误。
const localDataFiles = fs.existsSync(DATA)
  ? fs.readdirSync(DATA).filter((f) => f.endsWith('.json'))
  : [];
const expectedBases = [...new Set([...legacy, ...agg].map((r) => path.basename(r)))];
const expectedHave = expectedBases.filter((b) => localDataFiles.includes(b));
const CLONE_STALE = expectedBases.length > 0 && expectedHave.length < expectedBases.length / 2;

if (CLONE_STALE) {
  console.log('');
  console.log(`  [INFO] 克隆过期识别：本地 data/ 只有 ${localDataFiles.length} 个 .json，` +
    `而 build-site 声明 ${expectedBases.length} 个数据产物 —— ` +
    `data-producer 检查降级为信息级（CI 上 checkout 最新远端不受影响）`);
}

// 每个被复制的文件，源必须存在（否则 build 静默跳过，契约文件 404）
const missingProducer = [];
for (const rel of [...new Set([...legacy, ...agg])]) {
  const base = rel.split('/').pop();
  const inData = rel.startsWith('data/');
  const src = inData ? path.join(DATA, base) : path.join(STATE, base);
  if (!fs.existsSync(src)) missingProducer.push(rel);
}
for (const r of missingProducer) {
  add(CLONE_STALE ? 'INFO' : 'P1', 'data-producer', r,
    CLONE_STALE
      ? `build-site 声明复制 ${r}，本地源文件不存在（克隆过期，非配置错误）`
      : `build-site 声明复制 ${r}，但源文件不存在 —— 构建会静默跳过，部署产物 404`);
}

/* ── 第 4 步：聚合数据双路径一致性 ───────────────────────────────────── */

const onlyLegacy = legacy.filter((r) => !agg.some((a) => a.endsWith(path.basename(r))));
const onlyAgg = agg.filter((r) => !legacy.some((l) => l.endsWith(path.basename(r))));

if (onlyAgg.length || onlyLegacy.length) {
  for (const r of onlyAgg) {
    add('P1', 'data-dualpath', r,
      `仅在 AGGREGATED_DATA_FILES（syncAggregatedData，构建末段）—— ` +
      `该函数晚于 narrate，若上游 process.exit 被杀则永不发布。建议同时加入遗留复制列表做双保险`);
  }
  for (const r of onlyLegacy) {
    add('P2', 'data-dualpath', r,
      `仅在遗留复制列表，未进 AGGREGATED_DATA_FILES —— 契约校验不会覆盖它`);
  }
}

/* ── 报告 ─────────────────────────────────────────────────────────────── */

const bySev = (s) => issues.filter((i) => i.severity === s);
const P0 = bySev('P0').length, P1 = bySev('P1').length, P2 = bySev('P2').length;
const INFO = bySev('INFO').length;

console.log('='.repeat(72));
console.log('build 静态契约校验（编译期，零执行）');
console.log('='.repeat(72));
console.log(`扫描 tools/ 与 tools/lib/ 共 ${allTargets.length} 个文件`);
console.log(`legacy 复制 ${legacy.length} 项 / AGGREGATED_DATA_FILES ${agg.length} 项`);
console.log(`问题总数: ${issues.length}   阻断级(P0/P1): ${P0 + P1}   建议(P2): ${P2}   信息: ${INFO}`);
console.log('');

const ORDER = { P0: 0, P1: 1, P2: 2, INFO: 3 };
for (const it of [...issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])) {
  console.log(`  [${it.severity}]  ${it.file}  ${it.check}`);
  console.log(`        ${it.message}`);
}
console.log('');

if (P0 === 0 && P1 === 0) {
  console.log(P2 || INFO ? `✓ 契约完整（${P2} 个 P2 建议、${INFO} 个信息项）` : '✓ 契约完整');
  process.exit(0);
}
console.log(`✗ ${P0} 个 P0、${P1} 个 P1 待修`);
process.exit(STRICT && (P0 || P1) ? 3 : 2);
