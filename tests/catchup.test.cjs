/*
 * 第十六批之二 · 错过补跑（可控）
 *
 * 补跑的目的只有一个：服务不在的那段时间，任务别白丢。
 * 但它必须同时满足两个互相拉扯的要求 —— 补得到，且绝不重复跑。
 * 所以这里不测「有没有补」，而是逐条验证「哪些不该补」：
 *
 *   A 正常错过（10 分钟前，没跑过）      → 必须补 1 次
 *   B 错过太久（5 小时前，超 120 分钟窗口）→ 不补，只推进排期
 *   C 错过时刻之后其实已经跑过           → 不补（重复执行 = 副作用发生两次）
 *   D 任务级单独关闭补跑                 → 不补
 *   E 距上次执行太近（20s < 33s 下限）    → 不补（防对上游连打，触风控）
 *
 * 另外验证：
 *   · 启动时就把 nextRun 推进并落盘（认领），中途被回收也不会再来一次；
 *   · 第二次启动不会把已经补过的再补一遍；
 *   · maxPerStart 生效，超出部分丢弃而不是排队硬跑。
 *
 * 跑法：node tests/catchup.test.cjs
 * 数据目录用系统临时目录，上游用本地计数器，绝不碰线上、不发真实通知。
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
const MIN = 60000;

function makeState(tasks, catchup) {
  return {
    tasks,
    notifications: [],
    logs: [],
    settings: {
      catchup: Object.assign({ enabled: true, windowMinutes: 120, maxPerStart: 5, minGapSec: 45, jitterMaxMs: 1200 }, catchup || {}),
      blockPrivateUrls: false,
      missedPolicy: 'run',
    },
    smsRelay: [],
    keepAliveLog: [],
    auth: null,
    authLog: [],
    systemLogs: [],
    deadLetters: [],
    smsRecords: [],
  };
}

function httpTask(id, name, opts) {
  const o = opts || {};
  const now = Date.now();
  return {
    id,
    name,
    type: 'http',
    enabled: true,
    schedules: [{ mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 }],
    schedule: { mode: 'interval', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 },
    config: { url: 'http://127.0.0.1:' + o.port + '/hit/' + id, method: 'GET', noCatchup: o.noCatchup === true },
    notify: { channels: [] },
    nextRun: new Date(now - (o.lateMs === undefined ? 10 * MIN : o.lateMs)).toISOString(),
    lastRun: o.lastRunMs === undefined ? null : new Date(now - o.lastRunMs).toISOString(),
    runCount: 0,
    failCount: 0,
    lastResult: null,
    createdAt: new Date(now - 86400000).toISOString(),
  };
}

function freshDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-catchup-' + tag + '-'));
}

/** 本地上游：只记每个任务被真正打了几次，不关心返回内容 */
function startUpstream() {
  const hits = {};
  const server = http.createServer((req, res) => {
    const key = req.url.replace(/^\/hit\//, '').split('?')[0];
    hits[key] = (hits[key] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }));
  });
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
      // 补跑默认延后 12 秒（等预热），测试压到 400ms
      CRONHUB_CATCHUP_DELAY_MS: '400',
      CRONHUB_PREWARM: '0',
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
  throw new Error('服务未启动：\n' + out.slice(-1000));
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

const taskOf = (st, id) => (st.tasks || []).find((t) => t.id === id) || {};

