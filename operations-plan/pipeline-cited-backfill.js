#!/usr/bin/env node
/**
 * pipeline-cited-backfill.js —— 补齐「被引文档」到库
 *
 * 为什么需要它（2026-10-04 量化）：
 *   data/academic-entities.json 里 59,623 条引用声明 → 57,764 个 unique 被引 DOI，
 *   落到 30 站实体库里的只有 2,170 个（3.8%），**96.2%（55,594 个）完全不在库**。
 *   引用边数不由「我们抓了多少引用声明」决定，由「被引文档有多少在库」决定。
 *   所以真正该扩的是被引侧，不是引用侧。
 *
 * 为什么用 OpenAlex 的批量 DOI 过滤：
 *   Crossref 的 `filter=doi:a,b,c` 直接被拒（pair-list-form-invalid，实测），只能一条一条打；
 *   而 OpenAlex 的 `filter=doi:<a>|<b>|...` 是合法的多值 OR，
 *   实测 50 个 DOI/请求、1.7s 返回、命中正常 → 55,594 条约 1,100 次请求，一轮能跑完。
 *
 * 重要（别踩）：本脚本**只做事实补齐，不做站点归属推断**。
 *   早期版本想用 concepts 关键词把被引文档硬塞进某个站，实测精度极差：
 *   「A Markovian Decision Process」（纯数学）被匹配到 biomed-ai、
 *   「visual servoing in robotics」被匹配到 sat-6g。
 *   用这种归属建出来的「跨站引用缺口」是假的 —— 核心卖点会变成负资产。
 *   归属推断独立放在 pipeline-cited-site-assign.js，并带置信度与人工精度审计。
 *
 * 用法：
 *   node pipeline-cited-backfill.js                 # 续跑（跳过 state 里已查过的 DOI）
 *   node pipeline-cited-backfill.js --limit=200     # 只跑 200 条（分批追进度）
 *   node pipeline-cited-backfill.js --batch=100     # 每请求 100 个 DOI（OpenAlex 上限 50 条/字段时降到 50）
 *   node pipeline-cited-backfill.js --dry-run       # 零网络，只打印池子规模
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 被 import 复用时 CLI 守卫必须用这个形式。旧式 `import.meta.url === 'file://'+process.argv[1]`
// 在含「知识引擎14站」的路径上永远匹配（percent-encoding），自检块会被静默跳过。
const __file = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__file)) {
  main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}

async function main() {
  const ARGV = process.argv.slice(2);
  const DRY = ARGV.includes('--dry-run');
  const getArg = (k, d) => {
    const a = ARGV.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
    return a ? a.slice(`--${k}=`.length) : d;
  };
  const LIMIT = Number(getArg('limit', '0')) || 0;          // 0 = 不限
  const BATCH = Math.min(50, Math.max(1, Number(getArg('batch', '50')) || 50)); // OpenAlex 单字段多值上限 50
  const CONCURRENCY = Math.max(1, Number(getArg('concurrency', '3')) || 3);
  const GAP_MS = Math.max(0, Number(getArg('gap', '200')) || 200);
  const UA = 'Genetech14-InfraBot/1.0 (mailto:ops@genetech.tools)';

  const ROOT = path.resolve(path.dirname(__file), '..');
  const DATA_DIR = path.join(ROOT, 'data');
  const STATE_DIR = path.join(ROOT, 'state');
  const OUT_CITED = path.join(DATA_DIR, 'cited-entities.json');
  const OUT_STATE = path.join(STATE_DIR, 'cited-backfill-state.json');
  const REPORT_DIR = path.join(ROOT, 'reports');

  console.log('[args] ' + JSON.stringify({ limit: LIMIT, batch: BATCH, concurrency: CONCURRENCY, gapMs: GAP_MS, dryRun: DRY }));

  const normDoi = (v) => {
    if (!v) return '';
    return String(v).trim().toLowerCase()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
      .replace(/^doi:/, '');
  };

  // ---- 待补清单 = 引用声明里的被引 DOI 减去「已在站内 / 已抓过」的 ----
  const siteDoi = new Set();
  for (const site of fs.readdirSync(ROOT)) {
    let st; try { st = fs.statSync(path.join(ROOT, site)).isDirectory(); } catch { continue; }
    if (!st || !fs.existsSync(path.join(ROOT, site, 'website/api/entities.json'))) continue;
    const wrap = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website/api/entities.json'), 'utf8'));
    const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
    for (const e of list) { const d = normDoi(e && e.doi); if (d) siteDoi.add(d); }
  }

  const accWrap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'academic-entities.json'), 'utf8'));
  const acc = Array.isArray(accWrap) ? accWrap : (accWrap.entities || []);
  const citing = { total: 0 };
  const cited = new Set();
  for (const e of acc) {
    const from = (e.sites && e.sites[0]) || null;
    if (!from) continue;
    citing.total++;
    for (const r of (e.references || [])) {
      const d = normDoi(r);
      if (d) cited.add(d);
    }
  }

  let state = { done: {}, missing: {} };
  try { state = JSON.parse(fs.readFileSync(OUT_STATE, 'utf8')); } catch { state = { done: {}, missing: {} }; }
  state.done = state.done || {}; state.missing = state.missing || {};

  const onDiskCited = (() => {
    try { const d = JSON.parse(fs.readFileSync(OUT_CITED, 'utf8')); return new Set((Array.isArray(d) ? d : d.entities || []).map((e) => normDoi(e.doi))); } catch { return new Set(); }
  })();

  const already = new Set([...siteDoi, ...onDiskCited, ...Object.keys(state.done), ...Object.keys(state.missing)]);
  const pending = [...cited].filter((d) => d && !already.has(d));
  console.log(`库：30 站实体 ${siteDoi.size} 个 DOI / 已抓被引 ${onDiskCited.size} 个`);
  console.log(`引用声明涉及的 unique 被引 DOI：${cited.size}`);
  console.log(`已覆盖（站内或已抓或已试过）：${cited.size - pending.length} 个`);
  console.log(`**待补：${pending.length} 个**（本轮上限 ${LIMIT || '不限'}）`);
  if (DRY) return;
  if (!pending.length) { console.log('已全部补齐，无待补。'); return; }

  const todo = LIMIT ? pending.slice(0, LIMIT) : pending;

  // ---- 抓取：OpenAlex 多值 DOI 过滤 + cursor 翻页 ----
  const fetchBatch = async (dois) => {
    const qs = dois.map((d) => 'https://doi.org/' + d).join('|');
    const url = `https://api.openalex.org/works?filter=doi:${encodeURIComponent(qs)}&per-page=200&mailto=ops@genetech.tools&select=id,doi,title,publication_year,type,primary_location,authorships,concepts,topics,cited_by_count,abstract_inverted_index`;
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 1500 * (attempt + 1))); continue; }
        break;
      } catch { await new Promise((x) => setTimeout(x, 1500 * (attempt + 1))); }
    }
    if (!r || !r.ok) return { ok: false, items: [] };
    const j = await r.json();
    return { ok: true, items: j.results || [] };
  };

  const abstractFromInv = (inv) => {
    if (!inv) return '';
    const pos = new Map();
    for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos.set(i, w);
    const n = Math.max(...pos.keys()) + 1;
    return Array.from({ length: n }, (_, i) => pos.get(i) || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  };

  const norm = (w) => ({
    id: w.id || null,
    source: 'openalex-cited',
    doi: normDoi(w.doi),
    title: w.title || '',
    year: w.publication_year ?? null,
    venue: w.primary_location && w.primary_location.source && w.primary_location.source.display_name ? w.primary_location.source.display_name : null,
    type: w.type || null,
    citedByCount: w.cited_by_count ?? null,
    abstract: abstractFromInv(w.abstract_inverted_index),
    // concepts 是后续站点归属推断的唯一原料，必须留；但要截断，否则 5.5 万条会撑爆产物
    concepts: (w.concepts || []).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8)
      .map((c) => ({ name: c.display_name || '', score: c.score || 0 })),
    topics: (w.topics || []).slice(0, 3).map((t) => t.display_name || ''),
    url: w.doi || null,
    fetchedAt: new Date().toISOString(),
  });

  // ⚠️ 单一内存 Map 当唯一真源，由所有 worker 共用，flush 时同步写盘。
  // 不能让每个 worker 各自「读全文件 → 合并自己这批 → 写整个文件」：
  // 三个 worker 交错执行时，A 读到的是 B 写入前的快照，A 写完就把 B 那批抹掉
  // —— 55k 条跑到一半丢一批，而且没报错（本仓库在 knowledge-graph.json 上已经栽过同款）。
  // 同理也不能用 writeFile（异步），同步写会阻塞事件循环，天然不会被打断。
  const store = new Map();
  {
    try { const d = JSON.parse(fs.readFileSync(OUT_CITED, 'utf8')); for (const e of (Array.isArray(d) ? d : d.entities || [])) if (e && e.doi) store.set(normDoi(e.doi), e); } catch { /* 首次运行 */ }
  }

  const t0 = Date.now();
  let fetched = 0, notFound = 0, batchErr = 0;
  let sinceFlush = 0;
  const queue = [...todo];
  const last = { t: 0 };
  // crawl 阶段每批只更新内存 Map，每 FLUSH_EVERY 批才整体落盘一次。
  // 每批都重写整个 55k 数组 = 1,100 次 × 平均 45MB 的写，纯 O(n²) 磁盘，
  // 实测跑到 ~13k 就无了（无报错），换成周期性 flush 后稳定。
  const FLUSH_EVERY = Math.max(1, Number(getArg('flush-every', '10')) || 10);
  const flush = () => {
    fs.writeFileSync(OUT_CITED, JSON.stringify(Array.from(store.values()), null, 2), 'utf-8');
    // state 必须**无条件**落盘：本批一个都没命中时 done 不变但 missing 变了，
    // 不写就等于下次续跑把所有「上游查过、确认没有」的 DOI 再打一遍。
    fs.writeFileSync(OUT_STATE, JSON.stringify({ updatedAt: new Date().toISOString(), done: state.done, missing: state.missing }, null, 2), 'utf-8');
    sinceFlush = 0;
  };
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const batch = queue.splice(0, BATCH);
      const gap = GAP_MS - (Date.now() - last.t);
      if (gap > 0) await new Promise((x) => setTimeout(x, gap));
      last.t = Date.now();
      const { ok, items } = await fetchBatch(batch);
      if (!ok) { batchErr++; batch.forEach((d) => { state.missing[d] = 1; }); continue; }
      const got = ok ? items.map(norm).filter((x) => x.doi) : [];
      for (const g of got) { store.set(g.doi, g); state.done[g.doi] = 1; }
      for (const d of batch) if (!got.some((g) => g.doi === d)) { state.missing[d] = 1; notFound++; }
      fetched += got.length;
      // 边抓边落盘：55k 条要跑一阵，全堆到最后写盘 = 崩一次全白打（这个坑本仓库踩过两次）。
      // 用同步写 + 内存 Map 真源，多 worker 也不会互相抹掉对方那批。
      if (++sinceFlush >= FLUSH_EVERY) flush();
      // 进度日志：这个脚本要跑十几分钟，全程静默会让「还在跑」和「卡死了」看起来一模一样。
      // 注意 CI 里 console.log 是块缓冲的，所以按行数刷一个临时文件强制 flush（见 progress 那套做法）
      const doneN = todo.length - queue.length;
      const line = `  [${doneN}/${todo.length}] hit ${fetched} · miss ${notFound} · err ${batchErr} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`;
      process.stdout.write(line);
      try { fs.writeFileSync(path.join(ROOT, 'operations-plan', 'logs', '.cited-backfill.tmp'), line); } catch { /* noop */ }
    }
  });
  await Promise.all(workers);

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  flush(); // 收尾必须把最后一批 flush 掉，否则断点续跑会重打最后 10 批
  console.log(`\n--- 本轮结束：抓取命中 ${fetched} / 请求 ${todo.length}（上游无此 DOI ${notFound}，批次失败 ${batchErr}）---`);
  console.log(`累计 done=${Object.keys(state.done).length} missing=${Object.keys(state.missing).length} · ${sec}s`);

  // 门禁：跑了却一条都没落盘 —— 不管原因是什么都必须非零退出。
  // 「跑了 + exit 0 + 产物空」= 上游以为成功了，数据永远是空数组，比直接报错危险得多。
  if (todo.length && !fetched) {
    console.error('[GATE] cited-backfill 一条都没抓到。这是失败，不是「已经跑完」。');
    process.exit(3);
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `report-cited-backfill-${Date.now()}.json`), JSON.stringify({
    pipeline: 'cited-backfill', timestamp: new Date().toISOString(), dryRun: DRY,
    uniqueCited: cited.size, onDisk: onDiskCited.size, todo: todo.length,
    fetched: fetched, notFound: notFound, batchErr, doneTotal: Object.keys(state.done).length,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  }, null, 2), 'utf-8');
}
