/*
 * 第二十批之二 · 子进程发送预算（重复短信回归）
 *
 * 起因：父进程 execTimeout 与子进程单次超时都是 30s，子进程还没轮到第 2 次重试就被 kill；
 * 更麻烦的是「网关已受理、只是回包慢」时，父进程超时 → 任务判失败 → 下一轮再发一遍，
 * 用户会收到两条一样的短信。
 *
 * 本用例用一个「接了 TCP 但不回 TLS」的本地服务器，精确造出「发出去了才超时」：
 *   A 已建连后超时（connectMs > 0）→ 只跑 1 次尝试、打 [停止]、不再重试
 *   B 连接阶段就失败（端口拒绝）    → 仍按 3 次重试，证明没有把正常重试一起关掉
 */
'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'lib', 'sms', 'send.cjs');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function runSend(env, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT, '预算测试', '--raw', '--channel', 'cronhub', '--token-stdin'], {
      cwd: path.dirname(SCRIPT),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end('test-token');
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ out, ms: Date.now() - t0 });
    });
  });
}

(async () => {
  // 「接了但不回话」的服务器：TLS 握手永远等不到，正好模拟上游受理后不回包
  const silent = net.createServer(() => { /* 故意什么都不做 */ });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const port = silent.address().port;

  // A：已建连后超时，预算 6s → 单次超时被收缩到 4.5s，第一次失败后预算不够就停
  const a = await runSend({
    FIVEG_API_URL: `https://127.0.0.1:${port}/send`,
    CRONHUB_SMS_BUDGET_MS: '6000',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  ok('只跑了 1 次尝试', a.out.includes('[重试 1/3]') && !a.out.includes('[重试 2/3]'), a.out.slice(-400));
  ok('单次超时按预算收缩（≤4500ms）', /单次超时 (4[0-4]\d{2}|4500)ms/.test(a.out), a.out.slice(0, 300));
  ok('超时后明确停止重试', a.out.includes('[停止]') && a.out.includes('重复发送'), a.out.slice(-400));
  ok('在预算内收尾（<15s）', a.ms < 15000, { ms: a.ms });

  // B：连接被拒属于「没送出去」，重试必须照旧
  const b = await runSend({
    FIVEG_API_URL: 'https://127.0.0.1:1/send',
    CRONHUB_SMS_BUDGET_MS: '15000',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  ok('连接失败仍然重试到第 2 次', b.out.includes('[重试 2/3]'), b.out.slice(-400));
  ok('连接失败不打「已受理」停止标记', !b.out.includes('[停止]'), b.out.slice(-300));

  silent.close();
  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
