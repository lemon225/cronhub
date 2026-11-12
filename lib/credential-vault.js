'use strict';
/**
 * 凭据保险库 —— 三类凭据分开存储、分开加密、分开授权
 * ===========================================================================
 * 本模块只做一件事：把「凭据」与「业务代码」彻底隔离。
 *
 * 三类凭据（禁止混用，各自独立子密钥）：
 *   LONGTERM  长期凭据  uuid / clawUid          敏感级最高，等同账号密码，失效需人工重新授权
 *   SHORTTERM 短期凭据  creditToken             中，5 分钟到期，可重取
 *   APP       应用凭据  code / kid / strategyId 中高，换 Key 即可，含网关调用令牌
 *
 * 关键约束（对应规范第一、二、三节）：
 *   1. 主密钥不得与数据库同处 —— 只从环境变量或独立 secrets 文件读取，绝不从 state 派生。
 *   2. 业务代码不得直接访问存储 —— 只能通过 scope() 拿到受限视图；发送路径永远拿不到长期凭据。
 *   3. 明文只在调用瞬间解出 —— 本模块不缓存任何明文，每次 get() 现解，调用方用完即弃。
 *   4. 密钥缺失 / 密文损坏 → fail-safe：服务能启动，但明确拒绝发送，绝不静默降级。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------------------------------------------------------- 常量 */

/** 凭据分区。名字即权限边界，业务层按需申请，不跨界。 */
const SCOPE = {
  LONGTERM: 'longterm',
  SHORTTERM: 'shortterm',
  APP: 'app',
};

const SCOPE_LABEL = {
  longterm: '长期凭据（等同账号密码）',
  shortterm: '短期凭据（可重取）',
  app: '应用凭据（换 Key 即可）',
};

const VAULT_VERSION = 1;
const CIPHER_VERSION = 'v1';
const KEY_ENV = 'CRONHUB_SMS_KEY';
/** 密钥文件路径（可指向项目外 / 独立卷）：规范 I.2「不得与数据库同处存放」 */
const KEY_FILE_ENV = 'CRONHUB_SMS_KEY_FILE';
const KEY_FILE = 'sms-master.key';
const KEY_BYTES = 32;

/** 健康状态：只有 ok 才允许发送 */
const HEALTH = {
  OK: 'ok',
  KEY_MISSING: 'key_missing',
  DECRYPT_FAILED: 'decrypt_failed',
  STORE_CORRUPT: 'store_corrupt',
};

/* ------------------------------------------------------------ 工具函数 */

/**
 * 脱敏：保留后 4 位，形如 ak_****6af4 / ****6af4。
 * 规范第三节第 2 条要求「只保留后 4 位」，比整段打码更有排查价值。
 */
function redact(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (s.length <= 4) return '[REDACTED]';
  const tail = s.slice(-4);
  // 保留可读前缀（ak_ / sk_ 之类），其余一律打码
  const m = /^([a-z]{2,4}_)/i.exec(s);
  const head = m && s.length > m[1].length + 8 ? m[1] : '';
  return head + '****' + tail;
}

/** 从任意文本里清掉凭据痕迹：长十六进制串、token=xxx、完整手机号 */
function scrubText(s) {
  return String(s == null ? '' : s)
    .replace(/\b[0-9a-f]{24,}\b/gi, (m) => redact(m))
    .replace(/(token|code|secret|key|password|passwd)=([^\s&,;]+)/gi, (m, k, v) => k + '=' + redact(v))
    .replace(/\b1[3-9]\d{9}\b/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => redact(m));
}

/** 异常清洗：重抛前必须走一遍，防止令牌随堆栈外泄 */
function sanitizeError(e) {
  const msg = scrubText(e && e.message ? e.message : String(e || ''));
  const err = new Error(msg);
  err.name = (e && e.name) || 'Error';
  err.code = (e && e.code) || undefined;
  return err;
}

/* ---------------------------------------------------------- 主密钥 */

/**
 * 主密钥来源（按优先级）：
 *   1. 环境变量 CRONHUB_SMS_KEY（生产推荐，KMS 注入同理）
 *   2. 独立密钥文件，路径由 CRONHUB_SMS_KEY_FILE 指定（可指向另一个卷 / 项目目录之外，
 *      这是单容器环境下唯一能做到「密钥与数据不同处」的方式）
 *   3. 未指定时的默认位置 <dataDir>/.secrets/sms-master.key（权限 600，首次自动生成）
 *
 * 明确不做的事：不从 state / 数据库 / 代码常量派生。密钥与密文物理分离，
 * 拿到 state.json 也解不出任何凭据（验收第 3 条）。
 */
