/*
 * point-guide.js — GeneTech 知识引擎「指向式引导」组件（零依赖，浏览器原生）
 *
 * 借鉴自 heyclicky（farzaa/clicky，MIT）的 Visual Cursor Pointing 思想：
 *   模型/内容用坐标标签把"该看哪里"告诉前端，前端驱动一个光标飞过去指着。
 * 本移植做 Web-native 适配：
 *   - 不依赖 macOS ScreenCaptureKit / Computer Use API，改为绑定真实 DOM 元素 id
 *     （响应式，每次重算坐标，比 heyclicky 的绝对像素更稳）；
 *   - 内容作者用声明式属性或轻量内联标记即可，无需截图推理。
 *
 * 用法（引导式，推荐）：
 *   <div class="point-guide">
 *     <button data-target="#search" data-label="在这里输入关键词，回车做混合检索">步骤一</button>
 *     <button data-target="#ask"    data-label="进入 AI 问答，答案带参考来源">步骤二</button>
 *   </div>
 *   脚本会自动注入「▶ 开始引导」按钮；点击后光标依次飞到各目标并弹气泡。
 *
 * 用法（内联式，适合教程正文）：
 *   在任意带 data-point-inline 的容器里写 [[指向:#id|说明文字]]，
 *   会被替换为可点击的「指向」徽标，点击即单步指向。
 *
 * 无标记页面：脚本加载后直接 return，零副作用。
 */
