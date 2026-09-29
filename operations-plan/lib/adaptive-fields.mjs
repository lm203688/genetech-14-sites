/**
 * adaptive-fields.mjs — 自适应字段解析（借鉴 Scrapling 的 Adaptive Parsing）
 *
 * 设计来源
 *   Scrapling（D4Vinci，2025）的核心能力 Adaptive Scraping：不记死 CSS 选择器，
 *   而是给元素记录多维特征指纹（文本内容、属性值、DOM 位置、相邻关系、样式），
 *   页面改版后用相似度算法在所有候选中匹配最像原始目标的那一个。
 *   官方表述：「你的解析代码有了免疫力，换 class、调层级，小改版基本不受影响」。
 *
 * 移植到本项目（JSON API 生态）
 *   Web 爬虫面对的漂移是 HTML 结构；学术 API 面对的漂移是 **JSON schema**。
 *   OpenAlex / Crossref / arXiv / EuropePMC / PubMed 的字段名与嵌套层级会变。
 *   因此本模块把"元素指纹 + 相似度匹配"翻译成：
 *     候选路径列表 + 形状校验 + 实测命中率指纹 + 漂移事件上报
 *   即：不硬编码 e.abstract，而是一组候选路径按优先级降级，并观测谁在真实贡献。
 *
 * 本项目为何急需（2026-09-29 实测）
 *   30 站 300,000 实体中 32.6%（97,881 条）摘要缺失或不足 80 字。
 *   其中相当一部分是"字段名不统一"造成的假缺失：PubMed esummary 把摘要放在
 *   abstract_inverted_index（词→位置倒排），EuropePMC 用 resultAbstract，
 *   Crossref 用 JATS 标签包裹的 abstract，OpenAlex 用 abstract_inverted_index。
 *   硬编码单一字段名会把这部分永久判死。
 *
 * 硬约束
 *   - 纯函数、无副作用、不读不写文件系统
 *   - 无 process.exit、无顶层 main()
 */

// ============================================================
// 字段方案：每个逻辑字段的候选路径 + 形状校验
// 路径语法：'a.b.c'（点分隔）| 'a[0]'（数组下标）| 'a.*.b'（数组通配，取第一个非空）
// ============================================================
const FIELD_SCHEMAS = {
  abstract: {
    priority: [
      'abstract',
      'abstractText',
      'summary',
      'description',
      'abstracts',
      'resultAbstract',
      'abstract_inverted_index',        // OpenAlex / PubMed esummary 倒排格式
      'journal_issue.abstract',
      'message.abstract',
      'results.abstract',
    ],
    // 合格摘要的最低字符数（低于此值视为缺失，而非空字符串）
    minLength: 80,
    kind: 'text',
  },
  title: {
    priority: ['title', 'name', 'headline', 'full_title', 'paper.title', 'message.title', 'bestMatch.title'],
    minLength: 8,
    kind: 'text',
  },
  authors: {
    priority: ['authors', 'authorships', 'creator', 'creators', 'author_list.author', 'message.author', 'item.authors'],
    kind: 'array',
  },
  date: {
    priority: ['publishedDate', 'date', 'publication_date', 'created', 'updated', 'published-print', 'year', 'doi_content.published-print', 'published', 'bestMatch.published'],
    kind: 'date',
  },
  doi: {
    priority: ['doi', 'DOI', 'doi_id', 'bestMatch.doi', 'message.doi', 'resource.identifier'],
    kind: 'text',
  },
  source: {
    priority: ['source', 'providerName', 'source_type', 'publisher', 'institution'],
    kind: 'text',
  },
  url: {
    priority: ['url', 'landingPage', 'link', 'id', 'bestMatch.link', 'url_for_pdf'],
    kind: 'text',
  },
};

// ============================================================
// 解析原语
// ============================================================

