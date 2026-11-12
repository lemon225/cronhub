/**
 * CronHub SMS Relay · Cloudflare Pages（Advanced Mode / 根目录单文件 _worker.js）
 * RELAY_VER = relay-v3 · 2026-11-12
 *
 * 职责：把 CronHub 云端发来的短信请求原样中转到移动网关，并提供双向陪护探针。
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────────
 * 托管 CronHub 的沙箱到 *.workers.dev 被定向阻断、到短信网关直连一律
 * ECONNRESET 25~36ms（按来源 IP/出口拦，换 SNI 无效）；只有 *.pages.dev
 * 从云端可达。于是把中继部署成 Pages，用 Cloudflare 边缘做唯一短信出口。
 *
 * ── 端点（全部要求鉴权）────────────────────────────────────────────
 *   GET /__status   自身版本 / 配置态 / 超时参数 / 端点清单（不含任何密钥）
 *   GET /__probe    只测「CF 边缘 → 上游网关」TLS，不发业务请求
 *   GET /__echo     回显 CF 眼中的调用方（IP / ASN / 组织 / TLS 版本）
 *   GET /__wake     从 CF 边缘打一次 CronHub 唤醒地址（会顺带跑一次调度）
 *   GET /__guard    【双向陪护】并行体检「上游网关 + CronHub 站点」，一次拿两侧结果
 *   其它路径         原样转发给白名单上游
 *
 * v3：转发响应带回 x-relay-upstream-ms（中继→网关真实耗时，便于分段定位）；
 *     /__status 不再回显完整体检 URL（含 sharecode 属凭据），只回 host。
 *
 *   鉴权三选一：X-Relay-Secret / X-Relay-Key 头，或 ?key=（仅浏览器手测用）
 *
 * ── 部署（唯一验证可行的组合，别改）──────────────────────────────────
 *   根目录单文件 _worker.js（advanced mode）+ Wrangler 3.28：
 *     node node_modules/wrangler/bin/wrangler.js pages deploy pages-adv \
 *          --project-name cronhub-sms-relay
 *   functions/ 目录在 API 与 Wrangler 3.114 / 4.158 下全部 uses_functions:false。
 *
 * ── 环境变量（都可选，内置值仅作兜底）─────────────────────────────────
 *   RELAY_KEYS            多调用方密钥，JSON 或 name:key,name2:key2
 *   RELAY_SECRET          单密钥简写（有 RELAY_KEYS 时忽略）
 *   RELAY_EXTRA_HOSTS     追加白名单上游，逗号/分号/空白分隔
 *   WAKE_TOKEN            唤醒令牌；换令牌只改这个变量，不用改代码重新部署
 *   WAKE_BASE             唤醒基址（默认含 sharecode）
 *   WAKE_URL              完整唤醒 URL，设了就覆盖 WAKE_BASE + WAKE_TOKEN
 *   SITE_HEALTH_URL       站点健康检查地址（/__guard 用；只读，不触发调度）
 *   PROBE_TIMEOUT_MS / SITE_TIMEOUT_MS / WAKE_TIMEOUT_MS / FORWARD_TIMEOUT_MS
 *
 * ── 安全边界 ───────────────────────────────────────────────────────
 *   · 上游 host 白名单硬限制，绝不做开放代理
 *   · 转发前剔除全部 x-relay-* 私有头与逐跳头
 *   · 转发前从 query 里删掉 ?key=（v1 的漏洞：浏览器探针密钥会被带到网关）
 *   · 日志只记 method / path / status / 耗时 / 错误类别，绝不记 body、号码、令牌
 *   · /__guard 只打 /api/health，绝不打 /api/wake —— 后者触发调度会形成回环
 */

const RELAY_VER = 'relay-v3';
const DEFAULT_HOST = '5gvas01.cmicmaap.com';

const SITE_HEALTH_INLINE = 'https://cronhub.app.workbuddy.host/api/health?sharecode=ZDRK2MO6CP';
const WAKE_BASE_INLINE = 'https://cronhub.app.workbuddy.host/api/wake?sharecode=ZDRK2MO6CP';
const WAKE_TOKEN_INLINE = 'wk_fb3cef984be24d36115e34f493c41ff7';
const RELAY_KEYS_INLINE = 'cronhub:dcb1470eb88f0656d30ec0ac39082e74';

// 逐跳头 + 中继私有头：转发前必须清干净，否则污染上游 / content-length 不匹配
const PRIVATE_HEADERS = [
  'x-relay-secret', 'x-relay-key', 'x-relay-host',
  'host', 'content-length', 'connection',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
];
// 浏览器手测用的鉴权参数，绝不能出现在转发给上游的 URL 里
const PRIVATE_QUERY = ['key', 'relay_key', 'relay_secret'];

function num(v, dflt, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
}