(function () {
  'use strict';

  var THEME = '#0b62d6';

  function injectCSS() {
    if (document.getElementById('pg-style')) return;
    var css =
      '.pg-btn{display:inline-flex;align-items:center;gap:6px;margin:10px 0;padding:8px 14px;' +
      'border:0;border-radius:10px;background:' + THEME + ';color:#fff;font-size:14px;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(11,98,214,.35)}' +
      '.pg-btn:hover{filter:brightness(1.06)}' +
      '.pg-cursor{position:fixed;left:0;top:0;z-index:2147483600;pointer-events:none;' +
      'transition:transform .55s cubic-bezier(.22,.61,.36,1);will-change:transform;filter:drop-shadow(0 3px 5px rgba(0,0,0,.35))}' +
      '.pg-cursor .pg-ring{transform-origin:center;animation:pgpulse 1.4s ease-out infinite}' +
      '@keyframes pgpulse{0%{transform:scale(.6);opacity:.7}70%{transform:scale(1.8);opacity:0}100%{opacity:0}}' +
      '.pg-bubble{position:fixed;z-index:2147483601;max-width:280px;padding:10px 14px;border-radius:12px;' +
      'background:#fff;color:#1a2233;font-size:14px;line-height:1.5;box-shadow:0 10px 30px rgba(11,30,60,.22);' +
      'border:1px solid rgba(11,98,214,.25);opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s;' +
      'pointer-events:auto}' +
      '.pg-bubble.show{opacity:1;transform:translateY(0)}' +
      '.pg-bubble .pg-actions{margin-top:8px;display:flex;gap:10px;align-items:center;font-size:13px}' +
      '.pg-bubble .pg-next{color:' + THEME + ';cursor:pointer;font-weight:600}' +
      '.pg-bubble .pg-skip{color:#8a93a3;cursor:pointer}' +
      '.pg-target{outline:3px solid ' + THEME + '!important;outline-offset:3px;border-radius:6px;' +
      'transition:outline-color .2s;animation:pgglow 1.2s ease-in-out infinite}' +
      '@keyframes pgglow{0%,100%{box-shadow:0 0 0 0 rgba(11,98,214,.0)}50%{box-shadow:0 0 0 6px rgba(11,98,214,.18)}}' +
      '.pg-inline{color:' + THEME + ';border-bottom:1.5px dotted ' + THEME + ';cursor:pointer;font-weight:600}';
    var s = document.createElement('style');
    s.id = 'pg-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function cursorHTML() {
    return (
      '<svg class="pg-cursor" width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle class="pg-ring" cx="8" cy="7" r="6" fill="none" stroke="' + THEME + '" stroke-width="2"/>' +
      '<path d="M5 3 L5 20 L10 15 L13.5 22 L16.5 21 L13 14.5 L20 14.5 Z" ' +
      'fill="' + THEME + '" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/>' +
      '</svg>'
    );
  }

  function getEl(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function Guide(root) {
    this.root = root;
    this.steps = Array.prototype.slice.call(root.querySelectorAll('[data-target]'));
    this.cursor = null;
    this.bubble = null;
    this.index = -1;
    this.timer = null;
    this.active = false;
    this.autoplay = root.getAttribute('data-auto') !== 'false';
    this._ensureButton();
  }

  Guide.prototype._ensureButton = function () {
    var existing = this.root.querySelector('.pg-btn');
    if (existing) {
      existing.addEventListener('click', this.start.bind(this));
      return;
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pg-btn';
    btn.innerHTML = '▶ 开始引导';
    btn.addEventListener('click', this.start.bind(this));
    this.root.insertBefore(btn, this.root.firstChild);
  };

  Guide.prototype._ensureOverlay = function () {
    if (!this.cursor) {
      var wrap = document.createElement('div');
      wrap.innerHTML = cursorHTML();
      this.cursor = wrap.firstChild;
      document.body.appendChild(this.cursor);
    }
    if (!this.bubble) {
      this.bubble = document.createElement('div');
      this.bubble.className = 'pg-bubble';
      document.body.appendChild(this.bubble);
    }
  };

  Guide.prototype.start = function () {
    if (!this.steps.length) return;
    injectCSS();
    this._ensureOverlay();
    this.active = true;
    var self = this;
    this._onResize = function () { if (self.active && self.index >= 0) self._place(self.index, true); };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('scroll', this._onResize, true);
    this.goTo(0);
  };

  Guide.prototype.goTo = function (i) {
    if (i >= this.steps.length) return this.finish();
    this.index = i;
    this._place(i, false);
    var self = this;
    clearTimeout(this.timer);
    if (this.autoplay) {
      this.timer = setTimeout(function () { self.next(); }, 3000);
    }
  };

  Guide.prototype._place = function (i, instant) {
    var step = this.steps[i];
    var sel = step.getAttribute('data-target');
    var target = getEl(sel);
    if (!target) { this.next(); return; }
    document.querySelectorAll('.pg-target').forEach(function (n) { n.classList.remove('pg-target'); });
    target.classList.add('pg-target');
    target.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    var r = target.getBoundingClientRect();
    var cx = Math.max(8, r.left + 14);
    var cy = Math.max(8, r.top + 6);
    if (instant && this.cursor) {
      this.cursor.style.transition = 'none';
      this.cursor.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';
      // 强制重排后恢复过渡
      void this.cursor.offsetWidth;
      this.cursor.style.transition = '';
    } else if (this.cursor) {
      this.cursor.style.transform = 'translate(' + cx + 'px,' + cy + 'px)';
    }
    var label = step.getAttribute('data-label') || step.textContent || '';
    if (this.bubble) {
      var last = i === this.steps.length - 1;
      this.bubble.innerHTML =
        '<div>' + label + '</div>' +
        '<div class="pg-actions">' +
        (last ? '' : '<span class="pg-next">下一步 ›</span>') +
        '<span class="pg-skip">✕ 跳过</span>' +
        '</div>';
      var bw = 280;
      var bx = cx + 34;
      var by = cy + 14;
      if (bx + bw > window.innerWidth - 12) bx = Math.max(12, cx - bw - 10);
      this.bubble.style.left = bx + 'px';
      this.bubble.style.top = by + 'px';
      this.bubble.classList.add('show');
      var self = this;
      var nx = this.bubble.querySelector('.pg-next');
      var sk = this.bubble.querySelector('.pg-skip');
      if (nx) nx.onclick = function () { self.next(); };
      if (sk) sk.onclick = function () { self.stop(); };
    }
  };

  Guide.prototype.next = function () {
    if (this.index + 1 < this.steps.length) this.goTo(this.index + 1);
    else this.finish();
  };

  Guide.prototype.finish = function () {
    if (this.bubble) {
      this.bubble.innerHTML = '<div>✅ 引导完成。这就是 GeneTech 知识引擎的核心交互。</div>' +
        '<div class="pg-actions"><span class="pg-skip">关闭</span></div>';
      var self = this;
      var sk = this.bubble.querySelector('.pg-skip');
      if (sk) sk.onclick = function () { self.stop(); };
    }
    clearTimeout(this.timer);
    var self2 = this;
    this.timer = setTimeout(function () { self2.stop(); }, 2600);
  };

  Guide.prototype.stop = function () {
    this.active = false;
    clearTimeout(this.timer);
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('scroll', this._onResize, true);
    }
    document.querySelectorAll('.pg-target').forEach(function (n) { n.classList.remove('pg-target'); });
    if (this.cursor) this.cursor.remove();
    if (this.bubble) this.bubble.remove();
    this.cursor = null;
    this.bubble = null;
    this.index = -1;
  };

  function scanInline(root) {
    var hosts = root
      ? [root]
      : Array.prototype.slice.call(document.querySelectorAll('[data-point-inline]'));
    hosts.forEach(function (host) {
      var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      var n;
      while ((n = walker.nextNode())) {
        if (n.parentNode && n.parentNode.closest && n.parentNode.closest('.pg-inline, .point-guide, script, style')) continue;
        if (/\[\[指向:/.test(n.nodeValue)) nodes.push(n);
      }
      nodes.forEach(function (textNode) {
        var frag = document.createDocumentFragment();
        var parts = textNode.nodeValue.split(/(\[\[指向:[^\]]+\]\])/g);
        parts.forEach(function (part) {
          var m = part.match(/^\[\[指向:(.+?)\|$/);
          if (m) {
            var inner = part.slice(6, -2); // 去掉 [[指向: 和 ]]
            var mm = inner.match(/^(.*?)\|(.*)$/);
            var sel = mm ? mm[1].trim() : inner.trim();
            var label = mm ? mm[2].trim() : '';
            var span = document.createElement('span');
            span.className = 'pg-inline';
            span.textContent = '◎ ' + (label || '看这里');
            span.setAttribute('data-target', sel);
            span.setAttribute('data-label', label);
            span.addEventListener('click', function () {
              injectCSS();
              var g = new Guide(span);
              g.autoplay = false;
              g.steps = [span];
              g.start();
            });
            frag.appendChild(span);
          } else if (part) {
            frag.appendChild(document.createTextNode(part));
          }
        });
        textNode.parentNode.replaceChild(frag, textNode);
      });
    });
  }

  function init() {
    injectCSS();
    var guides = document.querySelectorAll('.point-guide');
    for (var i = 0; i < guides.length; i++) new Guide(guides[i]);
    scanInline(null);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PointGuide = { version: '1.0', reinit: init };
})();
