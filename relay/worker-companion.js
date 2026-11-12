/**
 * Cloudflare Worker · sms-relay —— 定时陪护版（COMPANION_VER = companion-v3，2026-11-12）
 *
 * 这个 Worker 与 Pages 中继是**两个不同部署**：
 *   · Pages（cronhub-sms-relay.pages.dev）跑真正的短信业务，CronHub 云端只能连它；
 *   · 本 Worker（sms-relay.*.workers.dev）云端连不上，专职用 Cron Trigger 每 30 分钟
 *     从外部唤醒 CronHub —— 容器睡了以后进程自己叫不醒自己，只有外部请求能拉起。
 * 换句话说：Pages 是「网站 → CF」的业务通道，本 Worker 是「CF → 网站」的陪护通道。
 *
 * v2 改动：唤醒令牌拆成 WAKE_TOKEN 变量（换令牌不用改代码重部署）；
 * scheduled 加真超时、耗时与错误分类日志；可选顺带打一次 Pages /__guard 做双向体检；
 * 转发时剔除 ?key= 私有参数（v1 会把浏览器探针密钥带给上游）。
 * v3 补转发分支的真超时（默认 60s，FORWARD_TIMEOUT_MS 可调）与 504/502 分类 ——
 * v2 的转发完全没超时，上游半开连接会一直挂到平台超时，把 cron 槽占住；
 * 同时回写 x-relay-upstream-ms，站点侧能把「本站→CF」和「CF→网关」分开看。
 *
 * 定位：只做三件事 —— 鉴权、把来源 IP 换成 Cloudflare 边缘、原样转发。
 * 不解析业务内容、不改写任何参数、不记录正文 / 号码 / 令牌。
 * 多个调用方共用同一个 Worker，各自带自己的内容和参数（Authorization、
 * Content-Type、baseKey、channel、query、body 等），Worker 一律透传。
 *
 * ===== 密钥（本版内置，粘贴部署即可用）=====
 *   RELAY_KEYS_INLINE   每用户一把，格式 name:key，逗号分隔，可单独吊销
 *   若以后在 Settings → Variables and Secrets 里配了 RELAY_KEYS / RELAY_SECRET，
 *   则环境变量优先，内置的自动失效 —— 两条路都能走，互不冲突。
 *
 * ===== 调用方请求头 =====
 *   X-Relay-Secret  必填：本用户的密钥
 *   X-Relay-Host    可选：上游主机名，必须命中白名单；不填走默认 5gvas01
 *   其余 headers / path / query / body 原样透传
 *
 * ===== 自带探针 =====
 *   GET /__probe            + 头 X-Relay-Secret: 密钥
 *   GET /__probe?key=密钥    （浏览器地址栏直接敲，免配请求头）
 *   不发任何业务请求，只测 Cloudflare 边缘能否与网关建立 TLS。
 */

const COMPANION_VER = 'companion-v3';
const DEFAULT_HOST = '5gvas01.cmicmaap.com';

// CronHub 外部唤醒地址：Cron Triggers 每 30 分钟打一次，唤醒容器并当场跑一次调度。
// 换成「基址 + 独立令牌」：线上重置令牌后只需改 Worker 变量 WAKE_TOKEN，不必重新部署脚本。
const WAKE_BASE_INLINE = 'https://cronhub.app.workbuddy.host/api/wake?sharecode=ZDRK2MO6CP';
const WAKE_TOKEN_INLINE = 'wk_fb3cef984be24d36115e34f493c41ff7';
function wakeUrl(env) {
  const explicit = String((env && env.WAKE_URL) || '').trim();
  if (explicit) return explicit;
  const token = String((env && env.WAKE_TOKEN) || '').trim() || WAKE_TOKEN_INLINE;
  const base = String((env && env.WAKE_BASE) || '').trim() || WAKE_BASE_INLINE;
  return token ? base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '';
}

// 可选：唤醒后顺带对 Pages 中继做一次双向体检（不配就只唤醒，行为与 v1 一致）
function guardUrl(env) { return String((env && env.GUARD_URL) || '').trim(); }

/** 真超时取消 + 错误分类；v1 的 scheduled 完全没有超时，上游挂起会拖满整个 cron 槽 */
async function timedFetch(url, init, ms) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    clearTimeout(timer);
    return { ok: true, status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    return { ok: false, status: 0, ms: Date.now() - t0, error: msg,
      kind: /abort|timeout/i.test(msg) ? 'timeout' : 'network' };
  }
}