/** 按路径取值；支持点分隔、数组下标 a[0]、数组通配 a.*.b */
export function getByPath(obj, p) {
  if (obj == null || typeof p !== 'string') return undefined;
  const segs = p.split('.').flatMap(s => {
    const m = s.match(/^(.*?)\[?(\d*)\]?(?:\*)?$/);
    return [m[1], m[2], /\*\]$/.test(s)];
  });
  let cur = obj;
  for (let i = 0; i < segs.length; i += 3) {
    const key = segs[i];
    const idx = segs[i + 1];
    const wildcard = segs[i + 2];
    if (cur == null) return undefined;
    if (idx) cur = Array.isArray(cur) ? cur[Number(idx)] : cur[idx];
    if (cur == null) return undefined;
    cur = cur[key];
    if (cur == null) return undefined;
    if (wildcard && Array.isArray(cur)) {
      cur = cur.find(v => v != null);
      if (cur == null) continue;
    }
  }
  return cur;
}

/** 把 OpenAlex / PubMed 的倒排摘要（词→位置数组）还原成正文 */
export function fromInvertedIndex(inv) {
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return '';
  const tokens = Object.keys(inv).map((word, i) => ({ word, pos: Array.isArray(inv[word]) ? inv[word][0] : i }));
  if (!tokens.length) return '';
  tokens.sort((a, b) => a.pos - b.pos);
  return tokens.map(t => t.word).join(' ');
}

/** 把各种"摘要容器"归一为纯文本字符串 */
function normalizeToText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(normalizeToText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    // 倒排摘要
    if (Object.keys(v).some(k => Array.isArray(v[k]) && v[k].length && typeof v[k][0] === 'number')) {
      return fromInvertedIndex(v);
    }
    // PubMed esummary: { abstract: [...segments] }
    if (Array.isArray(v.abstract)) return v.abstract.map(s => String(s)).join(' ');
    if (typeof v.text === 'string') return v.text.trim();
    if (typeof v.title === 'string') return v.title.trim();
  }
  return '';
}

