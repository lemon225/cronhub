/*
 * 第二十六批之二 · 请求体跨块截断中文
 *
 * 线上改天气提示词时发现：2.3KB 的中文提示词存进库后，某个「，」变成了
 * 「\uFFFD\uFFFD\uFFFD」。根因是 readBody 里 `raw += c`（c 是 Buffer）逐块调
 * toString()，多字节字符正好跨在两个 TCP 块中间就被切成半个字符。
 * 用户看到的是「提示词莫名其妙缺字」，AI 读到的是替换符。
 *
 * 这里用 EventEmitter 模拟 req，把同一个汉字拆到两个 data 块里。
 * 跑法：node tests/body-utf8.test.cjs
 */
'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let failures = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

const a = SRC.indexOf('function readBody(');
const b = SRC.indexOf('function publicState(', a);
if (a < 0 || b < 0) throw new Error('取 readBody 失败');
const readBody = new Function(SRC.slice(a, b) + '\nreturn readBody;')();

/** 把字节串按给定切点分块，逐个 emit 到假 req。 */
function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroy = () => {};
  setImmediate(() => {
    for (const c of chunks) req.emit('data', c);
    req.emit('end');
  });
  return req;
}
const splitEvery = (buf, n) => {
  const out = [];
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n));
  return out;
};

(async () => {
  console.log('\n[1] 多字节字符跨块不被截断');
  const payload = JSON.stringify({ name: '天气预报·三甲集', note: '字段时，只输出以下 3 行' });
  const buf = Buffer.from(payload, 'utf8');
  // 逐字节切：每个 3 字节汉字都必然跨块，最坏情况
  const byteByByte = await readBody(fakeReq(splitEvery(buf, 1)));
  ok('先生成内容逐字节分块后完全一致', JSON.stringify(byteByByte) === payload, byteByByte);
  ok('中文没有出现替换符', !JSON.stringify(byteByByte).includes('\uFFFD'));

  console.log('\n[2] 常规分块与空体');
  const big = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ name: `任务${i}·三甲集` })) });
  const chunked = await readBody(fakeReq(splitEvery(Buffer.from(big, 'utf8'), 7)));
  ok('7 字节分块的大 body 完整还原', JSON.stringify(chunked) === big);
  ok('空 body 返回空对象', JSON.stringify(await readBody(fakeReq([]))) === '{}');

  console.log('\n[3] 非法 JSON 仍报错');
  let err = null;
  try { await readBody(fakeReq([Buffer.from('{bad', 'utf8')])); } catch (e) { err = e; }
  ok('非法 JSON 抛「请求体不是合法 JSON」', err && /请求体不是合法 JSON/.test(err.message), err && err.message);

  console.log('\n' + (failures ? `失败 ${failures} 项` : '全部通过'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
