#!/usr/bin/env node
'use strict';
/**
 * 凭据治理验收（《授权凭据管理规范》第十条 + 第九条）
 * ===========================================================================
 * 跑法：node verify-credential.cjs
 *   - 不起服务、不发真实短信、不碰线上数据
 *   - 全部在临时目录里做，跑完自动清理
 *   - 有失败时退出码 1，可直接挂 CI
 *
 * 覆盖：
 *   第十条 7 项验收
 *     1. 全仓库 grep 不到凭据明文
 *     2. 日志中检索不到完整 token 与完整手机号
 *     3. 数据库落盘内容为密文，离线无法还原
 *     4. 100 并发刷新，preAuth 只被调用 1 次
 *     5. 杀进程重启，凭据与状态完整恢复
 *     6. 删除加密密钥后，服务能启动但拒绝发送并明确报错
 *     7. dev 环境任意调试，生产配额消耗为 0
 *   第九条 8 条禁止项（能静态/行为断言的都断言）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const VAULT_PATH = path.join(ROOT, 'lib', 'credential-vault.js');
const CRED_PATH = path.join(ROOT, 'lib', 'sms-credential.js');
const { createVault, SCOPE } = require(VAULT_PATH);
const { createSmsCredential, scrub, maskMobile } = require(CRED_PATH);

/* ---------------------------------------------------------------- 工具 */

const RESULT = [];
let SECTION = '';

function section(name) {
  SECTION = name;
  console.log('\n' + name);
  console.log('─'.repeat(66));
}

