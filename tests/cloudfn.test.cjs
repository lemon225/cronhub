/*
 * 脚本云函数回归：引擎纯函数 + 整个 Worker（data: URL 动态 import，零依赖、不联网）。
 * 同时守住「站点零改动」判据：server.js 的 applyEnvVars 正则只认 {{纯单词}}。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfn/_worker.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

const begin = SRC.indexOf('/* [CLOUD_FN_ENGINE_BEGIN] */');
const end = SRC.indexOf('/* [CLOUD_FN_ENGINE_END] */');
if (begin < 0 || end < 0) {
  console.error('找不到引擎区间标记');
  process.exit(1);
}
const E = new Function(SRC.slice(begin, end) + '\nreturn ENGINE;')();

function ctxAt(now, offsetMin) {
  return { now, offsetMin: offsetMin == null ? 480 : offsetMin };
}

(async () => {
  console.log('\n[1] 时区和日期加工（用户核心诉求：今天算明天 + 调整格式）');
  const u = Date.UTC(2026, 10, 15, 0, 0, 0);
  ok('UTC 20:00 → 北京次日 08:00:00', E.formatAt(u, 'YYYY-MM-DD HH:mm:ss', 480) === '2026-11-15 08:00:00',
    E.formatAt(u, 'YYYY-MM-DD HH:mm:ss', 480));
  ok('不用 toISOString：UTC 日期与北京时间不同日', E.formatAt(u, 'YYYY-MM-DD', 0) === '2026-11-15'
    && E.formatAt(Date.UTC(2026, 10, 14, 18, 0, 0), 'YYYY-MM-DD', 480) === '2026-11-15');
  const crossMonth = Date.UTC(2026, 10, 30, 18, 0, 0);
  ok('跨月：tomorrow → 2026-12-02', E.render('{{tomorrow | date()}}', {}, ctxAt(crossMonth)) === '2026-12-02',
    E.render('{{tomorrow | date()}}', {}, ctxAt(crossMonth)));
  ok('跨年：tomorrow → 2027-01-02',
    E.render('{{tomorrow | date()}}', {}, ctxAt(Date.UTC(2026, 11, 31, 18, 0, 0))) === '2027-01-02');
  ok('管道 addDays + format 自定义格式',
    E.render("{{ now | addDays(1) | format('YYYY/MM/DD HH:mm') }}", {}, ctxAt(u)) === '2026/11/16 08:00',
    E.render("{{ now | addDays(1) | format('YYYY/MM/DD HH:mm') }}", {}, ctxAt(u)));
  ok('weekday / 时间戳 / YYYYMMDD',
    E.render('{{ now | weekday() }}', {}, ctxAt(u)) === '星期日'
    && E.render('{{ now | timestamp() }}', {}, ctxAt(u)) === String(Math.floor(u / 1000))
    && E.render("{{ now | format('YYYYMMDD') }}", {}, ctxAt(u)) === '20261115');
  ok('负偏移时区可覆盖', E.formatAt(u, 'YYYY-MM-DD HH:mm', -300) === '2026-11-14 19:00');

  console.log('\n[2] 变量解析、派生变量、自定义函数');
  const vars = E.resolveVars({
    city: '北京',
    tomorrowtime: { expr: "now | addDays(1) | format('YYYY-MM-DD 08:00:00')" },
    dayParam: '{{tomorrowtime | urlencode()}}',
    display: '{{CITY}} · {{tomorrowtime}}',
  }, ctxAt(u));
  ok('派生变量算对', vars.tomorrowtime === '2026-11-16 08:00:00', vars.tomorrowtime);
  ok('静态值模板可引用派生变量并 urlencode',
    vars.dayParam === encodeURIComponent('2026-11-16 08:00:00'), vars.dayParam);
  ok('变量名不分大小写', vars.display === '北京 · 2026-11-16 08:00:00', vars.display);
  ok('未定义占位符原样保留',
    E.render('{{nope}} / {{now | noSuchFunc()}}', {}, ctxAt(u)) === '{{nope}} / {{now | noSuchFunc()}}');
  ok('单花括号不被替换（JSON 兼容）',
    E.render('{"d":"{tomorrowtime}"}', {}, ctxAt(u)) === '{"d":"{tomorrowtime}"}');
  ok('引号内的逗号和管道不当分隔符',
    E.render("{{ now | format('YYYY,MM|DD') }}", {}, ctxAt(u)) === '2026,11|15',
    E.render("{{ now | format('YYYY,MM|DD') }}", {}, ctxAt(u)));
  ok('循环模板不死循环', (() => {
    const v = E.resolveVars({ a: '{{b}}', b: '{{a}}' }, ctxAt(u));
    return typeof v.a === 'string' && typeof v.b === 'string';
  })());
  E.registerFunc('quarter', (value, args, c) => {
    const p = E.shiftParts(value, c.offsetMin);
    return 'Q' + (Math.floor(p.mo / 3) + 1) + ' ' + p.y;
  });
  ok('自定义函数可注册并参与管道', E.render('{{ now | quarter() }}', {}, ctxAt(u)) === 'Q4 2026');
  ok('非法函数名被拒绝', (() => { try { E.registerFunc('1bad', () => 1); return false; } catch { return true; } })());

  console.log('\n[3] 站点零改动判据');
  ok('server.js 仍是 {{纯单词}} 正则', SERVER.includes('/\\{\\{\\s*(\\w+)\\s*\\}\\}/g'));
  ok('表达式不被站点正则匹配',
    !/\{\{\s*(\w+)\s*\}\}/g.test("{{ now | addDays(1) | format('YYYY-MM-DD') }}"));
  const body = JSON.stringify({
    vars: { tomorrowtime: { expr: "now | addDays(1) | format('YYYY-MM-DD')" } },
    input: { template: { url: 'https://api.example.com/w?d={{tomorrowtime}}' } },
  });
  const map = new Map([['SCRIPT_BASE', 'https://cronhub-scripts.pages.dev'], ['SCRIPT_SECRET', 'S']]);
  const applied = body.replace(/\{\{\s*(\w+)\s*\}\}/g,
    (m, k) => (map.has(k.toUpperCase()) ? map.get(k.toUpperCase()) : m));
  ok('站内只替换已知变量，{{tomorrowtime}} 原样透传',
    applied.includes('{{tomorrowtime}}') && !applied.includes('{{SCRIPT_BASE}}'));

  console.log('\n[4] Worker 路由、鉴权与脚本执行');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(SRC).toString('base64'));
  const worker = mod.default;
  const env = { SCRIPT_SECRET: 'test-secret', TZ_OFFSET_MINUTES: '480' };
  const call = (url, opts = {}) => worker.fetch(new Request(url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
  }), opts.env === undefined ? env : opts.env);
  const post = (url, payload, headers) => call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-script-secret': 'test-secret', ...(headers || {}) },
    body: JSON.stringify(payload),
  });

  const h = await call('https://x.pages.dev/__health');
  const hj = await h.json();
  ok('/__health 无需鉴权且列出脚本与函数', h.status === 200 && hj.ver === 'cloudfn-v1'
    && hj.scripts.includes('proxy') && hj.funcs.includes('addDays'), hj);

  const noKey = await post('https://x.pages.dev/v1/vars-echo', {}, { 'x-script-secret': 'wrong' });
  ok('错误密钥 403', noKey.status === 403);
  const noConf = await call('https://x.pages.dev/v1/vars-echo', { env: {} });
  ok('未配密钥 503', noConf.status === 503);
  const unknown = await post('https://x.pages.dev/v1/nope', {});
  ok('未知脚本 404', unknown.status === 404);

  const echo = await post('https://x.pages.dev/v1/vars-echo', {
    vars: {
      city: '北京',
      apiSecret: 'abcdef123456',
      tomorrowtime: { expr: "now | addDays(1) | format('YYYY-MM-DD 08:00:00')" },
    },
  });
  const ej = await echo.json();
  ok('vars-echo 200 且派生变量格式正确', echo.status === 200 && ej.ok
    && /^\d{4}-\d{2}-\d{2} 08:00:00$/.test(ej.data.vars.tomorrowtime), ej.data);
  ok('敏感键打码、普通值原样', ej.data.vars.apiSecret === '••••3456' && ej.data.vars.city === '北京');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"temp":-1.4}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const proxied = await post('https://x.pages.dev/v1/proxy', {
    vars: { tomorrowtime: { expr: "now | addDays(1) | format('YYYY-MM-DD')" } },
    input: { template: {
      url: 'https://api.example.com/w?d={{tomorrowtime}}',
      method: 'GET',
      headers: '{"X-Date": "{{tomorrowtime}}"}',
    } },
  });
  const pj = await proxied.json();
  ok('proxy 渲染模板后转发成功', proxied.status === 200 && pj.ok && pj.data.body === '{"temp":-1.4}', pj);
  ok('proxy 摘要含上游 host 与状态', /api\.example\.com → 200/.test(pj.summary), pj.summary);

  const unresolved = await post('https://x.pages.dev/v1/proxy', {
    input: { template: { url: 'https://api.example.com/w?d={{nope}}' } },
  });
  const uj = await unresolved.json();
  ok('未解析占位符报 unresolved_var 而非静默发出', unresolved.status === 500 && uj.code === 'unresolved_var', uj);

  globalThis.fetch = async () => new Response('upstream down', { status: 502 });
  const upstreamBad = await post('https://x.pages.dev/v1/proxy', {
    input: { template: { url: 'https://api.example.com/w' } },
  });
  const ubj = await upstreamBad.json();
  ok('上游非 2xx → 云函数 500 且带回 data.status', upstreamBad.status === 500
    && ubj.code === 'upstream_status' && ubj.data.status === 502, ubj);

  globalThis.fetch = async () => new Response('[{"id":1}]', { status: 200 });
  const agg = await post('https://x.pages.dev/v1/aggregate-json', {
    vars: { today: { expr: 'now | date()' } },
    input: { calls: [{ name: 'one', url: 'https://a.example.com/x?d={{today}}' }] },
  });
  const agj = await agg.json();
  ok('aggregate-json 合并上游结果', agg.status === 200 && agj.ok && agj.data.one.status === 200, agj);
  globalThis.fetch = originalFetch;

  console.log('\n────────────────────────────');
  console.log(fail ? `失败 ${fail} / ${pass + fail}` : `全部通过 ${pass} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
