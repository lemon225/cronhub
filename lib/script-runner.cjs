/*
 * 青龙式脚本的执行内核 —— 跑在 worker 线程里，不是主进程。
 *
 * 为什么非要单独开线程：
 *   vm 的 timeout 只对「同步执行」有效。脚本写 `await sleep(10); while(true){}`，
 *   vm 的 5 秒超时早就过了，但后续同步代码是在微任务里跑的，vm 管不到 ——
 *   主进程会被这个死循环按死，调度、HTTP、保活全部停摆，只能等 watchdog 重启。
 *   实测（2026-11-21）：该脚本让整个进程卡死，Promise.race 的超时分支永远不触发。
 *   放进 worker 后主线程可以直接 terminate()，卡死与僵尸脚本都被物理切断。
 *
 * 沙箱边界：**不是安全沙箱**，只做「防手滑」级别的隔离。见文件末尾说明。
 */
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const crypto = require('node:crypto');
const httpClient = require('./http-client.cjs');
const { isPrivateHost } = require('./net-guard.cjs');

const {
  code = '',
  env = {},
  guardPrivate = false,
  outputMax = 20000,
  stepName = '',
  fetchTimeoutMs = 30000,
  bodyMax = 1024 * 1024,
  syncTimeoutMs = 5000,
} = workerData || {};

/* ------------------------------------------------------------------ 输出收集
 * 逐行推给主线程，主线程再统一截断。worker 自己也记一份，用于「失败时把日志带回去」。
 */
let used = 0;
const logs = [];
function emit(line) {
  const s = String(line == null ? '' : line);
  if (!s) return;
  if (used >= outputMax) return;
  const room = outputMax - used;
  const part = s.length > room ? s.slice(0, room) : s;
  used += part.length;
  logs.push(part);
  if (parentPort) parentPort.postMessage({ type: 'log', line: part });
}

/*
 * 错误定位：vm 的 message 只有「Unexpected token」或「boom」，不带位置 ——
 * 手机上看到这句话完全不知道死在哪一行。stack 里有 `script:任务名:3:21`，
 * 而执行体外面包了一层 `(async () => {`，所以行号减 1 才是用户编辑器里的行号。
 */
function errWhere(err, maxLine) {
  const st = String((err && err.stack) || '');
  const m = st.match(/script:([^:\n]*):(\d+)(?::(\d+))?/);
  if (!m) return '';
  let line = Math.max(1, Number(m[2]) - 1);
  // 语法错误的报错点常常落在执行体末尾的 })() 上，会指到用户代码外面去
  if (maxLine && line > maxLine) line = maxLine;
  const col = Number(m[3]) || 0;
  return `（第 ${line} 行${col ? ` 第 ${col} 列` : ''}）`;
}

/** 环境变量替换：与主进程 applyEnvVars 语义保持一致（{{KEY}}，大小写不敏感）。 */
function applyEnv(str) {
  const raw = String(str || '');
  if (!raw.includes('{{')) return raw;
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    const hit = Object.keys(env).find((k) => k.toUpperCase() === String(key).toUpperCase());
    return hit === undefined ? m : String(env[hit]);
  });
}

/* ------------------------------------------------------------------ 宿主能力
 * 这些函数只在 worker 里被 facade 通过闭包调用，绝不直接交给脚本 ——
 * 直接交出宿主函数，脚本一句 `console.log.constructor('return process')()` 就能出去。
 */
const timers = new Map();
let timerSeq = 0;

