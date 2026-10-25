#!/usr/bin/env node
/**
 * mcp-smoke.mjs — GeneTech 数据引擎 MCP Server 端到端冒烟测试（零依赖版）
 *
 * 为什么重写：原脚本 `await import('@modelcontextprotocol/sdk/dist/cjs/client')` 在
 * 2026-07-28 规范 v2 拆包后**必然失败**——v2 把 SDK 拆成 @modelcontextprotocol/core
 * (纯 Zod schema) 与 @modelcontextprotocol/server (纯 Server 端)，server 包的导出表里
 * 只有 McpServer / Server / StdioServerTransport / serveStdio，**没有任何 Client 类，
 * 也没有 StdioClientTransport**。仓库里也确实没装 client 包。
 * 结论：不能依赖官方 Client 做冒烟——它不存在。改用裸 JSON-RPC over stdio，零外部依赖。
 *
 * 为什么这比用 Client 更好：
 *   1. 不随 SDK 版本漂移而碎（v1→v2 已经碎过一次，见 package.json.v1bak）
 *   2. 测的是**线上真实流量**要走的协议帧本身，而不是 SDK 帮你封装过的路径
 *   3. 无需额外 npm install，CI 里 node 就能跑
 *
 * 协议帧：每行一个 JSON-RPC 2.0 对象。握手 = initialize → notifications/initialized
 *        → tools/list → tools/call。通知无 id、无响应。
 *
 * 用法:
 *   node .workbuddy/probe/mcp-smoke.mjs              # stdio 模式（默认）
 *   node .workbuddy/probe/mcp-smoke.mjs --http       # streamable-HTTP 模式
 *   node .workbuddy/probe/mcp-smoke.mjs --http --port=3199
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp-server', 'src', 'index.mjs');
const NM = path.join(ROOT, 'mcp-server', 'node_modules');

/* ---- 真实探针数据（从仓库实际数据里挑，避免硬编码失效）---- */
// 2026-10-25 修复：
// 1. 站点从 agent-ecosystem 改为 agritech（后者实体 DOI 大量出现在 citation-edges 中，
//    agent-ecosystem 的实体多为 arXiv 预印本，不在引用边数据集里）
// 2. citation-edges.json 的 edges 格式从数组 [doiA,doiB,siteA,siteB] 改为对象
//    {citing,cited,fromSite,toSite,...}，探针函数同步适配
// 3. linked/zeroGap 增加 null 兜底，避免下游访问 undefined[0] 崩溃
const SITE = 'agritech';
function probe() {
  // 找一个在 citation-edges 中实际存在的实体（DOI 必须出现在 citing 或 cited 字段）
  const edgesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'citation-edges.json'), 'utf-8'));
  const allEdges = edgesData.edges || [];
  const doiInEdges = new Set();
  for (const e of allEdges) {
    if (e.citing) doiInEdges.add(e.citing);
    if (e.cited) doiInEdges.add(e.cited);
  }

  const ents = JSON.parse(fs.readFileSync(path.join(ROOT, SITE, 'website', 'api', 'entities.json'), 'utf-8'));
  const arr = Array.isArray(ents) ? ents : (ents.entities || []);
  // 优先找 DOI 在引用边中的实体（verify_entity 才能返回 found）
  const withDoiInEdges = arr.find((e) => e.doi && doiInEdges.has(e.doi));
  const withDoi = withDoiInEdges || arr.find((e) => e.doi);

  // 找 linked（有引用边的站对）和 zeroGap（无引用边的站对）
  const gaps = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'citation-gaps.json'), 'utf-8'));
  const all = (gaps.sites || Object.keys(gaps.degrees || {})).filter(Boolean).sort();

  // 构建站对→引用边计数映射（对象格式：fromSite/toSite）
  const ec = {};
  for (const e of allEdges) {
    const fs = e.fromSite, ts = e.toSite;
    if (!fs || !ts) continue;
    const k = [fs, ts].sort().join('|');
    ec[k] = (ec[k] || 0) + 1;
  }

  let linked = null, zeroGap = null;
  for (let i = 0; i < all.length && (!linked || !zeroGap); i++) {
    for (let j = i + 1; j < all.length && (!linked || !zeroGap); j++) {
      const k = [all[i], all[j]].sort().join('|');
      if (ec[k]) { if (!linked) linked = [all[i], all[j], ec[k]]; }
      else if (!zeroGap) zeroGap = [all[i], all[j]];
    }
  }

  return {
    site: SITE,
    entityId: withDoi ? withDoi.id : null,
    doi: withDoi ? withDoi.doi : null,
    linked: linked || null,
    zeroGap: zeroGap || null,
  };
}
const P = probe();

