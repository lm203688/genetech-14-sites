/**
 * 结构化层 —— 从扁平实体数组派生多维结构化资产。
 *
 * 设计原则：
 *  1. 全部在构建期计算，不落仓库 → 零仓库膨胀、永远与源数据同步。
 *  2. 只依赖数据契约里已有的字段（id/name/source/abstract/url/authors/tags/publishedDate/sites），
 *     不引入外部依赖，CI 可直接跑。
 *  3. 产出既有「机器可读」(JSON/JSONL/CSV/BibTeX/CSL-JSON) 也有「可索引」(主题聚合页数据)。
 */

// ---------------------------------------------------------------- 词表 / 常量

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'to', 'with', 'by', 'from',
  'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'via', 'using', 'used', 'use',
  'new', 'novel', 'based', 'study', 'studies', 'analysis', 'approach', 'method', 'methods',
  'result', 'results', 'paper', 'article', 'review', 'research', 'we', 'our', 'this', 'that',
  'these', 'those', 'its', 'it', 'can', 'may', 'not', 'no', 'more', 'most', 'other', 'such',
  'science', 'sciences', 'scientific', 'journal', 'letter', 'letters', 'proceedings',
  'medicine', 'biology', 'chemistry', 'engineering', 'technology', 'materials science',
  'computer science', 'physics', 'mathematics', 'business', 'political science', 'philosophy',
  'psychology', 'sociology', 'economics', 'geology', 'geography', 'history', 'art', 'law',
  'environmental science',
]);

/**
 * arXiv 分类代码 → 可读主题名。
 * 原始 tags 里大量是 `cs.ai` / `quant-ph` 这类机器码，直接做主题页对搜索引擎与人类都无价值，
 * 统一翻译成自然语言主题后再参与聚合（未收录的代码会被 isArxivCode 拦下，不进主题榜）。
 */
const ARXIV_CATEGORIES = {
  'cs.ai': 'artificial intelligence', 'cs.lg': 'machine learning', 'cs.cl': 'computational linguistics',
  'cs.cv': 'computer vision', 'cs.ro': 'robotics', 'cs.ne': 'neural and evolutionary computing',
  'cs.cr': 'cryptography and security', 'cs.dc': 'distributed computing', 'cs.se': 'software engineering',
  'cs.ir': 'information retrieval', 'cs.hc': 'human-computer interaction', 'cs.sy': 'systems and control',
  'cs.ma': 'multi-agent systems', 'cs.db': 'databases', 'cs.gt': 'game theory', 'cs.it': 'information theory',
  'cs.cy': 'computers and society', 'cs.sd': 'sound processing', 'cs.ar': 'hardware architecture',
  'cs.pl': 'programming languages', 'cs.ds': 'data structures and algorithms', 'cs.ni': 'computer networks',
  'cs.et': 'emerging technologies', 'cs.gr': 'computer graphics', 'cs.mm': 'multimedia',
  'eess.sy': 'systems and control', 'eess.iv': 'image and video processing', 'eess.sp': 'signal processing',
  'eess.as': 'audio and speech processing',
  'quant-ph': 'quantum physics',
  'cond-mat.mtrl-sci': 'materials physics', 'cond-mat.mes-hall': 'mesoscale and nanoscale physics',
  'cond-mat.supr-con': 'superconductivity', 'cond-mat.str-el': 'strongly correlated electrons',
  'cond-mat.soft': 'soft condensed matter', 'cond-mat.stat-mech': 'statistical mechanics',
  'cond-mat.quant-gas': 'quantum gases', 'cond-mat.dis-nn': 'disordered systems and neural networks',
  'cond-mat.other': 'condensed matter physics',
  'astro-ph.ep': 'earth and planetary astrophysics', 'astro-ph.im': 'astrophysics instrumentation',
  'astro-ph.ga': 'galaxy astrophysics', 'astro-ph.sr': 'solar and stellar astrophysics',
  'astro-ph.co': 'cosmology', 'astro-ph.he': 'high energy astrophysics',
  'physics.optics': 'optics', 'physics.app-ph': 'applied physics', 'physics.plasm-ph': 'plasma physics',
  'physics.bio-ph': 'biological physics', 'physics.chem-ph': 'chemical physics',
  'physics.comp-ph': 'computational physics', 'physics.ins-det': 'instrumentation and detectors',
  'physics.med-ph': 'medical physics', 'physics.flu-dyn': 'fluid dynamics', 'physics.atom-ph': 'atomic physics',
  'physics.acc-ph': 'accelerator physics', 'physics.geo-ph': 'geophysics', 'physics.space-ph': 'space physics',
  'physics.soc-ph': 'physics and society', 'physics.data-an': 'data analysis',
  'q-bio.nc': 'neurons and cognition', 'q-bio.bm': 'biomolecules', 'q-bio.gn': 'genomics',
  'q-bio.qm': 'quantitative biology methods', 'q-bio.pe': 'populations and evolution',
  'q-bio.mn': 'molecular networks', 'q-bio.cb': 'cell behavior', 'q-bio.to': 'tissues and organs',
  'stat.ml': 'statistical machine learning', 'stat.me': 'statistical methodology',
  'stat.ap': 'applied statistics', 'stat.co': 'computational statistics',
  'math.oc': 'optimization and control', 'math.na': 'numerical analysis', 'math.pr': 'probability theory',
  'math.st': 'statistics theory', 'math.ds': 'dynamical systems', 'math.co': 'combinatorics',
  'math-ph': 'mathematical physics',
  'hep-th': 'high energy physics theory', 'hep-ph': 'particle physics phenomenology',
  'hep-ex': 'high energy physics experiment', 'hep-lat': 'lattice field theory',
  'nucl-th': 'nuclear theory', 'nucl-ex': 'nuclear experiment',
  'gr-qc': 'general relativity and quantum cosmology',
  'nlin.ao': 'adaptation and self-organizing systems', 'nlin.cd': 'chaotic dynamics',
  'nlin.ps': 'pattern formation', 'nlin.si': 'integrable systems',
  'econ.em': 'econometrics', 'q-fin.st': 'statistical finance',
};

