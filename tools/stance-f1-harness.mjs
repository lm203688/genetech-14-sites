#!/usr/bin/env node
// tools/stance-f1-harness.mjs — 立场检测 F1 harness
//
// 用途：给"实体间是否互相引用/支持/反驳"的判定提供可评测基线
// 输入:
//   1) 已知标注集（stance-entities.json 或 hand-annotated）
//   2) 待评测的预测（可以是规则或 LLM 输出）
// 输出:
//   precision / recall / f1 / per-class report
//
// 立场标签：
//   supports / contradicts / neutral / weakens
//
// 用法:
//   node tools/stance-f1-harness.mjs --gold <gold.json> --pred <pred.json>
//
// 文件格式:
//   { "pairs": [ { "pair": "A→B", "gold": "supports", "pred": "supports" }, ... ] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LABELS = ['supports', 'contradicts', 'neutral', 'weakens'];

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gold') opts.gold = argv[++i];
    else if (a === '--pred') opts.pred = argv[++i];
    else if (a === '--demo') opts.demo = true;
  }
  return opts;
}

function computeF1(pairs, labels = LABELS) {
  const perLabel = {};
  for (const lab of labels) perLabel[lab] = { tp: 0, fp: 0, fn: 0 };

  for (const p of pairs) {
    const gold = p.gold;
    const pred = p.pred;
    if (gold === pred) perLabel[gold].tp++;
    else {
      perLabel[pred].fp++;
      perLabel[gold].fn++;
    }
  }

  const perClass = {};
  let correct = 0;
  for (const lab of labels) {
    const { tp, fp, fn } = perLabel[lab];
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    perClass[lab] = {
      tp, fp, fn,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
      support: tp + fn,
    };
    correct += tp;
  }

  const total = pairs.length;
  const accuracy = total > 0 ? correct / total : 0;
  const macroF1 = labels.reduce((s, l) => s + perClass[l].f1, 0) / labels.length;
  return {
    total_pairs: total,
    correct: correct,
    accuracy: Math.round(accuracy * 1000) / 1000,
    macro_f1: Math.round(macroF1 * 1000) / 1000,
    per_class: perClass,
  };
}

function makeDemoPairs() {
  // 合成一个小型基线集：20 对，包含噪声
  const goldPairs = [
    { pair: 'A→B', gold: 'supports' }, { pair: 'C→D', gold: 'supports' },
    { pair: 'E→F', gold: 'supports' }, { pair: 'G→H', gold: 'supports' },
    { pair: 'I→J', gold: 'contradicts' }, { pair: 'K→L', gold: 'contradicts' },
    { pair: 'M→N', gold: 'contradicts' },
    { pair: 'O→P', gold: 'neutral' }, { pair: 'Q→R', gold: 'neutral' },
    { pair: 'S→T', gold: 'neutral' }, { pair: 'U→V', gold: 'neutral' },
    { pair: 'W→X', gold: 'neutral' },
    { pair: 'Y→Z', gold: 'weakens' }, { pair: 'A1→B1', gold: 'weakens' },
  ];
  // 85% 预测正确率 + 15% 随机噪声
  const withNoise = goldPairs.map((p, i) => {
    const noise = Math.random() < 0.15;
    const pred = noise
      ? LABELS[Math.floor(Math.random() * LABELS.length)]
      : p.gold;
    return { pair: p.pair, gold: p.gold, pred };
  });
  return withNoise;
}

function run() {
  const opts = parseArgs();

  if (opts.demo) {
    const pairs = makeDemoPairs();
    const r = computeF1(pairs);
    console.log(`\n=== STANCE F1 HARNESS (DEMO) ===`);
    console.log(`total_pairs:  ${r.total_pairs}`);
    console.log(`accuracy:     ${r.accuracy}`);
    console.log(`macro_f1:     ${r.macro_f1}`);
    console.log(`\nPer-class:`);
    console.log(`  ${'label'.padEnd(14)} | tp fp fn |  P    R    F1   support`);
    for (const [lab, m] of Object.entries(r.per_class)) {
      console.log(`  ${lab.padEnd(14)} | ${String(m.tp).padStart(2)} ${String(m.fp).padStart(2)} ${String(m.fn).padStart(2)} | ${m.precision.toFixed(3)} ${m.recall.toFixed(3)} ${m.f1.toFixed(3)} ${m.support}`);
    }
    return r;
  }

  if (!opts.gold || !opts.pred) {
    console.error('用法:');
    console.error('  node tools/stance-f1-harness.mjs --gold <gold.json> --pred <pred.json>');
    console.error('  node tools/stance-f1-harness.mjs --demo   # 跑合成基线');
    process.exit(1);
  }
  const gold = JSON.parse(fs.readFileSync(path.resolve(opts.gold), 'utf-8'));
  const pred = JSON.parse(fs.readFileSync(path.resolve(opts.pred), 'utf-8'));
  const goldMap = new Map((gold.pairs || gold).map(p => [p.pair, p.gold]));
  const merged = (pred.pairs || pred).map(p => ({ pair: p.pair, gold: goldMap.get(p.pair), pred: p.pred }));
  const r = computeF1(merged);
  console.log(JSON.stringify(r, null, 2));
  return r;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { run(); } catch (e) { console.error('✗', e); process.exit(1); }
}