function loadMasterKey(opts = {}) {
  const { dataDir, log, hasCipher } = opts;
  const envRaw = String(process.env[KEY_ENV] || '').trim();

  if (envRaw) {
    // 环境变量里允许直接给 64 位 hex / base64，也允许给任意口令（再哈希成 32 字节）
    let key;
    if (/^[0-9a-f]{64}$/i.test(envRaw)) key = Buffer.from(envRaw, 'hex');
    else {
      try {
        const b = Buffer.from(envRaw, 'base64');
        key = b.length === KEY_BYTES ? b : null;
      } catch { key = null; }
      if (!key) key = crypto.createHash('sha256').update(envRaw).digest();
    }
    return { key, source: 'env', path: null, generated: false };
  }

  /*
   * 第二优先：显式指定的密钥文件（CRONHUB_SMS_KEY_FILE）。
   * 这是「密钥不与数据库同处」在单容器里的唯一落地方式 ——
   * 把密钥放在另一个挂载点 / 另一个卷 / 项目目录之外。
   * 指定了就**只认它**：读不到直接 fail-safe，绝不悄悄回退到下面的默认路径，
   * 否则「我明明配了独立密钥」会变成一句谎话。
   */
  const explicit = String(process.env[KEY_FILE_ENV] || '').trim();
  if (explicit) {
    const p = path.resolve(explicit);
    try {
      const b = fs.readFileSync(p);
      if (b.length !== KEY_BYTES) {
        if (typeof log === 'function') log('error', `密钥文件长度异常（${b.length}，应为 ${KEY_BYTES}）：${p}`);
        return { key: null, source: 'file_env', path: p, generated: false, error: 'key_bad_length' };
      }
      return { key: b, source: 'file_env', path: p, generated: false };
    } catch (e) {
      if (typeof log === 'function') log('error', `密钥文件（${KEY_FILE_ENV}）读取失败：${e.code || e.message}`);
      return { key: null, source: 'file_env', path: p, generated: false, error: 'key_unreadable' };
    }
  }

  const dir = path.join(dataDir, '.secrets');
  const file = path.join(dir, KEY_FILE);
  try {
    const b = fs.readFileSync(file);
    if (b.length === KEY_BYTES) return { key: b, source: 'file', path: file, generated: false };
    // 长度不对：当作损坏，不猜
    if (typeof log === 'function') log('error', `主密钥文件长度异常（${b.length} 字节，应为 ${KEY_BYTES}）`);
    return { key: null, source: 'file', path: file, generated: false, error: 'key_bad_length' };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (typeof log === 'function') log('error', `主密钥文件读取失败：${e.code || e.message}`);
      return { key: null, source: 'file', path: file, generated: false, error: 'key_unreadable' };
    }
  }

  /*
   * 不存在 → 首次生成。但**只有在一件密文都没有的时候才允许**。
   * 否则「密钥文件被误删」会被系统悄悄糊过去：它生成一把新钥匙，把旧密文
   * 全部变成永远解不开的垃圾，而表面上只是「需要重新授权」。
   * 正确的做法是明确报错，让人去找备份 —— 这正是验收第 6 条要的 fail-safe。
   */
  if (typeof hasCipher === 'function' && hasCipher()) {
    if (typeof log === 'function') {
      log('error', '主密钥缺失，但存储中已有加密凭据 —— 拒绝自动生成新密钥（否则旧凭据永久报废）。请恢复原密钥文件或设置 ' + KEY_ENV + '。');
    }
    return { key: null, source: 'none', path: null, generated: false, error: 'key_missing_but_cipher_exists' };
  }

  // 首次生成。这是唯一一次写密钥。
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(KEY_BYTES);
    // wx：已存在就失败，避免并发首启互相覆盖
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows NTFS 不支持 POSIX 权限，忽略 */ }
    if (typeof log === 'function') {
      log('info', `已生成独立主密钥（${path.relative(dataDir, file)}，权限 600）。备份该文件才能恢复已存凭据。`);
    }
    return { key, source: 'file', path: file, generated: true };
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const b = fs.readFileSync(file);
        if (b.length === KEY_BYTES) return { key: b, source: 'file', path: file, generated: false };
      } catch { /* 落到下面报错 */ }
    }
    if (typeof log === 'function') log('error', `主密钥生成失败：${e.code || e.message}`);
    return { key: null, source: 'none', path: null, generated: false, error: 'key_create_failed' };
  }
}

