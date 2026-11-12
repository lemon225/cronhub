#!/usr/bin/env node
'use strict';
/**
 * 凭据泄露应急处置（Runbook 的可执行版本）
 * ===========================================================================
 * 规范第六节「处置顺序（禁止"先观察一下"）」的五步，这里实现前四步，
 * 第五步（重新授权）必须由人扫码完成，脚本只给出指引。
 *
 * 用法：
 *   node tools/credential-emergency.cjs                      只诊断 + 打印处置计划（不动任何数据）
 *   node tools/credential-emergency.cjs --scan               同上，但有高危发现时以 1 退出（CI 可用）
 *   node tools/credential-emergency.cjs --apply              真正执行：吊销 + 熔断 24 小时（先停服务！）
 *   node tools/credential-emergency.cjs --apply --reason 截图外泄
 *   node tools/credential-emergency.cjs --apply --destroy-key   连主密钥一起作废（更彻底）
 *
 * 为什么默认不动数据：
 *   应急脚本本身也可能被误触。默认只读，是唯一能避免"手抖把线上短信彻底停掉"的设计。
 *
 * 执行顺序（与规范一致）：
 *   1. 吊销：清空保险库 + 本地凭据副本，状态置 REVOKED
 *   2. 熔断 24 小时：阻断一切出站请求（不是 30 分钟，是最高一档）
 *   3. 排查泄露面：仓库 / 镜像 / 备份 / 日志 / 临时目录
 *   4. 重新授权：走一条未被污染的网络出口（人工）
 *   5. 事后补一轮轮换并通知相关方
 *
 * 注意：本脚本不发任何网络请求、不删除审计日志、不尝试自行重新授权。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAuditLog } = require('../lib/sms-audit');
const { KEY_ENV } = require('../lib/credential-vault');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KEY_FILE = path.join(DATA_DIR, '.secrets', 'sms-master.key');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has('--apply');
const SCAN_ONLY = has('--scan');
const DESTROY_KEY = has('--destroy-key');
const CIRCUIT_24H = 24 * 3600e3;

const optVal = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const REASON = String(optVal('--reason', 'manual_emergency')).slice(0, 120);

const line = (s = '') => console.log(s);
const head = (s) => { line(''); line('── ' + s + ' ' + '─'.repeat(Math.max(0, 62 - s.length))); };

/* ------------------------------------------------------------ 读状态 */

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

/** 扫描"凭据可能外泄"的地方，只报路径与命中数，不打印值 */
function scanLeakSurfaces() {
  const surfaces = [];

  // 1) 项目源码里是否有明文
  const patterns = [
    { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: '带前缀 Key', re: /\b(?:ak|sk|pk)_[A-Za-z0-9]{16,}/ },
    { name: '长令牌赋值', re: /(?:secret|password|access_token|refresh_token)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{24,}['"]/i },
    { name: '11 位手机号', re: /\b1[3-9]\d{9}\b/ },
    { name: '密文段出现在产物里', re: /v1:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:/ },
  ];
  const scan = (dir, depth = 0) => {
    if (depth > 6) return;
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      /* tools / 验收脚本里本来就有假凭据与假手机号（那是测试数据），不算泄露面 */
      if (['node_modules', '.git', 'data', 'tools', '.secrets', '.sms-runtime'].includes(e.name)) continue;
      if (/^verify-/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p, depth + 1); continue; }
      if (!/\.(js|cjs|mjs|json|html|md|yml|yaml|sh|ps1|env|txt)$/i.test(e.name)) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const pat of patterns) {
        if (pat.re.test(text)) {
          surfaces.push({ lvl: 'HIGH', at: path.relative(ROOT, p), kind: pat.name });
          break;
        }
      }
    }
  };
  scan(ROOT, 0);

  // 2) 明文凭据原件是否还在 lib/sms
  for (const f of ['auth_info_ydrz.json', 'clawUid.json']) {
    const p = path.join(ROOT, 'lib', 'sms', f);
    if (fs.existsSync(p)) surfaces.push({ lvl: 'HIGH', at: path.relative(ROOT, p), kind: '明文凭据文件仍在仓库' });
  }

  // 3) 临时目录里可能残留的凭据备份（迁移时移过去的原件）
  for (const t of [os.tmpdir(), DATA_DIR]) {
    try {
      for (const n of fs.readdirSync(t)) {
        if (/^cronhub-credential-backup-/.test(n)) {
          surfaces.push({ lvl: 'HIGH', at: path.join(t, n), kind: '迁移备份目录（含明文原件）' });
        }
      }
    } catch { /* 读不到就算了 */ }
  }

  // 4) 一次性凭据沙箱目录是否被即时销毁
  const rt = path.join(DATA_DIR, '.sms-runtime');
  try {
    const left = fs.readdirSync(rt);
    if (left.length) {
      surfaces.push({ lvl: 'HIGH', at: path.relative(ROOT, rt) || '.sms-runtime', kind: '一次性凭据目录有残留（' + left.length + ' 个）' });
    }
  } catch { /* 正常：目录不存在 */ }

  // 5) 审计日志：确认它不含凭据值（有的话是审计模块的 bug）
  try {
    for (const n of fs.readdirSync(AUDIT_DIR)) {
      const p = path.join(AUDIT_DIR, n);
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (/\b(?:ak|sk)_[A-Za-z0-9]{16,}/.test(text) || /v1:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:/.test(text)) {
        surfaces.push({ lvl: 'CRIT', at: path.relative(ROOT, p), kind: '审计日志里出现凭据/密文' });
      }
    }
  } catch { /* 没有审计目录 */ }

  // 6) .gitignore 是否挡住了 data/ 与密钥
  const gi = path.join(ROOT, '.gitignore');
  if (fs.existsSync(gi)) {
    const txt = fs.readFileSync(gi, 'utf8');
    if (!/^\s*data\/?\s*$/m.test(txt)) surfaces.push({ lvl: 'MED', at: '.gitignore', kind: '未忽略 data/（密文可能被提交）' });
    if (!/secrets|\.key/i.test(txt)) surfaces.push({ lvl: 'MED', at: '.gitignore', kind: '未忽略 .secrets / *.key（主密钥可能被提交）' });
  }

  return surfaces;
}

