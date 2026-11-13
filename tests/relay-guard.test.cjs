/*
 * 第二十批之一 · 中继 /__guard 的判据（假警报回归）
 *
 * 起因：线上双双报「陪护体检失败」，但同一时间短信发得出去、上游探针 ok:true。
 * 根因是判据取了「上游通 且 站点通」，而站点腿（CF 边缘 → 国内实例）冷启动常越过
 * 12s 被自己 abort —— 于是上游明明通，整条体检却回 502，连续 2 次就推假警报。
 *
 * 这里把 fetch 打桩，不需要真的连 Cloudflare：
 *   A 上游 403 + 站点 abort  → ok:true、channelOk:true、siteOk:false、HTTP 200、verdict=channel-ok-site-slow
 *   B 上游连不上            → ok:false、channelOk:false、HTTP 502、verdict=upstream-down
 *   C 无密钥                → 403
 *   D 只配了环境变量密钥      → 不依赖源码里的内置密钥也能通过
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'relay', '_worker.js');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/** 把中继源码复制成 .mjs 再 import（仓库里它不是 ESM 包，直接 import 会按 CJS 解析） */
async function loadWorker() {
  const tmp = path.join(os.tmpdir(), 'relay-guard-' + process.pid + '-' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, fs.readFileSync(SRC, 'utf8'), 'utf8');
  const mod = await import('file://' + tmp.replace(/\\/g, '/'));
  return mod.default;
}

/** 打桩：upstream 回 403；site 抛 AbortError（模拟站点腿超时） */
function stubFetch({ siteAborts = true, upstreamDown = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/health')) {
      if (siteAborts) {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      }
      return new Response(JSON.stringify({ ok: true, build: 'stub-build' }), { status: 200 });
    }
    if (upstreamDown) {
      const e = new Error('Client network socket disconnected before secure TLS connection was established');
      e.name = 'TypeError';
      throw e;
    }
    return new Response('forbidden', { status: 403 });
  };
}

(async () => {
  const worker = await loadWorker();
  const ENV = { RELAY_KEYS: 'tester:abc123def456', SITE_HEALTH_URL: 'https://cronhub.example/api/health' };
  const guardReq = () => new Request('https://relay.example/__guard?key=abc123def456');

  // A 上游通、站点超时 —— 这是线上真实发生的组合
  stubFetch({ siteAborts: true });
  let r = await worker.fetch(guardReq(), ENV);
  let b = await r.json();
  ok('站点腿超时不再判失败（HTTP 200）', r.status === 200, { status: r.status, body: b });
  ok('ok 只看上游腿', b.ok === true && b.channelOk === true, b);
  ok('站点腿单列 siteOk:false', b.siteOk === false, b.siteOk);
  ok('verdict 标注 channel-ok-site-slow', b.verdict === 'channel-ok-site-slow', b.verdict);
  ok('上游结果原样带回（403 属探针预期）', b.upstream && b.upstream.ok === true && b.upstream.status === 403, b.upstream);
  ok('版本已升到 relay-v4', b.ver === 'relay-v4', b.ver);

  // B 上游不通 —— 这才是该报的故障
  stubFetch({ upstreamDown: true });
  r = await worker.fetch(guardReq(), ENV);
  b = await r.json();
  ok('上游不通回 502', r.status === 502, r.status);
  ok('ok/channelOk 均 false', b.ok === false && b.channelOk === false, b);
  ok('verdict 标注 upstream-down', b.verdict === 'upstream-down', b.verdict);
  ok('带上上游错误原因', !!b.upstream && !!b.upstream.error, b.upstream);

  // C 无密钥
  r = await worker.fetch(new Request('https://relay.example/__guard'), ENV);
  ok('无密钥一律 403', r.status === 403, r.status);

  // D 环境变量密钥优先（不靠源码内置的那把）
  stubFetch({ siteAborts: true });
  r = await worker.fetch(new Request('https://relay.example/__guard', {
    headers: { 'x-relay-secret': 'abc123def456' },
  }), ENV);
  ok('header 密钥可用', r.status === 200, r.status);

  console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
