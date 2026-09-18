#!/usr/bin/env node
/**
 * scan-secrets.mjs — 仓库密钥泄漏扫描（fail-closed）
 * ============================================================================
 * 由来：2026-09-16 提交 95caf35 把真实 GATEWAY_SECRET 以明文写进 README.md / _test.mjs，
 * 而本仓是 public —— 任何人无需登录即可读到并自签任意 slb_ key（2026-09-18 复盘）。
 * unified-license/DEPLOY-SECRETS.md 早有「切勿提交密钥」的告诫，仍未防住，说明
 * **「写在文档里」不是机制**。本脚本把该条规则变成可执行的 CI 门禁。
 *
 * 用法：
 *   node tools/scan-secrets.mjs              # 扫描 git 跟踪的文件（默认）
 *   node tools/scan-secrets.mjs --all        # 扫描工作区所有文件（跳过忽略目录）
 *   node tools/scan-secrets.mjs <path...>    # 只扫指定文件/目录
 *   node tools/scan-secrets.mjs --json       # 机器可读输出
 *
 * 退出码：0 = 干净；1 = 发现疑似密钥（fail-closed，CI 应据此阻断）。
 *
 * 设计约束（避免误报把 CI 变成噪音源）：
 *   - 只报**高置信**形状：固定前缀密钥、`NAME=<64hex>` 形态、裸 64 位 hex 长串。
 *   - 显式放行占位符：`<hex>`、`<...>`、`REPLACE`、`xxx`、`your_`、`example`、`占位` 等。
 *   - 报告时**脱敏**（只回显前 6 位），避免扫描器自己把密钥再打印一遍。
 *   - 扫描器自身也被扫描（不给自己开后门）；其模式字面量不含可直接命中的密钥形状。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.wrangler', '_site', '_site_geo',
  'dist', 'build', '.next', '.cache', 'coverage', '.venv', 'venv',
]);
// 明确的占位/示例信号（命中则该行不算泄漏）
const PLACEHOLDER = /(<[^>]{1,40}>|REPLACE|replace[_-]?me|your[_-]|xxx+|example|sample|dummy|placeholder|占位|替换|待填|请填|\bTODO\b)/i;
// 跳过的文件名后缀/模式（示例与模板文件天然含占位）
const SKIP_FILE = /(\.example|\.sample|\.template|\.md\.example)$/i;

const PATTERNS = [
  {
    name: 'HMAC/密钥赋值（NAME=<64 hex>）',
    // GATEWAY_SECRET / PRO_SECRET / LICENSE_API_SECRET 等以 64 位 hex 赋值
    re: /\b([A-Z][A-Z0-9_]{2,40}(?:SECRET|KEY|TOKEN|PASSWORD))\s*[:=]\s*['"]?([0-9a-fA-F]{32,})['"]?/g,
    group: 2,
    label: (m) => m[1],
  },
  {
    name: 'swarmlabs gateway key（slb_ 完整 key）',
    re: /\bslb_[A-Za-z0-9_-]{16,}\.[0-9a-f]{64}\b/g,
    group: 0,
    label: () => 'slb_ key',
  },
  {
    name: 'swarmlabs pro key（gtk_ 完整 key）',
    re: /\bgtk_[A-Za-z0-9_-]{16,}\.[0-9a-f]{64}\b/g,
    group: 0,
    label: () => 'gtk_ key',
  },
  {
    name: 'GitHub token',
    re: /\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g,
    group: 1,
    label: () => 'GitHub token',
  },
  {
    name: 'OpenAI/通用 sk- 密钥',
    re: /\b(sk-[A-Za-z0-9_-]{24,})\b/g,
    group: 1,
    label: () => 'sk- key',
  },
  {
    name: '裸 64 位 hex（疑似 HMAC secret）',
    // 要求前后不是 hex/字母数字，降低误报；且不在注释性的「指纹」语境里
    re: /(?<![\w-])([0-9a-f]{64})(?![\w-])/g,
    group: 1,
    label: () => '64-hex',
  },
];

function listTrackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function walkAll(root, base = root, acc = []) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === '.secrets') continue; // 本地密钥仓，永不入仓
      walkAll(root, path.join(base, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, path.join(base, entry.name)).replaceAll('\\', '/'));
    }
  }
  return acc;
}

const redact = (s) => (s.length <= 8 ? s.slice(0, 2) + '***' : s.slice(0, 6) + '***(' + s.length + ')');

function scanFile(abs, rel) {
  const findings = [];
  let text;
  try {
    const st = fs.statSync(abs);
    if (st.size > 4 * 1024 * 1024) return findings;   // 跳过超大文件
    text = fs.readFileSync(abs, 'utf8');
  } catch { return findings; }
  if (text.includes('\u0000')) return findings;        // 二进制

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        const raw = m[p.group] ?? m[0];
        if (!raw) continue;
        // 占位放行
        if (PLACEHOLDER.test(line)) continue;
        // 纯零/纯重复的测试值放行（如 0000..、abcd..）
        if (/^(.)\1+$/.test(raw)) continue;
        if (/^(0123456789|1234567890|abcdef)/i.test(raw) && /^(0123456789abcdef)+$/i.test(raw)) continue;
        findings.push({ file: rel, line: i + 1, kind: p.name, label: p.label(m), value: redact(raw) });
        break; // 每行每模式只报一次
      }
    }
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const all = argv.includes('--all');
  const explicit = argv.filter((a) => !a.startsWith('--'));

  const root = process.cwd();
  let files;
  if (explicit.length) {
    files = [];
    for (const target of explicit) {
      const abs = path.resolve(root, target);
      if (fs.statSync(abs).isDirectory()) files.push(...walkAll(root, abs));
      else files.push(path.relative(root, abs).replaceAll('\\', '/'));
    }
  } else if (all) {
    files = walkAll(root);
  } else {
    files = listTrackedFiles(root);
  }

  files = files.filter((f) => !SKIP_FILE.test(f));

  const findings = [];
  for (const rel of files) {
    if (rel.startsWith('.secrets/')) continue;
    findings.push(...scanFile(path.join(root, rel), rel));
  }

  if (asJson) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  } else {
    console.log(`[scan-secrets] 扫描 ${files.length} 个文件（${explicit.length ? '指定' : all ? '工作区' : 'git 跟踪'}）`);
    if (!findings.length) {
      console.log('[ok] 未发现疑似明文密钥');
    } else {
      console.log(`[FAIL] 发现 ${findings.length} 处疑似明文密钥：\n`);
      for (const f of findings) {
        console.log(`  ${f.file}:${f.line}  [${f.kind}]  ${f.label} = ${f.value}`);
      }
      console.log('\n修复：改为环境变量 / Secret / .secrets/（已 gitignore）。');
      console.log('注意：已提交过的密钥必须**轮换**——移文只是止血，历史仍可检出。');
    }
  }
  process.exit(findings.length ? 1 : 0);
}

main();
