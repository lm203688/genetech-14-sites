#!/usr/bin/env node
/**
 * tools/kappa-self-consistency.mjs
 *
 * T2.2 备选方案：无 2 位人类独立标注时，用「多次自动标注的一致性」
 * 作为 Cohen's kappa 的诚实代理指标。
 *
 * 三个自动标注策略（各为 top-K=10 排序结果作为"相关集"）：
 *   annotatorA = BM25 top-10
 *   annotatorB = TF-IDF top-10
 *   annotatorC = BM25∩TF-IDF 或 rank-fusion top-10
 *
 * 计算 pairwise Cohen's kappa（A-B, A-C, B-C）与 pooled kappa。
 * 论文里明确披露：这不是人类标注一致性，是自动标注一致性；
 * 用于代理"检索层对同一 query 给出的相关判定是否稳定"。
 *
 * 用法：node tools/kappa-self-consistency.mjs
 *
 * 输出：reports/kappa-self-consistency-<date>.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GOLD = path.join(ROOT, 'data', 'gold.jsonl');
const BM25 = path.join(ROOT, 'eval', 'results-2026-10-18.json');
const TFIDF = path.join(ROOT, 'eval', 'results-tfidf-2026-10-18.json');
const OUT = path.join(ROOT, 'reports', `kappa-self-consistency-${new Date().toISOString().slice(0, 10)}.json`);

const TOP_K = 10;

function cohensKappa(aPos, aNeg, bPos, bNeg) {
  const n = aPos + aNeg + bPos + bNeg;
  if (n === 0) return { kappa: null, po: null, pe: null, n };
  const po = (aPos + aNeg) / n;
  const pApos = (aPos + bPos) / n;
  const pBpos = (aPos + aNeg) / n;
  const pe = pApos * pBpos + (1 - pApos) * (1 - pBpos);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa: +kappa.toFixed(4), po: +po.toFixed(4), pe: +pe.toFixed(4), n };
}

function pairwiseKappa(setA, setB, candidates) {
  let aPos = 0, aNeg = 0, bPos = 0, bNeg = 0;
  const A = new Set(setA);
  const B = new Set(setB);
  for (const cid of candidates) {
    const a = A.has(cid);
    const b = B.has(cid);
    if (a && b) aPos++;
    else if (!a && !b) aNeg++;
    else if (a && !b) bPos++;
    else bNeg++;
  }
  return cohensKappa(aPos, aNeg, bPos, bNeg);
}

function loadIdxMap(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = {};
  for (const r of data.results) out[r.idx] = r;
  return out;
}

function main() {
  if (!fs.existsSync(GOLD)) { console.error('[kappa-auto] 缺 data/gold.jsonl'); process.exit(1); }
  const gold = fs.readFileSync(GOLD, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const bm25 = loadIdxMap(BM25);
  const tfidf = loadIdxMap(TFIDF);

  const results = [];
  for (const g of gold) {
    const i = g.idx;
    const b = bm25[i]; const t = tfidf[i];
    if (!b || !t) continue;
    const bTop = new Set(b.top10 || []);
    const tTop = new Set(t.top10 || []);
    // rank-fusion: 综合 BM25 rank + TF-IDF rank（越小越好）
    const bRank = new Map((b.top10 || []).map((id, k) => [id, k + 1]));
    const tRank = new Map((t.top10 || []).map((id, k) => [id, k + 1]));
    const allIds = new Set([...(b.top10 || []), ...(t.top10 || [])]);
    const fused = [...allIds]
      .map(id => ({ id, score: (bRank.get(id) || 99) + (tRank.get(id) || 99) }))
      .sort((a, b2) => a.score - b2.score)
      .slice(0, TOP_K)
      .map(x => x.id);
    results.push({
      idx: i, site: g.site, queryType: g.queryType,
      annotatorA: [...bTop],   // BM25 top-K
      annotatorB: [...tTop],   // TF-IDF top-K
      annotatorC: fused,       // rank fusion top-K
      candidateIds: g.candidateIds,
    });
  }

  // Pairwise kappa（候选集 = candidateIds ∪ annotator 结果，确保两侧都能覆盖）
  const candsPerQuery = results.map(r => {
    const s = new Set([...r.candidateIds, ...r.annotatorA, ...r.annotatorB, ...r.annotatorC]);
    return [...s];
  });

  function aggregateKappa(aKey, bKey) {
    let aPos=0,aNeg=0,bPos=0,bNeg=0;
    for (let i=0;i<results.length;i++) {
      const s = pairwiseKappa(results[i][aKey], results[i][bKey], candsPerQuery[i]);
      aPos += s.n>0 ? (function(){const A=new Set(results[i][aKey]);const B=new Set(results[i][bKey]);let ap=0,an=0,bp=0,bn=0;for(const c of candsPerQuery[i]){const a=A.has(c);const b=B.has(c);if(a&&b)ap++;else if(!a&&!b)an++;else if(a&&!b)bp++;else bn++;}return{ap,an,bp,bn};})() : {ap:0,an:0,bp:0,bn:0};
      aPos += 0; // placeholder to keep structure
    }
    // simpler: recompute directly
    let AP=0,AN=0,BP=0,BN=0;
    for (let i=0;i<results.length;i++) {
      const A=new Set(results[i][aKey]); const B=new Set(results[i][bKey]);
      for(const c of candsPerQuery[i]) {
        const a=A.has(c); const b=B.has(c);
        if(a&&b)AP++;else if(!a&&!b)AN++;else if(a&&!b)BP++;else BN++;
      }
    }
    return cohensKappa(AP, AN, BP, BN);
  }

  const ab = aggregateKappa('annotatorA', 'annotatorB');
  const ac = aggregateKappa('annotatorA', 'annotatorC');
  const bc = aggregateKappa('annotatorB', 'annotatorC');
  const pooled = aggregateKappa(
    // merge A vs B-C agreement proxy: use (annotatorA) vs (annotatorB ∪ annotatorC)
    // simpler: pooled = mean of three pairwise
    'annotatorA', 'annotatorB'
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    method: 'self-consistency kappa (auto-annotator agreement)',
    annotators: {
      annotatorA: 'BM25 top-10',
      annotatorB: `TF-IDF cosine top-10`,
      annotatorC: `BM25+TF-IDF rank-fusion top-${TOP_K}`,
    },
    topK: TOP_K,
    queriesEvaluated: results.length,
    candidatePoolSize: {
      min: Math.min(...results.map(r => candsPerQuery[results.indexOf(r)].length)),
      max: Math.max(...results.map(r => candsPerQuery[results.indexOf(r)].length)),
    },
    pairwise: {
      'A_vs_B_bm25_vs_tfidf': ab,
      'A_vs_C_bm25_vs_fusion': ac,
      'B_vs_C_tfidf_vs_fusion': bc,
    },
    meanKappa: +((ab.kappa + ac.kappa + bc.kappa) / 3).toFixed(4),
    threshold: 0.6,
    pass: (ab.kappa + ac.kappa + bc.kappa) / 3 >= 0.6,
    interpretation: {
      A_B: '两种独立检索算法在"相关候选"上的一致程度',
      A_C: 'BM25 与 rank-fusion 的一致程度',
      B_C: 'TF-IDF 与 rank-fusion 的一致程度',
      mean: '三条边的平均 kappa，作为跨方法稳定性代理指标',
    },
    limitations: [
      '这不是人类标注者之间的一致性，是自动标注策略之间的一致性。',
      'Cohen\'s kappa_auto 高只说明两种检索器对"相关"判定稳定，不代表判定本身正确。',
      '真正的 inter-rater kappa 需要 2 位人类独立标注。',
      '本报告诚实披露这一点，不冒充人工 kappa。',
    ],
    sample: results.slice(0, 3),
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
  console.log('=== Cohen\'s kappa_auto（自洽性一致性）===');
  console.log(`queries evaluated: ${results.length}`);
  console.log(`A_vs_B (BM25 vs TF-IDF):     ${ab.kappa}  n=${ab.n}`);
  console.log(`A_vs_C (BM25 vs Fusion):     ${ac.kappa}  n=${ac.n}`);
  console.log(`B_vs_C (TF-IDF vs Fusion):   ${bc.kappa}  n=${bc.n}`);
  console.log(`mean kappa_auto:             ${summary.meanKappa}`);
  console.log(summary.pass ? '✅ mean kappa_auto ≥ 0.6' : '⚠️ mean kappa_auto < 0.6');
  console.log(`\nwritten: ${OUT}`);
}

main();
