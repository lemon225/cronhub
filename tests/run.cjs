/*
 * 一键跑全部用例：npm test
 *
 * 为什么要有它：以前每批验收脚本都写在 D:\Temp，那个目录每天 23:00 被清，
 * 五次回归的证据全是消耗品 —— 下次改同一处没有任何可复跑的基线。
 * 现在用例跟代码住在一起，改完就能证明「没坏」。
 *
 * 约定：tests/*.test.cjs，退出码 0 = 通过。每个子进程独立跑，
 * 一个用例崩了不影响后面的，最后统一汇总。
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.test.cjs'))
  .sort();

if (!files.length) {
  console.error('tests/ 下没有 *.test.cjs');
  process.exit(1);
}

const failed = [];
const t0 = Date.now();

for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    stdio: 'inherit',
    env: { ...process.env, CRONHUB_ENV: 'dev', CRONHUB_SMS_REAL: '' },
  });
  if (r.status !== 0) failed.push(f);
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n────────────────────────────────');
if (failed.length) {
  console.log('失败 ' + failed.length + '/' + files.length + '：' + failed.join(', ') + '（用时 ' + sec + 's）');
  process.exit(1);
}
console.log('全部通过：' + files.length + ' 个用例文件（用时 ' + sec + 's）');
