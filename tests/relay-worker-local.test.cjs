/*
 * 中继本地回归：直接加载 relay/_worker.js，模拟 Cloudflare 边缘，不起真实服务。
 *
 * 为什么直接加载源码：以前这套验证脚本是 D:\Temp 下的快照（_worker.mjs 副本），
 * 源码一改脚本就过时，等于拿旧地图验收新地形。现在用 data: URL 动态 import
 * 当前源码，改完立刻能验；也不需要把 .js 改名成 .mjs。
 *
 * 覆盖的是**判据**，不是实现细节：
 *   鉴权 → 白名单 → 私有头/私有参数剥离 → 转发透传 → 超时与错误类别 → /__guard 只看上游腿
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'relay', '_worker.js');
const KEY = 'testkey-0123456789abcdef';
const RELAY = 'https://relay.test';

const ENV = {
  RELAY_KEYS: 'tester:' + KEY,
  SITE_HEALTH_URL: 'https://site.test/api/health?sharecode=zzz',
  WAKE_URL: 'https://site.test/api/wake?sharecode=zzz',
  SITE_TIMEOUT_MS: '1000',
  FORWARD_TIMEOUT_MS: '1000',
};

let PASS = 0;
let FAIL = 0;
const out = (s) => process.stdout.write(s + '\n');
function ok(name, cond, extra) {
  if (cond) { PASS++; out('PASS | ' + name); }
  else { FAIL++; out('FAIL | ' + name + (extra ? ' | ' + extra : '')); }
}

/* 中继的 logLine 会往 stdout 打 JSON，收起来既避免刷屏，也便于断言「日志里没有敏感内容」 */
const logBuf = [];
console.log = (line) => { logBuf.push(String(line)); };

/* ---------- 模拟 CF 边缘：接管全局 fetch ---------- */
let mode = 'ok';
const seen = [];

