/**
 * GeneTech Knowledge Engine — TypeScript SDK
 *
 * 零依赖，只用 Node 18+ 的全局 fetch 与 fs。不用 axios/undici，
 * 因为这个 SDK 的定位是"数据层的最小接入面"，不是通用 HTTP 客户端。
 *
 * ```ts
 * import { GeneTech } from './gentech';
 *
 * const g = new GeneTech({ apiKey: 'gt_xxx' });
 * await g.health();
 * for (const e of g.iterSamplePack()) { /* ... *\/ }
 * ```
 *
 * 构建：见 consumer-sdk/typescript/package.json。
 *
 * 设计原则（与 Python 版一致）
 *   1. 零依赖 —— 可以被拷进任何项目而不引发依赖冲突
 *   2. 不静默降级 —— 需要 key 的端点在没配 key 时抛 KeyRequired，不返回空结果
 *   3. 样本包可离线用 —— 不需要 key、不需要联网
 */

export const VERSION = '1.0.0';
export const DEFAULT_BASE_URL = 'https://api.swarmlabs.tools';
export const USER_AGENT = `gentech-typescript-sdk/${VERSION}`;

export interface InitOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 覆盖默认的 GENETECH_API_KEY 环境变量名 */
  apiKeyEnv?: string;
}

export interface SemanticSearchOptions {
  query: string;
  topK?: number;
  sites?: string[];
  /** sites 的单值便捷写法；两者都给时 sites 优先 */
  site?: string;
}

/** SDK 基类异常 */
export class GeneTechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneTechError';
  }
}

