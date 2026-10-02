// 一次性审计：workflow 里点名的脚本，仓库里是否真的存在。
// 2026-10-02 摸底产物。用完可删，也可并入 tools/check-build-contract.mjs。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const files = new Set();
for (const wf of ['.github/workflows/ops.yml', '.github/workflows/ops-extra.yml']) {
  const t = fs.readFileSync(path.join(ROOT, wf), 'utf8');
  for (const m of t.matchAll(/run_one ([a-z0-9-]+)/g)) files.add('pipeline-' + m[1] + '.js');
  for (const m of t.matchAll(/SCRIPTS_DIR\/([A-Za-z0-9_.-]+\.(?:js|mjs|py))(?![A-Za-z0-9])/g)) files.add(m[1]);
  for (const m of t.matchAll(/node (?:tools|operations-plan)\/([A-Za-z0-9_.-]+\.(?:js|mjs|py))/g)) files.add(m[1]);
}

const exists = (f) => fs.existsSync(path.join(ROOT, 'operations-plan', f)) || fs.existsSync(path.join(ROOT, 'tools', f));
const missing = [...files].filter((f) => !exists(f)).sort();
const ok = [...files].filter(exists).sort();

console.log('workflow 点名脚本共 ' + files.size + ' 个');
console.log('\n存在 (' + ok.length + ')：\n  ' + ok.join(', '));
console.log('\n缺失 (' + missing.length + ')：\n  ' + missing.join('\n  '));
