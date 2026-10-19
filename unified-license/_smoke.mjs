import { createHupijiaoOrder, verifyHupijiaoCallback, buildSign } from "./hupijiao.js";
const APPID = process.env.HPJ_APPID;
const SECRET = process.env.HPJ_SECRET;
const tradeOrderId = "GUXTEST" + Date.now().toString(36).toUpperCase();
try {
  const order = await createHupijiaoOrder({
    appId: APPID, appSecret: SECRET,
    tradeOrderId, totalFee: "0.01", title: "GeneTech 测试订单",
    notifyUrl: "https://example.com/api/hupijiao/callback",
    returnUrl: "https://example.com/pay/success",
    attach: JSON.stringify({ plan: "pro", email: "test@example.com" }),
  });
  console.log("ORDER_OK", JSON.stringify(order));
  const cb = {
    trade_order_id: tradeOrderId, total_fee: "0.01", transaction_id: "TX123",
    open_order_id: "HPJ123", order_title: "GeneTech 测试订单", status: "OD",
    plugins: "", attach: JSON.stringify({plan:"pro",email:"test@example.com"}),
    appid: APPID, time: String(Math.floor(Date.now()/1000)), nonce_str: "abc123",
  };
  cb.hash = buildSign(cb, SECRET);
  console.log("CALLBACK_SIGN_VERIFY:", verifyHupijiaoCallback(cb, SECRET));
} catch (e) {
  console.log("ORDER_FAIL", e.message);
}