/** 未收录到 ARXIV_CATEGORIES 的机器码（形如 xx.yy / abc-de），不应进入主题榜 */
const ARXIV_PREFIXES = /^(cs|math|physics|astro-ph|cond-mat|quant-ph|hep-th|hep-ph|hep-ex|hep-lat|nucl-th|nucl-ex|gr-qc|q-bio|q-fin|stat|eess|econ|nlin|math-ph)([.-]|$)/;

function isArxivCode(s) {
  return ARXIV_PREFIXES.test(s) && /^[a-z-]+(\.[a-z-]+)?$/.test(s);
}

/** 明显是学科大类而非可检索主题的 OpenAlex 概念，做降权（不删，仅不进主题页） */
const BROAD_CONCEPTS = new Set([
  'computer science', 'physics', 'biology', 'chemistry', 'medicine', 'mathematics',
  'engineering', 'materials science', 'psychology', 'business', 'economics',
  'political science', 'sociology', 'philosophy', 'geology', 'geography', 'history',
  'environmental science', 'art', 'law',
]);

const PREPRINT_HOSTS = /arxiv|biorxiv|medrxiv|chemrxiv|preprint|ssrn/i;

// ---------------------------------------------------------------- 归一化工具

export function normTopic(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}\s./+#-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  if (s.length < 3 || s.length > 48) return null;
  if (!/\p{L}/u.test(s)) return null;
  // 纯数字/年份类
  if (/^\d+$/.test(s)) return null;

  // arXiv 机器码：能翻译的转成可读主题，翻译不了的直接丢弃（否则主题榜会被代码占满）
  if (ARXIV_CATEGORIES[s]) s = ARXIV_CATEGORIES[s];
  else if (isArxivCode(s)) return null;

  if (STOPWORDS.has(s)) return null;
  return s;
}

