/*
 * 上财自动认证 · 内容脚本
 * 检测到上财统一认证登录页后：倒计时（后台并行预拉图 + 预识别 + 预取配置，倒计时结束即登录）
 *   → 查询验证类型（字符验证码 / 滑块 / 无）
 *   → 字符验证码：拉图 → 后台 CRNN 离线识别 → 登录；识别未通过立即换图重试（上限 10 次，无等待），仍失败转人工
 *   → 滑块：CNN 缺口定位 + 邻域梯队 → 登录
 *   → 无验证码：直接登录
 * 仅向 login.sufe.edu.cn 提交数据，密码 RSA(PKCS#1 v1.5) 加密后传输。
 */
(async function () {
  'use strict';
  if (window.__SUFE_AUTO_LOGIN__) return;
  window.__SUFE_AUTO_LOGIN__ = true;

  // ── 常量 ────────────────────────────────────────────────────────────
  // WebVPN 镜像（login-sufe-edu-cn-s.webvpn.sufe.edu.cn）下 API 走当前源，
  // cookie 也在该源上；直连站点固定用 login.sufe.edu.cn。
  const IS_WEBVPN = /\.webvpn\.sufe\.edu\.cn$/.test(location.hostname);
  const BASE = (IS_WEBVPN ? location.origin : 'https://login.sufe.edu.cn') + '/esc-sso';
  const MAX_ROUNDS = 6;            // 整体登录尝试轮数（配置刷新级别）
  const SLIDER_ROUNDS = 6;         // 单次滑块内候选校验轮数上限
  const VCODE_CONF_MIN = 0.35;     // 自动提交的最低单字符置信度（低于则换图重试）
  const VCODE_MAX_AUTO_TRIES = 10; // 验证码自动识别重试上限（无间隔连试，超过转人工）
  const AUTO_DELAY_MS = 3000;
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

  function credentialError(res) {
    if (!isCredentialError(res)) return null;
    const err = new Error(res.code === 'SSO10001'
      ? '学号不存在（SSO10001），请在扩展设置中更正'
      : '学号或密码错误（SSO10002），请在扩展设置中更正');
    err.stopRetry = true;
    return err;
  }

  async function inferWithRetry(img) {
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      try { return await inferVcode(img); }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  /*
   * 字符验证码主流程：自动识别 → 提交；未通过立即换图重试（无等待），
   * 连试 VCODE_MAX_AUTO_TRIES 次仍未通过才转人工输入。
   * submit(code) 用当前 loginCfg 执行 doLogin；返回 code==='0' 的响应，
   * 或 { refresh: true }（登录配置类错误，需外层刷新后重来）。
   */
  async function vcodeFlow(ui, checkStop, imgPromise, predPromise, submit) {
    let img = null, pred = null;
    let res = null;
    let needRefresh = false;

    for (let t = 1; t <= VCODE_MAX_AUTO_TRIES; t++) {
      checkStop();
      if (t > 1) renderVcodeRetry(t, VCODE_MAX_AUTO_TRIES);
      img = (t === 1 && imgPromise) ? await imgPromise.catch(() => null) : null;
      if (!img) {
        try { img = await fetchVcodeImage(); }
        catch (e) {
          ui.note('第 ' + t + ' 次取图失败：' + e.message);
          await recordVcodeStat(false, null, '', null);
          continue;
        }
      }
      pred = (t === 1 && predPromise) ? await predPromise.catch(() => null) : null;
      if (!pred) {
        try { pred = await inferWithRetry(img); }
        catch (e) { ui.note('第 ' + t + ' 次识别异常：' + e.message); }
      }
      if (t === 1) ui.status('识别字符验证码…');
      const confident = pred && pred.text && pred.text.length === 4 && pred.minProb >= VCODE_CONF_MIN;
      if (!confident) {
        ui.note('第 ' + t + '/' + VCODE_MAX_AUTO_TRIES + ' 次置信度不足，换图立即重试');
        await recordVcodeStat(false, pred ? pred.minProb : null, pred ? pred.text : '', pred ? pred.ms : null);
        continue;
      }
      ui.status('正在登录…');
      res = await submit(pred.text);
      checkStop();
      if (String(res.code) === '0') {
        await recordVcodeStat(true, pred.minProb, pred.text, pred.ms);
        return res;
      }
      const ce = credentialError(res);
      if (ce) throw ce;
      if (isVcodeError(res)) {
        await recordVcodeStat(false, pred.minProb, pred.text, pred.ms);
        ui.note('第 ' + t + '/' + VCODE_MAX_AUTO_TRIES + ' 次识别未通过，立即重试');
        continue;
      }
      ui.note('doLogin 未通过：code=' + (res.code || '?') + ' msg=' + (res.msg || ''));
      needRefresh = true;
      break;
    }

    if (!needRefresh) {
      ui.status('自动识别 ' + VCODE_MAX_AUTO_TRIES + ' 次未通过，请人工输入');
      for (let m = 0; m < MAX_ROUNDS; m++) {
        checkStop();
        if (!img) {
          try { img = await fetchVcodeImage(); }
          catch (e) { ui.note('取图失败：' + e.message); continue; }
        }
        const code = await askVcodeManually(img, pred);
        checkStop();
        ui.status('正在登录…');
        res = await submit(code);
        if (String(res.code) === '0') return res;
        const ce = credentialError(res);
        if (ce) throw ce;
        if (isVcodeError(res)) {
          ui.note('输入的验证码有误，已换新图请重输');
          img = null; pred = null;
          continue;
        }
        ui.note('doLogin 未通过：code=' + (res.code || '?') + ' msg=' + (res.msg || ''));
        needRefresh = true;
        break;
      }
    }
    return { refresh: true, res: res };
  }

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

  function startPreflight(cfg) {
    const imgP = fetchVcodeImage().catch(() => null);
    const inferP = imgP.then((img) => {
      if (!img) return null;
      return inferWithRetry(img).catch(() => null);
    });
    const loginCfgP = getLoginConfig().then((v) => ({ value: v }), (error) => ({ error }));
    const userValidP = queryUserValid(cfg.username).then((v) => ({ value: v }), (error) => ({ error }));
    preflight = { imgP, inferP, loginCfgP, userValidP, at: Date.now() };
  }

  async function autoLogin(cfg, ui, runId, prepared) {
    const checkStop = () => { if (runId !== currentRunId) throw new Error('已停止'); };

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
      const submit = (code) => doLogin(cfg, loginCfg, encPw, code);
      const type = uv.type;

      if (type === 'vcode') {
        const res = await vcodeFlow(ui, checkStop, imgP, predP, submit);
        if (String(res.code) === '0') {
          await chrome.storage.local.set({ [STATE_KEY]: { lastAutoLoginAt: Date.now() } });
          return res;
        }
      } else {
        let vcode = '';
        if (type === 'slidercaptcha') {
          vcode = await sliderFlow(ui);
        } else if (type) {
          throw new Error('服务端要求的验证类型暂不支持：' + type);
        }
        checkStop();
        ui.status('正在登录…');
        const res = await submit(vcode);
        checkStop();
        if (String(res.code) === '0') {
          await chrome.storage.local.set({ [STATE_KEY]: { lastAutoLoginAt: Date.now() } });
          return res;
        }
        const ce = credentialError(res);
        if (ce) throw ce;
        ui.note('doLogin 未通过：code=' + (res.code || '?') + ' msg=' + (res.msg || ''));
      }
      await sleep(300);
    }
    throw new Error('连续 ' + MAX_ROUNDS + ' 轮未通过——请稍后再试或手动登录');
  }

  // ── 浮窗 ────────────────────────────────────────────────────────────
  const WIDGET_ID = 'sufe-auto-login-widget';
  let root = null, bodyEl = null, logEl = null, actionsEl = null, settingsEl = null;
  const logLines = [];

  // 内容脚本 CSS 里的相对 url() 字体在页面上下文解析不到扩展资源（这是此前
  // 像素字体不生效的根因），必须用 FontFace + chrome.runtime.getURL 注入；
  // fonts/* 已在 manifest 的 web_accessible_resources 中。
  const fontLoadTask = (function () {
    const fonts = [
      ['SufePixel', 'fonts/press-start-2p.ttf', {}],
      ['SufeHei', 'fonts/source-han-sans-sc-bold-subset.woff2', { weight: '700' }],
    ];
    return Promise.all(fonts.map(function (f) {
      try {
        const face = new FontFace(f[0], 'url(' + chrome.runtime.getURL(f[1]) + ')', f[2]);
        return face.load().then(function (ff) { document.fonts.add(ff); return ff; })
          .catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }));
  })();

  let fx = null;

  function startMatrixFx() {
    if (fx || !root) return;
    const holder = root.querySelector('.ssw-matrix');
    if (holder && typeof SufeFX !== 'undefined') fx = SufeFX.mount(holder);
  }

  function stopMatrixFx() {
    if (fx) { fx.stop(); fx = null; }
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
    matrix.appendChild(el('div', 'ssw-scan'));
    root.appendChild(matrix);
    const title = el('div', 'ssw-title', '上财自动认证');
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
    box.appendChild(el('div', 'ssw-username', cfg.username));
    bodyEl.appendChild(box);
    actionsEl.append(
      mkBtn('立即登录', () => startFlow(), true),
      mkBtn('取消', () => { stopRun(); renderManual(); })
    );
  }

  async function startCountdown(cfg) {
    state = 'pending';
    await fontLoadTask;
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

  // 验证码自动重试页：像素大数字显示当前重试序号（与倒计时同款切换特效）
  function renderVcodeRetry(t, max) {
    ensureWidget();
    let box = bodyEl.querySelector('.ssw-retry');
    if (!box) {
      bodyEl.textContent = '';
      logEl.textContent = '';
      actionsEl.textContent = '';
      actionsEl.appendChild(mkBtn('停止', stopRun));
      box = el('div', 'ssw-retry');
      box.appendChild(el('div', 'ssw-count-kicker', '[ SUFE // RETRY SEQUENCE ]'));
      const nums = el('div', 'ssw-retry-nums');
      const num = el('div', 'ssw-count-num ssw-retry-num');
      const tail = el('div', 'ssw-retry-max', '/' + max);
      nums.append(num, tail);
      box.appendChild(nums);
      box.appendChild(el('div', 'ssw-count-label', '次重试 · 识别中 RETRYING'));
      const bar = el('div', 'ssw-progress ssw-retry-bar');
      bar.appendChild(el('span'));
      box.appendChild(bar);
      bodyEl.appendChild(box);
    }
    setCountDigit(box.querySelector('.ssw-retry-num'), t);
    box.querySelector('.ssw-retry-max').textContent = '/' + max;
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
  await fontLoadTask;

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
    renderCard('上财自动认证：自动登录已停用。', [
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
