'use strict';
/**
 * 短信凭据管理（中国移动新消息通道）
 * ---------------------------------------------------------------------------
 * 设计目标：一次授权长期使用、失败快速熔断、绝不重复触发风控。
 *
 * 与本通道实际授权模型的映射（重要）：
 *   该通道没有 OAuth2 的 refresh_token 端点。它的授权是一次性绑定：
 *     preAuth(uuid + accessToken + 设备指纹) → 103000 + creditToken（短时效）
 *                                            → 103001 + authPageUrl（需人工扫码）
 *   所以：
 *     - "access_token"     → creditToken（真正的发送令牌，实测 TTL 约 5 分钟）
 *     - "refresh_token"    → 不存在，本模块恒为空并在仪表盘注明
 *     - "调 refresh 接口"  → 再调一次 preAuth
 *   preAuth 既是"取令牌"也是"刷新"，因此**所有 preAuth 调用都必须过闸门**。
 *
 * 状态机：ACTIVE / NEED_REAUTH / LOCKED，持久化，重启不丢。只能由代码判定迁移。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ 常量 */

const STATE = {
  ACTIVE: 'ACTIVE',           // 正常
  EXPIRING: 'EXPIRING',       // 即将到期（≤7 天），只告警不阻断
  NEED_REAUTH: 'NEED_REAUTH', // 已失效，停止自动请求，等人工
  REVOKED: 'REVOKED',         // 已吊销，等人工，不可被动转正
  LOCKED: 'LOCKED',           // 熔断中
};

/**
 * 状态机单向流转表。只允许按表迁移，任何「人工点按钮硬拉回 ACTIVE」都会被拒绝。
 *   - EXPIRING → ACTIVE 是合法回退：它还没失效，续期成功就恢复正常
 *   - NEED_REAUTH / REVOKED → 只能走向 REVOKED，必须由代码在重新授权成功后
 *     走「全新绑定」路径（clearRevoked）才回到 ACTIVE，而不是直接改字段
 */
const FLOW = {
  ACTIVE: ['EXPIRING', 'NEED_REAUTH', 'REVOKED', 'LOCKED'],
  EXPIRING: ['ACTIVE', 'NEED_REAUTH', 'REVOKED', 'LOCKED'],
  LOCKED: ['ACTIVE', 'EXPIRING', 'NEED_REAUTH', 'REVOKED'],
  NEED_REAUTH: ['REVOKED'],
  REVOKED: [],
};

/** 硬过期提醒里程碑：提前 7 / 3 / 1 天 */
const EXPIRY_MILESTONES = [7, 3, 1];

// 熔断阶梯：第 n 次连续触发（24h 内无新触发则重置）对应的熔断时长
const CIRCUIT_STEPS = [30 * 60e3, 2 * 3600e3, 6 * 3600e3, 24 * 3600e3];
const CIRCUIT_RESET_MS = 24 * 3600e3;

// 轮换突增告警阈值：1 小时内刷新次数超过它就叫一次（规范四.5）。
// 日配额只有 24 次，一小时内烧掉一大半一定不正常 —— 通常是令牌被反复判废。
const ROTATE_SPIKE_PER_HOUR = 15;

// 本地配额（假设移动侧取最严）
/*
 * 配额的定位：**提示线，不是闸门**。
 *
 * 这些数字最初是当硬上限写的，结果是「想重扫一次被本地拦住、点发送被告知 40 秒后再试」——
 * 用户面对的是自己写的程序在拦自己。现在统一改成：
 *   · 手动操作（人点的按钮：扫码授权、发送测试、诊断）→ 一律放行，只回一句提示
 *   · 自动操作（定时任务推送、后台探测）→ 仍按配额拦，防止程序自己失控刷爆号码
 *   · 熔断（平台风控 140005）→ 保留硬拦，这是上游的限制，不拦会被封
 * 真要把闸门装回来（比如把站点开放给别人用），设 CRONHUB_SMS_STRICT=1。
 */
const STRICT = /^(1|true|yes|on)$/i.test(String(process.env.CRONHUB_SMS_STRICT || ''));

const QUOTA = {
  authPerDay: 10,           // 授权页（会消耗验证码）每天最多 10 次
  authSoftPerDay: 3,        // 超过后提醒「在烧验证码额度」
  authPerHour: 5,
  authSoftPerHour: 1,
  refreshPerDay: 24,        // preAuth 调用（= 令牌刷新）每天最多 24 次
  sendPerDay: 20,           // 消息每天最多 20 条
  sendGapMs: 60 * 1000,     // 两条之间最小间隔 60 秒
};

// creditToken 实测 TTL 约 300s。需求要求"提前 10 分钟刷新"，但 TTL 只有 5 分钟，
// 那会导致每次调用都被判定为"快过期"→ 等于每次都刷新。这里按实际 TTL 定阈值。
const MAX_REFRESH_MARGIN_MS = 60 * 1000;   // 提前量上限 60s
const MIN_REFRESH_MARGIN_MS = 30 * 1000;   // 提前量下限 30s

// 请求级超时与重试（只对网络错误 / 5xx / 超时重试，4xx 一次都不重试）
const SEND_TIMEOUT_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const RETRY_DELAYS = [60 * 1000, 300 * 1000];  // 退避：60s → 300s

const FREQ_CODE = '140005';
const LOCK_TTL_MS = 30 * 1000;             // 文件锁 TTL
const LOCK_WAIT_MS = 15 * 1000;            // 未拿到锁时最长等结果 15s

/* ------------------------------------------------------------ 工具函数 */

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const hourKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 13);

/** 手机号脱敏：只保留首 3 尾 4，其余打码；不足 8 位直接全打码 */
function maskMobile(v) {
  const s = String(v || '').replace(/\s+/g, '');
  if (!s) return '';
  if (s.length < 8) return '***';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/**
 * 日志脱敏：只保留后 4 位，形如 ak_****6af4 / ****6af4。
 * 规范第三节第 2 条要求「只保留后 4 位」，比整段打码更有排查价值，
 * 又不至于把令牌整体泄出去。手机号保留首 3 尾 4。
 *
 * 覆盖四类真实会出现在日志里的东西（顺序有讲究，先具体后笼统）：
 *   1. 带前缀的 key：ak_xxx / sk_xxx —— 明文前缀是给人看的，尾巴必须打掉
 *   2. Authorization 头：Bearer xxx
 *   3. 长随机串：creditToken / JWT / 32+ 位 base64，无前缀也要打
 *   4. key=value 形式：token= / code= / secret=
 */
function redactOne(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (s.length <= 4) return '[REDACTED]';
  const m = /^([a-z]{2,4}_)/i.exec(s);
  const head = m && s.length > m[1].length + 8 ? m[1] : '';
  return head + '****' + s.slice(-4);
}

function scrub(s) {
  return String(s == null ? '' : s)
    /* ak_xxx / sk-xxx 这类带可读前缀的 */
    .replace(/\b([a-z]{2,4}[_-])[A-Za-z0-9_-]{12,}\b/gi, (m, p) => p + '****' + m.slice(-4))
    /* Authorization: Bearer xxx */
    .replace(/\b(Bearer)\s+([A-Za-z0-9._~+/=-]{10,})/gi, (m, k, v) => k + ' ****' + v.slice(-4))
    /* 长 hex / base64 / JWT（含 . 分段）：无前缀也要打掉 */
    .replace(/\b[0-9a-f]{24,}\b/gi, (m) => '****' + m.slice(-4))
    .replace(/\b[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, (m) => '****' + m.slice(-4))
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, (m) => '****' + m.slice(-4))
    .replace(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, (m) => '****' + m.slice(-4))
    .replace(/(token|code|secret|key|password|passwd)=([^\s&,;]+)/gi, (m, k, v) => k + '=****' + String(v).slice(-4))
    .replace(/\b1[3-9]\d{9}\b/g, (m) => maskMobile(m))
    .slice(0, 300);
}

/* -------------------------------------------------------------- 加密层 */

/**
 * AES-256-GCM。
 *
 * @deprecated 生产已改用 lib/credential-vault.js（三类凭据分区 + HKDF 子密钥 +
 *   外部密钥文件）。这个类只为还引用它的旧自测脚本保留，**不再导出**。
 *
 * v2 修掉的两处（规范 I.2）：
 *   1. 原来缺密钥时会退到常量 'cronhub-sms-fallback' 派生的密钥 —— 那等于
 *      「所有人共用一把钥匙」，比不加密更糟：它让人以为数据是加密的。
 *   2. 原来密钥可由 state.auth.salt+secret 派生 —— 密钥和密文躺在同一个
 *      state.json 里，拿到库文件就能解出令牌。现在没有密钥就是没有密钥，
 *      直接抛错，让调用方 fail-safe 而不是静默用错钥匙。
 */
class Vault {
  constructor(seed) {
    this._seed = seed;
    this._key = null;
    const raw = process.env.CRONHUB_SMS_KEY || '';
    this.fromEnv = !!raw;
    this._envKey = raw;
  }

  get key() {
    if (!this._key) {
      const base = typeof this._seed === 'function' ? String(this._seed() || '') : String(this._seed || '');
      const raw = String(this._envKey || base || '').trim();
      if (!raw) {
        throw new Error('主密钥缺失：请配置 CRONHUB_SMS_KEY，或改用 lib/credential-vault.js');
      }
      this._key = crypto.createHash('sha256').update(raw).digest();
    }
    return this._key;
  }

  encrypt(plain) {
    const s = String(plain == null ? '' : plain);
    if (!s) return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(blob) {
    const s = String(blob || '');
    if (!s) return '';
    const parts = s.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1], 'base64'));
      d.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
    } catch {
      return ''; // 密钥换了 / 密文损坏 → 当作没有凭据
    }
  }
}

