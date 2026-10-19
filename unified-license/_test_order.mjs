/**
 * 一次性探针：用真实虎皮椒凭证发起一笔测试下单（金额 0.01 元，不支付不扣款），
 * 验证 凭证有效性 + 签名算法 + 能否拿到支付二维码/链接。
 * 凭证通过环境变量传入，不硬编码，避免泄露。
 */
import { createHupijiaoOrder } from './hupijiao.js';

const appId = process.env.HUPIJIAO_APP_ID;
const appSecret = process.env.HUPIJIAO_APP_SECRET;
if (!appId || !appSecret) {
  console.error('缺少 HUPIJIAO_APP_ID / HUPIJIAO_APP_SECRET 环境变量');
  process.exit(1);
}

const tradeOrderId =
  'GUX' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6);
const notifyUrl = 'https://license.genetech.tools/api/hupijiao/callback';
const returnUrl = 'https://license.genetech.tools/pay/success';

console.log('AppID:', appId);
console.log('trade_order_id:', tradeOrderId);
console.log('notify_url:', notifyUrl);
console.log('--- 发起下单 ---');

try {
  const order = await createHupijiaoOrder({
    appId,
    appSecret,
    tradeOrderId,
    totalFee: '0.01', // 测试金额 1 分
    title: 'GeneTech 探针订单',
    notifyUrl,
    returnUrl,
    attach: JSON.stringify({ plan: 'pro', email: 'probe@test.local' }),
  });
  console.log('下单成功 ✅');
  console.log(JSON.stringify(order, null, 2));
  console.log('--- 诊断 ---');
  console.log('二维码(PC):', order.qrcode || '(无)');
  console.log('支付链接(手机):', order.payUrl || '(无)');
} catch (e) {
  console.error('下单失败 ❌:', e.message);
  process.exit(2);
}
