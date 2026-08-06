/**
 * 虎皮椒 (xunhupay) 聚合支付客户端 —— 国内微信/支付宝收款通道
 *
 * 为国内用户提供 GUX_ 统一许可证的购买入口。流程：
 *   1) 前端调用 /api/hupijiao/create-order → 本模块向虎皮椒下单，返回二维码(url_qrcode) 与手机支付链接(url)
 *   2) 用户扫码/支付 → 虎皮椒异步 POST /api/hupijiao/callback（form 表单）
 *   3) 校验签名后，由 unified-license worker 签发 GUX_ 许可证（见 worker.js）
 *
 * 文档：https://cps.xunhupay.com/doc/api/pay.html
 *
 * 关键点：
 *   - Cloudflare Workers 没有原生 MD5（Web Crypto 仅支持 SHA 系列），
 *     因此本文件内置一个纯 JS 的 MD5 实现（与 Node crypto / PHP md5 结果一致）。
 *   - 签名规则（虎皮椒）：取所有非空参数（排除 hash），按参数名 ASCII 升序，
 *     拼成 key=value&key=value…，末尾【直接】接上 APPSECRET（无连接符），整体做 MD5（32 位小写）。
 */

// ============================================================================
// 纯 JS MD5（RFC 1321），输入为字符串，按 UTF-8 编码后计算，返回 32 位小写 hex。
// 算法与经典 blueimp/joseph-myers 实现一致；已用 Node crypto 校准。
// ============================================================================

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = (() => {
    const k = new Array(64);
    for (let i = 0; i < 64; i++) {
      k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    }
    return k;
  })();

  function add(x, y) {
    return (x + y) & 0xffffffff;
  }
  function rol(n, c) {
    return (n << c) | (n >>> (32 - c));
  }
  function cmn(q, a, b, x, ss, t) {
    a = add(add(a, q), add(x, t));
    return add(rol(a, ss), b);
  }
  function ff(a, b, c, d, x, ss, t) {
    return cmn((b & c) | (~b & d), a, b, x, ss, t);
  }
  function gg(a, b, c, d, x, ss, t) {
    return cmn((b & d) | (c & ~d), a, b, x, ss, t);
  }
  function hh(a, b, c, d, x, ss, t) {
    return cmn(b ^ c ^ d, a, b, x, ss, t);
  }
  function ii(a, b, c, d, x, ss, t) {
    return cmn(c ^ (b | ~d), a, b, x, ss, t);
  }

  const len = bytes.length;
  // 填充：补 0x80，再补 0 直到长度 ≡ 56 (mod 64)，最后 8 字节存 bit 长度（小端）
  const padded = len + 1;
  const total = ((padded + 8 + 63) & ~63);
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  // 64 位小端 bit 长度
  const bitLen = len * 8;
  msg[total - 8] = bitLen & 0xff;
  msg[total - 7] = (bitLen >>> 8) & 0xff;
  msg[total - 6] = (bitLen >>> 16) & 0xff;
  msg[total - 5] = (bitLen >>> 24) & 0xff;
  msg[total - 4] = Math.floor(bitLen / 0x100000000) & 0xff;

  let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;

  const x = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      x[i] =
        (msg[j] |
          (msg[j + 1] << 8) |
          (msg[j + 2] << 16) |
          (msg[j + 3] << 24)) | 0;
    }
    let a = a0, b = b0, c = c0, d = d0;
    let f, g;
    for (let i = 0; i < 64; i++) {
      if (i < 16) { f = ff; g = i; }
      else if (i < 32) { f = gg; g = (5 * i + 1) % 16; }
      else if (i < 48) { f = hh; g = (3 * i + 5) % 16; }
      else { f = ii; g = (7 * i) % 16; }
      // 先用原始 a,b,c,d 计算新 B，再做 (a,b,c,d) <- (d,a,b,c) 旋转
      const nb = f(a, b, c, d, x[g], s[i], K[i]);
      const tmp = d;
      d = c; c = b; b = nb; a = tmp;
    }
    a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
  }

  function hex(n) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return s;
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// ============================================================================
// 签名
// ============================================================================