/* ------------------------------------------------------------ 审计 */

function auditAppend(event) {
  /*
   * 必须复用 lib/sms-audit.js 写入，不能在这里另拼一套。
   * 审计行带哈希链（h = sha256(prev + body)）：格式或算法只要有一处不同，
   * 整条链就会断，「篡改可检测」这个性质立刻归零 —— 应急时刻恰恰最需要它。
   */
  try {
    const audit = createAuditLog({ dataDir: DATA_DIR, onLog: () => {} });
    const r = audit.append({ source: 'emergency_script', ...event });
    return r.ok ? { ok: true, file: path.join(DATA_DIR, 'audit') } : { ok: false, error: r.reason };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/* ------------------------------------------------------------ 主流程 */

function main() {
  line('凭据泄露应急处置  ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  line('数据目录：' + DATA_DIR);
  line('原因：' + REASON);

  const state = readState();
  if (!state) {
    line('');
    line('⚠ 读不到 ' + STATE_FILE);
    line('  服务可能还没跑过，或 DATA_DIR 指向别处。');
    line('  若线上是容器部署，请在容器内执行本脚本（或直接调 /api/sms/revoke）。');
  }

  const cred = (state && state.smsCredential) || {};
  head('1. 当前状态');
  line('  生命周期状态：' + (cred.state || '(未知)'));
  line('  熔断截止：' + (Number(cred.circuitOpenUntil) > Date.now()
    ? new Date(cred.circuitOpenUntil).toLocaleString('zh-CN', { hour12: false }) : '未熔断'));
  line('  今日：刷新 ' + (cred.refreshCountToday || 0) + ' · 发送 ' + (cred.sendCountToday || 0) + ' · 授权 ' + (cred.authRequestToday || 0));
  const scopes = (state && state.credentialVault && state.credentialVault.scopes) || {};
  const counts = Object.entries(scopes).map(([k, v]) => k + '=' + Object.keys((v && v.entries) || {}).length);
  line('  保险库：' + (counts.length ? counts.join(' · ') : '(空)'));

  head('2. 泄露面排查（只报路径，不打印值）');
  const surfaces = scanLeakSurfaces();
  if (!surfaces.length) line('  项目目录内未发现明文凭据特征。');
  else for (const s of surfaces) line('  [' + s.lvl + '] ' + s.at + '  ← ' + s.kind);
  line('  另外请人工确认（脚本看不到的）：');
  line('    · 代码托管历史（git log -p 里搜 token）');
  line('    · 镜像层 / CI 变量 / 截图 / 工单附件');
  line('    · 备份介质是否与主密钥放在同一处');

  const critical = surfaces.some((s) => s.lvl === 'CRIT' || s.lvl === 'HIGH');

  head('3. 处置计划');
  line('  ① 吊销：清空保险库三区 + 本地凭据副本，状态 → REVOKED');
  line('  ② 熔断：24 小时（最高一档），期间零出站请求');
  line('  ③ 排查：见上一节，重点是仓库历史与备份');
  line('  ④ 重新授权：用一台干净设备、一条未被污染的网络出口扫码');
  line('  ⑤ 收尾：补一轮密钥轮换 + 通知相关方 + 复查审计日志');

  if (!APPLY) {
    line('');
    if (SCAN_ONLY) {
      line(critical ? '扫描结束：存在高危项，建议立即处置。' : '扫描结束：未发现高危项。');
      process.exit(critical ? 1 : 0);
    }
    line('当前是「只看不改」模式。确认要执行 ① ② 请加 --apply（先停服务，否则服务会在内存里覆盖回去）。');
    return;
  }

  /* ---- 真正执行 ---- */
  if (!state) {
    line('');
    line('✗ 没有 state.json，无法执行。');
    if (DESTROY_KEY) destroyKey();
    process.exit(1);
  }

  /* 先备份：应急也要留退路 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = STATE_FILE + '.bak-' + stamp;
  try {
    fs.copyFileSync(STATE_FILE, backup);
    line('');
    line('已备份原 state：' + backup);
  } catch (e) {
    line('');
    line('✗ 备份失败（' + (e.code || e.message) + '），为安全起见中止。');
    process.exit(1);
  }

  const s = state.smsCredential || (state.smsCredential = {});
  s.state = 'REVOKED';
  s.revokedAt = Date.now();
  s.accessExpiresAt = 0;
  s.refreshExpiresAt = 0;
  s.circuitOpenUntil = Date.now() + CIRCUIT_24H;
  s.circuitLevel = 4;
  s.lastCircuitAt = Date.now();
  s.lastDecision = { event: 'token_decision', action: 'revoke', reason: 'emergency_leak', at: Date.now() };
  delete s.accessTokenEnc; // 老版本残留字段

  /* 清空保险库三区：密文留着也没意义，且留着就还有被解出的可能 */
  let wiped = 0;
  for (const [, v] of Object.entries(scopes)) {
    const n = Object.keys((v && v.entries) || {}).length;
    if (v) { v.entries = {}; v.updatedAt = Date.now(); }
    wiped += n;
  }

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), 'utf8');
  } catch (e) {
    line('✗ 写回失败：' + (e.code || e.message));
    process.exit(1);
  }

  line('');
  line('✓ 已执行：状态 REVOKED · 熔断 24 小时 · 清除 ' + wiped + ' 条已存凭据');

  /* 写审计：吊销动作必须留痕，且要能证明是"谁在什么时候因为什么触发的" */
  const ar = auditAppend({
    event: 'emergency_revoke',
    reason: REASON,
    cleared: wiped,
    findings: surfaces.length,
    critical_findings: surfaces.filter((x) => x.lvl === 'CRIT').length,
    key_destroyed: DESTROY_KEY,
  });
  line(ar.ok ? '✓ 已写入审计：' + ar.file : '! 审计写入失败：' + ar.error);

  if (DESTROY_KEY) destroyKey();

  line('');
  line('接下来必须人工完成：');
  line('  1) 现在重新授权也发不出（熔断期禁止）—— 这是有意的，先排查完再恢复');
  line('  2) 排查完：停服务 → 手动把 circuitOpenUntil 改成 0（或等 24 小时）');
  line('  3) 到移动侧作废旧授权（本脚本只能清本地副本）');
  line('  4) 管理员重新扫码授权，走干净网络');
  line('  5) 换主密钥（node tools/credential-keygen.cjs --file <项目外路径>），旧密钥作废');
  line('  6) 通知收到过短信的各方：期间短信可能异常');
}

