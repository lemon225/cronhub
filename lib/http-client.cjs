'use strict';

/**
 * CronHub HTTP 客户端（零依赖）
 *
 * 为什么不用全局 fetch：
 *   Node 内置的 fetch 走 undici，连接池的 keepAliveTimeout 只有 4 秒且无法配置
 *   （要改得引入 undici 包，而本项目坚持零依赖）。4 秒意味着「上一次调用结束到下一次
 *   开始」超过 4 秒，连接就被关掉，下一个任务又从 DNS 查询、TCP 三次握手、TLS 握手
 *   重来一遍。实测同一个境外接口：
 *       每次新连接   981 / 1788 / 1474 ms
 *       连接复用后   175 / 174 ms
 *   差距接近 9 倍，而这段开销纯粹是握手，不是接口慢。
 *
 * 这个模块做三件事：
 *   1. 全局 keep-alive Agent —— 连接池复用，空闲连接保活 60 秒；
 *   2. DNS 缓存 —— 命中后跳过解析（实测首次 215ms，命中 3ms），TTL 5 分钟；
 *   3. TLS 会话缓存 —— 即使连接被断开，重建时也用 session ticket 走 1-RTT 恢复，
 *      而不是完整的 2-RTT 握手（maxCachedSessions）。
 *
 * 另外顺带把 fetch 默认帮我们做的事补齐了：跟随重定向、解压 gzip/deflate/br、
 * 超时中断、响应体大小上限。行为尽量与 fetch 对齐，避免换引擎把已有任务跑坏。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const dns = require('dns');

const DNS_TTL_MS = 5 * 60 * 1000;
const DNS_MAX_ENTRIES = 500;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB，超出直接报错而不是把内存吃光
const MAX_REDIRECTS = 5;

/* ------------------------------------------------------------------ DNS 缓存 */

const dnsCache = new Map(); // hostname -> { at, addrs: [{ address, family }] }

function evictDns() {
  if (dnsCache.size <= DNS_MAX_ENTRIES) return;
  // Map 保持插入顺序，淘汰最早进来的那批即可（足够用，不必上 LRU）
  const drop = dnsCache.size - DNS_MAX_ENTRIES;
  let i = 0;
  for (const k of dnsCache.keys()) {
    dnsCache.delete(k);
    if (++i >= drop) break;
  }
}

/**
 * 给 http(s).request 用的 lookup：命中缓存直接回，未命中查一次再缓存。
 * 注意要同时支持 { all: true } 和老式的 (err, address, family) 回调形态，
 * 两种形态 Node 都会用，弄错会导致某些请求回调参数错位。
 */
function cachedLookup(hostname, options, callback) {
  const opts = options && typeof options === 'object' ? options : { family: options };
  const wantAll = !!opts.all;
  const family = Number(opts.family) || 0;

  const pick = (addrs) => {
    // 缓存里可能只有另一族的地址（此前按 family 查过）。这时不能报 ENOTFOUND，
    // 退回全量地址交给 autoSelectFamily 去选，否则会莫名其妙「域名解析失败」。
    const list = family ? addrs.filter((a) => a.family === family) : addrs;
    return list.length ? list : addrs;
  };

  const deliver = (addrs) => {
    const list = pick(addrs);
    if (!list.length) {
      const e = new Error(`域名解析失败：${hostname}`);
      e.code = 'ENOTFOUND';
      return callback(e);
    }
    if (wantAll) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  };

  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return deliver(hit.addrs);

  dns.lookup(hostname, { family, hints: opts.hints, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs || !addrs.length) {
      const e = new Error(`域名解析失败：${hostname}`);
      e.code = 'ENOTFOUND';
      return callback(e);
    }
    dnsCache.set(hostname, { at: Date.now(), addrs });
    evictDns();
    deliver(addrs);
  });
}

/* ------------------------------------------------------------------ 连接池 */

/** 公共连接参数：DNS 缓存 + Happy Eyeballs（IPv6 不通时 300ms 内退回 IPv4） */
const connectOptions = {
  lookup: cachedLookup,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 300,
};

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 32,
  maxFreeSockets: 8,
  scheduling: 'lifo',
  ...connectOptions,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 32,
  maxFreeSockets: 8,
  scheduling: 'lifo',
  // TLS 会话缓存：连接断了以后重建仍可 1-RTT，省一个来回
  maxCachedSessions: 200,
  ...connectOptions,
});

/* ------------------------------------------------------------------ 解压 */