/**
 * 虎皮椒签名：非空参数（排除 hash）按 key ASCII 升序拼成 key=value&...，末尾直接接 appSecret，MD5 小写。
 * @param {Record<string, any>} params 待签名参数（不含 hash）
 * @param {string} appSecret
 * @returns {string} 32 位小写 MD5
 */
function buildSign(params, appSecret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'hash' && params[k] !== '' && params[k] != null)
    .sort(); // ASCII 升序（字典序）
  let arg = '';
  for (const k of keys) {
    if (arg) arg += '&';
    arg += `${k}=${params[k]}`;
  }
  arg += appSecret; // 末尾直接拼接，无连接符
  return md5Hex(arg);
}

// ============================================================================
// 下单
// ============================================================================

const HUPIJIAO_GATEWAY = 'https://api.xunhupay.com/payment/do.html';
const HUPIJIAO_GATEWAY_BACKUP = 'https://api.dpweixin.com/payment/do.html';

/**
 * 向虎皮椒发起付款（创建订单）。
 * @param {object} o
 * @param {string} o.appId       支付渠道 APPID
 * @param {string} o.appSecret   支付渠道 APPSECRET
 * @param {string} o.tradeOrderId 商户订单号（唯一，[0-9a-zA-Z_-*]，≤32）
 * @param {string|number} o.totalFee 金额（元，decimal(18,2)，字符串如 "9.90"）
 * @param {string} o.title       订单标题（≤42 汉字，禁 %/表情）
 * @param {string} o.notifyUrl    异步回调地址
 * @param {string} [o.returnUrl]  支付成功跳转地址
 * @param {string} [o.attach]     透传备注（回调原样返回）
 * @param {boolean} [o.useBackup] 使用备用网关
 * @returns {Promise<{tradeOrderId:string, qrcode:?string, payUrl:?string}>}
 */
async function createHupijiaoOrder(o) {
  const params = {
    version: '1.1',
    appid: o.appId,
    trade_order_id: o.tradeOrderId,
    total_fee: o.totalFee,
    title: o.title,
    time: Math.floor(Date.now() / 1000),
    notify_url: o.notifyUrl,
    nonce_str: Math.random().toString(36).slice(2, 18),
  };
  if (o.returnUrl) params.return_url = o.returnUrl;
  if (o.attach) params.attach = o.attach;
  params.hash = buildSign(params, o.appSecret);

  const gateway = o.useBackup ? HUPIJIAO_GATEWAY_BACKUP : HUPIJIAO_GATEWAY;
  const resp = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await resp.json().catch(() => ({}));
  if (!data || data.errcode !== 0) {
    throw new Error(`虎皮椒下单失败: errcode=${data?.errcode} errmsg=${data?.errmsg}`);
  }
  return {
    tradeOrderId: o.tradeOrderId,
    qrcode: data.url_qrcode || null, // PC 端二维码图片地址（有效期 5 分钟）
    payUrl: data.url || null, // 手机端跳转地址
  };
}

// ============================================================================
// 回调校验
// ============================================================================

/**
 * 校验虎皮椒异步回调签名（常量时间比较）。
 * @param {Record<string, any>} params 回调参数（含 hash）
 * @param {string} appSecret
 * @returns {boolean}
 */
function verifyHupijiaoCallback(params, appSecret) {
  const got = params.hash;
  if (!got || typeof got !== 'string') return false;
  const expected = buildSign(params, appSecret);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export {
  md5Hex,
  buildSign,
  createHupijiaoOrder,
  verifyHupijiaoCallback,
  HUPIJIAO_GATEWAY,
  HUPIJIAO_GATEWAY_BACKUP,
};