/* ------------------------------------------------------------ 文件锁 */

/**
 * 跨进程单飞锁。多 worker / 多进程必须共享，进程内锁不够。
 * 用 O_CREAT|O_EXCL 保证原子性；持锁超 TTL 视为死锁自动清理。
 */
class FileLock {
  constructor(file) {
    this.file = file;
  }

  tryAcquire() {
    try {
      const fd = fs.openSync(this.file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      // 死锁清理：持锁进程已退出或超过 TTL
      try {
        const st = fs.statSync(this.file);
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          fs.unlinkSync(this.file);
          return this.tryAcquire();
        }
      } catch {
        return this.tryAcquire();
      }
      return false;
    }
  }

  release() {
    try { fs.unlinkSync(this.file); } catch { /* 已被清理 */ }
  }

  /** 未拿到锁时轮询等结果，最长 waitMs */
  async waitReleased(waitMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (!fs.existsSync(this.file)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }
}

/* -------------------------------------------------------------- 主体 */

function createSmsCredential(opts) {
  const {
    getStore,        // () => 存储对象（服务器里就是 state.smsCredential，只放状态与计数）
    putStore,        // (obj) => void，写回并落盘
    probeToken,      // async () => { resultCode, resultDesc, creditToken, expireTime, authPageUrl }
    sendRaw,         // async (text, token) => { ok, out, netErr, httpStatus }
    onLog,           // ({ level, source, msg, detail }) => void
    onAlert,         // async ({ title, body }) => void
    lockDir,         // 文件锁目录
    quota,           // 覆盖默认配额（仅自测用；生产不传）
    retryDelays,     // 覆盖退避间隔（仅自测用）
    /*
     * 短期凭据的存储抽象 —— 生产由 lib/credential-vault.js 的 shortterm 分区实现。
     * 令牌本体只存在保险库里，state.smsCredential 里连密文都不放：
     * 这样「状态」与「凭据」在物理上就是两份东西，符合「分开存储」。
     */
    tokenStore,
    audit,           // (event) => void 独立审计日志（append-only）
    hardExpiryDays,  // 无 refresh_token 方案的硬过期天数（绑定后 N 天必须人工重授权）
  } = opts;

  const Q = { ...QUOTA, ...(quota || {}) };
  const DELAYS = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : RETRY_DELAYS;
  const HARD_EXPIRY_DAYS = Number(hardExpiryDays) > 0 ? Number(hardExpiryDays) : 180;

  /*
   * 未注入 tokenStore 时的兜底（只给单测用）：纯内存，不落盘。
   * 生产环境如果没有注入，宁可发不出去，也不能把令牌散落在内存里 —— 见下方 warnOnce。
   */
  const tokens = tokenStore || (() => {
    let mem = '';
    return {
      read: () => ({ ok: true, value: mem }),
      write: (plain) => { mem = String(plain || ''); return { ok: true }; },
      clear: () => { mem = ''; return { ok: true }; },
      ephemeral: true,
    };
  })();

  const emitAudit = (event) => {
    if (typeof audit !== 'function') return;
    try { audit(event); } catch { /* 审计失败不阻断业务 */ }
  };
  const lock = new FileLock(path.join(lockDir, '.sms-refresh.lock'));
  let inflight = null;   // 进程内单飞：同一个 Promise 复用

  /* ---------------------------------------------------- 存储读写 */

  function blank() {
    return {
      id: 1,
      mobileHash: '',           // sha256(手机号 + salt)，不存明文
      /*
       * 注意：这里刻意没有任何 token 字段。
       * 令牌本体（以及长期凭据）存在 lib/credential-vault.js 的分区里，
       * 本对象只保存「状态与计数」——凭据与状态物理分离。
       */
      accessExpiresAt: 0,
      refreshExpiresAt: 0,
      /*
       * 初值 ACTIVE 而不是 NEED_REAUTH：
       * 「取令牌」(preAuth) 与「验证码授权」是两件事——本地已有绑定文件时 preAuth
       * 直接返回 103000，不需要扫码、不消耗验证码。若初值就判 NEED_REAUTH，
       * 全新部署永远发不出第一条，反而逼用户去点授权。
       * 真正的 NEED_REAUTH 只在 preAuth 明确回 103001 时由代码判定。
       */
      state: STATE.ACTIVE,
      // 硬过期：本通道无 refresh_token，必须设硬过期日，提前 7/3/1 天人工更换
      boundAt: 0,
      hardExpiresAt: 0,
      revokedAt: 0,
      expiryAlerts: {},         // { '7': ts, '3': ts, '1': ts } 已告警过的里程碑
      // 轮换记账
      lastRotatedAt: 0,
      rotateCount: 0,
      rotateWindowStart: 0,     // 当前 1 小时窗口的起点
      rotateWindowCount: 0,     // 窗口内的轮换次数（突增告警依据）
      lastSpikeAlertAt: 0,      // 上次突增告警时间（1 小时内只叫一次）
      lastRefreshedAt: 0,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      circuitLevel: 0,
      lastCircuitAt: 0,
      authRequestToday: 0, authHour: '', authDay: '',
      authRequestToday_hour: 0,
      smsSentToday: 0, smsDay: '',
      refreshCountToday: 0, refreshDay: '',
      /*
       * 授权检测（preAuth 探活）单独计数。
       * 为什么必须分开：检测与「发短信前取令牌」是两种完全不同的消耗。
       * 检测只是问一句「现在通了没」，用户连点几次都不该挤占发送额度 ——
       * 以前它和发送共用 refreshCountToday，一次扫码轮询 9 次就能把当天
       * 刷新额度打满，随后自动任务推送被本地拦下，表现为「授权好好的却发不出」。
       */
      probeCountToday: 0, probeDay: '',
      sendCountToday: 0, sendDay: '',
      lastSendAt: 0,
      lastDecision: null,       // 最近一次决策（只含非敏感值）
    };
  }

  function store() {
    const s = getStore();
    if (!s || typeof s !== 'object') return null;
    return s;
  }

  function ensure() {
    let s = store();
    if (!s) {
      s = blank();
      putStore(s);
    }
    // 补齐新增字段（老 state 升级时不丢数据）
    for (const [k, v] of Object.entries(blank())) {
      if (s[k] === undefined) s[k] = v;
    }
    return s;
  }

  function commit(s) {
    putStore(s);
  }

  /**
   * 状态迁移（唯一入口）。违反 FLOW 的迁移会被拒绝并记审计，绝不静默改字段。
   * 这是「不允许人工点按钮硬拉回 ACTIVE」的代码级保证：
   * 任何路由想改状态，都得经过这里过一遍流转表。
   */
  function transition(s, to, reason) {
    const from = s.state || STATE.ACTIVE;
    if (from === to) return { ok: true, from, to, changed: false };
    const allowed = FLOW[from] || [];
    if (!allowed.includes(to)) {
      log('warn', `拒绝非法的状态迁移 ${from} → ${to}（${scrub(reason || '')}）`);
      emitAudit({ event: 'state_transition_denied', from, to, reason: scrub(reason || ''), credential_id: s.id || 1 });
      return { ok: false, from, to, changed: false, reason: 'illegal_transition' };
    }
    s.state = to;
    if (to === STATE.REVOKED && !s.revokedAt) s.revokedAt = Date.now();
    log('info', `凭据状态 ${from} → ${to}（${scrub(reason || '')}）`);
    emitAudit({ event: 'state_transition', from, to, reason: scrub(reason || ''), credential_id: s.id || 1 });
    return { ok: true, from, to, changed: true };
  }

  /*
   * 「这个操作成功了」不等于「凭据生命周期回到正常」。
   * EXPIRING 是硬过期临近的客观事实，发一条短信成功并不会让它变远 ——
   * 若无条件 transition 到 ACTIVE，就会把到期风险抹掉。所以这里单独收口。
   */
  function markHealthy(s, reason) {
    if (s.state === STATE.EXPIRING) return { ok: true, from: s.state, to: s.state, changed: false };
    return transition(s, STATE.ACTIVE, reason);
  }

  /**
   * 轮换突增告警（规范第四条第 5 款）。
   *
   * `lastRotatedAt` + `rotateCount` 只是记账，真正有诊断价值的是「短时间换得太勤」：
   * 那通常意味着令牌被服务端反复判废，再换下去就是白烧 preAuth 配额、逼近 140005。
   *
   * 阈值取「1 小时 15 次」：日配额 24 次，一小时内烧掉一大半，一定不正常。
   * 同一小时内只叫一次，避免自己变成骚扰源。
   */
  function noteRotation(s) {
    const now = Date.now();
    const win = Number(s.rotateWindowStart) || 0;
    if (!win || now - win > 3600e3) { s.rotateWindowStart = now; s.rotateWindowCount = 0; }
    s.rotateWindowCount = (Number(s.rotateWindowCount) || 0) + 1;
    if (s.rotateWindowCount < ROTATE_SPIKE_PER_HOUR) return;
    if (now - (Number(s.lastSpikeAlertAt) || 0) < 3600e3) return;
    s.lastSpikeAlertAt = now;
    log('warn', `令牌轮换突增：1 小时内 ${s.rotateWindowCount} 次（阈值 ${ROTATE_SPIKE_PER_HOUR}）`, {
      rotateWindowCount: s.rotateWindowCount, rotateCount: s.rotateCount,
    });
    emitAudit({
      event: 'rotate_spike', credential_id: s.id || 1,
      rotate_in_hour: s.rotateWindowCount, rotate_total: s.rotateCount,
    });
    if (typeof onAlert === 'function') {
      Promise.resolve(onAlert({
        title: '短信令牌轮换异常频繁',
        body: `1 小时内刷新了 ${s.rotateWindowCount} 次令牌（日上限 ${Q.refreshPerDay} 次）。通常意味着令牌被服务端反复判废，继续下去会逼近频率限制，建议检查通道绑定状态。`,
      })).catch(() => { /* 告警失败不影响主流程 */ });
    }
  }

  /**
   * 硬过期检查：本通道没有 refresh_token，只能设硬过期日靠人工更换。
   * 提前 7/3/1 天各告警一次（walk 其他通道），到期即 NEED_REAUTH。
   */
  function checkHardExpiry(s) {
    const hard = Number(s.hardExpiresAt) || 0;
    if (!hard) return;
    const leftMs = hard - Date.now();
    if (leftMs <= 0) {
      if (s.state !== STATE.NEED_REAUTH && s.state !== STATE.REVOKED) {
        transition(s, STATE.NEED_REAUTH, 'hard_expiry_reached');
        tokens.clear();
        s.accessExpiresAt = 0;
        commit(s);
        if (typeof onAlert === 'function') {
          Promise.resolve(onAlert({
            title: '短信凭据已到硬过期日',
            body: `该通道无 refresh_token，凭据在 ${new Date(hard).toLocaleDateString('zh-CN')} 到期后必须人工重新扫码授权。系统已停止自动请求。`,
          })).catch(() => {});
        }
      }
      return;
    }
    const days = Math.ceil(leftMs / 86400e3);
    const hit = EXPIRY_MILESTONES.find((d) => days <= d && !(s.expiryAlerts && s.expiryAlerts[d]));
    if (!hit) return;
    s.expiryAlerts = s.expiryAlerts || {};
    s.expiryAlerts[hit] = Date.now();
    if (s.state === STATE.ACTIVE) transition(s, STATE.EXPIRING, `hard_expiry_in_${days}d`);
    commit(s);
    log('warn', `短信凭据将在 ${days} 天后到期，请提前重新授权`);
    emitAudit({ event: 'credential_expiring', days_left: days, hard_expires_at: hard, milestone: hit });
    if (typeof onAlert === 'function') {
      Promise.resolve(onAlert({
        title: `短信凭据 ${days} 天后到期`,
        body: `该通道没有 refresh_token，只能人工重新扫码授权。请在 ${new Date(hard).toLocaleDateString('zh-CN')} 前完成，否则短信会中断。`,
      })).catch(() => {});
    }
  }

  /** 按天重置计数器（跨天自动归零，避免"昨天用完了今天还锁") */
  function rollDay(s) {
    const d = dayKey();
    if (s.smsDay !== d) { s.smsDay = d; s.smsSentToday = 0; }
    if (s.sendDay !== d) { s.sendDay = d; s.sendCountToday = 0; }
    if (s.refreshDay !== d) { s.refreshDay = d; s.refreshCountToday = 0; }
    if (s.probeDay !== d) { s.probeDay = d; s.probeCountToday = 0; }
    /*
     * 授权日计数也必须按天归零。
     * 这里曾经漏掉：只重置了每小时计数，authRequestToday 一旦涨到上限就永久停在那里，
     * 界面永远提示「请明天再试」，第二天照样拒绝 —— 用户看到的就是「按钮点了没反应」。
     * 老状态没有 authDay 字段，升级后第一次 rollDay 会立即归零（等价于给一次新配额）。
     */
    if (s.authDay !== d) { s.authDay = d; s.authRequestToday = 0; }
    const h = hourKey();
    if (s.authHour !== h) { s.authHour = h; s.authRequestToday_hour = 0; }
    return s;
  }

  function log(level, msg, detail) {
    const dec = { ...(detail || {}) };
    for (const k of Object.keys(dec)) {
      if (/token|code|mobile|uuid|secret/i.test(k)) dec[k] = '***';
    }
    if (typeof onLog === 'function') onLog({ level, source: 'sms', msg: scrub(msg), detail: dec });
  }

  /** 结构化决策日志：event=token_decision action=... credential_id=1 reason=... */
  function decision(s, action, reason, extra) {
    const line = {
      event: 'token_decision',
      action,
      credential_id: s.id || 1,
      reason: scrub(reason || ''),
      state: s.state,
      next_allowed_at: s.circuitOpenUntil > Date.now() ? new Date(s.circuitOpenUntil).toISOString() : null,
      ...(extra || {}),
    };
    s.lastDecision = line;
    log('info', `token_decision action=${line.action} reason=${line.reason}`.slice(0, 200), line);
    return line;
  }

  /* ---------------------------------------------------- 熔断器 */

  function circuitRemaining(s) {
    const until = Number(s.circuitOpenUntil) || 0;
    return until > Date.now() ? until - Date.now() : 0;
  }

  function openCircuit(s, why) {
    rollDay(s);
    // 24h 内无新触发 → 阶梯归零
    if (!s.lastCircuitAt || Date.now() - s.lastCircuitAt > CIRCUIT_RESET_MS) s.circuitLevel = 0;
    s.circuitLevel = Math.min(CIRCUIT_STEPS.length, (Number(s.circuitLevel) || 0) + 1);
    const dur = CIRCUIT_STEPS[s.circuitLevel - 1];
    s.circuitOpenUntil = Date.now() + dur;
    s.lastCircuitAt = Date.now();
    transition(s, STATE.LOCKED, 'circuit_open · ' + scrub(why || ''));
    commit(s);
    emitAudit({
      event: 'circuit_open', credential_id: s.id || 1, level: s.circuitLevel,
      duration_sec: Math.round(dur / 1000), reason: scrub(why || ''),
      circuit_open_until: s.circuitOpenUntil,
    });
    const human = dur >= 3600e3 ? `${dur / 3600e3} 小时` : `${dur / 60e3} 分钟`;
    log('warn', `触发频率限制 ${FREQ_CODE}，进入熔断第 ${s.circuitLevel} 档（${human}），期间零网络请求`, {
      circuitLevel: s.circuitLevel, circuitOpenUntil: s.circuitOpenUntil, why: scrub(why),
    });
    // 熔断通知必须走别的通道（这里用站内 + 手机推送，不用短信本身）
    if (typeof onAlert === 'function') {
      Promise.resolve(onAlert({
        title: `短信通道已熔断 ${human}`,
        body: `收到移动侧频率限制（${FREQ_CODE}），已停止所有短信请求至 ${new Date(s.circuitOpenUntil).toLocaleString('zh-CN', { hour12: false })}。期间不会产生任何出站调用，到期后只放行 1 次探测。`,
      })).catch(() => { /* 告警本身失败不影响熔断 */ });
    }
    return { ok: false, blocked: true, message: `短信通道熔断中（第 ${s.circuitLevel} 档），剩余 ${human}，不发任何请求` };
  }

  /** 熔断到期 → 只放行一次探测，成功才恢复 ACTIVE */
  function circuitExpiredWithProbePending(s) {
    const until = Number(s.circuitOpenUntil) || 0;
    return until > 0 && until <= Date.now() && s.state === STATE.LOCKED;
  }

  /* ---------------------------------------------------- 配额闸门 */

  /**
   * 发送配额。返回 { block } = 本地拒绝，{ warning } = 照发但提醒，null = 无话可说。
   * manual=true（人点的「发送测试」）默认只提醒；自动任务仍按配额拦。
   */
  function checkSendQuota(s, manual) {
    rollDay(s);
    const soft = STRICT ? false : !!manual;
    if (s.sendCountToday >= Q.sendPerDay) {
      const msg = `今日已发 ${s.sendCountToday} 条短信（提示线 ${Q.sendPerDay} 条）`;
      if (soft) return { warning: msg + '，本次仍会发出' };
      return { block: msg + '，已本地拦下未发请求。确需继续请手动点「发送测试」，或设 CRONHUB_SMS_STRICT=0' };
    }
    const gap = Date.now() - (Number(s.lastSendAt) || 0);
    if (gap < Q.sendGapMs) {
      const w = Math.ceil((Q.sendGapMs - gap) / 1000);
      const msg = `距上一条短信仅 ${Math.round(gap / 1000)} 秒（建议间隔 ≥ ${Q.sendGapMs / 1000} 秒）`;
      if (soft) return { warning: msg + '，本次仍会发出' };
      return { block: msg + `，请 ${w} 秒后再试` };
    }
    return null;
  }

  function checkRefreshQuota(s, manual) {
    rollDay(s);
    if (s.refreshCountToday >= Q.refreshPerDay) {
      const msg = `今日令牌刷新 ${s.refreshCountToday} 次（提示线 ${Q.refreshPerDay} 次）`;
      if (STRICT || !manual) return { block: msg + '，已本地拦下未发请求' };
      return { warning: msg + '，本次仍会继续' };
    }
    return null;
  }

  /**
   * 授权配额。默认**永不拦人**，只在超出提示线时回一句 warning。
   * 手动点「扫码重新授权」是人的明确意图，本地没有资格替人拒绝。
   */
  function checkAuthQuota(s, manual) {
    rollDay(s);
    const dayLine = Q.authPerDay;
    const hourLine = Q.authPerHour;
    if (s.authRequestToday >= dayLine) {
      const msg = `今日已发起 ${s.authRequestToday} 次授权（提示线 ${dayLine} 次，每次消耗一条验证码）`;
      if (STRICT) return { block: msg + '，今日不再放行' };
      return { warning: msg + '，仍继续' };
    }
    if ((s.authRequestToday_hour || 0) >= hourLine) {
      const msg = `本小时已发起 ${s.authRequestToday_hour} 次授权（提示线 ${hourLine} 次/小时）`;
      if (STRICT) return { block: msg + '，请稍后再试' };
      return { warning: msg + '，仍继续' };
    }
    if (s.authRequestToday >= Q.authSoftPerDay) {
      return {
        warning: `今日已发起 ${s.authRequestToday} 次授权（建议不超过 ${Q.authSoftPerDay} 次），本次继续会再消耗一条验证码`,
      };
    }
    return null;
  }

  /* ---------------------------------------------------- 令牌获取 */

  /*
   * 令牌只在需要的瞬间从保险库解出，用完即弃：
   * 这里不缓存返回值、不放进模块级变量，避免「进程内长期持有明文」。
   * 解不出来时区分两种情况——「没有/过期」与「保险库坏了」，后者必须 fail-safe。
   */
  let tokenReadError = '';

  /*
   * 轮询检测静默开关：checkAuth 每几秒一次 preAuth，若还没扫完就会一直返回 103001，
   * 那条路径会给用户推「授权已失效」的系统通知 —— 一分钟十来条，纯噪音。
   * 只抑制通知，状态机与日志照常记录。
   */
  let quietProbe = false;

  function currentToken(s) {
    tokenReadError = '';
    if (!s.accessExpiresAt) return '';
    if (Date.now() >= s.accessExpiresAt) return '';
    const r = tokens.read();
    if (!r.ok) {
      tokenReadError = r.message || `凭据保险库异常（${r.error || 'unknown'}）`;
      return '';
    }
    return r.value || '';
  }

  function refreshMargin(s) {
    const ttl = Math.max(0, (Number(s.accessExpiresAt) || 0) - (Number(s.lastRefreshedAt) || 0));
    if (!ttl) return MIN_REFRESH_MARGIN_MS;
    return Math.max(MIN_REFRESH_MARGIN_MS, Math.min(MAX_REFRESH_MARGIN_MS, Math.round(ttl * 0.2)));
  }

  /** 令牌足够新就直接用（这是"刷新次数 = 0"的来源） */
  function tokenUsable(s) {
    const t = currentToken(s);
    if (!t) return '';
    const margin = refreshMargin(s);
    if (Date.now() < s.accessExpiresAt - margin) return t;
    return '';
  }

  function ttlMs(expireTime) {
    // expireTime 格式不确定：>1e12 = 毫秒时间戳；>1e9 = 秒时间戳；小数值 = 相对秒数
    const n = Number(expireTime);
    let ms = 5 * 60000;
    if (Number.isFinite(n) && n > 1e12) ms = n - Date.now();
    else if (Number.isFinite(n) && n > 1e9) ms = n * 1000 - Date.now();
    else if (Number.isFinite(n) && n > 0) ms = n * 1000;
    return Math.max(60e3, Math.min(ms, 25 * 60e3));
  }

  /**
   * 真正的"刷新"：一次 preAuth。
   * 调用方必须已经确认过配额与熔断状态。
   */
  async function doRefresh(s, reason) {
    rollDay(s);
    /*
     * 检测（auth_check）只记到 probeCountToday，不占 refreshCountToday。
     * refreshCountToday 是「为发短信而取令牌」的额度，它的上限会拦自动任务；
     * 检测是只读探活，不该有资格把发送额度吃掉。
     */
    if (reason === 'auth_check') {
      s.probeCountToday = (Number(s.probeCountToday) || 0) + 1;
    } else {
      s.refreshCountToday = (Number(s.refreshCountToday) || 0) + 1;
    }
    s.lastRefreshedAt = Date.now();
    commit(s);

    let probe;
    try {
      probe = await Promise.race([
        probeToken(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe_timeout')), PROBE_TIMEOUT_MS)),
      ]);
    } catch (e) {
      /*
       * 应用凭据缺失是「我们自己库里没值」，在调用子进程之前就被拦下了，
       * 一次网络请求都没发出去。必须与网络异常分开，否则会被归类成
       * 「取令牌异常」当成偶发故障反复重试，还白占刷新配额。
       */
      if (e && e.code === 'APP_CRED_MISSING') {
        transition(s, STATE.NEED_REAUTH, '应用凭据缺失');
        commit(s);
        decision(s, 'need_reauth', '应用凭据缺失：保险库 app 分区无 code');
        log('error', '应用凭据缺失：已拒绝调用短信子进程（本地配置问题，非网络故障）');
        return {
          ok: false,
          needReauth: true,
          appCredMissing: true,
          missing: e.missing || ['code', 'kid', 'strategyId'],
          message: e.message,
        };
      }
      /* 规范第三节第 3 条：重抛/记录前必须清洗 message。
         探测链路会打印服务端原始响应，其中偶有回显 Authorization 或令牌片段，
         不清洗就直接进了日志与告警正文。 */
      const raw = e && e.message === 'probe_timeout' ? '取令牌超时（10s）' : `取令牌异常：${scrub(e && e.message)}`;
      const msg = scrub(raw);
      s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
      commit(s);
      decision(s, 'refresh', msg);
      return { ok: false, message: msg + '，本次不发消息' };
    }

    const code = String(probe.resultCode || '');

    // 103000：拿到令牌
    if (code === '103000' && probe.creditToken) {
      /*
       * 拿到令牌 = 服务端已经认这次绑定。
       * 如果此前是 NEED_REAUTH / REVOKED，这就是「人工扫码成功」的证据，
       * 必须在这里回到 ACTIVE —— 否则用户扫完码、令牌也拿到了，状态却死锁在
       * REVOKED（FLOW 里 REVOKED 是终态），页面永远显示「已吊销」，等于重扫无效。
       * 这不是「点按钮硬拉回」：只有 preAuth 真的返回 103000 + creditToken 才走到这里。
       */
      if (s.state === STATE.NEED_REAUTH || s.state === STATE.REVOKED) {
        const from = s.state;
        s.state = STATE.ACTIVE;
        s.boundAt = Date.now();
        s.hardExpiresAt = s.boundAt + HARD_EXPIRY_DAYS * 86400e3;
        s.expiryAlerts = {};
        s.revokedAt = 0;
        s.circuitOpenUntil = 0;
        s.circuitLevel = 0;
        s.lastRotatedAt = Date.now();
        s.rotateCount = (Number(s.rotateCount) || 0) + 1;
        emitAudit({
          event: 'credential_rebound', credential_id: s.id || 1, from, to: STATE.ACTIVE,
          hard_expires_at: s.hardExpiresAt, via: 'preauth_103000',
        });
        log('info', `凭据重新绑定成功（${from} → ACTIVE）：preAuth 已返回令牌`);
      }
      // 令牌只写进保险库分区，state 里不留任何密文
      const w = tokens.write(probe.creditToken);
      if (!w || w.ok === false) {
        // 写不进去（密钥缺失 / 磁盘不可写）→ 宁愿这次不发，也不降级到明文或内存
        s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
        commit(s);
        decision(s, 'refresh', 'token_store_write_failed');
        return { ok: false, message: (w && w.message) || '凭据保险库写入失败，本次不发消息' };
      }
      s.accessExpiresAt = Date.now() + ttlMs(probe.expireTime);
      s.lastRefreshedAt = Date.now();
      s.consecutiveFailures = 0;
      // 首次成功取到令牌 = 完成一次绑定；据此落硬过期日（无 refresh_token 方案必备）
      if (!s.boundAt) {
        s.boundAt = Date.now();
        s.hardExpiresAt = s.boundAt + HARD_EXPIRY_DAYS * 86400e3;
      }
      markHealthy(s, 'token_obtained');
      s.circuitOpenUntil = 0;       // 成功即视为熔断结束
      s.lastRotatedAt = Date.now();
      s.rotateCount = (Number(s.rotateCount) || 0) + 1;
      noteRotation(s);              // 1 小时内换太勤会告警（不阻断）
      commit(s);
      decision(s, 'refresh', reason || 'token_missing');
      emitAudit({
        event: 'token_rotated', credential_id: s.id || 1, action: 'refresh',
        reason: scrub(reason || 'token_missing'), rotate_count: s.rotateCount,
        ttl_sec: Math.round((s.accessExpiresAt - Date.now()) / 1000),
      });
      return { ok: true, token: probe.creditToken };
    }

    // 103001：需要人工授权 → 停止一切自动尝试
    if (code === '103001') {
      transition(s, STATE.NEED_REAUTH, 'preAuth 103001');
      tokens.clear();
      s.accessExpiresAt = 0;
      commit(s);
      decision(s, 'need_reauth', 'preAuth 返回 103001');
      log('warn', '凭据需人工重新授权：已停止所有自动请求，等待管理员扫码');
      // 轮询检测（checkAuth）期间不要反复推「授权已失效」——那是用户自己知道的
      if (typeof onAlert === 'function' && !quietProbe) {
        Promise.resolve(onAlert({
          title: '短信授权已失效',
          body: '需要管理员用手机扫码重新授权，系统已停止所有自动短信请求（不会反复重试）。',
        })).catch(() => {});
      }
      return {
        ok: false,
        needReauth: true,
        message: '短信授权已失效，需管理员重新扫码授权（系统已停止自动重试）',
        /*
         * 授权页链接必须从这里带出去。
         * 以前只让上层去读「上一次缓存的链接」，而缓存是在这次调用返回之后才写的，
         * 于是第一次点击拿到的永远是空串 —— 页面看起来像「点了没反应」。
         */
        authPageUrl: probe.authPageUrl || '',
      };
    }

    /*
     * 130088 uuid 未授权 —— 这是「半途状态」，不是错误。
     *
     * 语义：本地存着一个 uuid（上一次 preAuth 发出去的授权流程标识），
     * 但平台侧对应那次授权**没有完成**（用户没扫、扫了旧链接、或扫码后平台没记上）。
     * 平台对「已发链接但未完成的 uuid」不会再返回 103001，而是直接说未授权。
     *
     * 以前它落进「其他 4xx → 不再重试」，于是永远卡死：
     * 带 uuid → 130088；不带 uuid 又没人清它 → 死循环，用户扫多少次都是「未授权」。
     * 现在标记 staleUuid，由上层清掉这个 uuid 后重新取一条可扫的链接。
     */
    if (code === '130088') {
      transition(s, STATE.NEED_REAUTH, 'preAuth 130088 uuid未授权');
      tokens.clear();
      s.accessExpiresAt = 0;
      commit(s);
      decision(s, 'need_reauth', '130088 uuid未授权：本地 uuid 对应的扫码未完成，需换新链接');
      log('warn', '本地 uuid 处于「已发链接但未完成授权」状态，将丢弃它并重新取授权链接');
      return {
        ok: false,
        needReauth: true,
        staleUuid: true,
        message: '这个设备身份还没有完成手机号绑定（上次的授权链接没走完），需要重新获取链接再扫一次',
      };
    }

    /*
     * 200002 clientId 不能为空 —— 这不是网关故障，也不是「授权过期」。
     * 它意味着送进 preAuth 的应用凭据（code）是空串，压根没发出有效请求。
     * 上一轮线上就是这里卡死：吊销把 app 分区一起清了，页面只显示
     * 「取令牌失败（200002 clientId不能为空）」，看的人以为是网关抽风，实际是库里没值。
     * 这里单独识别、单独文案，并且不被计成「授权次数」（没请求就没有验证码成本）。
     */
    if (code === '200002') {
      transition(s, STATE.NEED_REAUTH, '应用凭据缺失 200002');
      commit(s);
      decision(s, 'need_reauth', '200002 clientId不能为空（保险库 app 分区缺 code）');
      log('error', '应用凭据缺失：保险库 app 分区的 code 为空，preAuth 无法完成签名');
      return {
        ok: false,
        needReauth: true,
        appCredMissing: true,
        missing: ['code', 'kid', 'strategyId'],
        message: '短信应用凭据缺失（code / clientId 为空），这不是网关或授权问题：'
          + '保险库里没有应用凭据，需要先写入 code / kid / strategyId，再重新扫码授权。',
      };
    }

    // 140005：频率限制 → 只熔断，禁止刷新、禁止重试
    if (code === FREQ_CODE || /频繁|too\s*frequent/i.test(String(probe.resultDesc || ''))) {
      tokens.clear();
      s.accessExpiresAt = 0;
      return openCircuit(s, `preAuth ${code} ${probe.resultDesc || ''}`);
    }

    // 5xx / 网络 → 可退避重试（由上层队列控制，这里只记失败）
    if (/^5\d\d$/.test(code) || code === '200005' || code === '200006') {
      s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
      commit(s);
      decision(s, 'refresh', `${code} ${probe.resultDesc || ''}`);
      return { ok: false, retryable: true, message: `取令牌失败（${code} ${probe.resultDesc || ''}），可退避重试` };
    }

    // 其他 4xx / 未知码 → 不重试，直接失败
    s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
    commit(s);
    decision(s, 'refresh', `${code} ${probe.resultDesc || ''}`);
    return { ok: false, message: `取令牌失败（${code} ${probe.resultDesc || '未知错误'}），不再重试` };
  }

  /**
   * 单飞保障的令牌获取。
   * 100 个并发只产生 1 次 preAuth：进程内复用 Promise，跨进程用文件锁。
   */
  async function ensureToken(reason, opt) {
    const manual = !!(opt && opt.manual);
    let s = ensure();
    rollDay(s);
    // 硬过期检查：到期会把状态推到 NEED_REAUTH，提前 7/3/1 天各告警一次
    checkHardExpiry(s);

    // 0) 已吊销：人工未处理前，任何请求都不发
    if (s.state === STATE.REVOKED) {
      decision(s, 'revoked', 'state=REVOKED，等待人工重新绑定');
      commit(s);
      return { ok: false, needReauth: true, revoked: true, message: '短信凭据已被吊销，需管理员重新绑定后才能发送' };
    }

    // 1) 熔断期内：零网络请求，直接本地失败
    const remain = circuitRemaining(s);
    if (remain > 0) {
      decision(s, 'circuit_block', `circuit active, ${Math.ceil(remain / 1000)}s left`);
      commit(s);
      const h = remain >= 3600e3 ? `${(remain / 3600e3).toFixed(1)} 小时` : `${Math.ceil(remain / 60e3)} 分钟`;
      return { ok: false, blocked: true, message: `短信通道熔断中（第 ${s.circuitLevel} 档），剩余约 ${h}，期间不发任何请求` };
    }

    // 2) 需要人工授权：直接失败，不发请求
    if (s.state === STATE.NEED_REAUTH) {
      decision(s, 'need_reauth', 'state=NEED_REAUTH');
      commit(s);
      return { ok: false, needReauth: true, message: '短信授权已失效，需管理员重新扫码授权（系统不会自动重试）' };
    }

    // 3) 令牌够新 → 复用（这是"刷新 0 次"的关键路径）
    const usable = tokenUsable(s);
    if (usable) {
      decision(s, 'reuse', reason || 'token_valid');
      commit(s);
      return { ok: true, token: usable };
    }

    /*
     * 3.5) fail-safe：保险库坏了（主密钥缺失 / 密文损坏）时，
     * 绝不能当成「令牌过期」再走一次 preAuth —— 那只会白烧配额，
     * 而且真正的错误（密钥丢了）会被掩盖成「取令牌失败」。
     * 这里直接返回明确错误，让上层拒绝发送。
     */
    if (tokenReadError) {
      decision(s, 'vault_block', tokenReadError);
      commit(s);
      return { ok: false, blocked: true, vaultError: true, message: tokenReadError };
    }

    // 4) 需要刷新 → 配额（手动触发的动作只提示，自动任务仍拦）
    const q = checkRefreshQuota(s, manual);
    if (q && q.block) {
      decision(s, 'circuit_block', q.block);
      commit(s);
      return { ok: false, blocked: true, message: q.block };
    }
    if (q && q.warning) {
      log('warn', q.warning);
      decision(s, 'refresh', q.warning);
      commit(s);
    }

    // 5) 进程内单飞
    if (inflight) {
      log('info', '令牌刷新进行中，复用同一次请求（单飞）');
      return inflight;
    }

    // 6) 跨进程文件锁
    inflight = (async () => {
      const got = lock.tryAcquire();
      if (!got) {
        log('info', '另一个进程正在刷新令牌，等待结果（最长 15s）');
        const released = await lock.waitReleased(LOCK_WAIT_MS);
        if (!released) {
          return { ok: false, message: '等待其他进程刷新令牌超时（15s），本次不发消息，且不会再自己发请求' };
        }
        // 别的进程刷完了，重新读共享存储
        const s2 = ensure();
        const t = currentToken(s2);
        if (t && Date.now() < s2.accessExpiresAt) {
          decision(s2, 'reuse', 'refreshed_by_peer');
          commit(s2);
          return { ok: true, token: t };
        }
        return { ok: false, message: '其他进程刷新未成功，本次不发消息' };
      }
      try {
        const s3 = ensure();
        // 双检：拿锁期间可能已被别的进程刷好
        const t = tokenUsable(s3);
        if (t) {
          decision(s3, 'reuse', 'double_check_hit');
          commit(s3);
          return { ok: true, token: t };
        }
        return await doRefresh(s3, reason || 'token_expired');
      } finally {
        lock.release();
        inflight = null;
      }
    })();

    return inflight;
  }

  /* ---------------------------------------------------- 发送 */

  /**
   * 判定发送结果属于哪一类错误。
   * 顺序很重要：140005 必须最先判（它含 "40" 片段，晚了会被误判成鉴权失败再触发刷新）。
   */
  function classify(out, httpStatus) {
    const txt = String(out || '');
    if (txt.includes('✅ 发送成功')) return { kind: 'ok' };
    // 逐号码失败（外层 10200 但个别号码被平台安全控制拒绝）是终态：
    // 必须先于 auth/net 判定 —— resultDesc 里若含「未授权/401」等字样，
    // 会被误判成令牌失效而触发刷新+重试，白烧一次发送配额。
    // 其中「Security control」是平台侧同步未完成的已知瞬态（文档风险 7：
    // 重新授权后几分钟自愈），单独分类按网络节奏重试；其余逐号码失败不重试。
    if (/部分号码发送失败/.test(txt)) {
      return /security\s*control|安全控制/i.test(txt) ? { kind: 'secctl' } : { kind: 'fatal' };
    }
    // 1) 频率限制：只熔断，绝不重试
    if (txt.includes(FREQ_CODE) || /频繁|too\s*frequent/i.test(txt)) return { kind: 'freq' };
    // 2) 服务端 / 网络：「HTTP 502 Bad Gateway」里 5xx 不在行首，不能只锚 ^
    if (/(?:^|\s|HTTP[\/\s]*)5\d\d(?:\s|$)/i.test(txt)
      || /(?:^|\s)20000[56](?:\s|$)/.test(txt)
      || /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|网络/i.test(txt)) return { kind: 'net' };
    // 3) 令牌失效：走一次刷新，不重新授权（\b 防止把 1403 这类数字串里的 403 认成 403）
    if (/\b(?:401|403)\b|invalid_token|token.*失效|未授权|授权已过期/i.test(txt)) return { kind: 'auth' };
    return { kind: 'fatal' };
  }

  async function sendOnce(text, reason, opt) {
    const manual = !!(opt && opt.manual);
    const got = await ensureToken(reason, { manual });
    if (!got.ok) return got;

    /*
     * 重试节奏按场景分开：
     * - 自动推送（任务触发）：失败退避 60s → 300s，上游抖动时多试几次值得；
     * - 手动测试（设置页按钮）：人当面等着看结果，60 秒退避等于让请求挂到
     *   前端 30 秒超时被掐断，表现为「点了发送测试没反应」。
     *   所以 manual 只快速重试 1 次（3 秒后），失败立刻把原因交回给页面。
     * sendRaw 透传 manual，调用方可把单次发送超时也缩短（server.js 20s）。
     */
    const delays = manual ? [3000] : DELAYS;
    let lastErr = null;
    let netFail = false;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1] || delays[delays.length - 1]));
        // 重试前重新取令牌（可能已过期），但不再走 preAuth 的无限循环
        const again = await ensureToken('retry', { manual });
        if (!again.ok) return again;
        got.token = again.token;
      }

      const r = await sendRaw(text, got.token, { manual });
      const c = classify(r.out, r.httpStatus);

      if (c.kind === 'ok') {
        const s = ensure();
        rollDay(s);
        s.sendCountToday = (Number(s.sendCountToday) || 0) + 1;
        s.smsSentToday = (Number(s.smsSentToday) || 0) + 1;
        s.lastSendAt = Date.now();
        s.consecutiveFailures = 0;
        markHealthy(s, 'send_ok');
        commit(s);
        // dry-run 必须如实回执：不能显示「已发送」，否则用户以为真发出去了
        const dry = !!r.dryRun;
        decision(s, dry ? 'dry_run' : 'reuse', dry ? 'send_dry_run' : 'send_ok');
        emitAudit({
          event: dry ? 'sms_dry_run' : 'sms_sent', credential_id: s.id || 1, attempt: attempt + 1,
          text_length: String(text || '').length, send_count_today: s.sendCountToday,
        });
        return { ok: true, dryRun: dry, message: dry ? '短信已模拟发送（dry-run，未真实发出，未消耗生产配额）' : '短信已发送' };
      }

      // 140005：只熔断，禁止刷新、禁止重试
      if (c.kind === 'freq') {
        const s = ensure();
        return openCircuit(s, 'send 返回 ' + FREQ_CODE);
      }

      // 401 / invalid_token：清掉本地令牌，走一次刷新（不重授权）
      if (c.kind === 'auth') {
        const s = ensure();
        tokens.clear();
        s.accessExpiresAt = 0;
        commit(s);
        lastErr = '短信令牌被判定无效';
        if (attempt >= 1) break; // 只允许一次刷新后重试
        log('warn', '短信令牌被服务端判定无效，清缓存后刷新一次');
        continue;
      }

      // 网络 / 5xx / 超时：退避重试
      if (c.kind === 'net') {
        ackFail(ensure());
        lastErr = scrub(r.out) || '网络异常';
        netFail = true;
        log('warn', `发送失败（网络，第 ${attempt + 1} 次）：${lastErr.slice(0, 160)}`);
        continue;
      }

      // 平台安全控制瞬态（重新授权后几分钟内同步未完成）：
      // 与网络异常同节奏退避重试，最多也就 2 次；重试仍失败就落到「已重试」出口
      if (c.kind === 'secctl') {
        ackFail(ensure());
        lastErr = scrub(r.out) || '平台安全控制拒绝';
        log('warn', `发送失败（安全控制瞬态，第 ${attempt + 1} 次）：${lastErr.slice(0, 160)}`);
        continue;
      }

      // 其他 4xx：不重试，进死信队列并告警
      ackFail(ensure());
      lastErr = scrub(r.out) || '未知错误';
      log('error', `发送失败（终态，不重试）：${lastErr.slice(0, 160)}`);
      const s = ensure();
      if (!Array.isArray(s.deadLetters)) s.deadLetters = [];
      s.deadLetters.unshift({ at: Date.now(), text: scrub(text), err: lastErr });
      s.deadLetters = s.deadLetters.slice(0, 20);
      commit(s);
      if (typeof onAlert === 'function') {
        Promise.resolve(onAlert({ title: '短信发送失败（参数错误）', body: `已进入死信队列不再重试：${lastErr}` })).catch(() => {});
      }
      return { ok: false, message: '短信发送失败：' + lastErr };
    }

    // 手动测试快速失败时的提示要能指路：secctl 是重新授权后几分钟内会自愈的瞬态
    if (manual && /security\s*control|安全控制/i.test(lastErr || '')) {
      log('error', `手动发送测试最终失败（安全控制瞬态）：${String(lastErr).slice(0, 160)}`);
      return { ok: false, message: '测试失败：平台安全控制暂未放行（刚重新授权后常见，几分钟内会自动恢复，稍后再测）' };
    }
    // 网络层连不上（HTTP 0 / ECONNRESET 等）：请求没到平台应用层，跟凭据与内容无关
    if (manual && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|HTTP 0|body 0 字节|连接超时|Socket 错误/i.test(lastErr || '')) {
      log('error', `手动发送测试最终失败（网络层连不上短信网关）：${String(lastErr).slice(0, 160)}`);
      return {
        ok: false,
        netFail: true,
        message: '测试失败：连不上短信网关（连接被重置，请求未到达平台）。这不是凭据或内容问题——'
          + '可点「链路诊断」确认探针是否同样失败，过几分钟重试；持续失败说明运行环境出网受阻。',
      };
    }
    log('error', `发送最终失败（已重试）：${String(lastErr || '未知错误').slice(0, 160)}`);
    return {
      ok: false,
      netFail: netFail || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|HTTP 0|body 0 字节|连接超时|Socket 错误/i.test(lastErr || ''),
      message: '短信发送失败（已重试）：' + (lastErr || '未知错误'),
    };
  }

  function ackFail(s) {
    s.consecutiveFailures = (Number(s.consecutiveFailures) || 0) + 1;
    commit(s);
  }

  /* ---------------------------------------------------- 对外 API */

  /** 发送一条短信（唯一入口，所有闸门都在里面） */
  /**
   * 本机发送通道领令牌（部署文档 §7.1 选项 A 落地）：
   * 发送网关对云端不可达，但认证服务（idaas）从云端可达——
   * preAuth 在云端做（凭据不出库），creditToken 随待发任务下发给本机 agent，
   * 真实发送在本机完成。令牌一次性使用，与本机本地凭据无关。
   */
  async function leaseToken() {
    const got = await ensureToken('agent_lease', { manual: false });
    if (!got.ok) return { ok: false, needReauth: !!got.needReauth, message: got.message || '取令牌失败' };
    if (!got.token) return { ok: false, message: '令牌为空' };
    return { ok: true, token: got.token };
  }

  async function send({ text, manual }) {
    const isManual = !!manual;
    const s = ensure();
    rollDay(s);
    /*
     * 保险库体检放在所有闸门之前。
     * 否则「密钥被换掉」会被「60 秒发送间隔」「配额已满」这类前置判断盖住，
     * 用户看到的提示与真实原因无关，排查方向直接被带偏。
     */
    if (typeof opts.checkVault === 'function') {
      let vh = null;
      try { vh = opts.checkVault(); } catch { vh = null; }
      if (vh && vh.ok === false) {
        decision(s, 'vault_block', vh.state || 'vault_unhealthy');
        commit(s);
        return { ok: false, skipped: true, vaultError: true, message: vh.message || '凭据保险库不可用，已拒绝发送' };
      }
    }
    // 硬过期：到期即推 NEED_REAUTH（只告警不阻断的 EXPIRING 不在这里拦）
    checkHardExpiry(s);

    // 已吊销优先：人工重新绑定前一律不发
    if (s.state === STATE.REVOKED) {
      decision(s, 'revoked', 'state=REVOKED');
      commit(s);
      return { ok: false, skipped: true, revoked: true, needReauth: true, message: '短信凭据已被吊销，需管理员重新绑定后才能发送' };
    }

    // 熔断优先：期间零网络请求
    const remain = circuitRemaining(s);
    if (remain > 0) {
      decision(s, 'circuit_block', 'circuit active');
      commit(s);
      const h = remain >= 3600e3 ? `${(remain / 3600e3).toFixed(1)} 小时` : `${Math.ceil(remain / 60e3)} 分钟`;
      return { ok: false, skipped: true, message: `短信通道熔断中（第 ${s.circuitLevel} 档），剩余约 ${h}，期间不发任何请求` };
    }
    if (s.state === STATE.NEED_REAUTH) {
      decision(s, 'need_reauth', 'state=NEED_REAUTH');
      commit(s);
      return { ok: false, skipped: true, needReauth: true, message: '短信授权已失效，需管理员重新扫码授权（系统不会自动重试）' };
    }

    /*
     * 本地配额：手动「发送测试」只提示不拦（人点的按钮，本地没资格替人拒绝）；
     * 自动推送仍按配额拦，避免任务异常时把号码刷爆。
     */
    const q = checkSendQuota(s, isManual);
    if (q && q.block) {
      decision(s, 'circuit_block', q.block);
      commit(s);
      return { ok: false, skipped: true, message: q.block };
    }
    const quotaWarning = (q && q.warning) || '';

    const sent = await sendOnce(text, 'send', { manual: isManual });
    if (quotaWarning) {
      log('warn', '已按提示继续发送：' + quotaWarning);
      return { ...sent, warning: [quotaWarning, sent && sent.warning].filter(Boolean).join('；') };
    }
    return sent;
  }

  /**
   * 吊销：泄露应急的唯一正确入口。
   * 清掉保险库里的短期令牌 + 长期凭据，状态推到 REVOKED（不可被动转正）。
   * 注意：这里不碰凭证以外的任何东西，也不发任何网络请求。
   */
  function revoke(reason) {
    const s = ensure();
    tokens.clear();
    s.accessExpiresAt = 0;
    transition(s, STATE.REVOKED, 'revoke · ' + scrub(reason || 'manual'));
    s.rotateCount = (Number(s.rotateCount) || 0) + 1;
    s.lastRotatedAt = Date.now();
    commit(s);
    emitAudit({ event: 'credential_revoked', credential_id: s.id || 1, reason: scrub(reason || 'manual') });
    log('warn', `凭据已被吊销（${scrub(reason || 'manual')}），在人工重新绑定前不会发出任何请求`);
    return { ok: true, state: s.state, at: Date.now() };
  }

  /**
   * 完成一次「全新绑定」：这是唯一允许 NEED_REAUTH / REVOKED 回到 ACTIVE 的路径。
   * 必须由人工扫码成功后调用，不是按钮直接改字段。
   */
  function completeRebind(meta) {
    const s = ensure();
    s.boundAt = Date.now();
    s.hardExpiresAt = s.boundAt + HARD_EXPIRY_DAYS * 86400e3;
    s.expiryAlerts = {};
    s.revokedAt = 0;
    s.consecutiveFailures = 0;
    s.circuitOpenUntil = 0;
    s.circuitLevel = 0;
    s.rotateCount = (Number(s.rotateCount) || 0) + 1;
    s.lastRotatedAt = Date.now();
    // 直接置位：这是一次全新的凭据生命周期，不是"回退"
    const from = s.state;
    s.state = STATE.ACTIVE;
    commit(s);
    log('info', `凭据已重新绑定（${from} → ACTIVE），硬过期 ${new Date(s.hardExpiresAt).toLocaleDateString('zh-CN')}`);
    emitAudit({
      event: 'credential_rebound', credential_id: s.id || 1, from, to: STATE.ACTIVE,
      hard_expires_at: s.hardExpiresAt, ...(meta || {}),
    });
    return { ok: true, hardExpiresAt: s.hardExpiresAt };
  }

  /**
   * 生成授权链接 —— **全局唯一可能消耗验证码的调用点**。
   * 手动入口（页面按钮）传 { manual: true }：按硬上限放行，只做提醒；
   * 自动入口不传，按软阈值判定，避免后台悄悄烧验证码额度。
   */
  async function requestAuthLink(req) {
    const manual = !!(req && req.manual);
    /*
     * verify=true：用户已经扫完码，来确认授权是否生效。
     * 它不是「再要一个授权页」，所以不占授权配额（只算一次 preAuth 刷新），
     * 否则「取链接 + 扫码后确认」一次就吃掉两次额度，一小时剩不下几次重试。
     */
    const verify = !!(req && req.verify);
    const s = ensure();
    rollDay(s);

    const remain = circuitRemaining(s);
    if (remain > 0) {
      const h = remain >= 3600e3 ? `${(remain / 3600e3).toFixed(1)} 小时` : `${Math.ceil(remain / 60e3)} 分钟`;
      return { ok: false, message: `熔断期内禁止重新授权（剩余约 ${h}）。熔断到期后系统会自动探测一次。` };
    }

    let warning = '';
    if (!verify) {
      const q = checkAuthQuota(s, manual);
      if (q && q.block) {
        decision(s, 'circuit_block', q.block);
        commit(s);
        return { ok: false, message: q.block };
      }
      warning = (q && q.warning) || '';
    }
    // 记录进来时的状态：重扫成功后要按「重新绑定」而不是「本来就没问题」来反馈
    const wasBroken = s.state === STATE.NEED_REAUTH || s.state === STATE.REVOKED;

    // 授权请求也计入刷新配额（它本身就是一次 preAuth），手动发起的只提示
    const rq = checkRefreshQuota(s, true);
    if (rq && rq.block) return { ok: false, message: rq.block };
    if (rq && rq.warning) warning = [warning, rq.warning].filter(Boolean).join('；');

    if (!verify) {
      s.authRequestToday = (Number(s.authRequestToday) || 0) + 1;
      s.authRequestToday_hour = (Number(s.authRequestToday_hour) || 0) + 1;
      commit(s);
    }

    // 清掉本地凭据，让服务端重新下发 uuid + authPageUrl
    // ⚠️ 只在「申请新链接」时做；verify 模式绝不能清 —— 那正是用户刚扫码写下的绑定文件
    if (!verify) {
      try {
        if (typeof opts.resetLocalCreds === 'function') await opts.resetLocalCreds();
      } catch { /* 清理失败也继续，preAuth 本身可能就返回 103001 */ }
    }

    let r = await doRefresh(s, 'manual_auth_request');
    /*
     * 130088：本地 uuid 是「发过链接但没扫完」的那个，平台不会再为它下发新链接。
     * 先丢掉这个 uuid 再取一次，才能拿到一条用户真正能扫的链接。
     * verify 也要走这条：它面对 130088 除了换链接没有别的出路。
     */
    if (r.staleUuid) {
      try {
        if (typeof opts.resetLocalCreds === 'function') await opts.resetLocalCreds();
      } catch { /* 清不掉也继续，下一次 preAuth 仍可能返回 103001 */ }
      r = await doRefresh(s, 'manual_auth_request_after_stale_uuid');
    }
    /*
     * 应用凭据缺失 = preAuth 在参数校验阶段就返回了，一次真实请求都没发出去，
     * 也就没消耗任何验证码额度 —— 这次不该记在「授权次数」头上。
     * 否则用户连点 10 次就把日配额烧光，却连一条授权链接都没看到（上一轮现场）。
     */
    if (r.appCredMissing) {
      if (!verify) {
        s.authRequestToday = Math.max(0, (Number(s.authRequestToday) || 0) - 1);
        s.authRequestToday_hour = Math.max(0, (Number(s.authRequestToday_hour) || 0) - 1);
        commit(s);
      }
      return {
        ok: false,
        appCredMissing: true,
        missing: r.missing || ['code', 'kid', 'strategyId'],
        message: r.message,
        warning,
        attempt: Number(s.authRequestToday) || 0,
      };
    }
    if (r.needReauth) {
      // 优先用本次 preAuth 刚返回的链接，取不到才退回上层缓存
      const page = r.authPageUrl || (opts.lastAuthPageUrl ? opts.lastAuthPageUrl() : '');
      return {
        ok: true,
        needScan: true,
        message: '请用手机打开授权链接完成验证',
        authPageUrl: page || '',
        warning,
        attempt: Number(s.authRequestToday) || 0,
      };
    }
    if (r.ok) {
      return {
        ok: true,
        needScan: false,
        rebound: wasBroken,
        message: wasBroken
          ? '✅ 重新绑定成功：已取到新令牌，短信通道恢复正常'
          : '凭据仍然有效，已自动续上，无需重新扫码',
        warning,
        attempt: Number(s.authRequestToday) || 0,
      };
    }
    return { ok: false, message: r.message, warning, attempt: Number(s.authRequestToday) || 0 };
  }

  /*
   * 授权状态检测 —— 只问「现在通了没有」，不动本地 uuid、不占授权配额。
   *
   * 和 requestAuthLink 的分工（这一条很关键）：
   *   · requestAuthLink 遇 130088 会清 uuid 再取一条新链接 —— 那是「换一张二维码」；
   *     扫描期间反复调它，会把用户手里正扫的那张作废。
   *   · checkAuth 只回状态、什么都不清，所以界面可以每几秒安全地调一次，
   *     用户扫完码后自动变绿，不用再手动点「我已扫码」。
   */
  async function checkAuth() {
    const s = ensure();
    rollDay(s);
    const remain = circuitRemaining(s);
    if (remain > 0) {
      const h = remain >= 3600e3 ? `${(remain / 3600e3).toFixed(1)} 小时` : `${Math.ceil(remain / 60e3)} 分钟`;
      return { ok: true, valid: false, blocked: true, message: `通道熔断中（剩余约 ${h}），到期后再检测` };
    }
    const wasBroken = s.state === STATE.NEED_REAUTH || s.state === STATE.REVOKED;
    quietProbe = true;
    let r;
    try { r = await doRefresh(s, 'auth_check'); } finally { quietProbe = false; }

    if (r && r.ok) {
      return {
        ok: true, valid: true, rebound: wasBroken,
        message: wasBroken ? '✅ 授权已生效，短信通道恢复正常' : '凭据有效，无需重新扫码',
      };
    }
    if (r && r.appCredMissing) {
      return { ok: false, valid: false, appCredMissing: true, missing: r.missing, message: r.message };
    }
    if (r && r.staleUuid) {
      /*
       * 130088 有两种含义，光看返回码分不出来：
       *   a) 链接刚发出去，用户还没扫（最常见，属于正常等待）
       *   b) 真扫了但平台没记上（这才叫失效）
       * 所以这里只如实说「还没完成绑定」，由前端按「二维码挂了多久」判断是否提示失效。
       * 说成「二维码已失效」会让刚生成 3 秒的码被判死，用户会以为程序坏了。
       */
      return {
        ok: true, valid: false, needScan: true, stale: true,
        message: '还没完成手机号绑定（平台未记录本次扫码）',
      };
    }
    if (r && r.needReauth) {
      return {
        ok: true, valid: false, needScan: true,
        authPageUrl: r.authPageUrl || '',
        message: '还没检测到手机端完成验证',
      };
    }
    return { ok: false, valid: false, message: (r && r.message) || '检测失败' };
  }

  /** 只读仪表盘：不含任何敏感值，也不提供任何"重试/重新授权"入口 */
  function status() {
    const s = ensure();
    rollDay(s);
    // 仪表盘必须反映真实生命周期：到期临近要在状态里看得见，不能只在发送时才算
    checkHardExpiry(s);
    commit(s);
    const remain = circuitRemaining(s);
    const hard = Number(s.hardExpiresAt) || 0;
    return {
      state: s.state,
      stateText: {
        ACTIVE: '正常',
        EXPIRING: '即将到期',
        NEED_REAUTH: '需重新授权',
        REVOKED: '已吊销',
        LOCKED: '熔断中',
      }[s.state] || s.state,
      hasRefreshToken: false,          // 本通道不提供 refresh_token，如实暴露
      refreshTokenNote: '该通道无 refresh_token 机制，授权为一次性绑定，令牌由 preAuth 现取；因此设硬过期日靠人工更换',
      tokenTtlSec: s.accessExpiresAt && s.lastRefreshedAt
        ? Math.max(0, Math.round((s.accessExpiresAt - s.lastRefreshedAt) / 1000))
        : 0,
      tokenExpiresInSec: s.accessExpiresAt ? Math.max(0, Math.round((s.accessExpiresAt - Date.now()) / 1000)) : 0,
      // 硬过期（长期凭据生命周期）
      boundAt: Number(s.boundAt) || 0,
      hardExpiresAt: hard,
      hardExpiresInDays: hard ? Math.max(0, Math.ceil((hard - Date.now()) / 86400e3)) : 0,
      revokedAt: Number(s.revokedAt) || 0,
      expiryAlerts: s.expiryAlerts || {},
      // 轮换记账
      lastRotatedAt: Number(s.lastRotatedAt) || 0,
      rotateCount: Number(s.rotateCount) || 0,
      circuit: {
        open: remain > 0,
        level: Number(s.circuitLevel) || 0,
        remainSec: Math.round(remain / 1000),
        until: s.circuitOpenUntil || 0,
      },
      today: {
        refreshCount: Number(s.refreshCountToday) || 0,
        refreshLimit: Q.refreshPerDay,
        // 只读探活次数：单独一档，不占 refreshLimit（见 blank() 里的说明）
        probeCount: Number(s.probeCountToday) || 0,
        sendCount: Number(s.sendCountToday) || 0,
        sendLimit: Q.sendPerDay,
        authCount: Number(s.authRequestToday) || 0,
        authLimit: Q.authPerDay,
        authSoftLimit: Q.authSoftPerDay,
        authHourCount: Number(s.authRequestToday_hour) || 0,
        authHourLimit: Q.authPerHour,
      },
      consecutiveFailures: Number(s.consecutiveFailures) || 0,
      lastRefreshedAt: s.lastRefreshedAt || 0,
      lastDecision: s.lastDecision || null,
      deadLetters: Array.isArray(s.deadLetters) ? s.deadLetters.length : 0,
      keyFromEnv: opts.keyFromEnv === true,
      // 生产环境若没注入保险库分区，令牌只活在内存里 —— 必须明着暴露，不能装作没问题
      tokenStoreEphemeral: !!tokens.ephemeral,
      quota: Q,
      circuitSteps: CIRCUIT_STEPS.map((ms) => ms / 60000),
      hardExpiryDays: HARD_EXPIRY_DAYS,
    };
  }

  /** 管理员清除死信 / 重置计数（不迁移状态到 ACTIVE，符合"不允许人工硬拉回"） */
  function clearDeadLetters() {
    const s = ensure();
    s.deadLetters = [];
    commit(s);
    return { ok: true };
  }

  return { send, leaseToken, requestAuthLink, checkAuth, status, clearDeadLetters, revoke, completeRebind, STATE, QUOTA };
}

/*
 * 不导出 Vault：它是废弃类，导出等于给任何 require 本模块的人一把解密入口。
 * 规范 II.1「业务代码不得直接访问凭据表」——导出加密器就是在开后门。
 */
module.exports = { createSmsCredential, STATE, FLOW, QUOTA, EXPIRY_MILESTONES, maskMobile, scrub };
