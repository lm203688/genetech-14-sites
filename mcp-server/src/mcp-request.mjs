/**
 * GeneTech Data MCP — 数据需求 intake 工具集
 * ---------------------------------------------------------------------------
 * 为下游独立项目（蜂群科研数据 / RoboParts / AIShield / 付费客户）提供
 * 结构化数据需求提交与浏览接口。
 *
 * 核心工具：
 *   - submit_request: 提交数据需求（幂等，自动去重）
 *   - retrieve_requests: 浏览 / 筛选 / 统计需求队列
 *
 * 数据落点：state/data-requests.json（最大 500KB，滚动裁剪）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(REPO_ROOT, 'state');
const REQUESTS_FILE = path.join(STATE_DIR, 'data-requests.json');
const MAX_FILE_BYTES = 500 * 1024; // 500KB 上限

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function readRequests() {
  try {
    const raw = fs.readFileSync(REQUESTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeRequests(reqs) {
  const clamped = reqs.slice(0, 300); // 保留最近 300 条，防止超大
  const raw = JSON.stringify(clamped, null, 2);
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) {
    // 超限时保留最新的足够多的条目使其 ≤ MAX_FILE_BYTES
    let trimmed = reqs.slice(0, 200);
    const t = JSON.stringify(trimmed, null, 2);
    if (Buffer.byteLength(t) > MAX_FILE_BYTES) {
      trimmed = reqs.slice(0, 100);
    }
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } else {
    fs.writeFileSync(REQUESTS_FILE, raw, 'utf8');
  }
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
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
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

function nowISO() {
  return new Date().toISOString();
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
    return {
      ok: false,
      error: '缺少必填字段：project_name, contact, purpose, spec',
    };
  }

  // 规格校验
  const validPriorities = ['low', 'medium', 'high', 'urgent'];
  if (!validPriorities.includes(priority)) {
    return { ok: false, error: `priority 必须为 ${validPriorities.join('|')}` };
  }

  const fp = specFingerprint(spec);
  const reqs = readRequests();

  // 7 天内同指纹去重
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dup = reqs.find(r =>
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

  const entry = {
    request_id: genRequestId(),
    submitted_at: nowISO(),
    submitted_by: contact,
    project_name,
    project_type: 'consumer', // 默认消费方
    status: 'pending_review',
    priority,
    purpose,
    spec,
    delivery_preference: spec.delivery_preference || 'pull',
    assigned_key: null,
    fulfilled_at: null,
    fulfillment_notes: null,
    export_url: null,
    rejection_reason: null,
    _fingerprint: fp,
  };

  reqs.unshift(entry);
  writeRequests(reqs);

  return {
    ok: true,
    request_id: entry.request_id,
    status: entry.status,
    message: '需求已提交，等待管理员审批',
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

  let reqs = readRequests();

  if (status_filter) {
    reqs = reqs.filter(r => r.status === status_filter);
  }
  if (project_name) {
    reqs = reqs.filter(r => r.project_name === project_name);
  }

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
    const reqs = readRequests();
    return {
      ok: true,
      file: REQUESTS_FILE,
      sizeBytes: Buffer.byteLength(JSON.stringify(reqs)),
      count: reqs.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