function timeouts(env) {
  return {
    probe: num(env.PROBE_TIMEOUT_MS, 12000, 1000, 30000),
    site: num(env.SITE_TIMEOUT_MS, 12000, 1000, 30000),
    wake: num(env.WAKE_TIMEOUT_MS, 15000, 1000, 30000),
    forward: num(env.FORWARD_TIMEOUT_MS, 20000, 1000, 60000),
  };
}

/** 常量时间比较，避免按字符短路泄漏密钥 */
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

function keyring(env) {
  const fromEnv = String(env.RELAY_KEYS || '').trim();
  if (fromEnv) return parseKeys(fromEnv);
  if (env.RELAY_SECRET) return [['default', String(env.RELAY_SECRET)]];
  return parseKeys(RELAY_KEYS_INLINE);
}

function allowedHosts(env) {
  const set = new Set([DEFAULT_HOST]);
  String(env.RELAY_EXTRA_HOSTS || '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .forEach((h) => set.add(h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()));
  return set;
}

/** 换令牌只需改 Pages 变量 WAKE_TOKEN，不用重新部署代码 */
function wakeUrl(env) {
  const explicit = String(env.WAKE_URL || '').trim();
  if (explicit) return explicit;
  const token = String(env.WAKE_TOKEN || '').trim() || WAKE_TOKEN_INLINE;
  const base = String(env.WAKE_BASE || '').trim() || WAKE_BASE_INLINE;
  if (!token) return '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}
function siteHealthUrl(env) {
  return String(env.SITE_HEALTH_URL || '').trim() || SITE_HEALTH_INLINE;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-relay-ver': RELAY_VER,
    },
  });
}

/**
 * 所有出站请求的统一入口：真超时取消 + 错误分类。
 * v1 的转发分支完全没有超时，上游半开连接会把 Worker 挂到平台超时。
 * text=true 时把响应体读完再撤定时器（否则 abort 会让 body 流中途断掉）。
 */
async function timedFetch(url, init, ms, { text = false } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = text ? await res.text() : '';
    clearTimeout(timer);
    return { ok: true, status: res.status, ms: Date.now() - t0, body, res };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    const kind = /abort|timeout/i.test(msg) ? 'timeout' : 'network';
    return { ok: false, status: 0, ms: Date.now() - t0, error: msg, kind };
  }
}

/** 只测 TLS 是否建得起来；网关回 401/403 也算通（说明到达了网关） */
async function probeUpstream(origin, host, ms) {
  const r = await timedFetch(origin + '/', { method: 'GET', redirect: 'manual' }, ms);
  return r.ok
    ? { ok: true, host, status: r.status, ms: r.ms }
    : { ok: false, host, status: 0, ms: r.ms, error: r.error, kind: r.kind };
}

/** 站点侧只读体检：解析 /api/health 的 build 与陪护字段，不触发调度 */
async function checkSite(env, ms) {
  const r = await timedFetch(siteHealthUrl(env), { method: 'GET', redirect: 'manual' }, ms, { text: true });
  if (!r.ok) return { ok: false, status: 0, ms: r.ms, error: r.error, kind: r.kind };
  let h = null;
  try { h = JSON.parse(r.body); } catch { /* 非 JSON 也如实返回片段 */ }
  const ok = r.status >= 200 && r.status < 300 && (!h || h.ok !== false);
  return {
    ok,
    status: r.status,
    ms: r.ms,
    build: (h && h.build) || null,
    uptimeSec: (h && h.uptime) || null,
    relay: (h && h.companion && h.companion.relay) || null,
    wake: (h && h.companion && h.companion.wake) || null,
    raw: h ? undefined : String(r.body || '').slice(0, 160),
  };
}

async function wakeSite(env, ms) {
  const wu = wakeUrl(env);
  if (!wu) return { ok: false, status: 0, ms: 0, error: 'WAKE_TOKEN / WAKE_URL 未配置', kind: 'config' };
  const r = await timedFetch(wu, { method: 'GET', redirect: 'manual' }, ms, { text: true });
  let site = null;
  try { site = JSON.parse(r.body); } catch { /* 忽略 */ }
  return {
    ok: r.ok && r.status >= 200 && r.status < 300 && (!site || site.ok !== false),
    status: r.status,
    ms: r.ms,
    wokeAt: (site && site.wokeAt) || null,
    count: (site && site.count) || null,
    ranNow: (site && site.ranNow) || 0,
    body: String(r.body || '').slice(0, 300),
    ...(r.ok ? {} : { error: r.error, kind: r.kind }),
  };
}

