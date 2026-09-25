#!/usr/bin/env node
/**
 * cite-checker.mjs —— 引文逐条核验器（零依赖，curl 通道）
 *
 * 借鉴 HyperResearch 的 cite-checker 机制（逐条核对引文是否原文存在、查 DOI 撤回），
 * 改造成可复用脚本，供本地模型优先栈 + 飞轮周报门禁调用。
 *
 * 能力：
 *   1. URL 存活核验 —— curl 跟随重定向，按 HTTP 分类：ok / redirect / dead(404,410) /
 *      blocked(401,403,429,451) / server-error(5xx) / error(4xx) / unreachable(网络)
 *   2. DOI 核验 —— 存活性主判据 = OpenAlex 是否有该 DOI 记录（索引有记录即 ok，
 *      查无记录 → unresolved）；撤回 = OpenAlex `is_retracted`。不走 doi.org 浏览器路径。
 *   3. 引文逐条核验（best-effort / advisory）—— 若引文所在行带「…」或 "…" 引号，取目标页正文做规范化子串匹配
 *
 * 用法：
 *   node tools/cite-checker.mjs <文件或目录>... [--strict] [--json <out.json>] [--no-claims]
 *
 * 退出码：
 *   flag 模式（默认）：恒 0，只报告；死链/撤回以 ::warning:: 形式输出
 *   --strict：存在 dead 或 retracted → 1（可作 CI 门禁）
 *
 * 设计约束：
 *   - 不引入任何 npm 依赖（curl + 原生 fs/child_process）
 *   - TLS 参数按 curl 后端探测组装：--ssl-no-revoke 仅 Windows Schannel 加，
 *     否则 GitHub Actions（Linux/OpenSSL）会 unknown option 直接退出 2 → 整个管线全灭
 *   - 分类口径刻意保守：403/401/429/451 归 blocked（出版商拦截，非死链），
 *     只有 404/410 算 dead。误杀代价高于漏报。
 *   - 网络不可达统一记 unreachable，不谎报 dead；unreachable/unresolved 不阻断门禁
 *   - 并发上限 5（CITE_CONCURRENCY），单请求 15s 超时（CITE_CURL_TIMEOUT），失败不抛栈
 */

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const UA = 'GeneTechCiteChecker/1.0 (+https://data.swarmlabs.tools; research-integrity-check)';
const CURL_TIMEOUT = Number(process.env.CITE_CURL_TIMEOUT || 15);
const CONCURRENCY = Number(process.env.CITE_CONCURRENCY || 5);
const CLAIM_LIMIT_PER_FILE = Number(process.env.CITE_CLAIM_LIMIT || 3);

/**
 * curl 能力探测（一次性）。
 * 可移植性关键：--ssl-no-revoke 是 Windows Schannel 专有选项，
 * 在 GitHub Actions（Linux / OpenSSL）上属于 unknown option，curl 会直接退出 code 2 → 整个管线全灭。
 * 因此按实际 TLS 后端动态组装参数，而非写死。
 */
const CURL_CAPS = (() => {
  try {
    const v = execFileSync('curl', ['-V'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    return { hasSchannel: /schannel/i.test(v), hasTls13: /TLSv1\.3/i.test(v) };
  } catch {
    return { hasSchannel: false, hasTls13: false };
  }
})();
const TLS_ARGS = [
  ...(CURL_CAPS.hasSchannel ? ['--ssl-no-revoke'] : []),
  ...(CURL_CAPS.hasTls13 ? ['--tlsv1.3'] : []),
];

/** 提取 markdown 中的 markdown 链接 */
const RE_MD_LINK = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)\]]+)\)/g;
/** 提取裸 URL */
const RE_BARE_URL = /https?:\/\/[^\s<>"')*\]`}]+/g;
/** 提取 DOI */
const RE_DOI = /\b10\.\d{4,9}\/[-._;()\/:?=@A-Za-z0-9]+\b/g;
/** 行内引号（中文直角引号 / 西文双引号） */
const RE_QUOTE = /「([^」]{8,400})」|"([^"]{8,400})"/g;

/**
 * curl 封装。
 * 本机有 TLS 拦截代理：必须带 --ssl-no-revoke --tlsv1.3，否则握手被重置。
 * 关键经验：不使用 `-o /dev/null`（在 Windows 上写盘失败会让 curl 报 E23 且 stdout 为空），
 * 改为正文走 stdout + 末尾拼 -w 元信息，用 MARK 分隔符切分；curl 非零退出也保留 stdout。
 */
const MARK = '\n<<<CITE_META>>>';

