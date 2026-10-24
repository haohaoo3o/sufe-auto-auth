// 上财自动认证 · 后台：模型加载与离线推理、打开设置页
importScripts('sufe-crnn.js');

let modelReady = null;

function ensureModel() {
  if (!modelReady) {
    modelReady = SufeCRNN.load({
      json: chrome.runtime.getURL('model.json'),
      bin: chrome.runtime.getURL('model.bin'),
    }).catch((e) => {
      modelReady = null;
      throw e;
    });
  }
  return modelReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'openSettings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    return false;
  }
  if (msg && msg.type === 'SUFE_WARMUP') {
    (async () => {
      await ensureModel();
      SufeCRNN.predict(new Float32Array(3 * 34 * 80));
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }
  if (msg && msg.type === 'SUFE_INFER') {
    (async () => {
      await ensureModel();
      const bin = atob(msg.pixels || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const input = new Float32Array(bytes.buffer);
      if (input.length !== 3 * 34 * 80) throw new Error('输入尺寸错误：' + input.length);
      const t0 = performance.now();
      const r = SufeCRNN.predict(input);
      sendResponse({
        ok: true, text: r.text, minProb: r.minProb,
        ms: Math.round(performance.now() - t0),
      });
    })().catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }
  return false;
});
