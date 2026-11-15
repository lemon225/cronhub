/* ============================================================================
 * CronHub Script Functions · CF Pages advanced mode 入口（cloudfn-v1）
 *
 * 部署（与短信中继同款、唯一验证过的组合）：
 *   mkdir pages-adv
 *   cp cloudfn/_worker.js cloudfn/index.html pages-adv/
 *   wrangler 3.28 pages deploy pages-adv --project-name cronhub-scripts
 *
 * 站点接入（server.js 零改动）：
 *   POST {{SCRIPT_BASE}}/v1/proxy
 *   x-script-secret: {{SCRIPT_SECRET}}
 *   请求体见 SPEC.md
 *
 * 边界：不碰 cronhub-sms-relay；不用 eval；不回打 /api/wake；凭据不进响应。
 * 引擎区间 [CLOUD_FN_ENGINE_BEGIN/END] 是纯函数，供 tests/cloudfn.test.cjs 抽取验证。
 * ========================================================================== */

const VER = 'cloudfn-v1';
const DEFAULT_TZ = 480;
const MAX_UPSTREAM_MS = 25000;
const MAX_BODY = 200000;

/* [CLOUD_FN_ENGINE_BEGIN] */
const DEFAULT_TZ_OFFSET = 480;
const MAX_DEPTH = 5;
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** 固定偏移取日历字段：不用 toISOString，也不依赖 Intl 的 ICU 数据。 */
function shiftParts(ts, offsetMin) {
  const t = Number(ts);
  const d = new Date(t + (offsetMin == null ? DEFAULT_TZ_OFFSET : offsetMin) * 60000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
    w: d.getUTCDay(), ts: t,
  };
}

function formatAt(ts, pattern, offsetMin) {
  const p = shiftParts(ts, offsetMin);
  const map = {
    YYYY: String(p.y), MM: pad2(p.mo), DD: pad2(p.d),
    HH: pad2(p.h), mm: pad2(p.mi), ss: pad2(p.s),
    dddd: '星期' + WEEK_CN[p.w], ddd: '周' + WEEK_CN[p.w], d: WEEK_CN[p.w],
    X: String(Math.floor(p.ts / 1000)), x: String(Math.floor(p.ts)),
  };
  return String(pattern == null ? 'YYYY-MM-DD HH:mm:ss' : pattern)
    .replace(/dddd|ddd|YYYY|MM|DD|HH|mm|ss|X|x|d/g, (t) => map[t]);
}

/** 按分隔符切分，引号内的分隔符不当成分隔符。 */
function splitTop(s, sep) {
  const out = [];
  let buf = '', quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === sep) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

function lookupVar(vars, key) {
  if (!vars || key == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
  const hit = Object.keys(vars).find((k) => k.toUpperCase() === String(key).toUpperCase());
  return hit ? vars[hit] : undefined;
}

function parseArgs(s, vars) {
  if (!s || !String(s).trim()) return [];
  return splitTop(String(s), ',').map((raw) => {
    const t = raw.trim();
    if (!t) return '';
    const q = t[0];
    if ((q === "'" || q === '"') && t[t.length - 1] === q && t.length > 1) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t[0] === '@') return lookupVar(vars, t.slice(1));
    if (/^[A-Za-z_]\w*$/.test(t)) {
      const v = lookupVar(vars, t);
      if (v !== undefined) return v;
    }
    return t;
  });
}

/** 内置函数：一律同步、纯函数，签名 (value, args, ctx) => value。 */
const FUNCS = {
  addDays: (v, a) => Number(v) + Number(a[0] || 0) * 86400000,
  addHours: (v, a) => Number(v) + Number(a[0] || 0) * 3600000,
  addMinutes: (v, a) => Number(v) + Number(a[0] || 0) * 60000,
  parseDate: (v) => Date.parse(String(v)),
  format: (v, a, ctx) => formatAt(v, a[0], ctx.offsetMin),
  date: (v, a, ctx) => formatAt(v, 'YYYY-MM-DD', ctx.offsetMin),
  time: (v, a, ctx) => formatAt(v, 'HH:mm:ss', ctx.offsetMin),
  weekday: (v, a, ctx) => '星期' + WEEK_CN[shiftParts(v, ctx.offsetMin).w],
  timestamp: (v) => Math.floor(Number(v) / 1000),
  urlencode: (v) => encodeURIComponent(String(v)),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  trim: (v) => String(v).trim(),
  default: (v, a) => (v == null || v === '' ? String(a[0] == null ? '' : a[0]) : String(v)),
  prefix: (v, a) => String(a[0] == null ? '' : a[0]) + String(v),
  suffix: (v, a) => String(v) + String(a[0] == null ? '' : a[0]),
  json: (v) => JSON.stringify(v),
};

function registerFunc(name, fn) {
  if (!/^[A-Za-z_]\w*$/.test(name) || typeof fn !== 'function') throw new Error('非法函数: ' + name);
  FUNCS[name] = fn;
  return FUNCS;
}