function runCurl(extraArgs, { maxBody = 80000 } = {}) {
  const args = [
    '-sS', '-L', '--compressed',
    ...TLS_ARGS,
    '--max-time', String(CURL_TIMEOUT),
    '--max-filesize', String(maxBody),
    '-A', UA,
    ...extraArgs,
  ];
  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 4 * 1024 * 1024, timeout: (CURL_TIMEOUT + 3) * 1000 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
        signal: err && err.signal ? err.signal : '',
        stdout: stdout === undefined ? '' : String(stdout),
        stderr: stderr === undefined ? '' : String(stderr),
      });
    });
  });
}

/**
 * HTTP 状态 → 引文健康度分类。
 * 口径说明（研究诚信场景关键，误杀代价高）：
 *   - 2xx → ok           可达
 *   - 3xx → redirect     可达（已跟随，建议更新为最终 URL）
 *   - 401/403/429/451 → blocked   出版商/反爬/限流拦截，**不等于引文失效**（如 ScienceDirect 对 bot 恒 403）
 *   - 404/410 → dead     目标不存在或永久移除，才是真正的死链
 *   - 4xx 其他 → error   客户端异常，需人工看
 *   - 5xx → server-error 上游临时故障，重试可能恢复，不判死
 */
function classifyStatus(code) {
  if (!code) return 'unreachable';
  if (code >= 200 && code < 300) return 'ok';
  if (code >= 300 && code < 400) return 'redirect';
  if (code === 401 || code === 403 || code === 429 || code === 451) return 'blocked';
  if (code === 404 || code === 410) return 'dead';
  if (code >= 400 && code < 500) return 'error';
  if (code >= 500) return 'server-error';
  return 'unreachable';
}

/** 存活探测（可选顺带取回正文用于逐条核验） */
async function probeUrl(url, { verifyContent = false } = {}) {
  const maxBody = verifyContent ? 800000 : 60000;
  const r = await runCurl(['-w', MARK + '%{http_code}\t%{url_effective}\t%{content_type}', url], { maxBody });

  let status = 'unreachable';
  let httpStatus = 0;
  let effectiveUrl = url;
  let contentType = '';
  let body = null;
  let error = '';

  const i = r.stdout.indexOf(MARK);
  if (i >= 0) {
    const meta = r.stdout.slice(i + MARK.length).trim().split('\t');
    httpStatus = parseInt(meta[0] || '0', 10) || 0;
    effectiveUrl = meta[1] || url;
    contentType = meta[2] || '';
    status = classifyStatus(httpStatus);
    if (verifyContent && status !== 'dead') body = r.stdout.slice(0, i);
  } else {
    error = (r.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 160) || (r.signal ? `timeout:${r.signal}` : `curl-exit-${r.exitCode}`);
  }

  return { status, httpStatus, effectiveUrl, contentType, error, body };
}

/** DOI → OpenAlex 查询（同时作为「该 DOI 是否真实存在」的主判据 + 撤回检测） */
async function checkRetraction(doi) {
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
  const r = await runCurl([url], { maxBody: 300000 });
  if (!r.stdout || !r.stdout.trim()) return { found: null, retracted: null, checked: false, reason: r.stderr.trim().slice(0, 80) || 'no-response' };
  try {
    const j = JSON.parse(r.stdout.trim());
    return { found: true, retracted: !!j.is_retracted, checked: true, openAlexId: j.id || '', title: j.title || '', reason: '' };
  } catch {
    return { found: null, retracted: null, checked: false, reason: 'json-parse-failed' };
  }
}

function normalizeText(s) {
  return s.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').toLowerCase().trim();
}

