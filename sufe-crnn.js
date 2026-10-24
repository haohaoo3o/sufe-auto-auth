/*
 * 上财字符验证码 · 纯 JS CRNN 前向（无 WASM，不受页面 CSP 影响）
 * 模型：7 层 Conv+BN(已折叠)+ReLU → 高均值 → 2 层 BiGRU → Linear → CTC greedy
 * 输入：80x34 RGB，归一化 (v/127.5 - 1)
 */
(function (root) {
  'use strict';

  let manifest = null;
  let tensors = null;
  let loadPromise = null;

  function tensor(name) {
    const t = tensors[name];
    if (!t) throw new Error('模型缺少权重：' + name);
    return t;
  }

  function conv3x3Relu(x, C, H, W, w, b, OC) {
    const plane = H * W;
    const out = new Float32Array(OC * plane);
    for (let oc = 0; oc < OC; oc++) {
      const ob = oc * plane;
      const bias = b[oc];
      for (let i = 0; i < plane; i++) out[ob + i] = bias;
      const wb = oc * C * 9;
      for (let ic = 0; ic < C; ic++) {
        const xb = ic * plane;
        const wc = wb + ic * 9;
        for (let ky = 0; ky < 3; ky++) {
          const dy = ky - 1;
          const yStart = dy < 0 ? -dy : 0;
          const yEnd = dy > 0 ? H - dy : H;
          for (let kx = 0; kx < 3; kx++) {
            const dx = kx - 1;
            const wv = w[wc + ky * 3 + kx];
            if (wv === 0) continue;
            const xStart = dx < 0 ? -dx : 0;
            const xEnd = dx > 0 ? W - dx : W;
            for (let y = yStart; y < yEnd; y++) {
              const src = xb + (y + dy) * W + dx;
              const dst = ob + y * W;
              for (let xx = xStart; xx < xEnd; xx++) {
                out[dst + xx] += wv * x[src + xx];
              }
            }
          }
        }
      }
      for (let i = 0; i < plane; i++) {
        const v = out[ob + i];
        out[ob + i] = v > 0 ? v : 0;
      }
    }
    return out;
  }

  function maxPool(src, C, H, W, kh, kw) {
    const OH = Math.floor(H / kh), OW = Math.floor(W / kw);
    const out = new Float32Array(C * OH * OW);
    for (let c = 0; c < C; c++) {
      const ib = c * H * W, ob = c * OH * OW;
      for (let y = 0; y < OH; y++) {
        for (let xx = 0; xx < OW; xx++) {
          let m = -Infinity;
          for (let ky = 0; ky < kh; ky++) {
            const row = ib + (y * kh + ky) * W + xx * kw;
            for (let kx = 0; kx < kw; kx++) {
              const v = src[row + kx];
              if (v > m) m = v;
            }
          }
          out[ob + y * OW + xx] = m;
        }
      }
    }
    return out;
  }

  function sigmoid(v) { return 1 / (1 + Math.exp(-v)); }

  // x: [T][I] 行优先；返回 [T][2H]，前向在左半、反向在右半
  function biGru(x, T, I, H, p) {
    const out = new Float32Array(T * 2 * H);
    const G = 3 * H;
    const wihF = tensor(p + 'weight_ih_l0');
    const whhF = tensor(p + 'weight_hh_l0');
    const bihF = tensor(p + 'bias_ih_l0');
    const bhhF = tensor(p + 'bias_hh_l0');
    const wihB = tensor(p + 'weight_ih_l0_reverse');
    const whhB = tensor(p + 'weight_hh_l0_reverse');
    const bihB = tensor(p + 'bias_ih_l0_reverse');
    const bhhB = tensor(p + 'bias_hh_l0_reverse');

    const gatesIH = new Float32Array(G);
    const gatesHH = new Float32Array(G);
    const h = new Float32Array(H);

    function step(wi, wh, bi, bh, xt, h) {
      for (let i = 0; i < G; i++) {
        let s = bi[i];
        const row = i * I;
        for (let j = 0; j < I; j++) s += wi[row + j] * xt[j];
        gatesIH[i] = s;
        let s2 = bh[i];
        const row2 = i * H;
        for (let j = 0; j < H; j++) s2 += wh[row2 + j] * h[j];
        gatesHH[i] = s2;
      }
      for (let i = 0; i < H; i++) {
        const r = sigmoid(gatesIH[i] + gatesHH[i]);
        const z = sigmoid(gatesIH[H + i] + gatesHH[H + i]);
        const n = Math.tanh(gatesIH[2 * H + i] + r * gatesHH[2 * H + i]);
        h[i] = (1 - z) * n + z * h[i];
      }
    }

    for (let t = 0; t < T; t++) {
      const xt = x.subarray(t * I, t * I + I);
      step(wihF, whhF, bihF, bhhF, xt, h);
      out.set(h, t * 2 * H);
    }

    h.fill(0);
    for (let t = T - 1; t >= 0; t--) {
      const xt = x.subarray(t * I, t * I + I);
      step(wihB, whhB, bihB, bhhB, xt, h);
      out.set(h, t * 2 * H + H);
    }
    return out;
  }

  function softmax(logits) {
    let m = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > m) m = logits[i];
    let sum = 0;
    const p = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) { p[i] = Math.exp(logits[i] - m); sum += p[i]; }
    for (let i = 0; i < logits.length; i++) p[i] /= sum;
    return p;
  }

  function forward(input) {
    const arch = manifest.arch || {};
    const channels = arch.channels || [32, 32, 64, 64, 128, 128, 128];
    const hidden = arch.hidden || 128;
    let f = input, C = 3, H = 34, W = 80;
    for (let i = 0; i < channels.length; i++) {
      const oc = channels[i];
      f = conv3x3Relu(f, C, H, W,
        tensor(`conv${i + 1}.weight`), tensor(`conv${i + 1}.bias`), oc);
      C = oc;
      if (i === 1 || i === 3) {
        f = maxPool(f, C, H, W, 2, 2);
        H = Math.floor(H / 2);
        W = Math.floor(W / 2);
      } else if (i === 5) {
        f = maxPool(f, C, H, W, 2, 1);
        H = Math.floor(H / 2);
      }
    }

    const T = W, F = C;
    const seq = new Float32Array(T * F);
    for (let c = 0; c < F; c++) {
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let y = 0; y < H; y++) s += f[c * H * W + y * W + t];
        seq[t * F + c] = s / H;
      }
    }

    const gru1 = biGru(seq, T, F, hidden, 'rnn.');
    const layer2 = biGru2(gru1, T, hidden * 2, hidden);
    const Wf = tensor('fc.weight'), B = tensor('fc.bias');
    const classes = B.length;
    const logits = new Float32Array(T * classes);
    for (let t = 0; t < T; t++) {
      for (let c = 0; c < classes; c++) {
        let s = B[c];
        const row = c * hidden * 2, base = t * hidden * 2;
        for (let k = 0; k < hidden * 2; k++) s += Wf[row + k] * layer2[base + k];
        logits[t * classes + c] = s;
      }
    }
    return { logits, C: classes };
  }

  // 第二层 GRU 的权重前缀不同（l1）
  function biGru2(x, T, I, H) {
    const out = new Float32Array(T * 2 * H);
    const G = 3 * H;
    const wihF = tensor('rnn.weight_ih_l1');
    const whhF = tensor('rnn.weight_hh_l1');
    const bihF = tensor('rnn.bias_ih_l1');
    const bhhF = tensor('rnn.bias_hh_l1');
    const wihB = tensor('rnn.weight_ih_l1_reverse');
    const whhB = tensor('rnn.weight_hh_l1_reverse');
    const bihB = tensor('rnn.bias_ih_l1_reverse');
    const bhhB = tensor('rnn.bias_hh_l1_reverse');
    const gatesIH = new Float32Array(G);
    const gatesHH = new Float32Array(G);
    const h = new Float32Array(H);

    function step(wi, wh, bi, bh, xt, h) {
      for (let i = 0; i < G; i++) {
        let s = bi[i];
        const row = i * I;
        for (let j = 0; j < I; j++) s += wi[row + j] * xt[j];
        gatesIH[i] = s;
        let s2 = bh[i];
        const row2 = i * H;
        for (let j = 0; j < H; j++) s2 += wh[row2 + j] * h[j];
        gatesHH[i] = s2;
      }
      for (let i = 0; i < H; i++) {
        const r = sigmoid(gatesIH[i] + gatesHH[i]);
        const z = sigmoid(gatesIH[H + i] + gatesHH[H + i]);
        const n = Math.tanh(gatesIH[2 * H + i] + r * gatesHH[2 * H + i]);
        h[i] = (1 - z) * n + z * h[i];
      }
    }

    for (let t = 0; t < T; t++) {
      step(wihF, whhF, bihF, bhhF, x.subarray(t * I, t * I + I), h);
      out.set(h, t * 2 * H);
    }
    h.fill(0);
    for (let t = T - 1; t >= 0; t--) {
      step(wihB, whhB, bihB, bhhB, x.subarray(t * I, t * I + I), h);
      out.set(h, t * 2 * H + H);
    }
    return out;
  }

  function decode(logits, C, blank) {
    const charset = manifest.charset;
    let prev = -1;
    const chars = [];
    const probs = [];
    const T = logits.length / C;
    for (let t = 0; t < T; t++) {
      const row = logits.subarray(t * C, (t + 1) * C);
      let bi = 0;
      for (let i = 1; i < C; i++) if (row[i] > row[bi]) bi = i;
      if (bi !== blank && bi !== prev) {
        const p = softmax(row);
        chars.push(charset[bi]);
        probs.push(p[bi]);
      }
      prev = bi;
    }
    const text = chars.join('');
    const minProb = probs.length ? Math.min.apply(null, probs) : 0;
    return { text, minProb, probs };
  }

  function parseWeights(buf, json) {
    const out = {};
    for (const t of json.tensors) {
      const off = t.offset;
      out[t.name] = new Float32Array(buf, off, t.count);
    }
    return out;
  }

  function loadRaw(m, buf) {
    manifest = m;
    tensors = parseWeights(buf, m);
    return true;
  }

  function load(urls) {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [mres, bres] = await Promise.all([fetch(urls.json), fetch(urls.bin)]);
      if (!mres.ok || !bres.ok) throw new Error('模型下载失败');
      const m = await mres.json();
      const buf = await bres.arrayBuffer();
      return loadRaw(m, buf);
    })();
    return loadPromise;
  }

  function predict(input) {
    if (!tensors) throw new Error('模型尚未加载');
    const { logits, C } = forward(input);
    return decode(logits, C, manifest.blank);
  }

  root.SufeCRNN = {
    load, loadRaw, predict, _forward: forward,
    _debug: { conv3x3Relu, maxPool, biGru, biGru2, tensor, getTensors: () => tensors },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