/** 求值一条管道；未定义的变量/函数返回 null，由 render 原样保留占位符。 */
function evalExpr(expr, vars, ctx) {
  const segs = splitTop(String(expr), '|').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const head = segs.shift();
  let value;
  if (head === 'now' || head === 'today') value = ctx.now;
  else if (head === 'tomorrow') value = ctx.now + 86400000;
  else if (head === 'yesterday') value = ctx.now - 86400000;
  else if (head === 'timestamp') value = Math.floor(ctx.now / 1000) * 1000;
  else if (/^-?\d+$/.test(head)) value = Number(head);
  else {
    const v = head[0] === '@' ? lookupVar(vars, head.slice(1)) : lookupVar(vars, head);
    if (v === undefined) return null;
    value = v;
  }
  for (const seg of segs) {
    const m = /^([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/.exec(seg);
    if (!m) return null;
    const fn = FUNCS[m[1]];
    if (!fn) return null;
    const args = m[2] === undefined ? [] : parseArgs(m[2], vars);
    value = fn(value, args, ctx);
  }
  return value == null ? '' : String(value);
}

function render(text, vars, ctx) {
  return String(text == null ? '' : text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, expr) => {
    const v = evalExpr(expr, vars, ctx);
    return v == null ? m : v;
  });
}

/** 先算静态变量，再算 { expr } 派生变量，最后展开静态值里的模板。 */
function resolveVars(raw, ctx) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const vars = {};
  const computed = [];
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && typeof v.expr === 'string') { computed.push([k, v.expr]); continue; }
    vars[k] = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (const [k, expr] of computed) {
    const r = evalExpr(expr, vars, ctx);
    vars[k] = r == null ? '' : String(r);
  }
  let depth = 0, changed = true;
  while (changed && depth < MAX_DEPTH) {
    changed = false; depth += 1;
    for (const k of Object.keys(vars)) {
      if (vars[k].indexOf('{{') < 0) continue;
      const next = render(vars[k], vars, ctx);
      if (next !== vars[k]) { vars[k] = next; changed = true; }
    }
  }
  return vars;
}

const ENGINE = { pad2, shiftParts, formatAt, splitTop, lookupVar, parseArgs, FUNCS,
  registerFunc, evalExpr, render, resolveVars, DEFAULT_TZ_OFFSET, MAX_DEPTH };
/* [CLOUD_FN_ENGINE_END] */

function clampNum(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function fmtOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-cloudfn-ver': VER,
      'cache-control': 'no-store',
    },
  });
}

function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i += 1) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function keyring(env) {
  const many = String(env.SCRIPT_KEYS || '').trim();
  if (many) return many.split(',').map((s) => s.trim()).filter(Boolean);
  const one = String(env.SCRIPT_SECRET || '').trim();
  return one ? [one] : [];
}

function makeCtx(env, payload) {
  const offsetMin = clampNum(env.TZ_OFFSET_MINUTES, DEFAULT_TZ, -720, 840);
  const upMs = clampNum(env.UPSTREAM_TIMEOUT_MS, MAX_UPSTREAM_MS, 1000, 60000);
  const ectx = { now: Date.now(), offsetMin, timezone: 'UTC' + fmtOffset(offsetMin) };
  const vars = resolveVars(payload && payload.vars, ectx);
  const logs = [];
  const input = { ...((payload && payload.template) ? { template: payload.template } : {}),
    ...((payload && payload.input) || {}) };
  const ctx = {
    input,
    vars: (name) => (name === undefined ? { ...vars } : lookupVar(vars, name)),
    render: (text) => render(text, vars, ectx),
    time: {
      now: ectx.now, offsetMin, timezone: ectx.timezone,
      format: (pattern, ts) => formatAt(ts == null ? ectx.now : ts, pattern, offsetMin),
    },
    env: { TZ_OFFSET_MINUTES: String(offsetMin), UPSTREAM_TIMEOUT_MS: String(upMs) },
    log: (...a) => {
      if (logs.length < 30) logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 300));
    },
    ok: (data, summary) => ({ ok: true, data: data == null ? null : data, summary: String(summary || '') }),
    fail: (code, message, data) => ({ ok: false, code: String(code || 'failed'),
      error: String(message || code || 'failed'), data: data == null ? null : data }),
    fetch: (url, init) => fetch(url, { ...init,
      signal: init && init.signal ? init.signal : AbortSignal.timeout(upMs) }),
  };
  return { ctx, logs };
}

/* ---------------------------------------------------------------------------
 * 脚本注册表：新增脚本 = 在下面加一项。契约与示例见 SPEC.md / examples.js。
 * 每项 { describe, async run(ctx) }，run 返回 ctx.ok() 或 ctx.fail()。
 * ------------------------------------------------------------------------- */