/** 剥掉 JATS / HTML 标签（Crossref 常见） */
function stripMarkup(s) {
  if (!s) return '';
  return String(s)
    .replace(/<jats:[^>]*>/g, '')
    .replace(/<\/?jats:[^>]*>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// 主解析器
// ============================================================

/**
 * 自适应取字段
 * @param {object} entity 原始实体
 * @param {string} field FIELD_SCHEMAS 中的逻辑字段名
 * @returns {{value: any, path: string|null, fallbackUsed: number, drift: boolean|null}}
 *   fallbackUsed : 命中第几个候选（0=首选，越大说明 schema 漂移越深）
 *   drift        : true=本条实体的首选路径缺失（schema 疑似漂移）；false=首选命中
 */
export function resolveField(entity, field) {
  const schema = FIELD_SCHEMAS[field];
  if (!schema) return { value: undefined, path: null, fallbackUsed: -1, drift: null };
  const priority = schema.priority || [];
  for (let i = 0; i < priority.length; i++) {
    const raw = getByPath(entity, priority[i]);
    if (raw == null || raw === '') continue;
    let value;
    if (schema.kind === 'text') value = stripMarkup(normalizeToText(raw));
    else if (schema.kind === 'date') value = normalizeToText(raw).slice(0, 10);
    else value = raw;
    if (schema.kind === 'text' && typeof schema.minLength === 'number') {
      if (value.length < schema.minLength) continue;   // 过短视为缺失，继续降级
    }
    if (schema.kind === 'array' && !Array.isArray(value) && !Array.isArray(raw)) continue;
    if (schema.kind === 'array') {
      value = Array.isArray(raw) ? raw : [raw];
    }
    return { value, path: priority[i], fallbackUsed: i, drift: i > 0 };
  }
  return { value: undefined, path: null, fallbackUsed: -1, drift: priority.length > 0 };
}

/** 批量解析多个字段 */
export function resolveEntity(entity, fields) {
  const out = {};
  for (const f of fields) out[f] = resolveField(entity, f);
  return out;
}

// ============================================================
// 漂移指纹与上报（Scrapling 的"元素指纹"对应物）
// ============================================================

/**
 * 统计字段漂移指纹
 * @param {Array} entities
 * @param {string} field
 * @returns {object} 各候选路径的实测贡献率 + 漂移率
 */
export function fieldFingerprint(entities, field) {
  const hits = new Map();
  let n = 0, resolved = 0, drifted = 0;
  for (const e of entities) {
    n++;
    const r = resolveField(e, field);
    if (r.path != null) {
      resolved++;
      hits.set(r.path, (hits.get(r.path) || 0) + 1);
      if (r.drift) drifted++;
    }
  }
  const schema = FIELD_SCHEMAS[field] || { priority: [] };
  return {
    field,
    total: n,
    resolved: n ? resolved : 0,
    resolvedRate: n ? +(resolved / n).toFixed(4) : 0,
    driftRate: n ? +(drifted / n).toFixed(4) : 0,
    coverageLoss: n ? +(1 - resolved / n).toFixed(4) : 0,
    // 各候选路径的贡献排名（0 位是首选）
    hitDistribution: schema.priority.map((p, i) => ({
      path: p,
      priority: i,
      hits: hits.get(p) || 0,
      share: n ? +((hits.get(p) || 0) / n).toFixed(4) : 0,
    })),
    // 首选路径失效 = schema 漂移的强信号
    schemaDriftDetected: schema.priority[0] && (hits.get(schema.priority[0]) || 0) < (n / 2),
  };
}

/**
 * 汇总所有字段的漂移事件（供日报 / 自愈告警消费）
 * @returns {Array} 只列出 driftRate > 0 的字段
 */
export function driftReport(entities) {
  const events = [];
  for (const field of Object.keys(FIELD_SCHEMAS)) {
    const fp = fieldFingerprint(entities, field);
    if (fp.driftRate > 0 || fp.resolvedRate < 0.9) {
      events.push({
        field,
        severity: fp.driftRate > 0.3 ? 'high' : fp.resolvedRate < 0.9 ? 'medium' : 'low',
        driftRate: fp.driftRate,
        resolvedRate: fp.resolvedRate,
        coverageLoss: fp.coverageLoss,
        topFallback: fp.hitDistribution.filter(h => h.hits > 0).sort((a, b) => b.hits - a.hits)[0] || null,
        schemaDriftDetected: fp.schemaDriftDetected,
      });
    }
  }
  return events.sort((a, b) => b.driftRate - a.driftRate);
}

// ============================================================
// 自检（只在直接运行时执行；被 import 时绝不调用）
// ============================================================
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  const { fileURLToPath } = await import('url');
  const _p = (await import('path')).default;
  if (_p.resolve(process.argv[1]) === _p.resolve(fileURLToPath(import.meta.url))) {
    const demo = [
      // OpenAlex 风格：倒排摘要
      { id: 'o1', title: 'A paper', doi: '10.1000/o1', abstract_inverted_index: { Quantum: [0], computing: [1], will: [2], transform: [3], everything: [4], 'in detail here with sufficient length to pass the minimum threshold': [5, 6, 7, 8, 9, 10, 11, 12] } },
      // EuropePMC 风格
      { id: 'e1', title: 'Clinical trial', resultAbstract: 'A randomized controlled trial assessing outcomes in hospital settings with sufficient descriptive text to be considered a real abstract.', publishedDate: '2023-05-01', doi: '10.1000/e1' },
      // Crossref 风格：JATS 标签包裹
      { id: 'c1', title: 'Materials study', abstract: '<jats:p>Perovskite solar cells achieve record efficiency in laboratory conditions with reproducible results and stable operation over extended periods of testing.</jats:p>', date: '2024-01-15', doi: '10.1000/c1' },
      // 真缺失
      { id: 'm1', title: 'No abstract here', abstract: 'too short', year: 2020 },
    ];
    for (const d of demo) {
      const r = resolveField(d, 'abstract');
      console.log(`${d.id}: 命中路径=${r.path ?? '无'} fallback=${r.fallbackUsed} drift=${r.drift}`);
      console.log(`     → ${r.value ? r.value.slice(0, 70) + '…' : '(缺失)'}`);
    }
    console.log('\n漂移指纹（abstract）:');
    console.log(JSON.stringify(fieldFingerprint(demo, 'abstract'), null, 2));
  }
}