async function doRequest(urlStr, optsJson) {
  const opts = optsJson ? JSON.parse(optsJson) : {};
  const url = applyEnv(String(urlStr || ''));
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 地址');
  if (guardPrivate) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* 交给下面的请求层报错 */ }
    if (host && isPrivateHost(host)) throw new Error(`私网地址被拦截：${host}`);
  }
  const method = String(opts.method || 'GET').toUpperCase();
  /*
   * 请求头与请求体也要做 {{变量}} 替换，跟主进程 applyEnvVars 对齐：
   * 以前只替换 URL，脚本里写 headers: { 'X-QW-Api-Key': '{{QWKEY}}' } 会把
   * 字面量发出去，上游回 401，排查半天以为是密钥错了。
   */
  const headers = {};
  if (opts.headers && typeof opts.headers === 'object') {
    for (const [k, v] of Object.entries(opts.headers)) headers[applyEnv(k)] = applyEnv(String(v));
  }
  const body = opts.body == null ? undefined : applyEnv(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  const began = Date.now();
  const res = await httpClient.request(url, {
    method,
    headers,
    body,
    timeoutMs: fetchTimeoutMs,
  });
  const text = await res.text().catch(() => '');
  const clipped = text.length > bodyMax ? text.slice(0, bodyMax) : text;
  return JSON.stringify({
    ok: !!res.ok,
    status: res.status,
    statusText: '',
    url: res.url || url,
    headers: Object.entries(res.headers || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    body: clipped,
    truncated: text.length > bodyMax,
    ms: Date.now() - began,
  });
}

const host = {
  log: (line) => emit(line),

  sleep: (ms, cb) => {
    const t = setTimeout(() => { try { cb(); } catch (e) { emit('sleep 回调异常：' + ((e && e.message) || e)); } }, Math.max(0, Math.min(60000, Number(ms) || 0)));
    return t;
  },

  setTimer: (ms, fn, args) => {
    const id = ++timerSeq;
    const t = setTimeout(() => {
      timers.delete(id);
      try { fn.apply(null, Array.isArray(args) ? args : []); } catch (e) { emit('定时回调异常：' + ((e && e.message) || e)); }
    }, Math.max(0, Math.min(600000, Number(ms) || 0)));
    timers.set(id, t);
    return id;
  },
  clearTimer: (id) => {
    const t = timers.get(Number(id));
    if (t) { clearTimeout(t); timers.delete(Number(id)); }
  },

  async request(url, optsJson) {
    try {
      return await doRequest(url, optsJson);
    } catch (e) {
      return JSON.stringify({ error: String((e && e.message) || e) });
    }
  },

  url: (input, base) => {
    try {
      const u = base ? new URL(input, base) : new URL(input);
      return JSON.stringify({
        href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname,
        port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
        username: u.username, password: u.password,
      });
    } catch {
      return JSON.stringify({ error: 'invalid url' });
    }
  },

  utf8: (s) => JSON.stringify([...Buffer.from(String(s), 'utf8')]),
  fromUtf8: (json) => Buffer.from(JSON.parse(String(json))).toString('utf8'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  uuid: () => crypto.randomUUID(),
  randHex: (n) => crypto.randomBytes(Math.max(0, Math.min(1024, Number(n) || 0))).toString('hex'),
  async digest(name, bytes) {
    const alg = String(name || 'SHA-256').replace('-', '').toLowerCase();
    const h = crypto.createHash(alg);
    h.update(Buffer.from(bytes));
    return h.digest('hex');
  },
};

/*
 * 能力 facade：全部在上下文内部用箭头函数/类包一层，脚本手上永远只有「本 realm」的对象。
 * 顺手把 URL / URLSearchParams / TextEncoder / TextDecoder / crypto 补上 ——
 * 它们不是 JS 内建，vm 上下文里没有，青龙脚本却天天用。
 * 不能直接把宿主实例丢进去：宿主对象带宿主原型链，`x.constructor.constructor` 就出去了。
 */
const FACADE_SRC = `(function () {
  var H = __host;
  var slice = Array.prototype.slice;

  function fmt(x) {
    if (typeof x === 'string') return x;
    if (typeof x === 'undefined') return 'undefined';
    if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message;
    try { var s = JSON.stringify(x); return typeof s === 'undefined' ? String(x) : s; } catch (e) { return String(x); }
  }
  function logLine() { H.log(slice.call(arguments).map(fmt).join(' ')); }
  globalThis.console = { log: logLine, info: logLine, warn: logLine, error: logLine, debug: logLine };

  globalThis.env = Object.freeze(JSON.parse(__envJson));

  globalThis.sleep = function (ms) {
    var n = Number(ms) || 0;
    // 宿主侧超时上限是 60 秒；以前静默截断，脚本以为等了两分钟其实只等了一分钟
    if (n > 60000) return Promise.reject(new Error('wait 最长 60000 毫秒，更长的等待请拆成多次'));
    return new Promise(function (resolve) { H.sleep(Math.max(0, n), resolve); });
  };
  // 同义别名：save 接口前的腾讯 WAF 把 "sleep(30)" 当成 SQL 注入特征直接 403，
  // 用户保存带 sleep(数字) 的脚本会看到一张拦截页。wait(ms) 没有这个误伤。
  globalThis.wait = globalThis.sleep;
  globalThis.setTimeout = function (fn, ms) { return H.setTimer(Number(ms) || 0, fn, slice.call(arguments, 2)); };
  globalThis.clearTimeout = function (id) { H.clearTimer(Number(id)); };
  globalThis.setInterval = function () { throw new Error('不支持 setInterval，请用 while(true){ await sleep(ms) } 并在超时内退出'); };

  function Headers(init) {
    this._m = {};
    var self = this;
    if (init instanceof Headers) {
      init.forEach(function (v, k) { self._m[String(k).toLowerCase()] = String(v); });
    } else if (Array.isArray(init)) {
      init.forEach(function (p) { if (p && p.length >= 2) self._m[String(p[0]).toLowerCase()] = String(p[1]); });
    } else if (init && typeof init === 'object') {
      Object.keys(init).forEach(function (k) { self._m[String(k).toLowerCase()] = String(init[k]); });
    }
  }
  Headers.prototype.get = function (k) { var v = this._m[String(k).toLowerCase()]; return v === undefined ? null : v; };
  Headers.prototype.has = function (k) { return Object.prototype.hasOwnProperty.call(this._m, String(k).toLowerCase()); };
  Headers.prototype.set = function (k, v) { this._m[String(k).toLowerCase()] = String(v); };
  Headers.prototype.append = function (k, v) {
    var key = String(k).toLowerCase();
    this._m[key] = this.has(key) ? this._m[key] + ', ' + String(v) : String(v);
  };
  Headers.prototype.delete = function (k) { delete this._m[String(k).toLowerCase()]; };
  Headers.prototype.forEach = function (fn) {
    var self = this;
    Object.keys(this._m).forEach(function (k) { fn(self._m[k], k); });
  };
  Headers.prototype.keys = function () { return Object.keys(this._m)[Symbol.iterator](); };
  Headers.prototype.values = function () { var self = this; return Object.keys(this._m).map(function (k) { return self._m[k]; })[Symbol.iterator](); };
  Headers.prototype.entries = function () { var self = this; return Object.keys(this._m).map(function (k) { return [k, self._m[k]]; })[Symbol.iterator](); };
  Headers.prototype[Symbol.iterator] = function () { return this.entries(); };
  globalThis.Headers = Headers;

  /** 把 body 变成宿主能直接发出的字符串；URLSearchParams / Uint8Array / ArrayBuffer 都要认。 */
  function bodyToText(b) {
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) {
      return H.fromUtf8(JSON.stringify(slice.call(new Uint8Array(b))));
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(b)) {
      return H.fromUtf8(JSON.stringify(slice.call(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))));
    }
    return b;
  }

  globalThis.fetch = async function (input, init) {
    var opts = null;
    if (init) {
      opts = {};
      if (init.method) opts.method = String(init.method);
      if (init.headers) {
        if (init.headers instanceof Headers) {
          var hs = {};
          init.headers.forEach(function (v, k) { hs[k] = v; });
          opts.headers = hs;
        } else if (Array.isArray(init.headers)) {
          var ha = {};
          init.headers.forEach(function (p) { if (p && p.length >= 2) ha[String(p[0])] = String(p[1]); });
          opts.headers = ha;
        } else {
          opts.headers = init.headers;
        }
      }
      /*
       * body 不能无脑丢给宿主 JSON.stringify：new URLSearchParams({a:1}) 会被序列化成
       * {"_l":[["a","1"]]}，上游收到一坨没人认识的 JSON（实测确认）。这里先转字符串。
       */
      if (init.body != null) opts.body = bodyToText(init.body);
    }
    var d = JSON.parse(await H.request(String(input), opts ? JSON.stringify(opts) : ''));
    if (d && d.error) throw new Error(d.error);
    var rows = d.headers || [];
    var headers = {
      get: function (k) {
        var t = String(k).toLowerCase();
        for (var i = 0; i < rows.length; i++) if (String(rows[i][0]).toLowerCase() === t) return rows[i][1];
        return null;
      },
      has: function (k) { return this.get(k) !== null; },
      forEach: function (fn) { rows.forEach(function (p) { fn(p[1], p[0]); }); },
    };
    var text = async function () { return d.body == null ? '' : String(d.body); };
    return {
      ok: !!d.ok,
      status: d.status,
      statusText: d.statusText || '',
      url: d.url || String(input),
      redirected: false,
      headers: headers,
      text: text,
      json: async function () {
        var t = await text();
        if (!t) throw new Error('响应正文为空，无法解析 JSON（HTTP ' + d.status + '）');
        try { return JSON.parse(t); }
        catch (e) { throw new Error('响应不是合法 JSON（HTTP ' + d.status + '）：' + String(t).slice(0, 80)); }
      },
      arrayBuffer: async function () { return new TextEncoder().encode(await text()).buffer; },
    };
  };

  globalThis.btoa = function (s) { return H.btoa(String(s)); };
  globalThis.atob = function (s) { return H.atob(String(s)); };

  function TextEncoder() { this.encoding = 'utf-8'; }
  TextEncoder.prototype.encode = function (s) {
    var b = JSON.parse(H.utf8(String(s == null ? '' : s)));
    return new Uint8Array(b);
  };
  TextEncoder.prototype.encodeInto = function (s, dest) {
    var b = JSON.parse(H.utf8(String(s == null ? '' : s)));
    var n = Math.min(dest.length, b.length);
    for (var i = 0; i < n; i++) dest[i] = b[i];
    return { read: String(s == null ? '' : s).length, written: n };
  };
  globalThis.TextEncoder = TextEncoder;

  function TextDecoder(label) { this.encoding = 'utf-8'; this.label = label || 'utf-8'; }
  TextDecoder.prototype.decode = function (buf) {
    if (!buf) return '';
    var a = slice.call(new Uint8Array(buf.buffer || buf));
    return H.fromUtf8(JSON.stringify(a));
  };
  globalThis.TextDecoder = TextDecoder;

  function dec(s) { return decodeURIComponent(String(s).replace(/\\+/g, ' ')); }
  function enc(s) { return encodeURIComponent(String(s)).replace(/%20/g, '+'); }

  function URLSearchParams(init) {
    var list = [];
    if (typeof init === 'string') {
      var s = init.charAt(0) === '?' ? init.slice(1) : init;
      if (s) s.split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        list.push(i < 0 ? [dec(pair), ''] : [dec(pair.slice(0, i)), dec(pair.slice(i + 1))]);
      });
    } else if (Array.isArray(init)) {
      init.forEach(function (p) { if (p && p.length) list.push([String(p[0]), String(p[1] == null ? '' : p[1])]); });
    } else if (init && typeof init === 'object') {
      Object.keys(init).forEach(function (k) { list.push([k, String(init[k] == null ? '' : init[k])]); });
    }
    this._l = list;
  }
  URLSearchParams.prototype.append = function (k, v) { this._l.push([String(k), String(v)]); };
  URLSearchParams.prototype.delete = function (k) { this._l = this._l.filter(function (p) { return p[0] !== String(k); }); };
  URLSearchParams.prototype.get = function (k) {
    for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === String(k)) return this._l[i][1];
    return null;
  };
  URLSearchParams.prototype.getAll = function (k) {
    return this._l.filter(function (p) { return p[0] === String(k); }).map(function (p) { return p[1]; });
  };
  URLSearchParams.prototype.has = function (k) { return this.get(k) !== null; };
  URLSearchParams.prototype.set = function (k, v) {
    var done = false;
    this._l = this._l.filter(function (p) {
      if (p[0] !== String(k)) return true;
      if (done) return false;
      done = true;
      p[1] = String(v);
      return true;
    });
    if (!done) this._l.push([String(k), String(v)]);
  };
  URLSearchParams.prototype.forEach = function (fn) { this._l.forEach(function (p) { fn(p[1], p[0]); }); };
  URLSearchParams.prototype.keys = function () { return this._l.map(function (p) { return p[0]; })[Symbol.iterator](); };
  URLSearchParams.prototype.values = function () { return this._l.map(function (p) { return p[1]; })[Symbol.iterator](); };
  URLSearchParams.prototype.entries = function () { return this._l.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); };
  URLSearchParams.prototype[Symbol.iterator] = function () { return this.entries(); };
  URLSearchParams.prototype.toString = function () {
    var self = this;
    return this._l.map(function (p) { return enc(p[0]) + '=' + enc(p[1]); }).join('&');
  };
  Object.defineProperty(URLSearchParams.prototype, 'size', { get: function () { return this._l.length; } });
  globalThis.URLSearchParams = URLSearchParams;

  function URL(input, base) {
    var d = JSON.parse(H.url(String(input), base == null ? '' : String(base)));
    if (d.error) throw new TypeError('Invalid URL: ' + input);
    this.href = d.href; this.origin = d.origin; this.protocol = d.protocol;
    this.host = d.host; this.hostname = d.hostname; this.port = d.port;
    this.pathname = d.pathname; this.search = d.search; this.hash = d.hash;
    this.username = d.username; this.password = d.password;
    this.searchParams = new URLSearchParams(d.search);
  }
  URL.prototype.toString = function () { return this.href; };
  URL.prototype.toJSON = function () { return this.href; };
  globalThis.URL = URL;

  globalThis.crypto = {
    randomUUID: function () { return H.uuid(); },
    getRandomValues: function (arr) {
      var hex = H.randHex(arr.length);
      for (var i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
      return arr;
    },
    subtle: {
      digest: async function (alg, data) {
        var name = typeof alg === 'string' ? alg : (alg && alg.name) || 'SHA-256';
        var bytes = slice.call(new Uint8Array(data));
        var hex = await H.digest(name, bytes);
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out.buffer;
      },
    },
  };
})();`;

function buildContext() {
  const sandbox = { __host: host, __envJson: JSON.stringify(env) };
  const ctx = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name: 'cronhub-script',
  });
  vm.runInContext(FACADE_SRC, ctx, { timeout: 3000, filename: 'cronhub-facade.js' });
  // facade 跑完就断开脚本对宿主桥的直接引用：之后从闭包里拿，全局上摸不到。
  vm.runInContext('delete globalThis.__host; delete globalThis.__envJson;', ctx, { timeout: 1000 });
  return ctx;
}