function decompress(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return res;
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/**
 * 读完整响应体并转字符串，超过上限就中断，避免被超大响应拖垮。
 *
 * 这里必须同时盯住「解压流」和「底层响应」两条线：res.pipe(gunzip) 不会把源流的
 * aborted / error 传播给 gunzip。上游 gzip 传到一半断开时，gunzip 既等不到 end 也收不到
 * error，Promise 就永远不 settle —— 而 runTask 在 await 它，tick 的全局 ticking 锁又不会
 * 释放，最终整个调度器假死，只能重启进程。所以底层 res 的 close/error 一律兜到 fail()。
 */
function readBody(stream, source) {
  const src = source || stream;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      src.removeListener('aborted', onAborted);
      src.removeListener('error', onSrcError);
      src.removeListener('close', onSrcClose);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { stream.destroy(); } catch { /* noop */ }
      if (src !== stream) { try { src.destroy(); } catch { /* noop */ } }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onAborted = () => fail(new Error('响应中途断开（aborted）'));
    const onSrcError = (e) => fail(e || new Error('响应流错误'));
    const onSrcClose = () => {
      // 正常读完时 end 先触发、监听已在 done() 里摘掉；能走到这里说明连接没正常结束。
      // 宁可让这一次任务失败（可重试），也不要让 Promise 永远 pending 把 ticking 锁死。
      if (!settled) fail(new Error('响应未读完连接已关闭'));
    };
    /*
     * 底层响应一律兜住，不能只在解压路径（src !== stream）注册。
     * decompress() 对没有 content-encoding 的响应直接返回 res 本身，此时 src === stream：
     * 旧写法会跳过注册，上游中途断连若只触发 aborted / close 而不触发 error，
     * done() 和 fail() 都不会被调用，Promise 永远 pending → runTask 卡住 → ticking 锁死。
     * 同一对象上多挂几个监听没有副作用，fail() 有 settled 保护，cleanup() 会一并摘掉。
     */
    src.on('aborted', onAborted);
    src.on('error', onSrcError);
    src.on('close', onSrcClose);
    stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error(`响应体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 上限，已中断`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', done);
    stream.on('error', fail);
  });
}

/* ------------------------------------------------------------------ 请求 */

function headersToObject(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    else if (v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function normalizeBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body), 'utf8');
}

/**
 * 分段耗时采集（可选）。传了 init.timing 对象才会挂事件，不影响其他调用方。
 *
 * 为什么要这个：中继链路的耗时一直是「一个总数」，出问题只能猜是握手慢、
 * 跨境慢还是对端处理慢。把 DNS / TCP / TLS / 首字节拆开以后，一眼就能看出
 * 瓶颈在哪一段 —— 复用连接时 connectMs/tlsMs 为 0 本身就是证据。
 */
function attachTiming(req, timing, t0) {
  if (!timing || typeof timing !== 'object') return;
  timing.reused = null;
  timing.connectMs = 0;
  timing.tlsMs = 0;
  timing.ttfbMs = 0;

  /*
   * 判定「是否复用」只看「这次请求期间有没有真的发生 connect / secureConnect」。
   * 不能用 socket.connecting：TLS socket 的这个属性在这里并不可靠，
   * 新建的 https 连接也会被读成 false，结果把每次新建连接都标成「复用」。
   */
  let sawConnect = false;
  req.on('socket', (socket) => {
    socket.once('connect', () => {
      sawConnect = true;
      timing.connectMs = Date.now() - t0;
    });
    if (socket.encrypted) {
      socket.once('secureConnect', () => {
        sawConnect = true;
        timing.tlsMs = Math.max(0, Date.now() - t0 - timing.connectMs);
      });
    }
  });

  req.on('response', () => {
    timing.reused = !sawConnect;
    timing.ttfbMs = Math.max(0, Date.now() - t0 - timing.connectMs - timing.tlsMs);
  });
}

