
const delaysSeen = [];
export async function persist(KV, tradeOrderId, plan, email, channel) {
  // ★ 顺序很重要：block 第一行就是 if (env.UNIFIED_LICENSES)，
  //   env 必须先定义，否则 TDZ（ReferenceError，本仓库已栽过多次）。
  //   plan / email / channel 也是原handler 的形参/局部变量，一并补齐。
  const env = { UNIFIED_LICENSES: KV };
  let orderPersisted = false;
  let persistError = null;
  if (env.UNIFIED_LICENSES) {
    const payload = JSON.stringify({
      plan,
      email,
      channel: channel.key,
      status: 'pending',
      license_key: null,
      created: new Date().toISOString(),
    });
    // KV 写失败多数是**瞬时**的（写配额按秒级窗口抖动、KV 节点刚扩容）。
    // 直接放弃会让用户白等一个回调周期，所以做有限退避重试：
    // 3 次（0 / 150 / 450ms），总代价<1s，远小于用户感知。
    // 注意：只对「像是限流/暂时性」的错误重试，格式类错误立刻放弃。
    const RETRYABLE = /429|rate|limit|timeout|unavailable|internal|reset|try again/i;
    const delays = [0, 150, 450];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      try {
        await env.UNIFIED_LICENSES.put(`hupijiao:${tradeOrderId}`, payload, {
          // TTL 与二维码有效期（5 分钟）对齐并留余量：记录比码活得久一点，
          // 避免用户在码过期瞬间付款，回调重建时又找不到任何上下文。
          expirationTtl: 3600,
        });
        orderPersisted = true;
        persistError = null;
        break;
      } catch (e) {
        persistError = String((e && e.message) || e);
        if (!RETRYABLE.test(persistError)) {
          console.error('[hupijiao] 待支付订单写入失败（非瞬时错误，不重试）:', persistError);
          break;
        }
        console.warn(
          `[hupijiao] 待支付订单写入失败（第 ${attempt + 1} 次，退避重试）:`,
          persistError
        );
      }
    }
  } else {
    persistError = 'UNIFIED_LICENSES 绑定缺失';
    console.error('[hupijiao] UNIFIED_LICENSES 绑定不存在，订单无法落库，仅靠回调重建');
  }

  try {
    const order = await createHupijiaoOrder({
      appId: channel.appid,
      appSecret: channel.appsecret,
      tradeOrderId,
      totalFee,
      title,
      notifyUrl,
      returnUrl,
      attach: JSON.stringify({ plan, email: email || '' }),
    });
    return json(
      {
        success: true,
        trade_order_id: tradeOrderId,
        qrcode: order.qrcode, // PC 端二维码图片地址（有效期 5 分钟）
        pay_url: order.payUrl, // 手机端跳转地址
        plan,
        total_fee: totalFee,
        expires_in: 300,
        // 订单是否已落 KV。false = 前端必须改用「付款后异步确认」文案，
        // 不能让用户因为轮询 404 误判支付失败而重复下单。
        order_persisted: orderPersisted,
        confirm_mode: orderPersisted ? 'poll' : 'async',
        ...(orderPersisted ? {} : { persist_error: persistError }),
      },
      200,
      corsH
    );
  } catch (e) {
    console.error('[hupijiao] 下单失败:', e.message);
    return err('create_order_failed', e.message, 502, corsH);
  }
}

/**
 * 虎皮椒异步回调（form 表单）。验签后：OD=已支付→签发 GUX_；CD=已退款→吊销。
 * 无论结果都必须返回纯文本 "success"，否则虎皮椒会重试 6 次。
 */