const failures = [];
let code = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); failures.push(m); };
const log = (m) => console.log(`    ${m}`);

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT,
  env: { ...process.env, NODE_PATH: NM },
});
child.stderr.on('data', (d) => {
  const s = String(d).trim();
  if (s) console.log(`  [server] ${s}`);
});
child.on('exit', (c) => { if (c !== null && c !== 0) fail(`server 进程异常退出 code=${c}`); });

let buf = '';
const pend = new Map();
const notifications = [];
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (typeof msg.id === 'number' || typeof msg.id === 'string') {
      const wait = pend.get(msg.id);
      if (wait) { pend.delete(msg.id); wait(msg); }
    } else if (msg.method) {
      notifications.push(msg);
    }
  }
});

const RPC_TIMEOUT = 180000;
let _id = 0;
function request(method, params) {
  const id = ++_id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pend.delete(id); reject(new Error(`${method} 超时 ${RPC_TIMEOUT}ms`)); }, RPC_TIMEOUT);
    pend.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function callTool(name, args) {
  return request('tools/call', { name, arguments: args || {} })
    .then((r) => {
      const res = (r && r.result) || {};
      const text = (res.content || []).map((c) => c.text || '').join('');
      return { r, res, text, isError: !!res.isError, err: r && r.error };
    })
    .catch((e) => ({ text: '', isError: true, err: { code: -1, message: e.message } }));
}

