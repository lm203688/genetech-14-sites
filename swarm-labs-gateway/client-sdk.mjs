/**
 * SwarmLabs Data Gateway — Partner 侧客户端 SDK（供"蜂群科研数据"等项目直接引入）
 * ============================================================================
 * 用法（Node.js 18+，也可移植到浏览器/TS）：
 *
 *   import { SwarmLabsClient } from './client-sdk.mjs';
 *   const client = new SwarmLabsClient({
 *     baseUrl: 'https://swarm-labs-gateway.<account>.workers.dev',
 *     apiKey:  'slb_XXXX.YYYY',   // 用户提供的 partner key
 *   });
 *
 *   const { domains } = await client.listDomains();
 *   const { entities, total } = await client.listEntities({
 *     domain: 'robot-parts', limit: 20, q: 'imitation',
 *   });
 *   const entity = await client.getEntity('arxiv-2607.29617v1', 'robot-parts');
 *
 * 也可作为 CommonJS 引入：
 *   const { SwarmLabsClient } = require('./client-sdk.mjs');
 */

const DEFAULT_BASE = 'https://swarm-labs-gateway.<account>.workers.dev';

export class SwarmLabsClient {
  constructor({ baseUrl = DEFAULT_BASE, apiKey, timeoutMs = 15000 } = {}) {
    if (!apiKey) throw new Error('apiKey 必填（slb_ 前缀）');
    if (!apiKey.startsWith('slb_')) throw new Error('apiKey 必须以 slb_ 开头');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${body?.error || body?.message || text}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 免鉴权健康检查（可选，用于探活） */
  async health() {
    const url = new URL(this.baseUrl + '/api/v1/health');
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    return res.json();
  }

  /** 列出所有可用领域 */
  listDomains() {
    return this._fetch('/api/v1/domains');
  }

  /** 分页查询实体 */
  listEntities({ domain, limit = 50, offset = 0, q } = {}) {
    if (!domain) throw new Error('domain 必填');
    return this._fetch('/api/v1/entities', { domain, limit, offset, q });
  }

  /** 按 ID 查单实体 */
  getEntity(id, domain) {
    if (!id || !domain) throw new Error('id 和 domain 必填');
    return this._fetch(`/api/v1/entities/${encodeURIComponent(id)}`, { domain });
  }
}

// CommonJS 兼容
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SwarmLabsClient };
}

// CLI 演示模式
if (import.meta.url.endsWith(process.argv[1] || '')) {
  if (!process.argv.includes('--help')) {
    console.log('用法：node client-sdk.mjs <baseUrl> <apiKey> [domain] [limit]');
    console.log('  例：node client-sdk.mjs https://swarm-labs-gateway.XXX.workers.dev slb_XXX.YYY robot-parts 5');
    process.exit(0);
  }
}
