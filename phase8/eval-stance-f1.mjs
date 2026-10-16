// phase8/eval-stance-f1.mjs
// Stance F1 评测 - 用 stance-classifier 跑真实分类
//
// 门禁判据: macro F1 >= 0.70 (M2)
// 使用: node phase8/eval-stance-f1.mjs

import { classifyStance } from './stance-classifier.mjs';

const LABELS = ['supports', 'contradicts', 'neutral', 'weakens'];

const GOLD = [
  // supports (4)
  { id: 'p1', evidence: 'Our approach demonstrates significant improvement over baseline, with a 23% increase in accuracy and reduced error rate.', claim: 'The method improves accuracy', gold: 'supports' },
  { id: 'p2', evidence: 'The paper confirms that the model outperforms prior methods on all metrics.', claim: 'The model outperforms prior methods', gold: 'supports' },
  { id: 'p3', evidence: 'Experiments validate the framework with strong results across multiple benchmarks.', claim: 'The framework is validated', gold: 'supports' },
  { id: 'p4', evidence: 'We show that the algorithm achieves state-of-the-art performance.', claim: 'The algorithm achieves state-of-the-art', gold: 'supports' },

  // contradicts (3)
  { id: 'p5', evidence: 'The paper failed to reproduce the claimed results and found significant flaws.', claim: 'The results are reliable', gold: 'contradicts' },
  { id: 'p6', evidence: 'Previous conclusions were disproven by new experiments showing opposite trends.', claim: 'The previous conclusions hold', gold: 'contradicts' },
  { id: 'p7', evidence: 'The claim is incorrect and contradicted by our measurements.', claim: 'The claim is correct', gold: 'contradicts' },

  // neutral (4)
  { id: 'p8', evidence: 'This paper reviews the history of classical mechanics and its foundational concepts.', claim: 'The method improves accuracy', gold: 'neutral' },
  { id: 'p9', evidence: 'The article presents an overview of quantum field theory applications.', claim: 'The dataset is large', gold: 'neutral' },
  { id: 'p10', evidence: 'We describe a survey of neural network architectures in computer vision.', claim: 'The experiment fails', gold: 'neutral' },
  { id: 'p11', evidence: 'A study introduces new notation for group theory.', claim: 'The model outperforms prior methods', gold: 'neutral' },

  // weakens (3)
  { id: 'p12', evidence: 'Results show partial improvement but are limited to small-scale datasets.', claim: 'The method is broadly effective', gold: 'weakens' },
  { id: 'p13', evidence: 'The improvement is questioned as the effect size is small and inconclusive.', claim: 'The improvement is significant', gold: 'weakens' },
  { id: 'p14', evidence: 'Preliminary findings suggest a weak association but require further validation.', claim: 'There is a strong causal link', gold: 'weakens' },
];

// 复用 tools/stance-f1-harness.mjs 的 computeF1 逻辑（内联以避免改 harness 接口）
function computeF1(pairs, labels = LABELS) {
  const perLabel = {};
  for (const lab of labels) perLabel[lab] = { tp: 0, fp: 0, fn: 0 };
  for (const p of pairs) {
    if (p.gold === p.pred) perLabel[p.gold].tp++;
    else { perLabel[p.pred].fp++; perLabel[p.gold].fn++; }
  }
  const perClass = {};
  let correct = 0;
  for (const lab of labels) {
    const { tp, fp, fn } = perLabel[lab];
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass[lab] = { tp, fp, fn, precision: Math.round(precision * 1000) / 1000, recall: Math.round(recall * 1000) / 1000, f1: Math.round(f1 * 1000) / 1000, support: tp + fn };
    correct += tp;
  }
  const total = pairs.length;
  const accuracy = total > 0 ? correct / total : 0;
  const macroF1 = labels.reduce((s, l) => s + perClass[l].f1, 0) / labels.length;
  return { total_pairs: total, correct, accuracy: Math.round(accuracy * 1000) / 1000, macro_f1: Math.round(macroF1 * 1000) / 1000, per_class: perClass };
}

const pairs = GOLD.map(g => {
  const r = classifyStance(g.evidence, g.claim);
  return { pair: g.id, gold: g.gold, pred: r.stance, confidence: r.confidence };
});

const result = computeF1(pairs);

console.log('\n=== STANCE F1 EVAL (phase8/stance-classifier.mjs) ===');
console.log('total_pairs:  ' + result.total_pairs);
console.log('accuracy:     ' + result.accuracy);
console.log('macro_f1:     ' + result.macro_f1);
console.log('');
console.log('Per-class:');
console.log('  ' + 'label'.padEnd(14) + ' | tp fp fn |  P    R    F1   support');
for (const [lab, m] of Object.entries(result.per_class)) {
  console.log('  ' + lab.padEnd(14) + ' | ' + String(m.tp).padStart(2) + ' ' + String(m.fp).padStart(2) + ' ' + String(m.fn).padStart(2) + ' | ' + m.precision.toFixed(3) + ' ' + m.recall.toFixed(3) + ' ' + m.f1.toFixed(3) + ' ' + m.support);
}
console.log('');
console.log('Predictions:');
for (const p of pairs) console.log('  ' + p.pair + ': gold=' + p.gold + ' pred=' + p.pred + ' conf=' + p.confidence.toFixed(3));

const PASS = result.macro_f1 >= 0.70;
console.log('\n' + (PASS ? 'PASS' : 'FAIL') + ' gate: macro_f1 >= 0.70 (M2)');

// 输出到 JSON 供报告引用
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.cwd(), 'data', 'stance-f1-eval.json'), JSON.stringify({
  evalAt: new Date().toISOString(),
  model: 'phase8/stance-classifier.mjs (rule-based)',
  goldSetSize: GOLD.length,
  ...result,
  pairs,
  gate: 'macro_f1 >= 0.70',
  pass: PASS,
}, null, 2));

process.exit(PASS ? 0 : 1);