/** 转发超时：默认 60s，可用环境变量 FORWARD_TIMEOUT_MS 覆盖（5s~100s） */
function forwardTimeoutMs(env) {
  const n = Number(env && env.FORWARD_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return 60000;
  return Math.min(100000, Math.max(5000, n));
}

/**
 * 转发专用：只要响应头回来就撤定时器，正文流原样交给调用方。
 * 这里必须设上限 —— v2 的转发分支完全没超时，上游半开连接会把这次调用
 * 一直挂到平台超时，期间 cron 槽被占住，后面的唤醒全部排队。
 */
async function forwardWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: true, res };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    return { ok: false, error: msg, kind: /abort|timeout/i.test(msg) ? 'timeout' : 'network' };
  }
}

// 内置密钥表：name:key, name2:key2 …… 撤销某用户就删掉对应那一段
const RELAY_KEYS_INLINE = 'cronhub:dcb1470eb88f0656d30ec0ac39082e74';

// 中继私有头 + 逐跳头：转发前清掉，避免污染上游 / 长度不匹配
const PRIVATE_HEADERS = [
  'x-relay-secret', 'x-relay-key', 'x-relay-host',
  'host', 'content-length', 'connection',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
];

/** 常量时间比较，避免按字符逐个短路泄漏密钥 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 密钥串 → [[userId, key], ...]，支持 JSON 与 name:key 简写 */
function parseKeys(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.entries(obj)
        .map(([id, k]) => [String(id), String(k)])
        .filter(([, k]) => k);
    }
  } catch { /* 不是 JSON，按简写格式处理 */ }
  return s
    .split(/[,;\n]/)
    .map((p) => p.split(':'))
    .filter((p) => p.length >= 2)
    .map(([id, ...rest]) => [id.trim(), rest.join(':').trim()])
    .filter(([id, k]) => id && k);
}

/** 环境变量优先，没配则用内置密钥 */
function keyring(env) {
  const fromEnv = String(env.RELAY_KEYS || '').trim();
  if (fromEnv) return parseKeys(fromEnv);
  if (env.RELAY_SECRET) return [['default', String(env.RELAY_SECRET)]];
  return parseKeys(RELAY_KEYS_INLINE);
}

