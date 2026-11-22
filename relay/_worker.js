/**
 * CronHub SMS Relay · Cloudflare Pages（Advanced Mode / 根目录单文件 _worker.js）
 * RELAY_VER = relay-v5 · 2026-11-15
 *
 * v5（批次 B 收口）：
 *   · 所有拒绝响应（403 / 503 / 405）改成带 x-relay-ver 的 JSON —— 以前 403 是裸文本，
 *     线上排障第一句「版本对不对」没法问。响应体仍不含任何密钥。
 *   · /__wake 加 30 秒节流：这个端点有副作用（会触发站点调度），pages.dev 域名公开可扫，
 *     不加节流等于给陌生人一个免费的重启按钮。?force=1 可绕过（仍需密钥）。
 *   · /__status 增 keysSource / debt：把「密钥还内联在源码里」这条安全债变成可查询状态，
 *     而不是只写在文档里等人想起来。
 *   · 转发响应增 x-relay-ttfb-ms（= 等到响应头的耗时），3xx 增 x-relay-redirect。
 *     注意 FORWARD_TIMEOUT_MS 覆盖的是「等到响应头」，正文流由平台超时兜底。
 *
 * v4（批次 A 止血）：
 *   · /__guard 的 ok 判据只看上游腿 —— 短信发不发得出去由「CF → 网关」决定；
 *     站点腿（CF → 国内实例）常因冷启动越过 12s，拿它一起判失败会把「短信明明能发」
 *     误报成中继异常，进而推假警报。站点腿降级为参考项，单独回 siteOk。
 *   · SITE_TIMEOUT_MS 默认 12s → 20s，减少冷启动误判（仍不影响通道健康判定）。
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

const RELAY_VER = 'relay-v5';
const DEFAULT_HOST = '5gvas01.cmicmaap.com';

/*
 * /__wake 节流：只在同一个 isolate 内有效（换 isolate 就清零）。
 * 它挡不住有决心的攻击者，但足以让「随手扫到的 URL 被反复点」不再变成
 * 每分钟一次的站点唤醒 —— 这正是它存在的理由，不要理解成鉴权。
 */
const WAKE_MIN_INTERVAL_MS = 30000;
let wakeLastAt = 0;
let wakeLastResult = null;

/*
 * 内联兜底一律留空：真实值属于部署环境，不进代码库。
 * 部署前在 Pages 项目里配好这几个变量（缺任一即为「未配置」，不静默降级）：
 *   RELAY_KEYS       每用户一把，name:key 逗号分隔
 *   WAKE_TOKEN       唤醒令牌
 *   WAKE_BASE        唤醒基址（自带 sharecode）
 *   SITE_HEALTH_URL  站点健康地址（自带 sharecode）
 * 留空后 keysSource() 会返回 'none'，鉴权直接 503，不会出现「空密钥也放行」。
 */
const SITE_HEALTH_INLINE = '';
const WAKE_BASE_INLINE = '';
const WAKE_TOKEN_INLINE = '';
const RELAY_KEYS_INLINE = '';

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
    site: num(env.SITE_TIMEOUT_MS, 20000, 1000, 30000),
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

/** 密钥是从变量来的还是源码来的 —— 决定「轮换要不要重新部署」 */
function keysSource(env) {
  if (String(env.RELAY_KEYS || '').trim()) return 'env:RELAY_KEYS';
  if (env.RELAY_SECRET) return 'env:RELAY_SECRET';
  // 源码里的兜底已经清空：没配变量就是「没配」，不能假装还有内联密钥
  return RELAY_KEYS_INLINE ? 'inline' : 'none';
}

/**
 * 配置缺项清单：把「凭据还没配进环境变量」做成可查询字段。
 * 只回类别，不回值 —— /__status 是诊断端点，不是密钥出口。
 */