/** 收集一个文件的所有引文 */
function extractFromFile(filePath) {
  const text = fss.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const urls = new Set();
  const dois = new Set();
  const claims = []; // { file, url, claim }

  lines.forEach((line, i) => {
    const seen = new Set();
    const lineUrls = [];
    const pushUrl = (u) => {
      if (!u || seen.has(u)) return;
      seen.add(u);
      lineUrls.push(u);
    };
    // markdown 链接
    for (const mm of line.matchAll(RE_MD_LINK)) pushUrl(mm[2]);
    // 裸 URL（与 markdown 链接去重，避免同一 URL 产生重复 claim）
    for (const mm of line.matchAll(RE_BARE_URL)) {
      const u = mm[0].replace(/[.,;:!?)\]"}]+$/, '');
      if (u.length > 8) pushUrl(u);
    }
    // DOI
    for (const mm of line.matchAll(RE_DOI)) dois.add(mm[0].replace(/[.,;:!?)]+$/, ''));
    // 引号 → 用于逐条核验（每行只核验首个引号，避免同一句反复报告）
    // 假阳性过滤：跳过内部域名 URL、配置字段名、占位符 URL、纯中文描述短语
    if (lineUrls.length && claims.length < CLAIM_LIMIT_PER_FILE) {
      for (const mm of line.matchAll(RE_QUOTE)) {
        const q = (mm[1] || mm[2] || '').trim();
        if (q.length >= 8) {
          // 过滤 1：跳过内部域名（自己的站点不是外部引文来源）
          const INTERNAL_DOMAINS = ['lm203688.github.io', 'genetech.tools', 'swarmlabs.tools', 'roboparts.cc', 'healthlens.cc', 'aishield.tools', 'oraclemind.cc', 'genetech14-sites'];
          const isInternalUrl = lineUrls.some(u => INTERNAL_DOMAINS.some(d => u.includes(d)));
          if (isInternalUrl) break;
          // 过滤 2：跳过配置字段名/JSON key（snake_case、@context 等）
          if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(q) && q.length <= 30) break;
          // 过滤 3：跳过纯 URL（引号里包的是 URL）
          if (/^https?:\/\//.test(q)) break;
          // 过滤 4：跳过 @context / @type 等 JSON-LD schema 字段
          if (/^@[\w-]+/.test(q)) break;
          // 过滤 5：跳过中文描述短语（自述性分析，不是引用）
          // 判断依据：含中文字符 + 无标点引用标记 + 长度 > 4 → 大概率是我们的描述
          // 也覆盖中英混合短语（如「可学习、可 benchmark、可复现」），学术来源极少含中文
          const hasChinese = /[\u4e00-\u9fff]/.test(q);
          const isChineseDesc = hasChinese && q.length > 4;
          if (isChineseDesc) break;

          for (const u of lineUrls) {
            if (claims.length >= CLAIM_LIMIT_PER_FILE) break;
            // 跳过占位符 URL（Wxxxx、example.com 等）
            if (/xxxx+|<your|your[_-]|placeholder|localhost|127\.0\.0\.1|app\.com/i.test(u)) continue;
            // 跳过 schema.org 等 schema 标准页面
            if (/schema\.org$/i.test(u)) continue;
            // 跳过 export.arxiv.org/api/query 等 API 端点
            if (/export\.arxiv\.org\/api\/query/i.test(u)) continue;
            claims.push({ file: filePath, url: u, claim: q, line: i + 1 });
          }
          break;
        }
      }
    }
    for (const u of lineUrls) {
      if (!u.toLowerCase().startsWith('http://') && !u.toLowerCase().startsWith('https://')) continue;
      // 跳过文档占位符 URL（如 api.openalex.org/works/Wxxxx），避免把示例当真实引文
      if (/example\.(com|org|net)|xxxx+|<your|your[_-]|placeholder|localhost|127\.0\.0\.1/i.test(u)) continue;
      urls.add(u);
    }
  });

  return { filePath, urls: [...urls], dois: [...dois], claims };
}