/** 上游白名单：硬限制，绝不开放任意目标（否则就是开放代理） */
function allowedHosts(env) {
  const set = new Set([DEFAULT_HOST]);
  String(env.RELAY_EXTRA_HOSTS || '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .forEach((h) => set.add(h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()));
  return set;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const edge = request.cf?.colo || 'n/a';

    // ---------- 1) 鉴权：多用户独立密钥 ----------
    const presented =
      request.headers.get('x-relay-secret') ||
      request.headers.get('x-relay-key') ||
      url.searchParams.get('key') ||
      '';
    const ring = keyring(env);
    if (!ring.length) return json({ ok: false, error: 'relay keys not configured' }, 503);
    const hit = presented ? ring.find(([, k]) => safeEqual(k, presented)) : null;
    if (!hit) return new Response('forbidden', { status: 403 });
    const userId = hit[0];

    // ---------- 2) 上游白名单 ----------
    const wantHost = String(request.headers.get('x-relay-host') || DEFAULT_HOST)
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (!allowedHosts(env).has(wantHost)) {
      return json({ ok: false, error: 'upstream not allowed', host: wantHost }, 403);
    }
    const origin = 'https://' + wantHost;

    // 出口身份回显：让调用方看到 Cloudflare 眼中的自己（IP / ASN / 组织）。
    // 只读元数据，不记录、不转发任何业务内容；同时验证「调用方 → workers.dev」这一段。
    if (url.pathname === '/__echo') {
      const cf = request.cf || {};
      return json({
        ok: true, edge, user: userId,
        callerIp: request.headers.get('cf-connecting-ip') || null,
        asn: cf.asn || null,
        asOrganization: cf.asOrganization || null,
        country: cf.country || null,
        httpProtocol: cf.httpProtocol || null,
        tlsVersion: cf.tlsVersion || null,
        ua: request.headers.get('user-agent') || null,
      });
    }

    // ---------- 3) 探针：只测 TLS，不发业务请求 ----------
    if (url.pathname === '/__probe') {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(origin + '/', {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        return json({
          ok: true, status: r.status, upstream: wantHost,
          edge, user: userId, ms: Date.now() - t0,
        });
      } catch (e) {
        clearTimeout(timer);
        return json({
          ok: false, error: String(e?.message || e), upstream: wantHost,
          edge, user: userId, ms: Date.now() - t0,
        }, 502);
      }
    }

    // 手动保活探针：立刻从 CF 边缘打一次 CronHub 唤醒地址（不用等 30 分钟）
    if (url.pathname === '/__wake') {
      const t0 = Date.now();
      const wu = wakeUrl(env);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(wu, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
        clearTimeout(timer);
        const txt = await r.text();
        return json({ ok: r.ok, status: r.status, ms: Date.now() - t0, body: txt.slice(0, 300), edge });
      } catch (e) {
        clearTimeout(timer);
        return json({ ok: false, error: String(e?.message || e), ms: Date.now() - t0, edge }, 502);
      }
    }

    // ---------- 4) 纯转发：path / query / method / headers / body 原样 ----------
    const headers = new Headers(request.headers);
    for (const h of PRIVATE_HEADERS) headers.delete(h);
    // 删掉 content-length，让运行时按 body 重新计算

    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    // ?key= 是浏览器手测探针用的鉴权参数，绝不能透传给上游网关
    const fwd = new URL(url.toString());
    for (const q of ['key', 'relay_key', 'relay_secret']) fwd.searchParams.delete(q);

    const t0 = Date.now();
    const r = await forwardWithTimeout(origin + fwd.pathname + fwd.search, init, forwardTimeoutMs(env));
    if (!r.ok) {
      console.log(JSON.stringify({ t: Date.now(), user: userId, host: wantHost, path: url.pathname,
        status: 0, ms: Date.now() - t0, errorKind: r.kind }));
      return json({
        ok: false, error: r.error, errorKind: r.kind,
        upstream: wantHost, edge, user: userId, ms: Date.now() - t0,
      }, r.kind === 'timeout' ? 504 : 502);
    }
    const resp = r.res;
    const out = new Headers(resp.headers);
    out.set('x-relay-by', encodeURIComponent(userId)); // 排障：哪个调用方
    out.set('x-relay-upstream', wantHost);
    // 中继 → 上游这段的真实耗时：站点侧能据此把「慢在握手还是慢在网关」分开
    out.set('x-relay-upstream-ms', String(Date.now() - t0));
    // 只记元数据，绝不记 body / 号码 / 令牌
    console.log(JSON.stringify({
      t: Date.now(), user: userId, host: wantHost,
      path: url.pathname, status: resp.status, ms: Date.now() - t0,
    }));
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: out,
    });
  },

  /*
   * Cron Triggers：每 30 分钟陪护一次 CronHub。
   * ① 唤醒（/api/wake 会当场跑一次 tick）—— 容器空闲被回收后只有外部请求能拉起；
   * ② 若配了 GUARD_URL + RELAY_SECRET，再打一次 Pages 的 /__guard 做双向体检。
   * 两步各自超时、各自记耗时与错误类别，任何一步失败都不会拖住另一步。
   */
  async scheduled(controller, env) {
    const log = (row) => console.log(JSON.stringify({ t: Date.now(), ver: COMPANION_VER, ...row }));
    const wu = wakeUrl(env);
    if (!wu) { log({ kind: 'cron-wake', ok: false, error: 'WAKE_TOKEN / WAKE_URL 未配置', errorKind: 'config' }); }
    else {
      const r = await timedFetch(wu, { method: 'GET', redirect: 'manual' }, 15000);
      let site = null;
      try { site = JSON.parse(r.body); } catch { /* 忽略 */ }
      log({ kind: 'cron-wake', ok: r.ok && r.status >= 200 && r.status < 300 && (!site || site.ok !== false),
        status: r.status, ms: r.ms,
        count: (site && site.count) || null, ranNow: (site && site.ranNow) || 0,
        ...(r.ok ? {} : { error: r.error, errorKind: r.kind }) });
    }

    const gu = guardUrl(env);
    if (!gu) return;
    const secret = String((env && (env.RELAY_SECRET || env.GUARD_SECRET)) || '').trim();
    const g = await timedFetch(gu, {
      method: 'GET', redirect: 'manual',
      headers: secret ? { 'x-relay-secret': secret } : {},
    }, 20000);
    let parsed = null;
    try { parsed = JSON.parse(g.body); } catch { /* 忽略 */ }
    log({ kind: 'cron-guard', ok: g.ok && !!parsed && parsed.ok !== false,
      status: g.status, ms: g.ms,
      upstreamOk: parsed && parsed.upstream && parsed.upstream.ok,
      siteOk: parsed && parsed.site && parsed.site.ok,
      build: parsed && parsed.site && parsed.site.build,
      ...(g.ok ? {} : { error: g.error, errorKind: g.kind }) });
  },
};
