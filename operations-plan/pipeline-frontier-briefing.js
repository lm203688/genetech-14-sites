#!/usr/bin/env node
/**
 * operations-plan/pipeline-frontier-briefing.js
 * ─────────────────────────────────────────────────────────────────────────
 * 月度前沿简报生成器（G3）。
 *
 * 为什么需要它
 *   v2 报告 §6 G3「月度前沿简报」要求：每站自动生成"本月该域 Top-N 进展"，
 *   数据变内容，可作 GEO 与私域素材。此前 30 站内容只有 README 与静态页面，
 *   没有任何"随数据变动自动生成"的内容。这条 pipeline 补上这个空缺。
 *
 * 输入
 *   每个 <site>/website/api/entities.json 里的实体，字段：
 *     name, abstract, source, url, authors, tags, confidence, sites,
 *     publishedDate, addedAt, doi, updatedAt, quality_tier
 *
 * 筛选逻辑（"最新"）
 *   优先按 publishedDate 排序（原论文的发表日期），日期缺失时降级到 addedAt
 *   （入库时间）；两者都缺失的实体不参与排序，直接跳过。
 *
 * 输出
 *   每站一份 Markdown：content/frontier-briefings/<site>-<YYYY-MM>.md
 *   汇总 JSON：reports/frontier-briefings-<date>.json（含每站 Top-N 元数据）
 *   可选 R2 索引：data/frontier-briefings-index.json（含所有简报清单）
 *
 * 用法
 *   node operations-plan/pipeline-frontier-briefing.js                          # 全部 30 站，最近 30 天
 *   node operations-plan/pipeline-frontier-briefing.js --days=90                # 最近 90 天
 *   node operations-plan/pipeline-frontier-briefing.js --top=5                  # Top 5（默认 10）
 *   node operations-plan/pipeline-frontier-briefing.js --site=quantum-computing # 单站
 *   node operations-plan/pipeline-frontier-briefing.js --dry-run                # 只算不写
 *
 * 不可逆操作防护
 *   与 quality-gate 约定一致：--dry-run 默认读只，--write 才落盘。
 *   目前设计为默认写盘（因为只写新增文件、不覆盖已有实体文件，无破坏性）。
 *   若要严格 dry-run，加 --dry-run。
 *
 * 退出码：0 正常 / 1 写入失败 / 2 配置错误
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'frontier-briefings');
const REPORTS = path.join(ROOT, 'reports');
const DATA = path.join(ROOT, 'data');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const FLAG = (name, def) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const DAYS = parseInt(FLAG('days', '30'), 10);
const TOP = parseInt(FLAG('top', '10'), 10);
const DRY_RUN = argv.includes('--dry-run');
const SITE_FILTER = FLAG('site', null);
const REFRESH_INDEX = argv.includes('--refresh-index');

// ---------- 工具 ----------
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function fmtDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function trunc(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- 扫描所有站 ----------
function discoverSites() {
  const out = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(ROOT, e.name, 'website', 'api', 'entities.json');
    if (fs.existsSync(p)) out.push(e.name);
  }
  return out.sort();
}

function loadEntities(site) {
  const p = path.join(ROOT, site, 'website', 'api', 'entities.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return Array.isArray(raw) ? raw : (raw.entities || []);
}

// ---------- 核心筛选 ----------
function pickRecent(entities, days, top) {
  const cutoff = Date.now() - days * 86400000;
  const candidates = [];
  let skipped = 0;
  for (const e of entities) {
    // 优先 publishedDate，回退 addedAt
    let t = parseDate(e.publishedDate) || parseDate(e.addedAt);
    if (!t) { skipped++; continue; }
    if (t < cutoff) continue;
    candidates.push({ e, t });
  }
  candidates.sort((a, b) => b.t - a.t);
  const picked = candidates.slice(0, top);
  return { picked, skipped, total: entities.length, cutoff };
}

// ---------- 渲染 ----------
function renderBriefing(site, { picked, cutoff }, days, top) {
  const lines = [];
  lines.push(`# ${site} · 前沿简报（近 ${days} 天 Top ${top}）`);
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 数据源：\`${site}/website/api/entities.json\``);
  lines.push(`> 筛选：publishedDate（缺失时 addedAt）≥ ${fmtDate(cutoff)}`);
  lines.push(`> 复现：\`node operations-plan/pipeline-frontier-briefing.js --site=${site} --days=${days} --top=${top}\``);
  lines.push('');

  if (!picked.length) {
    lines.push('**近 ' + days + ' 天无新增实体。** 可能原因：');
    lines.push('');
    lines.push('- 该域近期无新论文入库（数据采集端未捕获）');
    lines.push('- 该域实体的 `publishedDate` 字段普遍缺失，回退到 `addedAt` 也在阈值外');
    lines.push('');
    lines.push('可尝试放宽阈值：`--days=90` 或 `--days=180`。');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('_本简报由 `operations-plan/pipeline-frontier-briefing.js` 自动生成。_');
    return lines.join('\n');
  }

  lines.push(`近 ${days} 天共 ${picked.length} 条进入 Top-${top}（按发布时间倒序）。`);
  lines.push('');
  lines.push('## Top ' + picked.length);
  lines.push('');

  picked.forEach((item, i) => {
    const e = item.e;
    const title = e.name || e.title || '(未命名)';
    const authors = Array.isArray(e.authors) ? e.authors.join(', ') : (e.authors || '');
    const tags = Array.isArray(e.tags) ? e.tags.slice(0, 5).join(', ') : '';
    const url = e.url || '';
    const doi = e.doi || '';
    const abstract = e.abstract || e.description || '';
    const conf = e.confidence != null ? e.confidence.toFixed(2) : '?';
    const qt = e.quality_tier || '';
    const date = fmtDate(item.t);

    lines.push(`### ${i + 1}. ${title}`);
    lines.push('');
    lines.push(`- **日期**：${date}`);
    if (authors) lines.push(`- **作者**：${trunc(authors, 120)}`);
    if (doi) lines.push(`- **DOI**：[${doi}](${url || 'https://doi.org/' + doi})`);
    else if (url) lines.push(`- **URL**：[${url}](${url})`);
    if (tags) lines.push(`- **标签**：${tags}`);
    lines.push(`- **质量分**：${conf}${qt ? ' · ' + qt : ''}`);
    if (abstract) lines.push(`- **摘要**：${trunc(abstract, 400)}`);
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('_本简报由 `operations-plan/pipeline-frontier-briefing.js` 自动生成，数据源为本站 `entities.json`。_');
  return lines.join('\n');
}

// ---------- 索引 ----------
function refreshIndex(allSites, days, top) {
  const idx = {
    generatedAt: new Date().toISOString(),
    days, top,
    stations: allSites.map(s => ({
      site: s.site,
      count: s.picked.length,
      file: `content/frontier-briefings/${s.site}-${new Date().toISOString().slice(0, 7)}.md`,
    })),
  };
  const p = path.join(DATA, 'frontier-briefings-index.json');
  if (DRY_RUN) {
    console.log('[dry-run] 将写入索引：', p);
  } else {
    fs.writeFileSync(p, JSON.stringify(idx, null, 2));
    console.log('[index] 写入', p);
  }
  return idx;
}

// ---------- 主流程 ----------
function main() {
  const sites = discoverSites().filter(s => !SITE_FILTER || s === SITE_FILTER);
  console.log(`[briefing] 扫描 ${sites.length} 站，阈值=近 ${DAYS} 天，Top=${TOP}`);

  if (!fs.existsSync(CONTENT) && !DRY_RUN) {
    fs.mkdirSync(CONTENT, { recursive: true });
  }

  const now = new Date();
  const period = now.toISOString().slice(0, 7);
  const results = [];

  for (const site of sites) {
    let entities;
    try {
      entities = loadEntities(site);
    } catch (err) {
      console.warn(`  ! ${site}: 无法加载 entities.json → ${err.message.slice(0, 100)}`);
      continue;
    }
    const { picked, skipped, total } = pickRecent(entities, DAYS, TOP);
    const briefing = renderBriefing(site, { picked, cutoff: Date.now() - DAYS * 86400000 }, DAYS, TOP);
    const outPath = path.join(CONTENT, `${site}-${period}.md`);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${site}: ${picked.length}/${total} 命中 → 将写入 ${path.relative(ROOT, outPath)}`);
    } else {
      fs.writeFileSync(outPath, briefing);
      console.log(`  ✓ ${site}: ${picked.length}/${total} 命中 → ${path.relative(ROOT, outPath)}`);
    }
    results.push({
      site,
      total,
      skipped,
      picked: picked.length,
      file: path.relative(ROOT, outPath),
    });
  }

  // 汇总 JSON
  const summary = {
    generatedAt: new Date().toISOString(),
    days: DAYS,
    top: TOP,
    total_stations: sites.length,
    stations_with_results: results.filter(r => r.picked > 0).length,
    total_picked: results.reduce((s, r) => s + r.picked, 0),
    stations: results,
  };

  const summaryPath = path.join(REPORTS, `frontier-briefings-${now.toISOString().slice(0, 10)}.json`);
  if (DRY_RUN) {
    console.log(`[dry-run] 将写入汇总：${summaryPath}`);
  } else {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[summary] 写入 ${summaryPath}`);
  }

  if (REFRESH_INDEX) refreshIndex(results, DAYS, TOP);

  // 退出码
  const failures = results.filter(r => r.picked === 0).length;
  console.log(`\n[briefing] 完成：${results.length - failures}/${results.length} 站有内容`);
  process.exit(0);
}

main();