(async () => {
  /* ================================================================ 场景一：五类判定 */
  console.log('\n[1] 补跑判定：只补「确实错过且没跑过」的那一个');
  const up = await startUpstream();
  const port = 8897;
  const dir = freshDir('matrix');
  const tasks = [
    httpTask('a', '正常错过-该补', { port: up.port, lateMs: 10 * MIN }),
    httpTask('b', '超出窗口-不该补', { port: up.port, lateMs: 5 * 60 * MIN }),
    httpTask('c', '之后已跑过-不该补', { port: up.port, lateMs: 10 * MIN, lastRunMs: 3 * MIN }),
    httpTask('d', '任务级关闭-不该补', { port: up.port, lateMs: 10 * MIN, noCatchup: true }),
    httpTask('e', '刚跑过-不该补', { port: up.port, lateMs: 5000, lastRunMs: 20000 }),
  ];
  // E 的周期改成 1 分钟：55% = 33 秒，20 秒前刚跑过 → 落在最小间隔内
  tasks[4].schedules = [{ mode: 'interval', every: 1, unit: 'minute', startAt: '', everyMinutes: 1 }];
  tasks[4].schedule = tasks[4].schedules[0];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(makeState(tasks), null, 2), 'utf8');

  const svc = await start(dir, port);
  // 启动瞬间就应该完成「认领」：nextRun 全部推进到未来，否则下一轮 tick 会直接跑掉
  const claimed = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  ok('启动即认领：所有错过的 nextRun 已推进到未来',
    (claimed.tasks || []).every((t) => !t.nextRun || Date.parse(t.nextRun) > Date.now() - 1000),
    (claimed.tasks || []).map((t) => ({ id: t.id, nextRun: t.nextRun })));

  await sleep(6000); // 400ms 启动延迟 + 抖动上限 1.2s + 执行
  const health = await getJSON(svc.base, '/api/health');
  const cu = health.catchup || {};
  const st = await getJSON(svc.base, '/api/state');

  ok('补跑只计划了 1 个', cu.planned === 1, cu);
  ok('跳过了 4 个', cu.skipped === 4, cu);
  const reasons = (cu.reasons || []).map((r) => r.reason);
  ok('跳过原因含「超窗口」', reasons.includes('window'), reasons);
  ok('跳过原因含「该时刻后已执行过」', reasons.includes('already'), reasons);
  ok('跳过原因含「任务级关闭」', reasons.includes('task-off'), reasons);
  ok('跳过原因含「距上次太近」', reasons.includes('gap'), reasons);

  ok('A 真被补跑 1 次', up.hits.a === 1, up.hits);
  ok('B（超窗口）一次都没打', !up.hits.b, up.hits);
  ok('C（已跑过）一次都没打', !up.hits.c, up.hits);
  ok('D（任务级关闭）一次都没打', !up.hits.d, up.hits);
  ok('E（刚跑过）一次都没打', !up.hits.e, up.hits);
  ok('A 的结果已落库（lastRun 有值）', !!taskOf(st, 'a').lastRun, taskOf(st, 'a').lastRun);
  ok('C 的 lastRun 没被改写（仍是原来那次）',
    Math.abs(Date.parse(taskOf(st, 'c').lastRun) - (Date.now() - 3 * MIN)) < 20000,
    taskOf(st, 'c').lastRun);
  ok('健康接口带回补跑快照', typeof cu.enabled === 'boolean' && cu.at !== null, cu);

  await stop(svc.child);

  /* ---------------------------------------------------------------- 幂等：再启动一次 */
  console.log('\n[2] 幂等：重启后不会把补过的再补一遍');
  const svc2 = await start(dir, port);
  await sleep(4000);
  ok('A 的命中数仍是 1（没有重复执行）', up.hits.a === 1, up.hits);
  const st2 = await getJSON(svc2.base, '/api/state');
  ok('A 的 runCount 仍是 1', taskOf(st2, 'a').runCount === 1, taskOf(st2, 'a').runCount);
  await stop(svc2.child);

  /* ================================================================ 场景三：单次上限 */
  console.log('\n[3] 单次上限：宁可少补，也不在启动时打出一波集中请求');
  const dir3 = freshDir('limit');
  const up3 = await startUpstream();
  const t3 = [
    httpTask('x', '错过-1', { port: up3.port, lateMs: 3 * MIN }),
    httpTask('y', '错过-2', { port: up3.port, lateMs: 4 * MIN }),
    httpTask('z', '错过-3', { port: up3.port, lateMs: 5 * MIN }),
  ];
  fs.writeFileSync(path.join(dir3, 'state.json'),
    JSON.stringify(makeState(t3, { maxPerStart: 2, jitterMaxMs: 600 }), null, 2), 'utf8');
  const svc3 = await start(dir3, 8896);
  await sleep(6000);
  const h3 = await getJSON(svc3.base, '/api/health');
  const c3 = h3.catchup || {};
  ok('计划补跑 2 个（上限 2）', c3.planned === 2, c3);
  ok('第 3 个被标记为「超上限」', (c3.reasons || []).some((r) => r.reason === 'limit'), c3.reasons);
  const totalHits = (up3.hits.x || 0) + (up3.hits.y || 0) + (up3.hits.z || 0);
  ok('实际只发了 2 次请求', totalHits === 2, up3.hits);
  ok('补的是最早错过的两个（y、z）', up3.hits.y === 1 && up3.hits.z === 1 && !up3.hits.x, up3.hits);
  await stop(svc3.child);
  up3.server.close();

  /* ================================================================ 场景四：总开关 */
  console.log('\n[4] 总开关关闭：一个都不跑，但排期照常推进');
  const dir4 = freshDir('off');
  const up4 = await startUpstream();
  fs.writeFileSync(path.join(dir4, 'state.json'),
    JSON.stringify(makeState([httpTask('m', '错过-但总开关关', { port: up4.port, lateMs: 20 * MIN })],
      { enabled: false }), null, 2), 'utf8');
  const svc4 = await start(dir4, 8895);
  await sleep(4000);
  const c4 = (await getJSON(svc4.base, '/api/health')).catchup || {};
  ok('计划补跑 0 个', c4.planned === 0, c4);
  ok('命中数为 0', !up4.hits.m, up4.hits);
  const st4 = await getJSON(svc4.base, '/api/state');
  ok('nextRun 仍然被推进到未来（不会一直卡在过去）',
    Date.parse(taskOf(st4, 'm').nextRun) > Date.now(), taskOf(st4, 'm').nextRun);
  await stop(svc4.child);
  up4.server.close();

  up.server.close();

  console.log('\n────────────────────────────────');
  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n用例异常：', e && e.message ? e.message : e);
  process.exit(1);
});
