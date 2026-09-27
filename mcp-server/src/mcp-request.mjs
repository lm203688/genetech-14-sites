/**
 * GeneTech Data MCP — 数据需求 intake 工具集
 * ---------------------------------------------------------------------------
 * 为下游独立项目（蜂群科研数据 / RoboParts / AIShield / 付费客户）提供
 * 结构化数据需求提交与浏览接口。
 *
 * 核心工具：
 *   - submit_request: 提交数据需求（幂等，7 天同指纹去重）
 *   - retrieve_requests: 浏览 / 筛选 / 统计需求队列
 *   - healthCheck: 自检（供 intake_health 工具调用）
 *
 * 数据落点：state/data-requests.json（500KB 上限，滚动裁剪）
 * 存储格式：对象信封 { requests: [...], meta: { version, createdAt, updatedAt } }
 *   注：读侧同时兼容「裸数组」与「对象信封」两种历史格式（2026-09-27 修复）；
 *   写侧一律输出对象信封。旧实现把解析结果当数组直接 .find/.unshift，遇到信封
 *   会抛 TypeError，导致 submit_request / retrieve_requests 全链路不可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(REPO_ROOT, 'state');
const REQUESTS_FILE = path.join(STATE_DIR, 'data-requests.json');
const MAX_FILE_BYTES = 500 * 1024; // 500KB 上限
const MAX_ENTRIES = 300;

// 交付出口：GitHub Pages 静态直读，无需 Worker 端点
// （api.swarmlabs.tools 的 Worker 上游即 data.swarmlabs.tools，
//  而 data/export/<id>.json 会随 pages-deploy 发布，消费方直接拉取）
const EXPORT_BASE = (process.env.DATA_EXPORT_BASE || 'https://data.swarmlabs.tools').replace(/\/$/, '');
const EXPORT_URL = (id) => `${EXPORT_BASE}/data/export/${id}.json`;

// ---------------------------------------------------------------------------
// 读写（信封格式，兼容裸数组）
// ---------------------------------------------------------------------------

function nowISO() {
  return new Date().toISOString();
}

/** 归一化为信封格式；兼容裸数组、缺字段、损坏文件 */
function normalizeEnvelope(parsed) {
  if (Array.isArray(parsed)) {
    return { requests: parsed, meta: { version: 1, createdAt: nowISO(), updatedAt: nowISO() } };
  }
  if (parsed && typeof parsed === 'object') {
    const requests = Array.isArray(parsed.requests) ? parsed.requests : [];
    return {
      requests,
      meta: {
        version: Number(parsed.meta?.version) || 1,
        createdAt: parsed.meta?.createdAt || nowISO(),
        updatedAt: parsed.meta?.updatedAt || nowISO(),
      },
    };
  }
  return { requests: [], meta: { version: 1, createdAt: nowISO(), updatedAt: nowISO() } };
}

function readEnvelope() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
  } catch {
    // 文件缺失或损坏：fail-soft 返回空队列，不阻断提交
    return { requests: [], meta: { version: 1, createdAt: nowISO(), updatedAt: nowISO() } };
  }
  return normalizeEnvelope(parsed);
}

function writeEnvelope(env) {
  const dir = path.dirname(REQUESTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let requests = env.requests.slice(0, MAX_ENTRIES);
  let raw = JSON.stringify({ requests, meta: env.meta }, null, 2);
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) {
    // 超限则滚动裁剪，保证写入永不因体积失败
    for (const keep of [200, 100, 50, 20]) {
      requests = env.requests.slice(0, keep);
      raw = JSON.stringify({ requests, meta: env.meta }, null, 2);
      if (Buffer.byteLength(raw) <= MAX_FILE_BYTES) break;
    }
  }
  fs.writeFileSync(REQUESTS_FILE, raw, 'utf8');
}

function genRequestId() {
  // v4 UUID 风格，使用 crypto 随机数
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 版本 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `req_${hex.slice(0, 8)}_${hex.slice(8)}`;
}