/* ------------------------------------------------------------------ 执行 */
(async () => {
  const t0 = Date.now();
  let ctx;
  try {
    ctx = buildContext();
  } catch (e) {
    if (parentPort) parentPort.postMessage({ type: 'fail', message: '沙箱初始化失败：' + ((e && e.message) || e) });
    return;
  }

  // 同步段单独设闸：await 之后的死循环靠主线程 terminate。
  const wrapped = `(async () => {\n${code}\n})()`;
  let result;
  try {
    result = await vm.runInContext(wrapped, ctx, {
      timeout: Math.max(500, Number(syncTimeoutMs) || 5000),
      filename: stepName ? `script:${stepName}` : 'script.js',
      displayErrors: true,
    });
  } catch (e) {
    let msg = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    // vm 报的是英文 "Script execution timed out after 5000ms"，用户看不懂死在哪
    if (/script execution timed out/i.test(msg)) {
      msg = `同步代码执行超过 ${Math.round((Number(syncTimeoutMs) || 5000) / 1000)} 秒（多半是死循环），已中止`;
    } else {
      const where = errWhere(e, code.split('\n').length);
      if (e && e.name === 'SyntaxError') msg = '语法错误：' + msg + where;
      else if (where) msg += where;
    }
    if (parentPort) parentPort.postMessage({ type: 'fail', message: msg, logs: logs.join('\n') });
    return;
  }

  let text = logs.join('\n');
  if (result != null) {
    const tail = typeof result === 'string' ? result : (() => { try { return JSON.stringify(result); } catch { return String(result); } })();
    text = text ? text + '\n' + tail : tail;
  }
  if (text.length > outputMax) {
    // 静默截断会让用户以为脚本只输出了这么多，加一句明确的标记
    text = text.slice(0, outputMax) + `\n…[输出超过 ${outputMax} 字符，已截断]`;
  }
  if (parentPort) parentPort.postMessage({ type: 'done', text, ms: Date.now() - t0 });
})();

/*
 * 边界声明（别把它当安全沙箱）：
 *   - 脚本拿不到 require / process / fs，constructor 字符串代码生成被禁用，
 *     注入的宿主能力全部经 facade 包了一层，常见的「顺手读个文件」进不来；
 *   - 但 vm 官方明确不是安全边界，真正恶意且执着的代码仍可能找到别的路；
 *   - 真正的隔离靠线程：卡死、死循环、内存爆掉都在 worker 里，主进程 terminate 了事。
 * 结论：跑自己写的 / 信得过的脚本。来路不明的脚本别往里贴。
 */
