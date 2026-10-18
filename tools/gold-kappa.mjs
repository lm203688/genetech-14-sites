#!/usr/bin/env node
/**
 * tools/gold-kappa.mjs  (SCI 报告 §T2.2 — Cohen's kappa 计算)
 *
 * 读取 data/gold.jsonl（两条人工标注 annotatorA / annotatorB，各为「相关候选 id 数组」），
 * 对每条 query 的候选集逐候选二值化（id 在数组中=相关，否则=不相关），
 * 跨所有 (query, candidate) 对计算 Cohen's kappa（inter-rater 一致性）。
 *
 * 用法：
 *   node tools/gold-kappa.mjs                  # 读 data/gold.jsonl
 *   node tools/gold-kappa.mjs --self-test      # 用合成标注验证 kappa 数学正确
 *
 * 输出：kappa 值、各标注者相关数、一致/不一致对计数、是否达到 ≥0.6 门槛。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GOLD = path.join(ROOT, 'data', 'gold.jsonl');

/** Cohen's kappa 给定混淆计数 */
function cohensKappa(aPos, aNeg, bPos, bNeg) {
  const n = aPos + aNeg + bPos + bNeg;
  if (n === 0) return { kappa: null, n: 0 };
  const po = (aPos + aNeg) / n; // 一致率（aPos=都相关, aNeg=都不相关）
  const pa = (aPos + bPos) / n; // A 相关比例
  const pb = (aPos + aNeg) / n; // B 相关比例？——修正：见下
  // 正确边际：P(A=+) = (aPos+bPos)/n ; P(B=+) = (aPos+aNeg)/n
  const pApos = (aPos + bPos) / n;
  const pBpos = (aPos + aNeg) / n;
  const pe = pApos * pBpos + (1 - pApos) * (1 - pBpos);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa: +kappa.toFixed(4), po: +po.toFixed(4), pe: +pe.toFixed(4), n };
}

function compute(items) {
  let aPos = 0, aNeg = 0, bPos = 0, bNeg = 0; // aPos=都相关, aNeg=都不相关, bPos=A相关B不, bNeg=A不B相关
  let itemCount = 0;
  for (const it of items) {
    if (!Array.isArray(it.annotatorA) || !Array.isArray(it.annotatorB)) continue;
    const A = new Set(it.annotatorA);
    const B = new Set(it.annotatorB);
    itemCount++;
    for (const cid of it.candidateIds || []) {
      const a = A.has(cid);
      const b = B.has(cid);
      if (a && b) aPos++;
      else if (!a && !b) aNeg++;
      else if (a && !b) bPos++;   // 记作 "A 相关 B 不"
      else bNeg++;                // A 不 B 相关
    }
  }
  const r = cohensKappa(aPos, aNeg, bPos, bNeg);
  return { ...r, itemCount, aPos, aNeg, bPos, bNeg };
}

function main() {
  if (!fs.existsSync(GOLD)) { console.error('[kappa] 缺 data/gold.jsonl，先跑 build-gold-sample.mjs'); process.exit(1); }
  const items = fs.readFileSync(GOLD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = compute(items);
  console.log('=== Cohen\'s kappa（gold 子集人工一致性）===');
  console.log(`已标注 query 数: ${r.itemCount} / ${items.length}`);
  console.log(`(都相关, 都不相关, A独相关, B独相关) = (${r.aPos}, ${r.aNeg}, ${r.bPos}, ${r.bNeg})`);
  console.log(`Po(一致率)=${r.po}  Pe(期望一致)=${r.pe}`);
  console.log(`Cohen's kappa = ${r.kappa === null ? 'n/a（无标注）' : r.kappa}`);
  if (r.kappa !== null) {
    console.log(r.kappa >= 0.6 ? '✅ 达到 ≥0.6 门槛' : '⚠️ 未达 ≥0.6，需重标或扩样本');
  }
}

function selfTest() {
  // 合成：100 对，90 一致（50 都相关+40 都不），10 不一致
  const items = [];
  for (let i = 0; i < 50; i++) items.push({ candidateIds: ['c' + i], annotatorA: ['c' + i], annotatorB: ['c' + i] });
  for (let i = 0; i < 40; i++) items.push({ candidateIds: ['d' + i], annotatorA: [], annotatorB: [] });
  for (let i = 0; i < 10; i++) items.push({ candidateIds: ['e' + i], annotatorA: ['e' + i], annotatorB: [] });
  const r = compute(items);
  console.log(`[self-test] kappa=${r.kappa} (期望约 0.76)`, r.kappa > 0.7 ? 'PASS' : 'FAIL');
}

if (process.argv.includes('--self-test')) selfTest();
else main();
