/*
 * 任务部分更新（upsert）语义故障注入
 *
 * 起因：给 `instabox` 关掉重复告警时，只传了 name + config.notify，
 * 结果它的调度从「每 20 分钟」被换成默认的「每天 9 点」——而且是静默的。
 * 根因在 sanitizeTask：没传 schedule 就塞 [{}]，normalizeSchedule({}) 给默认值；
 * enabled / type / config 同样不回落 existing。
 *
 * 这不是一次误操作，是 upsert 的语义和实现不一致：
 * 接口说明是「按 name 匹配，匹配到就更新」，调用方自然按部分更新来用。
 *
 * 跑法：node tests/task-patch.test.cjs
 * 数据目录用系统临时目录，绝不碰项目 data/ 与线上。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(dir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, CRONHUB_ENV: 'dev', CRONHUB_SMS_REAL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return { child, base, log: () => out };
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  child.kill();
  throw new Error('服务未启动：\n' + out.slice(-800));
}

function stop(child) {
  if (!child || child.killed) return Promise.resolve();
  child.kill();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

const jget = async (base, p) => (await fetch(base + p)).json();
const jpost = async (base, p, body) => (await fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

const findTask = async (base, name) => {
  const s = await jget(base, '/api/state');
  return (s.tasks || []).find((t) => t.name === name);
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-patch-'));
  const s = await start(dir, 18921);
  try {
    /* ---------------------------------------------- 1. 只改通知策略，调度必须不动 */
    console.log('\n[1] upsert 只传 config.notify：schedule 不能被重置');
    await jpost(s.base, '/api/tasks', {
      name: '探活', type: 'http', enabled: true,
      schedule: { mode: 'interval', every: 20, unit: 'minute', startAt: '', everyMinutes: 20 },
      config: {
        url: 'https://example.com/', method: 'GET', expectStatus: 200, timeoutSec: 15,
        notify: { enabled: true, onSuccess: false, onFailure: true, channels: ['inapp'] },
      },
    });
    const before = await findTask(s.base, '探活');
    ok('初始是 20 分钟间隔', before.schedule.mode === 'interval' && before.schedule.everyMinutes === 20, before.schedule);

    await jpost(s.base, '/api/tasks/upsert', {
      items: [{
        name: '探活', type: 'http',
        config: { ...before.config, notify: { enabled: true, onSuccess: false, onFailure: false, channels: ['inapp'] } },
      }],
    });
    const after = await findTask(s.base, '探活');
    ok('schedule 仍是 20 分钟间隔', after.schedule.mode === 'interval' && after.schedule.everyMinutes === 20, after.schedule);
    ok('schedules 也保持原样', Array.isArray(after.schedules) && after.schedules[0].everyMinutes === 20, after.schedules);
    ok('通知策略已更新', after.config.notify.onFailure === false, after.config.notify);
    ok('nextRun 按 20 分钟重算（不是明天 9 点）', (() => {
      const ms = Date.parse(after.nextRun) - Date.now();
      return ms > 0 && ms <= 21 * 60000;
    })(), after.nextRun);

    /* ---------------------------------------------- 2. 只改组名，启停与类型不能翻 */
    console.log('\n[2] upsert 只传 group：enabled=false 与 type=remind 必须保住');
    await jpost(s.base, '/api/tasks', {
      name: '打卡', type: 'remind', enabled: false,
      schedule: { mode: 'cron', cron: '30 8 * * *' },
      config: { message: '记得打卡', channels: ['inapp'] },
    });
    const r1 = await findTask(s.base, '打卡');
    ok('初始为 remind + 暂停', r1.type === 'remind' && r1.enabled === false, [r1.type, r1.enabled]);

    await jpost(s.base, '/api/tasks/upsert', { items: [{ name: '打卡', group: '日常' }] });
    const r2 = await findTask(s.base, '打卡');
    ok('type 仍是 remind', r2.type === 'remind', r2.type);
    ok('enabled 仍是 false（没被偷偷打开）', r2.enabled === false, r2.enabled);
    ok('提醒内容还在', r2.config.message === '记得打卡', r2.config.message);
    ok('cron 仍是 30 8 * * *', r2.schedule.mode === 'cron' && r2.schedule.cron === '30 8 * * *', r2.schedule);
    ok('组名已改', r2.group === '日常', r2.group);
    ok('nextRun 为 null（暂停中）', r2.nextRun === null, r2.nextRun);

    /* ---------------------------------------------- 3. 真的什么都没传 */
    console.log('\n[3] upsert 只传 name：全字段不变');
    const snap = JSON.stringify(r2);
    await jpost(s.base, '/api/tasks/upsert', { items: [{ name: '打卡' }] });
    const r3 = await findTask(s.base, '打卡');
    const keep = ['type', 'enabled', 'group', 'schedule', 'schedules', 'config'];
    ok('关键字段逐项相同', keep.every((k) => JSON.stringify(r3[k]) === JSON.stringify(r2[k])),
      keep.filter((k) => JSON.stringify(r3[k]) !== JSON.stringify(r2[k])));
    ok('统计不被清零', r3.id === r2.id && r3.runCount === r2.runCount, [r3.id, r2.id]);
    void snap;

    /* ---------------------------------------------- 4. 显式传值仍然生效 */
    console.log('\n[4] 显式传 schedule / enabled 时必须照改');
    await jpost(s.base, '/api/tasks/upsert', {
      items: [{
        name: '打卡', enabled: true,
        schedule: { mode: 'interval', every: 2, unit: 'hour', startAt: '', everyMinutes: 120 },
      }],
    });
    const r4 = await findTask(s.base, '打卡');
    ok('enabled 改回 true', r4.enabled === true, r4.enabled);
    ok('schedule 换成每 2 小时', r4.schedule.everyMinutes === 120, r4.schedule);
    ok('nextRun 已重算且在未来', Date.parse(r4.nextRun) > Date.now(), r4.nextRun);
  } finally {
    await stop(s.child);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }
  }

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('用例崩了：', e);
  process.exit(1);
});
