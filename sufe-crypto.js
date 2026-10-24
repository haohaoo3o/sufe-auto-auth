/*
 * 上财自动认证 · RSA(PKCS#1 v1.5) 密码加密模块
 * 供内容脚本与 Node 自测脚本共用；纯 JS 实现，无任何依赖。
 * 背景：服务端下发 1024-bit RSA 公钥（Base64/DER，SPKI 或 PKCS#1 格式），
 *       浏览器 WebCrypto 不支持 RSAES-PKCS1-v1_5，故自行实现 modPow。
 */
(function (root) {
  'use strict';

  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64Decode(s) {
    s = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
    var out = [];
    var bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '=') break;
      var v = B64C.indexOf(ch);
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    return new Uint8Array(out);
  }

  function b64Encode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
      out += B64C[b0 >> 2];
      out += B64C[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? '=' : B64C[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? '=' : B64C[b2 & 63];
    }
    return out;
  }

  // 极简 DER 遍历：返回 { tag, contentStart, next }
  function tlv(buf, pos) {
    var tag = buf[pos];
    var first = buf[pos + 1];
    var len, contentStart;
    if (first & 0x80) {
      var n = first & 0x7f;
      len = 0;
      for (var i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
      contentStart = pos + 2 + n;
    } else {
      len = first;
      contentStart = pos + 2;
    }
    return { tag: tag, contentStart: contentStart, next: contentStart + len };
  }

  // 解析 RSA 公钥 DER（兼容 SPKI 与 PKCS#1），返回 { n, e, k(模数字节数) }
  function parsePublicDer(der) {
    var outer = tlv(der, 0);
    if (outer.tag !== 0x30) throw new Error('公钥 DER 异常：缺少外层 SEQUENCE');
    var first = tlv(der, outer.contentStart);
    var ints = [];
    if (first.tag === 0x30) {
      // SubjectPublicKeyInfo：SEQUENCE { AlgorithmIdentifier, BIT STRING }
      var bitStr = tlv(der, first.next);
      if (bitStr.tag !== 0x03) throw new Error('公钥 DER 异常：缺少 BIT STRING');
      var seq = tlv(der, bitStr.contentStart + 1); // +1 跳过未用位数 0x00
      var p = seq.contentStart;
      for (var i = 0; i < 2; i++) { var t = tlv(der, p); ints.push([t.contentStart, t.next]); p = t.next; }
    } else if (first.tag === 0x02) {
      // PKCS#1 RSAPublicKey：SEQUENCE { INTEGER n, INTEGER e }
      var q = outer.contentStart;
      for (var j = 0; j < 2; j++) { var t2 = tlv(der, q); ints.push([t2.contentStart, t2.next]); q = t2.next; }
    } else {
      throw new Error('公钥 DER 异常：未知结构');
    }
    function toBigInt(a, b) { var v = 0n; for (var x = a; x < b; x++) v = (v << 8n) | BigInt(der[x]); return v; }
    var n = toBigInt(ints[0][0], ints[0][1]);
    var e = toBigInt(ints[1][0], ints[1][1]);
    var bits = 0, t3 = n;
    while (t3 > 0n) { bits++; t3 >>= 1n; }
    return { n: n, e: e, k: Math.ceil(bits / 8) };
  }

  function modPow(base, exp, mod) {
    var r = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) r = (r * base) % mod;
      base = (base * base) % mod;
      exp >>= 1n;
    }
    return r;
  }

  function bytesToBigInt(b) { var v = 0n; for (var i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]); return v; }

  function bigIntToBytes(v, len) {
    var out = new Uint8Array(len);
    for (var i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }

  // 非零随机数填充（PKCS#1 v1.5 要求 PS 均为非零字节）
  function randomNonZero(len) {
    var out = new Uint8Array(len);
    var g = globalThis.crypto;
    var i = 0;
    while (i < len) {
      var buf = new Uint8Array(len * 2 + 8);
      g.getRandomValues(buf);
      for (var j = 0; j < buf.length && i < len; j++) if (buf[j] !== 0) out[i++] = buf[j];
    }
    return out;
  }

  function pkcs1Encrypt(msgBytes, n, e, k, rand) {
    if (msgBytes.length > k - 11) throw new Error('明文超出 PKCS#1 v1.5 长度上限');
    var em = new Uint8Array(k);
    em[0] = 0; em[1] = 2;
    var psLen = k - msgBytes.length - 3;
    em.set(rand(psLen), 2);
    em[2 + psLen] = 0;
    em.set(msgBytes, 3 + psLen);
    return bigIntToBytes(modPow(bytesToBigInt(em), e, n), k);
  }

  // password 明文 + publicKey(Base64 DER) → Base64 密文
  function encryptPassword(password, publicKeyB64) {
    var der = b64Decode(publicKeyB64);
    var key = parsePublicDer(der);
    var msg = new TextEncoder().encode(password);
    var c = pkcs1Encrypt(msg, key.n, key.e, key.k, randomNonZero);
    return b64Encode(c);
  }

  var api = {
    encryptPassword: encryptPassword,
    parsePublicDer: parsePublicDer,
    _b64Decode: b64Decode,
    _b64Encode: b64Encode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SufeCrypto = api;
})(typeof self !== 'undefined' ? self : globalThis);
