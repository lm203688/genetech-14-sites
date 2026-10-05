// 量一下 30 站实体表到底满没满、还有多少 headroom（飞轮「扩库」的容量前提）
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const SD = ROOT;
const SITES = fs.readdirSync(SD).filter((d) => fs.statSync(path.join(SD, d)).isDirectory() && fs.existsSync(path.join(SD, d, 'website/api/entities.json')));
let tot = 0;
const rows = [];
for (const s of SITES) {
  const p = path.join(SD, s, 'website/api/entities.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.entities || []);
  const dois = new Set();
  for (const e of arr) { const d = String(e.doi || '').trim().toLowerCase(); if (d) dois.add(d); }
  rows.push({ site: s, entities: arr.length, doi: dois.size });
  tot += arr.length;
}
rows.sort((a, b) => b.entities - a.entities);
for (const r of rows) console.log(r.site.padEnd(22) + String(r.entities).padStart(8) + ' 实体 ' + String(r.doi).padStart(8) + ' DOI');
console.log('站点数 ' + rows.length + '  总实体 ' + tot);
