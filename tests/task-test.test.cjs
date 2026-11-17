/*
 * 第三十六批 · 任务编辑面板「测试」按钮
 *
 * 守住两条：
 *   ① /api/tasks/test 用当前（未保存）配置真跑一次，返回每步 ok/status/响应摘要，
 *      失败步骤也要在结果里能看到（runHttpSteps 抛错时 e.steps 带上已跑的步骤）；
 *   ② 测试没有任何副作用 —— 不建任务、不写执行日志、不发通知、不动 runCount。
 *      测试若也发通知，用户点一次就被自己的配置轰炸一次。
 *
 * 跑法：node tests/task-test.test.cjs
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4137;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 500) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${pathname}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-tasktest-'));
  // mock 上游：/ok 返回 200 JSON，/bad 返回 500（带可读错误正文）
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/bad')) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"upstream boom"}'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"credit":8}'); }
  });
  await new Promise((r) => mock.listen(4138, '127.0.0.1', r));

  const child = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), CRONHUB_PREWARM: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (c) => { serverLog += c; });
  child.stderr.on('data', (c) => { serverLog += c; });

  try {
    let up = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try { await get('/api/health'); up = true; break; } catch { /* 继续等 */ }
    }
    ok('服务启动', up, serverLog.slice(-300));

    const before = await get('/api/state');
    const bTasks = before.tasks.length;
    const bLogs = (before.logs || []).length;
    const bNotif = (before.notifications || []).length;

    // 单步成功：用尚未保存的配置（没有 id / 没有合法 schedule，只有 config）
    const r1 = await post('/api/tasks/test', {
      name: '临时测试', type: 'http',
      config: { url: 'http://127.0.0.1:4138/ok', method: 'GET', expectStatus: 200 },
    });
    ok('单步成功回 ok:true', r1.ok === true, r1);
    ok('返回 1 步且成功', Array.isArray(r1.steps) && r1.steps.length === 1 && r1.steps[0].ok === true, r1.steps);
    ok('带状态码 200', r1.steps && r1.steps[0].status === 200, r1.steps);
    ok('响应摘要含 credit', r1.steps && /credit/.test(r1.steps[0].message), r1.steps);

    // 失败步骤也要可见（e.steps 带出）
    const r2 = await post('/api/tasks/test', {
      name: '临时测试2', type: 'http',
      config: {
        expectStatus: 200,
        steps: [
          { name: '先成功', url: 'http://127.0.0.1:4138/ok' },
          { name: '再失败', url: 'http://127.0.0.1:4138/bad' },
        ],
      },
    });
    ok('多步失败回 ok:false', r2.ok === false, r2);
    ok('失败时仍返回已跑的 2 步', Array.isArray(r2.steps) && r2.steps.length === 2, r2.steps);
    ok('第 1 步成功、第 2 步失败', r2.steps && r2.steps[0].ok === true && r2.steps[1].ok === false, r2.steps);

    // 缺地址：sanitizeHttpConfig 会补默认或用 runHttpTask 抛「未填写请求地址」
    const r3 = await post('/api/tasks/test', {
      name: '空配置', type: 'http', config: {},
    });
    ok('无地址回 ok:false 且给出原因', r3.ok === false && /地址/.test(r3.error || ''), r3);

    // 提醒任务：无需请求测试
    const r4 = await post('/api/tasks/test', {
      name: '提醒', type: 'remind', config: { message: '该吃药了', channels: ['inapp'] },
    });
    ok('提醒任务直接回配置检查通过', r4.ok === true && r4.type === 'remind', r4);

    // 副作用检查：测试跑完，任务/日志/通知数量与 runCount 全部不变
    const after = await get('/api/state');
    ok('未新增任务', after.tasks.length === bTasks, { before: bTasks, after: after.tasks.length });
    ok('未写执行日志', (after.logs || []).length === bLogs, { before: bLogs, after: (after.logs || []).length });
    ok('未发通知', (after.notifications || []).length === bNotif, { before: bNotif, after: (after.notifications || []).length });
    ok('未产生名为「临时测试」的任务', !after.tasks.some((t) => t.name === '临时测试'));
  } finally {
    child.kill('SIGTERM');
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures ? `失败 ${failures} 项` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('用例异常', e); process.exit(1); });