async function handleHupijiaoCallback(request, env, corsH) {
  let params = {};
  try {
    const form = await request.formData();
    for (const [k, v] of form.entries()) params[k] = v;
  } catch {
    return new Response('success', { status: 200 });
  }

  const channels = getHupijiaoChannels(env);
  const channel =
    channels.find((c) => c.appid === params.appid) || channels[0];
  // 验签失败也返回 success，避免无意义的重试风暴（但不签发许可证）
  if (!channel || !verifyHupijiaoCallback(params, channel.appsecret)) {
    console.warn('[hupijiao] 回调签名校验失败或通道缺失，忽略:', params.appid);
    return new Response('success', { status: 200 });
  }

  const tradeOrderId = params.trade_order_id;
  if (!tradeOrderId || !env.UNIFIED_LICENSES) {
    return new Response('success', { status: 200 });
  }
  let order = null;
  const orderRaw = await env.UNIFIED_LICENSES.get(`hupijiao:${tradeOrderId}`);
  if (orderRaw) {
    order = JSON.parse(orderRaw);
  } else {
    // 2026-09-23: 待支付记录缺失（下单时 KV 配额耗尽被守卫跳过）时，
    // 从虎皮椒原样回传的 attach 重建订单，保证已付款用户仍能拿到许可证。
    let att = {};
    try { att = JSON.parse(params.attach || '{}'); } catch (e) { att = {}; }
    if (att && att.plan && PLANS[att.plan]) {
      order = {
        plan: att.plan,
        email: att.email || null,
        channel: channel.key || 'default',
        status: 'pending',
        license_key: null,
        created: new Date().toISOString(),
      };
      console.warn('[hupijiao] 待支付记录缺失，已从 attach 重建:', tradeOrderId);
    } else {
      return new Response('success', { status: 200 });
    }
  }

  if (params.status === 'OD') {
    if (!order.license_key) {
      // 2026-09-23: 签发含多次 KV 写；配额耗尽时必须返回非 success，
      // 让虎皮椒按官方语义重试（最多 6 次），宁可重试不可吞单。
      try {
        const issued = await issueLicense(env, {
          plan: order.plan,
          email: order.email,
          hupijiao_order_id: tradeOrderId,
          source: 'hupijiao',
        });
        const key = issued.key;
        order.license_key = key;
        order.status = 'paid';
        // 支付成功后保留 24 小时，便于查询/排障
        try {
          await env.UNIFIED_LICENSES.put(`hupijiao:${tradeOrderId}`, JSON.stringify(order), {
            expirationTtl: 86400,
          });
        } catch (e) {
          console.warn('[hupijiao] 订单状态回写失败（许可证本身已签发）:', e && e.message);
        }
        console.log(`[hupijiao] 统一许可证已发放: ${order.plan} -> ${key.slice(0, 12)}...`);
      } catch (e) {
        console.error('[hupijiao] 签发失败，等待虎皮椒重试:', e && (e.stack || e.message));
        return new Response('issue_failed_retry', { status: 500 });
      }
    }
  } else if (params.status === 'CD') {
    // 退款：吊销已签发的许可证
    if (order.license_key) {
      await revokeLicense(env, order.license_key, 'hupijiao:refund');
    }
  }

  return new Response('success', { status: 200 });
}

/**
 * 查询虎皮椒订单状态与已签发的许可证（供前端轮询）。
 */
async function handleHupijiaoOrderQuery(request, url, env, corsH) {
  const tradeOrderId = url.searchParams.get('trade_order_id') || '';
  if (!tradeOrderId) return err('missing_trade_order_id', '请提供 trade_order_id', 400, corsH);
  if (!env.UNIFIED_LICENSES) return err('server_misconfigured', 'KV 不可用', 500, corsH);
  const raw = await env.UNIFIED_LICENSES.get(`hupijiao:${tradeOrderId}`);
  if (!raw) {
    // 2026-10-05：这里原来返 404，前端 poll() 的 .then 直接忽略 status，
    // 于是「订单没落库」和「支付失败」在用户眼里完全一样 → 重复下单。
    // 现在用 202 + status:'unknown' 明说「还没确认，可能尚未支付，
    // 也可能订单未落库（KV 配额），付款后由回调异步签发，请勿重复下单」。
    return json(
      {
        success: false,
        status: 'unknown',
        // pending  = 已落库、尚未收到支付回调
        // no_record = 订单没落库（KV 写失败），只能靠回调重建
        reason: 'no_record',
        message: '订单记录未落库，付款后由回调异步签发许可证，请勿重复下单。',
        license_key: null,
      },
      202,
      corsH
    );
  }
  const order = JSON.parse(raw);
  return json(
    {
      success: true,
      status: order.status,
      plan: order.plan,
      license_key: order.license_key || null,
    },
    200,
    corsH
  );
}

// ============================================================================
// 请求处理器
// ============================================================================