function logLine(row) {
  // 只记元数据：绝不记 body / 号码 / 令牌
  console.log(JSON.stringify({ t: Date.now(), ver: RELAY_VER, ...row }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const edge = request.cf?.colo || 'n/a';
    const T = timeouts(env);

    // ---------- 1) 鉴权：多调用方独立密钥 ----------
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

    // ---------- 3) 管理端点 ----------
    if (url.pathname === '/__status') {
      // siteHealth 只回 host：完整 URL 带着 sharecode，属凭据，不进诊断回显
      let healthHost = '';
      try { healthHost = new URL(siteHealthUrl(env)).host; } catch { /* 配置坏了就空着 */ }
      return json({
        ok: true, ver: RELAY_VER, at: new Date().toISOString(), edge, user: userId,
        upstreamHosts: [...allowedHosts(env)],
        defaultHost: DEFAULT_HOST,
        timeouts: T,
        wakeConfigured: !!wakeUrl(env),
        wakeFromEnv: !!(env.WAKE_URL || env.WAKE_TOKEN),
        siteHealthHost: healthHost,
        keys: ring.length,
        endpoints: ['/__status', '/__probe', '/__echo', '/__wake', '/__guard', '<forward>'],
      });
    }

    if (url.pathname === '/__echo') {
      const cf = request.cf || {};
      return json({
        ok: true, ver: RELAY_VER, edge, user: userId,
        callerIp: request.headers.get('cf-connecting-ip') || null,
        asn: cf.asn || null,
        asOrganization: cf.asOrganization || null,
        country: cf.country || null,
        httpProtocol: cf.httpProtocol || null,
        tlsVersion: cf.tlsVersion || null,
        ua: request.headers.get('user-agent') || null,
      });
    }

    if (url.pathname === '/__probe') {
      const up = await probeUpstream(origin, wantHost, T.probe);
      logLine({ kind: 'probe', user: userId, host: wantHost, ok: up.ok, ms: up.ms, edge });
      // v1 兼容：ok 表示 TLS 通不通，status 是网关回的码（403 属正常）
      return json({
        ok: up.ok, status: up.status, upstream: wantHost, edge, user: userId,
        ver: RELAY_VER, ms: up.ms, ...(up.ok ? {} : { error: up.error, errorKind: up.kind }),
      }, up.ok ? 200 : 502);
    }

    if (url.pathname === '/__wake') {
      const site = await wakeSite(env, T.wake);
      logLine({ kind: 'wake', user: userId, ok: site.ok, ms: site.ms, edge });
      // body 字段保留给 v1 调用方；结构化字段给新调用方
      return json({ ok: site.ok, status: site.status, ms: site.ms, body: site.body || '', site, ver: RELAY_VER, edge },
        site.ok ? 200 : 502);
    }

    /*
     * 双向陪护：一次请求同时看「CF → 上游网关」和「CF → CronHub 站点」。
     * 站点侧打的是只读 /api/health，绝不打 /api/wake（后者触发 tick 会回环）。
     * 两侧都通才回 200，任一失败回 502 —— 自检任务直接用 HTTP 状态码判定。
     */
    if (url.pathname === '/__guard') {
      const t0 = Date.now();
      const [up, site] = await Promise.all([
        probeUpstream(origin, wantHost, T.probe),
        checkSite(env, T.site),
      ]);
      const ok = up.ok && site.ok;
      const out = {
        ok, ver: RELAY_VER, edge, user: userId,
        at: new Date().toISOString(), ms: Date.now() - t0,
        upstream: up,
        site,
        hint: ok
          ? '两侧均正常：网站可经中继发短信，中继可回探网站健康'
          : '任一侧异常；看 upstream / site 里的 error 与 errorKind 定位',
      };
      logLine({ kind: 'guard', user: userId, ok, upOk: up.ok, siteOk: site.ok, ms: out.ms, edge });
      return json(out, ok ? 200 : 502);
    }

    // ---------- 4) 纯转发：path / query / method / headers / body 原样 ----------
    const headers = new Headers(request.headers);
    for (const h of PRIVATE_HEADERS) headers.delete(h);

    // v1 漏洞修复：?key= 是给浏览器手测探针用的，不能带到短信网关
    const fwd = new URL(url.toString());
    for (const q of PRIVATE_QUERY) fwd.searchParams.delete(q);

    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    const t0 = Date.now();
    const r = await timedFetch(origin + fwd.pathname + fwd.search, init, T.forward);
    if (!r.ok) {
      logLine({ kind: 'forward', user: userId, host: wantHost, path: fwd.pathname, status: 0,
        ms: r.ms, errorKind: r.kind, edge });
      return json({
        ok: false, error: r.error, errorKind: r.kind, ver: RELAY_VER,
        upstream: wantHost, edge, user: userId, ms: r.ms,
      }, r.kind === 'timeout' ? 504 : 502);
    }

    const out = new Headers(r.res.headers);
    out.set('x-relay-by', encodeURIComponent(userId));
    out.set('x-relay-upstream', wantHost);
    out.set('x-relay-ver', RELAY_VER);
    // 中继 → 网关这段的真实耗时：站点侧据此把「本站到 CF」和「CF 到网关」分开看
    out.set('x-relay-upstream-ms', String(r.ms));
    logLine({ kind: 'forward', user: userId, host: wantHost, path: fwd.pathname,
      status: r.status, ms: r.ms, edge });
    return new Response(r.res.body, {
      status: r.status,
      statusText: r.res.statusText,
      headers: out,
    });
  },
};
