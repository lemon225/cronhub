/*
 * 第十九批之一 · HTTP 引擎读响应的正确性（gzip 回归）
 *
 * 起因：线上「天气播报」任务连续 3 次报「响应未读完连接已关闭」，
 * 而真相同一时间用 curl 直连就是一句 401 Unauthorized。
 *
 * 根因：`readBody()` 把底层 res 的 'close' 一律当成断连。但解压是异步的 ——
 * 报文收完、连接归还池子的那一刻，gunzip 还差一个 tick 才吐出最后一块，
 * 于是**只要上游返回 gzip**，任务就 100% 失败，而且真实状态码被这条假故障完全盖住
 * （和风天气走 CDN，即使请求没带 accept-encoding 也无条件压缩）。
 *
 * 这里不测「能不能上网」，全部用本地服务器造响应，保证可以离线复跑：
 *   A gzip 200       → 读到解压后的正文
 *   B gzip 401       → 拿到 401 和正文，而不是「连接已关闭」
 *   C deflate/br 200 → 同样要能解
 *   D 真·半途断连    → 5 秒内失败（不许挂住，挂住会锁死 ticking），且错误信息可读
 *   E 无 content-encoding 的大正文 → 原样返回（不能因为没压缩就漏数据）
 */
const http = require('http');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { request } = require(path.join(ROOT, 'lib', 'http-client.cjs'));

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

const BIG = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i, v: 'x'.repeat(40) })) });

function startServer() {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/gzip') {
      const buf = zlib.gzipSync(JSON.stringify({ ok: true, hello: '压缩过的正文' }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    if (u === '/gzip401') {
      const buf = zlib.gzipSync(JSON.stringify({ error: { status: 401, title: 'Unauthorized', detail: 'Authentication failed' } }));
      res.writeHead(401, { 'content-type': 'application/problem+json', 'content-encoding': 'gzip', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    if (u === '/deflate') {
      const buf = zlib.deflateSync(BIG);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' });
      res.end(buf);
      return;
    }
    if (u === '/br') {
      const buf = zlib.brotliCompressSync(BIG);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
      res.end(buf);
      return;
    }
    if (u === '/plain') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(BIG);
      return;
    }
    if (u === '/truncated') {
      // 声明 gzip + 一个大 content-length，只发一半就掐断：模拟真·中途断连
      const buf = zlib.gzipSync(BIG);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': buf.length });
      res.write(buf.subarray(0, Math.floor(buf.length / 2)));
      setTimeout(() => { try { res.socket.destroy(); } catch { /* noop */ } }, 30);
      return;
    }
    res.writeHead(404).end('nope');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
}

(async () => {
  const { server, base } = await startServer();
  try {
    console.log('\n[1] gzip 200');
    let r = await request(base + '/gzip', { method: 'GET', timeoutMs: 8000 });
    let text = await r.text();
    ok('状态 200', r.status === 200, r.status);
    ok('正文已解压', text.includes('压缩过的正文'), text.slice(0, 80));
    ok('JSON 可解析', (() => { try { return JSON.parse(text).ok === true; } catch { return false; } })());

    console.log('\n[2] gzip 401（真实故障不许被伪装成断连）');
    r = await request(base + '/gzip401', { method: 'GET', timeoutMs: 8000 });
    text = await r.text();
    ok('状态码 401 拿到手', r.status === 401, r.status);
    ok('ok 标记为 false', r.ok === false, r.ok);
    ok('正文含 Unauthorized', /Unauthorized/.test(text), text.slice(0, 80));

    console.log('\n[3] deflate / br 同样要能解');
    r = await request(base + '/deflate', { method: 'GET', timeoutMs: 8000 });
    ok('deflate 正文长度正确', (await r.text()).length === BIG.length);
    r = await request(base + '/br', { method: 'GET', timeoutMs: 8000 });
    ok('brotli 正文长度正确', (await r.text()).length === BIG.length);

    console.log('\n[4] 无压缩的直接放行');
    r = await request(base + '/plain', { method: 'GET', timeoutMs: 8000 });
    ok('plain 正文完整', (await r.text()).length === BIG.length);

    console.log('\n[5] 真·半途断连：必须快速失败，不许挂住');
    const t0 = Date.now();
    let err = null;
    try {
      r = await request(base + '/truncated', { method: 'GET', timeoutMs: 8000 });
      await r.text();
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    ok('抛错而不是返回半截正文', !!err, err && err.message);
    ok('5 秒内结束（不会锁死调度）', ms < 5000, ms);
    ok('错误信息可读', !!err && /未读完|断开|解压|aborted|socket/i.test(err.message), err && err.message);
  } finally {
    server.close();
  }

  console.log('\n────────────────────────────────');
  if (failures) {
    console.log('失败 ' + failures + ' 项');
    process.exit(1);
  }
  console.log('全部通过');
})();
