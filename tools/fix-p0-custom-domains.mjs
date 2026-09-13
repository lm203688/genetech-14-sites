#!/usr/bin/env node
/**
 * fix-p0-custom-domains.mjs — P0 端点自定义域重绑（最小摩擦版）
 *
 * 背景：genetech-license / genetech-api-guard 两个 Worker 的自定义域
 * (license.swarmlabs.tools / api.swarmlabs.tools) 被 CF zone 绑定剥离导致 NXDOMAIN，
 * 支付链路 100% 不可用。Worker 本体存活，只需重绑自定义域。
 *
 * 本环境 cfut_ token 仅 zone 级（无 account Workers/Pages 写权），AI 无法自动跑。
 * 用法（用户侧，约 10 秒）：
 *   1. CF Dashboard（61960005@qq.com）→ My Profile → API Tokens → Create Token
 *      权限模板选 "Cloudflare Workers" + "Account:Cloudflare Pages"（或自定义勾
 *      Account > Workers Scripts > Edit、Account > Cloudflare Pages > Edit）
 *      适用 zone = swarmlabs.tools
 *   2. 复制 token，本地运行：
 *      CF_API_TOKEN=<粘贴> node tools/fix-p0-custom-domains.mjs
 *
 * 脚本自动：对两个 Worker 各 POST 自定义域，打印结果；任一失败给出 dashboard 兜底步骤。
 */
const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = '8162aa3b2241c132e43a81f526d7f758';
const ZONE = 'swarmlabs.tools';

if (!TOKEN) {
  console.error('✗ 未找到 CF_API_TOKEN 环境变量。请先生成含 Account:Workers Scripts + Cloudflare Pages 权限的 token。');
  process.exit(2);
}

const JOBS = [
  { script: 'genetech-license', host: 'license.swarmlabs.tools' },
  { script: 'genetech-api-guard', host: 'api.swarmlabs.tools' },
];

async function addCustomDomain({ script, host }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${script}/domains`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname: host, environment: 'production' }),
  });
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  return { res, j };
}

(async () => {
  let allOk = true;
  for (const job of JOBS) {
    process.stdout.write(`→ ${job.script} 重绑 ${job.host} ... `);
    try {
      const { res, j } = await addCustomDomain(job);
      if (res.ok && j.success) {
        console.log(`✓ 成功 (status=${j.result?.status || 'pending'})`);
      } else {
        allOk = false;
        console.log(`✗ 失败 HTTP ${res.status}`);
        console.log('  ', JSON.stringify(j.errors || j.raw || j).slice(0, 300));
      }
    } catch (e) {
      allOk = false;
      console.log(`✗ 异常 ${e.message}`);
    }
  }
  console.log('\n--- 验证 ---');
  console.log('DNS 生效后（约 1-5 分钟），运行：node .workbuddy/tools/endpoint-health-check.mjs');
  console.log('期望退出码 0。若仍 1，请在 CF Dashboard 手工重绑：');
  console.log('  Workers & Pages → genetech-license → Settings → Triggers → Custom Domains → Add license.swarmlabs.tools');
  console.log('  Workers & Pages → genetech-api-guard → Settings → Triggers → Custom Domains → Add api.swarmlabs.tools');
  process.exit(allOk ? 0 : 1);
})();