async function main() {
  console.log('=== GeneTech MCP 冒烟测试（裸 JSON-RPC，零 SDK 依赖）===\n');

  // ---- 握手 ----
  let init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'genetech-smoke', version: '1.0.0' },
  });
  if (init.error) fail(`initialize 报错: ${JSON.stringify(init.error).slice(0, 200)}`);
  else {
    const s = init.result.serverInfo || {};
    const proto = init.result.protocolVersion;
    ok(`initialize: ${s.name}@${s.version}，协议版本 ${proto}`);
    if (typeof proto !== 'string' || proto.length < 8) fail('initialize 未返回 protocolVersion');
  }
  notify('notifications/initialized', {});
  await new Promise((r) => setTimeout(r, 250));

  try {
    // ---- 工具清单 ----
    const tl = await request('tools/list', {});
    if (tl.error) fail(`tools/list 报错: ${JSON.stringify(tl.error).slice(0, 200)}`);
    else {
      const names = ((tl.result || {}).tools || []).map((t) => t.name);
      console.log(`  工具数: ${names.length}`);
      console.log(`    ${names.join(', ')}`);
      if (names.length < 14) fail(`工具数 ${names.length} < 14`);
      for (const need of ['verify_entity', 'snapshot_at', 'domain_relatedness']) {
        if (names.includes(need)) ok(`含新工具 ${need}`); else fail(`缺少新工具 ${need}`);
      }
    }

    console.log('\n-- list_sites --');
    {
      const c = await callTool('list_sites');
      if (c.isError || c.err) fail(`list_sites 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          if (j.count >= 30) ok(`list_sites count=${j.count}`); else fail(`list_sites count=${j.count} < 30`);
        } catch { fail('list_sites 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
    }

    console.log('\n-- query_entities --');
    {
      const c = await callTool('query_entities', { site: P.site, limit: 3 });
      if (c.isError || c.err) fail(`query_entities 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          if (j.returned > 0) ok(`query_entities 返回 ${j.returned}/${j.total}`); else fail('query_entities 返回 0 条');
        } catch { fail('query_entities 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
    }

    console.log('\n-- semantic_search（graphHop=true）--');
    {
      const c = await callTool('semantic_search', { query: 'protein folding', limit: 3, graphHop: true, hops: 1 });
      if (c.isError || c.err) fail(`semantic_search 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          const ge = (j.graphExtensions || []).length;
          const hits = j.hits || j.results || j.total || '?';
          ok(`semantic_search hits=${hits} graphExtensions=${ge} status=${j.graphStatus || 'n/a'}`);
          if (!ge) fail('graphHop=true 但没有扩召回结果（GraphRAG 图遍历未生效）');
        } catch { fail('semantic_search 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
    }

    console.log('\n-- graph_search --');
    {
      const c = await callTool('graph_search', { query: 'protein folding', hops: 2, maxReached: 10 });
      if (c.isError || c.err) fail(`graph_search 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          const n = (j.reached || []).length;
          ok(`graph_search anchors=${(j.anchorIds || []).length} reached=${n} graphEdges=${j.meta && j.meta.graphEdges}`);
          if (!n) fail('graph_search 0 条 reached');
        } catch { fail('graph_search 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
    }

    console.log('\n-- get_entity --');
    {
      const c = await callTool('get_entity', { id: P.entityId, citation: 'bibtex' });
      if (c.isError || c.err) fail(`get_entity 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          if (j.entity) ok(`get_entity(${P.entityId}) 命中，返回 ${c.text.length}B`);
          else fail('get_entity 未返回 entity');
        } catch { fail('get_entity 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
    }

    /* ============ 新工具 1：verify_entity ============ */
    console.log('\n-- 新工具 verify_entity（DOI 反查 + 溯源链）--');
    {
      if (!P.doi) fail('没有带 DOI 的探针实体，跳过 verify_entity');
      else {
        const c = await callTool('verify_entity', { identifier: P.doi, citation: 'apa', includeGaps: true });
        if (c.isError || c.err) fail(`verify_entity 失败: ${(c.err && c.err.message) || c.isError}`);
        else {
          try {
            const j = JSON.parse(c.text);
            if (j.status && j.status.startsWith('found')) ok(`verify_entity 命中 ${j.matchCount} 条 status=${j.status}`);
            else fail(`verify_entity status=${j.status}（期望 found*）`);
            const row = j.results && j.results[0];
            if (!row) fail('verify_entity 无 results');
            else {
              const st = row.provenance && row.provenance.chainLength;
              if (st >= 2) ok(`溯源链 ${st} 段（data_source→doi→published→入库→更新）`);
              else fail(`溯源链只有 ${st} 段，不足以证明可溯源`);
              const qt = row.provenance && row.provenance.qualityTier;
              if (qt) ok(`qualityTier=${qt}（分档已落地）`);
              else fail('缺 provenance.qualityTier（quality_tier 字段未透传）');
              if (row.confidenceSourceDeterministic === false) ok(`confidence 实测非 source 常量（同来源 ${row.confidenceSourceDistinctCount} 个取值）`);
              else fail(`confidenceSourceDeterministic=${row.confidenceSourceDeterministic}（仍是 source 常量编码）`);
              if (j.confidenceVerdict && j.confidenceVerdict.isRealQualityScore) ok('confidenceVerdict.isRealQualityScore=true（实测结论成立）');
              else fail('confidenceVerdict 未实测出「真实质量分」结论');
              if (row.citation) ok('APA 引用导出正常'); else fail('citation=apa 未导出引用');
            }
          } catch { fail('verify_entity 返回非 JSON'); log(c.text.slice(0, 200)); }
        }
      }
      // 反例：必须明确 not_found，不能假装命中
      const c2 = await callTool('verify_entity', { identifier: '10.9999/fake-doi-not-exist-000' });
      if (c2.isError || c2.err) fail(`verify_entity 反例调用报错: ${(c2.err && c2.err.message) || c2.isError}`);
      else {
        try {
          const j = JSON.parse(c2.text);
          if (j.status === 'not_found') ok('反例 DOI 正确返回 not_found（不谎报命中）');
          else fail(`反例 DOI 返回 ${j.status}，应该 not_found`);
        } catch { fail('verify_entity 反例返回非 JSON'); }
      }
    }

    /* ============ 新工具 2：snapshot_at ============ */
    console.log('\n-- 新工具 snapshot_at（时间机器）--');
    {
      const today = new Date().toISOString().slice(0, 10);
      const c = await callTool('snapshot_at', { site: P.site, date: today, limit: 3 });
      if (c.isError || c.err) fail(`snapshot_at 失败: ${(c.err && c.err.message) || c.isError}`);
      else {
        try {
          const j = JSON.parse(c.text);
          const ratio = j.visibleRatio;
          ok(`snapshot_at ${P.site}@${today}: ${j.visibleAtDate}/${j.totalNow} (ratio=${ratio})`);
          if (typeof ratio !== 'number' || ratio < 0 || ratio > 1) fail(`visibleRatio=${ratio} 越界 [0,1]`);
          if (j.provenanceConsistency) ok(`一致性判定=${j.provenanceConsistency}`);
          else fail('缺 provenanceConsistency（无法判断回放与 provenance 是否一致）');
          if (j.undatedEntities && j.undatedEntities > 0) log(`注意：${j.undatedEntities} 条实体无 addedAt，回放无法覆盖`);
        } catch { fail('snapshot_at 返回非 JSON'); log(c.text.slice(0, 200)); }
      }
      // 反例：远未来日期应看到全部；坏日期应报错
      const c2 = await callTool('snapshot_at', { site: P.site, date: '2030-01-01' });
      const c3 = await callTool('snapshot_at', { site: P.site, date: 'not-a-date' });
      try {
        const j2 = JSON.parse(c2.text);
        if (j2.visibleRatio >= 0.99) ok('远未来日期 visibleRatio=1.0（回放单调性成立）');
        else fail(`远未来日期 visibleRatio=${j2.visibleRatio}，应≈1.0`);
      } catch { /* 反例 1 失败记在下面 */ fail('snapshot_at 远未来日期返回非 JSON'); }
      if (c3.isError) ok('坏日期正确拒绝（isError=true）');
      else {
        try {
          const j3 = JSON.parse(c3.text);
          if (j3.status === 'bad_date') ok('坏日期正确返回 bad_date');
          else fail(`坏日期返回 ${j3.status || JSON.stringify(j3).slice(0, 80)}，应 bad_date`);
        } catch { fail('snapshot_at 坏日期返回非 JSON'); }
      }
      const c4 = await callTool('snapshot_at', { site: 'no-such-site-xyz', date: today });
      if (c4.isError) ok('不存在站点正确拒绝');
      else {
        try { if (JSON.parse(c4.text).status === 'site_not_found') ok('不存在站点返回 site_not_found'); else fail('不存在站点未正确拒绝'); }
        catch { fail('snapshot_at 不存在站点返回非 JSON'); }
      }
    }

    /* ============ 新工具 3：domain_relatedness ============ */
    console.log('\n-- 新工具 domain_relatedness（跨域相关度）--');
    {
      const linked = await callTool('domain_relatedness', { from: P.linked[0], to: P.linked[1], limit: 5 });
      if (linked.isError || linked.err) fail(`domain_relatedness 失败: ${(linked.err && linked.err.message) || linked.isError}`);
      else {
        try {
          const j = JSON.parse(linked.text);
          const total = j.directedCitation && j.directedCitation.total;
          ok(`domain_relatedness ${P.linked[0]}↔${P.linked[1]}: relatedness=${j.relatedness} tier=${j.tier}`);
          log(`  edgesByType=${JSON.stringify(j.edgesByType)} directedCitation=${total} bridges=${(j.bridges || []).length}`);
          if (j.isZeroCitationGap) fail('已知有引用边的站对被判 isZeroCitationGap=true');
          if (typeof total !== 'number' || total < P.linked[2]) {
            fail(`directedCitation=${total} < 实际引用边 ${P.linked[2]}（站点归属解析可能丢边）`);
          } else ok(`directedCitation=${total} 覆盖实际引用边 ${P.linked[2]}`);
          // cross_site 是本工具的关键证据类型，修完 station: 映射后必须 >0
          if ((j.edgesByType || {}).cross_site > 0) ok(`cross_site 边已计入 ${j.edgesByType.cross_site} 条`);
          else fail('cross_site=0（station: 节点未映射，跨站桥梁证据全丢）');
          if (j.relatedness == null || j.tier == null) fail('缺 relatedness/tier 评分');
          if (!j.scoring) fail('缺 scoring（权重与饱和阈值不可审计）');
        } catch { fail('domain_relatedness 返回非 JSON'); log(linked.text.slice(0, 200)); }
      }

      const zero = await callTool('domain_relatedness', { from: P.zeroGap[0], to: P.zeroGap[1], limit: 3 });
      if (zero.isError || zero.err) fail(`domain_relatedness 零缺口对失败: ${(zero.err && zero.err.message) || zero.err.isError}`);
      else {
        try {
          const j = JSON.parse(zero.text);
          if (j.isZeroCitationGap) ok(`零引用站对 ${P.zeroGap[0]}↔${P.zeroGap[1]} 正确识别（研究空白候选）`);
          else fail('零引用站对被误判 has-citation');
          if (j.tier === 'zero-citation-gap') ok('tier=zero-citation-gap');
          else log(`tier=${j.tier}（有图谱弱关联也可能抬高相关度，属预期）`);
        } catch { fail('domain_relatedness 零缺口对返回非 JSON'); }
      }

      const bad = await callTool('domain_relatedness', { from: 'no-such-a', to: 'no-such-b' });
      if (bad.isError) ok('不存在站点正确拒绝');
      else {
        try { if (JSON.parse(bad.text).status === 'site_not_found') ok('不存在站点对返回 site_not_found'); else fail('不存在站点对未正确拒绝'); }
        catch { fail('domain_relatedness 不存在站点对返回非 JSON'); }
      }
    }
  } catch (e) {
    fail(`异常: ${e && e.message ? e.message : e}`);
    console.log(e.stack);
  }

  // 收尾
  try { await request('ping', {}); } catch { /* ping 非必需 */ }
  child.stdin.end();
  await new Promise((r) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 4000);
    child.on('exit', () => { clearTimeout(t); r(); });
  });

  console.log(`\n服务器通知计数: ${notifications.length}`);
  console.log(failures.length ? `\n✗ 冒烟测试失败 ${failures.length} 项：` : '\n✓ 冒烟测试全部通过');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('未捕获异常:', e); process.exit(2); });