function hang(init) {
  return new Promise((_, rej) => {
    const sig = init && init.signal;
    if (!sig) return; // 没有 signal 就永远挂着，测试会超时失败，正好暴露问题
    sig.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      rej(e);
    });
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const hdrs = {};
  new Headers(init.headers || {}).forEach((v, k) => { hdrs[k] = v; });
  let body = '';
  if (init.body) body = await new Response(init.body).text();
  seen.push({ url, method: init.method || 'GET', headers: hdrs, body });

  const isSite = url.startsWith('https://site.test');
  if (isSite && mode === 'site-hang') return hang(init);

  if (!isSite) {
    if (mode === 'up-fail') {
      const e = new Error('read ECONNRESET');
      e.code = 'ECONNRESET';
      throw e;
    }
    if (mode === 'fwd-hang') return hang(init);
    if (mode === 'up-redirect') {
      return new Response('', { status: 302, headers: { location: 'https://5gvas01.cmicmaap.com/new-entry' } });
    }
    // 网关对裸探针的正常响应就是 403
    return new Response('{"code":403,"msg":"no auth"}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: true, build: 'audit-batch-21', uptime: 123,
    companion: { relay: { ok: true }, wake: { count: 7 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

function req(p, opts = {}) {
  return new Request(RELAY + p, opts);
}
function authed(p, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set('x-relay-secret', KEY);
  return req(p, { ...opts, headers });
}

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const worker = mod.default;
  const call = (r, env = ENV) => worker.fetch(r, env);

  /* ---------- 1) 鉴权 ---------- */
  {
    const r = await call(req('/__status'));
    const j = await r.json();
    // v5：拒绝响应也带版本与 JSON —— 线上第一步永远是「先确认跑的是哪一版」
    ok('无密钥 → 403 且带 ver（v5 起是 JSON，不再裸文本）',
      r.status === 403 && j.ok === false && j.error === 'forbidden' && j.ver === 'relay-v5',
      'status=' + r.status + ' body=' + JSON.stringify(j).slice(0, 80));
  }
  {
    const r = await call(req('/__status?key=wrong'));
    ok('错误密钥 → 403', r.status === 403);
  }
  {
    const r = await call(req('/__status?key=' + KEY));
    const j = await r.json();
    ok('query 密钥可用（浏览器手测路径）', r.status === 200 && j.ver === 'relay-v5');
  }
  {
    const r = await call(authed('/__status'));
    const j = await r.json();
    ok('header 密钥可用', r.status === 200 && j.user === 'tester');
    const raw = JSON.stringify(j);
    ok('/__status 不回显密钥', !raw.includes(KEY));
    ok('/__status 不回显 sharecode', !raw.includes('sharecode'));
  }
  {
    const r = await call(req('/__status'), {});
    /*
     * 源码里的密钥已清空（公开仓库不带凭据），所以 env 为空时走的是「未配置」分支：
     * 回 503 而不是 403 —— 这是有意的失败关闭，宁可全拒也不静默放行。
     * 部署时必须配 RELAY_KEYS，缺了会被 /__status 的 debt 列出来。
     */
    ok('env 未配置 → 503 失败关闭（不再有内联兜底）', r.status === 503,
      'status=' + r.status);
  }

  /* ---------- 2) 上游白名单 ---------- */
  {
    const r = await call(authed('/__status', { headers: { 'x-relay-host': 'evil.example.com' } }));
    const j = await r.json();
    ok('白名单外主机 → 403', r.status === 403 && j.error === 'upstream not allowed');
  }
  {
    const r = await call(authed('/__status', { headers: { 'x-relay-host': 'https://5gvas01.cmicmaap.com/sms' } }));
    ok('白名单内主机（带 scheme/路径也能归一）→ 200', r.status === 200);
  }

  /* ---------- 3) 探针 ---------- */
  {
    mode = 'ok';
    const r = await call(authed('/__probe'));
    const j = await r.json();
    ok('/__probe 上游 403 视为连通（ok:true / HTTP 200）',
      r.status === 200 && j.ok === true && j.status === 403);
  }
  {
    mode = 'up-fail';
    const r = await call(authed('/__probe'));
    const j = await r.json();
    ok('/__probe 上游断连 → 502 且带 errorKind',
      r.status === 502 && j.ok === false && !!j.errorKind, JSON.stringify(j).slice(0, 120));
  }

  /* ---------- 4) 陪护判据：只看上游腿 ---------- */
  {
    mode = 'ok';
    const r = await call(authed('/__guard'));
    const j = await r.json();
    ok('/__guard 两侧通 → ok / verdict=ok / HTTP 200',
      r.status === 200 && j.ok === true && j.verdict === 'ok' && j.siteOk === true);
  }
  {
    mode = 'site-hang';
    const r = await call(authed('/__guard'));
    const j = await r.json();
    ok('站点腿超时但上游通 → 仍 ok:true / HTTP 200（v4 核心修复）',
      r.status === 200 && j.ok === true && j.channelOk === true && j.siteOk === false,
      'status=' + r.status + ' verdict=' + j.verdict);
    ok('站点腿超时 → verdict=channel-ok-site-slow',
      j.verdict === 'channel-ok-site-slow', String(j.verdict));
  }
  {
    mode = 'up-fail';
    const r = await call(authed('/__guard'));
    const j = await r.json();
    ok('上游断连 → ok:false / HTTP 502 / verdict=upstream-down',
      r.status === 502 && j.ok === false && j.verdict === 'upstream-down');
  }

  /* ---------- 5) 转发：原样透传 + 私有信息剥离 ---------- */
  {
    mode = 'ok';
    seen.length = 0;
    const r = await call(authed('/gtw-ai/api/sms/send?foo=1&key=' + KEY + '&relay_secret=x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-relay-host': '5gvas01.cmicmaap.com' },
      body: 'phone=13800138000&text=hi',
    }));
    const up = seen.find((s) => s.url.includes('5gvas01'));
    ok('转发命中上游且状态码透传', !!up && r.status === 403);
    ok('path 原样保留', !!up && up.url.startsWith('https://5gvas01.cmicmaap.com/gtw-ai/api/sms/send'));
    ok('业务 query 保留（foo=1）', !!up && up.url.includes('foo=1'));
    ok('私有 query 剥离（key / relay_secret 不带给网关）',
      !!up && !up.url.includes('key=') && !up.url.includes('relay_secret'));
    ok('method 与 body 透传', !!up && up.method === 'POST' && up.body === 'phone=13800138000&text=hi');
    ok('私有头剥离（x-relay-secret 不出网）',
      !!up && !up.headers['x-relay-secret'] && !up.headers['x-relay-host']);
    ok('content-type 保留', !!up && up.headers['content-type'] === 'application/x-www-form-urlencoded');
    ok('响应带版本与分段耗时头',
      r.headers.get('x-relay-ver') === 'relay-v5' &&
      r.headers.get('x-relay-upstream-ms') !== null &&
      r.headers.get('x-relay-by') === 'tester');
  }
  {
    mode = 'fwd-hang';
    const r = await call(authed('/gtw-ai/api/sms/send', { method: 'POST', body: 'x=1' }));
    const j = await r.json();
    ok('转发超时 → 504 且标 timeout',
      r.status === 504 && j.errorKind === 'timeout', 'status=' + r.status + ' kind=' + j.errorKind);
  }
  {
    mode = 'up-fail';
    const r = await call(authed('/gtw-ai/api/sms/send', { method: 'POST', body: 'x=1' }));
    const j = await r.json();
    ok('转发网络错 → 502（不是 504）', r.status === 502 && j.ok === false);
  }

  /* ---------- 6) 日志不落敏感内容 ---------- */
  {
    logBuf.length = 0;
    mode = 'ok';
    await call(authed('/gtw-ai/api/sms/send', { method: 'POST', body: 'phone=13800138000' }));
    const joined = logBuf.join('\n');
    ok('日志只记元数据：不含号码 / 密钥', !joined.includes('13800138000') && !joined.includes(KEY),
      joined.slice(0, 160));
    ok('日志含 kind 与耗时', /"kind":"forward"/.test(joined) && /"ms":/.test(joined));
  }

  /* ---------- 7) v5：安全债可视化 / 唤醒节流 / 跳转标记 ---------- */
  {
    const r = await call(authed('/__status'));
    const j = await r.json();
    ok('/__status 标明密钥来源（env 优先）', j.keysSource === 'env:RELAY_KEYS', String(j.keysSource));
    ok('变量齐备时 debt 为空', Array.isArray(j.debt) && j.debt.length === 0, JSON.stringify(j.debt));
  }
  {
    // 只配密钥、不配唤醒与健康地址 → 两条配置缺项应该自报
    const r = await call(authed('/__status'), { RELAY_KEYS: 'tester:' + KEY });
    const j = await r.json();
    ok('缺变量时 debt 自报缺项（不会静默）',
      j.debt.includes('wake-token-missing') && j.debt.includes('site-health-missing'),
      JSON.stringify(j.debt));
    ok('debt 只报类别、不含凭据值',
      !JSON.stringify(j.debt).includes('wk_') && !JSON.stringify(j.debt).includes('sharecode='));
  }
  {
    mode = 'ok';
    const r1 = await call(authed('/__wake'));
    const j1 = await r1.json();
    ok('/__wake 首次正常执行', r1.status === 200 && j1.ok === true && !j1.throttled);
    const r2 = await call(authed('/__wake'));
    const j2 = await r2.json();
    ok('/__wake 30 秒内再次调用 → 节流且回上次结果',
      r2.status === 200 && j2.throttled === true && !!j2.last && j2.last.ok === true,
      JSON.stringify(j2).slice(0, 120));
    const r3 = await call(authed('/__wake?force=1'));
    const j3 = await r3.json();
    ok('/__wake?force=1 可绕过节流', r3.status === 200 && !j3.throttled);
  }
  {
    mode = 'up-redirect';
    const r = await call(authed('/gtw-ai/api/sms/send', { method: 'POST', body: 'x=1' }));
    ok('上游 3xx → 原样透传 + 标 x-relay-redirect',
      r.status === 302 && r.headers.get('x-relay-redirect') === '1',
      'status=' + r.status + ' hdr=' + r.headers.get('x-relay-redirect'));
    ok('3xx 也带 ttfb 头', r.headers.get('x-relay-ttfb-ms') !== null);
  }

  out('\n────────────────────────────────');
  if (FAIL) {
    out('失败 ' + FAIL + ' 项 / 通过 ' + PASS + ' 项');
    process.exit(1);
  }
  out('全部通过：' + PASS + ' 项（中继源码直载）');
})().catch((e) => {
  console.error('用例崩溃：', e && e.stack || e);
  process.exit(1);
});
