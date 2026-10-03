#!/usr/bin/env node
/**
 * 分片索引线上端到端验证（全 30 片）
 *
 * 验证的东西不是「文件在不在」，而是「Worker 会不会真的走这条路」：
 *   下载 → gzip 魔数 → DecompressionStream 解压（与 Worker 内实现同款）
 *   → JSON 解析 → 实体字段完整度（DOI/URL 必须 100%，否则下游 grounding 源不可用）
 *
 * 每次跑之前先拉线上 manifest，不允许把站点名写死在脚本里 ——
 * 2026-10-04 这版就是因为手写了 `tcm`，而真实站名是 `tcm-tools`，
 * 探针自己报了个假 404，差点让人去改根本没坏的数据。
 */
/**
 * 用法：
 *   node operations-plan/verify-shard-live.mjs
 * 可选 --base=<url> 覆盖数据 Host（默认 https://data.swarmlabs.tools）。
 *
 * 为什么必须是门禁而不是「顺手看一眼」：
 * 分片是 2026-10-03 才上线的承载路径（覆盖率 0% → 100%），它一旦损坏，
 * worker.js 会**静默回退到单文件**——那套代码是写好的、健康的，
 * 于是「线上覆盖率悄悄掉回 6%，而所有端点仍然 200」。
 * 这就是「优雅降级在离线脚本是优点，生产上是静默故障」的又一个实例。
 */
const ARGV = process.argv.slice(2);
const getArg = (k, d) => {
  const a = ARGV.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
  return a ? a.slice(`--${k}=`.length) : d;
};
const BASE = getArg('base', 'https://data.swarmlabs.tools') + '/data/search-index/';
const MANIFEST = BASE + 'manifest.json';

const mf = JSON.parse(await (await fetch(MANIFEST)).text());
const shards = mf.shards || [];
console.log(
  `manifest: v${mf.version} shards=${shards.length} totalEntities=${mf.totalEntities} ` +
    `coverage=${mf.coverage} maxShardsPerRequest=${mf.maxShardsPerRequest}\n`
);

const gunzip = async (buf) => {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([new Uint8Array(buf)]);
  const chunks = [];
  for await (const c of blob.stream().pipeThrough(ds)) chunks.push(c);
  return Buffer.concat(chunks);
};

let total = 0;
let withDoi = 0;
let sumRaw = 0;
let sumDec = 0;
const failures = [];

for (const s of shards) {
  const t0 = Date.now();
  try {
    const raw = Buffer.from(await (await fetch(BASE + s.file)).arrayBuffer());
    const magic = raw.subarray(0, 2).toString('hex');
    if (magic !== '1f8b') throw new Error(`gzip 魔数不对：0x${magic}`);
    const dec = await gunzip(raw);
    const arr = JSON.parse(dec.toString('utf8'));
    const list = Array.isArray(arr) ? arr : arr.entities || [];
    const ok = list.filter((e) => e.doi || e.url).length;
    total += list.length;
    withDoi += ok;
    sumRaw += raw.length;
    sumDec += dec.length;
    const ratio = raw.length / dec.length;
    console.log(
      `${s.site.padEnd(22)} raw=${String(raw.length).padStart(9)}B ` +
        `dec=${String(dec.length).padStart(9)}B ratio=${ratio.toFixed(2)} ` +
        `entities=${String(list.length).padStart(5)} withDoiOrUrl=${ok} ${Date.now() - t0}ms`
    );
  } catch (e) {
    failures.push(`${s.site}: ${e.message}`);
    console.log(`${s.site.padEnd(22)} FAIL ${e.message}`);
  }
}

const pct = total ? ((withDoi / total) * 100).toFixed(2) : '0';
console.log(`\n合计 ${shards.length} 片 / ${total} 实体 / 带 DOI_or_URL ${withDoi} (${pct}%)`);
console.log(`压缩率 ${(sumRaw / sumDec).toFixed(3)}（${(sumRaw / 1048576).toFixed(2)}MB → ${(sumDec / 1048576).toFixed(2)}MB）`);
console.log(failures.length ? `❌ 失败 ${failures.length} 片` : '✅ 全片通过（下载 + gzip + 解压 + JSON + 字段完整）');

// CI 用：任何一片炸了、或字段完整度掉了，都必须非零退出
if (failures.length) process.exit(2);
if (withDoi / total < 0.999) process.exit(3);