async function mapConcurrent(items, worker, limit) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function checkPaths(targets, opts = {}) {
  const { strict = false, checkClaims = true, ignore = null, maxDepth = 2 } = opts;
  const files = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (ignore && ignore.test(p)) continue;
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
      files.push(p);
    }
  }

  for (const t of targets) {
    let st;
    try { st = await fs.stat(t); } catch { continue; }
    if (st.isDirectory()) await walk(t, 1);
    else { if (/\.(md|markdown|txt)$/i.test(t) && !(ignore && ignore.test(t))) files.push(t); }
  }
  files.sort();

  const allClaims = [];
  const perFile = [];
  for (const f of files) {
    const r = extractFromFile(f);
    r.claims.slice(0, CLAIM_LIMIT_PER_FILE).forEach((c) => allClaims.push(c));
    perFile.push(r);
  }

  const urlItems = [];
  const doiItems = [];
  for (const r of perFile) {
    for (const u of r.urls) urlItems.push({ file: r.filePath, kind: 'url', target: u, url: u });
    for (const d of r.dois) doiItems.push({ file: r.filePath, kind: 'doi', target: d, url: `https://doi.org/${d}` });
  }

  const urlResults = await mapConcurrent(urlItems, async (it) => {
    const p = await probeUrl(it.url);
    return { ...it, ...p };
  }, CONCURRENCY);

  const doiResults = await mapConcurrent(doiItems, async (it) => {
    // 存活性主判据 = OpenAlex 是否有该 DOI 记录（doi.org 的 HTTP 只是出版商路径，对 bot 常 403）
    const ret = await checkRetraction(it.target);
    const p = await probeUrl(it.url);
    let status;
    let reason = '';
    if (ret.retracted === true) { status = 'retracted'; reason = 'indexed-as-retracted'; }
    else if (ret.checked && ret.found) { status = 'ok'; }
    else if (ret.checked && ret.found === false) { status = 'unresolved'; reason = 'not-in-openalex-index'; }
    else {
      // 索引查询失败（网络/限流）→ 退回 HTTP 判据，但 blocked 不算 dead
      status = p.status;
      reason = ret.reason || '';
    }
    return { ...it, ...p, ...ret, status, doiReason: reason };
  }, CONCURRENCY);

  let claimResults = [];
  if (checkClaims && allClaims.length) {
    const byUrl = new Map(urlResults.map((r) => [r.url, r]));
    claimResults = await mapConcurrent(allClaims, async (c) => {
      const base = byUrl.get(c.url);
      let body = base && base.body ? base.body : null;
      if (!body) {
        // 为逐条核验单独取一次正文
        const p2 = await probeUrl(c.url, { verifyContent: true });
        body = p2.body || '';
      }
      if (!body) return { ...c, claimVerified: 'unverified', reason: 'target-body-unavailable' };
      const hay = normalizeText(body);
      const needle = normalizeText(c.claim);
      const hit = hay.includes(needle);
      return { ...c, claimVerified: hit ? 'verified' : 'mismatch', reason: hit ? '' : 'quoted-text-not-found-verbatim' };
    }, CONCURRENCY);
  }

  const items = [...urlResults, ...doiResults].map((r) => ({
    file: r.file,
    kind: r.kind,
    target: r.target,
    status: r.status,
    httpStatus: r.httpStatus || 0,
    effectiveUrl: r.effectiveUrl || '',
    contentType: r.contentType || '',
    retracted: r.retracted === null ? undefined : !!r.retracted,
    found: r.found === undefined ? undefined : r.found,
    title: r.title || '',
    checked: r.checked === undefined ? true : r.checked,
    error: r.error || '',
    reason: r.reason || r.doiReason || '',
  }));

  const count = (f) => items.filter(f).length;
  const summary = {
    filesChecked: files.length,
    totalCitations: items.length,
    ok: count((r) => r.status === 'ok'),
    redirect: count((r) => r.status === 'redirect'),
    dead: count((r) => r.status === 'dead'),
    blocked: count((r) => r.status === 'blocked'),
    unresolved: count((r) => r.status === 'unresolved'),
    serverError: count((r) => r.status === 'server-error'),
    otherError: count((r) => r.status === 'error'),
    unreachable: count((r) => r.status === 'unreachable'),
    retracted: count((r) => r.status === 'retracted'),
    claimsChecked: claimResults.length,
    claimsVerified: claimResults.filter((r) => r.claimVerified === 'verified').length,
    claimsFailed: claimResults.filter((r) => r.claimVerified === 'mismatch').length,
    claimsUnverified: claimResults.filter((r) => r.claimVerified === 'unverified').length,
  };

  return { generatedAt: new Date().toISOString(), strict, summary, items, claims: claimResults };
}

export async function main(argv) {
  const args = argv.slice(2);
  const targets = [];
  const opts = { strict: false, checkClaims: true, jsonOut: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') opts.strict = true;
    else if (a === '--no-claims') opts.checkClaims = false;
    else if (a === '--json') { opts.jsonOut = args[++i]; }
    else targets.push(a);
  }
  if (!targets.length) {
    console.error('用法: node tools/cite-checker.mjs <文件|目录>... [--strict] [--json out.json] [--no-claims]');
    return 2;
  }
  const report = await checkPaths(targets, opts);

  const S = report.summary;
  console.log(`[cite-checker] 文件 ${S.filesChecked} / 引文 ${S.totalCitations} → ok ${S.ok} · redirect ${S.redirect} · dead ${S.dead} · blocked ${S.blocked} · unresolved ${S.unresolved} · server-error ${S.serverError} · unreachable ${S.unreachable} · retracted ${S.retracted}`);
  console.log(`[cite-checker] 逐条核验 引文 ${S.claimsChecked} → verified ${S.claimsVerified} · mismatch ${S.claimsFailed} · unverified ${S.claimsUnverified}`);

  const problems = report.items.filter((r) => r.status === 'dead' || r.status === 'retracted');
  for (const p of problems) {
    console.log(`::warning:: ${p.file} :: ${p.kind} ${p.target} → ${p.status}${p.httpStatus ? ` (HTTP ${p.httpStatus})` : ''}${p.reason ? ` :: ${p.reason}` : ''}`);
  }
  for (const c of report.claims.filter((r) => r.claimVerified === 'mismatch')) {
    console.log(`::warning:: 引文逐条核验未通过 ${c.file}:${c.line} :: ${c.url} :: 「${c.claim.slice(0, 80)}」`);
  }

  if (opts.jsonOut) {
    await fs.mkdir(path.dirname(opts.jsonOut), { recursive: true });
    await fs.writeFile(opts.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[cite-checker] JSON → ${opts.jsonOut}`);
  }

  if (opts.strict && (S.dead > 0 || S.retracted > 0)) return 1;
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => { console.error(e); process.exit(2); });
}
