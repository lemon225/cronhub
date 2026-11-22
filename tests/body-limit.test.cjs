/*
 * 第二十一批 · 响应数据「允许全部接受」
 *
 * 用户从「天气预报·示例镇」的日志里看到
 *   「…（已截断：原文共 14173 字，仅保留前 2000 字）」
 * 担心接口返回的数据被砍掉。这个用例守住全链路都不再截业务数据：
 *
 *   A 单步 14173 字响应   → 日志 message / response / lastResult.json 都完整
 *   B 5 步 × 5000 字      → 合计 25000 字不再被「合计 8000」砍掉后半段
 *   C 失败响应的长正文    → 不再截到 2000 字
 *   D AI 事实材料         → mock AI 收到的 rawData 是完整数据，无「数据已截断」
 *   E 安全阀             → CRONHUB_BODY_MAX=500 时仍会截断且明确标注
 *
 * 断言全部走真实 HTTP + 真实 state.json，不 mock 内部函数。
 * 跑法：node tests/body-limit.test.cjs
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-body-'));

/** 造一段长度可控、末尾带唯一标记的 JSON，方便断言「后半段还在」。 */
function longBody(tag, size) {
  const head = JSON.stringify({ tag, pad: '', tail: 'END-' + tag });
  const pad = 'x'.repeat(Math.max(0, size - head.length));
  return JSON.stringify({ tag, pad, tail: 'END-' + tag });
}

