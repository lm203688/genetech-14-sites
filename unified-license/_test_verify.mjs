/**
 * 一次性探针：验证虎皮椒回调验签算法能否正确识别真实回调（含篡改拒绝）。
 * 凭证通过环境变量传入，不硬编码。
 */
import { buildSign, verifyHupijiaoCallback } from './hupijiao.js';

const appId = process.env.HUPIJIAO_APP_ID;
const appSecret = process.env.HUPIJIAO_APP_SECRET;
if (!appId || !appSecret) {
  console.error('缺少 HUPIJIAO_APP_ID / HUPIJIAO_APP_SECRET 环境变量');
  process.exit(1);
}

// 模拟虎皮椒异步回调（典型字段，status=OD 表示已支付）
const cb = {
  appid: appId,
  trade_order_id: 'GUXMSMN06JJdf92',
  total_fee: '0.01',
  status: 'OD',
  pay_time: String(Math.floor(Date.now() / 1000)),
  openid: 'oXxxxxxxxxxxxxxxx',
};
cb.hash = buildSign(cb, appSecret);

console.log('1) 正确签名验签（期望 true）:', verifyHupijiaoCallback(cb, appSecret));

// 篡改金额，hash 仍是旧的 → 应被拒绝
const tampered = { ...cb, total_fee: '0.02' };
console.log('2) 篡改参数后验签（期望 false）:', verifyHupijiaoCallback(tampered, appSecret));

// 用错误密钥验签 → 应被拒绝
console.log('3) 错误密钥验签（期望 false）:', verifyHupijiaoCallback(cb, 'wrong-secret'));
