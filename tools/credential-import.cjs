#!/usr/bin/env node
/*
 * 凭据导入器 —— 把散落在明文文件里的凭据加密写进保险库，然后（可选）就地捣毁明文。
 *
 * 为什么需要它：规范第九条第 1 条禁止凭据落在代码/配置里，但「迁移」和「重新授权」
 * 两个环节总得有个入口把人工拿到的凭据送进保险库。没有这个工具，每次只能靠
 * 临时脚本手搓 set()，而临时脚本经常顺手把值打到终端上 —— 那等于自己制造泄露面。
 *
 * 用法：
 *   node tools/credential-import.cjs                          # 默认从 D:/Temp/cronhub-sms/plaintext-origin 读，只体检不写入
 *   node tools/credential-import.cjs --dir <目录>             # 指定明文来源目录
 *   node tools/credential-import.cjs --apply                  # 真正写入保险库（写入后逐条回读校验）
 *   node tools/credential-import.cjs --apply --shred          # 写入并校验通过后，把来源文件内容就地替换成占位符
 *
 * 安全约定：
 *   1. 全程不打印任何凭据值，只打印键名、长度、校验结果。
 *   2. --shred 只在「全部键回读校验通过」之后执行，避免把唯一副本毁掉。
 *   3. 任何一步失败都以非 0 退出，且不会留下半套写入（先全部校验来源，再统一写入）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const { createVault, SCOPE, redact } = require(path.join(ROOT, 'lib', 'credential-vault'));
const { createAuditLog } = require(path.join(ROOT, 'lib', 'sms-audit'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const APPLY = has('--apply');
const SHRED = has('--shred');
const SRC_DIR = path.resolve(val('--dir', 'D:/Temp/cronhub-sms/plaintext-origin'));

/* ---------------------------------------------------------------- 来源清单 */

/*
 * 文件 → 分区 → {源字段: 保险库键名}
 * config.json 里的 apiUrl / pid / tpl / key 不是秘密（公钥、模板号、接口地址），
 * 继续留在配置里；只有 code / kid / strategyId 属于应用凭据。
 */
const SOURCES = [
  { file: 'config.json', scope: SCOPE.APP, map: { code: 'code', kid: 'kid', strategyId: 'strategyId' } },
  { file: 'auth_info_ydrz.json', scope: SCOPE.LONGTERM, map: { uuid: 'uuid', accessToken: 'accessToken' } },
  { file: 'clawUid.json', scope: SCOPE.LONGTERM, map: { clawUid: 'clawUid' } },
];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 读取状态文件 */

function loadState() {
  const s = readJson(STATE_FILE);
  return s && typeof s === 'object' ? s : {};
}

let state = loadState();
let dirty = false;
let vault = null;
let auditLog = null;

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), 'utf8');
  dirty = false;
}

/*
 * 注意：体检模式不建保险库。createVault 在没有密钥时会顺手生成一把新密钥写到
 * data/.secrets/ —— 一个「只看不动」的命令不该改变磁盘状态。
 */
function openVault() {
  if (vault) return vault;
  /*
   * 必须接审计：规范第八节要求凭据的写入/轮换/吊销全部留痕。
   * 早期版本这里漏了 audit，结果「写库成功了但审计里一条没有」——
   * 那等于事后完全无法回答「这批凭据是什么时候、被谁导进来的」。
   */
  auditLog = createAuditLog({ dataDir: DATA_DIR, onLog: () => {} });
  vault = createVault({
    dataDir: DATA_DIR,
    getStore: () => state.credentialVault,
    putStore: (v) => {
      state.credentialVault = v;
      dirty = true;
    },
    audit: (e) => auditLog.append(e),
    onLog: () => {},
  });
  return vault;
}

/* ---------------------------------------------------------------- 第一步：盘点来源 */

const found = []; // {scope, key, value, file}
const missingFiles = [];
const seen = new Set();

for (const src of SOURCES) {
  const p = path.join(SRC_DIR, src.file);
  if (!fs.existsSync(p)) {
    missingFiles.push(src.file);
    continue;
  }
  const j = readJson(p);
  if (!j) {
    missingFiles.push(src.file + '（不是合法 JSON）');
    continue;
  }
  for (const [from, to] of Object.entries(src.map)) {
    const v = j[from];
    if (v === undefined || v === null || String(v) === '') continue;
    found.push({ scope: src.scope, key: to, value: String(v), file: src.file });
    seen.add(src.scope + '/' + to);
  }
}