function securityDebt(env) {
  const debt = [];
  const src = keysSource(env);
  if (src === 'inline') debt.push('relay-key-inline');
  if (src === 'none') debt.push('relay-key-missing');
  if (!String(env.WAKE_URL || '').trim() && !String(env.WAKE_TOKEN || '').trim()) debt.push('wake-token-missing');
  if (!String(env.SITE_HEALTH_URL || '').trim()) debt.push('site-health-missing');
  return debt;
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
    if (!ring.length) return json({ ok: false, error: 'relay keys not configured', ver: RELAY_VER }, 503);
    const hit = presented ? ring.find(([, k]) => safeEqual(k, presented)) : null;
    // 拒绝也要带版本：线上第一步永远是「先确认跑的是哪一版」
    if (!hit) return json({ ok: false, error: 'forbidden', ver: RELAY_VER }, 403);
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
        wakeThrottleSec: WAKE_MIN_INTERVAL_MS / 1000,
        siteHealthHost: healthHost,
        keys: ring.length,
        keysSource: keysSource(env),
        debt: securityDebt(env),
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
      /*
       * 有副作用的端点必须限速：它会让站点当场跑一次调度。
       * 节流窗口内直接回上次结果，调用方仍拿到可用信息（不会误判成故障）。
       */
      const force = url.searchParams.get('force') === '1';
      const now = Date.now();
      if (!force && wakeLastAt && now - wakeLastAt < WAKE_MIN_INTERVAL_MS) {
        const waitMs = WAKE_MIN_INTERVAL_MS - (now - wakeLastAt);
        logLine({ kind: 'wake', user: userId, ok: true, throttled: true, waitMs, edge });
        return json({
          ok: true, throttled: true, waitMs, last: wakeLastResult,
          ver: RELAY_VER, edge, hint: '30 秒内已唤醒过；确需立刻再跑一次用 ?force=1',
        });
      }
      wakeLastAt = now;
      const site = await wakeSite(env, T.wake);
      wakeLastResult = {
        at: new Date(now).toISOString(), ok: site.ok, status: site.status,
        ms: site.ms, ranNow: site.ranNow, count: site.count, wokeAt: site.wokeAt,
      };
      logLine({ kind: 'wake', user: userId, ok: site.ok, ms: site.ms, edge });
      // body 字段保留给 v1 调用方；结构化字段给新调用方
      return json({ ok: site.ok, status: site.status, ms: site.ms, body: site.body || '', site, ver: RELAY_VER, edge },
        site.ok ? 200 : 502);
    }

    /*
     * 双向陪护：一次请求同时看「CF → 上游网关」和「CF → CronHub 站点」。
     * 站点侧打的是只读 /api/health，绝不打 /api/wake（后者触发 tick 会回环）。
     *
     * v4：通道健康只看上游腿。站点腿是「回探能力」，CF 边缘到国内实例常因冷启动
     * 越过 SITE_TIMEOUT，把它算进 ok 会把「短信能发」误报成中继故障（假警报）。
     * 因此 ok / HTTP 码只由 upstream 决定，siteOk 单列，调用方自行当参考。
     */
    if (url.pathname === '/__guard') {
      const t0 = Date.now();
      const [up, site] = await Promise.all([
        probeUpstream(origin, wantHost, T.probe),
        checkSite(env, T.site),
      ]);
      const channelOk = !!up.ok;
      const siteOk = !!site.ok;
      const out = {
        ok: channelOk, channelOk, siteOk, ver: RELAY_VER, edge, user: userId,
        at: new Date().toISOString(), ms: Date.now() - t0,
        upstream: up,
        site,
        verdict: channelOk ? (siteOk ? 'ok' : 'channel-ok-site-slow') : 'upstream-down',
        hint: channelOk
          ? (siteOk
            ? '两侧均正常：网站可经中继发短信，中继可回探网站健康'
            : '短信通道正常（上游通）；站点回探偏慢，仅作参考，不影响通道健康')
          : '上游网关不通：短信发不出去，看 upstream.error / errorKind',
      };
      logLine({ kind: 'guard', user: userId, ok: channelOk, upOk: up.ok, siteOk, ms: out.ms, edge });
      return json(out, channelOk ? 200 : 502);
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
    // 同上，但语义说清楚：这是「等到响应头」的耗时。FORWARD_TIMEOUT_MS 也只看这一段，
    // 正文流由平台超时兜底 —— 避免有人拿它当「整段传输耗时」用。
    out.set('x-relay-ttfb-ms', String(r.ms));
    // 上游回了跳转就明说：调用方（send.cjs）那边 3xx 一律判失败，不再当成功
    if (r.status >= 300 && r.status < 400) out.set('x-relay-redirect', '1');
    logLine({ kind: 'forward', user: userId, host: wantHost, path: fwd.pathname,
      status: r.status, ms: r.ms, edge });
    return new Response(r.res.body, {
      status: r.status,
      statusText: r.res.statusText,
      headers: out,
    });
  },
};