/* ------------------------------------------------------- 子密钥派生 */

/**
 * 按分区派生独立子密钥（HKDF-SHA256，域分离）。
 * 某分区的密钥泄露不会牵连其他分区 —— 这正是「分开加密」的实质。
 */
function deriveScopeKey(master, scope) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('cronhub-sms|vault|v1'), Buffer.from(String(scope)), KEY_BYTES));
}

/* -------------------------------------------------------- 加解密 */

function makeCipher(key) {
  return {
    encrypt(plain) {
      const s = String(plain == null ? '' : plain);
      if (!s) return '';
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      // 版本号 + nonce + 认证标签 + 密文，四段一起存
      return [CIPHER_VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    /** 返回 { ok, value } —— 解不开要能区分「没有」和「坏了」 */
    decrypt(blob) {
      const s = String(blob || '');
      if (!s) return { ok: true, value: '' };
      const parts = s.split(':');
      if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
        return { ok: false, value: '', error: 'bad_format' };
      }
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
        d.setAuthTag(Buffer.from(parts[2], 'base64'));
        const v = Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
        return { ok: true, value: v };
      } catch {
        // 密钥换了 / 密文被动过 → 不是「空」，是「坏了」
        return { ok: false, value: '', error: 'auth_failed' };
      }
    },
  };
}

/* ------------------------------------------------------------ 主体 */

