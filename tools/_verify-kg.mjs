// scratch: 验证引用边合并后的图谱完整性（tools/_*.mjs 已 gitignore）
import fs from 'node:fs';

const kg = JSON.parse(fs.readFileSync('data/knowledge-graph.json', 'utf8'));
const ids = new Set(kg.nodes.map((n) => n.id));
const rel = {};
for (const e of kg.edges) rel[e.relation] = (rel[e.relation] || 0) + 1;

let dangling = 0;
for (const e of kg.edges) if (!ids.has(e.source) || !ids.has(e.target)) dangling++;

const stub = kg.nodes.filter((n) => n.kind === 'doi-stub');
const stubWithSites = stub.filter((n) => Array.isArray(n.sites) && n.sites.length);

console.log('nodes      ', kg.nodes.length);
console.log('edges      ', kg.edges.length);
console.log('relations  ', JSON.stringify(rel));
console.log('dangling   ', dangling, dangling === 0 ? 'OK' : 'FAIL');
console.log('stubs      ', stub.length, '| with sites:', stubWithSites.length);
console.log('stats      ', JSON.stringify(kg.stats));
console.log('kb/kg twins identical:',
  fs.readFileSync('data/knowledge-graph.json').equals(fs.readFileSync('data/knowledge-graph-entities.json')) ? 'YES' : 'NO');
console.log('baseline untouched:', JSON.parse(fs.readFileSync('data/knowledge-graph-baseline.json', 'utf8')).nodes === 14356 ? 'YES' : 'NO');