/** HTTP 4xx/5xx 或非 JSON 响应 */
export class ApiError extends GeneTechError {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly endpoint: string,
  ) {
    super(`${endpoint} -> HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'ApiError';
  }
}

/** 401：端点需要 key。注意这不是故障，是设计如此。 */
export class KeyRequired extends GeneTechError {
  constructor(
    public readonly endpoint: string,
    public readonly detail: string,
  ) {
    super(`401 on ${endpoint}: ${detail}`);
    this.name = 'KeyRequired';
  }
}

/**
 * 样本包记录。字段含义见 consumer-sdk/docs/DATA-DICTIONARY.md。
 *
 * 注意：API 记录里没有 `site` / `abstract_chars` / `abstract_truncated`
 * 三个字段，它们只出现在样本包里。
 */
export interface Entity {
  id: string;
  name?: string;
  source?: string;
  abstract?: string | null;
  url?: string;
  authors?: string | string[] | null;
  tags?: string[] | null;
  confidence?: number;
  sites?: string[];
  publishedDate?: string | null;
  addedAt?: string;
  quality_tier?: string;
  tagSource?: string | null;
  tagConfidence?: number | null;
  tagGap12?: boolean | null;
  /** 仅样本包 */
  site?: string;
  /** 仅样本包，截断前的摘要长度 */
  abstract_chars?: number;
  /** 仅样本包 */
  abstract_truncated?: boolean;
  [k: string]: unknown;
}

export interface DomainsResponse {
  generatedAt: string;
  totalSites: number;
  totalEntities: number;
  sites: Array<{
    site: string;
    label: string;
    totalEntities: number;
    lastUpdated: string;
    index: string;
    entities: string;
  }>;
}

export class GeneTech {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: InitOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? process.env[opts.apiKeyEnv ?? 'GENETECH_API_KEY'];
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ---------------------------------------------------------------- 公开端点
  /** GET /health */
  health(): Promise<Record<string, unknown>> {
    return this.get('/health');
  }

  /**
   * GET /v1/domains —— 30 域总量、lastUpdated 与相对路径。
   *
   * sites[] 里给的是 GitHub Pages **相对路径**，不是自定义域名。
   * 30 个站点子域从未配置 DNS。
   */
  domains(): Promise<DomainsResponse> {
    return this.get('/v1/domains');
  }

  /** GET /v1/oss/registry */
  registry(): Promise<unknown[]> {
    return this.get('/v1/oss/registry');
  }

  /** GET /v1/citation/edges —— 跨域引用边（28,001 条，约 2.4 MB） */
  citationEdges(): Promise<Record<string, unknown>> {
    return this.get('/v1/citation/edges');
  }

  /** GET /v1/citation/gaps —— 零引用域缺口矩阵 */
  citationGaps(): Promise<Record<string, unknown>> {
    return this.get('/v1/citation/gaps');
  }

  /** GET /v1/entities 或 /v1/entities/<site> */
  entities(site?: string): Promise<Record<string, unknown>> {
    return this.get('/v1/entities' + (site ? `/${site}` : ''));
  }

  // ---------------------------------------------------------------- 需 key
  /**
   * POST /v1/search/semantic。需要 API key。
   *
   * 未配置 key 时抛 KeyRequired（401 是设计如此，不是服务故障）。
   */
  searchSemantic(opts: SemanticSearchOptions): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { query: opts.query, topK: opts.topK ?? 10 };
    if (opts.sites) body.sites = opts.sites;
    else if (opts.site) body.sites = [opts.site];
    return this.post('/v1/search/semantic', body);
  }

  // ---------------------------------------------------------------- 本地样本包
  /** 样本包默认位置：consumer-sdk/samples/sample-10k.jsonl */
  static samplePackPath(baseDir: string = __dirname): string {
    return `${baseDir}/../samples/sample-10k.jsonl`.replace(/\\/g, '/');
  }

  /**
   * 一次性载入本地样本包。不需要 key、不需要联网。
   * 用同步 readFileSync，因为 JSONL 才 ~8 MB，同步读最简单也最快。
   */
  loadSamplePack(path?: string): Entity[] {
    const p = path ?? GeneTech.samplePackPath();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entity);
  }

  /** 逐行流式迭代本地样本包（大文件时不占内存）。 */
  *iterSamplePack(path?: string): Generator<Entity> {
    const p = path ?? GeneTech.samplePackPath();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      let leftover = '';
      let bytesRead: number;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        leftover += buf.toString('utf8', 0, bytesRead);
        let nl: number;
        while ((nl = leftover.indexOf('\n')) >= 0) {
          const line = leftover.slice(0, nl).trim();
          if (line) yield JSON.parse(line) as Entity;
          leftover = leftover.slice(nl + 1);
        }
      }
      if (leftover.trim()) yield JSON.parse(leftover.trim()) as Entity;
    } finally {
      const fs = require('node:fs') as typeof import('node:fs');
      fs.closeSync(fd);
    }
  }

  // ---------------------------------------------------------------- 归因
  /**
   * 生成一条符合归因规范的数据源声明。
   * 规范见 docs/attribution.md。
   */
  static attributionNote(retrievedOn?: string): string {
    const when = retrievedOn ?? 'unknown date';
    return (
      `Data source: GeneTech Knowledge Engine (${DEFAULT_BASE_URL}), retrieved ${when}. ` +
      'Original upstream: see the `source` field of each record ' +
      '(crossref | openalex | europepmc | pubmed | datacite | arxiv | preprints | semanticscholar).'
    );
  }

  // ---------------------------------------------------------------- HTTP
  private headers(requireKey: boolean): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    else if (requireKey) throw new KeyRequired('request', 'GENETECH_API_KEY not set');
    return h;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        headers: this.headers(init.body !== undefined),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 401) throw new KeyRequired(path, text.slice(0, 300));
        throw new ApiError(res.status, text, path);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError(res.status, text.slice(0, 200), path);
      }
    } catch (e) {
      if (e instanceof GeneTechError) throw e;
      throw new GeneTechError(`${path} -> ${String(e)}`);
    } finally {
      clearTimeout(t);
    }
  }

  private get(path: string, requireKey = false): Promise<unknown> {
    return this.request(path, { method: 'GET' }).then(() => {
      // requireKey 的语义：无 key 时也要报错，而不是让 401 走到 ApiError 分支
      if (requireKey && !this.apiKey) throw new KeyRequired(path, 'GENETECH_API_KEY not set');
      return this.request(path, { method: 'GET' });
    });
  }

  private post(path: string, payload: Record<string, unknown>, requireKey = false): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { ...this.headers(requireKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