function createVault(opts = {}) {
  const {
    dataDir,          // 密钥文件与存储根目录
    getStore,         // () => 分区存储对象
    putStore,         // (obj) => void 写回并落盘
    audit,            // (event) => void 追加审计日志
    onLog,            // ({level, msg}) => void 业务日志
    masterKey,        // 允许直接注入（自测用）
    keysDir,          // 覆盖 secrets 目录（自测用）
  } = opts;

  const log = (level, msg) => {
    if (typeof onLog === 'function') onLog({ level, msg: scrubText(msg) });
  };

  const mk = masterKey
    ? { key: masterKey, source: 'injected', path: null, generated: false }
    : loadMasterKey({
        dataDir: keysDir || dataDir,
        log,
        /* 已有密文时不许自动生成新密钥 —— 见 loadMasterKey 里的说明 */
        hasCipher: () => {
          try {
            const s = getStore();
            if (!s || !s.scopes) return false;
            return Object.values(SCOPE).some(
              (k) => Object.keys((s.scopes[k] && s.scopes[k].entries) || {}).length > 0
            );
          } catch {
            return false;
          }
        },
      });

  const health = { state: mk.key ? HEALTH.OK : HEALTH.KEY_MISSING, at: Date.now(), detail: mk.error || '' };
  const ciphers = {};
  for (const s of Object.values(SCOPE)) {
    ciphers[s] = mk.key ? makeCipher(deriveScopeKey(mk.key, s)) : null;
  }

  /* -------------------------------------------------- 存储结构 */

  function blankStore() {
    return {
      version: VAULT_VERSION,
      createdAt: Date.now(),
      scopes: {
        [SCOPE.LONGTERM]: { updatedAt: 0, entries: {}, hardExpiresAt: 0, boundAt: 0 },
        [SCOPE.SHORTTERM]: { updatedAt: 0, entries: {}, expiresAt: 0 },
        [SCOPE.APP]: { updatedAt: 0, entries: {} },
      },
      rotation: { lastRotatedAt: 0, rotateCount: 0 },
      lastAuditAt: 0,
    };
  }

  function store() {
    const s = typeof getStore === 'function' ? getStore() : null;
    if (!s || typeof s !== 'object' || !s.scopes) return null;
    return s;
  }

  function ensure() {
    let s = store();
    if (!s) {
      s = blankStore();
      if (typeof putStore === 'function') putStore(s);
      return s;
    }
    // 补齐结构（老版本升级不丢数据）
    const b = blankStore();
    if (!s.version) s.version = b.version;
    if (!s.createdAt) s.createdAt = b.createdAt;
    s.scopes = s.scopes || {};
    for (const [k, v] of Object.entries(b.scopes)) {
      if (!s.scopes[k]) s.scopes[k] = v;
      else {
        s.scopes[k].entries = s.scopes[k].entries || {};
        for (const [fk, fv] of Object.entries(v)) {
          if (s.scopes[k][fk] === undefined) s.scopes[k][fk] = fv;
        }
      }
    }
    s.rotation = s.rotation || b.rotation;
    return s;
  }

  function commit(s) {
    if (typeof putStore === 'function') putStore(s);
  }

  function emit(event) {
    const line = {
      at: new Date().toISOString(),
      source: 'credential_vault',
      ...event,
    };
    // 审计里绝不能出现凭据值：只保留键名与操作结果
    delete line.value;
    if (typeof audit === 'function') {
      try { audit(line); } catch { /* 审计失败不阻断业务 */ }
    }
  }

  /* -------------------------------------------------- 能力视图 */

  /**
   * 申请某个分区的受限视图。
   * 这是唯一的读写入口 —— 业务代码拿不到 store 本身，也就无法越界读别的分区。
   */
  function scope(name) {
    const key = String(name || '');
    if (!SCOPE[key.toUpperCase()] && !Object.values(SCOPE).includes(key)) {
      throw new Error(`未知的凭据分区：${key}`);
    }
    const cipher = ciphers[key];
    if (!cipher) {
      // fail-safe：没有密钥时所有读写都返回明确错误，绝不返回假数据
      const denied = () => ({
        ok: false, value: '', error: HEALTH.KEY_MISSING,
        message: `凭据保险库不可用（主密钥缺失），拒绝访问 ${key} 分区。请恢复 ${KEY_ENV} 或 .secrets/${KEY_FILE}`,
      });
      return {
        name: key,
        get: denied,
        set: () => denied(),
        remove: () => denied(),
        keys: () => [],
        available: () => false,
      };
    }

    return {
      name: key,
      available: () => true,

      /** 取明文。调用方用完必须立即丢弃，不得放进全局变量 / session / 本地缓存文件。 */
      get(k) {
        const s = ensure();
        const enc = s.scopes[key].entries[k];
        if (!enc) return { ok: true, value: '' };
        const r = cipher.decrypt(enc);
        if (!r.ok) {
          health.state = HEALTH.DECRYPT_FAILED;
          health.detail = `${key}.${k}:${r.error}`;
          emit({ event: 'credential_read', scope: key, key_name: k, result: 'decrypt_failed' });
          log('error', `凭据解密失败（${key}/${k}）：${r.error}。通常是主密钥被更换或密文损坏。`);
          return { ok: false, value: '', error: r.error };
        }
        emit({ event: 'credential_read', scope: key, key_name: k, result: 'ok' });
        return { ok: true, value: r.value };
      },

      /** 写明文（内部加密）。值本身绝不进日志、绝不进审计。 */
      set(k, v) {
        const s = ensure();
        s.scopes[key].updatedAt = Date.now();
        if (v === null || v === undefined || v === '') {
          delete s.scopes[key].entries[k];
          emit({ event: 'credential_write', scope: key, key_name: k, action: 'remove' });
        } else {
          s.scopes[key].entries[k] = cipher.encrypt(v);
          emit({ event: 'credential_write', scope: key, key_name: k, action: 'set', valueLength: String(v).length });
        }
        commit(s);
        return { ok: true };
      },

      remove(k) {
        return this.set(k, null);
      },

      keys() {
        const s = ensure();
        return Object.keys(s.scopes[key].entries || {});
      },

      /** 分区元数据（不含任何凭据值） */
      meta() {
        const s = ensure();
        const sc = s.scopes[key];
        return {
          name: key,
          label: SCOPE_LABEL[key] || key,
          entryCount: Object.keys(sc.entries || {}).length,
          updatedAt: sc.updatedAt || 0,
          hardExpiresAt: sc.hardExpiresAt || 0,
          boundAt: sc.boundAt || 0,
          expiresAt: sc.expiresAt || 0,
        };
      },

      /** 整分区清空（吊销时用） */
      clear() {
        const s = ensure();
        s.scopes[key].entries = {};
        s.scopes[key].updatedAt = Date.now();
        commit(s);
        emit({ event: 'credential_clear', scope: key });
        return { ok: true };
      },
    };
  }

  /** 一次性取全部明文（物化给子进程用）。调用方必须用后即删。 */
  function materialize(name) {
    const sc = scope(name);
    if (!sc.available()) return { ok: false, error: HEALTH.KEY_MISSING, values: {} };
    const values = {};
    for (const k of sc.keys()) {
      const r = sc.get(k);
      if (r.ok && r.value) values[k] = r.value;
    }
    emit({ event: 'credential_materialize', scope: name, key_count: Object.keys(values).length });
    return { ok: true, values };
  }

  /* -------------------------------------------------- 状态 / 维护 */

  /*
   * 主动探针：从每个分区各取一条密文试解密。
   * 不做这件事的话，「密钥被换掉」只能等到真正发送时才暴露 ——
   * 而那时往往先被「60 秒发送间隔」之类的前置闸门挡住，
   * 用户看到的是「请 60 秒后再试」，真正的原因被掩盖。
   */
  function probeCipherHealth(s) {
    for (const k of Object.values(SCOPE)) {
      const entries = (s.scopes[k] && s.scopes[k].entries) || {};
      const firstKey = Object.keys(entries)[0];
      if (!firstKey) continue;
      const cipher = ciphers[k];
      if (!cipher) return { ok: false, state: HEALTH.KEY_MISSING };
      const r = cipher.decrypt(entries[firstKey]);
      if (!r.ok) return { ok: false, state: HEALTH.DECRYPT_FAILED, detail: `${k}.${firstKey}:${r.error}` };
      return { ok: true };
    }
    return { ok: true };
  }

  function healthOf() {
    const s = ensure();
    // 有密文但主密钥不在 → 明确 fail-safe，而不是「当作没有凭据」静默继续
    const hasCipher = Object.values(SCOPE).some(
      (k) => Object.keys((s.scopes[k] && s.scopes[k].entries) || {}).length > 0
    );
    if (!mk.key && hasCipher) {
      return {
        ok: false,
        state: HEALTH.KEY_MISSING,
        message: `主密钥缺失，但存储中已有加密凭据，无法解密。请恢复 ${KEY_ENV} 环境变量、${KEY_FILE_ENV} 指定的密钥文件，或 .secrets/${KEY_FILE}（备份文件）。在此之前拒绝发送短信。`,
      };
    }
    const probe = probeCipherHealth(s);
    if (!probe.ok) {
      health.state = probe.state;
      health.detail = probe.detail || health.detail;
      return {
        ok: false,
        state: probe.state,
        message: `凭据解密失败（${probe.detail || '主密钥不匹配'}）。主密钥可能被更换，请恢复 .secrets/${KEY_FILE} 或重新授权。在此之前拒绝发送短信。`,
      };
    }
    if (health.state === HEALTH.DECRYPT_FAILED) {
      return {
        ok: false,
        state: HEALTH.DECRYPT_FAILED,
        message: `凭据解密失败（${health.detail}）。主密钥可能被更换，请恢复正确密钥或重新授权。在此之前拒绝发送短信。`,
      };
    }
    return { ok: true, state: HEALTH.OK, message: '凭据保险库正常' };
  }

  /** 只读仪表盘：只有键名与时间，没有任何值 */
  function status() {
    const s = ensure();
    const h = healthOf();
    return {
      ok: h.ok,
      health: h.state,
      message: h.message,
      keySource: mk.source,             // env / file / injected —— 不暴露路径细节
      keyFromEnv: mk.source === 'env',
      generatedAtFirstBoot: !!mk.generated,
      version: s.version,
      createdAt: s.createdAt || 0,
      rotation: {
        lastRotatedAt: (s.rotation && s.rotation.lastRotatedAt) || 0,
        rotateCount: (s.rotation && s.rotation.rotateCount) || 0,
      },
      scopes: Object.values(SCOPE).map((k) => {
        const sc = scope(k);
        return sc.available() ? sc.meta() : { name: k, label: SCOPE_LABEL[k], entryCount: null, unavailable: true };
      }),
      keyFileHint: mk.source === 'file'
        ? `密钥文件 .secrets/${KEY_FILE}（权限 600），备份该文件即可在新机器恢复已存凭据`
        : (mk.source === 'env' ? `密钥来自环境变量 ${KEY_ENV}` : '未配置主密钥'),
    };
  }

  /** 轮换记账（换密钥 / 换凭据后调用） */
  function noteRotation(reason) {
    const s = ensure();
    s.rotation.lastRotatedAt = Date.now();
    s.rotation.rotateCount = (Number(s.rotation.rotateCount) || 0) + 1;
    commit(s);
    emit({ event: 'credential_rotated', reason: scrubText(reason || ''), rotate_count: s.rotation.rotateCount });
    return s.rotation;
  }

  /*
   * 整体吊销：清空「用户身份」相关分区 + 记账。
   *
   * ⚠️ 默认保留 APP 分区（code / kid / strategyId）。
   *    第 38 轮的线上事故就是这里踩的：吊销按钮把三个分区一起清空，
   *    连平台分配的应用凭据也抹掉了 —— 而它没有任何恢复入口
   *    （分区一旦非空 bootstrap 就 409，反过来空了才有入口，但值只在平台侧），
   *    结果所有后续 preAuth 都返回「200002 clientId不能为空」，通道彻底失联。
   *
   *    语义上也该分开：吊销的是「这个手机号的授权」，不是「我们是哪个应用」。
   *    真要连应用凭据一起清（确认 code/kid 泄露），显式传 includeApp: true。
   *
   * ⚠️ longterm 里还保留了 clawUid —— 它是「这台设备的身份」，不是授权凭据。
   *    清掉它等于换机器，平台侧原有绑定全部作废，而用户只是想在**同一台设备**上重扫。
   *    与 APP 分区同理：能自助恢复的值不动，不能恢复/不该变的值不动。
   */
  const KEEP_ON_REVOKE = { [SCOPE.LONGTERM]: ['clawUid'] };

  function revokeAll(reason, opts = {}) {
    const s = ensure();
    const targets = opts.includeApp
      ? Object.values(SCOPE)
      : [SCOPE.LONGTERM, SCOPE.SHORTTERM];
    for (const k of targets) {
      const keep = (opts.includeApp ? [] : (KEEP_ON_REVOKE[k] || []));
      const entries = s.scopes[k].entries || {};
      const next = {};
      for (const key of Object.keys(entries)) {
        // clawUid 不加密值本身也不是秘密，但一律按密文原样留下，不做任何“解了再存”
        if (keep.includes(key)) next[key] = entries[key];
      }
      s.scopes[k].entries = next;
      s.scopes[k].updatedAt = Date.now();
    }
    s.rotation.lastRotatedAt = Date.now();
    s.rotation.rotateCount = (Number(s.rotation.rotateCount) || 0) + 1;
    commit(s);
    emit({ event: 'credential_revoke_all', reason: scrubText(reason || 'manual'), kept_app: !opts.includeApp });
    return { ok: true, at: Date.now(), keptApp: !opts.includeApp, keptKeys: opts.includeApp ? [] : ['clawUid'] };
  }

  /** 把旧格式（sms-credential 自带的 accessTokenEnc）迁移进 shortterm 分区 */
  function migrateLegacyShortTerm(legacyCipher, legacyPlainOk) {
    const s = ensure();
    const sc = s.scopes[SCOPE.SHORTTERM];
    if (Object.keys(sc.entries || {}).length) return { ok: true, skipped: 'already_migrated' };
    const r = legacyCipher || {};
    if (!legacyPlainOk || !r.creditToken) return { ok: true, skipped: 'nothing_to_migrate' };
    scope(SCOPE.SHORTTERM).set('creditToken', r.creditToken);
    return { ok: true, migrated: true };
  }

  return {
    SCOPE,
    scope,
    materialize,
    status,
    health: healthOf,
    noteRotation,
    revokeAll,
    migrateLegacyShortTerm,
    /** 兼容旧接口：等价于 scope(SHORTTERM)，供 sms-credential.js 注入 */
    shortTermCipher: ciphers[SCOPE.SHORTTERM],
    meta: {
      keySource: mk.source,
      keyPath: mk.path,
      keyGenerated: !!mk.generated,
      version: VAULT_VERSION,
    },
  };
}

module.exports = {
  createVault,
  loadMasterKey,
  deriveScopeKey,
  makeCipher,
  SCOPE,
  SCOPE_LABEL,
  HEALTH,
  redact,
  scrubText,
  sanitizeError,
  KEY_ENV,
  KEY_FILE,
};
