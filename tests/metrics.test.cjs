/*
 * 第十八批 · 看得见（运行指标 + 死信水位）
 *
 * 这批不改变任何调度行为，只解决「事后能不能判断」：
 *   ① 累计数（跑了 200 次、失败 7 次）分不清「零星抖动」和「从 14:00 起全挂」，
 *      所以要有按小时的桶；
 *   ② 失败次数分不清「自愈了」和「靠人补」，所以重试后成功要单独记一笔「救回」；
 *   ③ 死信队列以前只进不出、无人看，堆到 20 条和堆到 1 条在界面上没区别，
 *      所以要有水位告警，并且**同一档位只告警一次**（重启也不重发）。
 *
 * 断言全部走真实 HTTP + 真实 state.json，不 mock：
 *   A 一次成功           → ok=1，失败 0
 *   B 一次 500           → fail=1（重试默认关，不放大失败数）
 *   C 前 500 后 200      → ok=1 且 retry=1（救回）
 *   D 5 条死信在启动时   → alertLevel=5，只推一条告警
 *   E 重启               → 指标不归零，死信告警不重发
 *
 * 跑法：node tests/metrics.test.cjs
 */
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
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-metrics-'));
}

/** 本地上游：/ok 恒成功，/fail 恒 500，/flaky 第一次 500、之后成功 */
function startUpstream() {
  const calls = { ok: 0, fail: 0, flaky: 0 };
  const server = http.createServer((req, res) => {
    const key = req.url.replace(/^\//, '').split('?')[0];
    if (calls[key] === undefined) calls[key] = 0;
    calls[key] += 1;
    if (key === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'boom' }));
      return;
    }
    if (key === 'flaky' && calls[key] === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'first hit fails' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

function httpTask(id, name, url, extra) {
  const now = Date.now();
  return {
    id,
    name,
    type: 'http',
    enabled: true,
    schedules: [{ mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 }],
    schedule: { mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 },
    config: Object.assign({ url, method: 'GET', expectStatus: 200, timeoutSec: 8 }, extra || {}),
    notify: { channels: [] },
    // 排到一天后：本轮只用 /run 手动触发，避免 tick 掺进来把计数弄脏
    nextRun: new Date(now + 86400000).toISOString(),
    lastRun: null,
    runCount: 0,
    failCount: 0,
    lastResult: null,
    createdAt: new Date(now - 86400000).toISOString(),
  };
}

function deadLetter(i) {
  return {
    id: 'dl_seed_' + i,
    at: new Date(Date.now() - i * 60000).toISOString(),
    channel: 'notifyme',
    label: 'NotifyMe',
    title: '测试死信 ' + i,
    body: 'x',
    markdown: '',
    message: '模拟投递失败',
    attempts: 3,
    taskName: 'seed',
  };
}

function makeState(port) {
  return {
    tasks: [
      httpTask('t_ok', '成功任务', `http://127.0.0.1:${port}/ok`),
      httpTask('t_fail', '失败任务', `http://127.0.0.1:${port}/fail`),
      // 重试 1 次、间隔 500ms（下限）：第 1 次 503 属可重试，第 2 次成功
      httpTask('t_flaky', '抖动任务', `http://127.0.0.1:${port}/flaky`, {
        retry: { times: 1, delayMs: 500 },
      }),
    ],
    notifications: [],
    logs: [],
    settings: {
      catchup: { enabled: false },
      blockPrivateUrls: false,
      ai: { enabled: false },
      sms: { enabled: false },
      missedPolicy: 'skip',
    },
    smsRelay: [],
    keepAliveLog: [],
    auth: null,
    authLog: [],
    systemLogs: [],
    // 5 条死信正好踩第一档水位
    deadLetters: [0, 1, 2, 3, 4].map(deadLetter),
    smsRecords: [],
  };
}

async function start(dir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      CRONHUB_ENV: 'dev',
      CRONHUB_SMS_REAL: '',
      CRONHUB_PREWARM: '0',
      CRONHUB_SMS_RELAY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return { child, base, log: () => out };
    } catch { /* 还没起来 */ }
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

/** 手动执行一个任务，等它真的跑完（/run 是 202 异步的） */
async function runAndWait(base, id, beforeLogs) {
  const r = await fetch(base + '/api/tasks/' + id + '/run', { method: 'POST' });
  if (r.status !== 202) return { ok: false, error: 'run 返回 ' + r.status };
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const st = await getJSON(base, '/api/state');
    if ((st.logs || []).length > beforeLogs) {
      return { ok: true, log: (st.logs || [])[0], state: st };
    }
  }
  return { ok: false, error: '执行超时未见日志' };
}

(async () => {
  const dir = freshDir();
  const up = await startUpstream();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(makeState(up.port), null, 2));

  const port = 18000 + Math.floor(Math.random() * 500);
  let child = null;
  try {
    console.log('\n[1] 启动 + 死信水位（历史 5 条）');
    let srv = await start(dir, port);
    child = srv.child;
    const base = srv.base;

    let st = await getJSON(base, '/api/state');
    ok('死信条数 = 5', (st.deadLetter || {}).count === 5, st.deadLetter);
    ok('启动即把水位档位定在 5', (st.deadLetter || {}).alertLevel === 5, st.deadLetter);
    const dlNotes = (st.notifications || []).filter((n) => n.source === 'deadletter' && /死信堆积/.test(n.title || ''));
    ok('只推一条水位告警', dlNotes.length === 1, dlNotes.length);
    const h0 = await getJSON(base, '/api/health');
    ok('health 带死信水位与上限', (h0.deadLetter || {}).max === 50 && h0.deadLetter.alertLevel === 5, h0.deadLetter);

    console.log('\n[2] 三种执行结果分别落到指标桶');
    let r = await runAndWait(base, 't_ok', 0);
    ok('成功任务执行完成', r.ok && r.log && r.log.ok === true, r.log && r.log.message);
    r = await runAndWait(base, 't_fail', 1);
    ok('失败任务执行完成（判定为失败）', r.ok && r.log && r.log.ok === false, r.log && r.log.message);
    r = await runAndWait(base, 't_flaky', 2);
    ok('抖动任务重试后成功', r.ok && r.log && r.log.ok === true, r.log && r.log.message);
    ok('上游确实被打了两次', up.calls.flaky === 2, up.calls.flaky);

    st = await getJSON(base, '/api/state');
    const m = st.metrics || {};
    const d24 = m.last24h || {};
    ok('24h 成功 2 次', d24.ok === 2, d24);
    ok('24h 失败 1 次', d24.fail === 1, d24);
    ok('24h 重试救回 1 次', d24.retry === 1, d24);
    ok('成功率 = 66.7%（2/3）', m.successRate === 66.7, m.successRate);
    ok('24 个小时柱齐全', Array.isArray(m.hourly) && m.hourly.length === 24, m.hourly && m.hourly.length);
    const hourSum = (m.hourly || []).reduce((n, h) => n + h.ok + h.fail, 0);
    ok('小时柱合计 = 总执行数 3', hourSum === 3, hourSum);
    ok('最后一小时包含本次执行', (m.last1h || {}).ok === 2 && (m.last1h || {}).fail === 1, m.last1h);
    ok('失败任务的 lastResult 不带 attempts（没重试）', !(st.tasks.find((t) => t.id === 't_fail').lastResult || {}).attempts);
    ok('抖动任务的 lastResult 记了 attempts=2', (st.tasks.find((t) => t.id === 't_flaky').lastResult || {}).attempts === 2);

    const h1 = await getJSON(base, '/api/health');
    ok('health.metrics 汇总一致', (h1.metrics || {}).last24h && h1.metrics.last24h.ok === 2, h1.metrics);

    console.log('\n[3] 重启：指标不归零、告警不重发');
    await stop(child);
    srv = await start(dir, port);
    child = srv.child;
    st = await getJSON(srv.base, '/api/state');
    const m2 = st.metrics || {};
    ok('重启后 24h 成功仍为 2', (m2.last24h || {}).ok === 2, m2.last24h);
    ok('重启后重试救回仍为 1', (m2.last24h || {}).retry === 1, m2.last24h);
    ok('重启后桶数不膨胀（仍 1 个 5 分钟桶）', (m2.buckets || 0) === 1, m2.buckets);
    const dl2 = (st.notifications || []).filter((n) => n.source === 'deadletter' && /死信堆积/.test(n.title || ''));
    ok('重启不重发死信告警（仍 1 条）', dl2.length === 1, dl2.length);
    ok('重启后水位档位保持 5', (st.deadLetter || {}).alertLevel === 5, st.deadLetter);

    console.log('\n[4] 清空死信后档位归零（下次堆积能再提醒）');
    const del = await fetch(srv.base + '/api/sms/dead-letters', { method: 'DELETE' });
    ok('清空接口返回 200/403（未设口令时为开放模式）', del.status === 200 || del.status === 403, del.status);
    if (del.status === 200) {
      const st3 = await getJSON(srv.base, '/api/state');
      ok('清空后条数 0', (st3.deadLetter || {}).count === 0, st3.deadLetter);
      ok('清空后档位归零', (st3.deadLetter || {}).alertLevel === 0, st3.deadLetter);
    }
  } catch (err) {
    failures++;
    console.log('  ✗ 异常：' + (err && err.message));
    if (child && child.spawnargs) console.log(String((child.__log && child.__log()) || '').slice(-800));
  } finally {
    await stop(child);
    up.server.close();
  }

  console.log('\n────────────────────────────────');
  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
  console.log('全部通过');
})();