const SCRIPTS = {
  'vars-echo': {
    describe: '回显解析后的变量，用于核对日期加工结果（敏感键自动打码）',
    async run(ctx) {
      const all = ctx.vars();
      const safe = {};
      for (const [k, v] of Object.entries(all)) {
        safe[k] = /(SECRET|TOKEN|KEY|PASS|CRED)/i.test(k) ? '••••' + String(v).slice(-4) : v;
      }
      return ctx.ok({ vars: safe, count: Object.keys(safe).length, timezone: ctx.time.timezone },
        Object.keys(safe).length + ' 个变量');
    },
  },

  proxy: {
    describe: '渲染模板后转发到真实上游，返回 status / headers / body',
    async run(ctx) {
      const t = ctx.input.template || ctx.input;
      if (!t || !t.url) return ctx.fail('missing_url', '缺少 template.url');
      const url = ctx.render(String(t.url));
      if (url.indexOf('{{') >= 0) return ctx.fail('unresolved_var', 'URL 仍有未解析占位符: ' + url.slice(0, 200));
      let parsed;
      try { parsed = new URL(url); } catch { return ctx.fail('bad_url', 'URL 不合法'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ctx.fail('bad_scheme', '只允许 http/https');
      const method = String(t.method || 'GET').toUpperCase();
      let headers = {};
      try { headers = JSON.parse(ctx.render(String(t.headers || '{}')) || '{}'); }
      catch { return ctx.fail('bad_headers', 'headers 不是合法 JSON'); }
      const body = t.body == null || t.body === '' ? undefined : ctx.render(String(t.body));
      ctx.log('upstream', method, parsed.host);
      let r, text;
      try {
        r = await ctx.fetch(url, { method, headers, body });
        text = await r.text();
      } catch (e) {
        return ctx.fail('upstream_error', String((e && e.message) || e));
      }
      const data = { status: r.status, ok: r.ok, host: parsed.host, body: text.slice(0, MAX_BODY) };
      if (!r.ok) return ctx.fail('upstream_status', method + ' ' + parsed.host + ' → ' + r.status, data);
      return ctx.ok(data, method + ' ' + parsed.host + ' → ' + r.status);
    },
  },

  'aggregate-json': {
    describe: '串行请求多个上游并把 JSON 合并成一个对象',
    async run(ctx) {
      const calls = Array.isArray(ctx.input.calls) ? ctx.input.calls.slice(0, 5) : [];
      if (!calls.length) return ctx.fail('missing_calls', '缺少 input.calls');
      const merged = {};
      for (const c of calls) {
        const url = ctx.render(String(c.url || ''));
        if (!url || url.indexOf('{{') >= 0) return ctx.fail('bad_call', 'call.url 未解析');
        ctx.log('fetch', new URL(url).host);
        try {
          const r = await ctx.fetch(url, { method: String(c.method || 'GET').toUpperCase() });
          const text = await r.text();
          let v;
          try { v = JSON.parse(text); } catch { v = text.slice(0, MAX_BODY); }
          merged[String(c.name || new URL(url).host)] = { status: r.status, data: v };
        } catch (e) {
          merged[String(c.name || 'unknown')] = { error: String((e && e.message) || e) };
        }
      }
      return ctx.ok(merged, calls.length + ' 个上游');
    },
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__health') {
      return json({ ok: true, ver: VER, timezone: 'UTC' + fmtOffset(clampNum(env.TZ_OFFSET_MINUTES, DEFAULT_TZ, -720, 840)),
        funcs: Object.keys(FUNCS).sort(), scripts: Object.keys(SCRIPTS).sort() });
    }
    const ring = keyring(env);
    if (!ring.length) return json({ ok: false, error: 'secret not configured' }, 503);
    const presented = request.headers.get('x-script-secret') || url.searchParams.get('key') || '';
    if (!ring.some((k) => safeEqual(k, presented))) return json({ ok: false, error: 'forbidden' }, 403);

    const m = /^\/v1\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!m || !SCRIPTS[m[1]]) {
      return json({ ok: false, error: 'unknown script', available: Object.keys(SCRIPTS).sort() }, 404);
    }
    if (request.method !== 'POST' && request.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);

    let payload = {};
    if (request.method === 'POST') {
      try { payload = await request.json(); } catch { return json({ ok: false, error: 'bad json body' }, 400); }
    } else {
      for (const [k, v] of url.searchParams) payload[k] = v;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};

    const t0 = Date.now();
    const made = makeCtx(env, payload);
    try {
      const out = await SCRIPTS[m[1]].run(made.ctx);
      const failed = !out || out.ok === false;
      return json({ script: m[1], ver: VER, ...out, ok: !failed, logs: made.logs,
        durationMs: Date.now() - t0 }, failed ? 500 : 200);
    } catch (e) {
      return json({ ok: false, script: m[1], ver: VER, error: String((e && e.stack) || e).slice(0, 1000),
        logs: made.logs, durationMs: Date.now() - t0 }, 500);
    }
  },
};
