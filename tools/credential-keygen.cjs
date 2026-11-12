#!/usr/bin/env node
'use strict';
/**
 * 主密钥生成 / 检查工具
 * ===========================================================================
 * 规范交付项：「说明凭据的加密方式、密钥来源、恢复方式」——
 * 这个脚本就是"密钥来源"和"恢复方式"的可执行版本。
 *
 * 用法：
 *   node tools/credential-keygen.cjs                 生成新密钥到 data/.secrets/sms-master.key
 *   node tools/credential-keygen.cjs --print         只打印 64 位 hex，不落盘（放环境变量用）
 *   node tools/credential-keygen.cjs --file D:\safe\sms.key   写到项目目录之外（推荐）
 *   node tools/credential-keygen.cjs --check         检查当前生效的密钥来源与健康状态
 *
 * 铁律：
 *   - 密钥文件权限 600，属主为服务账号
 *   - 密钥不得进 git / 镜像层 / 聊天记录 / 工单截图
 *   - 换密钥 = 旧密文全部报废，必须先把旧密钥备份；本工具永不覆盖已存在的密钥
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KEY_BYTES = 32;
const DEFAULT_DIR = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'), '.secrets');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'sms-master.key');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function check() {
  delete require.cache[require.resolve('../lib/credential-vault')];
  const { createVault } = require('../lib/credential-vault');
  const store = { v: null };
  const logs = [];
  const v = createVault({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
    getStore: () => store.v,
    putStore: (x) => { store.v = x; },
    onLog: (e) => logs.push(e),
  });
  const h = v.health();
  const meta = v.meta || {};
  console.log('密钥来源：' + (meta.keySource || '(未知)'));
  if (meta.keyPath) console.log('密钥文件：' + meta.keyPath);
  else if (meta.keySource === 'env') console.log('密钥文件：无（来自环境变量 CRONHUB_SMS_KEY）');
  console.log('保险库状态：' + (h.ok ? '正常' : '不可用') + '（' + h.state + '）');
  if (!h.ok) console.log('原因：' + h.message);
  for (const l of logs) console.log('日志[' + l.level + '] ' + l.msg);
  process.exit(h.ok ? 0 : 1);
}

function gen() {
  const hex = crypto.randomBytes(KEY_BYTES).toString('hex');

  if (has('--print')) {
    console.log(hex);
    console.error('\n把它放进环境变量（不要写进任何文件）：');
    console.error('  Windows PowerShell:  $env:CRONHUB_SMS_KEY = "' + hex + '"');
    console.error('  Bash / 容器:         export CRONHUB_SMS_KEY="' + hex + '"');
    return;
  }

  const target = valOf('--file') ? path.resolve(valOf('--file')) : DEFAULT_FILE;
  if (fs.existsSync(target) && !has('--force')) {
    fail('目标已存在，拒绝覆盖：' + target + '\n  换密钥会让已存凭据全部失效。真要覆盖请加 --force，并先备份旧文件。');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  /* wx：已存在就失败。并发首启不会互相覆盖。 */
  fs.writeFileSync(target, Buffer.from(hex, 'hex'), { mode: 0o600, flag: has('--force') ? 'w' : 'wx' });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows NTFS 忽略 POSIX 权限 */ }

  const inProject = target.startsWith(ROOT + path.sep);
  console.log('✓ 已生成主密钥（32 字节 / AES-256）');
  console.log('  文件：' + target);
  console.log('  权限：600' + (inProject ? '' : '（在项目目录之外 —— 符合「密钥不与数据同处」）'));
  console.log('');
  console.log('接下来：');
  console.log('  1) 备份这个文件到与备份介质物理分离的地方（U 盘 / 密码管理器），丢了就解不出任何已存凭据');
  console.log('  2) 用环境变量指定它（推荐，路径不写死）：');
  console.log('       CRONHUB_SMS_KEY_FILE=' + target);
  if (inProject) {
    console.log('  3) ⚠ 它现在在项目目录内。单容器部署时这是妥协方案；');
    console.log('     能做的话请加 --file 指到项目外的独立卷，再配 CRONHUB_SMS_KEY_FILE。');
  }
}

if (has('--check')) check();
else if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
} else gen();
