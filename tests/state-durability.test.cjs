/*
 * 第十六批 · 落盘可靠性故障注入
 *
 * 验证四件事：
 *   1. 正常写盘留下 fsync 证据，并自动生成 bak.1；
 *   2. 主文件被截断（模拟断电写坏）→ 改名隔离 + 从 bak.1 恢复 + 任务数不变；
 *   3. 主文件被清空（0 字节）→ 同样能恢复；
 *   4. 主文件与全部备份都坏 → 起空状态但必须留痕（recovered=true），绝不静默。
 *
 * 跑法：node tests/state-durability.test.cjs
 * 不依赖任何第三方库；数据目录用系统临时目录，绝不碰项目 data/ 与线上。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
let failures = 0;

function ok(name, cond, extra) {
  if (cond) {
    results.push({ name, pass: true });
    console.log('  ✓ ' + name);
  } else {
    failures++;
    results.push({ name, pass: false, extra });
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeState(tasks) {
  return {
    tasks,
    notifications: [],
    logs: [],
    settings: {},
    smsRelay: [],
    keepAliveLog: [],
    auth: null,
    authLog: [],
    systemLogs: [],
    deadLetters: [],
    smsRecords: [],
  };
}

function makeTasks(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: 't_' + i,
      name: '用例任务 ' + i,
      type: 'remind',
      enabled: false,
      cron: '0 9 * * *',
      message: '测试',
      config: {},
      notify: { channels: [] },
      createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    });
  }
  return out;
}

function freshDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-state-' + tag + '-'));
  return dir;
}

async function start(dir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      // 强制 dev：任何情况下都不产生真实短信
      CRONHUB_ENV: 'dev',
      CRONHUB_SMS_REAL: '',
    },
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

async function stop(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function getJSON(base, p) {
  const r = await fetch(base + p);
  return r.json();
}

(async () => {
  /* ---------------------------------------------------------------- 1. 正常写入 */
  console.log('\n[1] 正常写盘：fsync 生效 + 自动生成 bak.1');
  const d1 = freshDir('normal');
  fs.writeFileSync(path.join(d1, 'state.json'), JSON.stringify(makeState(makeTasks(3)), null, 2));
  let s = await start(d1, 18901);
  let health = await getJSON(s.base, '/api/health');
  let st = health.storage || {};
  ok('fsync 真正执行过', st.fsync === true, st);
  ok('加载来源是主文件', st.loadSource === 'main', st.loadSource);
  ok('未发生回退', st.recovered === false, st.recovered);
  ok('已有备份时间戳', !!st.backup.at, st.backup);
  ok('bak.1 已生成', fs.existsSync(path.join(d1, 'state.json.bak.1')));
  const stFull = await getJSON(s.base, '/api/state');
  ok('任务数 3', (stFull.tasks || []).length === 3, (stFull.tasks || []).length);
  await stop(s.child);

  /* -------------------------------------------------- 2. 半截 JSON（断电写坏） */
  console.log('\n[2] 主文件被截断：隔离 + 从 bak.1 恢复');
  const mainFile = path.join(d1, 'state.json');
  const truncated = fs.readFileSync(mainFile, 'utf8').slice(0, 40);
  fs.writeFileSync(mainFile, truncated);
  s = await start(d1, 18902);
  health = await getJSON(s.base, '/api/health');
  st = health.storage || {};
  ok('标记为已回退', st.recovered === true, st.recovered);
  ok('回退来源 bak1', st.recoveredFrom === 'bak1', st.recoveredFrom);
  ok('恢复出 3 个任务', st.recoveredTasks === 3, st.recoveredTasks);
  const corrupt = fs.readdirSync(d1).filter((f) => f.includes('.corrupt.'));
  ok('坏文件被隔离保留', corrupt.length >= 1, corrupt);
  if (corrupt.length) {
    const kept = fs.readFileSync(path.join(d1, corrupt[0]), 'utf8');
    ok('隔离文件内容 = 当初的截断内容', kept === truncated, { len: kept.length });
  }
  const afterRecover = await getJSON(s.base, '/api/state');
  ok('页面上看到的任务数仍是 3', (afterRecover.tasks || []).length === 3, (afterRecover.tasks || []).length);
  ok('主文件已回写为合法 JSON', (() => {
    try { return Array.isArray(JSON.parse(fs.readFileSync(mainFile, 'utf8')).tasks); } catch { return false; }
  })());
  await stop(s.child);

  /* ------------------------------------------------------------ 3. 0 字节文件 */
  console.log('\n[3] 主文件被清空（0 字节）：同样能恢复');
  fs.writeFileSync(mainFile, '');
  s = await start(d1, 18903);
  health = await getJSON(s.base, '/api/health');
  st = health.storage || {};
  ok('清空后仍标记回退', st.recovered === true, st.recovered);
  ok('清空后恢复出 3 个任务', st.recoveredTasks === 3, st.recoveredTasks);
  await stop(s.child);

  /* ---------------------------------------------- 4. 主文件与全部备份都不可用 */
  console.log('\n[4] 全部损坏：起空状态但必须留痕');
  const d2 = freshDir('allbad');
  fs.writeFileSync(path.join(d2, 'state.json'), '{bad');
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(d2, 'state.json.bak.' + i), '{"tasks":');
  s = await start(d2, 18904);
  health = await getJSON(s.base, '/api/health');
  st = health.storage || {};
  ok('无备份时标记回退', st.recovered === true, st.recovered);
  ok('恢复任务数为 0', st.recoveredTasks === 0, st.recoveredTasks);
  ok('错误被计数', (st.errors || 0) >= 1, st.errors);
  ok('隔离文件存在', fs.readdirSync(d2).some((f) => f.includes('.corrupt.')), fs.readdirSync(d2));
  await stop(s.child);

  /* ------------------------------------------------------ 5. 结构不完整也算损坏 */
  console.log('\n[5] 结构不完整（缺 tasks）：按损坏处理，不静默清空');
  const d3 = freshDir('shape');
  fs.writeFileSync(path.join(d3, 'state.json'), JSON.stringify({ notifications: [{ id: 'n1' }] }));
  s = await start(d3, 18905);
  health = await getJSON(s.base, '/api/health');
  st = health.storage || {};
  ok('缺 tasks 被视为损坏', st.recovered === true, st);
  await stop(s.child);

  console.log('\n' + (failures === 0
    ? '全部通过：' + results.length + '/' + results.length
    : '失败 ' + failures + ' / 共 ' + results.length));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('用例执行异常:', e && e.stack || e);
  process.exit(1);
});