export function topicSlug(topic) {
  return String(topic)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** "Cao, Y" / "Emanuel Knill" / "Aspuru-Guzik, A" → { key, display } */
export function normalizeAuthor(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 2 || s.length > 80) return null;
  if (/\d/.test(s)) return null;
  if (/^(et al|the|and|group|consortium|collaboration)$/i.test(s)) return null;

  let last;
  let rest;
  if (s.includes(',')) {
    const parts = s.split(',');
    last = parts[0].trim();
    rest = parts.slice(1).join(' ').trim();
  } else {
    const parts = s.split(' ').filter(Boolean);
    if (parts.length === 1) {
      last = parts[0];
      rest = '';
    } else {
      last = parts[parts.length - 1];
      rest = parts.slice(0, -1).join(' ');
    }
  }
  last = last.replace(/[^\p{L}'\-\s]/gu, '').trim();
  if (last.length < 2) return null;

  const givenTokens = rest.split(/[\s.\-]+/).filter(Boolean).filter((w) => /\p{L}/u.test(w[0]));
  const initials = givenTokens.map((w) => w[0]).join('').toUpperCase().slice(0, 4);

  const lastDisplay = last
    .split(/([\s-])/)
    .map((p) => (/\p{L}/u.test(p) ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join('');

  // 主键优先用「完整名」而非首字母：
  // 只按首字母归并会把 Wang Yong / Wang Yan / Wang Yu 全并成 "Wang, Y"，
  // 造成头部作者统计严重虚高。宁可欠合并（同一人拆成两条）也不过度合并。
  const firstGiven = givenTokens[0] || '';
  const useFull = firstGiven.length >= 2;
  const givenDisplay = useFull
    ? firstGiven[0].toUpperCase() + firstGiven.slice(1).toLowerCase()
    : initials;

  return {
    key: `${last.toLowerCase()}|${(useFull ? firstGiven : initials).toLowerCase()}`,
    display: givenDisplay ? `${lastDisplay}, ${givenDisplay}` : lastDisplay,
  };
}

export function extractYear(e) {
  const m = String(e.publishedDate || e.addedAt || '').match(/(19|20)\d{2}/);
  const y = m ? parseInt(m[0], 10) : null;
  if (!y || y < 1900 || y > new Date().getFullYear() + 1) return null;
  return y;
}

export function extractDoi(e) {
  const m = String(e.url || '').match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

/** 实体类型：preprint / dataset / article */
export function entityType(e) {
  const u = String(e.url || '');
  const src = String(e.source || '').toLowerCase();
  if (src === 'arxiv' || PREPRINT_HOSTS.test(u)) return 'preprint';
  if (/datacite|zenodo|figshare|dryad|dataset/i.test(u) || src === 'datacite') return 'dataset';
  return 'article';
}

/**
 * 质量分 0-100：用于排序、导出择优、主题页选摘。
 * 维度：摘要完整度、作者完整度、可溯源(DOI)、时效性、跨站共现、原始置信度。
 */
export function qualityScore(e) {
  let s = 0;
  const abs = String(e.abstract || '');
  if (abs.length > 600) s += 30;
  else if (abs.length > 250) s += 22;
  else if (abs.length > 80) s += 12;

  const au = Array.isArray(e.authors) ? e.authors.length : 0;
  if (au >= 3) s += 15;
  else if (au >= 1) s += 9;

  if (extractDoi(e)) s += 18;

  const y = extractYear(e);
  if (y) {
    const age = new Date().getFullYear() - y;
    if (age <= 1) s += 15;
    else if (age <= 3) s += 11;
    else if (age <= 6) s += 6;
    else s += 2;
  }

  const tags = Array.isArray(e.tags) ? e.tags.length : 0;
  if (tags >= 4) s += 10;
  else if (tags >= 1) s += 5;

  const sites = Array.isArray(e.sites) ? e.sites.length : 1;
  if (sites > 1) s += Math.min(8, (sites - 1) * 4);

  const conf = Number(e.confidence);
  if (Number.isFinite(conf)) s += Math.round(Math.max(0, Math.min(1, conf)) * 4);

  return Math.max(0, Math.min(100, s));
}

// ---------------------------------------------------------------- 主体构建

/**
 * @param {Array<{slug:string,entities:Array,index:object}>} sites
 * @param {{labels?:Record<string,string>, minTopicDocs?:number, maxTopics?:number,
 *          topicEntityCap?:number, graphNodes?:number}} [opts]
 */
export function buildStructure(sites, opts = {}) {
  const labels = opts.labels || {};
  const minTopicDocs = opts.minTopicDocs ?? 25;
  const maxTopics = opts.maxTopics ?? 600;
  const topicEntityCap = opts.topicEntityCap ?? 120;
  const graphNodes = opts.graphNodes ?? 260;

  /** topic -> 聚合数据 */
  const topicMap = new Map();
  /** authorKey -> 聚合数据 */
  const authorMap = new Map();
  const yearMap = new Map(); // year -> {total, bySite}
  const sourceMap = new Map(); // source -> count
  const typeMap = new Map();
  const perSite = {};

  let totalEntities = 0;
  let withAbstract = 0;
  let withAuthors = 0;
  let withDoi = 0;
  let withTags = 0;
  let qualitySum = 0;
  let crossSiteEntities = 0;

  // 每条实体归一化后的主题，供后续共现计算复用
  const entityTopics = []; // {site, topics:[]}

  for (const s of sites) {
    const siteTopics = new Map();
    const siteAuthors = new Map();
    const siteYears = new Map();
    const siteSources = new Map();
    let siteQuality = 0;

    for (const e of s.entities) {
      totalEntities += 1;
      const q = qualityScore(e);
      qualitySum += q;
      siteQuality += q;

      const abs = String(e.abstract || '');
      if (abs.length > 80) withAbstract += 1;
      const authors = Array.isArray(e.authors) ? e.authors.slice(0, 20) : [];
      if (authors.length) withAuthors += 1;
      const doi = extractDoi(e);
      if (doi) withDoi += 1;
      const rawTags = Array.isArray(e.tags) ? e.tags : [];
      if (rawTags.length) withTags += 1;
      if (Array.isArray(e.sites) && e.sites.length > 1) crossSiteEntities += 1;

      const src = String(e.source || 'unknown').toLowerCase();
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
      siteSources.set(src, (siteSources.get(src) || 0) + 1);

      const t = entityType(e);
      typeMap.set(t, (typeMap.get(t) || 0) + 1);

      const year = extractYear(e);
      if (year) {
        if (!yearMap.has(year)) yearMap.set(year, { year, total: 0, bySite: {} });
        const yr = yearMap.get(year);
        yr.total += 1;
        yr.bySite[s.slug] = (yr.bySite[s.slug] || 0) + 1;
        siteYears.set(year, (siteYears.get(year) || 0) + 1);
      }

      // ---- 主题
      const topics = [];
      const seen = new Set();
      for (const raw of rawTags) {
        const n = normTopic(raw);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        topics.push(n);
        if (topics.length >= 12) break;
      }
      entityTopics.push(topics);

      for (const n of topics) {
        if (!topicMap.has(n)) {
          topicMap.set(n, {
            topic: n,
            slug: topicSlug(n),
            docCount: 0,
            siteCounts: {},
            years: {},
            entities: [],
            broad: BROAD_CONCEPTS.has(n),
          });
        }
        const tm = topicMap.get(n);
        tm.docCount += 1;
        tm.siteCounts[s.slug] = (tm.siteCounts[s.slug] || 0) + 1;
        if (year) tm.years[year] = (tm.years[year] || 0) + 1;
        if (tm.entities.length < topicEntityCap * 3) {
          tm.entities.push({
            id: e.id,
            site: s.slug,
            name: e.name,
            url: e.url,
            year,
            q,
            abstract: abs.slice(0, 220),
          });
        }
        siteTopics.set(n, (siteTopics.get(n) || 0) + 1);
      }

      // ---- 作者
      for (const raw of authors) {
        const a = normalizeAuthor(raw);
        if (!a) continue;
        if (!authorMap.has(a.key)) {
          authorMap.set(a.key, { key: a.key, name: a.display, docCount: 0, sites: {}, years: {} });
        }
        const am = authorMap.get(a.key);
        am.docCount += 1;
        am.sites[s.slug] = (am.sites[s.slug] || 0) + 1;
        if (year) am.years[year] = (am.years[year] || 0) + 1;
        siteAuthors.set(a.key, (siteAuthors.get(a.key) || 0) + 1);
      }
    }

    perSite[s.slug] = {
      site: s.slug,
      label: labels[s.slug] || s.slug,
      totalEntities: s.entities.length,
      avgQuality: s.entities.length ? Math.round(siteQuality / s.entities.length) : 0,
      topTopics: [...siteTopics.entries()]
        .filter(([k]) => !BROAD_CONCEPTS.has(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([topic, count]) => ({ topic, slug: topicSlug(topic), count })),
      topAuthors: [...siteAuthors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([key, count]) => ({ name: authorMap.get(key)?.name || key, count })),
      timeline: [...siteYears.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count })),
      sources: [...siteSources.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })),
    };
  }

  // ---- 主题排序与裁剪
  const allTopics = [...topicMap.values()]
    .filter((t) => t.docCount >= minTopicDocs && !t.broad)
    .sort((a, b) => b.docCount - a.docCount);

  const topics = allTopics.slice(0, maxTopics).map((t) => {
    const ents = t.entities
      .sort((a, b) => b.q - a.q || String(b.year || '').localeCompare(String(a.year || '')))
      .slice(0, topicEntityCap);
    return {
      topic: t.topic,
      slug: t.slug,
      docCount: t.docCount,
      siteCount: Object.keys(t.siteCounts).length,
      siteCounts: t.siteCounts,
      years: t.years,
      entities: ents,
    };
  });

  // ---- 知识图谱：主题共现（只在入选主题间计算，避免爆炸）
  const nodeSet = new Set(topics.slice(0, graphNodes).map((t) => t.topic));
  const edgeMap = new Map();
  for (const topicsOfE of entityTopics) {
    const inSet = topicsOfE.filter((t) => nodeSet.has(t));
    for (let i = 0; i < inSet.length; i++) {
      for (let j = i + 1; j < inSet.length; j++) {
        const [a, b] = inSet[i] < inSet[j] ? [inSet[i], inSet[j]] : [inSet[j], inSet[i]];
        const k = `${a}\u0000${b}`;
        edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
      }
    }
  }
  const edges = [...edgeMap.entries()]
    .filter(([, w]) => w >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4000)
    .map(([k, weight]) => {
      const [source, target] = k.split('\u0000');
      return { source, target, weight };
    });

  const topicBySlug = new Map(topics.map((t) => [t.topic, t]));
  const graph = {
    generatedAt: new Date().toISOString(),
    nodes: [...nodeSet].map((t) => {
      const tm = topicBySlug.get(t);
      return {
        id: t,
        slug: topicSlug(t),
        docCount: tm ? tm.docCount : 0,
        sites: tm ? Object.keys(tm.siteCounts) : [],
      };
    }),
    edges,
  };

  // ---- 相关主题（给主题页做内链，强化 SEO 与图谱可用性）
  const related = new Map();
  for (const e of edges) {
    if (!related.has(e.source)) related.set(e.source, []);
    if (!related.has(e.target)) related.set(e.target, []);
    related.get(e.source).push({ topic: e.target, weight: e.weight });
    related.get(e.target).push({ topic: e.source, weight: e.weight });
  }
  for (const t of topics) {
    t.related = (related.get(t.topic) || [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((r) => ({ topic: r.topic, slug: topicSlug(r.topic), weight: r.weight }));
  }

  const authors = [...authorMap.values()]
    .filter((a) => a.docCount >= 3)
    .sort((a, b) => b.docCount - a.docCount)
    .slice(0, 3000)
    .map((a) => ({
      name: a.name,
      docCount: a.docCount,
      sites: Object.keys(a.sites),
      siteCounts: a.sites,
    }));

  const timeline = [...yearMap.values()].sort((a, b) => a.year - b.year);

  const stats = {
    generatedAt: new Date().toISOString(),
    totalSites: sites.length,
    totalEntities,
    uniqueTopics: topicMap.size,
    indexedTopics: topics.length,
    uniqueAuthors: authorMap.size,
    graphNodes: graph.nodes.length,
    graphEdges: edges.length,
    coverage: {
      abstract: pct(withAbstract, totalEntities),
      authors: pct(withAuthors, totalEntities),
      doi: pct(withDoi, totalEntities),
      tags: pct(withTags, totalEntities),
      crossSite: pct(crossSiteEntities, totalEntities),
    },
    avgQuality: totalEntities ? Math.round(qualitySum / totalEntities) : 0,
    byType: Object.fromEntries([...typeMap.entries()].sort((a, b) => b[1] - a[1])),
    bySource: Object.fromEntries([...sourceMap.entries()].sort((a, b) => b[1] - a[1])),
    bySite: Object.fromEntries(sites.map((s) => [s.slug, s.entities.length])),
    byYear: Object.fromEntries(timeline.map((t) => [t.year, t.total])),
  };

  return { stats, topics, authors, timeline, graph, perSite };
}

function pct(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------- 导出格式

/** JSONL —— LLM 微调 / RAG 摄取的事实标准格式，每行一个独立 JSON */
export function toJSONL(entities, site) {
  const out = [];
  for (const e of entities) {
    out.push(
      JSON.stringify({
        id: e.id,
        site: site || (Array.isArray(e.sites) ? e.sites[0] : undefined),
        title: e.name,
        abstract: e.abstract || '',
        url: e.url,
        doi: extractDoi(e),
        authors: Array.isArray(e.authors) ? e.authors : [],
        tags: Array.isArray(e.tags) ? e.tags : [],
        year: extractYear(e),
        source: e.source,
        type: entityType(e),
        quality: qualityScore(e),
      }),
    );
  }
  return `${out.join('\n')}\n`;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV —— Excel / pandas / BI 工具直接可用 */
export function toCSV(entities, site) {
  const head = ['id', 'site', 'title', 'year', 'authors', 'tags', 'source', 'type', 'doi', 'quality', 'url'];
  const rows = [head.join(',')];
  for (const e of entities) {
    rows.push(
      [
        e.id,
        site || (Array.isArray(e.sites) ? e.sites[0] : ''),
        e.name,
        extractYear(e) || '',
        (Array.isArray(e.authors) ? e.authors : []).join('; '),
        (Array.isArray(e.tags) ? e.tags : []).join('; '),
        e.source,
        entityType(e),
        extractDoi(e) || '',
        qualityScore(e),
        e.url,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

function bibEscape(s) {
  return String(s || '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
}

/** BibTeX —— Zotero / EndNote / LaTeX 直接导入 */
export function toBibTeX(entities) {
  const out = [];
  const used = new Set();
  for (const e of entities) {
    let key = String(e.id || '').replace(/[^A-Za-z0-9]/g, '') || 'ref';
    while (used.has(key)) key += 'a';
    used.add(key);
    const type = entityType(e) === 'preprint' ? 'misc' : 'article';
    const year = extractYear(e);
    const doi = extractDoi(e);
    const authors = (Array.isArray(e.authors) ? e.authors : []).map(bibEscape).filter(Boolean).join(' and ');
    const lines = [`@${type}{${key},`];
    lines.push(`  title = {${bibEscape(e.name)}},`);
    if (authors) lines.push(`  author = {${authors}},`);
    if (year) lines.push(`  year = {${year}},`);
    if (doi) lines.push(`  doi = {${doi}},`);
    if (e.url) lines.push(`  url = {${bibEscape(e.url)}},`);
    lines.push(`  note = {Source: ${bibEscape(e.source)}; via GeneTech 知识引擎}`);
    lines.push('}');
    out.push(lines.join('\n'));
  }
  return `${out.join('\n\n')}\n`;
}

/** CSL-JSON —— Zotero / Pandoc / 引文样式引擎标准交换格式 */
export function toCSLJSON(entities) {
  return entities.map((e) => {
    const year = extractYear(e);
    return {
      id: e.id,
      type: entityType(e) === 'preprint' ? 'manuscript' : 'article-journal',
      title: e.name,
      abstract: e.abstract || undefined,
      author: (Array.isArray(e.authors) ? e.authors : [])
        .map((raw) => {
          const a = normalizeAuthor(raw);
          if (!a) return null;
          const [family, initials] = a.display.split(', ');
          return initials ? { family, given: initials } : { family };
        })
        .filter(Boolean),
      issued: year ? { 'date-parts': [[year]] } : undefined,
      DOI: extractDoi(e) || undefined,
      URL: e.url || undefined,
      source: e.source,
    };
  });
}
