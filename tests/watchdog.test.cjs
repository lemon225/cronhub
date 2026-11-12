/*
 * 第十七批 · 进程守护故障注入
 *
 * 验证：
 *   1. 通过 watchdog 启动时，服务端确实处于「守护模式」（health.supervised = true）——
 *      这是它敢在未捕获异常后直接退出的前提；
 *   2. 服务端被强制杀死（taskkill /F，等价于 OOM 或宿主强杀）后，守护会在几秒内把它拉起来；
 *   3. 被强杀之后 state.json 仍然是合法 JSON —— fsync + 原子改名经得起硬切；
 *   4. 重启事实落进 watchdog.log，事后能判断「是崩过还是平台重启过」。
 *
 * 跑法：node tests/watchdog.test.cjs（Windows 下用 PowerShell 定位子进程；其它平台跳过重启用例）
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18921;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-wd-'));
const LOG = path.join(DATA_DIR, 'watchdog.log');
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return null;
}

/** 找到 watchdog 的子进程（真正跑 server.js 的那个 node） */
function childPidOf(parentPid) {
  try {
    const cmd = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | '
      + 'Where-Object { $_.ParentProcessId -eq ' + parentPid + ' } | '
      + 'Select-Object -ExpandProperty ProcessId';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8', timeout: 20000,
    });
    const pid = parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function killHard(pid) {
  try {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  console.log('\n[1] 通过 watchdog 启动，确认处于守护模式');
  const wd = spawn(process.execPath, [path.join(ROOT, 'watchdog.cjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, CRONHUB_ENV: 'dev', CRONHUB_SMS_REAL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wdOut = '';
  wd.stdout.on('data', (d) => { wdOut += d.toString(); });
  wd.stderr.on('data', (d) => { wdOut += d.toString(); });

  const h1 = await health(20000);
  ok('服务已起来', !!h1, wdOut.slice(-300));
  ok('health.supervised = true', !!h1 && h1.supervised === true, h1 && h1.supervised);
  ok('watchdog.log 已创建', fs.existsSync(LOG));

  const childPid = childPidOf(wd.pid);
  ok('能定位到子进程 PID', childPid > 0, { wdPid: wd.pid, childPid });

  if (childPid > 0) {
    console.log('\n[2] 强杀子进程，等守护拉起');
    const killed = killHard(childPid);
    ok('子进程被 taskkill /F 杀掉', killed);
    // 等端口重新可用（退避最长 1~2 秒 + 启动时间）
    let h2 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      h2 = await health(2000);
      if (h2) break;
    }
    ok('守护把服务重新拉起来', !!h2);
    ok('重启后 supervised 仍为 true', !!h2 && h2.supervised === true);
    ok('新进程 PID 与旧的不同', h2 && childPidOf(wd.pid) !== childPid, { old: childPid, now: childPidOf(wd.pid) });

    console.log('\n[3] 硬切之后状态文件仍可解析');
    const sf = path.join(DATA_DIR, 'state.json');
    ok('state.json 存在', fs.existsSync(sf));
    let parseOk = false;
    try {
      const j = JSON.parse(fs.readFileSync(sf, 'utf8'));
      parseOk = Array.isArray(j.tasks);
    } catch { parseOk = false; }
    ok('state.json 是合法 JSON 且含 tasks', parseOk);
    ok('没有残留 .tmp 半截文件', !fs.existsSync(sf + '.tmp'));

    console.log('\n[4] 重启事件有记录');
    const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    ok('watchdog.log 记到重启', /子进程退出.*重启/.test(log), log.slice(-300));
  }

  try { wd.kill(); } catch { /* 已退出 */ }
  await sleep(1200);
  try { if (childPid) killHard(childPid); } catch { /* ignore */ }

  console.log('\n' + (failures === 0 ? '全部通过' : '失败 ' + failures + ' 项'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('用例执行异常:', (e && e.stack) || e);
  process.exit(1);
});
