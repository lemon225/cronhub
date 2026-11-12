/*
 * CronHub 进程守护（第 17 批）
 *
 * 为什么需要它：平台会不会在进程崩溃后自动拉起，我们无法确认。没有守护时，
 * 一次未捕获异常就是站点永久挂掉；有守护则最差也能在几秒内自愈。
 *
 * 用法：`npm start`（package.json 已把 start 指到这里）；
 * 想跳过守护直接跑服务端，用 `npm run start:bare`。
 *
 * 设计要点：
 *   - 子进程环境里注入 CRONHUB_SUPERVISED=1，server.js 据此决定「异常后退出」而不是「带病续跑」；
 *   - 退避重启：1s → 2s → 5s → 10s → 30s 封顶；活过 60 秒就认为稳定，重置退避；
 *   - 收到 SIGTERM/SIGINT 时先转给子进程，给它最多 8 秒优雅收尾（落盘 + 等在途任务），
 *     超时才强杀，然后自己也退出，绝不把子进程留成孤儿；
 *   - 重启事实写进 DATA_DIR/watchdog.log（超过 200KB 自动截断），便于事后判断
 *     「是崩过还是平台重启过」。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'server.js');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const LOG_MAX = 200 * 1024;

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const STABLE_MS = 60 * 1000;

let child = null;
let restarts = 0;
let backoffIdx = 0;
let startedAt = 0;
let stopping = false;

function stamp() {
  return new Date().toISOString();
}

function note(line) {
  const text = '[' + stamp() + '] ' + line;
  console.log('[watchdog] ' + line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX) fs.truncateSync(LOG_FILE, 0);
    } catch { /* 文件还没有 */ }
    fs.appendFileSync(LOG_FILE, text + '\n', 'utf8');
  } catch { /* 日志写不进去不影响守护 */ }
}

function startChild() {
  startedAt = Date.now();
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, CRONHUB_SUPERVISED: '1' },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    const lived = Date.now() - startedAt;
    child = null;
    if (stopping) {
      note('子进程已退出（' + (signal || 'code ' + code) + '），守护一同结束');
      process.exit(0);
      return;
    }
    // 活过 60 秒说明不是启动即崩，重置退避，避免一次偶发崩溃留下 30 秒的启动延迟
    if (lived > STABLE_MS) backoffIdx = 0;
    const wait = BACKOFF[Math.min(backoffIdx, BACKOFF.length - 1)];
    backoffIdx += 1;
    restarts += 1;
    note('子进程退出（' + (signal || 'code ' + code) + '，存活 ' + Math.round(lived / 1000) + 's），'
      + wait + 'ms 后第 ' + restarts + ' 次重启');
    setTimeout(() => {
      if (stopping) { process.exit(0); return; }
      startChild();
    }, wait);
  });

  child.on('error', (e) => {
    note('子进程启动失败：' + (e && e.message));
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  note('收到 ' + signal + '，转给子进程等待优雅退出');
  if (!child) process.exit(0);
  try { child.kill(signal); } catch { /* 已退出 */ }
  // 优雅窗口 8 秒（服务端自己最多等 5 秒在途任务），超时强杀
  const timer = setTimeout(() => {
    note('子进程 8 秒内未退出，强制终止');
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    process.exit(0);
  }, 8000);
  if (timer.unref) timer.unref();
  child.once('exit', () => {
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 守护自身出问题也别静默死掉：记一笔后让子进程照常跑（此时已无法再守护）
process.on('uncaughtException', (e) => {
  note('守护自身未捕获异常：' + (e && e.message));
});

note('守护启动（node ' + process.version + '，数据目录 ' + DATA_DIR + '）');
startChild();
