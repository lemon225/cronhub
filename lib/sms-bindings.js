'use strict';
/*
 * 短信「接收号码」绑定层。
 *
 * 为什么需要这一层：
 *   平台的授权记录绑在 (clawUid, uuid) 上，一条授权只能发给**本人那个号**。
 *   想同时发到两个手机号，就必须有两份独立授权 —— 两份 clawUid、两份 uuid/accessToken。
 *   原来是全局单份，于是「多号码」在数据层根本无处安放。
 *
 * 设计要点：
 *   1. 凭证仍在保险库里，但键名加绑定前缀（`b2:uuid` / `b2:clawUid` / `b2:creditToken`），
 *      应用凭据（code/kid/strategyId）是平台级身份，全局共用，不加前缀。
 *   2. 老部署是「无前缀单份」，首次启动做一次幂等迁移：值原样搬成 `b1:*`，
 *      并把它标记为主号码 —— 已经扫过的授权不会因为这次改版失效。
 *   3. 状态对象（ACTIVE/计数/熔断）跟着绑定走：每个号码有自己的熔断与配额，
 *      一个号被平台限流不该拖死另一个号。
 */

const crypto = require('crypto');

const MAX_BINDINGS = 5;
const DEFAULT_LABEL = '主号码';

/** 绑定 id 白名单：只允许 b + 数字，避免被当成键名注入保险库 */
const ID_RE = /^b[0-9]{1,3}$/;

function isValidId(id) {
  return ID_RE.test(String(id || ''));
}

function cleanLabel(s, fallback) {
  const v = String(s || '').replace(/[\r\n\t\u0000-\u001f]/g, ' ').trim().slice(0, 20);
  return v || fallback || '未命名号码';
}

function nextId(taken) {
  for (let i = 1; i <= 999; i++) {
    const id = 'b' + i;
    if (!taken.includes(id)) return id;
  }
  return 'b' + crypto.randomBytes(3).toString('hex');
}

/**
 * @param {object} deps
 * @param {() => object} deps.getState      取業務 state（含 settings / 绑定数组）
 * @param {(st:object)=>void} deps.putState 写回 state（不落盘，由调用方决定时机）
 * @param {() => void} deps.saveSync        同步落盘（迁移这种一次性动作要立刻生效）
 * @param {object} deps.longterm            保险库 longterm 分区
 * @param {object} deps.shortterm           保险库 shortterm 分区
 * @param {(e:object)=>void} [deps.onLog]
 * @param {(e:object)=>void} [deps.audit]
 */