async function handleValidate(env, body, corsH) {
  const key = (body.key || body.license_key || '').trim();
  const siteName = (body.site_name || body.site || '').trim();
  if (!key) return err('missing_key', '请提供 key', 400, corsH);
  const result = await validateLicense(env, key, siteName || null);
  if (!result.valid) {
    // 统一返回 200，由 valid 字段判断，便于客户端处理
    return json(result, 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleRedeem(env, body, corsH) {
  const key = (body.key || body.license_key || '').trim();
  const siteName = (body.site_name || body.site || '').trim();
  const siteDomain = (body.site_domain || body.domain || '').trim();
  if (!key) return err('missing_key', '请提供 key', 400, corsH);
  if (!siteName) return err('missing_site', '请提供 site_name', 400, corsH);
  const result = await redeemLicense(env, key, siteName, siteDomain || null);
  if (!result.valid) {
    return json(result, 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleStatus(request, env, url, corsH) {
  const key = url.searchParams.get('key') || '';
  if (!key) return err('missing_key', '请提供 key 参数', 400, corsH);
  const result = await validateLicense(env, key, null);
  if (!result.valid) {
    return json(result, result.error === 'license_not_found' ? 404 : 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleIssue(request, rawBody, body, env, corsH) {
  const admin = await verifyAdmin(request, rawBody, env, corsH);
  if (!admin.ok) return admin.error;

  const plan = (body.plan || '').trim();
  if (!PLANS[plan]) {
    return err(
      'invalid_plan',
      `无效套餐: ${plan}（可选: starter / pro / lifetime）`,
      400,
      corsH
    );
  }
  const email = body.email ? String(body.email).trim() : null;

  const { license, key } = await issueLicense(env, {
    plan,
    email,
    expires: body.expires || null,
    source: body.source || 'admin_issue',
  });

  return json(
    {
      success: true,
      message: '统一许可证已发行',
      license_key: key,
      plan,
      plan_name: license.plan_name,
      credits_total: license.credits_total === -1 ? 'unlimited' : license.credits_total,
      expires: license.expires,
      created: license.created,
    },
    201,
    corsH
  );
}

// ============================================================================
// 路由分发
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return corsResponse(request, env);
    }

    const corsH = corsHeaders(request, env);

    try {
      // 健康检查（不限速）
      if ((path === '/' || path === '/health') && method === 'GET') {
        return json(
          {
            service: 'genetech-unified-license',
            status: 'ok',
            version: '2.0',
            time: new Date().toISOString(),
          },
          200,
          corsH
        );
      }

      // 速率限制（管理员、虎皮椒回调路径豁免，由各自鉴权/签名保护）
      const isAdminPath = path.startsWith('/api/admin/');
      const isWebhookPath = path === '/api/hupijiao/callback';
      if (!isAdminPath && !isWebhookPath) {
        const ip = getClientIp(request);
        const rl = await checkRateLimit(env, ip);
        if (!rl.allowed) {
          return err(
            'rate_limited',
            '请求过于频繁，请稍后再试（限制 10 次/分钟/IP）',
            429,
            corsH,
            { 'Retry-After': String(rl.retryAfter) }
          );
        }
      }

      // ---- GET 路由 ----
      if (method === 'GET') {
        if (path === '/api/license/status') {
          return handleStatus(request, env, url, corsH);
        }
        if (path === '/api/hupijiao/order') {
          return handleHupijiaoOrderQuery(request, url, env, corsH);
        }
        return err('not_found', `未知路由: ${method} ${path}`, 404, corsH);
      }

      // ---- POST 路由 ----
      if (method === 'POST') {
        // 虎皮椒异步回调（form 表单，非 JSON），需最先匹配
        if (path === '/api/hupijiao/callback') {
          return handleHupijiaoCallback(request, env, corsH);
        }

        const rawBody = await request.text();

        // 解析 JSON
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return err('bad_request', '请求体必须是 JSON', 400, corsH);
        }

        if (path === '/api/license/validate') {
          return handleValidate(env, body, corsH);
        }
        if (path === '/api/license/redeem') {
          return handleRedeem(env, body, corsH);
        }
        if (path === '/api/hupijiao/create-order') {
          return handleHupijiaoCreateOrder(request, rawBody, body, env, corsH);
        }
        if (path === '/api/admin/issue') {
          return handleIssue(request, rawBody, body, env, corsH);
        }

        return err('not_found', `未知路由: ${method} ${path}`, 404, corsH);
      }

      return err('method_not_allowed', `不支持的方法: ${method}`, 405, corsH);
    } catch (e) {
      console.error('[license] 未捕获错误:', e);
      return err('internal_error', e.message || '服务器内部错误', 500, corsH);
    }
  },
}
  return { orderPersisted, persistError };
}
