/*
 * 上财自动登录 · 内容脚本
 * 检测到上财统一认证登录页后：倒计时 → 查询验证类型（字符验证码 / 滑块 / 无）
 *   → 字符验证码：拉图 → 后台 CRNN 离线识别 → 登录（低置信度时浮窗人工输入）
 *   → 滑块：CNN 缺口定位 + 邻域梯队 → 登录
 *   → 无验证码：直接登录
 * 仅向 login.sufe.edu.cn 提交数据，密码 RSA(PKCS#1 v1.5) 加密后传输。
 */
(async function () {
  'use strict';
  if (window.__SUFE_AUTO_LOGIN__) return;
  window.__SUFE_AUTO_LOGIN__ = true;

  // ── 常量 ────────────────────────────────────────────────────────────
  const BASE = 'https://login.sufe.edu.cn/esc-sso';
  const MAX_ROUNDS = 6;            // 整体登录尝试轮数
  const SLIDER_ROUNDS = 6;         // 单次滑块内候选校验轮数上限
  const VCODE_CONF_MIN = 0.35;     // 自动提交的最低单字符置信度（低于则人工输入）
  const VCODE_FORCE_MANUAL = 2;    // 自动识别连续失败次数达到后强制人工
  const AUTO_DELAY_MS = 2000;
  const LOOP_GUARD_MS = 20000;
  const CFG_KEY = 'sufeAutoLoginCfg';
  const STATE_KEY = 'sufeAutoLoginState';
  const STATS_KEY = 'sufeAutoLoginStats';
  const VSTATS_KEY = 'sufeAutoLoginVcodeStats';
  const BLIND_X = [100, 98, 102];

  // ── 小工具 ──────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function backoff(rnd) { return rnd >= 4 ? 3000 : 1200; }

  async function getCfg() {
    const o = await chrome.storage.local.get(CFG_KEY);
    return o[CFG_KEY] || null;
  }
  async function getState() {
    const o = await chrome.storage.local.get(STATE_KEY);
    return o[STATE_KEY] || {};
  }
  async function recordStat(firstTry, X, conf) {
    try {
      const o = await chrome.storage.local.get(STATS_KEY);
      const s = o[STATS_KEY] || { n: 0, firstTry: 0 };
      s.n++; if (firstTry) s.firstTry++;
      s.lastX = X;
      s.lastConf = (conf == null) ? null : Math.round(conf * 1000) / 1000;
      await chrome.storage.local.set({ [STATS_KEY]: s });
    } catch (e) { /* 统计失败不影响流程 */ }
  }
  async function recordVcodeStat(ok, minProb, text, ms) {
    try {
      const o = await chrome.storage.local.get(VSTATS_KEY);
      const s = o[VSTATS_KEY] || { n: 0, ok: 0 };
      s.n++; if (ok) s.ok++;
      s.lastText = text || '';
      s.lastProb = (minProb == null) ? null : Math.round(minProb * 1000) / 1000;
      s.lastMs = ms == null ? null : ms;
      await chrome.storage.local.set({ [VSTATS_KEY]: s });
    } catch (e) { /* ignore */ }
  }

  async function api(path, opts = {}) {
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { Accept: 'application/json' },
        opts.body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) {
      throw new Error('接口返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 100));
    }
  }

  // ── 滑块（沿用旧插件策略） ──────────────────────────────────────────
  async function decodeSource(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, cv.width, cv.height);
    if (bmp.close) bmp.close();
    return { px: id.data, w: cv.width, h: cv.height };
  }

  function offsets(x, m) {
    if (x == null || !isFinite(x)) return [];
    const x0 = Math.round(x);
    if (x0 < 0 || x0 > 600) return [];
    const out = [];
    const push = (v, mm) => {
      if (v >= 0 && v <= 600 && !out.some((o) => o.x === v)) out.push({ x: v, m: mm });
    };
    push(x0, m);
    push(x0 + 1, m + '+1'); push(x0 - 1, m + '-1');
    push(x0 + 2, m + '+2'); push(x0 - 2, m + '-2');
    return out;
  }

  async function decodeAndSegment(d) {
    const img = await decodeSource(d.sourceImage);
    let strict = null;
    try { strict = SufeCNN.segmentStrict(img.px, img.w, img.h); } catch (e) { strict = null; }
    return { img: img, strict: strict, cnn: null, looseX: null };
  }

  function runCnn(det) {
    if (!det || !det.img || det.cnn) return det ? det.cnn : null;
    try { det.cnn = SufeCNN.locate(det.img.px, det.img.w, det.img.h); } catch (e) { det.cnn = null; }
    return det.cnn;
  }

  function runLooseSeg(det) {
    if (!det || !det.img || det.looseX != null) return det ? det.looseX : null;
    try { det.looseX = SufeCNN.segmentX(det.img.px, det.img.w, det.img.h); } catch (e) { det.looseX = null; }
    return det.looseX;
  }

  function* candidateStream(det) {
    const seen = new Set();
    const pick = function* (list) {
      for (const c of list) {
        if (seen.has(c.x)) continue;
        seen.add(c.x);
        yield c;
      }
    };
    const cheapThenCnn = function* () {
      const loose = runLooseSeg(det);
      if (loose != null) yield* pick(offsets(loose, 'seg'));
      const cnn = runCnn(det);
      if (cnn) yield* pick(offsets(cnn.x, 'cnn'));
    };
    if (det && det.strict) {
      yield* pick(offsets(det.strict.x, 'seg'));
      yield* cheapThenCnn();
    } else {
      yield* cheapThenCnn();
    }
    for (const b of BLIND_X) yield* pick([{ x: b, m: 'blind' }]);
  }

  async function sliderRound(ui) {
    const init = await api('/api/v3/sliderCaptcha/init', { method: 'POST', body: {} });
    const d = init && init.data;
    if (!d || !d.token) throw new Error('滑块 init 失败：' + ((init && init.msg) || '未知错误'));
    const y = d.Y, token = d.token;
    let det = null;
    try { det = await decodeAndSegment(d); }
    catch (e) { if (ui) ui.note('背景图解码失败，退回盲试：' + e.message); }

    const segShown = () => (det ? (det.strict ? det.strict.x : det.looseX) : null);
    const cnnShown = () => (det && det.cnn ? Math.round(det.cnn.x) : null);
    const confShown = () => (det && det.cnn ? det.cnn.conf : 0);

    let lastMsg = (init && init.msg) || '';
    let first = true;
    for (const c of candidateStream(det)) {
      const r = await api(
        '/api/v3/sliderCaptcha/check?X=' + encodeURIComponent(c.x) +
        '&Y=' + encodeURIComponent(y) + '&token=' + encodeURIComponent(token)
      );
      const wasFirst = first;
      first = false;
      if (String(r.code) === '0') {
        await recordStat(wasFirst, c.x, confShown());
        return {
          vcode: r.data, x: c.x, y: y, method: c.m, firstTry: wasFirst,
          cnnX: cnnShown(), conf: confShown(), segX: segShown(),
        };
      }
      lastMsg = r.msg || lastMsg;
    }
    return {
      vcode: null, lastMsg: lastMsg, method: 'none',
      cnnX: cnnShown(), conf: confShown(), segX: segShown(),
    };
  }

  async function sliderFlow(ui) {
    for (let rnd = 1; rnd <= SLIDER_ROUNDS; rnd++) {
      ui.status('滑块解锁中（第 ' + rnd + '/' + SLIDER_ROUNDS + ' 轮）…');
      let v;
      try { v = await sliderRound(ui); }
      catch (e) { ui.note('init 异常：' + e.message); await sleep(backoff(rnd)); continue; }
      if (!v.vcode) {
        ui.note('第 ' + rnd + ' 轮未通过（' + (v.lastMsg || '无信息') +
          (v.cnnX != null ? ' CNN=' + v.cnnX : '') +
          (v.segX != null ? ' 分割=' + v.segX : '') + '）');
        if (rnd < SLIDER_ROUNDS) await sleep(backoff(rnd));
        continue;
      }
      ui.status('滑块已解锁（X=' + v.x + ' 方式=' + v.method + '）');
      return v.vcode;
    }
    throw new Error('滑块连续 ' + SLIDER_ROUNDS + ' 轮未通过——疑似风控收紧期，请稍后再试或手动登录');
  }

  // ── 字符验证码 ──────────────────────────────────────────────────────
  async function fetchVcodeImage() {
    const url = BASE + '/api/v1/image/getRandcode?' + Math.random();
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error('验证码图片获取失败（HTTP ' + res.status + '）');
    const blob = await res.blob();
    if (!blob.type || blob.type.indexOf('image') < 0) throw new Error('验证码接口未返回图片');
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = 80; cv.height = 34;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 80, 34);
    const id = ctx.getImageData(0, 0, 80, 34);
    if (bmp.close) bmp.close();
    return { dataUrl: cv.toDataURL('image/png'), rgba: id.data };
  }

  function rgbaToInput(rgba) {
    const plane = 80 * 34;
    const x = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
      x[i] = rgba[i * 4] / 127.5 - 1;
      x[plane + i] = rgba[i * 4 + 1] / 127.5 - 1;
      x[plane * 2 + i] = rgba[i * 4 + 2] / 127.5 - 1;
    }
    return x;
  }

  async function inferVcode(img) {
    const input = rgbaToInput(img.rgba);
    const bytes = new Uint8Array(input.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const res = await chrome.runtime.sendMessage({ type: 'SUFE_INFER', pixels: btoa(bin) });
    if (!res || !res.ok) throw new Error('识别失败：' + ((res && res.error) || '后台无响应'));
    return res;
  }

  async function vcodeTry(ui, imgPromise, predPromise) {
    let img = imgPromise ? await imgPromise.catch(() => null) : null;
    if (!img) img = await fetchVcodeImage();
    ui.status('识别字符验证码…');
    let pred = predPromise ? await predPromise.catch(() => null) : null;
    if (!pred) {
      try { pred = await inferVcode(img); }
      catch (e) { ui.note(e.message); }
    }
    if (pred) {
      const pct = Math.round((pred.minProb || 0) * 100);
      ui.note('识别：' + (pred.text || '空') + '（置信度 ' + pct + '%，' + pred.ms + 'ms）');
      if (pred.text && pred.text.length === 4 && pred.minProb >= VCODE_CONF_MIN &&
          vcodeAutoFails < VCODE_FORCE_MANUAL) {
        return { code: pred.text, auto: true };
      }
      if (vcodeAutoFails >= VCODE_FORCE_MANUAL) ui.note('自动识别连续未通过，转人工输入');
      else ui.note('识别不确定，请人工输入');
    } else {
      ui.note('识别不可用，请人工输入');
    }
    await recordVcodeStat(false, pred ? pred.minProb : null, pred ? pred.text : '', pred ? pred.ms : null);
    const code = await askVcodeManually(img, pred);
    return { code: code, auto: false };
  }

  let vcodeAutoFails = 0;

  // ── 人工输入浮窗 ────────────────────────────────────────────────────
  let manualReject = null;

  function cancelManual() {
    if (manualReject) {
      const r = manualReject;
      manualReject = null;
      r(new Error('已停止'));
    }
  }

  function askVcodeManually(img, pred) {
    return new Promise((resolve, reject) => {
      manualReject = reject;
      let current = img;
      ensureWidget();
      bodyEl.textContent = '';
      actionsEl.textContent = '';
      logEl.textContent = '';

      const line = el('div', 'ssw-line', '请输入图片中的 4 位字符');
      const box = el('div', 'ssw-vbox');
      const im = document.createElement('img');
      im.className = 'ssw-vimg';
      im.src = current.dataUrl;
      im.title = '点击可换一张';
      im.addEventListener('click', refresh);
      const input = document.createElement('input');
      input.className = 'ssw-vinput';
      input.type = 'text';
      input.maxLength = 4;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = pred && pred.text ? '识别 ' + pred.text + '（可改）' : '输入验证码';
      box.append(im, input);
      bodyEl.append(line, box);

      const errLine = el('div', 'ssw-logline', '');
      logEl.appendChild(errLine);

      function normalize() {
        input.value = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 4);
      }
      input.addEventListener('input', normalize);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      async function refresh() {
        try {
          const fresh = await fetchVcodeImage();
          current = fresh;
          im.src = fresh.dataUrl;
          input.value = '';
          input.placeholder = '输入验证码';
          errLine.textContent = '已换一张';
          input.focus();
        } catch (e) {
          errLine.textContent = e.message;
        }
      }

      function submit() {
        normalize();
        if (input.value.length !== 4) {
          errLine.textContent = '请输入完整的 4 位字符';
          return;
        }
        const code = input.value;
        if (manualReject === reject) manualReject = null;
        resolve(code);
      }

      const submitBtn = mkBtn('提交验证码', submit, true);
      const refreshBtn = mkBtn('换一张', refresh);
      const cancelBtn = mkBtn('取消', () => {
        if (manualReject === reject) manualReject = null;
        reject(new Error('已停止'));
      });
      actionsEl.append(submitBtn, refreshBtn, cancelBtn);
      setTimeout(() => input.focus(), 50);
    });
  }

  // ── 登录 ────────────────────────────────────────────────────────────
  function extractRedirect(res) {
    const d = res && res.data;
    if (typeof d === 'string') {
      const m = d.match(/https?:\/\/[^\s"'<>]+/);
      if (m) return m[0];
    }
    if (d && typeof d === 'object') {
      for (const k of ['redirectUri', 'redirect', 'redirectUrl', 'url', 'target', 'forward']) {
        const v = d[k];
        if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
      }
    }
    return null;
  }

  function isCredentialError(res) {
    return res && (res.code === 'SSO10001' || res.code === 'SSO10002');
  }

  function isVcodeError(res) {
    if (!res) return false;
    if (isCredentialError(res) || String(res.code) === '0') return false;
    return /验证码|vcode/i.test(res.msg || '');
  }

  async function getLoginConfig() {
    const cfgRes = await api('/api/v3/auth/queryAllValid');
    const param = cfgRes && cfgRes.data && cfgRes.data.param;
    const ticket = cfgRes && cfgRes.data && cfgRes.data.config && cfgRes.data.config.loginTicket;
    if (!param || !param.publicKey || !ticket) throw new Error('获取登录配置失败（接口结构可能已变化）');
    return { param: param, ticket: ticket };
  }

  async function queryUserValid(username) {
    const r = await api('/api/v3/auth/queryUserValid?username=' +
      encodeURIComponent(username) + '&authType=webLocalAuth');
    const d = r && r.data;
    if (d && d.enable === false) {
      const err = new Error('账号当前不可用（enable=false）');
      err.stopRetry = true;
      throw err;
    }
    return d || {};
  }

  async function doLogin(cfg, loginCfg, encPw, vcode) {
    return api('/api/v3/auth/doLogin', {
      method: 'POST',
      body: {
        authType: 'webLocalAuth',
        dataField: {
          username: cfg.username,
          password: encPw,
          vcode: vcode || '',
          publicKeyId: loginCfg.param.publicKeyId,
        },
        loginTicket: loginCfg.ticket,
        redirectUri: '',
      },
    });
  }

  let preflight = null;

  function updatePreflight() {
    if (!root || state !== 'pending' || !preflight) return;
    const line = root.querySelector('.ssw-preflight');
    if (!line) return;
    const p = preflight.progress;
    const parts = [];
    if (p.config) parts.push('配置');
    if (p.image) parts.push('图片');
    if (p.infer) parts.push('识别');
    line.textContent = parts.length === 3 ? '预破解就绪，等待进入' : '后台预破解：' + (parts.join(' / ') || '启动中');
  }

  function startPreflight(cfg) {
    const progress = { config: false, image: false, infer: false };
    const imgP = fetchVcodeImage().catch(() => null);
    const inferP = imgP.then((img) => {
      progress.image = true;
      updatePreflight();
      return img ? inferVcode(img).catch(() => null) : null;
    }).then((pred) => { progress.infer = true; updatePreflight(); return pred; });
    const loginCfgP = getLoginConfig().then((v) => {
      progress.config = true; updatePreflight(); return { value: v };
    }, (error) => ({ error }));
    const userValidP = queryUserValid(cfg.username).then((v) => ({ value: v }), (error) => ({ error }));
    preflight = { progress, imgP, inferP, loginCfgP, userValidP, at: Date.now() };
    updatePreflight();
  }

  async function autoLogin(cfg, ui, runId, prepared) {
    const checkStop = () => { if (runId !== currentRunId) throw new Error('已停止'); };
    vcodeAutoFails = 0;

    for (let attempt = 1; attempt <= MAX_ROUNDS; attempt++) {
      checkStop();
      ui.status('获取登录配置…（第 ' + attempt + '/' + MAX_ROUNDS + ' 轮）');
      let imgP, predP, loginCfg, uv;
      if (prepared) {
        const [lc, uvr] = await Promise.all([prepared.loginCfgP, prepared.userValidP]);
        if (lc.error) throw lc.error;
        if (uvr.error) throw uvr.error;
        loginCfg = lc.value;
        uv = uvr.value;
        imgP = prepared.imgP;
        predP = prepared.inferP;
        prepared = null;
      } else {
        imgP = fetchVcodeImage().catch(() => null);
        [loginCfg, uv] = await Promise.all([getLoginConfig(), queryUserValid(cfg.username)]);
      }
      checkStop();
      const encPw = SufeCrypto.encryptPassword(cfg.password, loginCfg.param.publicKey);

      let vcode = '';
      let vcodeAuto = false;
      const type = uv.type;
      if (type === 'slidercaptcha') {
        vcode = await sliderFlow(ui);
      } else if (type === 'vcode') {
        const r = await vcodeTry(ui, imgP, predP);
        vcode = r.code;
        vcodeAuto = r.auto;
      } else if (type) {
        throw new Error('服务端要求的验证类型暂不支持：' + type);
      }

      checkStop();
      ui.status('正在登录…');
      const res = await doLogin(cfg, loginCfg, encPw, vcode);
      checkStop();
      if (String(res.code) === '0') {
        vcodeAutoFails = 0;
        await chrome.storage.local.set({ [STATE_KEY]: { lastAutoLoginAt: Date.now() } });
        return res;
      }
      if (isCredentialError(res)) {
        const err = new Error(res.code === 'SSO10001'
          ? '学号不存在（SSO10001），请在扩展设置中更正'
          : '学号或密码错误（SSO10002），请在扩展设置中更正');
        err.stopRetry = true;
        throw err;
      }
      if (type === 'vcode' && vcodeAuto && isVcodeError(res)) vcodeAutoFails++;
      ui.note('doLogin 未通过：code=' + (res.code || '?') + ' msg=' + (res.msg || ''));
      await sleep(500);
    }
    throw new Error('连续 ' + MAX_ROUNDS + ' 轮未通过——请稍后再试或手动登录');
  }

  // ── 浮窗 ────────────────────────────────────────────────────────────
  const WIDGET_ID = 'sufe-auto-login-widget';
  let root = null, bodyEl = null, logEl = null, actionsEl = null, settingsEl = null;
  let matrixTimer = null;
  const logLines = [];

  function sufeAscii() {
    const glyphs = [
      ['01110', '11000', '10000', '01110', '00011', '00011', '11110'],
      ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
      ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
      ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    ];
    return Array.from({ length: 7 }, (_, y) => glyphs.map((g) => g[y]).join(' ')
      .replace(/1/g, '█').replace(/0/g, ' ')).join('\n');
  }

  function startMatrixFx() {
    if (matrixTimer) clearInterval(matrixTimer);
    const pre = root && root.querySelector('.ssw-ascii');
    if (!pre) return;
    const pattern = pre.dataset.base;
    pre.textContent = '';
    const waveChars = [];
    let x = 0, y = 0;
    for (const ch of pattern) {
      if (ch === '\n') {
        pre.appendChild(document.createTextNode('\n'));
        x = 0; y++;
      } else if (ch === '█') {
        const span = el('span', 'ssw-wavechar', '·');
        span.dataset.x = x;
        span.dataset.y = y;
        pre.appendChild(span);
        waveChars.push(span);
        x++;
      } else {
        pre.appendChild(document.createTextNode(' '));
        x++;
      }
    }
    const shades = ' .:-=+*#%@';
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      const t = reduced ? 0 : Date.now() / 170;
      for (const span of waveChars) {
        const x = Number(span.dataset.x), y = Number(span.dataset.y);
        const v = (Math.sin(x * 0.42 + y * 0.68 - t) + 1) / 2;
        const idx = Math.max(0, Math.min(shades.length - 1, Math.floor(v * shades.length)));
        span.textContent = shades[idx];
        span.style.opacity = String(0.45 + v * 0.55);
      }
    };
    draw();
    if (!reduced) matrixTimer = setInterval(() => {
      if (!root || !root.isConnected) {
        clearInterval(matrixTimer);
        matrixTimer = null;
        return;
      }
      draw();
    }, 65);
  }

  function stopMatrixFx() {
    if (matrixTimer) clearInterval(matrixTimer);
    matrixTimer = null;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function ensureWidget() {
    if (root && root.isConnected) return;
    root = el('div'); root.id = WIDGET_ID;
    const matrix = el('div', 'ssw-matrix');
    matrix.setAttribute('aria-hidden', 'true');
    const ascii = el('pre', 'ssw-ascii');
    ascii.dataset.base = sufeAscii();
    ascii.textContent = ascii.dataset.base;
    matrix.append(ascii, el('div', 'ssw-scan'));
    root.appendChild(matrix);
    const title = el('div', 'ssw-title', '上财自动登录');
    const tools = el('span', 'ssw-tools');
    const gear = el('span', 'ssw-link', '设置');
    gear.title = '在此填写或修改学号/密码';
    gear.addEventListener('click', openCfgEditor);
    const closeTop = el('span', 'ssw-close', '×');
    closeTop.title = '隐藏浮窗（刷新页面后重新出现）';
    closeTop.addEventListener('click', hideWidget);
    tools.append(gear, closeTop);
    title.appendChild(tools);
    bodyEl = el('div', 'ssw-body');
    logEl = el('div', 'ssw-log');
    actionsEl = el('div', 'ssw-actions');
    settingsEl = el('div', 'ssw-settings');
    root.append(title, bodyEl, logEl, actionsEl, settingsEl);
    document.documentElement.appendChild(root);
    startMatrixFx();
  }

  function hideWidget() { stopMatrixFx(); if (root) root.remove(); root = null; }

  function mkBtn(text, onClick, primary) {
    const b = el('button', 'ssw-btn' + (primary ? ' ssw-btn-primary' : ''), text);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderStatus(text) {
    ensureWidget();
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'ssw-line', text));
    actionsEl.textContent = '';
    actionsEl.appendChild(mkBtn('停止', stopRun));
  }

  function renderNote(text) {
    ensureWidget();
    logLines.push(text);
    if (logLines.length > 30) logLines.shift();
    logEl.textContent = '';
    for (const line of logLines.slice(-8)) logEl.appendChild(el('div', 'ssw-logline', line));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderCard(mainText, buttons) {
    ensureWidget();
    bodyEl.textContent = '';
    bodyEl.appendChild(el('div', 'ssw-line', mainText));
    logEl.textContent = '';
    actionsEl.textContent = '';
    for (const b of buttons) actionsEl.appendChild(b);
  }

  function renderSuccess(target) {
    ensureWidget();
    bodyEl.textContent = '';
    logEl.textContent = '';
    actionsEl.textContent = '';
    const box = el('div', 'ssw-success');
    box.appendChild(el('div', 'ssw-success-kicker', '[ SUFE // INTRUSION COMPLETE ]'));
    box.appendChild(el('div', 'ssw-success-title', 'ACCESS GRANTED'));
    box.appendChild(el('div', 'ssw-success-sub', '登录成功 · 正在跳转…'));
    box.appendChild(el('div', 'ssw-pixels', '▰ ▰▰ ▰▰▰ ▰ ▰▰▰▰'));
    bodyEl.appendChild(box);
    actionsEl.appendChild(mkBtn('立即跳转', () => { location.href = target || location.href; }, true));
  }

  function renderError(err) {
    const msg = err && err.message ? err.message : String(err);
    const buttons = err && err.stopRetry
      ? [mkBtn('填写账密', openCfgEditor, true), mkBtn('关闭', hideWidget)]
      : [mkBtn('重试', () => startFlow(), true), mkBtn('填写账密', openCfgEditor), mkBtn('关闭', hideWidget)];
    renderCard('✗ ' + msg, buttons);
  }

  function closeCfgEditor() {
    if (!settingsEl) return;
    settingsEl.classList.remove('ssw-open');
    settingsEl.textContent = '';
  }

  async function openCfgEditor() {
    if (settingsEl && settingsEl.classList.contains('ssw-open')) {
      closeCfgEditor();
      return;
    }
    const c = await getCfg();
    renderCfgCard(c);
  }

  function renderCfgCard(cfg) {
    stopRun();
    ensureWidget();
    settingsEl.textContent = '';
    settingsEl.classList.add('ssw-open');
    settingsEl.appendChild(el('div', 'ssw-line',
      cfg && cfg.username ? '修改学号/密码（仅保存在本机）' : '填写上财学号与密码（仅保存在本机）'));

    const u = document.createElement('input');
    u.className = 'ssw-cinput';
    u.type = 'text';
    u.placeholder = '学号';
    u.autocomplete = 'off';
    u.spellcheck = false;
    u.value = (cfg && cfg.username) || '';

    const p = document.createElement('input');
    p.className = 'ssw-cinput';
    p.type = 'password';
    p.placeholder = '密码';
    p.autocomplete = 'off';
    p.value = (cfg && cfg.password) || '';

    const errLine = el('div', 'ssw-logline', '');
    settingsEl.append(u, p, errLine);

    let saving = false;
    function save() {
      if (saving) return;
      const username = u.value.trim();
      const password = p.value;
      if (!username || !password) {
        errLine.textContent = '请填写学号和密码';
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      chrome.storage.local.set({ [CFG_KEY]: { username: username, password: password, enabled: true } })
        .then(() => { closeCfgEditor(); startFlow(); })
        .catch((e) => {
          saving = false;
          saveBtn.disabled = false;
          errLine.textContent = '保存失败：' + (e && e.message ? e.message : e);
        });
    }

    u.addEventListener('keydown', (e) => { if (e.key === 'Enter') p.focus(); });
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

    const saveBtn = mkBtn('保存并登录', save, true);
    const showBtn = mkBtn('显示密码', () => {
      const show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      showBtn.textContent = show ? '隐藏密码' : '显示密码';
    });
    const panelActions = el('div', 'ssw-actions');
    panelActions.append(saveBtn, showBtn, mkBtn('收起', closeCfgEditor));
    settingsEl.appendChild(panelActions);
    setTimeout(() => (u.value ? p : u).focus(), 50);
  }

  // ── 流程控制 ────────────────────────────────────────────────────────
  let currentRunId = 0;
  let countdownTimer = null;
  let state = 'idle';

  function stopRun() {
    currentRunId++;
    cancelManual();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    state = 'idle';
  }

  async function startFlow() {
    const prepared = preflight && Date.now() - preflight.at < 15000 ? preflight : null;
    preflight = null;
    stopRun();
    const myRunId = ++currentRunId;
    state = 'running';
    const ui = { status: renderStatus, note: renderNote };
    try {
      const cfg = await getCfg();
      if (!cfg || !cfg.username || !cfg.password) {
        renderCfgCard(cfg || null);
        return;
      }
      const res = await autoLogin(cfg, ui, myRunId, prepared);
      if (myRunId !== currentRunId) return;
      state = 'idle';
      const target = extractRedirect(res);
      renderSuccess(target);
      setTimeout(() => {
        if (myRunId !== currentRunId) return;
        if (target) location.href = target; else location.reload();
      }, 600);
    } catch (err) {
      if (myRunId !== currentRunId) return;
      state = 'idle';
      if (err && err.message === '已停止') return;
      renderError(err);
    }
  }

  function setCountDigit(box, remain) {
    const next = String(remain).padStart(2, '0');
    if (box.dataset.value === next) return;
    const previous = box.dataset.value;
    box.dataset.value = next;
    box.textContent = '';
    if (previous !== undefined) box.appendChild(el('span', 'ssw-digit-out', previous));
    box.appendChild(el('span', 'ssw-digit-in', next));
  }

  function renderCountdown(remain, cfg) {
    ensureWidget();
    const existing = bodyEl.querySelector('.ssw-countdown');
    if (existing) {
      setCountDigit(existing.querySelector('.ssw-count-num'), remain);
      updatePreflight();
      return;
    }
    bodyEl.textContent = '';
    logEl.textContent = '';
    actionsEl.textContent = '';
    const box = el('div', 'ssw-countdown');
    box.appendChild(el('div', 'ssw-count-kicker', '[ SUFE // ACCESS SEQUENCE ]'));
    const num = el('div', 'ssw-count-num');
    box.appendChild(num);
    setCountDigit(num, remain);
    box.appendChild(el('div', 'ssw-count-label', '秒后自动进入 · AUTO LOGIN'));
    const progress = el('div', 'ssw-progress');
    progress.appendChild(el('span'));
    box.appendChild(progress);
    box.appendChild(el('div', 'ssw-preflight', '后台预破解：启动中'));
    box.appendChild(el('div', 'ssw-username', cfg.username));
    bodyEl.appendChild(box);
    actionsEl.append(
      mkBtn('立即登录', () => startFlow(), true),
      mkBtn('取消', () => { stopRun(); renderManual(); })
    );
    updatePreflight();
  }

  async function startCountdown(cfg) {
    state = 'pending';
    startPreflight(cfg);
    let remain = Math.round(AUTO_DELAY_MS / 1000);
    renderCountdown(remain, cfg);
    countdownTimer = setInterval(() => {
      remain--;
      if (remain <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        startFlow();
        return;
      }
      renderCountdown(remain, cfg);
    }, 1000);
  }

  function renderManual() {
    renderCard('已取消自动登录。可点击按钮手动登录。', [
      mkBtn('立即登录', () => startFlow(), true),
      mkBtn('关闭', hideWidget),
    ]);
  }

  function onUserInteract(e) {
    if (state !== 'pending') return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('#' + WIDGET_ID)) return;
    if (e.target.closest('input, button, form')) {
      stopRun();
      renderManual();
    }
  }

  // ── 自检 ────────────────────────────────────────────────────────────
  async function testVcode(rounds) {
    const lines = [];
    let ok = 0;
    for (let i = 1; i <= rounds; i++) {
      try {
        const img = await fetchVcodeImage();
        const pred = await inferVcode(img);
        await recordVcodeStat(true, pred.minProb, pred.text, pred.ms);
        if (pred.text && pred.text.length === 4 && pred.minProb >= VCODE_CONF_MIN) ok++;
        lines.push('#' + i + ' 识别=' + (pred.text || '空') +
          ' 置信=' + Math.round((pred.minProb || 0) * 100) + '% ' + pred.ms + 'ms');
      } catch (e) {
        lines.push('#' + i + ' 异常：' + e.message);
      }
      if (i < rounds) await sleep(400);
    }
    return { ok: ok, detail: lines.join('\n'), highConf: ok + '/' + rounds };
  }

  async function testSlider(rounds) {
    const log = [];
    for (let rnd = 1; rnd <= rounds; rnd++) {
      try {
        const v = await sliderRound();
        if (v.vcode) {
          return {
            ok: true,
            detail: '第 ' + rnd + ' 轮通过（X=' + v.x + ' Y=' + v.y + ' 方式=' + v.method +
              (v.cnnX != null ? ' CNN=' + v.cnnX + '/conf' + v.conf.toFixed(2) : '') +
              (v.segX != null ? ' 分割=' + v.segX : '') + '）',
          };
        }
        log.push('第 ' + rnd + ' 轮未通过（' + (v.lastMsg || '无信息') +
          (v.cnnX != null ? ' CNN=' + v.cnnX : '') +
          (v.segX != null ? ' 分割=' + v.segX : '') + '）');
      } catch (e) { log.push('第 ' + rnd + ' 轮异常：' + e.message); }
      if (rnd < rounds) await sleep(backoff(rnd));
    }
    return { ok: false, detail: log.join('\n') };
  }

  // ── 消息 ────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'SUFE_TEST_SLIDER') {
      testSlider(3).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'SUFE_TEST_VCODE') {
      testVcode(5).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'SUFE_RUN_NOW') {
      startFlow();
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'SUFE_STATS') {
      Promise.all([
        chrome.storage.local.get(STATS_KEY),
        chrome.storage.local.get(VSTATS_KEY),
      ]).then((o) => sendResponse({
        slider: o[0][STATS_KEY] || null,
        vcode: o[1][VSTATS_KEY] || null,
      }));
      return true;
    }
  });

  // ── 检测登录页 ──────────────────────────────────────────────────────
  async function waitForForm(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const acc = document.querySelector('input.f-account, .f-account input, input[name="username"]');
      const pwd = document.querySelector('input.f-pwd, .f-pwd input, input[type="password"]');
      if (acc && pwd) return { acc: acc, pwd: pwd };
      await sleep(300);
    }
    return null;
  }

  // ── 主入口 ──────────────────────────────────────────────────────────
  const cfg = await getCfg();
  const form = await waitForForm(20000);
  if (!form) return;

  try { chrome.runtime.sendMessage({ type: 'SUFE_WARMUP' }); } catch (e) { /* SW 可能尚未就绪 */ }

  if (window.__SUFE_RUN_NOW__) {
    delete window.__SUFE_RUN_NOW__;
    startFlow();
    return;
  }

  if (window.__SUFE_TEST_ONLY__) {
    delete window.__SUFE_TEST_ONLY__;
    return;
  }

  if (location.hash.indexOf('sufe-test-vcode') >= 0) {
    const r = await testVcode(5);
    renderCard('验证码识别 ' + r.highConf + ' 高置信\n' + r.detail, [mkBtn('关闭', hideWidget)]);
    return;
  }

  if (location.hash.indexOf('sufe-test-slider') >= 0) {
    const r = await testSlider(3);
    renderCard(r.ok ? '✓ ' + r.detail : '✗ ' + r.detail, [mkBtn('关闭', hideWidget)]);
    return;
  }

  document.addEventListener('pointerdown', onUserInteract, true);
  document.addEventListener('input', onUserInteract, true);

  const st = await getState();
  if (st.lastAutoLoginAt && Date.now() - st.lastAutoLoginAt < LOOP_GUARD_MS) {
    renderCard('刚刚已完成自动登录，但页面仍停留在登录页。可能跳转异常，请手动登录或稍后重试。', [
      mkBtn('重新尝试', () => startFlow(), true),
      mkBtn('关闭', hideWidget),
    ]);
    return;
  }

  if (!cfg || !cfg.username || !cfg.password) {
    renderCfgCard(cfg);
    return;
  }

  if (cfg.enabled === false) {
    renderCard('上财自动登录：自动登录已停用。', [
      mkBtn('本次登录', () => startFlow(), true),
      mkBtn('启用', async () => {
        const c = await getCfg();
        c.enabled = true;
        await chrome.storage.local.set({ [CFG_KEY]: c });
        startCountdown(c);
      }),
      mkBtn('关闭', hideWidget),
    ]);
    return;
  }

  startCountdown(cfg);
})();
