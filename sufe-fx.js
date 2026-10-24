/*
 * 上财自动认证 · 流动 ASCII 装饰背景（canvas，requestAnimationFrame 60fps）
 * 1) 全面板极暗的字符雨（@!%# 等，缓慢下落、边落边变字）；
 * 2) 右上角由流动字符组成的 SUFE 字样（低明度装饰，不抢前景）。
 * 内容脚本浮窗与扩展弹窗共用；prefers-reduced-motion 时只渲染一帧静态画面。
 */
(function (root) {
  'use strict';

  var LETTERS = {
    S: ['01110', '10001', '10000', '01110', '00001', '10001', '01110'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  };

  var CHARS = '@#$%&*+=!?/\\<>~^:;'.split('');

  function buildMask(word) {
    var cells = [];
    var letters = word.split('');
    for (var li = 0; li < letters.length; li++) {
      var g = LETTERS[letters[li]];
      if (!g) continue;
      for (var y = 0; y < g.length; y++) {
        for (var x = 0; x < g[y].length; x++) {
          if (g[y][x] === '1') cells.push({ x: li * 6 + x, y: y });
        }
      }
    }
    return { w: letters.length * 6 - 1, h: 7, cells: cells };
  }

  function lerp3(c0, c1, c2, t) {
    var a, b, k;
    if (t < 0.5) { a = c0; b = c1; k = t * 2; }
    else { a = c1; b = c2; k = t * 2 - 1; }
    return [
      Math.round(a[0] + (b[0] - a[0]) * k),
      Math.round(a[1] + (b[1] - a[1]) * k),
      Math.round(a[2] + (b[2] - a[2]) * k),
    ];
  }

  // 确定性伪随机（字符变换 / 列相位都用它，稳定且无噪闪）
  function hash(i, seed) {
    var v = (i * 374761393 + seed * 668265263) | 0;
    v = (v ^ (v >>> 13)) * 1274126177 | 0;
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  }

  function mount(container, opts) {
    opts = opts || {};
    var api = { stop: function () {} };
    if (!container || !root.document) return api;

    var canvas = root.document.createElement('canvas');
    canvas.className = 'ssw-fx';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    if (!ctx) return api;

    var m = buildMask(opts.word || 'SUFE');
    var dpr = Math.min(2, (root.devicePixelRatio || 1));
    var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 蓝色系（低明度装饰）：暗蓝 → 亮蓝 → 白热
    var dim = opts.dim || [38, 78, 158];
    var mid = opts.mid || [86, 148, 240];
    var hot = opts.hot || [205, 228, 255];
    var fontStack = '"SufePixel", "Menlo", "Consolas", monospace';
    var running = true;
    var raf = 0;

    function layout() {
      var w = container.clientWidth || 300;
      var h = container.clientHeight || 180;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
      }
      return { w: w, h: h };
    }

    // 变换中的字符：每个格子按各自周期换字，形成字符流动感
    function cellChar(i, t) {
      var period = 0.4 + hash(i, 7) * 0.55;
      var idx = Math.floor(hash(i, 1000 + Math.floor(t / period)) * CHARS.length);
      return CHARS[idx];
    }

    function draw(now) {
      var t = now / 1000;
      var L = layout();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, L.w, L.h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // ── 1) 环境字符雨（整体极暗，纯装饰） ─────────────────
      var colStep = 17;
      var rowStep = 15;
      for (var cx = 8; cx < L.w; cx += colStep) {
        var ci = Math.floor(cx / colStep);
        var speed = 14 + hash(ci, 31) * 22;             // px/s，缓慢
        var span = L.h + 90;
        var headY = ((t * speed + hash(ci, 13) * span) % span) - 45;
        for (var k = 0; k < 7; k++) {
          var y = headY - k * rowStep;
          if (y < -8 || y > L.h + 8) continue;
          var fade = (k === 0) ? 0.2 : 0.16 * Math.exp(-k / 2.6);   // 头亮尾暗
          var ch = cellChar(ci * 50 + k, t);
          ctx.font = '10px ' + fontStack;
          ctx.fillStyle = 'rgba(96, 152, 238, ' + fade.toFixed(3) + ')';
          ctx.fillText(ch, cx, y);
        }
      }

      // ── 2) 右下角 SUFE 字符字样（无眩光、低明度、加粗） ─────────────
      var cell = Math.max(6, Math.min(
        Math.floor(L.w * 0.62 / m.w),
        Math.floor(L.h * 0.42 / m.h)
      ));
      var ox = L.w - m.w * cell - Math.round(cell * 1.1);   // 右对齐
      var oy = L.h - m.h * cell - Math.round(cell * 1.4);    // 贴底（留少量边距）
      var fontSize = Math.round(cell * 1.35);
      var lineWidth = Math.max(1.5, cell * 0.22);            // 描边加粗
      ctx.font = fontSize + 'px ' + fontStack;
      for (var i = 0; i < m.cells.length; i++) {
        var c = m.cells[i];
        var wave = Math.sin(c.x * 0.5 + t * 1.7)
                 + Math.sin(c.y * 0.9 - t * 1.1)
                 + Math.sin((c.x + c.y) * 0.32 + t * 0.7);
        var v = (wave + 3) / 6;                              // 0..1 缓慢起伏
        var alpha = 0.1 + v * 0.26;                          // 0.10~0.36 低明度
        var col = lerp3(dim, mid, mid, v);                   // 暗蓝→亮蓝，不进白热
        var paint = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha.toFixed(3) + ')';
        var px = ox + c.x * cell + cell / 2;
        var py = oy + c.y * cell + cell / 2;
        var ch = cellChar(9000 + i, t);
        ctx.strokeStyle = paint;
        ctx.lineWidth = lineWidth;
        ctx.strokeText(ch, px, py);                          // 描边 → 加粗
        ctx.fillStyle = paint;
        ctx.fillText(ch, px, py);
      }
    }

    function frame(now) {
      if (!running) return;
      if (!container.isConnected) { api.stop(); return; }
      draw(now);
      raf = root.requestAnimationFrame(frame);
    }

    if (reduced) {
      draw(830);
    } else {
      raf = root.requestAnimationFrame(frame);
    }

    api.stop = function () {
      running = false;
      if (raf) root.cancelAnimationFrame(raf);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
    return api;
  }

  root.SufeFX = { mount: mount, buildMask: buildMask };
})(typeof globalThis !== 'undefined' ? globalThis : self);