/** 单次请求，不做重定向。 */
function once(urlStr, init) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = normalizeBody(init.body);

    const headers = { ...(init.headers || {}) };
    // 没显式要求压缩就不要 —— 少一层解压，也少一个出错点
    if (body) headers['Content-Length'] = String(body.length);

    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers,
      agent: isHttps ? httpsAgent : httpAgent,
    };

    /*
     * 清理函数交给 request() 在「建连 + 读体」全部结束后统一调用。
     * 以前挂在 req 的 close 上，而 close 在响应头到达后不久就触发，导致读体阶段
     * AbortSignal.timeout 已经失效 —— 大响应或慢上游就彻底失去超时保护。
     */
    let onAbort = null;
    const signal = init.signal;
    const cleanup = () => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const req = lib.request(opts, (res) => {
      resolve({ res, url: urlStr, cleanup });
    });
    attachTiming(req, init.timing, Date.now());

    const timeoutMs = Number(init.timeoutMs) || 30000;
    req.setTimeout(timeoutMs, () => {
      const e = new Error('请求超时');
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });

    // AbortSignal 支持（runHttpTask 传的是 AbortSignal.timeout）
    if (signal) {
      if (signal.aborted) {
        req.destroy(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }));
      } else {
        onAbort = () => req.destroy(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 与 fetch 用法对齐的最小实现：request(url, { method, headers, body, signal, timeoutMs })
 * 返回 { status, ok, url, headers, text() }
 */
async function request(urlStr, init = {}) {
  let current = urlStr;
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  const t0All = Date.now();
  // 每一跳的 abort 监听都要留到「读体完成」后再摘，否则慢响应会失去超时保护
  const cleanups = [];

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { res, cleanup } = await once(current, { ...init, method, body });
      if (cleanup) cleanups.push(cleanup);
      const status = res.statusCode || 0;
      const loc = res.headers.location;

      if (status >= 300 && status < 400 && loc) {
        // 先把这次响应丢掉，连接才能回到池子里
        res.resume();
        const next = new URL(loc, current);
        // 与 fetch 一致：301/302 的 POST 降级为 GET，303 一律 GET，307/308 保留方法与正文
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        if (!/^https?:$/.test(next.protocol)) {
          throw new Error(`重定向到不支持的协议：${next.protocol}`);
        }
        current = next.toString();
        continue;
      }

      /*
       * 没有响应体的响应不解压：HEAD、204、304 都可能带 content-encoding 头，
       * 但流里一个字节都没有，照着头去建 Gunzip 会抛「unexpected end of file」，
       * 顺手把这条连接销毁 —— 于是预热等于白做（握好的连接刚回池就被扔掉）。
       */
      const noBody =
        method === 'HEAD' ||
        status === 204 ||
        status === 304 ||
        res.headers['content-length'] === '0';
      const stream = noBody ? res : decompress(res);
      const text = await readBody(stream, res);
      if (init.timing && typeof init.timing === 'object') init.timing.totalMs = Date.now() - t0All;
      return {
        status,
        ok: status >= 200 && status < 300,
        url: current,
        headers: headersToObject(res.headers),
        timing: init.timing || null,
        text: async () => text,
      };
    }

    throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
  } finally {
    for (const fn of cleanups) { try { fn(); } catch { /* noop */ } }
  }
}

/**
 * 预热：提前把 TCP + TLS 握手做掉，让紧随其后的真实请求直接复用连接。
 *
 * 为什么需要它：上面的连接池只对「间隔小于 60 秒」的请求有效，而定时任务的间隔通常是
 * 几小时甚至几天，连接早被回收了。于是每次执行都要重新握手，那 1~2 秒的耗时里绝大部分
 * 花在这上面。在任务到点前几秒先握一次手，等于把这笔开销从「执行耗时」里挪走。
 *
 * 用 OPTIONS 而不是 GET：OPTIONS 只声明能力、不执行业务逻辑，任何接口上都是只读的，
 * 不会像 GET /api/checkin 那样「预热一下就签到两次」。也不带 query，避开签名接口的
 * 时间戳与防重放校验 —— 预热只想要一条连好的连接，不要任何业务语义。
 *
 * 为什么不用 HEAD：Node 对 HEAD 响应不保活连接（实测 HEAD 后 freeSockets 是空的，
 * OPTIONS / GET 才会回池），用它预热等于握手完就把连接扔掉，白付一次 RTT。
 *
 * 失败一律静默：预热只是优化，绝不能影响调度。
 */
function prewarm(urlStr, { timeoutMs = 8000 } = {}) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return Promise.resolve(false);
  }
  if (!/^https?:$/.test(u.protocol)) return Promise.resolve(false);
  const origin = u.origin + u.pathname;

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    // 兜底：绝不让预热挂住调度。超时不只是放弃 Promise，还要真 abort 底层请求 ——
    // 否则遇到不结束的 chunked 响应，socket 会一直占着 maxSockets 的槽位，
    // 而 maybePrewarm 每 10 秒还会再触发一次，慢慢就把连接池占满了。
    const ctrl = new AbortController();
    const guard = setTimeout(() => { ctrl.abort(); finish(false); }, timeoutMs + 500);
    if (guard.unref) guard.unref();

    request(origin, { method: 'OPTIONS', timeoutMs, signal: ctrl.signal }).then(
      () => { clearTimeout(guard); finish(true); },
      () => { clearTimeout(guard); finish(false); }
    );
  });
}

/** 池子状态，给诊断接口用（看复用到底有没有生效） */
function poolStats() {
  const stat = (agent) => {
    const count = (obj) => Object.values(obj || {}).reduce((a, v) => a + (v.length || 0), 0);
    return {
      free: count(agent.freeSockets),
      active: count(agent.sockets),
      pending: count(agent.requests),
    };
  };
  return {
    http: stat(httpAgent),
    https: stat(httpsAgent),
    dns: dnsCache.size,
  };
}

module.exports = { request, prewarm, poolStats, cachedLookup, httpAgent, httpsAgent };