/**
 * 销毁主密钥。
 * 关键点：密钥可能根本不在这个文件里 —— 环境变量或 CRONHUB_SMS_KEY_FILE 指向别处时，
 * 删本地文件纯属自我安慰，必须明确告诉人"你真正要作废的是哪个"。
 */
function destroyKey() {
  head('4. 作废主密钥');
  const fromEnv = !!String(process.env[KEY_ENV] || '').trim();
  const keyFileEnv = String(process.env.CRONHUB_SMS_KEY_FILE || '').trim();
  if (fromEnv) {
    line('  ⚠ 主密钥来自环境变量 ' + KEY_ENV + '，删本地文件无效。');
    line('    请在部署平台（或 shell 配置）里删除该变量并滚动重启，旧密钥才算作废。');
    return;
  }
  const target = keyFileEnv || KEY_FILE;
  if (!fs.existsSync(target)) {
    line('  - 找不到密钥文件（' + target + '），可能已被销毁。');
    return;
  }
  /*
   * 先复制一份到 .bak 再删：万一这是"误判泄露"，至少还有 24 小时熔断期可以回滚。
   * 真正不可逆的销毁由人工确认后自己删 .bak。
   */
  const bak = target + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.copyFileSync(target, bak);
    fs.unlinkSync(target);
    line('  ✓ 主密钥已作废：' + target);
    line('    备份（24h 熔断期内可回滚）：' + bak);
    line('    确认无误后请手工删除该 .bak —— 留着它等于留着一把旧钥匙。');
  } catch (e) {
    line('  ✗ 密钥作废失败：' + (e.code || e.message));
  }
}

main();