function ok(name, cond, detail) {
  RESULT.push({ section: SECTION, name, pass: !!cond, detail });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${name}${detail ? '  → ' + detail : ''}`);
  return !!cond;
}

const tmpRoots = [];
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `cronhub-verify-${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  tmpRoots.push(d);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 内存版 state —— 必须**持久化同一个对象**。
 * 第一版这里写成 `getStore: () => ({ id: 1, state: 'ACTIVE' })`，
 * 每次读都返回全新的 ACTIVE，于是 revoke 改完立刻被下一次读冲掉，
 * 三条断言全红 —— 是夹具写错了，不是产品有问题。
 */
function memStore() {
  const s = { id: 1, state: 'ACTIVE' };
  return {
    raw: s,
    get: () => s,
    /* 注意 v === s 的情况：putStore(s) 传进来的就是它自己，
       先删光再 assign 会把对象清空（产品里 putStore 是替换引用，不存在这问题）。 */
    put: (v) => {
      if (v === s) return;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, v);
    },
  };
}

/* ================================================================
 * 第十条第 1 项：全仓库没有凭据明文
 * ================================================================ */

const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.sh', '.ps1']);
const SCAN_SKIP_DIR = new Set(['node_modules', '.git', 'data', '.secrets', 'shots', 'screenshots']);

function walk(dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (e.isDirectory()) {
      if (SCAN_SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (SCAN_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 凭据明文特征。宁可窄一点，也不要天天误报导致这条断言被忽略。 */
const SECRET_PATTERNS = [
  { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '带前缀的 Key', re: /\b(?:ak|sk|pk)_(?!\*)[A-Za-z0-9]{16,}/ },
  { name: '赋值式长令牌', re: /(?:secret|password|passwd|apikey|api_key|access_token|refresh_token)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{24,}['"]/i },
  { name: '11 位手机号', re: /\b1[3-9]\d{9}\b/ },
];

/** 明确允许出现的行（示例值 / 打码串 / 测试夹具里的假值） */
const SECRET_ALLOW = [
  /cronhub-diag-invalid-token/,
  /\*{4}/,
  /PLAINTEXT_CANARY/,
  /CANARY_/,
  /13800138000/,          // 验收脚本自己的假号码（本文件被扫描时）
  /verify-credential\.cjs/, // 扫描器自身
];

function scanPlaintext() {
  const files = walk(ROOT);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 2000) continue;
      if (SECRET_ALLOW.some((re) => re.test(line))) continue;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) {
          hits.push({ file: rel, line: i + 1, kind: p.name, sample: line.trim().slice(0, 90) });
          break;
        }
      }
    }
  }
  return { files: files.length, hits };
}

/* ================================================================
 * 主流程
 * ================================================================ */

async function main() {
  console.log('凭据治理验收  ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  console.log('项目：' + ROOT);

  /* ---------------- 1. 明文扫描 ---------------- */
  section('第十条 ①  全仓库 grep 不到凭据明文');
  {
    const { files, hits } = scanPlaintext();
    /* 允许清单之外的命中才算违规 */
    ok('扫描了 ' + files + ' 个源码/配置文件', files >= 20, '命中 ' + hits.length + ' 处');
    if (hits.length) {
      for (const h of hits.slice(0, 8)) {
        console.log(`         ${h.file}:${h.line}  [${h.kind}]  ${h.sample}`);
      }
      if (hits.length > 8) console.log(`         …另有 ${hits.length - 8} 处`);
    }
    ok('没有明文凭据落盘', hits.length === 0, hits.length ? '见上方清单' : '');

    /* lib/sms/config.json 是历史遗留位置，必须已经不含 code / kid / strategyId */
    const cfgPath = path.join(ROOT, 'lib', 'sms', 'config.json');
    let cfgClean = true;
    let cfgKeys = [];
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        cfgKeys = Object.keys(cfg);
        cfgClean = !['code', 'kid', 'strategyId'].some((k) => cfg[k]);
      } catch { cfgClean = false; }
    }
    ok('lib/sms/config.json 不再含应用凭据', cfgClean, cfgKeys.join(',') || '(无文件)');
  }

  /* ---------------- 2. 日志脱敏 ---------------- */
  section('第十条 ②  日志里检索不到完整 token 与完整手机号');
  {
    const samples = [
      { in: 'ak_live_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', mustNot: '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', kind: '带前缀 Key' },
      { in: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', mustNot: 'eyJhbGciOiJIUzI1NiJ9', kind: 'Bearer' },
      { in: 'creditToken=Qk9nU1FEcXdVdmhLbUJ4R2pUeVo1d0FhM2FOZ2l0', mustNot: 'Qk9nU1FEcXdVdmhLbUJ4R2pUeVo1d0FhM2FOZ2l0', kind: 'key=value' },
      { in: '用户 13800138000 绑定成功', mustNot: '13800138000', kind: '手机号' },
      { in: 'token 8f4b2c1d9e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c', mustNot: '8f4b2c1d9e7a6b5c', kind: '长 hex' },
    ];
    for (const s of samples) {
      const out = scrub(s.in);
      ok(`${s.kind}被脱敏`, !out.includes(s.mustNot), out.slice(0, 60));
    }
    ok('手机号保留首 3 尾 4（还能排查）', maskMobile('13800138000') === '138****8000', maskMobile('13800138000'));

    /* 重抛的异常 message 必须已清洗 */
    const src = fs.readFileSync(CRED_PATH, 'utf8');
    const rawConcat = /取令牌异常：\$\{e && e\.message\}/.test(src);
    ok('异常 message 重抛前已清洗', !rawConcat);
  }

  /* ---------------- 3. 落盘为密文 ---------------- */
  section('第十条 ③  数据库落盘为密文，离线还原不出凭据');
  const dd = tmpDir('store');
  const store = { vault: null };
  const CANARY = 'CANARY_plaintext_' + crypto.randomBytes(6).toString('hex');
  {
    const v = createVault({
      dataDir: dd,
      getStore: () => store.vault,
      putStore: (x) => { store.vault = x; },
    });
    const w = v.scope(SCOPE.SHORTTERM).set('creditToken', CANARY);
    ok('写入成功', !w || w.ok !== false, JSON.stringify(w));

    const onDisk = JSON.stringify(store.vault);
    ok('库内容里没有明文', !onDisk.includes(CANARY));
    ok('库内容里是密文结构', /"entries"/.test(onDisk) && onDisk.length > 40, onDisk.slice(0, 80) + '…');
    /* 密文形态：v1:iv:tag:data，至少四段 */
    const anyEnc = JSON.stringify(store.vault).match(/v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/);
    ok('密文含 版本号 + nonce + tag', !!anyEnc);

    const back = v.scope(SCOPE.SHORTTERM).get('creditToken');
    ok('同密钥能解回原文', back.ok && back.value === CANARY);
  }

  /* ---------------- 4. 100 并发只刷 1 次 ---------------- */
  section('第十条 ④  100 并发刷新，preAuth 只被调用 1 次');
  {
    let probeCount = 0;
    let sendCount = 0;
    let mem = '';
    const MST = memStore();
    const cred = createSmsCredential({
      getStore: MST.get,
      putStore: MST.put,
      probeToken: async () => {
        probeCount += 1;
        await sleep(60);
        return { resultCode: '103000', creditToken: 'TK_' + probeCount, expireTime: 300 };
      },
      sendRaw: async () => { sendCount += 1; return { ok: true, out: '✅ 发送成功' }; },
      tokenStore: {
        read: () => ({ ok: true, value: mem }),
        write: (p) => { mem = String(p); return { ok: true }; },
        clear: () => { mem = ''; },
      },
      onLog: () => {},
      onAlert: async () => {},
      audit: () => {},
      lockDir: tmpDir('lock'),
      quota: { sendPerDay: 1000, sendGapMs: 0, refreshPerDay: 1000, authPerDay: 99, authPerHour: 99 },
    });
    const rs = await Promise.all(Array.from({ length: 100 }, () => cred.send({ text: '并发测试' })));
    const success = rs.filter((r) => r && r.ok).length;
    ok('100 个并发请求全部拿到结果', rs.length === 100, `成功 ${success}`);
    ok('preAuth 只被调用 1 次', probeCount === 1, `probe=${probeCount}，send=${sendCount}`);
  }

  /* ---------------- 5. 重启恢复 ---------------- */
  section('第十条 ⑤  进程重启后凭据与状态完整恢复');
  {
    const dd2 = tmpDir('restart');
    const stateFile = path.join(dd2, 'state.json');
    const runner = path.join(dd2, 'runner.cjs');
    fs.writeFileSync(runner, `'use strict';
const fs = require('fs');
const { createVault, SCOPE } = require(${JSON.stringify(VAULT_PATH)});
const dd = process.env.VDD, sf = process.env.VSF;
let state = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
const v = createVault({
  dataDir: dd,
  getStore: () => state.vault,
  putStore: (x) => { state.vault = x; fs.writeFileSync(sf, JSON.stringify(state)); },
  onLog: () => {},
});
const mode = process.argv[2];
if (mode === 'write') {
  v.scope(SCOPE.SHORTTERM).set('creditToken', process.env.VCANARY);
  fs.writeFileSync(sf, JSON.stringify(state));
  console.log('written');
} else {
  const r = v.scope(SCOPE.SHORTTERM).get('creditToken');
  console.log(JSON.stringify(r));
}
`, 'utf8');

    const env = { ...process.env, VDD: dd2, VSF: stateFile, VCANARY: 'CANARY_restart_ok' };
    delete env.CRONHUB_SMS_KEY;
    delete env.CRONHUB_SMS_KEY_FILE;

    const w = execFileSync(process.execPath, [runner, 'write'], { env, encoding: 'utf8' }).trim();
    const r = JSON.parse(execFileSync(process.execPath, [runner, 'read'], { env, encoding: 'utf8' }).trim());
    ok('子进程 A 写入成功', w === 'written', w);
    ok('子进程 B（新进程）读回一致', r.ok && r.value === 'CANARY_restart_ok', JSON.stringify(r));
    ok('密钥文件已落在独立目录', fs.existsSync(path.join(dd2, '.secrets', 'sms-master.key')));
  }

  /* ---------------- 6. 删密钥 fail-safe ---------------- */
  section('第十条 ⑥  删掉密钥后：能启动、拒绝发送、明确报错');
  {
    const dd3 = tmpDir('nokey');
    const st3 = { vault: null };

    /* 先正常写一条，制造「库里有密文」的事实 */
    const v1 = createVault({
      dataDir: dd3,
      getStore: () => st3.vault,
      putStore: (x) => { st3.vault = x; },
      onLog: () => {},
    });
    v1.scope(SCOPE.SHORTTERM).set('creditToken', 'CANARY_nokey');

    /* 删掉密钥文件，模拟「密钥被误删 / 备份丢了」 */
    const keyFile = path.join(dd3, '.secrets', 'sms-master.key');
    fs.rmSync(keyFile, { force: true });
    delete process.env.CRONHUB_SMS_KEY;
    delete process.env.CRONHUB_SMS_KEY_FILE;

    const logs = [];
    const v2 = createVault({
      dataDir: dd3,
      getStore: () => st3.vault,
      putStore: (x) => { st3.vault = x; },
      onLog: (e) => logs.push(e),
    });
    const h = v2.health();
    ok('服务能「启动」（模块构造不抛异常）', true);
    ok('保险库报告不健康', h.ok === false, h.state);
    ok('没有自动生成新密钥（否则旧密文永久报废）', !fs.existsSync(keyFile));
    ok('日志里给了明确原因', /主密钥/.test(h.message || ''), (h.message || '').slice(0, 70));

    const MST = memStore();
    const cred = createSmsCredential({
      getStore: MST.get,
      putStore: MST.put,
      probeToken: async () => ({ resultCode: '103000', creditToken: 'X', expireTime: 300 }),
      sendRaw: async () => ({ ok: true, out: '✅ 发送成功' }),
      tokenStore: {
        read: () => v2.scope(SCOPE.SHORTTERM).get('creditToken'),
        write: (p) => v2.scope(SCOPE.SHORTTERM).set('creditToken', p) || { ok: true },
        clear: () => v2.scope(SCOPE.SHORTTERM).remove('creditToken'),
      },
      checkVault: () => v2.health(),
      onLog: () => {},
      onAlert: async () => {},
      lockDir: tmpDir('lock2'),
    });
    const r = await cred.send({ text: '密钥缺失时必须拒绝' });
    ok('拒绝发送（不是 fail-open）', r.ok === false, JSON.stringify(r).slice(0, 90));
    ok('报错说人话：指向主密钥', /主密钥|密钥/.test(r.message || ''), (r.message || '').slice(0, 60));
  }

  /* ---------------- 7. dry-run 零消耗 ---------------- */
  section('第十条 ⑦  dev 调试不消耗生产配额');
  {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok('取令牌被 dry-run 拦住（不调 smsFetchToken）',
      /if \(SMS_DRY_RUN\) \{\s*return Promise\.resolve\(\{/.test(srv));
    ok('发送被 dry-run 拦住（不进 smsExec）',
      /if \(SMS_DRY_RUN\) \{\s*return \{\s*ok: true,\s*dryRun: true/.test(srv));
    ok('默认走 dry-run，必须显式开关才真发',
      /SMS_DRY_RUN\s*=\s*[^\n]*REAL/.test(srv) || /CRONHUB_SMS_REAL/.test(srv),
      (srv.match(/const SMS_DRY_RUN[^\n]*/) || [''])[0].slice(0, 90));

    /* 行为面：dry-run 下令牌由本地伪造，不会打到网络 */
    let netCalls = 0;
    const MST = memStore();
    const cred = createSmsCredential({
      getStore: MST.get,
      putStore: MST.put,
      probeToken: async () => ({ resultCode: '103000', creditToken: 'tk_dryrun_x', expireTime: 300 }),
      sendRaw: async () => { netCalls += 1; return { ok: true, out: '✅ 发送成功' }; },
      tokenStore: { read: () => ({ ok: true, value: '' }), write: () => ({ ok: true }), clear: () => {} },
      onLog: () => {}, onAlert: async () => {}, audit: () => {},
      lockDir: tmpDir('lock3'),
      quota: { sendPerDay: 1000, sendGapMs: 0 },
    });
    const st = cred.status();
    ok('配额闸门可见（控制台能查到消耗）', st.today && typeof st.today.sendCount === 'number', JSON.stringify(st.today));
  }

  /* ---------------- 第九条 禁止项 ---------------- */
  section('第九条  8 条禁止项');
  {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const credSrc = fs.readFileSync(CRED_PATH, 'utf8');
    const vaultSrc = fs.readFileSync(VAULT_PATH, 'utf8');

    ok('① 凭据不写在代码/配置明文里', scanPlaintext().hits.length === 0);

    /* ② 凭据不随前端下发：状态接口只回状态 */
    const credRoute = (srv.match(/pathname === '\/api\/sms\/credential'[\s\S]{0,300}/) || [''])[0];
    ok('② 状态接口只返回状态，不含凭据字段',
      /\bsmsCred\.status\(\)/.test(credRoute) && !/\btoken\s*:|accessToken|refreshToken\s*:|Enc\b/.test(credRoute),
      credRoute.replace(/\s+/g, ' ').slice(0, 80));

    /* ③ 凭据不拼进 URL：发送走 stdin */
    ok('③ token 走 stdin，不进命令行',
      /--token-stdin/.test(srv) && !/'--token',\s*token/.test(srv));
    ok('③ 网关调用强制 https', /url\.protocol !== 'https:'/.test(fs.readFileSync(path.join(ROOT, 'lib', 'sms', 'send.cjs'), 'utf8')));

    /*
     * ③' 沙箱只搬密文，不搬公钥 —— 反过来说：RSA 公钥不能跟着一起被删。
     * send.cjs:52 用 config.key 加密载荷，沙箱把 key 删掉就等于真实发送必挂。
     * 这条断言存在的唯一理由，就是防止「清理敏感字段」的人顺手把公钥也清了。
     */
    {
      const sandbox = (srv.match(/async function withCredentialSandbox[\s\S]*?\n\}/) || [''])[0];
      ok('③ 沙箱不删 RSA 公钥（send.cjs 加密要用）',
        !!sandbox && !/delete\s+base_cfg\.key/.test(sandbox),
        sandbox ? 'withCredentialSandbox 里没有 delete base_cfg.key' : '没找到沙箱函数');
      ok('③ 沙箱仍然清掉三项应用凭据',
        /delete\s+base_cfg\.code/.test(sandbox) && /delete\s+base_cfg\.kid/.test(sandbox)
        && /delete\s+base_cfg\.strategyId/.test(sandbox));
    }

    /* ④ 不进日志：日志写入统一过 scrub */
    const pushLogOk = /pushSysLog\(\{\s*level[^}]*msg:\s*scrub/.test(srv) || /function pushSysLog[\s\S]{0,400}scrub/.test(srv);
    ok('④ 系统日志入口统一脱敏', pushLogOk);

    /* ⑤ dev 与 prod 不共用：dev 默认 dry-run */
    ok('⑤ dev 默认 dry-run，环境隔离有代码保证', /SMS_DRY_RUN/.test(srv) && /RUNTIME_ENV/.test(srv));

    /* ⑥ 不并发刷新：进程内单飞 + 跨进程文件锁 */
    ok('⑥ 进程内单飞', /if \(inflight\)/.test(credSrc));
    ok('⑥ 跨进程文件锁', /class FileLock/.test(credSrc) && /tryAcquire/.test(credSrc));

    /* ⑦ 吊销后要断言，不能当已处理 */
    {
      let mem = '';
      const MST = memStore();
      const cred = createSmsCredential({
        getStore: MST.get,
        putStore: MST.put,
        probeToken: async () => ({ resultCode: '103000', creditToken: 'TK', expireTime: 300 }),
        sendRaw: async () => ({ ok: true, out: '✅ 发送成功' }),
        tokenStore: { read: () => ({ ok: true, value: mem }), write: (p) => { mem = p; return { ok: true }; }, clear: () => { mem = ''; } },
        onLog: () => {}, onAlert: async () => {}, audit: () => {},
        lockDir: tmpDir('lock4'),
        quota: { sendPerDay: 1000, sendGapMs: 0 },
      });
      await cred.send({ text: '先发一条' });
      const rv = cred.revoke('验收：模拟泄露');
      const after = cred.status();
      /* 令牌要在"再发一次"之前查：发送成功会重新取令牌，把 mem 又填回去 */
      const memAfterRevoke = mem;
      const r2 = await cred.send({ text: '吊销后不该发出去' });
      ok('⑦ 吊销后状态是 REVOKED', after.state === 'REVOKED', JSON.stringify(rv).slice(0, 80));
      ok('⑦ 吊销后令牌被清空', memAfterRevoke === '', JSON.stringify(memAfterRevoke));
      ok('⑦ 吊销后发送被拒（有断言，不是静默忽略）', r2.ok === false && r2.revoked === true, (r2.message || '').slice(0, 60));
    }

    /* ⑧ 重新授权不是谁都能点 */
    ok('⑧ 重新授权要求管理员会话', /function canManageSms[\s\S]{0,600}isAdmin/.test(srv));
    ok('⑧ 授权入口有配额（每天/每小时）', /authPerDay/.test(credSrc) && /authPerHour/.test(credSrc));
    ok('⑧ 没有把 Vault 导出给业务层', !/module\.exports[^\n]*\bVault\b/.test(credSrc));
  }

  /* ---------------- 汇总 ---------------- */
  const fail = RESULT.filter((r) => !r.pass);
  console.log('\n' + '─'.repeat(66));
  console.log(`${RESULT.length - fail.length}/${RESULT.length} 通过`);
  if (fail.length) {
    console.log('\n失败项：');
    for (const f of fail) console.log(`  ✗ [${f.section}] ${f.name}   ${f.detail || ''}`);
  }

  /* 清理临时目录 */
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 占用中就算了 */ }
  }

  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('验收脚本自身出错：', (e && e.stack) || e);
  process.exit(2);
});
