/*
 * 上财自动认证 · 缺口定位 CNN（滑块兜底，纯 JS 前向，无依赖）
 *
 * 输入：整张背景图（不做裁剪），area-resize 到 256x128 后归一 [-1,1]（CHW），
 * 结构：4×[Conv3x3+ReLU → 高度方向 MaxPool] → 全高 MaxPool → Conv1x1 → 256 列 logits
 *       → softmax → soft-argmax
 * 输出：缺口「可通过窗口中心」在原图像素坐标（四舍五入即服务端期望的 X，两侧各 ±2px 余量）。
 * 权重由 lab/train2.py 训练导出（sufe-cnn-weights.js 注入 window.SUFE_CNN_WEIGHTS）。
 *
 * API:
 *   SufeCNN.locate(px, w, h) -> { x, conf, col }   px 可为 RGBA(canvas) 或 RGB
 *   SufeCNN.segment(px, w, h) -> { x0,y0,w,h,cnt } | null   经典分割兜底
 */
var SufeCNN = (function () {
  'use strict';

  var META = null, LAYERS = null;

  function b64ToF32(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(u8.buffer);
  }

  function load() {
    var W = window.SUFE_CNN_WEIGHTS;
    if (!W) throw new Error('SUFE_CNN_WEIGHTS 未加载');
    META = W.meta;
    LAYERS = W.layers.map(function (L) {
      return { k: L.k, cin: L.cin, cout: L.cout, w: b64ToF32(L.w), b: b64ToF32(L.b) };
    });
  }

  // 与 numpy resize.py 等价：权重 = 区间重叠长度 / 目标区间长度（分离式，两次加权）
  function axisWeights(srcN, dstN) {
    var sr = srcN / dstN;
    var M = [];
    for (var i = 0; i < dstN; i++) {
      var a = i * sr, b = (i + 1) * sr;
      var j0 = Math.floor(a), j1 = Math.ceil(b), row = [];
      for (var j = j0; j < j1 && j < srcN; j++) {
        var ov = Math.min(j + 1, b) - Math.max(j, a);
        row.push([j, ov > 0 ? ov / (b - a) : 0]);
      }
      M.push(row);
    }
    return M;
  }

  function toRgb(pix, w, h) {
    if (pix.length === w * h * 4) {
      var rgb = new Uint8Array(w * h * 3);
      for (var i = 0, j = 0; i < pix.length; i += 4, j += 3) {
        rgb[j] = pix[i]; rgb[j + 1] = pix[i + 1]; rgb[j + 2] = pix[i + 2];
      }
      return rgb;
    }
    return pix;
  }

  // RGB uint8 → CHW float32 [-1,1]，尺寸 (dw,dh)
  function prep(pix, w, h, dw, dh) {
    var rgb = toRgb(pix, w, h);
    var Wy = axisWeights(h, dh), Wx = axisWeights(w, dw);
    // 先沿 y：中间 (dh, w, 3)
    var mid = new Float32Array(dh * w * 3);
    for (var dy = 0; dy < dh; dy++) {
      var row = Wy[dy];
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0;
        for (var ki = 0; ki < row.length; ki++) {
          var j = row[ki][0], wt = row[ki][1];
          var p = (j * w + x) * 3;
          r += rgb[p] * wt; g += rgb[p + 1] * wt; b += rgb[p + 2] * wt;
        }
        var o = (dy * w + x) * 3;
        mid[o] = r / 255 * 2 - 1; mid[o + 1] = g / 255 * 2 - 1; mid[o + 2] = b / 255 * 2 - 1;
      }
    }
    // 再沿 x：输出 CHW (3, dh, dw)
    var plane = dh * dw;
    var out = new Float32Array(plane * 3);
    for (var dx = 0; dx < dw; dx++) {
      var col = Wx[dx];
      for (var y = 0; y < dh; y++) {
        var r2 = 0, g2 = 0, b2 = 0;
        for (var kj = 0; kj < col.length; kj++) {
          var xx = col[kj][0], wt2 = col[kj][1];
          var q = (y * w + xx) * 3;
          r2 += mid[q] * wt2; g2 += mid[q + 1] * wt2; b2 += mid[q + 2] * wt2;
        }
        var ob = y * dw + dx;
        out[ob] = r2; out[ob + plane] = g2; out[ob + 2 * plane] = b2;
      }
    }
    return out;
  }

  // 3x3 conv + ReLU（**零填充**，与 torch Conv2d(padding=1) 及训练端一致），尺寸不变
  function conv3Relu(x, ci, h, w, L, out) {
    var co = L.cout, kw = L.w, kb = L.b;
    for (var o = 0; o < co; o++) {
      var ob = o * h * w;
      for (var y = 0; y < h; y++) {
        for (var xx = 0; xx < w; xx++) {
          var acc = kb[o];
          for (var c = 0; c < ci; c++) {
            var kc = (o * ci + c) * 9, ch = c * h * w;
            for (var dy = -1; dy <= 1; dy++) {
              var yy = y + dy; if (yy < 0 || yy >= h) continue;
              for (var dx = -1; dx <= 1; dx++) {
                var xa = xx + dx; if (xa < 0 || xa >= w) continue;
                acc += kw[kc + (dy + 1) * 3 + (dx + 1)] * x[ch + yy * w + xa];
              }
            }
          }
          out[ob + y * w + xx] = acc > 0 ? acc : 0;
        }
      }
    }
  }

  function maxPoolY2(x, c, h, w, out) {
    var oh = h >> 1;
    for (var i = 0; i < c; i++) {
      for (var y = 0; y < oh; y++) {
        var a0 = (i * h + 2 * y) * w, b0 = (i * h + 2 * y + 1) * w, o0 = (i * oh + y) * w;
        for (var xx = 0; xx < w; xx++) {
          out[o0 + xx] = x[a0 + xx] > x[b0 + xx] ? x[a0 + xx] : x[b0 + xx];
        }
      }
    }
    return oh;
  }

  function locate(px, w, h) {
    if (!LAYERS) load();
    var IN_W = META.in_w, IN_H = META.in_h;
    var cur = prep(px, w, h, IN_W, IN_H), ci = 3, hh = IN_H, ww = IN_W;
    for (var l = 0; l < LAYERS.length; l++) {
      var L = LAYERS[l];
      if (L.k === 3) {
        var buf = new Float32Array(L.cout * hh * ww);
        conv3Relu(cur, ci, hh, ww, L, buf);
        var pooled = new Float32Array(L.cout * (hh >> 1) * ww);
        hh = maxPoolY2(buf, L.cout, hh, ww, pooled);
        cur = pooled; ci = L.cout;
      } else {
        break;
      }
    }
    // 全高 max（等价 numpy 的 MaxPoolRows）
    var feat = new Float32Array(ci * ww);
    for (var c = 0; c < ci; c++) {
      for (var x = 0; x < ww; x++) {
        var m = -Infinity;
        for (var y = 0; y < hh; y++) { var v = cur[(c * hh + y) * ww + x]; if (v > m) m = v; }
        feat[c * ww + x] = m;
      }
    }
    // 1x1 conv（最后一层）→ 每列 logits
    var head = LAYERS[LAYERS.length - 1];
    var logits = new Float32Array(ww);
    for (var x2 = 0; x2 < ww; x2++) {
      var s = head.b[0];
      for (var c2 = 0; c2 < ci; c2++) s += head.w[c2] * feat[c2 * ww + x2];
      logits[x2] = s;
    }
    // softmax + soft-argmax（±2 列质心细化）
    var mx = -Infinity;
    for (var i3 = 0; i3 < ww; i3++) if (logits[i3] > mx) mx = logits[i3];
    var sum = 0, probs = new Float32Array(ww);
    for (var i4 = 0; i4 < ww; i4++) { probs[i4] = Math.exp(logits[i4] - mx); sum += probs[i4]; }
    var best = 0, bestI = 0;
    for (var i5 = 0; i5 < ww; i5++) { probs[i5] /= sum; if (probs[i5] > best) { best = probs[i5]; bestI = i5; } }
    var lo = Math.max(0, bestI - 2), hi = Math.min(ww, bestI + 3), ws = 0, acc = 0;
    for (var i6 = lo; i6 < hi; i6++) { ws += probs[i6]; acc += i6 * probs[i6]; }
    var xIn = acc / ws;
    return { x: xIn * (w / IN_W), conf: best, col: bestI };
  }

  // 经典分割（宽松过滤）：枚举所有「平坦高亮低饱和」连通块 → [{x0,y0,w,h,cnt}]
  function segmentAll(px, w, h) {
    var n = w * h;
    var flat = new Uint8Array(n);
    var rgb = toRgb(px, w, h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x, p = i * 3;
        var R = rgb[p], G = rgb[p + 1], B = rgb[p + 2];
        var mx = R > G ? (R > B ? R : B) : (G > B ? G : B);
        var mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
        if ((R + G + B) / 3 <= 200 || (mx - mn) >= 16) continue;
        var s = 0, s2 = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var q = ((y + dy) * w + (x + dx)) * 3;
          var gv = (rgb[q] + rgb[q + 1] + rgb[q + 2]) / 3;
          s += gv; s2 += gv * gv;
        }
        var mean = s / 9;
        if (s2 / 9 - mean * mean < 6) flat[i] = 1;
      }
    }
    var lab = new Int32Array(n), nl = 0, cands = [];
    var stack = new Int32Array(n);
    for (var i0 = 0; i0 < n; i0++) {
      if (!flat[i0] || lab[i0]) continue;
      nl++;
      var sp = 0, cnt = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = i0; lab[i0] = nl;
      while (sp) {
        var cur = stack[--sp];
        cnt++;
        var cy = (cur / w) | 0, cx = cur % w;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (var dy2 = -1; dy2 <= 1; dy2++) for (var dx2 = -1; dx2 <= 1; dx2++) {
          var ny = cy + dy2, nx = cx + dx2;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          var ni = ny * w + nx;
          if (flat[ni] && !lab[ni]) { lab[ni] = nl; stack[sp++] = ni; }
        }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = cnt / (bw * bh);
      if (cnt >= 2000 && bw >= 70 && bw <= 110 && bh >= 70 && bh <= 110 && fill > 0.5 && fill < 0.9) {
        cands.push({ x0: x0, y0: y0, w: bw, h: bh, cnt: cnt });
      }
    }
    return cands;
  }

  // 经典分割（宽松）：返回面积最大的候选，兼容旧接口
  function segment(px, w, h) {
    var cands = segmentAll(px, w, h);
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      if (!best || cands[i].cnt > best.cnt) best = cands[i];
    }
    return best;
  }

  // 分割结果的窗口中心（与训练标签一致：nx - 3）
  function segmentX(px, w, h) {
    var s = segment(px, w, h);
    return s ? s.x0 - 3 : null;
  }

  // 严格分割：缺口模板在图中恆为 ~96x93、面积 ~5590（382 张实测 99% 一致）。
  // 只有「形状/面积合规且全场唯一」才认为可信；多候选或异常 → null（交给 CNN 兜底）。
  function segmentStrict(px, w, h) {
    var cands = segmentAll(px, w, h);
    var tight = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.w >= 92 && c.w <= 100 && c.h >= 89 && c.h <= 97 &&
          c.cnt >= 5450 && c.cnt <= 5750) tight.push(c);
    }
    if (tight.length === 1) return { x: tight[0].x0 - 3, conf: 1, n: 1 };
    return null;
  }

  return { locate: locate, segment: segment, segmentX: segmentX,
           segmentStrict: segmentStrict, segmentAll: segmentAll, load: load };
})();
if (typeof module !== 'undefined') module.exports = SufeCNN;