function createBindings(deps) {
  const { getState, putState, saveSync, longterm, shortterm, onLog, audit } = deps;

  const log = (level, msg, detail) => {
    if (typeof onLog === 'function') {
      try { onLog({ level, source: 'sms', msg, detail }); } catch { /* 日志失败不影响业务 */ }
    }
  };
  const emit = (event) => {
    if (typeof audit !== 'function') return;
    try { audit(event); } catch { /* 审计失败不阻断业务 */ }
  };

  /* ---------------------------------------------------------- 键名 */

  const keyOf = (id, name) => `${id}:${name}`;

  /** 从保险库取值（带绑定前缀）；无前缀的老键只在迁移期用 */
  function vaultGet(id, name) {
    const sc = name === 'creditToken' ? shortterm : longterm;
    const r = sc.get(keyOf(id, name));
    return r && r.ok ? r.value : '';
  }
  function vaultSet(id, name, value) {
    const sc = name === 'creditToken' ? shortterm : longterm;
    return sc.set(keyOf(id, name), value);
  }
  function vaultDel(id, name) {
    const sc = name === 'creditToken' ? shortterm : longterm;
    return sc.remove(keyOf(id, name));
  }

  /* ---------------------------------------------------------- 结构 */

  function blankBinding(id, label) {
    return {
      id,
      label: cleanLabel(label, id === 'b1' ? DEFAULT_LABEL : ''),
      /*
       * 状态对象由 lib/sms-credential.js 自己补齐字段（它有 blank()）。
       * 这里只保证 cred 字段存在，避免实例化时拿到 undefined。
       */
      cred: null,
      createdAt: Date.now(),
    };
  }

  function list() {
    const st = getState();
    if (!Array.isArray(st.smsBindings)) st.smsBindings = [];
    return st.smsBindings;
  }

  /** 拿一条绑定（不创建）；id 缺省时返回第一条 */
  function get(id) {
    const arr = list();
    if (!id) return arr[0] || null;
    return arr.find((b) => b && b.id === id) || null;
  }

  function ids() {
    return list().map((b) => b && b.id).filter(Boolean);
  }

  /**
   * 幂等迁移：把老的「单份状态 + 无前缀凭据」搬成第一条绑定。
   * 关键点：值原样搬运，不做任何"重新生成" —— 重新生成 clawUid 等于换设备，
   * 用户刚扫过的授权会立刻作废（第 39 轮的坑）。
   */
  function ensure() {
    const st = getState();
    if (!Array.isArray(st.smsBindings)) st.smsBindings = [];

    let migrated = false;

    /*
     * 老部署：state.smsCredential 是单份状态对象。
     * 搬进第一条绑定后，顶层留一份 legacy 副本（不删），万一需要人工回溯还能看。
     */
    if (!st.smsBindings.length && st.smsCredential && typeof st.smsCredential === 'object') {
      const b = blankBinding('b1', DEFAULT_LABEL);
      b.cred = st.smsCredential;
      b.migratedFrom = 'state.smsCredential';
      st.smsBindings.push(b);
      st.smsCredentialLegacy = st.smsCredential;
      delete st.smsCredential;
      migrated = true;
      log('info', '已把单份短信凭据迁移为「接收号码 #1」，原有授权继续有效');
      emit({ event: 'bindings_migrated', from: 'state.smsCredential', binding_id: 'b1' });
    }

    /* 全新部署：建第一条空绑定，但状态留空由实例补齐 */
    if (!st.smsBindings.length) {
      st.smsBindings.push(blankBinding('b1', DEFAULT_LABEL));
      migrated = true;
    }

    /* 结构规范化：id / label / cred 都得在 */
    const seen = [];
    for (const b of st.smsBindings) {
      if (!b || typeof b !== 'object') continue;
      if (!isValidId(b.id) || seen.includes(b.id)) b.id = nextId(seen);
      seen.push(b.id);
      if (!b.label) b.label = cleanLabel('', b.id === 'b1' ? DEFAULT_LABEL : '');
      if (!b.createdAt) b.createdAt = Date.now();
      if (b.cred === undefined) b.cred = null;
    }

    /*
     * 保险库键迁移：无前缀的 uuid/clawUid/accessToken/creditToken → b1: 前缀。
     * 先读、再写、最后删旧键；任何一步失败都不删旧键，宁可留一份重复也不能丢。
     */
    const primary = st.smsBindings[0];
    if (primary) {
      for (const name of ['uuid', 'clawUid', 'accessToken', 'creditToken']) {
        const sc = name === 'creditToken' ? shortterm : longterm;
        if (!sc || typeof sc.get !== 'function') continue;
        const oldKey = name;
        const newKey = keyOf(primary.id, name);
        try {
          const cur = sc.get(newKey);
          if (cur && cur.ok && cur.value) continue;      // 已迁移过
          const legacy = sc.get(oldKey);
          if (!legacy || !legacy.ok || !legacy.value) continue;
          const w = sc.set(newKey, legacy.value);
          if (w && w.ok !== false) {
            sc.remove(oldKey);
            migrated = true;
            log('info', `凭据键已加绑定前缀：${oldKey} → ${newKey}`);
            emit({ event: 'vault_key_migrated', scope: name === 'creditToken' ? 'shortterm' : 'longterm', from: oldKey, to: newKey });
          }
        } catch { /* 单键迁移失败不影响启动，下次再试 */ }
      }
    }

    if (migrated) {
      putState(st);
      if (typeof saveSync === 'function') {
        try { saveSync(); } catch { /* 落盘失败由上层日志兜底 */ }
      }
    }
    return st.smsBindings;
  }

  /* ---------------------------------------------------------- 增删 */

  function add(opts = {}) {
    const st = getState();
    ensure();
    const arr = list();
    if (arr.length >= MAX_BINDINGS) {
      return { ok: false, message: `最多只能绑定 ${MAX_BINDINGS} 个号码` };
    }
    const id = nextId(ids());
    const b = blankBinding(id, opts.label);
    /*
     * 新号码一定是「待授权」：它还没有任何凭据，平台也不可能认识它。
     * 这里必须写死 NEED_REAUTH —— 用默认值 ACTIVE 会让列表显示「正常」，
     * 用户以为配好了，实际发的时候才发现要扫码（第 44 轮踩到的坑）。
     */
    b.cred = { state: 'NEED_REAUTH' };
    arr.push(b);
    putState(st);
    if (typeof saveSync === 'function') saveSync();
    log('info', `新增接收号码：${b.label}（${id}）`);
    emit({ event: 'binding_added', binding_id: id, label: b.label });
    return { ok: true, binding: b };
  }

  /**
   * 解绑：删状态 + 删该绑定的凭据，但**保留最后一条**。
   * 允许全删会让系统进入「没有任何号码」的尴尬态，反而不如留一个空壳等重新授权。
   */
  function remove(id) {
    const st = getState();
    ensure();
    const arr = list();
    if (arr.length <= 1) return { ok: false, message: '至少要保留一个接收号码' };
    const idx = arr.findIndex((b) => b && b.id === id);
    if (idx < 0) return { ok: false, message: '号码不存在' };
    const [gone] = arr.splice(idx, 1);
    for (const name of ['uuid', 'accessToken', 'clawUid', 'creditToken']) {
      try { vaultDel(gone.id, name); } catch { /* 删不掉也不阻断 */ }
    }
    putState(st);
    if (typeof saveSync === 'function') saveSync();
    log('info', `已解绑接收号码：${gone.label || gone.id}`);
    emit({ event: 'binding_removed', binding_id: gone.id, label: gone.label || '' });
    return { ok: true, removed: gone.id };
  }

  /** 默认绑定（第一条）的 id —— 老路由不带 binding 参数时用它 */
  function primaryId() {
    ensure();
    const arr = list();
    return (arr[0] && arr[0].id) || 'b1';
  }

  /** 把一批 id 规范化成「真实存在的绑定 id」，空则回落到主号码 */
  function resolveIds(input) {
    ensure();
    const arr = list();
    const all = arr.map((b) => b.id);
    const want = Array.isArray(input) ? input : (input ? [input] : []);
    const picked = want.filter((x) => all.includes(x));
    const unique = [...new Set(picked)];
    return unique.length ? unique : [primaryId()];
  }

  return {
    MAX_BINDINGS,
    DEFAULT_LABEL,
    ensure,
    list,
    get,
    ids,
    add,
    remove,
    primaryId,
    resolveIds,
    keyOf,
    vaultGet,
    vaultSet,
    vaultDel,
    isValidId,
    cleanLabel,
  };
}

module.exports = { createBindings, MAX_BINDINGS, isValidId };
