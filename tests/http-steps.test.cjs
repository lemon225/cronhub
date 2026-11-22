/*
 * 第四十七批 · HTTP 多步骤链路
 *
 * 守住 2026-11-21 压测出来的四件事：
 *   ① 脚本任务的默认超时必须是 60 秒（曾被 sanitize 写死成 15，脚本跑到一半被杀）；
 *   ② 多步骤失败重试不能重放已成功的步骤（签到成功、领奖 500 会变成签到两次）；
 *   ③ extract 路径要认接口文档的方括号写法 data.items[0].token；
 *   ④ 步骤之间能用 {{step1.token}} 传值，{{json:KEY}} 能防住变量里的引号。
 *
 * 跑法：node tests/http-steps.test.cjs
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4141;
const UPP = 4142;
const BASE = `http://127.0.0.1:${PORT}`;
const UP = `http://127.0.0.1:${UPP}`;
let failures = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-httpsteps-'));
  let countHits = 0;
  let lastBody = '';
  const mock = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const p = req.url.split('?')[0];
      res.setHeader('Content-Type', 'application/json');
      if (p === '/count') { countHits += 1; return res.end(JSON.stringify({ ok: true, hit: countHits })); }
      if (p === '/fail') { res.statusCode = 500; return res.end('{"msg":"upstream boom"}'); }
      if (p === '/token') return res.end(JSON.stringify({ data: { items: [{ token: 'abc123' }] } }));
      if (p === '/echo') { lastBody = buf; return res.end('{"ok":true}'); }
      if (p === '/need-token') return res.end(JSON.stringify({ got: String(req.headers['x-token'] || '') }));
      res.statusCode = 404;
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => mock.listen(UPP, '127.0.0.1', r));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), CRONHUB_PREWARM: '0', CRONHUB_BLOCK_PRIVATE_URL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (c) => { serverLog += c; });
  child.stderr.on('data', (c) => { serverLog += c; });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { const h = await api('/api/health'); if (h && (h.build || h.ok)) { up = true; break; } } catch { /* 继续等 */ }
    }
    ok('服务启动', up, serverLog.slice(-300));
    await api('/api/settings', { method: 'PUT', body: { envVars: [{ key: 'Q', value: 'a"b', enabled: true }] } });

    console.log('\n[1] 默认超时按类型分开');
    const cr = await api('/api/tasks/upsert', { method: 'POST', body: { items: [{
      name: 'T 脚本默认', type: 'http', enabled: false,
      schedules: [{ mode: 'cron', cron: '0 3 * * *' }],
      config: { url: '', script: 'return 1;' },
    }] } });
    const ch = await api('/api/tasks/upsert', { method: 'POST', body: { items: [{
      name: 'T 接口默认', type: 'http', enabled: false,
      schedules: [{ mode: 'cron', cron: '0 3 * * *' }],
      config: { url: `${UP}/count` },
    }] } });
    const st0 = await api('/api/state');
    const tScript = (st0.tasks || []).find((t) => t.name === 'T 脚本默认');
    const tHttp = (st0.tasks || []).find((t) => t.name === 'T 接口默认');
    ok('脚本任务默认 60 秒', !!tScript && Number(tScript.config.timeoutSec) === 60, tScript && tScript.config.timeoutSec);
    ok('接口任务默认 15 秒', !!tHttp && Number(tHttp.config.timeoutSec) === 15, tHttp && tHttp.config.timeoutSec);
    ok('创建都成功', !!(cr.created && cr.created.length) && !!(ch.created && ch.created.length), [cr, ch]);

    console.log('\n[2] extract 方括号路径');
    const r2 = await api('/api/tasks/test', { method: 'POST', body: {
      type: 'http', name: '临时-方括号',
      config: { url: `${UP}/token`, method: 'GET', timeoutSec: 8,
        extract: [{ path: 'data.items[0].token', label: '令牌' }] },
    } });
    const s2 = (r2.steps && r2.steps[0]) || {};
    ok('data.items[0].token 取到值', !!(s2.extract && s2.extract['令牌'] === 'abc123'), r2);

    console.log('\n[3] 步骤之间传值');
    const r3 = await api('/api/tasks/test', { method: 'POST', body: {
      type: 'http', name: '临时-传值',
      config: { url: '', timeoutSec: 8, steps: [
        { name: '取令牌', method: 'GET', url: `${UP}/token`, extract: [{ path: 'data.items[0].token', label: 'token' }] },
        { name: '带令牌', method: 'GET', url: `${UP}/need-token`, headers: '{"x-token":"{{step1.token}}"}' },
      ] },
    } });
    ok('第一步提取到 token', !!(r3.steps && r3.steps[0] && r3.steps[0].extract && r3.steps[0].extract.token === 'abc123'), r3.steps && r3.steps[0]);
    ok('{{step1.token}} 被替换', !!r3.ok && /abc123/.test(String((r3.steps[1] || {}).message || '')), r3.steps && r3.steps[1]);
    const r3b = await api('/api/tasks/test', { method: 'POST', body: {
      type: 'http', name: '临时-传值2',
      config: { url: '', timeoutSec: 8, steps: [
        { name: '取令牌', method: 'GET', url: `${UP}/token`, extract: [{ path: 'data.items[0].token', label: 'token' }] },
        { name: '带令牌', method: 'GET', url: `${UP}/need-token`, headers: '{"x-token":"{{取令牌.token}}"}' },
      ] },
    } });
    ok('按步骤名也能取（中文名）', !!r3b.ok && /abc123/.test(String((r3b.steps[1] || {}).message || '')), r3b.steps && r3b.steps[1]);

    console.log('\n[4] JSON 体里的变量引号');
    lastBody = '';
    const r4 = await api('/api/tasks/test', { method: 'POST', body: {
      type: 'http', name: '临时-引号',
      config: { url: `${UP}/echo`, method: 'POST', timeoutSec: 8,
        headers: '{"content-type":"application/json"}', body: '{"pw":"{{Q}}"}' },
    } });
    ok('坏 JSON 在本地被拦下', r4.ok === false && /\{\{json:KEY\}\}/.test(String(r4.error || '')), r4);
    ok('坏 JSON 没有发出去', lastBody === '', lastBody);
    const r4b = await api('/api/tasks/test', { method: 'POST', body: {
      type: 'http', name: '临时-转义',
      config: { url: `${UP}/echo`, method: 'POST', timeoutSec: 8,
        headers: '{"content-type":"application/json"}', body: '{"pw":"{{json:Q}}"}' },
    } });
    let parsed = null;
    try { parsed = JSON.parse(lastBody); } catch { parsed = null; }
    ok('{{json:Q}} 发出的是合法 JSON', r4b.ok === true && !!parsed, { r: r4b, body: lastBody });
    ok('转义后值仍是 a"b', !!parsed && parsed.pw === 'a"b', parsed);

    console.log('\n[5] 多步骤失败重试不重放');
    countHits = 0;
    await api('/api/tasks/upsert', { method: 'POST', body: { items: [{
      name: 'T 重试重放', type: 'http', enabled: false,
      schedules: [{ mode: 'cron', cron: '0 4 * * *' }],
      config: { url: '', timeoutSec: 8, retry: { times: 2, delayMs: 300 }, steps: [
        { name: '第一步', method: 'GET', url: `${UP}/count` },
        { name: '第二步', method: 'GET', url: `${UP}/fail` },
      ] },
    }] } });
    const st1 = await api('/api/state');
    const tRetry = (st1.tasks || []).find((t) => t.name === 'T 重试重放');
    ok('任务已创建', !!tRetry, st1.tasks && st1.tasks.map((t) => t.name));
    await api(`/api/tasks/${tRetry.id}/run`, { method: 'POST', body: {} });
    await sleep(3000);
    const st2 = await api('/api/state');
    const logRetry = (st2.logs || []).find((l) => l.taskName === 'T 重试重放');
    ok('整体按失败记录', !!logRetry && logRetry.ok === false, logRetry && logRetry.message);
    ok('已成功的第一步只跑 1 次', countHits === 1, `实际 ${countHits} 次`);
    const sl = await api('/api/system-logs?q=' + encodeURIComponent('跳过自动重试'));
    ok('系统日志说明了原因', Array.isArray(sl.logs) && sl.logs.some((l) => /T 重试重放/.test(l.msg)), sl.logs && sl.logs.map((l) => l.msg));

    console.log('\n[清理]');
    const st3 = await api('/api/state');
    const ids = (st3.tasks || []).filter((t) => /^T /.test(t.name)).map((t) => t.id);
    if (ids.length) await api('/api/tasks/batch', { method: 'POST', body: { action: 'delete', ids } });
    const st4 = await api('/api/state');
    ok('临时任务已清空', (st4.tasks || []).filter((t) => /^T /.test(t.name)).length === 0);
  } finally {
    child.kill();
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('异常:', (e && e.stack) || e);
  process.exit(1);
});