console.log('\n  凭据导入器' + (APPLY ? ' · 写入模式' : ' · 体检模式（不写入，加 --apply 才落库）'));
console.log('  来源目录：' + SRC_DIR);
console.log('  保险库  ：' + STATE_FILE);
if (APPLY) {
  const m = openVault().meta;
  console.log('  主密钥  ：' + (m.keySource === 'env'
    ? '环境变量 CRONHUB_SMS_KEY'
    : m.keySource === 'file'
      ? '文件 ' + m.keyPath
      : m.keySource === 'generated'
        ? '本次新生成 ' + (m.keyPath || 'data/.secrets/') + '（请立即备份，丢了就再也解不开）'
        : '缺失（不可写入）'));
}

if (missingFiles.length) {
  console.log('\n  跳过的文件：' + missingFiles.join('、'));
}

if (!found.length) {
  console.log('\n  ❌ 来源里没有找到任何可导入的凭据。请确认 --dir 指向的目录里含 config.json / auth_info_ydrz.json / clawUid.json。\n');
  process.exit(2);
}

console.log('\n  待导入（' + found.length + ' 项，仅显示键名与长度）：');
for (const f of found) {
  console.log('    ' + (f.scope + '/' + f.key).padEnd(26) + ' ← ' + f.file.padEnd(22) + ' 长度 ' + String(f.value.length).padStart(3) + '  ' + redact(f.value));
}

/* ---------------------------------------------------------------- 第二步：写库 */

if (!APPLY) {
  console.log('\n  体检模式结束，未写入任何内容。确认无误后加 --apply 执行写入。\n');
  process.exit(0);
}

const v = openVault();
const h = v.health();
if (!h.ok) {
  console.log('\n  ❌ 保险库不可用：' + h.message);
  console.log('     先跑 node tools/credential-keygen.cjs 生成主密钥，再回来导入。\n');
  process.exit(3);
}

for (const f of found) {
  const sc = v.scope(f.scope);
  const r = sc.set(f.key, f.value);
  if (!r || r.ok !== true) {
    console.log('\n  ❌ 写入失败：' + f.scope + '/' + f.key + ' → ' + (r && (r.error || r.message)));
    process.exit(4);
  }
}

if (dirty) saveState();

/* ---------------------------------------------------------------- 第三步：回读校验 */

console.log('\n  回读校验：');
let bad = 0;
for (const f of found) {
  const r = v.scope(f.scope).get(f.key);
  const ok = r.ok && r.value && sha(r.value) === sha(f.value);
  if (!ok) bad += 1;
  console.log('    ' + (ok ? '✅' : '❌') + ' ' + (f.scope + '/' + f.key).padEnd(26) + ' 指纹 ' + sha(f.value).slice(0, 12));
}

if (bad) {
  console.log('\n  ❌ ' + bad + ' 项回读不一致，已中止（不会动来源文件）。请检查主密钥是否稳定。\n');
  process.exit(5);
}

/* 汇总留痕：谁在什么时候往保险库里放了几个键（不记值） */
if (auditLog) {
  auditLog.append({
    event: 'credential_imported',
    source: 'credential-import.cjs',
    entries_written: found.length,
    scopes: [...new Set(found.map((f) => f.scope))].join(','),
    key_names: found.map((f) => f.key).join(','),
    source_dir: path.basename(SRC_DIR),
    shredded: SHRED,
  });
}

console.log('\n  ✅ ' + found.length + ' 项全部写入并校验通过。审核：' + path.join(DATA_DIR, 'audit'));

/* ---------------------------------------------------------------- 第四步：捣毁明文（可选） */

if (SHRED) {
  const groups = new Map();
  for (const f of found) {
    if (!groups.has(f.file)) groups.set(f.file, []);
    groups.get(f.file).push(f);
  }
  console.log('\n  捣毁来源明文：');
  for (const [file, items] of groups) {
    const p = path.join(SRC_DIR, file);
    const j = readJson(p) || {};
    for (const it of items) {
      // 用固定长度占位符覆盖，保证长度不泄露
      const src = SOURCES.find((s) => s.file === file);
      const from = Object.keys(src.map).find((k) => src.map[k] === it.key);
      if (from) j[from] = '[moved-to-vault]';
    }
    fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
    console.log('    ✅ ' + file + ' 中 ' + items.length + ' 个字段已替换为 [moved-to-vault]');
  }
} else if (found.length) {
  console.log('  提示：来源目录里仍是明文。确认线上发送正常后，加 --shred 重跑一次即可就地清除（或自行转移后删除）。');
}

console.log('');
