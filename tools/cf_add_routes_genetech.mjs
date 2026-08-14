// zone 变 active 后：给 genetech.tools 加两条 Worker 路由
//   license.genetech.tools/* -> genetech-license (unified-license)
//   api.genetech.tools/*     -> genetech-api-guard
import process from 'process';

const TOKEN = process.env.CF_TOKEN;
const ZONE = '7e0473d710a545e7f145651c8a02d721';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function cf(method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

// 1) 检查 zone 状态
const z = await cf('GET', `/zones/${ZONE}`);
console.log('[zone] status:', z.j.result?.status, '| reason:', z.j.result?.activation_failure_reason);
if (z.j.result?.status !== 'active') {
  console.log('✗ zone 仍非 active，无法加路由。请先在 Dashboard 把 NS 改为 jillian/osmar，待 zone 变 active 后再跑本脚本。');
  process.exit(2);
}

// 2) 列已有路由，避免重复
const existing = await cf('GET', `/zones/${ZONE}/workers/routes?per_page=100`);
const patterns = new Set((existing.j.result || []).map((r) => r.pattern));
console.log('[现有路由]', [...patterns].join(', ') || '(无)');

const want = [
  { pattern: 'license.genetech.tools/*', script: 'genetech-license' },
  { pattern: 'api.genetech.tools/*', script: 'genetech-api-guard' },
];

for (const r of want) {
  if (patterns.has(r.pattern)) {
    console.log(`• 路由已存在，跳过: ${r.pattern}`);
    continue;
  }
  const res = await cf('POST', `/zones/${ZONE}/workers/routes`, r);
  if (res.j.success) {
    console.log(`✓ 已添加路由: ${r.pattern} -> ${r.script}`);
  } else {
    console.log(`✗ 添加失败 ${r.pattern}:`, JSON.stringify(res.j.errors || res.j));
  }
}
console.log('\n下一步：重部署 Worker + 推 GitHub 触发 Pages 重建，然后实测 https://license.genetech.tools');
