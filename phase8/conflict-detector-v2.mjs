// phase8/conflict-detector-v2.mjs
// Conflict Detector v2 - 冲突检测器 v2
//
// 目标：从 v1 的 numeric-conflict 升级到三类冲突：
//   1. numeric-conflict:  数值冲突（同指标、不同数字）
//   2. temporal-conflict: 时间冲突（同事件、不同年份）
//   3. semantic-conflict: 语义冲突（矛盾主张）
//
// 使用：
//   node phase8/conflict-detector-v2.mjs --site robot-parts --limit 200

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

import { extractEvidence } from './evidence-engine.mjs';

// 冲突指标键：常见学术指标同义词
const METRIC_SYNONYMS = {
  accuracy: ['accuracy', 'acc', 'f1', 'precision', 'recall'],
  speed: ['speed', 'faster', 'throughput', 'latency', 'ms', 'fps'],
  cost: ['cost', 'price', 'cheaper', 'expensive', '$', 'usd'],
  size: ['size', 'parameters', 'model', 'mb', 'gb', 'million'],
  efficiency: ['efficiency', 'energy', 'watt', 'power'],
  error: ['error', 'loss', 'mse', 'rmse'],
};

function extractNumbers(text) {
  return (String(text).match(/-?\d+\.?\d*/g) || []).map(Number).filter(n => !isNaN(n));
}

function extractYears(text) {
  return (String(text).match(/\b(19|20)\d{2}\b/g) || []).map(Number);
}

function sharedTopicWords(a, b) {
  const stop = new Set(['the', 'and', 'this', 'that', 'with', 'from', 'have', 'has', 'is', 'are', 'of', 'in', 'on', 'to', 'for', 'by', 'a', 'an', 'was', 'were', 'be', 'been']);
  const tokenize = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 4 && !stop.has(w));
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  return [...sa].filter(w => sb.has(w));
}

function classifyMetric(num) {
  for (const [k, syns] of Object.entries(METRIC_SYNONYMS)) {
    if (syns.some(s => String(num).toLowerCase().includes(s))) return k;
  }
  return null;
}

export function detectConflictsV2(evsA, evsB, entityA, entityB) {
  const conflicts = [];
  if (!evsA || !evsB) return conflicts;

  for (const a of evsA) {
    for (const b of evsB) {
      const shared = sharedTopicWords(a.text, b.text);
      if (shared.length < 2) continue;

      // 1. 数值冲突
      if (a.type === 'abstract-numeric' || b.type === 'abstract-numeric') {
        const numsA = extractNumbers(a.text);
        const numsB = extractNumbers(b.text);
        if (numsA.length > 0 && numsB.length > 0) {
          const different = numsA.filter(n => !numsB.includes(n));
          if (different.length > 0 && numsA.length <= 5 && numsB.length <= 5) {
            // 同量级但不同值（相差 <3x）算 numeric conflict
            const overlap = numsA.filter(n => numsB.some(m => Math.abs(n - m) / Math.max(1, Math.abs(n)) < 0.5)).length;
            if (overlap > 0) {
              conflicts.push({
                type: 'numeric-conflict',
                textA: a.text, textB: b.text,
                numbersA: numsA, numbersB: numsB,
                sharedContext: shared.slice(0, 5),
                severity: overlap >= 2 ? 'high' : 'medium',
                entityA: entityA?.id, entityB: entityB?.id,
              });
            }
          }
        }
      }

      // 2. 时间冲突
      if ((a.type === 'metadata-date' || a.type === 'abstract-lead') &&
          (b.type === 'metadata-date' || b.type === 'abstract-lead')) {
        const yearsA = extractYears(a.text);
        const yearsB = extractYears(b.text);
        if (yearsA.length > 0 && yearsB.length > 0) {
          const gap = Math.abs(yearsA[0] - yearsB[0]);
          if (gap >= 5 && shared.length >= 3) {
            conflicts.push({
              type: 'temporal-conflict',
              textA: a.text, textB: b.text,
              yearsA, yearsB, gap,
              sharedContext: shared.slice(0, 5),
              severity: gap >= 10 ? 'high' : 'medium',
              entityA: entityA?.id, entityB: entityB?.id,
            });
          }
        }
      }

      // 3. 语义冲突：同主题但一正一负
      const negWords = ['not', 'fail', 'denied', 'reject', 'contradict', 'refut', 'unreliable', 'incorrect', 'wrong'];
      const posWords = ['show', 'demonstrate', 'prove', 'confirm', 'improve', 'achiev', 'success'];
      const aNeg = negWords.filter(w => a.text.toLowerCase().includes(w)).length;
      const aPos = posWords.filter(w => a.text.toLowerCase().includes(w)).length;
      const bNeg = negWords.filter(w => b.text.toLowerCase().includes(w)).length;
      const bPos = posWords.filter(w => b.text.toLowerCase().includes(w)).length;
      if ((aNeg >= 1 && bPos >= 1) || (aPos >= 1 && bNeg >= 1)) {
        if (shared.length >= 2) {
          conflicts.push({
            type: 'semantic-conflict',
            textA: a.text, textB: b.text,
            signalsA: { neg: aNeg, pos: aPos },
            signalsB: { neg: bNeg, pos: bPos },
            sharedContext: shared.slice(0, 5),
            severity: 'medium',
            entityA: entityA?.id, entityB: entityB?.id,
          });
        }
      }
    }
  }
  return conflicts;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { site: null, limit: 200, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') opts.site = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.site) {
    console.error('Usage: node phase8/conflict-detector-v2.mjs --site robot-parts --limit 200');
    process.exit(1);
  }
  const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
  let d;
  if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
  else { console.error('data not found for ' + opts.site); process.exit(1); }
  const entities = (Array.isArray(d) ? d : (d.entities || [])).slice(0, opts.limit);

  const evidences = {};
  for (const e of entities) {
    evidences[e.id] = extractEvidence(e);
  }

  const conflicts = [];
  const typeCount = { 'numeric-conflict': 0, 'temporal-conflict': 0, 'semantic-conflict': 0 };
  const severityCount = { high: 0, medium: 0, low: 0 };

  // 全对检测（O(n^2) 上限）
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < Math.min(i + 20, entities.length); j++) {
      const cfs = detectConflictsV2(evidences[entities[i].id], evidences[entities[j].id], entities[i], entities[j]);
      for (const c of cfs) {
        typeCount[c.type] = (typeCount[c.type] || 0) + 1;
        severityCount[c.severity] = (severityCount[c.severity] || 0) + 1;
        conflicts.push(c);
      }
    }
  }

  const out = {
    site: opts.site,
    entityCount: entities.length,
    pairCount: entities.length * (entities.length - 1) / 2,
    conflictCount: conflicts.length,
    byType: typeCount,
    bySeverity: severityCount,
    sampleConflicts: conflicts.slice(0, 20),
  };
  const outPath = opts.out || path.join(ROOT, 'data', `conflicts-v2-${opts.site}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('OK ' + opts.site + ': ' + conflicts.length + ' conflicts');
  console.log('  byType: ' + JSON.stringify(typeCount));
  console.log('  bySeverity: ' + JSON.stringify(severityCount));
  console.log('  output: ' + outPath);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(1); });
}
