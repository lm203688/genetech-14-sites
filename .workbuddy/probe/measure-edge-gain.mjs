// 量「扩库填充清单」到底能新增几条跨站引用边。
// 算法必须这样走：遍历**源论文**（academic-entities 里带 references 的记录），
// 对每条引用声明 r，看 r 是不是在填充集合里；是的话，
// 源论文的站 vs 填充给的那个站，不同才算一条新边（同站自引本来就有）。
// 之前写成「拿填充 DOI 反查以它自己为源的记录」，算出来 0 条，纯属算错方向。
import fs from 'node:fs';
const norm = (v) => String(v ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').replace(/\s+/g, '').toLowerCase();
const ex = JSON.parse(fs.readFileSync('data/library-expand.json', 'utf8'));
const fills = Object.entries(ex.fills || {});
const doiToSite = new Map();
for (const [s, p] of fills) for (const t of p) { const d = norm(t.doi); if (!doiToSite.has(d)) doiToSite.set(d, { site: s, conf: t.confidence, margin: t.margin }); }
console.log('填充清单 ' + doiToSite.size + ' 条');

const aw = JSON.parse(fs.readFileSync('data/academic-entities.json', 'utf8'));
const recs = Array.isArray(aw) ? aw : (aw.entities || []);
const withRefs = recs.filter((e) => Array.isArray(e.references) && e.references.length);
console.log('源论文 ' + withRefs.length + ' 篇（带 references[]）');

let hitDecls = 0, newCross = 0, newSelf = 0;
const byConf = { high: 0, medium: 0 };
for (const e of withRefs) {
  const ss = (e.sites && e.sites[0]) || null;
  if (!ss || !e.doi) continue;
  for (const r of e.references) {
    const d = norm(r);
    const f = doiToSite.get(d);
    if (!f) continue;
    hitDecls++;
    byConf[f.conf] = (byConf[f.conf] || 0) + 1;
    if (f.site === ss) newSelf++; else newCross++;
  }
}
console.log('命中引用声明的填充条目 ' + hitDecls + ' 条（high ' + byConf.high + ' / medium ' + byConf.medium + '）');
console.log('→ 新增跨站边 ' + newCross + ' 条；同站自引不算 ' + newSelf + ' 条');
// 参照系：现有边总数 26,692（上一轮实测）
console.log('相对现有边 26692：+' + (100 * newCross / 26692).toFixed(2) + '%');
