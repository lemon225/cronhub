/*
 * 第二十批之三 · /api/relay/guard 的鉴权与默认返回
 *
 * 改动点：这个端点以前无鉴权，任何人拿到 sharecode 就能反复触发十几秒的出站探测。
 * 现在开着访问控制时必须登录，且 60 秒内重复调用走缓存（force=1 才重测）。
 *
 * 这里只验证两件不依赖中继的事（不连 Cloudflare，离线可跑）：
 *   A 开了访问控制、没登录  → 401
 *   B 没开访问控制、没配中继 → 200 且 configured:false（不会因为没配置就报错）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function startServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-guard-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, CRONHUB_ENV: 'dev', DATA_DIR: dataDir, PORT: String(PORT), ...env },
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, dataDir, getLog: () => log };
}

async function waitReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function stop(s) {
  s.child.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(s.dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

(async () => {
  // A：开了访问控制，未登录
  let s = startServer({ REQUIRE_PASSWORD: '1' });
  let up = await waitReady(20000);
  ok('服务已启动（鉴权模式）', up, s.getLog().slice(-300));
  if (up) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/relay/guard`, { signal: AbortSignal.timeout(10000) });
    ok('未登录时返回 401', r.status === 401, r.status);
    const b = await r.json().catch(() => ({}));
    ok('401 带可读原因', /登录/.test(String(b.error || '')), b);
  }
  await stop(s);

  // B：关闭访问控制，且没配中继
  s = startServer({ REQUIRE_PASSWORD: '' });
  up = await waitReady(20000);
  ok('服务已启动（开放模式）', up, s.getLog().slice(-300));
  if (up) {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/relay/guard`, { signal: AbortSignal.timeout(10000) });
    const b = await r.json().catch(() => ({}));
    ok('开放模式下可调用（200）', r.status === 200, r.status);
    ok('未配置中继时 configured:false', b.configured === false, b);
    ok('未配置时不报错、ok 为 null', b.ok === null && !b.error, b);
  }
  await stop(s);

  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
