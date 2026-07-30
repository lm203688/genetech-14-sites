/* Anti-Scraping Protection v3.0 — GeneTech Knowledge Base
 *
 * 重构说明：
 * v2.0 的问题：
 *   - debugger 陷阱导致正常用户浏览器卡顿
 *   - DevTools 检测误伤开发者（窗口尺寸差>160px 即触发）
 *   - 右键禁用严重影响用户体验
 *   - 键盘快捷键拦截（Ctrl+U/S/A）过于激进
 *   - Canvas 指纹检测 headless 浏览器不可靠
 *   - 5秒无鼠标移动即弹遮罩层，误伤键盘导航用户
 *
 * v3.0 策略：
 *   - 移除所有影响正常用户的措施
 *   - 保留轻量级的蜜罐链接（用于识别恶意爬虫）
 *   - 反爬逻辑转移到服务端（API Gateway Worker）
 *   - 添加版权提示而非技术阻断
 */

(function () {
  'use strict';

  // 1. 蜜罐链接 — 仅对爬虫可见，用于识别恶意抓取
  //    真实用户永远不会看到或点击这些链接
  var honeypot = document.createElement('div');
  honeypot.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;';
  honeypot.innerHTML = '<a href="/api/honeypot.json" aria-hidden="true" tabindex="-1">download all data export admin</a>';
  document.body.appendChild(honeypot);

  // 如果有人点击蜜罐链接，记录到服务端
  honeypot.querySelector('a').addEventListener('click', function (e) {
    e.preventDefault();
    // 使用 navigator.sendBeacon 异步上报，不阻塞用户
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/honeypot.json', JSON.stringify({
        ua: navigator.userAgent,
        ts: Date.now(),
        ref: document.referrer
      }));
    }
    // 不做任何惩罚性重定向，避免误伤
  });

  // 2. 检测明显的 headless 浏览器特征（仅对确定性的特征检测）
  //    不再使用 window 尺寸差或鼠标移动等不可靠方法
  var headlessSignals = [];
  if (navigator.webdriver === true) headlessSignals.push('webdriver');
  if (window.__nightmare) headlessSignals.push('nightmare');
  if (window.domAutomation) headlessSignals.push('domAutomation');
  if (window.callPhantom) headlessSignals.push('phantom');

  if (headlessSignals.length > 0) {
    // 仅记录，不阻断 — 避免误伤
    console.warn('Headless browser detected:', headlessSignals.join(', '));
    // 可选：上报到服务端进行频率分析
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/bot-detected.json', JSON.stringify({
        signals: headlessSignals,
        ua: navigator.userAgent,
        ts: Date.now()
      }));
    }
  }

  // 3. 版权提示（替代右键禁用）
  //    当用户复制内容时，添加版权信息
  document.addEventListener('copy', function (e) {
    var selection = window.getSelection().toString();
    if (selection.length > 50) {
      // 仅对较长的复制添加版权信息
      var copyright = '\n\n— 来源: ' + window.location.href + '\n  GeneTech 知识引擎 © 2026';
      e.clipboardData.setData('text/plain', selection + copyright);
      e.preventDefault();
    }
  });

  // 4. 移除 v2.0 中所有激进的措施
  //    以下功能已被移除（保留注释作为提醒）：
  //    - document.addEventListener('contextmenu', ...) // 右键菜单 — 已移除
  //    - document.addEventListener('keydown', ...) // 键盘拦截 — 已移除
  //    - setInterval(check devtools, 1000) // DevTools 检测 — 已移除
  //    - setInterval(debugger, 3000) // debugger 陷阱 — 已移除
  //    - 5秒无鼠标移动弹遮罩 — 已移除

})();