function specFingerprint(spec) {
  // 用于 7 天去重的哈希
  const parts = [
    spec.domains?.join(',') || '',
    spec.keywords?.join(',') || '',
    spec.time_range?.from || '',
    spec.time_range?.to || '',
    String(spec.min_confidence ?? 0),
    String(spec.target_count ?? 0),
  ].join('|');
  return Buffer.from(parts).toString('base64').slice(0, 32);
}

// ---------------------------------------------------------------------------
// submit_request
// ---------------------------------------------------------------------------

export function submitRequest(args) {
  const {
    project_name,
    contact,
    purpose,
    priority = 'medium',
    spec,
  } = args;

  if (!project_name || !contact || !purpose || !spec) {
    return { ok: false, error: '缺少必填字段：project_name, contact, purpose, spec' };
  }

  // 规格校验
  const validPriorities = ['low', 'medium', 'high', 'urgent'];
  if (!validPriorities.includes(priority)) {
    return { ok: false, error: `priority 必须为 ${validPriorities.join('|')}` };
  }

  const env = readEnvelope();
  const reqs = env.requests;
  const fp = specFingerprint(spec);

  // 7 天内同指纹去重
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dup = reqs.find(
    (r) =>
      r._fingerprint === fp &&
      r.submitted_at >= sevenDaysAgo &&
      r.project_name === project_name
  );
  if (dup) {
    return {
      ok: false,
      error: '7 天内已有相同规格的需求',
      existing_request_id: dup.request_id,
    };
  }

  const delivery_preference = spec.delivery_preference || 'pull';
  const request_id = genRequestId();
  const entry = {
    request_id,
    submitted_at: nowISO(),
    submitted_by: contact,
    project_name,
    project_type: 'consumer', // 默认消费方
    status: 'pending_review',
    priority,
    purpose,
    spec,
    delivery_preference,
    assigned_key: null,
    fulfilled_at: null,
    fulfillment_notes: null,
    // pull 模式下交付地址可预知（Pages 静态直读），提前给出便于消费方轮询
    export_url: delivery_preference === 'pull' ? EXPORT_URL(request_id) : null,
    rejection_reason: null,
    _fingerprint: fp,
  };

  reqs.unshift(entry);
  env.meta.updatedAt = nowISO();
  writeEnvelope(env);

  return {
    ok: true,
    request_id: entry.request_id,
    status: entry.status,
    export_url: entry.export_url,
    message: entry.export_url
      ? '需求已提交，等待管理员审批。交付后将写入 export_url（pull 模式可直接拉取）。'
      : '需求已提交，等待管理员审批。',
  };
}

// ---------------------------------------------------------------------------
// retrieve_requests
// ---------------------------------------------------------------------------

export function retrieveRequests(args = {}) {
  const {
    status_filter,
    project_name,
    limit = 20,
    offset = 0,
  } = args;

  let reqs = readEnvelope().requests;

  if (status_filter) reqs = reqs.filter((r) => r.status === status_filter);
  if (project_name) reqs = reqs.filter((r) => r.project_name === project_name);

  const total = reqs.length;
  const page = reqs.slice(offset, offset + limit);
  const safe = page.map(({ _fingerprint, ...rest }) => rest);

  // 统计摘要
  const byStatus = {};
  const byPriority = {};
  const byProject = {};
  for (const r of reqs) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
    byProject[r.project_name] = (byProject[r.project_name] || 0) + 1;
  }

  return {
    ok: true,
    total,
    returned: safe.length,
    offset,
    limit,
    summary: { byStatus, byPriority, byProject },
    requests: safe,
  };
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function healthCheck() {
  try {
    const env = readEnvelope();
    const raw = JSON.stringify(env);
    return {
      ok: true,
      file: REQUESTS_FILE,
      sizeBytes: Buffer.byteLength(raw),
      count: env.requests.length,
      maxBytes: MAX_FILE_BYTES,
      maxEntries: MAX_ENTRIES,
      schema: 'envelope',
      exportBase: EXPORT_BASE,
      meta: env.meta,
    };
  } catch (e) {
    return { ok: false, file: REQUESTS_FILE, error: e.message };
  }
}