/** 上游：/long 返回 14173 字；/s1..s5 各返回 5000 字；/fail 返回 500 + 长正文 */
function startUpstream() {
  const server = http.createServer((req, res) => {
    const key = req.url.replace(/^\//, '').split('?')[0];
    if (key === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(longBody('FAIL', 9000));
      return;
    }
    const size = key === 'long' ? 14173 : 5000;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(longBody(key, size));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** mock AI：把真实请求体存下来，回一个合法的最小改写结果 */
function startAi() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d.toString(); });
    req.on('end', () => {
      seen.push(raw);
      const content = JSON.stringify({ title: 't', body: '今天晴，最低 -1.8 °C。' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function httpTask(id, name, url, extra) {
  const now = Date.now();
  return {
    id, name, type: 'http', enabled: true,
    schedules: [{ mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 }],
    schedule: { mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 },
    config: Object.assign({ url, method: 'GET', expectStatus: 200, timeoutSec: 8 }, extra || {}),
    notify: { channels: [] },
    nextRun: new Date(now + 86400000).toISOString(),
    lastRun: null, runCount: 0, failCount: 0, lastResult: null,
    createdAt: new Date(now - 86400000).toISOString(),
  };
}

function makeState(upPort, aiPort) {
  const u = (p) => `http://127.0.0.1:${upPort}/${p}`;
  const five = ['s1', 's2', 's3', 's4', 's5'].map((k, i) => ({ name: '步骤' + (i + 1), url: u(k), method: 'GET' }));
  return {
    tasks: [
      httpTask('t_long', '单步长响应', u('long')),
      httpTask('t_multi', '多步长响应', u('s1'), { steps: five }),
      httpTask('t_fail', '失败长响应', u('fail')),
      httpTask('t_ai', 'AI 长材料', u('long')),
    ],
    notifications: [], logs: [],
    settings: {
      catchup: { enabled: false },
      blockPrivateUrls: false,
      sms: { enabled: false },
      missedPolicy: 'skip',
      ai: {
        enabled: true, provider: 'openai', model: 'mock-model', apiKey: 'mock-key',
        baseUrl: `http://127.0.0.1:${aiPort}/v1`,
        defaultPrompt: '', timeoutMs: 20000, maxAttempts: 1,
      },
    },
    smsRelay: [], keepAliveLog: [], auth: null, authLog: [], systemLogs: [],
    deadLetters: [], smsRecords: [],
  };
}

async function start(dir, port, extraEnv) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dir,
      CRONHUB_ENV: 'dev', CRONHUB_SMS_REAL: '', CRONHUB_PREWARM: '0', CRONHUB_SMS_RELAY: '',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return { child, base, log: () => out }; } catch { /* 启动中 */ }
    await sleep(120);
  }
  child.kill();
  throw new Error('服务未启动：\n' + out.slice(-1500));
}

async function stop(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}
const getJSON = async (base, p) => (await fetch(base + p)).json();

async function runAndWait(base, id, beforeLogs) {
  const r = await fetch(base + '/api/tasks/' + id + '/run', { method: 'POST' });
  if (r.status !== 202) return { ok: false, error: 'run 返回 ' + r.status };
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const st = await getJSON(base, '/api/state');
    if ((st.logs || []).length > beforeLogs) return { ok: true, log: (st.logs || [])[0], state: st };
  }
  return { ok: false, error: '执行超时未见日志' };
}

(async () => {
  const dir = freshDir();
  const up = await startUpstream();
  const ai = await startAi();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(makeState(up.port, ai.port), null, 2));

  const port = 19000 + Math.floor(Math.random() * 500);
  let srv = null;
  try {
    console.log('\n[1] 单步 14173 字：日志与落盘都不许截');
    srv = await start(dir, port);
    let base = srv.base;
    let r = await runAndWait(base, 't_long', 0);
    ok('执行成功', r.ok && r.log && r.log.ok === true, r.log && r.log.message);
    const msg = String((r.log && r.log.message) || '');
    const resp = String((r.log && r.log.response) || '');
    ok('日志 message 含末尾标记 END-long', msg.includes('END-long'), msg.slice(-120));
    ok('日志 message 无「已截断」', !msg.includes('已截断'), msg.slice(-120));
    ok('日志 response 含末尾标记且无「已截断」', resp.includes('END-long') && !resp.includes('已截断'), resp.slice(-120));
    ok('原始正文确实超过 8000 字（回归前提）', resp.length > 13000, resp.length);
    const st1 = r.state;
    const j = ((st1.tasks.find((t) => t.id === 't_long') || {}).lastResult || {}).steps;
    ok('lastResult.json 是完整对象（含 pad 与 tail）',
      !!(j && j[0] && j[0].json && j[0].json.tail === 'END-long' && j[0].json.pad.length > 13000),
      j && j[0] && j[0].json && Object.keys(j[0].json));

    console.log('\n[2] 5 步 × 5000 字：合计不再被 8000 砍掉');
    r = await runAndWait(base, 't_multi', 1);
    ok('执行成功', r.ok && r.log && r.log.ok === true, r.log && r.log.message);
    const m2 = String((r.log && r.log.message) || '');
    const p2 = String((r.log && r.log.response) || '');
    const marks = ['END-s1', 'END-s2', 'END-s3', 'END-s4', 'END-s5'];
    ok('message 含全部 5 个步骤末尾标记', marks.every((m) => m2.includes(m)), marks.filter((m) => !m2.includes(m)));
    ok('response 含全部 5 个步骤末尾标记', marks.every((m) => p2.includes(m)), marks.filter((m) => !p2.includes(m)));
    ok('response 长度 > 25000（合计未被截）', p2.length > 25000, p2.length);
    ok('message / response 均无「已截断」', !m2.includes('已截断') && !p2.includes('已截断'));

    console.log('\n[3] 失败响应的长正文也完整');
    r = await runAndWait(base, 't_fail', 2);
    ok('判定为失败', r.ok && r.log && r.log.ok === false, r.log && r.log.message);
    const m3 = String((r.log && r.log.message) || '');
    ok('失败正文含 END-FAIL 且无「已截断」', m3.includes('END-FAIL') && !m3.includes('已截断'), m3.slice(-120));

    console.log('\n[4] AI 事实材料完整（mock AI 抓真实请求）');
    const before = ai.seen.length;
    r = await runAndWait(base, 't_ai', 3);
    ok('执行成功', r.ok && r.log && r.log.ok === true, r.log && r.log.message);
    const reqBody = ai.seen.length > before ? ai.seen[ai.seen.length - 1] : '';
    ok('确实调用了 AI', !!reqBody);
    ok('AI 请求含完整末尾标记 END-long', reqBody.includes('END-long'));
    ok('AI 材料没有「数据已截断」', !reqBody.includes('数据已截断'));
    ok('AI 材料长度 > 13000', reqBody.length > 13000, reqBody.length);
    const note = (r.state.notifications || [])[0];
    ok('通知已生成', !!note, note && note.title);
    if (note && note.rawBody) ok('AI 前原文未被 800 字静默截掉', !/已截断/.test(note.rawBody));

    await stop(srv.child);
    srv = null;

    console.log('\n[5] 安全阀：CRONHUB_BODY_MAX=500 时仍会截且标注');
    const dir2 = freshDir();
    fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify(makeState(up.port, ai.port), null, 2));
    srv = await start(dir2, port + 1, { CRONHUB_BODY_MAX: '500' });
    base = srv.base;
    r = await runAndWait(base, 't_long', 0);
    const m5 = String((r.log && r.log.message) || '');
    ok('执行成功', r.ok && r.log && r.log.ok === true);
    ok('小上限时出现明确截断标注', m5.includes('已截断：原文共') && m5.includes('仅保留前 500 字'), m5.slice(-120));
    ok('小上限时末尾标记确实不在（证明真截了）', !m5.includes('END-long'));
  } catch (e) {
    failures++;
    console.log('  ✗ 用例异常：' + (e && e.stack ? e.stack : e));
  } finally {
    if (srv) await stop(srv.child);
    up.server.close();
    ai.server.close();
  }

  console.log('\n' + (failures ? `失败 ${failures} 项` : '全部通过'));
  process.exit(failures ? 1 : 0);
})();
