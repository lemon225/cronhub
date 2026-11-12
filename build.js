'use strict';
/**
 * 构建脚本：用 esbuild 把 public/app.js 压缩成 public/app.min.js。
 * 服务端启动时自动优先回 /app.js 压缩内容（URL、版本号机制不变）。
 * 用法：node build.js（本机需 NODE_PATH 指向 esbuild 所在依赖目录）
 */
const path = require('node:path');
const fs = require('node:fs');

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('未找到 esbuild：请设置 NODE_PATH 后重试，例如 NODE_PATH=<托管依赖目录>/node_modules node build.js');
  process.exit(1);
}

const src = path.join(__dirname, 'public', 'app.js');
const out = path.join(__dirname, 'public', 'app.min.js');

esbuild.buildSync({
  entryPoints: [src],
  outfile: out,
  minify: true,
  bundle: false,
  charset: 'utf8',
  target: ['es2020'],
  legalComments: 'none',
});

const a = fs.statSync(src).size;
const b = fs.statSync(out).size;
/*
 * 产物与源码对齐 mtime：server.js 启动时用「app.js 是否比 app.min.js 新」判断
 * 是否忘了构建。刚构建完若产物时间戳反而更早会误报；部署打包保留 mtime 时也靠它保持安静。
 * 真正忘了 build 时 app.js 会被重新写入、mtime 变新，告警仍然会触发。
 */
try {
  const st = fs.statSync(src);
  fs.utimesSync(out, st.atime, st.mtime);
} catch { }
console.log(`app.js     ${a} bytes`);
console.log(`app.min.js ${b} bytes  (-${Math.round((1 - b / a) * 100)}%)`);
