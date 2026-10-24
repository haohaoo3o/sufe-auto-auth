const CFG_KEY = 'sufeAutoLoginCfg';
const LOGIN_URL_PREFIX = 'https://login.sufe.edu.cn/';

const $username = document.getElementById('username');
const $password = document.getElementById('password');
const $togglePwd = document.getElementById('togglePwd');
const $enabled = document.getElementById('enabled');
const $save = document.getElementById('save');
const $login = document.getElementById('login');
const $test = document.getElementById('test');
const $testVcode = document.getElementById('testvcode');
const $status = document.getElementById('status');
const $stats = document.getElementById('stats');

(function startMatrixWave() {
  const pre = document.querySelector('.matrix-bg pre');
  if (!pre) return;
  const pattern = pre.textContent;
  pre.textContent = '';
  const chars = [];
  let x = 0, y = 0;
  for (const ch of pattern) {
    if (ch === '\n') {
      pre.appendChild(document.createTextNode('\n'));
      x = 0; y++;
    } else if (ch === '█') {
      const span = document.createElement('span');
      span.className = 'wavechar';
      span.dataset.x = x;
      span.dataset.y = y;
      span.textContent = '·';
      pre.appendChild(span);
      chars.push(span);
      x++;
    } else {
      pre.appendChild(document.createTextNode(' '));
      x++;
    }
  }
  const shades = ' .:-=+*#%@';
  function draw() {
    const t = Date.now() / 170;
    for (const span of chars) {
      const v = (Math.sin(Number(span.dataset.x) * 0.42 + Number(span.dataset.y) * 0.68 - t) + 1) / 2;
      span.textContent = shades[Math.min(shades.length - 1, Math.floor(v * shades.length))];
      span.style.opacity = String(0.45 + v * 0.55);
    }
  }
  draw();
  if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setInterval(draw, 65);
  }
})();

function setStatus(text, isErr) {
  $status.textContent = text;
  $status.className = isErr ? 'err' : '';
}

chrome.storage.local.get(CFG_KEY).then((o) => {
  const cfg = o[CFG_KEY] || {};
  $username.value = cfg.username || '';
  $password.value = cfg.password || '';
  $enabled.checked = cfg.enabled !== false;
});

chrome.storage.local.get('sufeAutoLoginStats').then((o) => {
  const s = o.sufeAutoLoginStats;
  if (s && s.n) {
    $stats.textContent = `滑块：${s.n} 次成功，${s.firstTry} 次首次命中（${Math.round(s.firstTry / s.n * 100)}%）`;
  }
});

chrome.storage.local.get('sufeAutoLoginVcodeStats').then((o) => {
  const v = o.sufeAutoLoginVcodeStats;
  if (v && v.n) {
    const line = `验证码：${v.n} 次识别，最近「${v.lastText || '-'}」置信 ${v.lastProb == null ? '-' : Math.round(v.lastProb * 100) + '%'}`;
    $stats.textContent = ($stats.textContent ? $stats.textContent + '；' : '') + line;
  }
});

$togglePwd.addEventListener('click', () => {
  const show = $password.type === 'password';
  $password.type = show ? 'text' : 'password';
  $togglePwd.textContent = show ? '隐藏' : '显示';
  $togglePwd.title = show ? '隐藏密码' : '显示密码';
});

$save.addEventListener('click', async () => {
  const cfg = {
    username: $username.value.trim(),
    password: $password.value,
    enabled: $enabled.checked,
  };
  if (!cfg.username || !cfg.password) {
    setStatus('请填写学号和密码。', true);
    return;
  }
  await chrome.storage.local.set({ [CFG_KEY]: cfg });
  setStatus('已保存 ✓ 刷新上财登录页即可自动登录。');
});

async function activeLoginTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith(LOGIN_URL_PREFIX)) return null;
  return tab;
}

async function injectAndRun(tab, runNow, testOnly) {
  if (runNow) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__SUFE_RUN_NOW__ = true; },
    });
  }
  if (testOnly) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__SUFE_TEST_ONLY__ = true; },
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['sufe-crypto.js', 'sufe-cnn-weights.js', 'sufe-cnn.js', 'content.js'],
  });
}

async function sendTest(tab, msgType) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: msgType });
  } catch (e) {
    await injectAndRun(tab, false, true);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { return await chrome.tabs.sendMessage(tab.id, { type: msgType }); } catch (e2) { /* retry */ }
    }
    throw e;
  }
}

$login.addEventListener('click', async () => {
  const tab = await activeLoginTab();
  if (!tab) {
    setStatus('请先在当前标签页打开上财登录页（login.sufe.edu.cn），再点「登录」。', true);
    return;
  }
  setStatus('正在登录…（结果见页面右上角浮窗）');
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SUFE_RUN_NOW' });
    setStatus('已通知页面开始登录，请看页面浮窗 ✓');
  } catch (e) {
    try {
      await injectAndRun(tab, true);
      setStatus('已注入脚本并开始登录，请看页面浮窗 ✓');
    } catch (e2) {
      setStatus('注入失败：' + (e2 && e2.message ? e2.message : e2) + '\n请刷新登录页后重试。', true);
    }
  }
});

$test.addEventListener('click', async () => {
  const tab = await activeLoginTab();
  if (!tab) {
    setStatus('请先打开上财登录页（login.sufe.edu.cn）标签页，再点击测试。', true);
    return;
  }
  setStatus('滑块测试中（最多 3 轮）…');
  try {
    const res = await sendTest(tab, 'SUFE_TEST_SLIDER');
    if (res && res.ok) {
      setStatus('✓ 滑块可正常通过：' + res.detail);
    } else {
      setStatus('✗ 未通过（多为风控收紧期，稍后再试）：\n' + (res ? res.detail : '无响应'), true);
    }
  } catch (e) {
    setStatus('测试失败：' + (e && e.message ? e.message : e) + '\n（请确认当前标签页是登录页且已刷新）', true);
  }
});

$testVcode.addEventListener('click', async () => {
  const tab = await activeLoginTab();
  if (!tab) {
    setStatus('请先打开上财登录页（login.sufe.edu.cn）标签页，再点击测试。', true);
    return;
  }
  setStatus('验证码识别测试中（5 张，不登录）…');
  try {
    const res = await sendTest(tab, 'SUFE_TEST_VCODE');
    if (res && res.detail) {
      setStatus('高置信 ' + res.highConf + '\n' + res.detail);
    } else {
      setStatus('测试无响应，请刷新登录页后重试。', true);
    }
  } catch (e) {
    setStatus('测试失败：' + (e && e.message ? e.message : e) + '\n（请确认当前标签页是登录页且已刷新）', true);
  }
});
