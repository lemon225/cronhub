'use strict';
/* CronHub 前端 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const S = {
  data: null,
  view: 'overview',
  taskFilter: 'all',
  taskQuery: '',
  inboxFilter: 'all',
  editingId: null,
  formType: 'http',
  schedRows: null,
  schedFocus: 0,
  nmMode: 'token',
  stepSeq: 0,
  busy: false,
  logTab: 'sys',
  sysInfo: null,
  sysLogs: [],
  sysMeta: null,
  sysLevel: 'all',
  sysSource: 'all',
  sysQuery: '',
  sysTimer: null,
  sorting: false, // 拖动排序进行中：此时跳过列表重绘，否则手指底下那张卡会被替换掉
  lastSortAt: 0, // 刚拖完的时间戳，用来吃掉尾随的那次 click
};

/* ------------------------------------------------------------ 工具 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yest = new Date(today.getTime() - 86400000);
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === yest.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDateTime(iso);
}

/*
 * 凭据回填规则：接口下发的一律是掩码（gw_18a2…9f3c / ••••••），
 * 掩码串**绝不能**写进输入框 —— 用户随手一点保存，掩码就被当成新凭据存回去，
 * 真的凭据从这一刻起就废了（后端虽然也有拦截，但不该让用户走到那一步）。
 * 所以：掩码 → 输入框留空 + placeholder 说明「留空 = 不修改」。
 */
function isMaskedVal(v) {
  const s = String(v == null ? '' : v);
  return !s || s === '••••' || s === '••••••' || s.includes('…');
}

/**
 * 把一个可能是掩码的凭据填进输入框：掩码就留空，只改提示语。
 * 注意「空值」不等于「已保存」：以前 isMaskedVal('') 也返回 true，
 * 导致从没存过凭据的框也会显示「已保存（已隐藏），留空则不修改」，纯属撒谎。
 */
function fillSecretField(sel, val, keepHint) {
  const el = $(sel);
  if (!el) return;
  const raw = String(val == null ? '' : val);
  const masked = isMaskedVal(raw) && !!raw;
  el.value = masked ? '' : raw;
  el.dataset.hasSecret = masked ? '1' : '';
  if (masked && keepHint) {
    el.placeholder = keepHint;
  }
}

/*
 * 服务端默认明文下发凭据（这些号泄露了损失也能接受），只有设了 CRONHUB_CRED_MASK=1
 * 才会打码。明文模式下「👁 换明文」按钮就是多余的，点了反而要输一道口令，所以藏起来；
 * 密码框也直接摊开，省得用户点开才发现是圆点。
 */
function credMaskedMode() {
  const m = S.data && S.data.meta;
  return !!(m && m.credMasked);
}

function applySecretMode() {
  const masked = credMaskedMode();
  const eye = $('#gwReveal');
  if (eye) eye.style.display = masked ? '' : 'none';
  const pass = $('#smtpPass');
  if (pass) pass.type = masked ? 'password' : 'text';
}

/**
 * 查看凭据明文（显式动作）。
 *
 * /api/state 里的 token 全是掩码，需要复制或核对时走这里：当场输管理口令，
 * 服务端返回一次明文，只写进输入框，不缓存、不进 localStorage。
 * 口令弹窗复用短信管理面那个（同一套交互），失败计数也在服务端统一算。
 */
async function revealSecret(keys, hint) {
  /*
   * 开放模式（站点没设管理口令）没有口令可输，直接发空口令：
   * 服务端在开放模式下放行并记审计。掩码在开放模式下依然有意义 ——
   * 它防的是截图、录屏、共享屏幕时的意外泄露，不是防访问者。
   */
  let pwd = '';
  if (authState && authState.passwordRequired) {
    pwd = await askSmsPassword(hint || '查看凭据需要管理口令');
    if (!pwd) return null;
  }
  try {
    const r = await fetch('/api/settings/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: pwd, keys }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      toast(data.error || '查看失败', 'warn');
      return null;
    }
    return data.values || {};
  } catch (e) {
    toast('查看失败：' + e.message, 'warn');
    return null;
  }
}

/** 「👁 显示」按钮的统一绑定：点一次拿明文填进目标输入框。 */
function bindRevealButton(btnSel, fieldSel, keys, hint) {
  const btn = $(btnSel);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const el = $(fieldSel);
    if (!el) return;
    if (el.value && !isMaskedVal(el.value)) {
      // 已经是明文了：再点一次收回（避免明文长期摊在屏幕上）
      el.value = '';
      btn.title = '显示';
      return;
    }
    btn.disabled = true;
    try {
      const vals = await revealSecret(keys, hint);
      if (!vals) return;
      const v = String(vals[keys[0]] || '');
      el.value = v;
      el.dataset.hasSecret = '';
      btn.title = '隐藏';
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * 推送格式决定凭据字段：
 *   NotifyMe → 显示 UUID / FCM 两个专用字段（二选一），藏掉通用 Token；
 *   其他格式 → 只显示通用 Token。
 * 以前两种情况共用「凭据」一个框、靠冒号猜类型，填错只能从 invalid UUID 反推，这里改掉。
 */
function syncWhTokenHint() {
  const el = $('#whFormat');
  if (!el) return;
  const isNm = el.value === 'notifyme';
  const tokenField = $('#whTokenField');
  const credFields = $('#whCredFields');
  const advFields = $('#whAdvFields');
  if (tokenField) tokenField.hidden = isNm;
  if (credFields) credFields.hidden = !isNm;
  if (advFields) advFields.hidden = !isNm;
  syncNmActionField('#whActionType', '#whActionField', '#whActionLabel', '#whActionHint', '#whAction');

  const tok = $('#whToken');
  // 已有存好的凭据时，输入框是空的（掩码不回填），提示语要说清「留空 = 不修改」
  if (tok && tok.dataset.hasSecret === '1' && !tok.value) {
    tok.placeholder = '已保存的凭据（已隐藏），留空则不修改；要替换就直接覆盖';
  } else {
    tok.placeholder = '目标服务用请求头鉴权时才填，随请求加 Authorization: Bearer 头';
  }
  for (const sel of ['#whUuid', '#whFcm']) {
    const box = $(sel);
    if (!box) continue;
    box.placeholder = box.dataset.hasSecret === '1' && !box.value
      ? '已保存（已隐藏），留空则不修改'
      : (sel === '#whUuid' ? '22 位，走新版网关 notifyme-server.wzn556.top' : '含冒号，走旧版网关 send-notifyme.521933.xyz');
  }
}

/* AI 供应商预设：选名称自动填接口地址与推荐模型 */
const AI_PROVIDERS = {
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
};

function guessAiProvider(baseUrl) {
  const b = String(baseUrl || '');
  for (const [k, v] of Object.entries(AI_PROVIDERS)) {
    if (b && b.replace(/\/+$/, '') === v.baseUrl) return k;
  }
  return '';
}

/**
 * 倒计时只求「大概知道」：分钟级给准数，小时/天一律约到整数。
 * 原来「2 时 41 分后」这种精确到分又把胶囊撑宽的写法，主页上既不必要也显松散。
 */
function untilTime(iso) {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return '即将';
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分`;
  if (m < 24 * 60) return `约 ${Math.max(1, Math.round(m / 60))} 时`;
  return `约 ${Math.max(1, Math.round(m / 1440))} 天`;
}

function durText(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 11v5M12 8v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  // 警告不能只靠颜色区分：以前 warn 借用 info 的圆形图标，色觉障碍/高对比模式下无法分辨
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L2.5 17.4A2 2 0 004.2 20.4h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4.5M12 17v.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8a6 6 0 10-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a1.8 1.8 0 003 0"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  http: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 007.5.5l2.5-2.5a5 5 0 00-7-7L11.5 5.5"/><path d="M14 11a5 5 0 00-7.5-.5L4 13a5 5 0 007 7l1.5-1.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6a1 1 0 001.5.87l11-6.8a1 1 0 000-1.74l-11-6.8A1 1 0 008 5.2z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16.5 3.5a2.1 2.1 0 013 3L7.5 18.5 3 20l1.5-4.5z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9L17.5 7"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.5 6.8a8 8 0 1011 0"/></svg>',
  // 微信式细线图钉：不用彩色 emoji，置顶态靠「浅灰整条 + 绿色开关」表达
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.8 3.6h6.4l-.8 5.6 3.1 3.1H6.5l3.1-3.1-.8-5.6z"/><path d="M12 12.3V20.4"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 11h5l1.5 2.5h5L16 11h5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 4 14L16 12h5"/></svg>',
  sleep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>',
};

/* ------------------------------------------------------------ API */

let authState = { authed: false, role: null };

async function api(path, opts = {}) {
  // timeout 可按调用场景放宽（如短信发送测试 90s）；错误文案跟随实际值
  const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 30000;
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s），请检查网络`);
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }

  if (res.status === 401) {
    // 只有「开了访问控制」时才跳回登录页；否则只是这次操作失败
    if (authState.passwordRequired) {
      showAuth('login');
      throw new Error(data.error || '登录已过期，请重新登录');
    }
    throw new Error(data.error || '密码不正确');
  }
  if (!res.ok) {
    // 带上服务端 payload（例如短信授权页地址），调用方才能做针对性引导
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------ 登录 */

function showAuth(mode) {
  $('#authScreen').hidden = false;
  $('#appRoot').hidden = true;
  $('#authLogin').hidden = mode !== 'login';
  $('#authSubtitle').textContent = mode === 'login' ? '管理员验证' : '定时任务控制中心';
  $('#authErr').textContent = '';
  setTimeout(() => {
    const el = $('#authPassword');
    if (el) el.focus();
  }, 80);
}

function showApp() {
  $('#authScreen').hidden = true;
  $('#appRoot').hidden = false;
}

/*
 * 启动时的身份判定：
 *  - 访问控制关闭（passwordRequired=false）：直接进，不等登录
 *  - 访问控制开启：必须先登录
 * 另外 URL 带 ?admin 时，即使已进入也弹一次管理员验证框（用于提权）
 */
async function checkAuth() {
  let r = { passwordRequired: false, authed: true, role: 'guest' };
  try {
    r = await api('/api/auth/status');
  } catch {
    /* 拿不到状态时按「直接进入」处理，避免整站打不开 */
  }
  authState = r;

  const wantsAdmin = /[?&]admin\b/.test(location.search);
  if (wantsAdmin && r.role !== 'admin') {
    showAuth('login');
    return false;
  }

  if (r.passwordRequired && !r.authed) {
    showAuth('login');
    return false;
  }

  applyRole(r.role);
  showApp();
  return true;
}

/** admin 身份才放出管理面板与「退出管理员」，普通访客连节点都不渲染。 */
function applyRole(role) {
  const admin = role === 'admin';
  document.body.classList.toggle('is-admin', admin);
  const card = $('#adminCard');
  if (card) card.hidden = !admin;
  const out = $('#logoutBtn');
  if (out) out.hidden = !admin;
  if (admin) loadAdmin();
}

async function loadAdmin() {
  try {
    const r = await api('/api/admin/audit');
    const p = r.process || {};
    $('#adminStats').innerHTML = `
      <div class="admin-item"><dt>角色</dt><dd>管理员</dd></div>
      <div class="admin-item"><dt>主密码</dt><dd>${r.forced && r.forced.passwordLocked ? '已锁定' : '可改'}</dd></div>
      <div class="admin-item"><dt>存储</dt><dd>${r.storage && r.storage.writable ? '可写' : '只读'}</dd></div>
      <div class="admin-item"><dt>内存</dt><dd>${esc(String(p.rssMb))} MB</dd></div>
      <div class="admin-item"><dt>端口</dt><dd>${esc(String(p.port))}</dd></div>
      <div class="admin-item"><dt>PID</dt><dd>${esc(String(p.pid))}</dd></div>`;
    const rows = r.entries || [];
    $('#adminAudit').innerHTML = rows.length
      ? rows.slice(0, 20).map((e) => `
        <div class="audit-row ${e.ok ? 'is-ok' : 'is-fail'}">
          <span class="audit-badge">${e.ok ? (e.role === 'admin' ? '管理' : '成功') : '失败'}</span>
          <span class="audit-ip">${esc(e.ip)}</span>
          <span class="audit-time">${esc(fmtDateTime(e.at))}</span>
        </div>`).join('')
      : '<p class="hint hint--block">还没有登录记录</p>';
  } catch {
    /* 非 admin 或接口不可用时静默 */
  }
}

async function doLogin() {
  const btn = $('#authLoginBtn');
  const pwd = $('#authPassword').value;
  if (!pwd) { $('#authErr').textContent = '请输入密码'; return; }
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    await api('/api/auth/login', { method: 'POST', body: { password: pwd } });
    $('#authPassword').value = '';
    // 验证后再问一次身份，决定要不要放出管理面板
    const st = await api('/api/auth/status');
    authState = st;
    applyRole(st.role);
    showApp();
    await load(true);
    if (st.role === 'admin') {
      toast('管理员身份已验证');
      // 地址栏去掉 ?admin，不留在历史记录里
      if (/[?&]admin\b/.test(location.search)) {
        const u = new URL(location.href);
        u.searchParams.delete('admin');
        history.replaceState(null, '', u.pathname + (u.search || ''));
      }
    } else {
      toast('登录成功');
    }
  } catch (err) {
    $('#authErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function doSetup() {
  // 主密码由服务端锁定，前端不再提供设置流程
  showAuth('login');
}

async function doLogout() {
  const wasAdmin = document.body.classList.contains('is-admin');
  if (wasAdmin && !confirm('退出管理员身份？退出后管理面板会隐藏。')) return;
  if (!wasAdmin) return; // 不是管理员时无需退出（本来就没登录）
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* 忽略 */ }
  S.data = null;
  document.body.classList.remove('is-admin');
  const card = $('#adminCard');
  if (card) card.hidden = true;
  showApp();
  await load();
  toast('已退出管理员身份');
}

function toast(msg, kind = 'ok') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  const icon = kind === 'ok' ? ICONS.ok : kind === 'err' ? ICONS.err : kind === 'warn' ? ICONS.warn : ICONS.info;
  el.innerHTML = `${icon}<span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 240);
  }, kind === 'err' ? 4200 : 2600);
}

/* ------------------------------------------------------------ 渲染：总览 */

function renderStats() {
  const { tasks, logs } = S.data;
  const enabled = tasks.filter((t) => t.enabled).length;
  const failures = logs.filter((l) => !l.ok).length;
  const runsToday = logs.filter((l) => new Date(l.at).toDateString() === new Date().toDateString()).length;

  // 每张统计卡都可点击，直接跳到对应视图看明细
  const cards = [
    { view: 'tasks', label: '活跃任务', icon: ICONS.zap, value: enabled, unit: '个', foot: tasks.length ? `共 ${tasks.length} 个任务，${enabled === tasks.length ? '全部启用' : (tasks.length - enabled) + ' 个已暂停'}` : '还没有任务' },
    { act: 'tasklogs', label: '执行日志', icon: ICONS.clock, value: logs.length, unit: '条', foot: `今日 ${runsToday} 次` },
    { view: 'logs', label: '失败次数', icon: ICONS.err, value: failures, unit: '次', foot: failures ? `占 ${logs.length ? ((failures / logs.length) * 100).toFixed(1) : '0'}%` : '运行状况良好' },
  ];

  // 第 4 张：系统日志（后台运行数据），填满 4 列统计栏
  const sysMeta = S.sysMeta || {};
  const sysCounts = sysMeta.counts || {};
  const sysErr = sysCounts.error || 0;
  const sysWarn = sysCounts.warn || 0;
  cards.push({
    view: 'logs',
    label: '系统日志',
    icon: ICONS.list,
    value: sysMeta.total || 0,
    unit: '条',
    foot: sysErr ? `错误 ${sysErr} · 警告 ${sysWarn}` : (sysWarn ? `警告 ${sysWarn} 条` : '后台运行正常'),
  });

  $('#stats').innerHTML = cards.map((c) => `
    <div class="stat is-clickable" role="button" tabindex="0" aria-label="打开${esc(c.label)}" ${c.act ? `data-act="${esc(c.act)}"` : `data-view="${esc(c.view)}"`} title="点击打开${esc(c.label)}">
      <div class="stat-label">${c.icon}${esc(c.label)}</div>
      <div class="stat-value">${esc(c.value)}<i>${esc(c.unit)}</i></div>
      <div class="stat-foot">${esc(c.foot)}</div>
    </div>`).join('');

  renderMetrics();
}

/*
 * 近 24 小时运行指标（第十八批）。
 *
 * 上面四张卡都是「累计数」：累计跑了 200 次、累计失败 7 次。累计数回答不了
 * 「昨天夜里稳不稳」「失败是零星抖动还是从 14:00 起全挂」—— 那两个问题才决定
 * 要不要现在动手。所以这里补一条带时间轴的小图：每小时一根柱，有失败的那根标红，
 * 鼠标悬停给出该小时的成功/失败/平均耗时。
 *
 * 服务端只下发 24 个小时桶的计数（见 metricsSnapshot），前端不做任何聚合，
 * 免得两边口径不一致。
 */
function renderMetrics() {
  const box = $('#metricStrip');
  if (!box) return;
  const m = S.data && S.data.metrics;
  const hours = (m && Array.isArray(m.hourly)) ? m.hourly : [];
  const total = hours.reduce((n, h) => n + (h.ok || 0) + (h.fail || 0), 0);
  if (!total) {
    // 刚部署或刚清空：一个样本都没有时不显示空图，避免「一排水管」看着像故障
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;

  const maxTotal = Math.max(1, ...hours.map((h) => (h.ok || 0) + (h.fail || 0)));
  const nowHour = new Date();
  nowHour.setMinutes(0, 0, 0);
  const bars = hours.map((h, i) => {
    const ok = h.ok || 0;
    const fail = h.fail || 0;
    const sum = ok + fail;
    // 空小时留一条 4% 高的底桩，让人看得出「这一格是 0 次」而不是「没有数据」
    const hPct = sum ? Math.max(6, Math.round((sum / maxTotal) * 100)) : 4;
    const cls = sum ? (fail ? 'is-bad' : 'is-ok') : 'is-idle';
    const label = new Date(nowHour.getTime() - (hours.length - 1 - i) * 3600 * 1000);
    const hh = `${String(label.getHours()).padStart(2, '0')}:00`;
    const tip = `${hh} · 成功 ${ok} · 失败 ${fail}${h.retry ? ` · 重试救回 ${h.retry}` : ''}${sum ? ` · 平均 ${h.avgMs || 0}ms` : ''}`;
    return `<i class="ms-bar ${cls}" style="--h:${hPct}%" title="${esc(tip)}" aria-label="${esc(tip)}"></i>`;
  }).join('');

  const sum24 = m.last24h || {};
  const rate = m.successRate == null ? '—' : `${m.successRate}%`;
  const dl = (S.data && S.data.deadLetter) || {};
  const dlCount = Number(dl.count) || Number(sum24.dl) || 0;
  const dlHot = Number(dl.alertLevel) > 0;

  box.innerHTML = `
    <div class="ms-head">
      <b>近 24 小时</b>
      <span class="ms-chips">
        <span class="ms-chip">成功 <b>${esc(sum24.ok || 0)}</b></span>
        <span class="ms-chip${sum24.fail ? ' is-warn' : ''}">失败 <b>${esc(sum24.fail || 0)}</b></span>
        <span class="ms-chip${sum24.retry ? ' is-ok' : ''}">重试救回 <b>${esc(sum24.retry || 0)}</b></span>
        <span class="ms-chip${dlHot ? ' is-bad' : ''}">死信 <b>${esc(dlCount)}</b></span>
      </span>
    </div>
    <div class="ms-bars">${bars}</div>
    <div class="ms-foot">
      <span>成功率 ${esc(rate)}</span>
      <span>平均耗时 ${esc(sum24.avgMs || 0)}ms</span>
      <span>最近 1 小时 成功 ${esc((m.last1h || {}).ok || 0)} / 失败 ${esc((m.last1h || {}).fail || 0)}</span>
    </div>`;
}


function renderNext() {
  const tasks = S.data.tasks
    .filter((t) => t.enabled && t.nextRun)
    .sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun))
    .slice(0, 6);

  const box = $('#nextList');
  if (!tasks.length) {
    box.innerHTML = `<div class="empty">${ICONS.empty}<p>没有待执行的任务</p><small>创建任务后将在这里显示倒计时</small></div>`;
    return;
  }
  box.innerHTML = tasks.map((t) => {
    const soon = new Date(t.nextRun).getTime() - Date.now() < 10 * 60000;
    return `
    <div class="next-item">
      <div class="next-when ${soon ? 'is-soon' : ''}">${esc(untilTime(t.nextRun))}</div>
      <div class="next-main">
        <div class="next-name">${esc(t.name)}</div>
        <div class="next-desc">${esc(t.type === 'http' ? 'HTTP 请求 · ' + scheduleHuman(t) : '提醒 · ' + scheduleHuman(t))}</div>
      </div>
    </div>`;
  }).join('');
}

function renderFeed() {
  const items = [];
  for (const l of S.data.logs.slice(0, 5)) {
    items.push({
      kind: l.ok ? 'ok' : 'err',
      title: l.taskName,
      // 动态流只放摘要：日志正文里可能是整段接口响应（最长 2000 字），
      // 完整内容和展开交给「运行日志」弹层，这里按默认长度收口，别撑破卡片
      desc: truncate(l.message, 120),
      at: l.at,
    });
  }
  for (const n of S.data.notifications.slice(0, 3)) {
    if (!items.some((i) => i.at === n.at)) {
      items.push({ kind: n.level === 'error' ? 'err' : 'info', title: n.title, desc: truncate(n.body, 120), at: n.at });
    }
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));

  const box = $('#feed');
  if (!items.length) {
    box.innerHTML = `<div class="empty">${ICONS.empty}<p>暂无动态</p><small>任务执行后会在这里留下记录</small></div>`;
    return;
  }
  box.innerHTML = items.slice(0, 7).map((i) => `
    <div class="feed-item">
      <div class="feed-icon feed-icon--${i.kind}">${i.kind === 'ok' ? ICONS.ok : i.kind === 'err' ? ICONS.err : ICONS.info}</div>
      <div class="feed-body">
        <div class="feed-title">${esc(i.title)}</div>
        <div class="feed-desc">${esc(i.desc || '')}</div>
      </div>
      <div class="feed-time">${esc(relTime(i.at))}</div>
    </div>`).join('');
}

function keyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------------------------------------------ 渲染：任务 */

function scheduleText(t) {
  return schedDesc(t.schedule || {});
}

/** 任务的节奏列表（老数据只有一条 schedule 时回落）。 */
function schedulesOf(t) {
  const list = Array.isArray(t.schedules) && t.schedules.length ? t.schedules : (t.schedule ? [t.schedule] : []);
  return list.length ? list : [{ mode: 'cron', cron: '0 9 * * *' }];
}

/** 单条节奏说人话：每天 09:00 / 每 2 小时 … */
function schedDesc(s) {
  if (!s) return '';
  if (s.mode === 'interval') {
    // 新数据带 unit/every；老任务只有 everyMinutes，继续按分钟说人话
    if (s.unit && s.unit !== 'minute') return intervalHuman(s.every, s.unit);
    const m = Math.max(1, Number(s.everyMinutes) || 60);
    if (m === 60) return '每小时';
    if (m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${m} 分钟`;
  }
  const parts = String(s.cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return String(s.cron || '');
  return describeCron(parts) || parts.join(' ');
}

function scheduleHuman(t) {
  return schedulesOf(t).map(schedDesc).join('、');
}

/**
 * 任务卡里的节奏行：只留「→ 每天 09:00」。
 * 原来还拼了一串「接下来：11/10 15:22、11/10 16:22…」，手机上必然折成第二行，
 * 和上面的速度信息叠成一片；未来执行时间在编辑弹层里另有完整预览，这里不再重复。
 */
function schedLines(t) {
  const list = schedulesOf(t);
  return `<div class="task-sched">${list.map((s) =>
    `<div class="task-sched-row"><span class="task-sched-desc">→ ${esc(schedDesc(s))}</span></div>`
  ).join('')}</div>`;
}

function taskMatches(t) {
  if (S.taskFilter === 'http' && t.type !== 'http') return false;
  if (S.taskFilter === 'remind' && t.type !== 'remind') return false;
  if (S.taskFilter === 'enabled' && !t.enabled) return false;
  if (S.taskQuery) {
    const q = S.taskQuery.toLowerCase();
    const hay = (t.name + ' ' + (t.config.url || '') + ' ' + (t.config.message || '')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderTasks() {
  // 拖动过程中不重绘：45 秒一轮的后台刷新一旦替换 DOM，手指底下那张卡就没了
  if (S.sorting) return;
  const list = S.data.tasks.filter(taskMatches).slice();
  const box = $('#taskList');
  $('#taskCount').textContent = S.data.tasks.length;
  const sel = S.taskSel || (S.taskSel = new Set());

  const batchBar = $('#batchBar');
  if (batchBar) batchBar.hidden = sel.size === 0;
  const batchN = $('#batchN');
  if (batchN) batchN.textContent = sel.size;
  // 多选框默认不占位置，点工具栏「批量」才显示。每 45 秒重绘后同步按钮态，别把模式丢了。
  box.classList.toggle('is-selecting', !!S.batchMode);
  const batchToggle = $('#batchMode');
  if (batchToggle) {
    batchToggle.textContent = S.batchMode ? '退出批量' : '批量';
    batchToggle.classList.toggle('is-active', !!S.batchMode);
    batchToggle.setAttribute('aria-pressed', S.batchMode ? 'true' : 'false');
  }

  if (!list.length) {
    const isFiltered = S.data.tasks.length > 0;
    box.innerHTML = `<div class="card"><div class="empty">${ICONS.empty}
      <p>${isFiltered ? '没有符合条件的任务' : '还没有创建任何任务'}</p>
      <small>${isFiltered ? '试试调整筛选或搜索关键词' : '点右上角「新建任务」开始'}</small>
    </div></div>`;
    return;
  }

  const cardHtml = (t, groupName, folded) => {
    // 一条 config 缺失的脏数据会抛 TypeError，进而中断整个 renderAll() 链，
    // 最后被 load() 的 catch 吞成「连接失败」—— 看起来像服务挂了，其实只是渲染崩了。
    const cfg = t.config || {};
    const last = t.lastResult;
    const failing = !t.enabled ? false : !!last && !last.ok;
    const resultCls = !last ? '' : last.ok ? 'is-ok' : 'is-err';
    const resultTxt = !last ? '未运行' : last.ok ? '成功' : '失败';
    return `
    <div class="task ${t.enabled ? '' : 'is-off'} ${failing ? 'is-failing' : ''} ${t.pinned ? 'is-pinned' : ''}" data-id="${esc(t.id)}" data-group="${esc(groupName || '')}"${folded ? ' hidden' : ''} title="长按拖动可以调整任务顺序">
      <input type="checkbox" class="task-check" data-check="${esc(t.id)}" ${sel.has(t.id) ? 'checked' : ''} title="加入批量操作" aria-label="选择 ${esc(t.name)}">
      <div class="task-main">
        <div class="task-title-row">
          <span class="task-name">${esc(t.name)}</span>
          <span class="pill pill--type">${t.type === 'http' ? 'HTTP' : '提醒'}</span>
          <span class="pill ${t.enabled ? 'pill--on' : 'pill--off'}">${t.enabled ? '运行中' : '已暂停'}</span>
          ${t.type === 'http' && cfg.retry && Number(cfg.retry.times) > 0
            ? `<span class="pill pill--retry" title="失败后自动重试 ${Number(cfg.retry.times)} 次，间隔 ${Math.round((Number(cfg.retry.delayMs) || 3000) / 1000)} 秒（仅超时/连接失败/5xx/408/429）">↻ 重试 ${Number(cfg.retry.times)}×</span>`
            : ''}
          ${t.type === 'http' && cfg.aiEnabled === false
            ? '<span class="pill pill--ai-off" title="这个任务关闭了 AI 优化，直接发接口原文">AI 关</span>'
            : ''}
          <button type="button" class="task-log-btn" data-act="logs" title="查看这个任务的历史运行日志"><span class="tlb-full">运行日志</span><span class="tlb-mini">日志</span></button>
        </div>
        <div class="task-sub">
          ${t.type === 'http'
            ? `<code>${esc(cfg.method)}</code><span title="${esc(cfg.url || '')}">${esc(shortUrl(cfg.url))}</span>`
            : `<span>${esc(truncate(cfg.message, 42))}</span>`}
        </div>
        ${schedLines(t)}
        ${t.type === 'http' && Array.isArray(cfg.steps) && cfg.steps.length
          ? `<div class="task-steps">${cfg.steps.map((s, i) =>
              `<span class="task-step-tag">${i + 1}. ${esc(s.name || shortUrl(s.url))}</span>`).join('')}</div>`
          : ''}
        ${failing && last && last.message
          ? `<div class="task-fail-msg" title="${esc(String(last.message))}">⚠ ${esc(truncate(String(last.message).replace(/响应片段[：:].*$/, ''), 72))}</div>`
          : ''}
      </div>
      <dl class="task-meta">
        <div><dt>上次结果</dt><dd class="${resultCls}">${resultTxt}</dd></div>
        <div><dt>下次执行</dt><dd>${t.enabled ? esc(untilTime(t.nextRun)) : '—'}</dd></div>
        <div><dt>运行次数</dt><dd>${t.runCount || 0}</dd></div>
      </dl>
      <div class="task-actions">
        <button class="icon-btn is-run" data-act="run" title="立即执行">${ICONS.play}</button>
        <button class="icon-btn pin-btn ${t.pinned ? 'is-active' : ''}" data-act="pin" title="${t.pinned ? '取消置顶' : '置顶'}" aria-label="${t.pinned ? '取消置顶' : '置顶'}" aria-pressed="${t.pinned ? 'true' : 'false'}">${ICONS.pin}</button>
        <button class="icon-btn" data-act="toggle" title="${t.enabled ? '暂停' : '启用'}">${ICONS.power}</button>
        <button class="icon-btn" data-act="edit" title="编辑">${ICONS.edit}</button>
        <button class="icon-btn is-del" data-act="del" title="删除">${ICONS.del}</button>
      </div>
    </div>`;
  };

  /*
   * 任务组：按组名聚合（组内保持原顺序，组按首次出现排），未分组的排在最后。
   * 分组标题和任务卡都是 #taskList 的直接子元素 —— 长按拖动仍走原来的容器委托，
   * 只要用 canSwap 把换位限制在同组内即可，不用给每组单独绑一套事件。
   */
  const fold = readGroupFold();
  const byGroup = new Map();
  const loose = [];
  for (const t of list) {
    const g = String(t.group || '').trim();
    if (!g) { loose.push(t); continue; }
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(t);
  }
  const html = [];
  for (const [g, arr] of byGroup) {
    const collapsed = fold[g] === true;
    html.push(`<button type="button" class="task-group-head${collapsed ? ' is-collapsed' : ''}" data-group="${esc(g)}" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="tgh-caret">${collapsed ? '▸' : '▾'}</span>
      <span class="tgh-name">${esc(g)}</span>
      <span class="tgh-count">${arr.length}</span>
      <span class="tgh-hint">${collapsed ? '展开' : '收起'}</span>
    </button>`);
    for (const t of arr) html.push(cardHtml(t, g, collapsed));
  }
  for (const t of loose) html.push(cardHtml(t, '', false));
  box.innerHTML = html.join('');
}

/** 任务组折叠状态：跟设置页的折叠卡一样放 localStorage，45 秒重绘不会打回。 */
const GROUP_FOLD_KEY = 'cronhub.fold.groups';
function readGroupFold() {
  try { return JSON.parse(localStorage.getItem(GROUP_FOLD_KEY) || '{}') || {}; } catch { return {}; }
}
function writeGroupFold(m) {
  try { localStorage.setItem(GROUP_FOLD_KEY, JSON.stringify(m)); } catch { /* 无痕模式忽略 */ }
}

function shortUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.host + (x.pathname === '/' ? '' : x.pathname);
  } catch {
    return u;
  }
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/* ------------------------------------------------------------ 长按拖动排序 */

/*
 * 通用的「长按再拖」排序。
 *
 * 为什么非得长按：任务卡上本身有复选框和 5 个按钮，筛选栏是一整排可点的分段控件，
 * 手指一按就进拖动会把这些「点」全吃掉。按满 380ms 才进拖动，两种意图就分得开；
 * 反过来，按下后立刻滑动（超过 8px）说明用户是在滚页面，直接放弃长按。
 *
 * opts:
 *   itemSel    可拖动项（任务卡用 .task，筛选栏用 button）
 *   ignoreSel  在这个范围内按下不触发拖动（按钮 / 输入框）
 *   axis       'y' 竖向列表（默认），'x' 横向分段
 *   keyOf      取排序键，默认 dataset.id → data-filter → data-act
 *   onDrop     松手后回调 (keys, el)，排序怎么落由调用方决定
 */
function enableLongPressSort(container, opts) {
  if (!container) return;
  const itemSel = opts.itemSel || '*';
  const ignoreSel = opts.ignoreSel || '';
  const axis = opts.axis === 'x' ? 'x' : 'y';
  /*
   * 长按阈值：触摸屏 380ms（手指容易误触，宁慢一点），鼠标 200ms。
   * 鼠标用户按住 380ms 已经接近「以为没反应」的耐心边缘，尤其在桌面端。
   */
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const holdMs = opts.holdMs || (coarse ? 380 : 200);
  const keyOf = opts.keyOf || ((el) => el.dataset.id || el.dataset.filter || el.dataset.act || '');
  const coord = (e) => (axis === 'x' ? e.clientX : e.clientY);
  const shift = (px) => (axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`);
  const items = () => Array.from(container.children).filter((c) => c.matches(itemSel));

  let press = null;
  let drag = null;
  let touchEl = null;
  let touchY = 0;
  let touchAt = 0;

  const stopPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

  function onMove(c) {
    if (!drag) return;
    const el = drag.el;
    el.style.transform = shift(c - drag.base);
    // 和相邻项的中点比：越过了就换位，并把基准重置到当前位置，视觉上就「吸附」进新槽位
    for (const s of items()) {
      // 折叠收起的组，卡片 display:none（rect 全 0）不能拿来比中线，否则会误换位
      if (s === el || !s.offsetParent) continue;
      // 任务组：同组之内才允许换位，手指划到隔壁组不会把任务「拖出组」
      if (opts.canSwap && !opts.canSwap(el, s)) continue;
      const r = s.getBoundingClientRect();
      const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
      /*
       * 方向必须对上：s 在 el 上方（before）时，只有指针越过 s 的中线向上才换位，
       * 换位动作是「插到 s 前面」；s 在 el 下方时反过来。
       * 早先这两条写反了（before 分支却判断向下越线），结果是往下拖能换、往上拖永远不动。
       */
      const before = !!(s.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (before && c < mid) {
        container.insertBefore(el, s);
        drag.base = c;
        el.style.transform = shift(0);
        break;
      }
      if (!before && c > mid) {
        container.insertBefore(el, s.nextElementSibling);
        drag.base = c;
        el.style.transform = shift(0);
        break;
      }
    }
  }

  function beginDrag(el, c) {
    press = null;
    drag = { el, base: c };
    el.classList.add('is-dragging');
    document.body.classList.add('is-sorting');
    S.sorting = true;
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function endDrag(commit) {
    if (!drag) return;
    const el = drag.el;
    drag = null;
    el.classList.remove('is-dragging');
    el.style.transform = '';
    document.body.classList.remove('is-sorting');
    S.sorting = false;
    S.lastSortAt = Date.now();
    if (commit && opts.onDrop) opts.onDrop(items().map(keyOf).filter(Boolean), el);
  }

  container.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const el = e.target.closest(itemSel);
    if (!el || el.parentElement !== container) return;
    if (ignoreSel && e.target.closest(ignoreSel)) return;
    stopPress();
    const start = coord(e);
    press = { y: start, timer: setTimeout(() => beginDrag(el, start), holdMs) };
  });

  /*
   * 拖动中的坐标更新与「放弃长按」的判断。
   *
   * 触摸单独走 touch 事件：手指一滑，浏览器接管滚动后会立刻发 pointercancel，
   * 指针流断掉、长按计时器和拖动一起被取消 —— 用户看到的现象就是
   * 「明明按住了，一滑动页面就跟着滚，怎么都拖不动」。
   */
  const onPointerMove = (e) => {
    if (drag) {
      if (e.pointerType !== 'touch') onMove(coord(e));
      return;
    }
    if (press && Math.abs(coord(e) - press.y) > 8) stopPress();
  };
  const onUp = (e) => {
    // 触摸的 pointercancel 不代表手势结束（浏览器常在触摸开始时就撤掉指针流），
    // 真正的结束交给 touchend / touchcancel。
    if (e && e.pointerType === 'touch' && drag) return;
    endDrag(true);
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const el = e.target.closest(itemSel);
    if (!el || el.parentElement !== container) return;
    if (ignoreSel && e.target.closest(ignoreSel)) return;
    touchEl = el;
    touchY = coord(e.touches[0]);
    touchAt = Date.now();
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!touchEl && !drag) return;
    const y = coord(e.touches[0]);
    if (drag) {
      // 拖动中：拦掉滚动，页面不许跟着动
      if (e.cancelable) e.preventDefault();
      onMove(y);
      return;
    }
    if (!press) return;
    if (Math.abs(y - touchY) > 10) { stopPress(); touchEl = null; return; }
    /*
     * 按住不动超过 90ms：认定是长按，从这里开始就把滚动锁死，
     * 否则等计时器到点时浏览器早已判定成滚动手势，preventDefault 会失效。
     * 快速滑动（90ms 内就超过 10px）不会走到这里，滚页面照旧。
     */
    if (e.cancelable && Date.now() - touchAt > 90) e.preventDefault();
  }, { passive: false });

  container.addEventListener('touchend', () => { touchEl = null; endDrag(true); });
  container.addEventListener('touchcancel', () => { touchEl = null; endDrag(true); });

  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => container.addEventListener(ev, stopPress, true));
  // 长按会弹系统菜单（「复制 / 全选」），正好在拖动开始时打断手势，这里禁掉
  container.addEventListener('contextmenu', (e) => {
    if (drag || press) e.preventDefault();
  });
}

/** 读本地保存的排序键（筛选栏是纯前端偏好，存 localStorage 就够）。 */
function readSortOrder(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function saveSortOrder(key, keys) {
  try { localStorage.setItem(key, JSON.stringify(keys)); } catch { /* 无痕模式忽略 */ }
}

/** 按保存的顺序重排容器子节点；没出现在记录里的（新加的按钮）保持原位置往后排。 */
function applySortOrder(container, key) {
  if (!container) return;
  const saved = readSortOrder(key);
  if (!saved.length) return;
  const map = new Map();
  for (const el of Array.from(container.children)) {
    const k = el.dataset.id || el.dataset.filter || el.dataset.act || '';
    if (k && !map.has(k)) map.set(k, el);
  }
  for (const k of saved) {
    const el = map.get(k);
    if (el) { container.appendChild(el); map.delete(k); }
  }
  for (const el of map.values()) container.appendChild(el);
}

/* ------------------------------------------------------------ 渲染：通知 */

function renderInbox() {
  const all = S.data.notifications;
  const unread = all.filter((n) => !n.read).length;
  const badge = $('#unreadCount');
  badge.textContent = unread;
  badge.hidden = unread === 0;

  // 通道概览：只列「真的配好了」的渠道。
  // 以前把短信 / 邮件无条件挂出来（哪怕从没配过），看着像一堆待处理的残留；
  // 现在没配的干脆不出现，多账号按实例逐个列出，点进去就是那个账号的设置。
  // 顺序 = 优先级：NotifyMe（手机推送）→ 短信 → 其余方案/邮件。
  const CARD = { webhook: 'card:webhookCard', email: 'card:smtpCard', sms: 'card:smsCard' };
  const stW = (S.data.settings && S.data.settings.webhook) || {};
  const CAP = { webhook: whSchemeName(stW.format), email: '邮件', sms: '短信' };
  const chans = [{ goto: '', name: '站内通知', state: '始终开启', on: true, icon: ICONS.info }];
  const nmRow = [];
  const smsRow = [];
  const restRow = [];
  // 手机推送（NotifyMe）不单列第二份：它就是 Webhook 的 notifyme 格式，
  // 同一个出口列两遍会让人以为「关掉一个还剩一个」。这里只是把名字换成方案名。
  for (const type of ['webhook', 'email', 'sms']) {
    if (channelUsable(type)) {
      const mark = channelMarkOf(type, 'main');
      const item = { goto: CARD[type], name: `${CAP[type]}${mark ? ' · ' + mark : ''}`, state: '已启用', on: true, icon: ICONS.zap };
      (type === 'webhook' && isNmFormat(stW) ? nmRow : type === 'sms' ? smsRow : restRow).push(item);
    }
    channelInstancesOf(type).forEach((inst, i) => {
      if (!channelUsable(type, inst)) return;
      const mark = String(inst.remark || '').trim();
      const base = type === 'webhook' ? `${whSchemeName((inst.config || {}).format)} ${i + 2}` : `${CAP[type]} ${i + 2}`;
      const item = { goto: CARD[type], name: `${base}${mark ? ' · ' + mark : ''}`, state: '已启用', on: true, icon: ICONS.zap };
      (type === 'webhook' && isNmFormat(inst.config) ? nmRow : type === 'sms' ? smsRow : restRow).push(item);
    });
  }
  chans.push(...nmRow, ...smsRow, ...restRow);
  $('#channelBar').innerHTML = chans.map((c) => `
    <div class="channel ${c.goto ? 'is-clickable' : ''} ${c.on ? 'is-on' : ''}" ${c.goto ? `data-goto="${c.goto}" title="点击查看或配置"` : ''}>
      <div class="channel-icon">${c.icon}</div>
      <div class="channel-main">
        <div class="channel-name">${esc(c.name)}</div>
        <div class="channel-state">${esc(c.state)}</div>
      </div>
      <span class="channel-dot"></span>
    </div>`).join('');

  let list = all;
  if (S.inboxFilter === 'unread') list = all.filter((n) => !n.read);
  if (S.inboxFilter === 'remind') list = all.filter((n) => n.level === 'remind');
  if (S.inboxFilter === 'error') list = all.filter((n) => n.level === 'error');

  const box = $('#inbox');
  if (!list.length) {
    const isFiltered = all.length > 0;
    box.innerHTML = `<div class="card"><div class="empty">${ICONS.empty}
      <p>${isFiltered ? '这个分类下没有消息' : '收件箱是空的'}</p>
      <small>${isFiltered ? '换个筛选条件看看' : '创建提醒任务或配置推送通道后，消息会出现在这里'}</small>
    </div></div>`;
    return;
  }
  const trigMap = { schedule: '定时', manual: '手动', catchup: '补跑' };
  box.innerHTML = list.map((n) => `
    <div class="inbox-item ${n.read ? '' : 'is-unread'}" data-id="${esc(n.id)}">
      <div class="feed-icon feed-icon--${n.level === 'error' ? 'err' : 'info'}">${n.level === 'error' ? ICONS.err : n.level === 'remind' ? ICONS.bell : ICONS.info}</div>
      <div class="inbox-body">
        <div class="inbox-title">
          ${esc(n.title)}
          <span class="pill ${n.level === 'error' ? 'pill--off' : 'pill--on'}">${n.level === 'error' ? '告警' : n.level === 'remind' ? '提醒' : n.level === 'success' ? '成功' : '通知'}</span>
          ${n.trigger === 'catchup' ? '<span class="pill pill--off">补跑（有延迟）</span>' : ''}
        </div>
        <div class="inbox-text">${esc(n.body || '')}</div>
        ${n.aiNote ? `<div class="inbox-ai">${esc(n.aiNote)}</div>` : ''}
        ${n.rawBody ? `
        <button type="button" class="inbox-raw-toggle" data-raw="${esc(n.id)}">原文与依据</button>
        <div class="inbox-text inbox-raw" hidden></div>` : ''}
        <div class="inbox-time">${esc(fmtDateTime(n.at))} · ${esc(relTime(n.at))}${n.trigger && trigMap[n.trigger] ? ' · ' + trigMap[n.trigger] : ''}</div>
      </div>
      ${n.channels && n.channels.length ? `
      <div class="inbox-channels" title="各渠道推送结果">
        ${n.channels.map((c) => `<span class="ch-chip ${c.ok ? 'is-ok' : 'is-err'}" title="${esc(c.message || '')}">${c.ok ? '✓' : '✕'} ${esc(normChannelName(c.name))}</span>`).join('')}
      </div>` : ''}
      ${n.deadLetterId ? `
      <div class="inbox-acts">
        <button class="btn btn--ghost btn--sm" data-replay="${esc(n.deadLetterId)}">重放这条</button>
      </div>` : ''}
    </div>`).join('');
}

/* ---- 网站运行日志 ---- */

const SYS_SRC_LABEL = {
  boot: '启动', sleep: '休眠', runtime: '运行态', config: '配置',
  api: '接口', http: '页面', task: '任务', channel: '渠道', tick: '调度',
  auth: '登录', sms: '短信', system: '系统', keep: '保活',
};
const SYS_LV_LABEL = { info: '信息', warn: '警告', error: '错误' };

function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderLogView() {
  // 不在日志页 / 标签页在后台时，不拉 400 条系统日志，也不起轮询
  if (S.view !== 'logs' || document.hidden) return;
  loadSysLogs(true);
  if (!S.sysTimer) {
    S.sysTimer = setInterval(() => {
      const auto = $('#sysLogAuto');
      if (S.view === 'logs' && !document.hidden && auto && auto.checked) loadSysLogs(true);
    }, 10000);
  }
}

/** 从通用入口（总览卡 / 设置页）进日志页时，先恢复成「全部」再展示 */
function resetSysFilter() {
  S.sysSource = 'all';
  S.sysLevel = 'all';
  S.sysQuery = '';
  const lv = $('#sysLogLevel');
  if (lv) [...lv.children].forEach((x) => x.classList.toggle('is-active', x.dataset.lv === 'all'));
  const sea = $('#sysLogSearch');
  if (sea) sea.value = '';
}

/** 顶部后台运行数据：连续运行、启动时间、休眠中断、内存、任务量 */
function renderSysInfoBar() {
  const box = $('#sysInfoBar');
  if (!box) return;
  const s = S.sysInfo;
  if (!s) { box.innerHTML = ''; return; }
  const rt = s.runtime || {};
  const mem = s.mem || {};
  const items = [
    { label: '本次进程运行', value: s.processText || '—', foot: '连续记录 ' + (s.curText || '—'), icon: ICONS.clock, tip: '进程重启（部署、平台冷启动）会让这个数字归零。下面的「连续记录」在重启间隔小于 3 分钟时继续累计，因此可能大于本次进程；累计总运行 ' + (s.totalText || '—') },
    { label: '本次启动', value: fmtClock(s.bootAt), foot: (s.bootAtText || '').split(' ')[0] + ' · PID ' + (s.pid || '—'), icon: ICONS.power },
    { label: '运行中断', value: (s.interruptions || 0) + ' 次', foot: s.longestText ? '最长连续 ' + s.longestText : '尚未中断', icon: ICONS.sleep, tip: '休眠、断电、重新部署都会让心跳断开，各记一次' },
    { label: '内存占用', value: (mem.rssMB || 0) + ' MB', foot: 'Heap ' + (mem.heapUsedMB || 0) + ' / ' + (mem.heapTotalMB || 0) + ' MB', icon: ICONS.pulse },
    { label: '启用任务', value: (s.tasksEnabled || 0) + ' / ' + (s.tasks || 0), foot: '执行记录 ' + (s.runLogs || 0) + ' 条', icon: ICONS.zap },
    { label: '运行环境', value: 'Node ' + String(s.node || '').replace('v', ''), foot: (s.port ? '端口 ' + s.port + ' · ' : '') + (s.tz || ''), icon: ICONS.info },
  ];
  box.innerHTML = items.map((it) => `
    <div class="sysinfo-item"${it.tip ? ` title="${esc(it.tip)}"` : ''}>
      <div class="sysinfo-label">${it.icon}${esc(it.label)}</div>
      <div class="sysinfo-value">${esc(String(it.value))}</div>
      <div class="sysinfo-foot">${esc(it.foot)}</div>
    </div>`).join('');
}

async function loadSysLogs(silent) {
  try {
    const qs = new URLSearchParams({
      level: S.sysLevel || 'all',
      source: S.sysSource || 'all',
      q: S.sysQuery || '',
      limit: '400',
    });
    const r = await api('/api/system-logs?' + qs.toString());
    S.sysLogs = r.logs || [];
    S.sysMeta = r;
    S.sysInfo = r.sys || S.sysInfo;
    renderSysInfoBar();
    renderSysLogs();
  } catch (e) {
    if (!silent) toast('日志读取失败：' + e.message, 'err');
  }
}

/** 只取计数与运行快照，给总览统计卡用（不拿明细，很轻） */
async function loadSysMeta() {
  try {
    const r = await api('/api/system-logs?limit=1');
    S.sysMeta = r;
    S.sysInfo = r.sys || S.sysInfo;
    renderStats();
    // 这份数据比 /api/state 晚到，会二次重建卡片；动态元素的可访问属性补一次
    keyboardClickable();
    // 连接状态只由 load() 判定：这份请求比 /api/state 晚到，若中途有一次 load() 失败
    // 已标成「连接失败」，这里再无条件置回在线会把故障盖掉。
    if (S.data && S.data.meta) renderServerInfo(S.data.meta);
  } catch { /* 统计卡拿不到就显示 0，不影响主流程 */ }
}

function renderSysLogs() {
  const list = S.sysLogs || [];
  const meta = S.sysMeta || {};
  const counts = meta.counts || {};
  const cnt = $('#sysLogCount');
  if (cnt) {
    cnt.textContent = `共 ${meta.total || 0} 条 · 错误 ${counts.error || 0} · 警告 ${counts.warn || 0}`;
    cnt.className = counts.error ? 'hint hint--warn' : 'hint';
  }
  const sel = $('#sysLogSource');
  if (sel && meta.sources) {
    const cur = S.sysSource || 'all';
    // 当前筛选的来源可能还没有任何记录（比如刚点「推送日志」），也要保留成可选项，
    // 否则下拉会跳回「全部来源」，用户会以为筛选没生效
    const opts = [...meta.sources];
    if (cur !== 'all' && !opts.includes(cur)) opts.push(cur);
    opts.sort();
    sel.innerHTML = '<option value="all">全部来源</option>' +
      opts.map((v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(SYS_SRC_LABEL[v] || v)}</option>`).join('');
  }
  const box = $('#sysLogList');
  if (!box) return;
  if (!list.length) {
    const srcNow = S.sysSource && S.sysSource !== 'all' ? (SYS_SRC_LABEL[S.sysSource] || S.sysSource) : '';
    const tip = srcNow
      ? `当前只看「${srcNow}」记录，还没有产生过；换成「全部来源」看整体`
      : '换个筛选条件，或等任务跑一轮';
    box.innerHTML = `<div class="empty">${ICONS.empty}<p>没有匹配的日志</p><small>${esc(tip)}</small></div>`;
    return;
  }
  box.innerHTML = list.map((l) => `
    <div class="log-row" data-log="${esc(l.id)}">
      <span class="log-time">${esc(fmtClock(l.at))}</span>
      <span class="log-lv log-lv--${esc(l.level)}">${esc(SYS_LV_LABEL[l.level] || l.level)}</span>
      <span class="log-src">${esc(SYS_SRC_LABEL[l.source] || l.source)}</span>
      <span class="log-msg">${esc(l.msg)}</span>
    </div>
    ${l.detail ? `<div class="log-detail" data-detail="${esc(l.id)}" hidden><pre>${esc(JSON.stringify(l.detail, null, 2))}</pre></div>` : ''}
  `).join('');
}

/* ---- 单个任务的运行日志 ---- */

function openTaskLogs(id) {
  // id 为空 = 全部任务的执行记录（任务页右上角「执行日志」入口）
  const t = id ? S.data.tasks.find((x) => x.id === id) : null;
  if (id && !t) return;
  const all = id ? (S.data.logs || []).filter((l) => l.taskId === id) : (S.data.logs || []);
  const okN = all.filter((l) => l.ok).length;
  const failN = all.filter((l) => !l.ok).length;
  const avg = all.length ? Math.round(all.reduce((a, l) => a + (Number(l.duration) || 0), 0) / all.length) : 0;
  const last = all[0] || null;
  $('#tlTitle').textContent = id ? `运行日志 · ${t.name}` : `执行日志 · 全部任务（${all.length} 条）`;
  $('#tlSummary').innerHTML = `
    <div class="tl-stat"><span>总执行</span><strong>${all.length}</strong></div>
    <div class="tl-stat"><span>成功</span><strong class="ok">${okN}</strong></div>
    <div class="tl-stat"><span>失败</span><strong class="${failN ? 'err' : ''}">${failN}</strong></div>
    <div class="tl-stat"><span>平均耗时</span><strong>${esc(durText(avg))}</strong></div>
    <div class="tl-stat"><span>最近一次</span><strong>${last ? esc(fmtDateTime(last.at)) : '—'}</strong></div>`;
  const trigMap = { schedule: '定时', manual: '手动', catchup: '补跑' };
  const box = $('#tlList');
  box.innerHTML = all.length
    ? all.map((l, i) => `
      <div class="tl-item ${l.ok ? '' : 'is-fail'}">
        <div class="tl-item-head">
          <span class="tl-at">${esc(fmtDateTime(l.at))}</span>
          <span class="${l.ok ? 'badge-ok' : 'badge-err'}">${l.ok ? '成功' : '失败'}</span>
          ${id ? '' : `<span class="tl-name">${esc(l.taskName || '—')}</span>`}
          <span class="tl-trig">${esc(trigMap[l.trigger] || l.trigger || '—')}</span>
          <span class="tl-dur">${esc(durText(l.duration))}</span>
          <span class="tl-tools">
            <button type="button" class="tl-tool" data-tl-toggle="${i}" hidden>展开全部</button>
            <button type="button" class="tl-tool" data-tl-copy="${i}" title="复制这条记录的全部内容">复制</button>
          </span>
        </div>
        <div class="tl-msg">${esc(l.message || '（无详情）')}</div>
      </div>`).join('')
    : (id
      ? `<div class="empty">${ICONS.empty}<p>这个任务还没有执行记录</p><small>点任务卡上的「▶」立即跑一次就会有</small></div>`
      : `<div class="empty">${ICONS.empty}<p>还没有任何执行记录</p><small>任务跑过一次之后，这里会列出每次的执行结果</small></div>`);
  // 覆盖式绑定：列表每次重建，用 onclick 赋值不会累积监听器
  box.onclick = async (e) => {
    const tgl = e.target.closest('[data-tl-toggle]');
    if (tgl) {
      const msg = tgl.closest('.tl-item')?.querySelector('.tl-msg');
      if (!msg) return;
      const open = msg.classList.toggle('is-open');
      tgl.textContent = open ? '收起' : '展开全部';
      return;
    }
    const cp = e.target.closest('[data-tl-copy]');
    if (!cp) return;
    const rec = all[Number(cp.dataset.tlCopy)];
    if (!rec) return;
    if (!(await copyPlain(logFullText(rec)))) {
      toast('复制失败，请手动选择文本', 'warn');
      return;
    }
    const old = cp.textContent;
    cp.textContent = '已复制';
    setTimeout(() => { cp.textContent = old; }, 1200);
  };
  $('#taskLogModal').hidden = false;
  // 只有真被折行的记录才挂「展开全部」，否则每条都摆一个点不动的按钮
  box.querySelectorAll('.tl-item').forEach((item) => {
    const msg = item.querySelector('.tl-msg');
    const btn = item.querySelector('[data-tl-toggle]');
    if (msg && btn && msg.scrollHeight - msg.clientHeight > 2) btn.hidden = false;
  });
}

/** 复制到剪贴板：优先异步 API（HTTPS / 本地回环可用），被拒时退回 execCommand。 */
async function copyPlain(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 权限被拒就走下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制用全文：结论行 + 完整响应体（响应若已在结论里露过面就不再重复贴一遍）。 */
function logFullText(l) {
  const head = `[${fmtDateTime(l.at)}] ${l.ok ? '成功' : '失败'}`
    + (l.taskName ? ` · ${l.taskName}` : '')
    + ` · 耗时 ${durText(l.duration)}`;
  let out = `${head}\n${l.message || '（无详情）'}`;
  const resp = typeof l.response === 'string' ? l.response.trim() : '';
  if (resp && !String(l.message || '').includes(resp.slice(0, 60))) {
    out += `\n\n--- 响应内容（${resp.length} 字）---\n${resp}`;
  }
  return out;
}

/* ------------------------------------------------------------ 渲染：设置 */

let smtpHydrated = false;

/* ---- 凭据续期：状态展示 ---- */
let tokenStatusLoaded = false;

async function loadTokenStatus() {
  if (tokenStatusLoaded) return;
  tokenStatusLoaded = true;
  try {
    const r = await api('/api/settings/token');
    renderTokenStatus(r);
  } catch {
    $('#tkStatus').textContent = '';
  }
}

function renderTokenStatus(r) {
  const box = $('#tkStatus');
  if (!box) return;
  if (!r || !r.configured) {
    box.innerHTML = '<span class="hint">尚未配置长效令牌。任务里用 <code>{{ACCESS_TOKEN}}</code> 之前，请先在这里保存一次。</span>';
    return;
  }
  const a = r.accessDaysLeft;
  const b = r.refreshDaysLeft;
  const warn = (a != null && a <= 3) || (b != null && b <= 7);
  const part = [];
  if (a != null) part.push(`访问令牌剩 <strong>${a}</strong> 天`);
  if (b != null) part.push(`长效令牌剩 <strong>${b}</strong> 天`);
  box.innerHTML = part.join(' ｜ ') + (warn
    ? '<br><span style="color:var(--danger,#d4380d)">长效令牌快到期了，请换一个新的 refreshToken。</span>'
    : '<br><span class="hint">访问令牌到期前会自动换新，无需手工处理。</span>');
}

/* ------------------------------------------------ 通知渠道：多标签实例
 *
 * 每个渠道（短信 / Webhook / 邮件 / AI）可以有多套配置，卡片顶部并排成标签：
 *   ┌────────────────┬────────────────┬────┐
 *   │ ● 短信通知  复制 │ ● 短信通知2 复制 │ ＋ │
 *   │   张三          │   李四          │    │
 *   └────────────────┴────────────────┴────┘
 * 标题是自动编号的渠道名，标题右边「复制」按钮 = 照抄这套配置做一个新标签，
 * 标题下面那行小字是「标识」（多用户时用来区分），点它就能改。
 * 「默认」标签就是原来的单套配置，老数据不用迁移。
 */

const CH_META = {
  sms: { label: '短信', title: '短信通知', fallback: '短信通知' },
  webhook: { label: 'Webhook', title: 'Webhook', fallback: 'Webhook' },
  email: { label: '邮件', title: '邮件提醒', fallback: '邮件' },
  ai: { label: 'AI 通知', title: 'AI 通知优化', fallback: 'AI 通知配置' },
};
const CH_TABS_MAX = 12;
const CH_ACTIVE = { sms: 'main', webhook: 'main', email: 'main', ai: 'main' };

/*
 * Webhook 只是「方案容器」，真正发到哪由 format 决定。
 * 设置页那张卡还叫 Webhook（那里确实在填地址和凭据），但**任务渠道、通知记录、
 * 系统日志一律显示方案名** —— 用户勾了「Webhook」根本不知道自己会收到什么，
 * 勾了「NotifyMe」才知道是手机。
 */
const WH_SCHEMES = {
  notifyme: { short: 'NotifyMe', full: 'NotifyMe' },
  generic: { short: '通用 JSON', full: '通用 JSON' },
  serverchan: { short: 'Server酱', full: 'Server酱' },
  feishu: { short: '飞书机器人', full: '飞书机器人' },
  dingtalk: { short: '钉钉机器人', full: '钉钉机器人' },
  bark: { short: 'Bark', full: 'Bark (iOS)' },
};
function whSchemeName(format, short) {
  const s = WH_SCHEMES[String(format || 'generic')] || WH_SCHEMES.generic;
  return short ? s.short : s.full;
}
/*
 * 历史通知记录里存的是当时的渠道名（「NotifyMe（手机推送）·fcm」「手机推送」），
 * 现在对外统一叫 NotifyMe。只在渲染时归一，不改存档数据。
 */
function normChannelName(name) {
  return String(name || '').replace('NotifyMe（手机推送）', 'NotifyMe').replace('手机推送', 'NotifyMe');
}
/** 某个渠道配置是不是走 NotifyMe（决定要不要露「NotifyMe 推送选项」）。 */
function isNmFormat(cfg) { return String((cfg && cfg.format) || '') === 'notifyme'; }

/** 规范化 actionType：只认 0/1/2/4/5，其他一律当 0（不动作）。 */
function nmActionValue(v) {
  const n = Number(v);
  return [0, 1, 2, 4, 5].includes(n) ? n : 0;
}

/*
 * 点击动作的「目标值」：只有 1/2/4 需要填。
 * 0（不动作）和 5（从正文抓验证码）不需要 —— 5 还填个 action 只会让人以为有用。
 * 这几个文案同时服务设置页和任务弹层，改一处两边都跟着变。
 */
const NM_ACTION_META = {
  1: { label: '链接地址', ph: 'https://example.com', hint: '点通知直接打开这个网址。' },
  2: { label: '应用包名', ph: 'com.tencent.mobileqq', hint: '点通知启动这个 App（包名在应用信息里能看到）。' },
  4: { label: '要复制的文本', ph: '例：取件码已到驿站', hint: '收到通知的瞬间就把这段文本写进剪贴板；这里的变量不会被替换。' },
};
function syncNmActionField(typeSel, fieldSel, labelSel, hintSel, inputSel) {
  const sel = $(typeSel);
  if (!sel) return;
  const meta = NM_ACTION_META[nmActionValue(sel.value)] || null;
  const field = $(fieldSel);
  if (field) field.hidden = !meta;
  if (!meta) return;
  if ($(labelSel)) $(labelSel).textContent = meta.label;
  if ($(hintSel)) $(hintSel).textContent = meta.hint;
  const inp = $(inputSel);
  if (inp && !inp.value.trim()) inp.placeholder = meta.ph;
}

/** 任务里勾了 NotifyMe（不管是独立通道还是 webhook 的 notifyme 方案）就露任务级选项。 */
function nmTaskSelected() {
  const vals = $$('#fNotifyChannels input:checked').map((i) => i.value);
  return vals.some((v) => {
    if (v === 'notifyme') return true;
    if (v === 'webhook') return isNmFormat((S.data.settings || {}).webhook);
    if (v.indexOf('webhook:') === 0) {
      const inst = channelInstancesOf('webhook').find((x) => x.id === v.slice(8));
      return isNmFormat(inst && inst.config);
    }
    return false;
  });
}
function syncNmTaskBlock() {
  const box = $('#fNmBlock');
  if (!box) return;
  box.hidden = !nmTaskSelected();
  syncNmActionField('#fNmActionType', '#fNmActionField', '#fNmActionLabel', '#fNmActionHint', '#fNmAction');
}

function fillNmTask(nmPush) {
  const n = nmPush && typeof nmPush === 'object' ? nmPush : {};
  if ($('#fNmBigText')) $('#fNmBigText').value = n.bigText === undefined ? '' : (n.bigText ? '1' : '0');
  if ($('#fNmActionType')) $('#fNmActionType').value = n.actionType === undefined ? '' : String(nmActionValue(n.actionType));
  if ($('#fNmAction')) $('#fNmAction').value = n.action || '';
  if ($('#fNmGroup')) $('#fNmGroup').value = n.group || '';
  if ($('#fNmUrgent')) $('#fNmUrgent').value = n.urgent === undefined ? '' : (n.urgent ? '1' : '0');
  syncNmTaskBlock();
}

/** 收集任务级覆盖：全空返回 null，表示完全跟随设置页（不落库）。 */
function collectNmTask() {
  const out = {};
  const bt = $('#fNmBigText') ? $('#fNmBigText').value : '';
  if (bt !== '') out.bigText = bt === '1';
  const at = $('#fNmActionType') ? $('#fNmActionType').value : '';
  if (at !== '') out.actionType = nmActionValue(at);
  const ac = (($('#fNmAction') && $('#fNmAction').value) || '').trim();
  if (ac) out.action = ac;
  const g = (($('#fNmGroup') && $('#fNmGroup').value) || '').trim();
  if (g) out.group = g;
  const ug = $('#fNmUrgent') ? $('#fNmUrgent').value : '';
  if (ug !== '') out.urgent = ug === '1';
  return Object.keys(out).length ? out : null;
}

/**
 * 「预览请求体」：不自己拼，找后端要 —— 和真实发送共用 buildNotifyMePayload。
 * 自己在前端拼一份必然和线上不一致，那就又变回「预览说没事、实际发出去字段没了」。
 */
async function previewNmPayload() {
  const box = $('#whPreview');
  const btn = $('#whPrevBtn');
  if (!box) return;
  if (btn) btn.disabled = true;
  try {
    const chId = activeChannelId('webhook');
    const r = await api('/api/notifyme/preview', {
      method: 'POST',
      body: {
        channelId: chId === 'main' ? '' : chId,
        format: 'notifyme',
        actionType: nmActionValue($('#whActionType') && $('#whActionType').value),
        action: (($('#whAction') && $('#whAction').value) || '').trim(),
        group: (($('#whGroup') && $('#whGroup').value) || '').trim(),
        urgent: !!($('#whUrgent') && $('#whUrgent').checked),
        bigText: !!($('#whBigText') && $('#whBigText').checked),
      },
    });
    const adv = r.advanced || {};
    const head = [
      `# ${r.scheme} · ${r.mode === 'uuid' ? 'UUID（新版网关）' : 'FCM token（旧版网关）'}`,
      `# 端点：${r.endpoint}${r.hasCred ? '' : '（还没填凭据，发送时会跳过）'}`,
      `# 大文本 ${adv.bigText ? '开' : '关'} · 点击动作 ${adv.actionType ? adv.actionType : '无'}`
        + `${adv.action ? ' → ' + adv.action : ''} · ${adv.group ? '分组 ' + adv.group : '不分组'}${adv.urgent ? ' · 紧急响铃' : ''}`,
      '',
    ].join('\n');
    box.textContent = head + JSON.stringify(r.payload, null, 2);
    box.hidden = false;
  } catch (e) {
    box.textContent = '预览失败：' + (e && e.message ? e.message : e);
    box.hidden = false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function channelInstancesOf(type) {
  const all = (S.data && S.data.settings && S.data.settings.channelInstances) || {};
  return Array.isArray(all[type]) ? all[type] : [];
}

function activeChannelId(type) {
  const id = CH_ACTIVE[type] || 'main';
  if (id !== 'main' && !channelInstancesOf(type).some((x) => x.id === id)) return 'main';
  return id;
}

/** 当前标签对应的配置（默认标签回落到老字段）。 */
function activeChannelConfig(type) {
  const st = S.data.settings || {};
  const id = activeChannelId(type);
  if (id === 'main') {
    if (type === 'webhook') return { format: 'generic', ...(st.webhook || {}) };
    if (type === 'email') return { port: 465, ...(st.smtp || {}) };
    if (type === 'ai') return { ...(st.ai || {}) };
    return { ...(st.sms || {}) };
  }
  const inst = channelInstancesOf(type).find((x) => x.id === id);
  return inst ? { ...(inst.config || {}) } : {};
}

function activeChannelEnabled(type) {
  const id = activeChannelId(type);
  if (id === 'main') return !!activeChannelConfig(type).enabled;
  const inst = channelInstancesOf(type).find((x) => x.id === id);
  return inst ? inst.enabled !== false : false;
}

/** 表单 ← 配置 */
function hydrateChannel(type) {
  const cfg = activeChannelConfig(type);
  if (type === 'webhook') {
    $('#whFormat').value = cfg.format || 'generic';
    $('#whUrl').value = cfg.url || '';
    // 接口回显的是掩码，留空 = 不修改（后端 isMaskedValue 走保留原值分支）
    fillSecretField('#whToken', cfg.token);
    fillSecretField('#whUuid', cfg.uuid, '已保存（已隐藏），留空则不修改');
    fillSecretField('#whFcm', cfg.fcm, '已保存（已隐藏），留空则不修改');
    // 老配置只存了 token：按形态回填到对应字段，用户看到的是它在哪一格，而不是空着
    const legacyTok = String(cfg.token || '');
    if (legacyTok && !isMaskedVal(legacyTok)) {
      if (legacyTok.includes(':')) { if (!$('#whFcm').value) $('#whFcm').value = legacyTok; }
      else if (!$('#whUuid').value) $('#whUuid').value = legacyTok;
    }
    // NotifyMe 高级选项
    if ($('#whBigText')) $('#whBigText').checked = cfg.bigText !== false;
    if ($('#whActionType')) $('#whActionType').value = String(nmActionValue(cfg.actionType));
    if ($('#whAction')) $('#whAction').value = cfg.action || '';
    if ($('#whGroup')) $('#whGroup').value = cfg.group || '';
    if ($('#whUrgent')) $('#whUrgent').checked = cfg.urgent === true;
    if ($('#whPreview')) { $('#whPreview').hidden = true; $('#whPreview').textContent = ''; }
    syncWhTokenHint();
    $('#whEnabled').checked = activeChannelEnabled(type);
  } else if (type === 'email') {
    $('#smtpHost').value = cfg.host || '';
    $('#smtpPort').value = cfg.port || 465;
    $('#smtpUser').value = cfg.user || '';
    fillSecretField('#smtpPass', cfg.pass, '已保存的密码，留空则不修改');
    $('#smtpTo').value = cfg.to || '';
    $('#smtpEnabled').checked = activeChannelEnabled(type);
  } else if (type === 'ai') {
    $('#aiEnabled').checked = activeChannelEnabled(type);
    $('#aiProvider').value = cfg.provider || guessAiProvider(cfg.baseUrl || '');
    $('#aiBaseUrl').value = cfg.baseUrl || '';
    $('#aiModel').value = cfg.model || '';
    fillSecretField('#aiApiKey', cfg.apiKey, '已保存的 Key，留空则不修改');
    $('#aiDefaultPrompt').value = cfg.defaultPrompt || '';
    // 单次超时 / 最多尝试：老配置没有这两项，按 20 秒 / 2 次回填（与后端默认值一致）
    const tSel = $('#aiTimeout');
    if (tSel) {
      const want = Number(cfg.timeoutMs) || 20000;
      Array.from(tSel.options).forEach((o) => { if (o.dataset.extra) o.remove(); });
      if (!Array.from(tSel.options).some((o) => Number(o.value) === want)) {
        const opt = document.createElement('option');
        opt.value = String(want);
        opt.dataset.extra = '1';
        opt.textContent = `${Math.round(want / 1000)} 秒`;
        tSel.appendChild(opt);
      }
      tSel.value = String(want);
    }
    const aSel = $('#aiMaxAttempts');
    if (aSel) aSel.value = String(Number(cfg.maxAttempts) || 2);
  } else if (type === 'sms') {
    const el = $('#smsEnabled');
    if (el) el.checked = activeChannelEnabled(type);
    const sms = (S.data && S.data.settings && S.data.settings.sms) || {};
    const lv = $('#smsMinLevel');
    if (lv) lv.value = sms.minLevel === 'all' ? 'all' : 'important';
    const mc = $('#smsMaxChars');
    if (mc) mc.value = String(sms.maxChars || 134);
    const al = $('#smsActionLink');
    if (al) al.checked = sms.actionLink === true;
    renderSmsPreview();
    loadSmsState();
  }
  renderChannelTabs();
}

/** 表单 → 配置 */
function collectChannelConfig(type) {
  if (type === 'webhook') {
    const isNm = $('#whFormat').value === 'notifyme';
    const cfg = {
      enabled: !!($('#whEnabled') && $('#whEnabled').checked),
      format: $('#whFormat').value,
      url: ($('#whUrl').value || '').trim(),
    };
    /*
     * NotifyMe 走下面两个专用字段，通用 token 不参与。
     * 但**不能**在这里塞 token: '' —— 老配置的 FCM token 就存在 token 里，
     * 保存一次 NotifyMe 设置就会把它清空，之后所有推送都报「要填凭据」。
     * 不提交这个 key，服务端 deepMerge 才会保留原值。
     */
    if (!isNm) cfg.token = ($('#whToken').value || '').trim();
    // 掩码回显时输入框是空的：此时不提交该 key，deepMerge 才会保留服务端原值（留空 = 不修改）
    for (const [key, sel] of [['uuid', '#whUuid'], ['fcm', '#whFcm']]) {
      const box = $(sel);
      if (!box) continue;
      const v = box.value.trim();
      if (box.dataset.hasSecret === '1' && !v) continue;
      cfg[key] = v;
    }
    // NotifyMe 高级选项：不是凭据，每次都整体提交（清空就是要清空）
    if (isNm) {
      cfg.bigText = !!($('#whBigText') && $('#whBigText').checked);
      cfg.actionType = nmActionValue($('#whActionType') && $('#whActionType').value);
      cfg.action = (($('#whAction') && $('#whAction').value) || '').trim();
      cfg.group = (($('#whGroup') && $('#whGroup').value) || '').trim();
      cfg.urgent = !!($('#whUrgent') && $('#whUrgent').checked);
    }
    return cfg;
  }
  if (type === 'email') {
    return {
      enabled: !!($('#smtpEnabled') && $('#smtpEnabled').checked),
      host: ($('#smtpHost').value || '').trim(),
      port: Number($('#smtpPort').value) || 465,
      user: ($('#smtpUser').value || '').trim(),
      pass: $('#smtpPass').value || '',
      from: ($('#smtpUser').value || '').trim(),
      to: ($('#smtpTo').value || '').trim(),
    };
  }
  if (type === 'ai') {
    return {
      enabled: !!($('#aiEnabled') && $('#aiEnabled').checked),
      provider: $('#aiProvider').value || '',
      baseUrl: ($('#aiBaseUrl').value || '').trim(),
      apiKey: ($('#aiApiKey').value || '').trim(),
      model: ($('#aiModel').value || '').trim(),
      defaultPrompt: ($('#aiDefaultPrompt').value || '').trim(),
      // 这两个值服务端还会再夹一次范围（5s–120s / 1–3 次），前端只负责传上去
      timeoutMs: Number($('#aiTimeout') && $('#aiTimeout').value) || 20000,
      maxAttempts: Number($('#aiMaxAttempts') && $('#aiMaxAttempts').value) || 2,
    };
  }
  return { enabled: !!($('#smsEnabled') && $('#smsEnabled').checked) };
}

/** 把表单写回「当前标签」：默认标签 → 老字段，实例标签 → 该实例配置。 */
async function persistChannel(type, okMsg) {
  const id = activeChannelId(type);
  const cfg = collectChannelConfig(type);
  if (id === 'main') {
    const patch = {};
    if (type === 'webhook') patch.webhook = cfg;
    else if (type === 'email') patch.smtp = cfg;
    else if (type === 'ai') patch.ai = cfg;
    else patch.sms = cfg;
    return saveSettings(patch, okMsg);
  }
  const list = channelInstancesOf(type).map((inst) => (inst.id === id
    ? { ...inst, enabled: !!cfg.enabled, config: { ...(inst.config || {}), ...cfg } }
    : inst));
  return saveSettings({ channelInstances: { [type]: list } }, okMsg);
}

/** 标签标题：第一套就是渠道名，之后自动编号（短信通知2、短信通知3…）。 */
function tabTitleOf(type, index) {
  const base = CH_META[type].title || CH_META[type].label;
  if (!index) return base;
  return /[A-Za-z0-9]$/.test(base) ? `${base} ${index + 1}` : `${base}${index + 1}`;
}

/** 某套配置的「标识」：默认标签存在 settings.channelMarks，实例存在 remark。 */
function channelMarkOf(type, id) {
  if (!id || id === 'main') {
    const marks = (S.data && S.data.settings && S.data.settings.channelMarks) || {};
    return String(marks[type] || '').trim();
  }
  const inst = channelInstancesOf(type).find((x) => x.id === id);
  return String((inst && inst.remark) || '').trim();
}

/**
 * 渲染四张卡片顶部的「胶囊分段」：外圈灰底，选中项为白色圆角块（参照系统分段控件）。
 * 每个账号一段，段内小字是标识；当前账号的标识另在小字行里可点改。
 */
function renderChannelTabs() {
  for (const type of Object.keys(CH_META)) {
    const box = document.querySelector(`.ch-nav[data-type="${type}"]`);
    if (!box) continue;
    const list = channelInstancesOf(type);
    const actId = activeChannelId(type);
    const entries = [{ id: 'main' }].concat(list.map((i) => ({ id: i.id })));

    const segs = entries.map((en, i) => {
      const inst = en.id === 'main' ? null : list.find((x) => x.id === en.id);
      const off = inst ? inst.enabled === false : !activeChannelConfig(type).enabled;
      const mark = channelMarkOf(type, en.id);
      // 新建账号的段标题就是它自己的名字，别再叠一层标识（否则「Webhook 2 Webhook 2」）
      const label = en.id === 'main' ? tabTitleOf(type, 0) : (String((inst && inst.remark) || '').trim() || tabTitleOf(type, i));
      const markHtml = en.id === 'main' && mark ? `<span class="ch-seg-mark">${esc(mark)}</span>` : '';
      return `<button type="button" class="ch-seg-item${en.id === actId ? ' is-on' : ''}${off ? ' is-off' : ''}" data-type="${type}" data-id="${esc(en.id)}" title="点击切换 · 长按新建一个账号（不含凭证）">${esc(label)}${markHtml}</button>`;
    }).join('');

    const mark = channelMarkOf(type, actId);
    const isMain = actId === 'main';
    box.innerHTML = `<div class="ch-seg">${segs}</div>
      <div class="ch-mark">
        ${isMain
          ? `<span class="ch-mark-txt${mark ? '' : ' is-empty'}" data-act="mark" title="点一下改标识（多账号时用来区分）">${mark ? '标识：' + esc(mark) : '点此添加标识'}</span>`
          : `<span class="ch-mark-txt is-empty" data-act="mark" title="给这个账号改个名字">点此改名</span>
             <span class="ch-mark-del" data-act="del" title="删除这个账号">×</span>`}
      </div>`;
  }
}

async function switchChannelTab(type, id) {
  CH_ACTIVE[type] = id;
  hydrateChannel(type);
}

/**
 * 长按标题 = 新建一个账号：照抄当前这套的配置，但把凭证清空。
 * 清空在后端做（token / 密码 / API Key），避免前端拿到脱敏串抄出一份空值。
 */
async function cloneChannelTab(type, fromId) {
  if (channelInstancesOf(type).length >= CH_TABS_MAX) {
    toast(`每个渠道最多 ${CH_TABS_MAX} 个账号`, 'err');
    return;
  }
  try {
    const r = await api('/api/channel-instances/copy', { method: 'POST', body: { type, from: fromId || 'main', stripSecrets: true } });
    await load();
    CH_ACTIVE[type] = r.id;
    hydrateChannel(type);
    toast(`已新建「${r.remark}」，凭证已清空，填好新账号再点保存`, 'ok');
  } catch (e) {
    toast(e.message || '新建失败', 'err');
  }
}

async function deleteChannelTab(type, id) {
  if (id === 'main') return;
  const inst = channelInstancesOf(type).find((x) => x.id === id);
  if (!inst) return;
  const name = tabTitleOf(type, channelInstancesOf(type).findIndex((x) => x.id === id) + 1);
  const mark = channelMarkOf(type, id);
  if (!confirm(`删除「${name}${mark ? ' · ' + mark : ''}」？使用它的任务会收到「配置已删除」的提示。`)) return;
  const ok = await saveSettings({ channelInstances: { [type]: channelInstancesOf(type).filter((x) => x.id !== id) } }, '这个账号已删除');
  if (ok) {
    CH_ACTIVE[type] = 'main';
    await load();
    hydrateChannel(type);
  }
}

/** 改「标识」：默认账号写 settings.channelMarks，新建的账号写 remark。 */
async function editChannelMark(type, id) {
  const cur = channelMarkOf(type, id);
  const mark = prompt('写个标识，用来区分不同用户 / 用途（最多 24 字）：', cur);
  if (mark === null) return;
  const val = String(mark).trim().slice(0, 24);
  if (val === cur) return;
  if (!id || id === 'main') {
    const marks = { ...((S.data.settings && S.data.settings.channelMarks) || {}), [type]: val };
    await saveSettings({ channelMarks: marks }, val ? `标识已改为「${val}」` : '标识已清空');
  } else {
    const list = channelInstancesOf(type).map((x) => (x.id === id ? { ...x, remark: val } : x));
    await saveSettings({ channelInstances: { [type]: list } }, val ? `标识已改为「${val}」` : '标识已清空');
  }
  await load();
}

/** 分段交互：点击切换 / 双击改标识 / 长按 600ms 新建账号 / 小字改标识 / × 删除。 */
function bindChannelTabs() {
  let suppressClick = false;

  document.addEventListener('click', (e) => {
    const seg = e.target.closest('.ch-seg-item');
    if (seg) {
      if (suppressClick) { suppressClick = false; return; }
      switchChannelTab(seg.dataset.type, seg.dataset.id || 'main');
      return;
    }
    const del = e.target.closest('.ch-mark-del');
    if (del) {
      const nav = del.closest('.ch-nav');
      if (nav) deleteChannelTab(nav.dataset.type, activeChannelId(nav.dataset.type));
      return;
    }
    const markEl = e.target.closest('[data-act="mark"]');
    if (markEl) {
      const nav = markEl.closest('.ch-nav');
      if (nav) editChannelMark(nav.dataset.type, activeChannelId(nav.dataset.type));
    }
  });

  // 双击分段 = 改标识（不想点小字时的捷径）
  document.addEventListener('dblclick', (e) => {
    const seg = e.target.closest('.ch-seg-item');
    if (!seg) return;
    editChannelMark(seg.dataset.type, seg.dataset.id || 'main');
  });

  // 长按分段 600ms = 新建一个账号（照抄配置，凭证清空）
  let hold = null;
  const clearHold = () => { if (hold) { clearTimeout(hold); hold = null; } };
  document.addEventListener('pointerdown', (e) => {
    const seg = e.target.closest('.ch-seg-item');
    if (!seg || e.button > 0) return;
    clearHold();
    hold = setTimeout(() => {
      hold = null;
      suppressClick = true;
      if (navigator.vibrate) navigator.vibrate(15);
      cloneChannelTab(seg.dataset.type, seg.dataset.id || 'main');
    }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel', 'scroll'].forEach((ev) => document.addEventListener(ev, clearHold, true));

  // 长按触发系统菜单会打断手势，这里直接禁掉
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ch-seg-item')) e.preventDefault();
  });
}

/**
 * 任务弹窗里的渠道选项：默认那套 + 每个实例一行。
 * 值就是服务端认的写法：webhook / webhook:ci_xxx。
 */
/**
 * 渠道在这台机器上到底能不能发。
 *
 * 「配好了」不看开关一个字，而是看开关 + 必要字段：
 * 只开了开关却连 host 都没填的邮件账号，发出去只会失败，不该出现在任务的选项里。
 * inst 传 undefined 表示判断「默认那一套」，传实例则判断该实例。
 */
function channelUsable(type, inst) {
  const st = (S.data && S.data.settings) || {};
  const cfg = inst ? (inst.config || {}) : null;
  const base = cfg || (type === 'webhook' ? st.webhook : type === 'email' ? st.smtp : type === 'sms' ? st.sms : st.ai) || {};
  const enabled = inst ? inst.enabled !== false && cfg.enabled !== false : !!base.enabled;
  if (!enabled) return false;
  if (type === 'webhook') return !!(base.url || base.token || base.uuid || base.fcm);
  if (type === 'email') return !!(base.host && base.user && base.to);
  if (type === 'sms') return true; // 短信凭据全局共用，开关就是判据
  return false;
}

/** 手机推送（NotifyMe）是全局单独一套，不跟 webhook 走。 */
function notifymeUsable() {
  const nm = ((S.data && S.data.settings && S.data.settings.notifyme) || {});
  return !!nm.enabled && !!(nm.uuid || nm.fcm);
}

/**
 * 任务弹窗里的渠道选项。
 *
 * 四条规则：
 *  ① 站内固定第一位、固定勾选、点不掉 —— 站内是「至少留一条记录」的地板。
 *     但**不再画小锁**：锁住的灰块看着像「功能被禁用」，用户会去设置里找开关。
 *     现在就是普通选中态，点它会弹一句「必选项，不能取消」。
 *  ② 顺序按「主用 → 次用 → 备用」：NotifyMe（手机推送）→ 短信 → 其余方案/邮件。
 *  ③ 只列已经配置好的渠道，没配的根本不出现，否则用户以为勾上就能收到。
 *  ④ Webhook 显示它当前的方案名（NotifyMe / Bark / 飞书…），不写「Webhook」。
 */
function renderTaskChannelChips(remindChans, notifyChans) {
  const parts = [{ v: 'inapp', t: '站内通知', req: true }];
  /*
   * 「NotifyMe（手机推送）」和 Webhook 的 NotifyMe 格式是同一个出口：两个勾选框发同一条通知，
   * 只会让人以为「少勾一个就收不到」。所以 Webhook 已经配成 NotifyMe 格式时，这里不再单列。
   *
   * 但不能无条件藏：如果 Webhook 配的是飞书 / 钉钉 / Server酱，
   * 独立入口就是唯一能发到手机的通道，藏了等于静默丢掉推送能力。
   */
  const whCoversNotifyme = (() => {
    const st = (S.data && S.data.settings) || {};
    if (channelUsable('webhook') && isNmFormat(st.webhook)) return true;
    return channelInstancesOf('webhook').some((inst) => channelUsable('webhook', inst)
      && isNmFormat(inst.config));
  })();
  // 三组分开攒，最后按「手机推送 → 短信 → 其余」拼，避免跟着渠道类型的循环顺序走
  const nmGroup = [];
  const smsGroup = [];
  const restGroup = [];
  if (notifymeUsable() && !whCoversNotifyme) nmGroup.push({ v: 'notifyme', t: 'NotifyMe' });

  for (const type of ['webhook', 'email']) {
    if (channelUsable(type)) {
      const mainMark = channelMarkOf(type, 'main');
      const cfg = type === 'webhook' ? ((S.data.settings && S.data.settings.webhook) || {}) : null;
      const base = type === 'webhook' ? whSchemeName(cfg && cfg.format) : tabTitleOf(type, 0);
      const part = { v: type, t: `${base}${mainMark ? ` · ${mainMark}` : ''}` };
      (type === 'webhook' && isNmFormat(cfg) ? nmGroup : restGroup).push(part);
    }
    channelInstancesOf(type).forEach((inst, i) => {
      if (!channelUsable(type, inst)) return;
      const mark = String(inst.remark || '').trim();
      const base = type === 'webhook'
        ? `${whSchemeName((inst.config || {}).format)} ${i + 2}`
        : tabTitleOf(type, i + 1);
      const part = { v: `${type}:${inst.id}`, t: `${base}${mark ? ` · ${mark}` : ''}` };
      (type === 'webhook' && isNmFormat(inst.config) ? nmGroup : restGroup).push(part);
    });
  }
  if (channelUsable('sms')) {
    const mainMark = channelMarkOf('sms', 'main');
    smsGroup.push({ v: 'sms', t: `${tabTitleOf('sms', 0)}${mainMark ? ` · ${mainMark}` : ''}` });
  }
  channelInstancesOf('sms').forEach((inst, i) => {
    if (!channelUsable('sms', inst)) return;
    const mark = String(inst.remark || '').trim();
    smsGroup.push({ v: `sms:${inst.id}`, t: `${tabTitleOf('sms', i + 1)}${mark ? ` · ${mark}` : ''}` });
  });
  parts.push(...nmGroup, ...smsGroup, ...restGroup);

  /*
   * 兜底：任务里已经存着、但上面没有渲染出来的渠道值（典型是老任务里的 notifyme，
   * 或账号已被删掉的 webhook:<id>）补一个 chip 出来。
   * 不补的话，打开弹层再点保存，这些值会从 channels 里被静默抹掉 —— 等于悄悄关掉推送。
   */
  const known = new Set(parts.map((p) => p.v));
  /*
   * 两侧都要兜底：#fChannels 渲染的是 remindChans（提醒类任务的 config.channels），
   * #fNotifyChannels 渲染的是 notifyChans（完成通知的 config.notify.channels）。
   * 只遍历 notifyChans 时，提醒任务里存过的老渠道值不会补出 chip，
   * 打开弹层再保存就被静默抹掉 —— 等于悄悄关掉这个任务的推送。
   */
  const legacyValues = new Set([
    ...(Array.isArray(remindChans) ? remindChans : []),
    ...(Array.isArray(notifyChans) ? notifyChans : []),
  ]);
  for (const v of legacyValues) {
    if (known.has(v) || v === 'inapp') continue;
    known.add(v);
    const type = String(v).split(':')[0];
    const label = v === 'notifyme'
      ? 'NotifyMe（旧配置）'
      : (CH_META[type] ? `${CH_META[type].title}（历史账号）` : v);
    parts.push({ v, t: label });
  }

  const html = parts.map((p) => (p.req
    // 必选项：正常勾选态，靠 change 事件拦「取消」，不再用 disabled + 🔒
    ? `<label class="chip chip--req" title="站内通知必选，不能取消"><input type="checkbox" value="${esc(p.v)}" checked data-req="1"><span>${esc(p.t)}</span></label>`
    : `<label class="chip"><input type="checkbox" value="${esc(p.v)}"><span>${esc(p.t)}</span></label>`)).join('');

  const values = new Set(parts.map((p) => p.v));
  const paint = (box, vals) => {
    if (!box) return;
    box.innerHTML = html;
    const list = Array.isArray(vals) ? vals : [];
    // 只勾「还在选项里」的值：已删除 / 未配置的渠道不留下勾选残留
    $$('input', box).forEach((i) => { i.checked = i.value === 'inapp' || (values.has(i.value) && list.includes(i.value)); });
  };
  paint($('#fChannels'), remindChans);
  paint($('#fNotifyChannels'), notifyChans);
}

function renderSettings() {
  const st = S.data.settings;
  applySecretMode();
  /*
   * 补跑状态每次渲染都刷（放在 hydrate 门控之外）：
   * 它反映的是「本次启动补了几个、跳过几个」，会随队列推进变化，
   * 塞进一次性 hydrate 里就会停在首帧，看着像一直没动静。
   */
  const cuState = S.data.catchup || {};
  if ($('#cuLast')) {
    if (!cuState.at) {
      $('#cuLast').textContent = '本次启动还没有需要补跑的任务。';
    } else if (cuState.running) {
      $('#cuLast').textContent = `正在补跑：已完成 ${cuState.done || 0} 个，队列还剩 ${cuState.queued || 0} 个。`;
    } else {
      const why = (cuState.reasons || []).slice(0, 2).map((r) => `${r.name}：${r.label}`).join('；');
      $('#cuLast').textContent = `上次启动：计划补跑 ${cuState.planned || 0} 个，完成 ${cuState.done || 0}，失败 ${cuState.failed || 0}，跳过 ${cuState.skipped || 0}`
        + (why ? `（${why}${(cuState.reasons || []).length > 2 ? ' 等' : ''}）` : '')
        + `。${cuState.at ? '时间 ' + new Date(cuState.at).toLocaleString('zh-CN') : ''}`;
    }
  }
  if (!smtpHydrated) {
    // 四个通知渠道按「当前激活的标签」回显（默认标签 = 老的单套配置）
    renderChannelTabs();
    hydrateChannel('sms');
    hydrateChannel('webhook');
    hydrateChannel('email');
    hydrateChannel('ai');

    // 错过补跑策略回显
    const mp = (st.missedPolicy === 'skip') ? 'skip' : 'run';
    $$('#missedPolicy input').forEach((i) => { i.checked = i.value === mp; });

    // 补跑细则回显：全部带兜底值，state 里缺字段（老数据）也不会把输入框清成空
    const cu = st.catchup || {};
    const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    if ($('#cuEnabled')) $('#cuEnabled').checked = cu.enabled !== false;
    if ($('#cuWindow')) $('#cuWindow').value = numOr(cu.windowMinutes, 120);
    if ($('#cuMax')) $('#cuMax').value = numOr(cu.maxPerStart, 5);
    if ($('#cuMinGap')) $('#cuMinGap').value = numOr(cu.minGapSec, 45);
    if ($('#cuJitter')) $('#cuJitter').value = Math.round(numOr(cu.jitterMaxMs, 20000) / 1000);

    /*
     * 短信网关 / 中转页面已下线（导航入口与整页都已移除），回显前先确认控件还在。
     * 不判空会抛 TypeError，让这段之后的所有初始化一起不执行 ——
     * 那是一个可选页面拖垮整页，完全不成比例。
     */
    if ($('#gwEnabled')) {
      const gw = st.gatewaySms || {};
      $('#gwEnabled').checked = !!gw.enabled;
      fillSecretField('#gwToken', gw.token, '已保存的令牌（已隐藏），留空则不修改');
      updateGatewaySnippet();
    }

    // 短信发送中继回显（控件在短信卡片里，随页面一起加载）
    if ($('#sgrEnabled')) {
      const sgr = st.smsGatewayRelay || {};
      $('#sgrEnabled').checked = !!sgr.enabled;
      $('#sgrUrl').value = sgr.url || '';
      if ($('#sgrUrls')) $('#sgrUrls').value = Array.isArray(sgr.urls) ? sgr.urls.join(', ') : '';
      fillSecretField('#sgrSecret', sgr.secret, '已保存的密钥（已隐藏），留空则不修改');
      renderSgrState();
    }
    // 白名单 SNI 伪装回显
    if ($('#sgsEnabled')) {
      const sgs = st.smsGatewaySni || {};
      $('#sgsEnabled').checked = !!sgs.enabled;
      $('#sgsSni').value = sgs.sni || '';
      renderSgsState();
    }

    smtpHydrated = true;
  }
  // 每次渲染都刷新标签栏（实例可能刚新建/改名/删除），但不碰表单内容
  renderChannelTabs();

  loadTokenStatus();
  loadGatewayLog();

  const m = S.data.meta;
  renderServerInfo(m);
  applyChannelFold();
}

/* ------------------------------------------------------------ 设置页：未配置渠道折叠 */

/*
 * 四张渠道卡里，没配置过的那几张（典型是「邮件通知」）默认只留一行标题，
 * 点一下才展开整套表单。
 *
 * 为什么要做：设置页一屏要摆短信、Webhook、邮件、AI 四套表单，
 * 没用过的渠道占着 90% 的纵向空间，真正要调的「服务器」反而被挤到折叠线以下。
 *
 * 折叠只是「隐藏」，不改变任何数据：renderSettings 仍然把值填进控件，
 * 展开即所见即所得。已配置的渠道完全不受影响，长得跟以前一样。
 */
const CH_FOLD_KEY = 'cronhub.fold.channels';

/** 渠道是否「配过」：口径放宽到「填了东西」，未启用也算配过，免得刚填完被折叠藏起来。 */
function channelConfigured(type) {
  const st = (S.data && S.data.settings) || {};
  const insts = channelInstancesOf(type);
  const anyInst = (pred) => insts.some((i) => pred(i.config || {}));
  if (type === 'ai') {
    const ai = st.ai || {};
    return !!((ai.baseUrl && ai.apiKey && ai.model) || anyInst((c) => c.baseUrl && c.apiKey && c.model));
  }
  if (type === 'email') {
    const s = st.smtp || {};
    return !!((s.host && s.user && s.to) || anyInst((c) => c.host && c.user && c.to));
  }
  if (type === 'sms') {
    const s = st.sms || {};
    // 短信是扫码授权 + 全局开关，开关就是「我在用它」的判据
    return !!s.enabled || insts.length > 0;
  }
  if (type === 'webhook') {
    const w = st.webhook || {};
    return !!(w.url || w.token || w.uuid || w.fcm
      || anyInst((c) => c.url || c.token || c.uuid || c.fcm));
  }
  return true;
}

function readFoldMap() {
  try {
    const v = JSON.parse(localStorage.getItem(CH_FOLD_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/*
 * 可折叠的卡片清单：通知通道四张（短信 / Webhook / 邮件 / AI）靠 ch-nav 定位，
 * 环境变量与凭据续期直接用 id。默认**全部收起**，只留一行「项名 + 状态 + 展开」——
 * 这一屏十几张卡全摊开就是用户说的「太乱」，找某项要滚半天。
 */
const FOLD_CARDS = [
  { type: 'sms', title: '短信通知' },
  { type: 'webhook', title: 'Webhook 推送' },
  { type: 'email', title: '邮件通知' },
  { type: 'ai', title: 'AI 通知优化' },
  { type: 'env', title: '环境变量', sel: '#envCard' },
  { type: 'token', title: '凭据自动续期', sel: '#tokenCard' },
];

/** 收起时那一行右侧的状态文案：不展开也知道「有没有在用」。 */
function foldTagOf(type) {
  const st = (S.data && S.data.settings) || {};
  if (type === 'env') {
    const n = (st.envVars || []).length;
    return n ? `${n} 个变量` : '未配置';
  }
  if (type === 'token') {
    const tv = st.tokenVault || {};
    return tv.enabled ? '已启用' : '未启用';
  }
  return channelConfigured(type) ? '已配置' : '未配置';
}

function applyChannelFold() {
  const map = readFoldMap();
  for (const item of FOLD_CARDS) {
    const card = item.sel
      ? document.querySelector(item.sel)
      : (() => {
        const nav = document.querySelector(`.ch-nav[data-type="${item.type}"]`);
        return nav && nav.closest('.card');
      })();
    if (!card) continue;
    card.classList.add('has-fold');
    let head = card.querySelector(':scope > .ch-fold-head');
    if (!head) {
      head = document.createElement('button');
      head.type = 'button';
      head.className = 'ch-fold-head';
      head.dataset.foldType = item.type;
      head.innerHTML = `<span class="ch-fold-name">${esc(item.title)}</span>
        <span class="ch-fold-tag"></span>
        <span class="ch-fold-carets"></span>`;
      card.insertBefore(head, card.firstChild);
    }
    const collapsed = map[item.type] !== true;
    const tag = head.querySelector('.ch-fold-tag');
    if (tag) tag.textContent = foldTagOf(item.type);
    const carets = head.querySelector('.ch-fold-carets');
    if (carets) carets.textContent = collapsed ? '展开' : '收起';
    card.classList.toggle('is-collapsed', collapsed);
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

/** 点折叠头：展开 ↔ 收起，状态记进 localStorage，45 秒一轮的后台刷新不会打回。 */
function toggleFoldCard(head) {
  const type = head.dataset.foldType;
  if (!type) return;
  const card = head.closest('.card');
  if (!card) return;
  const willCollapse = !card.classList.contains('is-collapsed');
  const map = readFoldMap();
  map[type] = !willCollapse;
  try { localStorage.setItem(CH_FOLD_KEY, JSON.stringify(map)); } catch { /* 无痕模式忽略 */ }
  card.classList.toggle('is-collapsed', willCollapse);
  head.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
  const carets = head.querySelector('.ch-fold-carets');
  if (carets) carets.textContent = willCollapse ? '展开' : '收起';
}


/* ---- 服务器信息 + 连续运行统计 ---- */

/** 秒 → 人话（「1 天 3 小时」「12 分 5 秒」）。 */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s >= 86400) return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  if (s >= 60) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function renderServerInfo(m) {
  const rt = m.runtime || {};
  const ka = m.keepAlive || {};
  const self = ka.self || {};
  const wake = ka.wake || {};
  const curSec = rt.curSec != null ? rt.curSec : m.uptimeSec;
  const errCount = S.data.tasks.filter((t) => (t.failCount || 0) > 0).length;
  const kw = (S.data.settings && S.data.settings.keepWarm) || {};
  const pageOn = kw.pageBeat !== false;

  // 设置页：一行一个状态（保险细节看下面的「长期运行」入口），绿点正常 / 红点异常 / 灰点关闭
  const lines = $('#srvLines');
  if (lines) {
    const rows = [
      {
        s: curSec > 90 ? 'ok' : 'warn',
        t: `已连续运行 ${fmtDur(curSec)}`,
        n: '',   // 最长 / 累计 / 中断在「长期运行」卡里有独立一行，这里不再重复一遍
      },
      {
        s: m.storageWritable === false ? 'err' : 'ok',
        t: m.storageWritable === false ? '数据目录不可写' : '数据可正常保存',
        n: `${m.nodeVersion} · 端口 ${m.port} · ${m.timezone}`,
      },
      {
        s: m.authEnabled ? 'ok' : 'warn',
        t: m.authEnabled ? '访问控制：密码访问' : '访问控制：开放访问',
        n: '',   // 后果与改法在「安全与数据」的访问控制卡里说，这里只留状态
      },
      {
        s: errCount ? 'err' : 'ok',
        t: `任务 ${S.data.tasks.length} 个${errCount ? ` · ${errCount} 个近期失败` : ''}`,
        n: `日志 ${S.data.logs.length} 条 · 服务器时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      },
    ];
    lines.innerHTML = rows.map((r) => `<div class="srv-line"><i class="sdot is-${r.s}"></i><span class="srv-line-main">${esc(r.t)}</span><span class="srv-line-note">${esc(r.n)}</span></div>`).join('');
  }

  // 保活入口摘要（设置页）
  const entryLines = $('#keepEntryLines');
  if (entryLines) {
    const on1 = self.enabled && self.lastOk !== false;
    const on2 = (wake.count || 0) > 0;
    const rows = [
      { s: on1 ? 'ok' : 'off', t: '保险一 · 内置自探活', n: self.enabled ? `每 ${self.everyMin || 10} 分钟` : '未开启' },
      { s: on2 ? 'ok' : 'warn', t: '保险二 · 外部唤醒', n: on2 ? `已唤醒 ${wake.count} 次` : '尚未接入外部定时器' },
      { s: pageOn ? 'ok' : 'off', t: '保险三 · 页面心跳', n: pageOn ? `每 ${Number(kw.pageBeatSec) || 30} 秒` : '已关闭' },
    ];
    entryLines.innerHTML = rows.map((r) => `<div class="srv-line"><i class="sdot is-${r.s}"></i><span class="srv-line-main">${esc(r.t)}</span><span class="srv-line-note">${esc(r.n)}</span></div>`).join('');
  }
  const entryHint = $('#keepEntryHint');
  if (entryHint) {
    const n = (self.enabled && self.lastOk !== false ? 1 : 0) + ((wake.count || 0) > 0 ? 1 : 0) + (pageOn ? 1 : 0);
    entryHint.textContent = n >= 2 ? `三道生效 ${n}/3 · 已经在防休眠` : `生效 ${n}/3 · 建议至少开两道`;
    entryHint.className = n >= 2 ? 'hint hint--ok' : 'hint hint--warn';
  }

  // 系统日志入口摘要（设置页）
  const logsHint = $('#logsEntryHint');
  if (logsHint) {
    const meta = S.sysMeta || {};
    const c = meta.counts || {};
    const err = c.error || 0;
    const warn = c.warn || 0;
    // 卡头只报「跑了多久」：错误 / 警告 / 总量在下面三行已经分行列出
    logsHint.textContent = (S.sysInfo && S.sysInfo.curText) ? `已运行 ${S.sysInfo.curText}` : '';
    logsHint.className = err ? 'hint hint--warn' : 'hint';
  }

  // 长期运行 · 运行概况（设置页）：不点进去也能看到连续运行 / 累计 / 中断 / 内存
  const runLines = $('#keepRunLines');
  if (runLines) {
    const s = S.sysInfo || {};
    const memMB = (s.mem && s.mem.rssMB) || 0;
    const runs = [
      { s: curSec > 90 ? 'ok' : 'warn', t: '连续运行', n: s.curText || '—' },
      { s: 'ok', t: '累计运行', n: s.totalText || '—' },
      { s: (s.interruptions || 0) > 0 ? 'warn' : 'ok', t: '中断空档', n: `${s.interruptions || 0} 次` },
      { s: memMB > 300 ? 'warn' : 'ok', t: '内存占用', n: memMB ? `${memMB} MB` : '—' },
    ];
    runLines.innerHTML = runs.map((r) => `<div class="srv-line"><i class="sdot is-${r.s}"></i><span class="srv-line-main">${esc(r.t)}</span><span class="srv-line-note">${esc(r.n)}</span></div>`).join('');
  }

  // 系统日志 · 计数概览（设置页）
  const logLines = $('#logsEntryLines');
  if (logLines) {
    const meta = S.sysMeta || {};
    const c = meta.counts || {};
    const rows = [
      { s: (c.error || 0) ? 'err' : 'ok', t: '错误', n: `${c.error || 0} 条` },
      { s: (c.warn || 0) ? 'warn' : 'ok', t: '警告', n: `${c.warn || 0} 条` },
      { s: 'ok', t: '日志总量', n: `${meta.total || 0} 条` },
    ];
    logLines.innerHTML = rows.map((r) => `<div class="srv-line"><i class="sdot is-${r.s}"></i><span class="srv-line-main">${esc(r.t)}</span><span class="srv-line-note">${esc(r.n)}</span></div>`).join('');
  }

  // 数据管理 · 数据量概览（设置页）
  const dataHint = $('#dataEntryHint');
  if (dataHint && S.data) {
    dataHint.textContent = `${S.data.tasks.length} 个任务 · ${(S.data.logs || []).length} 条执行记录`;
  }

  const hint = $('#srvStateHint');
  if (hint) {
    const alive = curSec > 90;
    hint.textContent = self.enabled && self.lastOk === true
      ? `运行中 · 自探活正常（${self.lastMsg || ''}）`
      : self.enabled && self.lastOk === false
        ? '自探活异常，请检查保险一'
        : alive ? '运行中 · 未开启自探活' : '刚刚启动';
  }

  const locked = !!m.authEnabled;
  const modeHint = $('#authModeHint');
  if (modeHint) modeHint.textContent = locked ? '已开启' : '已关闭';
  const openNotice = $('#authOpenNotice');
  if (openNotice) openNotice.hidden = locked;
  const lockNotice = $('#authLockNotice');
  if (lockNotice) lockNotice.hidden = !locked;

  // 任务总数徽章与设置页文案保持同步
  renderBadges();
}

/** 侧边栏徽章：保活告警（挂在「设置」上，因为保活控制台收在设置里）。 */
function renderBadges() {
  const badge = $('#settingsAlert');
  if (!badge) return;
  const m = (S.data && S.data.meta) || {};
  const ka = m.keepAlive || {};
  const self = ka.self || {};
  const wake = ka.wake || {};
  const bad = !(self.enabled && self.lastOk !== false) && !(wake.count > 0);
  badge.hidden = !bad;
}

/* ---- 双道保活：状态渲染 ---- */

function wakeUrlOf(token) {
  const sc = (location.search.match(/[?&]sharecode=([^&]+)/) || [])[1]
    || (S.data && S.data.settings && S.data.settings.sharecode) || '';
  return `${location.origin}/api/wake?token=${encodeURIComponent(token || '')}` + (sc ? `&sharecode=${sc}` : '');
}

/* ---- 保活控制台（三道保险统一管理） ---- */

/** 相对时间：3 分钟前 / 2 小时前。 */
function fmtAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

/** 拉一次统一快照。控制台、设置入口、侧边徽章都吃这一份数据。 */
async function refreshKeep(seq) {
  try {
    const keep = await api('/api/keepalive');
    // 与 load() 共用同一序号：先发后到的旧响应不能覆盖较新的保活状态
    if (seq !== undefined && seq !== stateSeq) return;
    S.keep = keep;
  } catch {
    if (seq !== undefined && seq !== stateSeq) return;
    S.keep = S.keep || null;
  }
  renderKeepView();
}

function renderKeepView() {
  const box = $('#keepTiles');
  if (!box) return;
  const k = S.keep;
  const meta = (S.data && S.data.meta) || {};
  const kw = (S.data && S.data.settings && S.data.settings.keepWarm) || {};
  const self = (k && k.self) || ((meta.keepAlive || {}).self) || {};
  const wake = (k && k.wake) || ((meta.keepAlive || {}).wake) || {};
  const page = (k && k.page) || { enabled: kw.pageBeat !== false, beatSec: Number(kw.pageBeatSec) || 30 };
  const rt = (k && k.runtime) || meta.runtime || {};

  // 顶部四个运行时长
  const rtBox = $('#srvRuntime');
  if (rtBox) {
    const curSec = rt.curSec != null ? rt.curSec : meta.uptimeSec || 0;
    const uptimePct = rt.totalSec ? Math.round((curSec / rt.totalSec) * 100) : 100;
    rtBox.innerHTML = `
      <dl class="srv-run"><dt>连续运行（未中断）</dt><dd>${esc(fmtDur(curSec))}<small>占总计 ${uptimePct}%</small></dd></dl>
      <dl class="srv-run"><dt>最长连续运行</dt><dd>${esc(fmtDur(rt.longestSec))}</dd></dl>
      <dl class="srv-run"><dt>累计运行</dt><dd>${esc(fmtDur(rt.totalSec))}</dd></dl>
      <dl class="srv-run"><dt>休眠 / 重启中断</dt><dd>${rt.interruptions || 0}<small>次</small></dd></dl>`;
  }

  // 三道保险一览
  const layers = [
    {
      no: 1,
      name: '内置自探活',
      state: !self.enabled ? 'off' : self.lastOk === false ? 'err' : self.lastOk === true ? 'ok' : 'warn',
      value: !self.enabled ? '未启用' : self.lastOk === false ? '探测失败' : self.lastOk === true ? '正常' : '待探测',
      note: self.enabled
        ? `每 ${self.everyMin || 10} 分钟${self.nextAt ? ` · 下次 ${new Date(self.nextAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`
        : '没有持续流量，平台会判空闲休眠',
    },
    {
      no: 2,
      name: '外部唤醒',
      state: wake.count ? 'ok' : 'warn',
      value: wake.count ? `${wake.count} 次` : '未接入',
      note: wake.count ? `最近 ${fmtAgo(wake.lastAt)}` : '唯一能打醒睡死实例的手段',
    },
    {
      no: 3,
      name: '页面心跳',
      state: page.enabled !== false ? 'ok' : 'off',
      value: page.enabled !== false ? `每 ${page.beatSec || 30} 秒` : '已关闭',
      note: '只在控制台打开时生效',
    },
  ];
  box.innerHTML = layers.map((l) => `
    <div class="keep-tile is-${l.state}">
      <div class="keep-tile-head"><span class="keep-tile-no">${l.no}</span><span>${esc(l.name)}</span><i class="sdot is-${l.state}"></i></div>
      <div class="keep-tile-value">${esc(l.value)}</div>
      <div class="keep-tile-note">${esc(l.note)}</div>
    </div>`).join('');

  // 顶部健康结论
  const good = layers.filter((l) => l.state === 'ok').length;
  const health = $('#keepHealth');
  if (health) {
    const lvl = good >= 2 ? 'ok' : good === 1 ? 'warn' : 'err';
    health.className = 'keep-health is-' + lvl;
    health.innerHTML = `<i class="sdot is-${lvl}"></i>${good}/3 道生效${good >= 2 ? ' · 防休眠良好' : good === 1 ? ' · 建议再加一道' : ' · 实例会休眠'}`;
  }

  // 表单回显（正在输入的框不动）。self/wake 已回退到 meta，所以不依赖 S.keep 是否已加载
  const ae = document.activeElement;
  const setVal = (sel, v) => { const el = $(sel); if (el && el !== ae) el.value = v; };
  {
    if (self.url) setVal('#keepAliveUrl', self.url);
    if (self.everyMin) setVal('#kwInterval', Math.min(60, Math.max(1, Number(self.everyMin) || 2)));
    if (wake.url) setVal('#wakeUrl', wake.url);
    if (page.beatSec) setVal('#kwPageSec', page.beatSec);
    const on1 = $('#kwEnabled');
    if (on1 && on1 !== ae) on1.checked = !!self.enabled;
    const on3 = $('#kwPageEnabled');
    if (on3 && on3 !== ae) on3.checked = page.enabled !== false;
  }

  // 保险一状态与说明
  const s1 = $('#kw1State');
  if (s1) {
    if (!self.enabled) { s1.textContent = '未启用'; s1.className = 'kw-state is-off'; }
    else if (self.lastOk === false) { s1.textContent = `探测失败 · 连败 ${self.failStreak || 1} 次`; s1.className = 'kw-state is-err'; }
    else if (self.lastOk === true) { s1.textContent = `正常 · 已探测 ${self.hits || 0} 次`; s1.className = 'kw-state is-ok'; }
    else { s1.textContent = '等待首次探测'; s1.className = 'kw-state'; }
  }
  const d1 = $('#kw1Detail');
  if (d1) {
    if (!self.enabled) d1.textContent = '开启后服务端每 N 分钟访问一次自己的公网地址。进程内定时器撑不过空闲休眠，要彻底不断还得配下面的外部唤醒。';
    else if (self.lastAt) d1.textContent = `最近一次：${new Date(self.lastAt).toLocaleString('zh-CN', { hour12: false })} · ${self.lastMsg || '—'}` + (self.nextAt ? `　下次：${new Date(self.nextAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '');
    else d1.textContent = '已开启，正在等待首次探测结果…';
  }
  const note = $('#kwStateNote');
  if (note) {
    // 开关状态、间隔、状态标签已经把「现在是什么」说完了，这行只留预警和漏配提示
    note.textContent = self.enabled
      ? (Number(self.everyMin) > 2 ? '⚠ 间隔大于 2 分钟时两次探活之间仍会断（空闲约 1 分钟就停容器），建议改成 1 分钟。' : '')
      : '未开启不影响保险二：外部唤醒只在需要时叫醒实例，其余时间照常休眠省资源。';
  }

  // 保险二
  const s2 = $('#kw2State');
  if (s2) {
    if (wake.count) { s2.textContent = `已唤醒 ${wake.count} 次`; s2.className = 'kw-state is-ok'; }
    else { s2.textContent = '待外部调用'; s2.className = 'kw-state is-off'; }
  }
  const wStats = $('#wakeStats');
  if (wStats) {
    wStats.textContent = wake.count
      ? `最近一次唤醒：${new Date(wake.lastAt).toLocaleString('zh-CN', { hour12: false })}`
      : '还没有外部请求打过这个地址 —— 去 cron-job.org 建一个 1 分钟间隔的监控，才算真正防休眠。';
  }

  // 保险三
  const s3 = $('#kw3State');
  if (s3) {
    s3.textContent = page.enabled !== false ? `开 · 每 ${page.beatSec || 30} 秒` : '已关闭';
    s3.className = 'kw-state ' + (page.enabled !== false ? 'is-ok' : 'is-off');
  }
  const d3 = $('#kwPageDetail');
  if (d3) {
    d3.textContent = `切到后台或关页面自动停；不占服务端资源。`;
  }

  renderKeepLog(k && k.log);
  renderKeepSegments(rt);

  // 侧边徽章 + 设置页入口摘要（快速变化，就地更新）
  renderBadges();
  const entryHint = $('#keepEntryHint');
  if (entryHint) {
    const on2 = (wake.count || 0) > 0;
    const n = (self.enabled && self.lastOk !== false ? 1 : 0) + (on2 ? 1 : 0) + (page.enabled !== false ? 1 : 0);
    entryHint.textContent = n >= 2 ? `生效 ${n}/3 · 已经在防休眠` : `生效 ${n}/3 · 建议至少开两道`;
    entryHint.className = 'hint ' + (n >= 2 ? 'hint--ok' : 'hint--warn');
  }
}

const KEEP_KIND = { self: '自探活', manual: '手动探活', wake: '外部唤醒', start: '启动', stop: '关闭' };

function renderKeepLog(list) {
  const box = $('#keepLog');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="hint hint--block">暂无记录 —— 开启自探活或接入外部唤醒后，这里会有记录</div>';
    return;
  }
  box.innerHTML = list.slice(0, 30).map((e) => `
    <div class="relay-item">
      <div class="relay-meta">
        <i class="sdot is-${e.ok ? 'ok' : 'err'}"></i>
        <span class="keep-kind">${esc(KEEP_KIND[e.kind] || e.kind)}</span>
        <span>${esc(new Date(e.at).toLocaleString('zh-CN', { hour12: false }))}</span>
        ${e.ms ? `<span>${e.ms}ms</span>` : ''}
      </div>
      <div class="relay-content">${esc(e.message || '')}</div>
    </div>`).join('');
}

function renderKeepSegments(rt) {
  const box = $('#keepSegments');
  if (!box) return;
  const segs = (rt && rt.segments) || [];
  const cur = rt && rt.curStart ? [{ start: rt.curStart, end: '', sec: rt.curSec, cur: true }] : [];
  const all = cur.concat(segs);
  if (!all.length) {
    box.innerHTML = '<div class="hint hint--block">暂无记录</div>';
    return;
  }
  box.innerHTML = all.slice(0, 5).map((sg) => `
    <div class="relay-item">
      <div class="relay-meta">
        <i class="sdot is-${sg.cur ? 'ok' : 'off'}"></i>
        <span>${sg.cur ? '进行中' : '已结束'}</span>
        <span>${esc(new Date(sg.start).toLocaleString('zh-CN', { hour12: false }))}</span>
      </div>
      <div class="relay-content">连续 ${esc(fmtDur(sg.sec))}${sg.end ? ` → ${esc(new Date(sg.end).toLocaleTimeString('zh-CN', { hour12: false }))}` : ''}</div>
    </div>`).join('');
}

/* ---- 短信转发中转（总览控制项） ---- */
function smsRelayBaseUrl() {
  const sc = (location.search.match(/[?&]sharecode=([^&]+)/) || [])[1]
    || (S.data && S.data.settings && S.data.settings.sharecode) || '';
  return location.origin + '/gateway/sms/receive' + (sc ? `?sharecode=${sc}` : '');
}

async function renderSmsRelay() {
  const st = (S.data.settings && S.data.settings.smsRelay) || {};
  if (!$('#srUrl')) return;
  $('#srEnabled').checked = !!st.enabled;
  $('#srPush').checked = st.pushNotify !== false;
  $('#srHide').checked = st.hideContent !== false;
  // 令牌在接口侧已打码：这里显示掩码串（表示「已配置」），复制时再走口令换明文
  const masked = isMaskedVal(st.token);
  const token = masked ? (st.token || '') : st.token;
  const tokenShown = token || '<启用后自动生成>';
  const base = smsRelayBaseUrl();
  $('#srUrl').value = base + (base.includes('?') ? '&' : '?') + 'token=' + (masked ? '<已隐藏>' : tokenShown);
  $('#srToken').value = tokenShown;
  $('#srToken').dataset.hasSecret = masked && !!st.token ? '1' : '';
  try {
    const r = await api('/api/sms-relay/log');
    S.relayEntries = r.entries || [];
  } catch {
    S.relayEntries = [];
  }
  renderRelayList();
  renderRelayStats(st);
  renderRelayInbox();
}

/* 中转页顶部统计 + 侧边栏未读徽章 */
function renderRelayStats(st) {
  const list = S.relayEntries || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayN = list.filter((e) => String(e.at || '').slice(0, 10) === today).length;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#relayState', st.enabled ? '接收中' : '已停用');
  set('#relayTotal', String(list.length));
  set('#relayToday', String(todayN));
  set('#relayPushState', st.pushNotify !== false ? '开启' : '关闭');
  // 侧边栏徽章：sms-relay 来源的未读通知数
  const badge = $('#relayCount');
  if (badge) {
    const unread = (S.data.notifications || []).filter((n) => n.source === 'sms-relay' && !n.read).length;
    badge.textContent = unread;
    badge.hidden = unread === 0;
  }
}

/* 中转通知中心：只列短信转发产生的站内通知 */
function renderRelayInbox() {
  const box = $('#relayInbox');
  if (!box) return;
  const list = (S.data.notifications || []).filter((n) => n.source === 'sms-relay').slice(0, 20);
  if (!list.length) {
    box.innerHTML = '<div class="hint hint--block">暂无中转通知——收到转发后会出现在这里</div>';
    return;
  }
  const hide = $('#srHide') ? $('#srHide').checked : true;
  box.innerHTML = list.map((n) => `
    <div class="relay-item ${n.read ? '' : 'is-unread'}" data-ntf="${esc(n.id)}">
      <div class="relay-meta"><strong>${esc(n.title)}</strong><span>${esc(fmtDateTime(n.at))}</span></div>
      <div class="relay-content ${hide ? 'is-masked' : ''}" ${hide ? 'title="点击显示内容"' : ''}>${hide
        ? `已隐藏 · ${(n.body || '').length} 字（点击显示）`
        : esc(n.body || '')}</div>
    </div>`).join('');
}

function renderRelayList() {
  const box = $('#srLog');
  if (!box) return;
  // 中转页已下线，开关可能不存在：默认按「隐藏内容」处理（更保守的一侧）
  const hideEl = $('#srHide');
  const hide = hideEl ? hideEl.checked : true;
  const list = S.relayEntries || [];
  if (!list.length) {
    box.innerHTML = '<div class="hint hint--block">暂无转发</div>';
    return;
  }
  box.innerHTML = list.map((e) => `
    <div class="relay-item" data-id="${esc(e.id)}">
      <div class="relay-meta"><strong>${esc(e.from)}</strong><span>${esc(fmtDateTime(e.at))}</span></div>
      <div class="relay-content ${hide ? 'is-masked' : ''}" ${hide ? 'title="点击显示内容"' : ''}>${hide
        ? `已隐藏 · ${e.content.length} 字（点击显示）`
        : esc(e.content)}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------ 主渲染 */

/** 焦点是否正落在一个「会打断输入」的可编辑控件里。复选框/只读框重写 value 无感，不算。 */
function editingForm() {
  // 弹层打开时也按「正在编辑」处理，避免任何补渲染打断弹层里的输入
  const modal = $('#modal');
  if (modal && !modal.hidden) return true;
  const el = document.activeElement;
  if (!el || el === document.body || el.readOnly || el.disabled) return false;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  return !/^(checkbox|radio|button|hidden|submit|reset|file)$/.test(el.type || '');
}

/*
 * 填了但还没保存的草稿：只在「设置 / 保活」两个视图里统计，任务搜索框之类不算。
 * 否则用户搜一下任务，设置页的状态点就永远不刷新了。
 */
const DRAFT_STALE_MS = 5 * 60 * 1000;
const DRAFT_SEL = '#view-settings [data-user-edited], #view-keep [data-user-edited]';
/**
 * 「填了但没保存」的字段一律算脏，且**不再自动失效**。
 * 旧实现 5 分钟后删标记：用户填完一大段 AI 要求、失焦去查资料再回来，
 * 下一次 45s 轮询就会用服务端旧值整段覆盖输入框 —— 丢草稿比状态点不刷新严重得多。
 * 放弃草稿有两个明确出口（保存 / 切视图），另有 draftBanner() 的按钮，不会永久卡住轮询。
 */
function formDirty() {
  return document.querySelectorAll(DRAFT_SEL).length > 0;
}
function staleDraftCount() {
  let n = 0;
  document.querySelectorAll(DRAFT_SEL).forEach((el) => {
    const at = Number(el.dataset.editedAt || 0);
    if (!at || Date.now() - at >= DRAFT_STALE_MS) n++;
  });
  return n;
}
function clearFormDirty() {
  document.querySelectorAll('[data-user-edited]').forEach((el) => {
    delete el.dataset.userEdited;
    delete el.dataset.editedAt;
  });
}

/** 超时草稿提示条：给「保留草稿导致自动刷新暂停」一个可见的退出按钮（只写 textContent）。 */
function draftBanner() {
  const host = $('#view-settings');
  if (!host || !S.data) return;
  let box = $('#draftBanner');
  if (!staleDraftCount()) { if (box) box.hidden = true; return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'draftBanner';
    box.className = 'draft-banner';
    const span = document.createElement('span');
    span.textContent = '有未保存的修改，自动刷新已暂停（内容不会被覆盖）。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'draft-discard';
    btn.textContent = '放弃草稿并恢复刷新';
    btn.addEventListener('click', () => {
      clearFormDirty();
      renderSettings();
      renderSmsRelay();
      renderEnvVars();
      renderKeepView();
      draftBanner();
    });
    box.append(span, btn);
    host.prepend(box);
  }
  box.hidden = false;
}

/*
 * index.html 里 61 个 <label> 全是「标签文本」+「兄弟节点里的 input」，既没有 for
 * 也没包住控件：屏幕阅读器读不出关联，点标签也不会聚焦输入框。
 * 逐条改 900 行 HTML 容易漏（动态渲染出来的字段同样有这问题），改成启动时按 DOM
 * 结构自动补：优先找标签后面的兄弟控件，找不到再往上一层找。幂等，可反复调用。
 */
let labelAutoId = 0;
function findFollowingControl(label) {
  const pick = (el) => {
    if (!el) return null;
    if (el.matches && el.matches('input:not([type="hidden"]),select,textarea')) return el;
    return el.querySelector ? el.querySelector('input:not([type="hidden"]),select,textarea') : null;
  };
  let n = label.nextElementSibling;
  while (n) {
    const c = pick(n);
    if (c) return c;
    n = n.nextElementSibling;
  }
  let p = label.parentElement;
  for (let i = 0; i < 2 && p; i++, p = p.parentElement) {
    let s = p.nextElementSibling;
    while (s) {
      const c = pick(s);
      if (c) return c;
      s = s.nextElementSibling;
    }
  }
  return null;
}

function linkLabels(root = document) {
  if (!root || !root.querySelectorAll) return;
  for (const label of root.querySelectorAll('label:not([for])')) {
    // <label class="switch"><input …></label> 属于隐式关联，本来就合法，别改成双重关联
    if (label.querySelector('input,select,textarea')) continue;
    const ctrl = findFollowingControl(label);
    if (!ctrl) continue;
    if (!ctrl.id) ctrl.id = 'lb-auto-' + (++labelAutoId);
    label.htmlFor = ctrl.id;
  }
}

/*
 * 统计卡、渠道分段、标识/删除这些是 div/span 做的按钮，鼠标能用、键盘够不着。
 * 统一补 tabindex + role，配合 bind() 里的全局 keydown 把 Enter/Space 转成 click，
 * 已有的点击委托一行都不用改。
 */
function keyboardClickable() {
  const sel = '.stat.is-clickable, .ch-seg-item, .ch-mark-txt, .ch-mark-del, .keep-tile, [data-goto]:not(button):not(a)';
  document.querySelectorAll(sel).forEach((el) => {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
}

function renderAll() {
  if (!S.data) return;
  renderStats();
  renderNext();
  renderFeed();
  renderTasks();
  renderInbox();
  renderLogView();
  // 陪护卡只写文本、不碰任何 input，所以放在编辑门控外面，实时刷新也不会打断填写
  renderCompanion();
  draftBanner();
  loadSysMeta();
  /*
   * 45 秒轮询 / 任何一次操作后的 load() 都会走这里。下面四个渲染函数会直接写
   * input.value：用户正在填 token 时，光标位置、没提交的一半内容会被整段冲掉。
   * 检测到焦点在输入框里就先跳过这几块，列表与统计照常刷新；失焦后由 bind()
   * 里的 focusout 补一次渲染，状态点和开关值不会停在旧值。
   */
  if (!editingForm() && !formDirty()) {
    renderSettings();
    renderSmsRelay();
    renderEnvVars();
    renderKeepView();
  }
  linkLabels();
  keyboardClickable();
}

/**
 * 侧栏底部状态：连接正常时直接显示「连续运行 X」。
 * 连续运行时长来自 sysInfo.curText（重启间隔小于 3 分钟会继续累计，比进程 uptime 更贴近观感）；
 * sysInfo 是异步到位的，所以这里要能被反复调用刷新，不允许写死文案。
 */
function setSrvStatus(online) {
  const dot = $('#srvDot');
  const txt = $('#srvText');
  if (!dot || !txt) return;
  if (!online) {
    dot.className = 'dot is-off';
    txt.textContent = '连接失败';
    txt.removeAttribute('title');
    return;
  }
  dot.className = 'dot is-on';
  const s = S.sysInfo || {};
  txt.textContent = s.curText ? '连续运行 ' + s.curText : '服务运行中';
  // 详情收进悬停提示，不占用侧栏宽度
  const tips = [];
  if (s.bootAtText) tips.push('本次启动 ' + s.bootAtText);
  if (s.processText) tips.push('本进程 ' + s.processText);
  if (s.totalText) tips.push('累计 ' + s.totalText);
  if (s.interruptions) tips.push('中断 ' + s.interruptions + ' 次');
  if (tips.length) txt.title = tips.join(' · ');
  else txt.removeAttribute('title');
}

/*
 * 45 秒轮询、手动刷新、任务跑完后的补偿刷新、各处操作后的 load() 会并发触发。
 * 没有序号保护时，先发后到的旧响应会覆盖新状态：任务明明已暂停却显示运行中，
 * 侧栏还可能被一次失败请求误标成「连接失败」。只看最后一次发起的结果。
 */
let stateSeq = 0;
async function load(showErr = false) {
  const my = ++stateSeq;
  try {
    const data = await api('/api/state');
    if (my !== stateSeq) return;
    S.data = data;
    setSrvStatus(true);
    renderAll();
    refreshKeep(my);
  } catch (err) {
    if (my !== stateSeq) return;
    setSrvStatus(false);
    // 401 时 api() 已切到登录页，不必再弹错误提示
    if (showErr && !$('#appRoot').hidden) toast('无法连接服务：' + err.message, 'err');
  }
}

/* ------------------------------------------------------------ 视图切换 */

/* 顶栏副标题只在这里写一次：能由页面自己说清的一律留空（统计卡、分组标题、
 *  三道保险的编号卡、设置页的四个分段标题本身就是目录），不重复讲一遍布局。 */
const VIEW_META = {
  overview: ['总览', ''],
  tasks: ['任务', '服务端执行，关掉页面也会照常跑'],
  inbox: ['通知', ''],
  logs: ['系统日志', ''],
  keep: ['保活控制台', ''],
  settings: ['设置', ''],
};

/** 不在左侧导航里的页面：只能从设置页的按钮进入，进入后顶栏出现「返回设置」。 */
const HIDDEN_VIEWS = ['logs', 'keep'];

function switchView(view) {
  // 主动离开页面视为放弃未保存草稿，让目标页能正常回显服务端值
  if (S.view !== view) clearFormDirty();
  S.view = view;
  // 切页时把任务日志弹层收掉，避免遮住新页面
  const tlModal = $('#taskLogModal');
  if (tlModal) tlModal.hidden = true;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  // 隐藏页没有对应导航项，此时把设置项标为激活，让位置感不丢
  const navKey = HIDDEN_VIEWS.includes(view) ? 'settings' : view;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === navKey));
  const back = $('#viewBack');
  if (back) back.hidden = !HIDDEN_VIEWS.includes(view);
  const [title, sub] = VIEW_META[view] || ['', ''];
  $('#viewTitle').textContent = title;
  const subEl = $('#viewSub');
  subEl.textContent = sub;
  subEl.hidden = !sub;   // 空副标题不留一块空行，标题与内容直接相邻
  if (view === 'settings') smtpHydrated = false;
  if (view === 'keep') refreshKeep();
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 跳到设置页的某张卡片：切视图 → 等渲染完成 → 滚动到位 → 高亮闪烁两秒。 */
async function gotoCard(cardId) {
  if (S.view !== 'settings') switchView('settings');
  await new Promise((r) => setTimeout(r, 400));
  const el = document.getElementById(cardId);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('card--flash');
  void el.offsetWidth; // 强制重排以重启动画
  el.classList.add('card--flash');
  setTimeout(() => el.classList.remove('card--flash'), 2000);
}

/* ------------------------------------------------------------ 任务操作 */

async function runTask(id, btn) {
  btn.classList.add('is-spin');
  btn.disabled = true;
  try {
    const r = await api(`/api/tasks/${id}/run`, { method: 'POST' });
    if (r.started) {
      // 服务端已改成后台执行：AI 改写 + 外部渠道可能要几十秒，分几次把结果刷出来
      toast('已开始执行，完成后会显示在通知与日志里', 'ok');
      [3000, 9000, 20000, 40000].forEach((ms) => setTimeout(() => { if (!document.hidden) load(); }, ms));
    } else {
      const ok = r.result.ok;
      toast(ok ? `执行成功：${truncate(r.result.message, 60)}` : `执行失败：${truncate(r.result.message, 60)}`, ok ? 'ok' : 'err');
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.classList.remove('is-spin');
    btn.disabled = false;
    await load();
  }
}

async function toggleTask(id) {
  try {
    await api(`/api/tasks/${id}/toggle`, { method: 'POST' });
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteTask(id) {
  const t = S.data.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`确定删除任务「${t.name}」吗？该操作不可撤销。`)) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    toast('任务已删除');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 表单 */

function openModal(task) {
  S.editingId = task ? task.id : null;
  $('#modalTitle').textContent = task ? '编辑任务' : '新建任务';
  $('#modalErr').textContent = '';

  const t = task || { name: '', type: 'http', enabled: true, schedule: { mode: 'cron', cron: '0 9 * * *', everyMinutes: 60 }, config: {} };
  $('#fName').value = t.name || '';
  $('#fEnabled').checked = t.enabled !== false;
  // 任务组：带 datalist，复用已有组名，避免「天气播报」和「天气播报组」分成两组
  if ($('#fGroup')) {
    $('#fGroup').value = String(t.group || '');
    const dl = $('#groupOptions');
    if (dl) {
      const names = [...new Set((S.data.tasks || []).map((x) => String(x.group || '').trim()).filter(Boolean))].sort();
      dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
    }
  }

  setFormType(t.type || 'http');
  setSchedRows(Array.isArray(t.schedules) && t.schedules.length ? t.schedules : [t.schedule || { mode: 'cron', cron: '0 9 * * *' }]);

  const c = t.config || {};
  $('#fMethod').value = c.method || 'GET';
  $('#fExpect').value = c.expectStatus || 200;
  $('#fAlsoOk').value = Array.isArray(c.alsoOkStatus) ? c.alsoOkStatus.join(',') : (c.alsoOkStatus || '');
  $('#fUrl').value = c.url || '';
  $('#fHeaders').value = c.headers || '';
  $('#fBody').value = c.body || '';
  // 失败重试：老任务没这个字段，默认「不重试 / 3 秒」，与后端行为一致
  if ($('#fRetryTimes')) $('#fRetryTimes').value = String((c.retry && Number(c.retry.times)) || 0);
  if ($('#fRetryDelay')) {
    // 通过接口写入的间隔可能不在下拉选项里（例如 500ms）——不补一项的话
    // select.value 会变成空串，用户看到「间隔」一片空白，保存时还会被静默改成默认值。
    const wantMs = Number(c.retry && c.retry.delayMs) || 3000;
    const sel = $('#fRetryDelay');
    // 上一次为别的任务临时补的选项要清掉，否则下拉里会越积越多
    Array.from(sel.options).forEach((o) => { if (o.dataset.extra) o.remove(); });
    if (!Array.from(sel.options).some((o) => Number(o.value) === wantMs)) {
      const opt = document.createElement('option');
      opt.value = String(wantMs);
      opt.dataset.extra = '1';
      opt.textContent = wantMs % 1000 === 0 ? `${wantMs / 1000} 秒` : `${(wantMs / 1000).toFixed(1)} 秒`;
      sel.appendChild(opt);
    }
    sel.value = String(wantMs);
  }
  $('#fMessage').value = c.message || '';
  setSteps(Array.isArray(c.steps) ? c.steps : []);

  const chans = Array.isArray(c.channels) ? c.channels : ['inapp'];

  // 任务级通知开关：没单独设置过就显示全局策略，用户一眼能看出这个任务现在会不会推
  const gp = (S.data.settings && S.data.settings.notifyme) || {};
  const tn = c.notify && typeof c.notify === 'object' ? c.notify : null;
  const tnOn = !!(tn && tn.enabled !== false);
  $('#fNotify').checked = tn ? tn.enabled !== false : !!gp.enabled;
  $('#fNotifySuccess').checked = tnOn ? tn.onSuccess !== false : gp.onSuccess !== false;
  $('#fNotifyFailure').checked = tnOn ? tn.onFailure !== false : gp.onFailure !== false;
  // 通知渠道：老任务没存过 channels 就只勾站内（手机推送等已配置的渠道由用户自己点）
  const nch = tn && Array.isArray(tn.channels) && tn.channels.length ? tn.channels : ['inapp'];
  // 一次性渲染两处渠道选项：提醒类通道 + 完成通知通道，各自勾各自的值
  renderTaskChannelChips(chans, nch);
  // 任务级 NotifyMe 选项：勾了手机推送才显示（没勾就完全不占地方）
  fillNmTask(c.nmPush);
  if ($('#fNotifyTpl')) $('#fNotifyTpl').value = c.notifyTemplate || '';
  if ($('#fNotifyPrompt')) $('#fNotifyPrompt').value = c.notifyPrompt || '';
  syncAiPromptCount();
  const pv = $('#fAiPreview');
  if (pv) { pv.hidden = true; pv.innerHTML = ''; }   // 换任务时别把上一条的预览留着
  // 老任务没存过 aiEnabled 视为开启，与后端 taskAiOn 的判定保持一致
  if ($('#fAiEnabled')) $('#fAiEnabled').checked = c.aiEnabled !== false;
  // 补跑开关：只有显式存过 true 才勾上，老任务默认「允许补跑」
  if ($('#fNoCatchup')) $('#fNoCatchup').checked = c.noCatchup === true;
  if ($('#fAiInstance')) {
    const opts = ['<option value="">默认（设置页那套）</option>'].concat(
      channelInstancesOf('ai').map((i) => `<option value="${esc(i.id)}">${esc(i.remark || i.id.slice(-4))}${i.enabled === false ? '（未启用）' : ''}</option>`)
    );
    $('#fAiInstance').innerHTML = opts.join('');
    $('#fAiInstance').value = c.aiInstance || '';
  }
  syncNotifyOpts();
  syncAiOpts();

  $('#modal').hidden = false;
  /*
   * 打开就把光标塞进「任务名称」，在手机上等于立刻弹出输入法、把上半屏顶掉，
   * 用户想先看的是当前配置，不是改名。所以：编辑已有任务 → 只滚到顶部、不抢焦点；
   * 新建任务 → 名字还是空的，聚焦到名字仍然是最省事的。
   */
  setTimeout(() => {
    const body = document.querySelector('#modal .modal-body');
    if (body) body.scrollTop = 0;
    if (!task) {
      const name = $('#fName');
      if (name) name.focus({ preventScroll: true });
    }
  }, 60);
}

function closeModal() {
  $('#modal').hidden = true;
  S.editingId = null;
}

/** 任务完成通知：关掉开关就把下面的通知选项收起来。 */
function syncNotifyOpts() {
  const on = $('#fNotify').checked;
  const box = $('#fNotifyOpts');
  if (box) box.hidden = !on;
}

/*
 * 任务级「是否使用 AI 优化」开关（第十一批）。
 * 关掉后收起 AI 要求 / 实例选择，弹层回到紧凑状态；写过的提示词不清空，
 * 下次打开开关还能接着用。全局总开关没开时给一句明确提示，避免用户
 * 以为勾上了就一定会优化 —— 运行层是「全局 enabled && 任务 aiEnabled !== false」。
 */
/* ---- 任务级 AI 要求：字数提示 + 「看实际提示词」（第十二批） ----
 *
 * 用户问得最多的是「我写的要求到底有没有进提示词」。与其反复解释，不如把服务端
 * 真实拼装结果原样摊开 —— 所以这里不自己拼一份预览（那必然和线上不一致），
 * 一律找后端 /api/ai/preview 要。
 */
const AI_PROMPT_MAX = 4000;

function syncAiPromptCount() {
  const ta = $('#fNotifyPrompt');
  const el = $('#fAiPromptCount');
  if (!ta || !el) return;
  const n = ta.value.trim().length;
  el.textContent = `${n} / ${AI_PROMPT_MAX} 字`;
  el.classList.toggle('is-over', n > AI_PROMPT_MAX);
}

function aiPreviewSection(title, text) {
  const h = document.createElement('h5');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = text;
  return [h, pre];
}

async function showAiPreview() {
  const box = $('#fAiPreview');
  if (!box) return;
  // 再点一次收起，省得占掉弹层高度
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = '正在拼装…';
  let r = null;
  try {
    r = await api('/api/ai/preview', {
      method: 'POST',
      body: {
        taskId: S.editingId || '',
        name: ($('#fName') && $('#fName').value.trim()) || '',
        notifyPrompt: ($('#fNotifyPrompt') && $('#fNotifyPrompt').value) || '',
        aiInstance: ($('#fAiInstance') && $('#fAiInstance').value) || '',
      },
    });
  } catch (e) {
    box.textContent = '拼装失败：' + ((e && e.message) || '未知错误');
    return;
  }
  box.innerHTML = '';
  const meta = document.createElement('p');
  meta.className = 'ai-preview-note';
  meta.textContent = `模型：${r.model || '未设置'}　·　全局开关：${r.globalOn ? '已开启' : '未开启（不会调用 AI）'}`
    + `　·　任务要求：${r.taskPromptLen} 字`;
  box.appendChild(meta);
  if (r.rules && r.rules.length) {
    const h = document.createElement('h5');
    h.textContent = `生成后的机器校验（${r.rules.length} 项）`;
    box.appendChild(h);
    const wrap = document.createElement('div');
    for (const rule of r.rules) {
      const s = document.createElement('span');
      s.className = 'ai-rule';
      s.textContent = rule.label;
      wrap.appendChild(s);
    }
    box.appendChild(wrap);
  }
  for (const n of aiPreviewSection('system（真实发送内容）', r.system || '')) box.appendChild(n);
  for (const n of aiPreviewSection('user（真实发送内容）', r.user || '')) box.appendChild(n);
  if (r.note) {
    const p = document.createElement('p');
    p.className = 'ai-preview-note';
    p.textContent = r.note;
    box.appendChild(p);
  }
}

function syncAiOpts() {
  const sw = $('#fAiEnabled');
  if (!sw) return;
  const on = sw.checked;
  const box = $('#fAiOpts');
  if (box) box.hidden = !on;
  const hint = $('#fAiHint');
  if (!hint) return;
  const g = (S.data.settings && S.data.settings.ai) || {};
  hint.classList.remove('is-err');
  if (g.enabled === false) {
    hint.textContent = '⚠ 设置页「AI 通知优化」总开关未开启，本开关暂不生效；先在设置页启用 AI。';
    hint.classList.add('is-err');
  } else if (!on) {
    hint.textContent = '已关闭：直接发接口原文，不调用 AI；写过的 AI 要求会保留。';
  } else {
    hint.textContent = '开启后按本任务要求改写正文；没写就用设置页的全局默认要求。设置页总开关仍优先。';
  }
}

/* ---- 场景模板：天气播报（和风 v1 新版接口） ---- */

/*
 * 一键套用「和风天气 → AI 改写 → 手机推送」这套配置。
 *
 * 全部走新版 v1 接口（2026 年起公共域名与 v7 陆续停用，v7/warning 已经直接 403）：
 *   GET /weather/v1/current/{纬度}/{经度}       实况
 *   GET /weather/v1/daily/{纬度}/{经度}         逐日
 *   GET /weather/v1/hourly/{纬度}/{经度}        逐小时
 *   GET /weatheralert/v1/current/{纬度}/{经度}  灾害预警
 *   GET /airquality/v1/current/{纬度}/{经度}    空气质量
 *
 * v1 与 v7 的三个硬差异，模板固化下来免得再踩：
 *   ① 坐标是路径参数，顺序「纬度/经度」，不再用 ?location=经度,纬度；
 *   ② 响应里没有 code 字段，成败只看 HTTP 状态码（无数据是 200 + zeroResult/空数组，不是 204）；
 *   ③ humidity / 降水概率 / 云量都是 0~1 小数，风是 wind.scale 蒲福风级，温度是 {value,unit} 对象。
 */
const QW_HOST = 'https://jm564xg389.re.qweatherapi.com';
/*
 * 坐标口径：三甲集镇（35.53, 103.68），不是广河县城。
 * GeoAPI 的 city/lookup 只到县级——查「广河县」给的是县城 35.48169,103.57619，
 * 和镇子差十来公里；查「三甲集镇」它甚至会把台湾的「集集镇」匹配回来。
 * 所以这里写死镇子的经纬度，顺序按 v1 路径要求「纬度/经度」。
 */
const QW_POS = '35.53/103.68';
const WEATHER_PROMPT = [
  '你是天气播报编辑，地点：甘肃省临夏州广河县三甲集镇（洮河河谷，昼夜温差大）。',
  '',
  '【事实｜最高优先】',
  '· 只用 JSON 里出现的数值和文字，严禁推算；缺的项不写。',
  '· 分工：current 此刻，hourly 未来 24 小时，daily 今天与明天，weatheralert 预警，airquality 空气。',
  '· 今晚取 daily 第一条的 nighttime（不是 daytime）；明天取 daily 第二条。',
  '· 温度取 temperature.value / temperatureMax/Min.value，保留一位小数并带 °C。',
  '',
  '【量纲｜v1 特有】',
  '· humidity、precipitation.probability、cloudCover 是 0~1 小数（0.4＝40%）；见到大于 1 的数按百分比理解。',
  '· wind.scale 是蒲福风级，uvIndexMax 是 0~11，aqi 是 0~500。',
  '',
  '【数值规则｜只有温度带数字】',
  '· 只有温度带数字和 °C，其余量一律定性，不带单位不带数字。',
  '· 风按 wind.scale：0-2 微风／3-4 风稍大／5-6 风大／≥7 大风。',
  '· 雨按概率：<0.3 不下雨／0.3-0.6 可能有雨／>0.6 有雨；日累计 amount>10 写「雨不小」。',
  '· 雪看 condition.text 含「雪」；紫外线按 uvIndexMax：<3 弱／3-5 中／≥6 强。',
  '',
  '【预警｜有则置顶】',
  '· 取 alerts：eventType.name 是类型，color.code 是级别（red 红／orange 橙／yellow 黄／blue 蓝）。',
  '· 有预警时，第一行只写「⚠ 类型级别」（如「⚠ 道路结冰黄色预警」），不掺别的内容。',
  '· alerts 为空就不提，也不要写「无预警」；多条取 expireTime 未过、severity 最高的。',
  '',
  '【空气｜只在差的时候说】',
  '· indexes[0].category 是「优/良/轻度污染…」；轻度污染及以上，才在建议行末尾加「空气差，戴口罩」。',
  '',
  '【排版｜有预警 4 行，无预警 3 行，无空行无序号，每行 ≤24 字】',
  '🌙 今晚：nighttime 现象＋最低温＋风感。例「今晚晴，最低 -5.9°C，微风」',
  '☀️ 明天：最低到最高温＋升降趋势＋风感。例「明天 0.2 到 9°C，白天升温，午后风大」',
  '💡 只写建议内容，不加「建议：」，≤20 字。例「昼夜温差大，早晚添衣，白天注意防风」',
  '· 数字与单位之间要空格：写「最低 -5.9°C」，不写「最低-5.9°C」。',
  '',
  '【断句｜必守】',
  '· 逗号「，」隔开信息点，两句建议之间用「；」，行末不加句号。',
  '· 每行是通顺句子，不是关键词罗列；时间词后不加空格。',
  '· 温度直写「最低 -5.9°C」，不写「气温降至」。',
  '',
  '【建议｜先原因后动作，最多两句】',
  '· 安全优先：大风(≥6)→远离广告牌；雨不小→避低洼山边；雪且最低温≤0°C→路面结冰慢行。',
  '· 否则第一句写穿衣：春夏按最高温、秋冬按最低温；温差≥12 或体感偏冷→「昼夜温差大，早晚添衣」。',
  '· 第二句写出行：雨→带伞；紫外线强→戴帽防晒；没命中就不写第二句。',
  '',
  '【风格】',
  '· 每行 1 个 emoji，全篇不重复；正文 ≤64 字，超出先删形容词，不删温度和标点。',
].join('\n');

function applyWeatherScene() {
  setFormType('http');
  $('#fName').value = '每日天气播报';
  $('#fMethod').value = 'GET';
  $('#fExpect').value = '200';
  $('#fAlsoOk').value = '';
  $('#fUrl').value = `${QW_HOST}/weather/v1/current/${QW_POS}?localTime=true&lang=zh`;
  $('#fHeaders').value = '{"X-QW-Api-Key":"PASTE_YOUR_QWEATHER_KEY"}';
  $('#fBody').value = '';
  // 请求头放在任务级，五个步骤留空继承，改 KEY 只用改一处
  // 注意：一旦填了步骤，执行时只跑步骤、不再跑上面的主请求，所以实况也要作为第一步列出来
  setSteps([
    { name: '实况', method: 'GET', url: `${QW_HOST}/weather/v1/current/${QW_POS}?localTime=true&lang=zh`, expectStatus: 200 },
    { name: '逐日预报', method: 'GET', url: `${QW_HOST}/weather/v1/daily/${QW_POS}?days=2&localTime=true&lang=zh`, expectStatus: 200 },
    { name: '逐小时预报', method: 'GET', url: `${QW_HOST}/weather/v1/hourly/${QW_POS}?hours=24&localTime=true&lang=zh`, expectStatus: 200 },
    { name: '灾害预警', method: 'GET', url: `${QW_HOST}/weatheralert/v1/current/${QW_POS}?lang=zh`, expectStatus: 200, optional: true },
    { name: '空气质量', method: 'GET', url: `${QW_HOST}/airquality/v1/current/${QW_POS}?lang=zh`, expectStatus: 200, optional: true },
  ]);
  setSchedRows([{ mode: 'cron', cron: '0 7 * * *', everyMinutes: 60 }]);
  $('#fNotifyTpl').value = '';
  $('#fNotifyPrompt').value = WEATHER_PROMPT;
  syncAiPromptCount();
  // 模板自带一整套 AI 播报要求，顺手把任务级 AI 开关打开并展开输入框
  if ($('#fAiEnabled')) $('#fAiEnabled').checked = true;
  syncAiOpts();
  const note = $('#sceneNote');
  if (note) {
    note.hidden = false;
    note.textContent = '已填好：实况 / 逐日 / 逐小时 / 预警 / 空气 五个新版 v1 请求（共用一份请求头）+ 每天 7:00 + AI 播报要求。'
      + '还需改一处：请求头里的 PASTE_YOUR_QWEATHER_KEY 换成你的 KEY。'
      + '坐标是路径参数「纬度/经度」，默认三甲集镇 35.53/103.68（GeoAPI 只到县级，镇子要写死）；换地点要改全部 5 个地址。'
      + 'v1 响应没有 code 字段，无预警是 200 + alerts 空数组，所以只看 HTTP 状态码，不设 204。';
  }
  toast('已套用「天气播报」模板（v1 新版接口）');
}

function setFormType(type) {
  S.formType = type;
  $$('#fType .type-opt').forEach((b) => b.classList.toggle('is-active', b.dataset.type === type));
  $('#httpFields').hidden = type !== 'http';
  $('#remindFields').hidden = type !== 'remind';
  // AI 通知优化只作用于 HTTP 任务，提醒类任务别给一个点了没反应的开关
  const aiBlock = $('#fAiBlock');
  if (aiBlock) aiBlock.hidden = type !== 'http';
}

/* ---- 执行节奏：一个任务可以配多条 ---- */

/** 间隔单位：与服务端 INTERVAL_UNITS 一一对应（分钟数用于老字段兼容换算）。 */
const UNIT_MIN = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 };
const UNIT_LABEL = { minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月（按 30 天）' };
const unitOf = (u) => (Object.prototype.hasOwnProperty.call(UNIT_MIN, u) ? u : 'minute');

function schedRowsDefault() {
  return [{ mode: 'cron', cron: '0 9 * * *', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 }];
}

/** 载入节奏（编辑老任务时用它的 schedule/schedules）。 */
function setSchedRows(list) {
  S.schedRows = (Array.isArray(list) && list.length ? list : schedRowsDefault()).slice(0, 6).map((r) => {
    const unit = unitOf(r && r.unit);
    const everyMinutes = Number(r && r.everyMinutes) || 60;
    return {
      mode: r && r.mode === 'interval' ? 'interval' : 'cron',
      cron: (r && r.cron) || '0 9 * * *',
      // 老任务只有 everyMinutes：按分钟回填，展示与改版前一致
      every: Number(r && r.every) || Math.max(1, Math.round(everyMinutes / UNIT_MIN[unit])),
      unit,
      startAt: String((r && r.startAt) || ''),
      everyMinutes,
    };
  });
  S.schedFocus = 0;
  renderScheduleRows();
}

/** 把界面上的值读回 S.schedRows（切模式、增删行前先同步一次）。 */
function readSchedRows() {
  const rows = $$('#fSchedules .sched-row');
  if (!rows.length) return;
  S.schedRows = rows.map((row, i) => {
    const cur = S.schedRows[i] || {};
    const cronEl = row.querySelector('.sched-cron');
    const everyEl = row.querySelector('.sched-every');
    const unitEl = row.querySelector('.sched-unit');
    const startEl = row.querySelector('.sched-start');
    const unit = unitOf((unitEl && unitEl.value) || cur.unit);
    const every = Math.max(1, Number(everyEl && everyEl.value) || cur.every || 1);
    return {
      mode: row.dataset.mode === 'interval' ? 'interval' : 'cron',
      cron: ((cronEl && cronEl.value) || '').trim() || cur.cron || '0 9 * * *',
      every,
      unit,
      startAt: startEl ? String(startEl.value || '') : (cur.startAt || ''),
      everyMinutes: Math.max(1, Math.round(every * UNIT_MIN[unit])),
    };
  });
}

/** 渲染节奏行列表。 */
function renderScheduleRows() {
  const box = $('#fSchedules');
  if (!box) return;
  if (!Array.isArray(S.schedRows) || !S.schedRows.length) S.schedRows = schedRowsDefault();
  box.innerHTML = S.schedRows.map((r, i) => {
    const isInt = r.mode === 'interval';
    return `<div class="sched-row" data-mode="${isInt ? 'interval' : 'cron'}" data-i="${i}">
      <div class="sched-mode">
        <button type="button" data-mode="cron" class="${isInt ? '' : 'is-active'}">定时</button>
        <button type="button" data-mode="interval" class="${isInt ? 'is-active' : ''}">间隔</button>
      </div>
      <input type="text" class="sched-cron" value="${esc(isInt ? '' : (r.cron || '0 9 * * *'))}" placeholder="分 时 日 月 周" spellcheck="false"${isInt ? ' hidden' : ''}>
      <input type="number" class="sched-every" value="${Number(r.every) || 1}" min="1"${isInt ? '' : ' hidden'}>
      <select class="sched-unit" aria-label="间隔单位"${isInt ? '' : ' hidden'}>
        ${Object.keys(UNIT_MIN).map((u) => `<option value="${u}"${unitOf(r.unit) === u ? ' selected' : ''}>每 ${UNIT_LABEL[u]}</option>`).join('')}
      </select>
      <button type="button" class="sched-del" title="删除这条节奏"${S.schedRows.length > 1 ? '' : ' hidden'}>×</button>
      <label class="sched-start-wrap"${isInt ? '' : ' hidden'}>
        <span>开始时间 <small class="sched-start-hint">留空 = 从现在起算</small></span>
        <input type="datetime-local" class="sched-start" value="${esc(r.startAt || '')}" aria-label="首次执行时间">
      </label>
      <p class="sched-prev"></p>
    </div>`;
  }).join('');
  updateSchedPreviews();
}

/** 每条节奏的「→ 描述 ｜ 接下来：...」，未来时间由服务端算。 */
function updateSchedPreviews() {
  clearTimeout(S.schedPrevTimer);
  S.schedPrevTimer = setTimeout(async () => {
    const rows = $$('#fSchedules .sched-row');
    for (const row of rows) {
      const note = row.querySelector('.sched-prev');
      if (!note) continue;
      note.className = 'sched-prev';
      if (row.dataset.mode === 'interval') {
        const n = Number(row.querySelector('.sched-every').value) || 1;
        const unit = unitOf(row.querySelector('.sched-unit').value);
        const start = row.querySelector('.sched-start').value || '';
        note.textContent = '→ ' + intervalHuman(n, unit)
          + (start ? ` ｜ 从 ${start.slice(5).replace('T', ' ')} 开始` : ' ｜ 从现在起算');
        continue;
      }
      const expr = row.querySelector('.sched-cron').value.trim();
      if (!expr) { note.textContent = ''; continue; }
      const parts = expr.split(/\s+/);
      if (parts.length !== 5) {
        note.textContent = '表达式要 5 段：分 时 日 月 周';
        note.classList.add('is-err');
        continue;
      }
      // 描述不出来就原样显示表达式，别拦着用户保存
      const desc = describeCron(parts) || expr;
      note.textContent = '→ ' + desc;
      note.classList.add('is-ok');
      try {
        const r = await api('/api/cron-preview?cron=' + encodeURIComponent(expr));
        if (r.times && r.times.length) {
          note.textContent = `→ ${desc} ｜ 接下来：${r.times.map(fmtShortDate).join('、')}`;
        } else {
          note.textContent = `→ ${desc}（这个表达式算不出执行时间，检查一下）`;
          note.classList.remove('is-ok');
          note.classList.add('is-err');
        }
      } catch { /* 预览失败不打扰 */ }
    }
  }, 320);
}

/** 间隔说人话：每 3 天 / 每 2 周 / 每 1 个月（按 30 天）… */
function intervalHuman(n, unit) {
  const v = Math.max(1, Number(n) || 1);
  return `每 ${v} ${UNIT_LABEL[unitOf(unit)]}`;
}

/** 短时间：10/27 09:00（今天的显示「今天 09:00」）。 */
function fmtShortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeCron(p) {
  const [mi, ho, dom, mo, dow] = p;
  const num = (s) => /^\d+$/.test(s) ? Number(s) : null;
  // 逗号列表：3,15 → [3,15]（有一个不是纯数字就返回 null）
  const nums = (s) => {
    const arr = String(s).split(',').map((x) => (/^\d+$/.test(x.trim()) ? Number(x.trim()) : null));
    return arr.length && arr.every((x) => x !== null) ? arr : null;
  };
  const WD = '日一二三四五六';

  if (/^\*$/.test(mi) && /^\*$/.test(ho)) return '每分钟执行';
  if (/^\*\/\d+$/.test(mi) && /^\*$/.test(ho)) return `每 ${mi.split('/')[1]} 分钟执行`;

  const miList = nums(mi);
  const hoList = nums(ho);

  // 小时为 * 且分钟固定 → 每小时的第 N 分
  if (miList && miList.length === 1 && ho === '*') {
    if (dom === '*' && mo === '*' && dow === '*') return `每小时的第 ${miList[0]} 分`;
    if (dom === '*' && mo === '*' && /^1-5$/.test(dow)) return `工作日每小时的第 ${miList[0]} 分`;
  }

  // 小时带步长
  if (miList && miList.length === 1 && /^\*\/\d+$/.test(ho)) {
    return `每 ${ho.split('/')[1]} 小时的第 ${pad(miList[0])} 分`;
  }

  if (!miList || !hoList) return null;

  const times = [];
  for (const h of hoList) for (const m of miList) times.push(`${pad(h)}:${pad(m)}`);
  const tt = times.join('、');

  if (dom === '*' && mo === '*' && dow === '*') return `每天 ${tt}`;
  if (dom === '*' && mo === '*' && /^1-5$/.test(dow)) return `每个工作日 ${tt}`;

  if (dom === '*' && mo === '*') {
    const dl = nums(dow);
    if (dl && dl.every((d) => d >= 0 && d <= 6)) {
      if (dl.length === 1) return `每周${WD[dl[0]]} ${tt}`;
      return `每周${dl.map((d) => WD[d]).join('、')} ${tt}`;
    }
  }

  const domList = nums(dom);
  const moList = nums(mo);
  if (mo === '*' && dow === '*' && domList) {
    if (domList.length === 1) return `每月 ${domList[0]} 号 ${tt}`;
    return `每月 ${domList.join('、')} 号 ${tt}`;
  }
  if (dow === '*' && domList && moList && domList.length === 1 && moList.length === 1) {
    return `每年 ${moList[0]} 月 ${domList[0]} 日 ${tt}`;
  }
  return null;
}

/**
 * 渲染一个步骤卡片。
 * 步骤可以覆盖任务级的任何请求字段（url/method/headers/body/expectStatus/alsoOkStatus），
 * 没填的字段执行时自动继承任务级配置。
 */
function stepHtml(s, i) {
  const d = s || {};
  const alsoOk = Array.isArray(d.alsoOkStatus) ? d.alsoOkStatus.join(',') : (d.alsoOkStatus || '');
  return `
  <div class="step-item" data-step="1">
    <div class="step-head">
      <span class="step-idx">${i + 1}</span>
      <input type="text" class="st-name" value="${esc(d.name || '')}" placeholder="这一步做什么，例如：签到">
      <button type="button" class="step-remove" title="删除此步骤">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="step-row">
      <select class="st-method">
        ${['GET', 'POST', 'PUT', 'HEAD'].map((m) =>
          `<option ${String(d.method || 'POST').toUpperCase() === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
      <input type="number" class="step-expect st-expect" value="${d.expectStatus || 200}" title="期望状态码">
      <input type="text" class="step-also st-also" value="${esc(alsoOk)}" placeholder="也算成功" title="额外视为成功的状态码，逗号分隔">
    </div>
    <div class="step-row">
      <input type="text" class="st-url" value="${esc(d.url || '')}" placeholder="https://...（留空则继承上面的地址）">
    </div>
    <textarea class="st-headers" rows="1" placeholder='请求头 JSON，留空继承'>${esc(d.headers || '')}</textarea>
    <textarea class="st-body" rows="1" placeholder='请求体，留空继承'>${esc(d.body || '')}</textarea>
    <label class="step-opt"><input type="checkbox" class="st-optional" ${d.optional === true ? 'checked' : ''}> 允许失败（失败后继续执行下一步）</label>
  </div>`;
}

/** 给步骤卡片重新编号（删除中间某步后要刷新）。 */
function renumberSteps() {
  $$('#fSteps .step-item').forEach((el, i) => {
    const badge = el.querySelector('.step-idx');
    if (badge) badge.textContent = String(i + 1);
  });
}

function addStep(data) {
  const wrap = $('#fSteps');
  const idx = wrap.querySelectorAll('.step-item').length;
  wrap.insertAdjacentHTML('beforeend', stepHtml(data, idx));
  return wrap.lastElementChild;
}

function setSteps(steps) {
  $('#fSteps').innerHTML = '';
  (steps || []).forEach((s) => addStep(s));
}

/** 把步骤卡片读回成数据；空 url 且没名称的空卡片会被忽略。 */
function readSteps() {
  const out = [];
  $$('#fSteps .step-item').forEach((el) => {
    const url = el.querySelector('.st-url').value.trim();
    const name = el.querySelector('.st-name').value.trim();
    if (!url && !name) return; // 整张空白卡片直接丢掉
    const alsoRaw = el.querySelector('.st-also').value.trim();
    const item = {
      name: name || undefined,
      method: el.querySelector('.st-method').value,
      url,
      headers: el.querySelector('.st-headers').value.trim(),
      body: el.querySelector('.st-body').value,
      expectStatus: Number(el.querySelector('.st-expect').value) || 200,
    };
    const also = alsoRaw ? alsoRaw.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n)) : [];
    if (also.length) item.alsoOkStatus = also;
    if (el.querySelector('.st-optional').checked) item.optional = true;
    out.push(item);
  });
  return out;
}

async function saveTask() {
  const errBox = $('#modalErr');
  errBox.textContent = '';

  const name = $('#fName').value.trim();
  if (!name) { errBox.textContent = '请填写任务名称'; return; }

  readSchedRows();
  const schedules = (S.schedRows || []).map((r) => (r.mode === 'interval'
    ? {
        mode: 'interval',
        every: Math.max(1, Number(r.every) || 1),
        unit: unitOf(r.unit),
        startAt: String(r.startAt || ''),
        everyMinutes: Math.max(1, Number(r.everyMinutes) || 60),
      }
    : { mode: 'cron', cron: String(r.cron || '').trim() }));
  if (schedules.some((sc) => sc.mode === 'cron' && !sc.cron)) {
    errBox.textContent = '有一条节奏没填 cron 表达式';
    return;
  }

  let config;
  if (S.formType === 'http') {
    const steps = readSteps();
    const url = $('#fUrl').value.trim();
    // 多步骤任务的主地址可以留空（由第一步兜底），单请求任务必须填
    if (!url && !steps.length) { errBox.textContent = '请填写请求地址，或至少添加一个步骤'; return; }
    if (url && !/^https?:\/\//i.test(url)) { errBox.textContent = '请求地址需要以 http:// 或 https:// 开头'; return; }
    for (const s of steps) {
      if (s.url && !/^https?:\/\//i.test(s.url)) {
        errBox.textContent = `步骤「${s.name || s.url}」的地址需要以 http:// 或 https:// 开头`;
        return;
      }
    }
    const headers = $('#fHeaders').value.trim();
    if (headers) {
      try { JSON.parse(headers); } catch { errBox.textContent = '请求头不是合法 JSON'; return; }
    }
    const alsoRaw = $('#fAlsoOk').value.trim();
    const also = alsoRaw ? alsoRaw.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n)) : [];
    config = {
      url,
      method: $('#fMethod').value,
      headers,
      body: $('#fBody').value,
      expectStatus: Number($('#fExpect').value) || 200,
      timeoutSec: 15,
    };
    if (also.length) config.alsoOkStatus = also;
    const rTimes = Number($('#fRetryTimes') && $('#fRetryTimes').value) || 0;
    if (rTimes > 0) {
      config.retry = { times: Math.min(3, rTimes), delayMs: Number($('#fRetryDelay') && $('#fRetryDelay').value) || 3000 };
    }
    if (steps.length) config.steps = steps;
  } else {
    const message = $('#fMessage').value.trim();
    if (!message) { errBox.textContent = '请填写提醒内容'; return; }
    const channels = $$('#fChannels input:checked').map((i) => i.value);
    // 站内是必选项（复选框 disabled 但仍会提交），这里再保一次底
    if (!channels.includes('inapp')) channels.unshift('inapp');
    config = { message, channels };
  }

  // 任务完成通知：开关 + 通知时机 + 通知渠道一起落到 config.notify
  const notifyOn = $('#fNotify').checked;
  const nSuccess = $('#fNotifySuccess').checked;
  const nFailure = $('#fNotifyFailure').checked;
  const nChannels = $$('#fNotifyChannels input:checked').map((i) => i.value);
  if (!nChannels.includes('inapp')) nChannels.unshift('inapp');
  if (notifyOn && !nSuccess && !nFailure) {
    errBox.textContent = '开了任务完成通知，至少要选一个通知时机';
    return;
  }
  if (notifyOn && !nChannels.length) {
    errBox.textContent = '开了任务完成通知，至少要选一个通知渠道';
    return;
  }
  config.notify = { enabled: notifyOn, onSuccess: nSuccess, onFailure: nFailure, channels: nChannels };
  /*
   * 切换任务类型时不丢原有配置：把存过 AI 要求 / 模板 / AI 实例的 HTTP 任务改成
   * 「定时提醒」再保存，提醒分支只收集 message + channels，整份 config 被替换，
   * 这四个字段就永久丢了，切回 HTTP 时弹层一片空白。编辑已有任务时从原 config 回填。
   */
  if (S.editingId) {
    const prevTask = (S.data.tasks || []).find((t) => t.id === S.editingId);
    const prevCfg = (prevTask && prevTask.config) || {};
    for (const k of ['notifyTemplate', 'notifyPrompt', 'aiEnabled', 'aiInstance']) {
      if (prevCfg[k] !== undefined && config[k] === undefined) config[k] = prevCfg[k];
    }
  }
  // 任务级 NotifyMe 高级选项：勾了手机推送且填过才落库，全空就跟随设置页
  const nmPush = collectNmTask();
  if (nmPush) config.nmPush = nmPush;
  // 通知优化（仅 http 任务）：模版 + AI 通知优化要求
  if (S.formType === 'http') {
    const tpl = ($('#fNotifyTpl') && $('#fNotifyTpl').value.trim()) || '';
    const prompt = ($('#fNotifyPrompt') && $('#fNotifyPrompt').value.trim()) || '';
    if (tpl) config.notifyTemplate = tpl;
    if (prompt) config.notifyPrompt = prompt;
    // 任务级 AI 开关：显式写 true/false，后端只在 false 时落库（缺省即开启）
    const aiSw = $('#fAiEnabled');
    if (aiSw) config.aiEnabled = !!aiSw.checked;
    const aiInst = ($('#fAiInstance') && $('#fAiInstance').value) || '';
    if (aiInst) config.aiInstance = aiInst;
  }
  /*
   * 任务级补跑开关：只在勾上时写 true，取消勾选写 false ——
   * 后端两处 sanitize 都只认 true，所以 false 会被丢掉，等于恢复默认「允许补跑」。
   */
  const noCatch = $('#fNoCatchup');
  if (noCatch) config.noCatchup = !!noCatch.checked;

  const payload = {
    name,
    group: ($('#fGroup') && $('#fGroup').value.trim()) || '',
    type: S.formType,
    enabled: $('#fEnabled').checked,
    schedule: schedules[0], schedules, config,
  };

  const btn = $('#modalSave');
  btn.disabled = true;
  try {
    if (S.editingId) {
      await api(`/api/tasks/${S.editingId}`, { method: 'PUT', body: payload });
      toast('任务已更新');
    } else {
      const r = await api('/api/tasks', { method: 'POST', body: payload });
      const nr = r.task && r.task.nextRun;
      toast(nr ? `任务已创建，下次执行：${fmtDateTime(nr)}` : '任务已创建');
    }
    closeModal();
    await load();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ 设置操作 */

/* ---- 环境变量（青龙面板式） ---- */
function renderEnvVars() {
  const box = $('#envTable');
  if (!box) return;
  const list = S.data.settings.envVars || [];
  if (!list.length) {
    box.innerHTML = '<div class="hint hint--block">还没有变量。添加后即可在任务里用 <code>{{变量名}}</code> 引用。</div>';
    return;
  }
  box.innerHTML = list.map((v, i) => `
    <div class="env-row ${v.enabled ? '' : 'is-disabled'}" data-i="${i}">
      <code class="env-key">${esc(v.key)}</code>
      <span class="env-val" data-i="${i}" title="点击显示/隐藏">${v.enabled ? '••••••' : '(已停用)'}</span>
      <span class="env-note">${esc(v.note || '')}</span>
      <button class="icon-btn env-eye" data-eye="${i}" title="显示/隐藏">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
      </button>
      <label class="switch env-switch" title="启用/停用">
        <input type="checkbox" data-toggle="${i}" ${v.enabled ? 'checked' : ''}>
        <span class="track"></span>
      </label>
      <button class="icon-btn is-del" data-del="${i}" title="删除">${ICONS.del}</button>
    </div>`).join('');
}

function envVarsFromUI() {
  // 以当前服务端列表为基础，套用行内改动（显隐/启停/删除），返回待保存数组
  return (S.data.settings.envVars || []).map((v) => ({ ...v }));
}

/* ---- 短信网关：拼调用地址与示例（sharecode 跟探活地址同规则，外部可直连） ---- */
function gatewayBaseUrl() {
  const sc = (location.search.match(/[?&]sharecode=([^&]+)/) || [])[1]
    || (S.data && S.data.settings && S.data.settings.sharecode) || '';
  return location.origin + '/gateway/sms/send' + (sc ? `?sharecode=${sc}` : '');
}

function updateGatewaySnippet() {
  const urlEl = $('#gwUrl');
  if (!urlEl) return;
  const base = gatewayBaseUrl();
  const token = $('#gwToken').value.trim() || '<你的令牌>';
  const sendUrl = base + (base.includes('?') ? '&' : '?') + 'token=' + token;
  urlEl.value = sendUrl;
  const snip = $('#gwSnippet');
  if (snip) {
    snip.textContent =
      `# GET 直发（content 需 URL 编码；加 async=1 立即受理、后台发送）\n` +
      `curl "${sendUrl}&content=${encodeURIComponent('服务器告警：磁盘超 90%')}&async=1"\n\n` +
      `# POST JSON（推荐，免转码；令牌放 X-Token 头或 ?token= 参数）\n` +
      `curl -X POST "${base}?token=${token}" \\\n` +
      `  -H "X-Token: ${token}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"content": "服务器告警：磁盘超 90%"}'`;
  }
}

async function loadGatewayLog() {
  const box = $('#gwLog');
  if (!box) return;
  try {
    const r = await api('/api/gateway-sms/log');
    box.innerHTML = r.entries.length
      ? r.entries.map((e) =>
          `<div>${esc(e.at.slice(5, 16))} ${e.ok ? '✅' : '❌'} ${esc(e.message || '')}` +
          `${e.content ? ' · ' + esc(e.content) : ''}${e.mode ? `（${e.mode === 'async' ? '异步' : '同步'}）` : ''}</div>`
        ).join('')
      : '暂无调用';
  } catch (e) {
    // 网关日志含短信正文片段，服务端只给管理员；访客看到这句而不是「加载失败」
    box.textContent = smsHandleAuthError(e, true) ? '需管理员登录后查看（日志含短信内容）' : '日志加载失败';
  }
}

async function saveSettings(patch, okMsg) {
  try {
    const r = await api('/api/settings', { method: 'PUT', body: patch });
    S.data.settings = { ...S.data.settings, ...r.settings };
    clearFormDirty(); // 已落盘，允许下一次轮询正常回显
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

/* ---- 网站 ↔ Cloudflare 双向陪护（第十批）----
 * 只读展示：数据来自 /api/state 的 companion（与 /api/health 同一份快照）。
 * 全部用 textContent 写，绝不重建 DOM —— details 的展开状态由浏览器保持，
 * 45 秒轮询和任务编辑门控都不会把它收回去。
 */
function renderCompanion() {
  const c = (S.data && S.data.companion) || null;
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  };
  const dot = $('#cmpDot');
  if (!c || !c.configured) {
    if (dot) dot.className = 'sdot is-off';
    set('#cmpBrief', c ? '未配置中继' : '状态未下发', 'hint');
    set('#cmpUpstream', '—', 'cmp-v'); set('#cmpUpstreamNote', '配置发送中继后开始体检');
    set('#cmpSite', '—', 'cmp-v'); set('#cmpSiteNote', '');
    set('#cmpAt', '—', 'cmp-v'); set('#cmpAtNote', '');
    set('#cmpWake', '—', 'cmp-v'); set('#cmpWakeNote', '');
    return;
  }
  const g = c.guard || {};
  const r = c.relay || {};
  const w = c.wake || {};
  /*
   * 通道健康只看上游腿（与后端一致）：短信发不发得出去，由「CF → 网关」决定。
   * 站点腿（CF → 本站）冷启动常十几秒，把它算进红绿会把「能发短信」误标成异常。
   */
  const channelOk = g.ok === true;
  const siteOk = g.siteOk === true;
  const level = channelOk ? 'ok' : (g.ok === false ? 'err' : 'warn');
  if (dot) dot.className = 'sdot is-' + (channelOk ? 'ok' : (g.ok === false ? 'err' : 'off'));

  let brief;
  if (channelOk) {
    brief = (siteOk ? '双向正常' : '短信通道正常 · 站点回探偏慢')
      + ' · ' + (g.at ? fmtAgo(g.at) : '刚刚');
  } else if (g.ok === false) brief = '体检异常 · ' + (g.error || '上游不通');
  else brief = '等待首次体检';
  set('#cmpBrief', brief, 'hint' + (level === 'err' ? ' hint--warn' : ''));

  // 上游网关：403 是网关对探针的正常响应，判据是 relay.ok 不是状态码
  const upOk = r.ok === true;
  set('#cmpUpstream', r.ok == null ? '未知' : (upOk ? '连通' : '不通'),
    'cmp-v is-' + (upOk ? 'ok' : (r.ok === false ? 'err' : 'warn')));
  set('#cmpUpstreamNote', [
    r.status ? 'HTTP ' + r.status + (r.status === 403 ? '（探针预期）' : '') : '',
    r.edge || '', r.ms ? r.ms + 'ms' : '', r.at ? fmtAgo(r.at) : '',
    // 失败时把原因留在这一项里，别让用户只看到「不通」却不知道是超时还是网络错
    r.ok === false && r.error ? '原因 ' + r.error : '',
  ].filter(Boolean).join(' · ') || '暂无探针数据');

  set('#cmpSite', g.ok == null ? '未知' : (siteOk ? '可达' : '偏慢'),
    'cmp-v is-' + (siteOk ? 'ok' : 'warn'));
  // 站点腿是参考项：它慢不等于短信发不出去，这里不再跟着整条体检的失败状态染红
  set('#cmpSiteNote', g.build ? '回探到 build ' + g.build
    : (siteOk ? '' : '回探未通过 · 不影响短信通道'));

  set('#cmpAt', g.at ? fmtAgo(g.at) : '尚未体检', 'cmp-v');
  set('#cmpAtNote', [
    g.ms ? g.ms + 'ms' : '', g.edge || '',
    g.upstreamOk === true && g.siteOk === true ? '两侧均通' : '',
    g.error || '',
  ].filter(Boolean).join(' · '));

  set('#cmpWake', w.lastWokeAt ? fmtAgo(w.lastWokeAt) : '—', 'cmp-v');
  set('#cmpWakeNote', '累计唤醒 ' + (Number(w.count) || 0) + ' 次 · 每 30 分钟一次');
}

if ($('#cmpGuardBtn')) {
  $('#cmpGuardBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const note = $('#cmpGuardNote');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '体检中…';
    if (note) note.textContent = '正在并行检测上游网关与本站，最多 30 秒…';
    try {
      // force=1：按钮就是要「现在测一次」，绕过服务端 60 秒结果缓存；客户端留足余量
      const r = await api('/api/relay/guard?force=1', { timeout: 40000 });
      if (note) {
        note.textContent = r.ok
          ? '体检通过：短信通道正常（' + (r.ms || 0) + 'ms）'
            + (r.siteOk === false ? '，站点回探偏慢（参考项）' : '，两侧均通') + '，状态已更新。'
          : '体检未通过：' + (r.error || ('HTTP ' + r.status)) + '。详情见上方四项。';
      }
      await load();
    } catch (err) {
      if (note) note.textContent = '体检请求失败：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

/* ---- 短信发送中继（可选）---- */
function renderSgrState() {
  const el = $('#sgrState');
  if (!el) return;
  const sgr = (S.data && S.data.settings && S.data.settings.smsGatewayRelay) || {};
  const h = (S.data && S.data.relayHealth) || {};
  el.classList.remove('hint--warn');
  if (!sgr.enabled || !sgr.url) {
    el.textContent = '未启用';
  } else if (h.ok === true) {
    // 真实发送成功比探针更有说服力：它证明中继、网关、送达三段全通
    const src = h.src === 'send' ? '最近发送成功' : '自检通过';
    el.textContent = '已启用 · ' + src
      + (h.ms ? ' · ' + h.ms + 'ms' : '')
      + (h.edge ? ' · ' + h.edge : '')
      + (h.at ? ' · ' + fmtAgo(h.at) : '');
  } else if (h.ok === false) {
    el.classList.add('hint--warn');
    el.textContent = '已启用 · ' + (h.src === 'send' ? '发送' : '自检') + '失败'
      + (h.at ? '（' + fmtAgo(h.at) + '）' : '') + '：' + (h.error || '未知原因');
  } else {
    el.textContent = '已启用 · 尚未验证（点「测试连通」）';
  }
  /*
   * 多地址与分段耗时：「几条中继、现在经哪条、慢在哪一段」直接摆出来。
   * 复用连接时 connectMs/tlsMs 为 0 —— 这本身就是「连接池生效」的证据，
   * 比一个笼统的总耗时有用得多。
   */
  const eps = $('#sgrEndpoints');
  if (eps) {
    const c = (S.data && S.data.companion) || {};
    const list = Array.isArray(c.endpoints) ? c.endpoints : [];
    const t = h.timing || {};
    const segs = [];
    if (t.reused === true) segs.push('连接复用');
    else if (t.reused === false) segs.push('新建连接');
    if (t.connectMs) segs.push('握手 ' + t.connectMs + 'ms');
    if (t.tlsMs) segs.push('TLS ' + t.tlsMs + 'ms');
    if (t.ttfbMs) segs.push('首字节 ' + t.ttfbMs + 'ms');
    const parts = [];
    if (list.length > 1) parts.push(list.length + ' 条中继（通 ' + (Number(h.upCount) || 0) + ' 条）');
    if (h.via) parts.push('当前经 ' + String(h.via).replace(/^https:\/\//, ''));
    if (segs.length) parts.push(segs.join(' · '));
    if (Number(c.failStreak) > 0) parts.push('连续失败 ' + c.failStreak + ' 次');
    eps.textContent = parts.join(' · ');
    eps.className = 'field-note' + (Number(c.failStreak) > 0 || h.ok === false ? ' hint--warn' : '');
  }
  if (typeof renderSgsState === 'function') renderSgsState();
}

function sgrPayload() {
  const p = {
    enabled: $('#sgrEnabled').checked,
    url: $('#sgrUrl').value.trim(),
    // 备用地址：逗号/空白分隔都认，后端会统一去重并只留 https origin
    urls: ($('#sgrUrls') ? $('#sgrUrls').value : '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
  };
  // 密钥留空 = 不修改（不提交该字段，后端 deepMerge 保留原值）
  const sv = $('#sgrSecret').value.trim();
  if (sv) p.secret = sv;
  return p;
}

if ($('#sgrSave')) {
  $('#sgrSave').addEventListener('click', async () => {
    const ok = await saveSettings({ smsGatewayRelay: sgrPayload() }, '中继配置已保存');
    if (ok) renderSgrState();
  });
  $('#sgrEnabled').addEventListener('change', () => {
    const n = $('#sgrNote');
    if (n) n.textContent = '开关已修改，点「保存」后生效。密钥留空则保留原值。';
  });
  $('#sgrTest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await api('/api/sms/relay-test');
      const rp = r.relayProbe || {};
      const n = $('#sgrNote');
      if (!rp.configured) {
        if (n) n.textContent = '还没配置中继地址：填好地址并点「保存」后再测。';
      } else {
        /*
         * 多地址逐条报结果：主地址不通时能立刻看到备用是否还活着，
         * 顺带把「是否复用连接」写出来 —— 首次一定新建，第二次起应该显示复用。
         */
        const list = Array.isArray(rp.endpoints) ? rp.endpoints : [];
        const best = list.filter((x) => x.ok).sort((a, b) => a.ms - b.ms)[0] || null;
        const parts = list.map((e) => {
          const host = String(e.url || '').replace(/^https:\/\//, '');
          if (!e.ok) return host + ' 不通（' + (e.error || 'HTTP ' + e.status || '未知错误') + '，' + (e.ms || 0) + 'ms）';
          const inner = e.result && e.result.ok === true;
          const t = e.timing || {};
          const seg = t.reused === true ? '连接复用' : ('握手 ' + ((t.connectMs || 0) + (t.tlsMs || 0)) + 'ms');
          return host + (best && best.url === e.url ? '【当前使用】' : '') + ' 通（' + e.ms + 'ms，' + seg + '）· 网关'
            + (inner ? ' TLS 正常' : ' ' + JSON.stringify(e.result || {}).slice(0, 120));
        });
        if (n) n.textContent = parts.length ? parts.join('；') : '中继未返回结果';
      }
      // 探针结果已写进 relayHealth/companion，拉一次状态把「分段耗时」那行也刷新
      try { await load(); } catch { /* 拉取失败不影响已展示的探针结果 */ }
      if (typeof renderSgrState === 'function') renderSgrState();
    } catch (err) {
      const n = $('#sgrNote');
      if (n) n.textContent = '诊断失败：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

/* ---- 白名单 SNI 伪装（实验 · 已否证，见 2026-11-08 实测）---- */
function renderSgsState() {
  const el = $('#sgsState');
  if (!el) return;
  const sgs = (S.data && S.data.settings && S.data.settings.smsGatewaySni) || {};
  const sgr = (S.data && S.data.settings && S.data.settings.smsGatewayRelay) || {};
  // 结论已经钉死：6 组 SNI 全部在 ClientHello 前被重置，拦截在出口 IP 层。
  // 这里显式写「已否证」，避免有人以为开了开关就能绕过去。
  el.textContent = (sgr.enabled && sgr.url) ? '已否证 · 发送走中继'
    : (sgs.enabled && sgs.sni ? '已否证 · 开着也无效（' + sgs.sni + '）' : '已否证 · 建议保持关闭');
}

function sgsPayload() {
  return {
    enabled: $('#sgsEnabled').checked,
    sni: $('#sgsSni').value.trim(),
  };
}

if ($('#sgsSave')) {
  $('#sgsSave').addEventListener('click', async () => {
    const ok = await saveSettings({ smsGatewaySni: sgsPayload() }, 'SNI 伪装配置已保存');
    if (ok) renderSgsState();
  });
  $('#sgsEnabled').addEventListener('change', () => {
    const n = $('#sgsNote');
    if (n) n.textContent = '开关已修改，点「保存」后生效。提醒：SNI 伪装已实测否证，开了也不会通；发送请走中继。';
  });
  $('#sgsTest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '探测中…';
    try {
      const r = await api('/api/sms/sni-probe');
      const n = $('#sgsNote');
      if (!n) return;
      const rs = r.results || [];
      const wins = rs.filter((x) => x.ok && x.label !== 'gateway');
      const brief = rs.map((x) => x.sni + ':' + (x.ok ? '通' : '断')).join('  ');
      n.textContent = '[' + (r.build || '?') + '] ' + brief + (wins.length
        ? ' → 出现可握手变体：' + wins.map((x) => x.sni).join('、') + '（网关策略可能变了，值得复测发送链路）'
        : ' → 全部在握手前被断，与 2026-11-08 结论一致：拦截在出口 IP 层，改 SNI 绕不过，请用中继');
    } catch (err) {
      const n = $('#sgsNote');
      if (n) n.textContent = '探测失败：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

/**
 * 管理口令弹窗：resolve 口令字符串，取消 resolve null。
 * 不用原生 prompt —— 原生 prompt 会把口令明文回显在输入框上方，也无法标注来源。
 * hint 用来承接上一次「口令不对」的提示，避免用户输错一次就得重新点按钮。
 */
function askSmsPassword(hint) {
  return new Promise((resolve) => {
    const modal = $('#smsPassModal');
    const input = $('#spInput');
    const err = $('#spErr');
    const okBtn = $('#spOk');
    if (!modal || !input || !okBtn) { resolve(null); return; }

    err.textContent = hint || '';
    input.value = '';
    modal.hidden = false;
    setTimeout(() => input.focus(), 30);

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      okBtn.onclick = null;
      input.onkeydown = null;
      modal.querySelectorAll('[data-sp-close]').forEach((el) => { el.onclick = null; });
      resolve(val);
    };
    const submit = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = '口令不能为空'; input.focus(); return; }
      done(v);
    };
    okBtn.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    modal.querySelectorAll('[data-sp-close]').forEach((el) => { el.onclick = () => done(null); });
  });
}

/**
 * 短信高危操作的二次认证闸门。
 * 已解锁直接放行；未解锁则要口令 → 换 30 分钟令牌。
 *
 * 两个刻意的选择：
 *   1. 不用 api()，因为它把 401 当成「登录过期」会跳登录页 —— 而本站通常没开
 *      访问口令，压根没有登录页，跳过去就是一片空白。
 *   2. 输错时不直接放弃，而是带着提示重新弹窗（最多 3 次）。服务端另有
 *      10 次/IP 的锁定，这里只是别让用户白点。429 说明已被锁，立刻停。
 */
const SMS_PWD_MAX_TRIES = 3;

async function smsEnsureAdmin() {
  if (S.smsState && S.smsState.canManage) return true;
  // 状态还没拉到就先不拦：免认证模式下这次请求本来就会成功，
  // 真开了 CRONHUB_SMS_GUARD 的话，端点会回 403，再由 smsHandleAuthError 引导去登录。
  if (!S.smsState) return true;

  let hint = '';
  for (let i = 0; i < SMS_PWD_MAX_TRIES; i++) {
    const pwd = await askSmsPassword(hint);
    if (!pwd) return false;   // 用户取消

    let res, data = {};
    try {
      res = await fetch('/api/sms/admin-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pwd }),
        signal: AbortSignal.timeout(15000),
      });
      try { data = await res.json(); } catch { /* 空响应 */ }
    } catch (e) {
      toast(e && e.name === 'TimeoutError' ? '认证超时，请重试' : (e.message || '认证失败'), 'err');
      return false;
    }

    if (res.ok) {
      await loadSmsState();
      toast(`管理员登录成功，${Math.round((data.ttlSec || 1800) / 60)} 分钟内可执行全部短信操作`);
      return true;
    }

    // 429 = 已触发服务端锁定，继续试只会延长锁定
    if (res.status === 429) {
      toast(data.error || '尝试次数过多，请稍后再试', 'err');
      return false;
    }
    const left = SMS_PWD_MAX_TRIES - i - 1;
    hint = (data.error || '口令不正确') + (left > 0 ? `（还可再试 ${left} 次）` : '（已用完重试次数）');
    if (!left) { toast(hint, 'err'); return false; }
  }
  return false;
}

/** 短信接收状态：正常 / 静音到几点 / 已退订（退订或静音时给一键恢复） */
async function loadSmsState() {
  const dotEl = $('#smsStateDot');
  const txtEl = $('#smsStateText');
  const btn = $('#smsResumeBtn');
  if (!txtEl) return;
  try {
    const r = await api('/api/sms/recv-state');
    S.smsState = r;
    const cred = r.credential || {};
    const vault = r.vault || {};
    const rt = r.runtime || {};
    const locked = !!(cred.circuit && cred.circuit.open);
    const needAuth = cred.state === 'NEED_REAUTH' || cred.state === 'REVOKED';
    const expiring = cred.state === 'EXPIRING';
    const vaultBad = vault.ok === false;
    if (dotEl) {
      dotEl.className = 'sms-state-dot'
        + (!r.receiving ? ' is-off'
          : (vaultBad || needAuth ? ' is-off'
            : (locked || expiring ? ' is-warn' : ' is-ok')));
    }
    /*
     * 状态条是用户第一眼看到的东西，必须说人话。
     * 退订、熔断、需重授权、密钥丢失、临近到期是五种完全不同的原因，
     * 混成一句「接收正常」就是粉饰；dry-run 不写清楚等于让用户以为真发出去了。
     */
    txtEl.textContent = vaultBad
      ? '凭据保险库异常 · ' + String(vault.message || '').slice(0, 40)
      : !r.receiving
        ? r.stateText + '（站内与推送不受影响）'
        : locked
          ? '通道已熔断 · 剩余 ' + fmtRemain(cred.circuit.remainSec) + '（站内与推送不受影响）'
          : cred.state === 'REVOKED'
            ? '凭据已吊销 · 点「扫码授权」重新绑定（站内与推送不受影响）'
            : cred.state === 'NEED_REAUTH'
              ? '短信授权已失效 · 点「扫码授权」重新绑定（站内与推送不受影响）'
              : expiring
                ? '凭据 ' + (cred.hardExpiresInDays || 0) + ' 天后到期 · 请提前重新授权'
                : (rt.dryRun ? 'dry-run 环境 · 短信只模拟不实发' : '短信接收正常');
    if (btn) btn.hidden = !!r.receiving;
    /*
     * 访客视角：服务端只回「通道在不在收」，不回凭据状态与配额。
     * 所以这里不能假装「凭据正常」，也不能给出任何可点的操作 ——
     * 直接说清当前是访客，并指向唯一的认证入口。
     */
    if (!r.canManage) {
      if (dotEl) dotEl.className = 'sms-state-dot' + (r.receiving ? ' is-ok' : ' is-off');
      txtEl.textContent = (r.receiving ? '短信通道接收中' : r.stateText)
        + ' · 通道配置与凭据操作需管理员登录';
    }
    applySmsAdminGate(!!r.canManage, r.authStats, r.guard);
    renderSmsCredential(r.credential, r.canManage);
    renderSmsBrief(r.credential);
    renderSmsBinds(r.bindings, r.canManage);
    renderSmsPreview();

    /*
     * 面板自愈：只要真实状态是 ACTIVE，就把还挂着的二维码 / 报错清掉。
     * 否则会出现最让人困惑的一种画面：顶部写着「短信接收正常」，
     * 下面授权结果框还停在「未检测到授权」——用户只会相信下面那一句。
     */
    if (cred.state === 'ACTIVE') {
      const box = $('#smsAuthResult');
      if (box && !box.hidden) {
        const stale = box.dataset.hasQr === '1'
          || /未检测到|没检测到|已失效|申请失败|❌/.test(box.textContent || '');
        if (stale) {
          stopSmsPoll();
          box.className = 'sms-auth-result is-ok';
          box.innerHTML = '✅ 授权已生效，短信通道正常';
          delete box.dataset.hasQr;
        }
      }
    } else if (cred.state === 'NEED_REAUTH' || cred.state === 'REVOKED') {
      /*
       * 状态是「需重新授权」时，打开页面就问一次真话。
       * 后端只有被 preAuth 问过才会知道「用户其实已经扫完码了」——
       * 没人问，它就一直是 NEED_REAUTH，页面也就一直显示「没有」。
       * 延迟到下一个事件循环，避免与模块顶层的 let 声明抢时序。
       */
      setTimeout(() => { smsProbeOnce(false).catch(() => {}); }, 0);
    }
  } catch {
    if (txtEl) txtEl.textContent = '状态未知（服务端版本较旧）';
    applySmsAdminGate(false);
  }
}

/**
 * 服务端回「需要管理员权限」= 30 分钟令牌过期、或换了设备/网络。
 * 此时页面还以为是管理员，按钮都亮着，点了必然 403 —— 统一收敛成「重新登录」，
 * 而不是把 403 原文当业务错误抛给用户看。
 */
function smsHandleAuthError(err, silent) {
  const m = String((err && err.message) || err || '');
  if (!m.includes('管理员权限') && !m.includes('未解锁')) return false;
  if (S.smsState) S.smsState.canManage = false;
  applySmsAdminGate(false);
  renderSmsCredential(null, false);
  if (!silent) toast('管理员认证已失效，请重新点「管理员登录」', 'err');
  return true;
}

/**
 * 短信卡片的权限外观：guest 时所有可操作控件禁用，只留管理员条的登录按钮。
 *
 * 这只是「别让人白点」，不是安全边界 —— 真正的判定在每个 /api/sms 端点上。
 * 之所以还要做：不 disable 的话，访客点「保存」会收到 403 弹窗，体验像坏了。
 */
function applySmsAdminGate(canManage, stats, guard) {
  const card = $('#smsCard');
  if (!card) return;
  // guard 未传（错误兜底路径）时按「需要认证」渲染，避免误报免认证
  const isGuard = guard === undefined ? true : !!guard;
  card.classList.toggle('is-guest', !canManage);
  card.querySelectorAll('input, select, button').forEach((el) => {
    if (el.hasAttribute('data-admin-gate')) { el.disabled = false; return; }
    if (el.hasAttribute('data-need-admin')) return;  // 显隐由 renderSmsCredential 控制
    el.disabled = !canManage;
  });

  const bar = $('#smsAdminBar');
  const role = $('#smsAdminRole');
  const hint = $('#smsAdminHint');
  const btn = $('#smsAdminBtn');
  if (bar) bar.classList.toggle('is-admin', canManage);
  if (!isGuard) {
    // 免认证模式：身份条改成「授权次数」计数牌，管理员登录入口收起来（没用了）
    const n = Number((stats && stats.count) || 0);
    const last = stats && stats.lastAt ? fmtDateTime(stats.lastAt) : '';
    if (role) role.textContent = '🔓 免认证';
    if (hint) {
      hint.textContent = n
        ? `短信操作直接生效，不拦人 · 已授权 ${n} 次${last ? ' · 最近 ' + last + (stats.lastAction ? '（' + stats.lastAction + '）' : '') : ''}`
        : '短信操作直接生效，不拦人 · 尚无授权记录';
    }
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = '';
  if (role) role.textContent = canManage ? '✅ 管理员' : '🔒 访客';
  if (hint) {
    hint.textContent = canManage
      ? '已通过管理员认证，30 分钟内可执行全部短信操作（含授权与吊销）'
      : '短信通道的开关、保存、测试、授权、吊销均需管理员权限';
  }
  if (btn) btn.textContent = canManage ? '退出管理员' : '管理员登录';
}

/**
 * 一行摘要：平时只看这一行就够，不必展开细节。
 * 「通了没、还剩多久、今天用了多少」——三件事一行说完。
 */
function renderSmsBrief(c) {
  const el = $('#smsBrief');
  if (!el) return;
  if (!c) { el.hidden = true; el.textContent = ''; return; }
  const t = c.today || {};
  const bits = [];
  if (c.circuit && c.circuit.open) {
    bits.push('熔断剩余 ' + fmtRemain(c.circuit.remainSec));
  } else {
    bits.push('令牌 ' + (Number(c.tokenExpiresInSec) > 0 ? fmtRemain(c.tokenExpiresInSec) : '未持有'));
  }
  bits.push('今日发送 ' + (t.sendCount || 0) + '/' + (t.sendLimit || 20));
  bits.push('授权 ' + (t.authCount || 0) + ' 次');
  if (c.hardExpiresInDays !== undefined && c.hardExpiresInDays !== null && c.state !== 'NEED_REAUTH') {
    bits.push('凭据剩 ' + (c.hardExpiresInDays || 0) + ' 天');
  }
  el.textContent = bits.join(' · ');
  el.hidden = false;
}

/**
 * 接收号码列表：一个号码一份独立授权，状态互不影响。
 * 数据来自 recv-state 附带的 bindings 摘要（不发额外请求）；
 * 操作按钮只在管理员态出现：待授权 → 授权；非主号码 → 解绑；列表头 → 添加号码。
 */
function renderSmsBinds(bindings, canManage) {
  const box = $('#smsBinds');
  if (!box) return;
  if (!Array.isArray(bindings) || !bindings.length || !canManage) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const STATE_TEXT = {
    ACTIVE: '正常', NEED_REAUTH: '待授权', REVOKED: '已吊销',
    EXPIRING: '临近过期', CIRCUIT_OPEN: '熔断中',
  };
  const dotCls = (st) => (st === 'ACTIVE' ? 'is-ok' : st === 'EXPIRING' ? 'is-warn' : 'is-off');
  const rows = bindings.map((b) => {
    const st = b.state || 'NEED_REAUTH';
    const acts = [];
    if (st === 'NEED_REAUTH' || st === 'REVOKED') {
      acts.push(`<button class="btn btn--ghost btn--xs" data-bind-auth="${b.id}">扫码授权</button>`);
    }
    if (!b.primary && bindings.length > 1) {
      acts.push(`<button class="btn btn--ghost btn--xs is-danger" data-bind-del="${b.id}" title="删除该号码的授权与凭据">解绑</button>`);
    }
    return `<div class="sms-bind-row">
      <span class="sms-state-dot ${dotCls(st)}"></span>
      <span class="sms-bind-label">${esc(b.label || b.id)}${b.primary ? ' <em class="sms-bind-primary">主</em>' : ''}</span>
      <span class="sms-bind-state">${STATE_TEXT[st] || st}</span>
      <span class="sms-bind-acts">${acts.join('')}</span>
    </div>`;
  });
  const addBtn = bindings.length < 5
    ? `<button class="btn btn--ghost btn--xs" data-bind-add title="多绑一个号 = 多扫一次码，两号各自授权互不影响">＋添加号码</button>`
    : `<span class="hint">已达上限 5 个</span>`;
  box.innerHTML = `<div class="sms-bind-head"><span>接收号码（${bindings.length}）</span>${addBtn}</div>` + rows.join('');
  box.hidden = false;
}


/** 发送记录：懒加载 —— 展开细节面板时才拉一次，平时 45 秒轮询不碰它 */
let smsRecordsLoadedAt = 0;
/**
 * 发送记录的结果标签。失败时优先展示原因：排障信息比正文更重要，不必再去翻 toast 或系统日志。
 */
function smsRecordTag(x) {
  const m = String((x && x.message) || '');
  if (!x || !x.ok) {
    const why = m
      .replace(/^短信发送失败（已重试）：/, '')
      .replace(/^测试失败：/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      text: why ? why.slice(0, 26) + (why.length > 26 ? '…' : '') : '发送失败',
      cls: 'is-err',
      title: m || '发送失败',
    };
  }
  if (x.dryRun) return { text: '', cls: '', title: m };
  return { text: '已发送', cls: '', title: m };
}

async function loadSmsRecords(force) {
  const body = $('#smsRecordsBody');
  if (!body) return;
  if (!force && Date.now() - smsRecordsLoadedAt < 60000) return;   // 60 秒内不重复拉
  smsRecordsLoadedAt = Date.now();
  try {
    const r = await api('/api/sms/records?limit=8');
    const rows = r.records || [];
    if (!rows.length) { body.innerHTML = '<span class="hint">还没有发送记录</span>'; return; }
    body.innerHTML = rows.map((x) => {
      const tag = smsRecordTag(x);
      const tagHtml = tag.text
        ? `<span class="sms-record-tag ${tag.cls}" title="${esc(tag.title)}">${esc(tag.text)}</span>`
        : '';
      return `<div class="sms-record-row">
      <span>${x.ok ? '✅' : '❌'}</span>
      <span class="sms-record-time">${esc(x.atText || '')}</span>
      <span class="sms-record-label">${esc(x.label || x.bindingId || '')}</span>
      <span class="sms-record-msg" title="${esc(x.message || '')}">${esc(x.summary || '')}${x.dryRun ? ' <em>（模拟）</em>' : ''}</span>
      ${tagHtml}
    </div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<span class="hint">记录读取失败：' + esc(e.message || '未知错误') + '</span>';
  }
}

/**
 * 凭据仪表盘：只读展示状态机与今日计数。
 * 刻意不渲染任何"重试 / 重新授权"入口 —— 那两个按钮只在 canManage 时露出，其余情况一律隐藏。
 */
function renderSmsCredential(c, canManage) {
  const set = (id, text, cls) => {
    const el = $('#' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'sms-meter-v' + (cls ? ' ' + cls : '');
  };
  if (!c) {
    // 访客拿不到凭据状态（服务端按身份裁字段），这里如实说明原因，不显示假数据
    set('smCredState', canManage ? '未知' : '需管理员');
    ['smCredToken', 'smCredRefresh', 'smCredSend', 'smCredAuth'].forEach((id) => set(id, '—', 'is-dim'));
    document.querySelectorAll('[data-need-admin]').forEach((el) => { el.hidden = true; });
    /*
     * 这一行不能漏：退出管理员后 c 变成空，如果直接 return，
     * 说明栏会保留上一次（管理员时）渲染的内容 —— 那里面写着硬过期日、
     * 保险库分区计数、最近一次决策原因，等于退出登录后仍摊在屏幕上。
     */
    const noteEl = $('#smsAuthState');
    if (noteEl) {
      noteEl.textContent = canManage
        ? '凭据状态读取中…'
        : '凭据状态、配额计数、保险库信息与最近一次决策，需要管理员登录后查看。';
    }
    return;
  }
  const stateText = c.circuit && c.circuit.open
    ? '熔断中 · 剩余 ' + fmtRemain(c.circuit.remainSec)
    : (c.state === 'EXPIRING' ? '即将到期 · ' + (c.hardExpiresInDays || 0) + ' 天' : c.stateText);
  const stateCls = (c.circuit && c.circuit.open) || c.state === 'EXPIRING'
    ? 'is-warn'
    : (c.state === 'ACTIVE' ? 'is-ok' : 'is-err');
  set('smCredState', stateText + (c.state === 'LOCKED' && !(c.circuit || {}).open ? ' · 待探测' : ''), stateCls);

  const ttl = Number(c.tokenExpiresInSec) || 0;
  set('smCredToken', ttl > 0 ? '剩余 ' + fmtRemain(ttl) : '未持有', ttl > 0 ? '' : 'is-dim');

  const t = c.today || {};
  set('smCredRefresh', (t.refreshCount || 0) + ' / ' + (t.refreshLimit || 24),
    (t.refreshCount || 0) >= (t.refreshLimit || 24) ? 'is-warn' : '');
  set('smCredSend', (t.sendCount || 0) + ' / ' + (t.sendLimit || 20),
    (t.sendCount || 0) >= (t.sendLimit || 20) ? 'is-warn' : '');
  // 授权次数只是提示线：超过建议值时标黄（说明在烧验证码），从不标红——它不会拦住任何人
  const soft = Number(t.authSoftLimit) || 3;
  set('smCredAuth', (t.authCount || 0) + ' / ' + (t.authLimit || 10),
    (t.authCount || 0) >= (t.authLimit || 10) ? 'is-warn'
      : (t.authCount || 0) >= soft ? 'is-warn' : '');
  const authMeter = $('#smCredAuth');
  if (authMeter) {
    authMeter.title = `今日授权 ${t.authCount || 0} 次（建议 ≤ ${soft} 次，提示线 ${t.authLimit || 10} 次；超出只提醒，仍会继续）`
      + (t.authHourLimit ? ` · 每小时建议 ≤ ${t.authHourLimit} 次（本小时 ${t.authHourCount || 0} 次）` : '');
  }

  /*
   * 高危入口：只在通过管理员认证后出现。
   * 上一版曾做成「始终可见 + 点击再认证」，但那样等于把「重新授权 / 吊销」写在了
   * 任何人一进设置页就能看到的位置 —— 权限要求是全量的，入口本身也不该公开。
   * 「看不到有这回事」的问题改由管理员身份条承担：它常驻显示，说明有这些操作、需要登录。
   */
  document.querySelectorAll('[data-need-admin]').forEach((el) => {
    el.hidden = !canManage;
    el.removeAttribute('data-locked');
    el.classList.remove('is-locked');
    if (el.id === 'smsAuthBtn') el.textContent = '扫码授权';
  });
  // 授权结果面板同属高危操作的输出，访客不该看到残留
  const authResult = $('#smsAuthResult');
  if (authResult) {
    if (!canManage) {
      authResult.hidden = true;
      authResult.innerHTML = '';
      authResult.className = 'sms-auth-result';
    }
    if (canManage) {
      const at = (c.today || {});
      authResult.title = `今日已发起 ${at.authCount || 0} 次授权（建议 ≤ ${at.authSoftLimit || 3} 次，超出只提醒）`;
    }
  }

  const note = $('#smsAuthState');
  if (note) {
    /*
     * 访客不该看到这些：硬过期日、保险库三分区条目数、密钥来源、累计轮换次数、
     * 最近一次决策 —— 单看每项都不敏感，合起来等于把内部构造摊开给路过的人看。
     */
    if (!canManage) {
      note.textContent = '凭据状态、配额计数、保险库信息与最近一次决策，需要管理员登录后查看。';
      return;
    }
    const v = (S.smsState && S.smsState.vault) || {};
    const rt = (S.smsState && S.smsState.runtime) || {};
    const bits = ['无 refresh_token（一次性绑定，按需取短时效令牌，因此设硬过期日）'];

    // 硬过期：没有 refresh_token 就只能靠人盯着，必须显式给出剩余天数
    if (c.hardExpiresAt) {
      bits.push('硬过期 ' + fmtDate(c.hardExpiresAt) + '（剩 ' + (c.hardExpiresInDays || 0) + ' 天）');
    }

    // 保险库：密钥来源 + 三类凭据各自条目数（只有键名计数，没有值）
    if (v.ok === false) {
      bits.push('保险库异常：' + String(v.message || '').slice(0, 50));
    } else if (v.scopes) {
      const parts = v.scopes.map((s) => ({
        longterm: '长期', shortterm: '短期', app: '应用',
      }[s.name] || s.name) + ' ' + (s.entryCount === null ? '?' : s.entryCount));
      bits.push('保险库 ' + parts.join(' / '));
      bits.push(v.keyFromEnv ? '密钥来自环境变量' : '密钥独立存于 .secrets/（与库文件分离）');
      /*
       * 应用凭据为 0 是个「静默致命」状态：通道看着在，实际每次取令牌都返回
       * 200002 clientId不能为空。必须在这里顶格提示，不能只在出错后才让人发现。
       */
      const appScope = v.scopes.find((s) => s.name === 'app');
      if (appScope && appScope.entryCount === 0) {
        bits.push('❗应用凭据缺失（code/kid/strategyId 不在库里），取令牌会失败，需先用引导接口写入');
      }
    }

    // 轮换记账：次数突然暴涨说明令牌在频繁失效，值得警惕
    if (c.rotateCount) {
      bits.push('累计轮换 ' + c.rotateCount + ' 次' + (c.lastRotatedAt ? '（最近 ' + fmtDate(c.lastRotatedAt) + '）' : ''));
    }
    if (c.tokenStoreEphemeral) bits.push('⚠ 令牌仅存内存，未接入保险库');

    // dry-run：必须让用户一眼看出这条短信根本没发出去
    if (rt.dryRun) bits.push('⚠ dry-run：不会真实发送，生产配额消耗 0');

    if (c.deadLetters) bits.push('死信 ' + c.deadLetters + ' 条');
    if (c.lastDecision) {
      const ACTION_CN = {
        reuse: '复用令牌', refresh: '刷新令牌', circuit_block: '本地拦截',
        need_reauth: '需重新授权', revoked: '已吊销', vault_block: '保险库拦截',
        dry_run: '模拟发送',
      };
      const act = ACTION_CN[c.lastDecision.action] || c.lastDecision.action;
      bits.push('最近决策：' + act + ' · ' + c.lastDecision.reason);
    }
    note.textContent = bits.join(' · ');
  }
}

/** 时间戳 → 「10-27 19:05」 */
function fmtDate(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 秒 → 「4 分 12 秒」这种可读时长 */
function fmtRemain(sec) {
  const s2 = Math.max(0, Math.round(Number(sec) || 0));
  if (s2 >= 3600) {
    const h = Math.floor(s2 / 3600);
    const m = Math.round((s2 % 3600) / 60);
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  }
  if (s2 >= 60) return Math.floor(s2 / 60) + ' 分 ' + (s2 % 60) + ' 秒';
  return s2 + ' 秒';
}

/** 正文效果预览：按当前分级 / 字数 / 链接开关拼一条样例，实时算条数 */
function renderSmsPreview() {
  const box = $('#smsPreviewBody');
  if (!box) return;
  const max = Number(($('#smsMaxChars') || {}).value) || 134;
  const alEl = $('#smsActionLink');
  const withLink = !alEl || alEl.checked;
  const realUrl = (S.smsState && S.smsState.actionUrl) || '';
  const fullLink = withLink ? (realUrl || 'https://<你的域名>/a/<token>') : '';
  const head = '❌ 每日签到 · 09:12';
  // 与服务端同一套规则：链接 + 标题 + 20 字装不进上限时，宁可不带链接，把位置留给正文
  const link = fullLink && fullLink.length + head.length + 20 <= max ? fullLink : '';
  const budget = Math.max(12, max - head.length - (link ? link.length + 1 : 0) - 1);
  let line = '接口超时（timeout 8000ms），已重试 2 次仍未成功';
  if (line.length > budget) line = line.slice(0, budget - 1) + '…';
  const text = [head, line, link].filter(Boolean).join('\n');
  box.textContent = text;
  const lenEl = $('#smsPreviewLen');
  if (lenEl) {
    const n = text.length;
    lenEl.textContent = n + ' 字 · 约 ' + Math.max(1, Math.ceil(n / 67)) + ' 条' + (n > max ? ' · 超出上限' : '');
    lenEl.className = n > max ? 'hint hint--warn' : 'hint';
  }
}

async function testChannel(channel, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    // 短信测试给 90 秒：后端手动路径快失败（约 43s 内出结果），
    // 这里放宽是兜底——哪怕后端仍在慢重试，页面也能等到明确结果而不是 30s 就断
    const r = await api('/api/settings/test-notify', { method: 'POST', body: { channel }, timeout: 90000 });
    toast(r.message || '测试消息已发出');
  } catch (err) {
    // 短信授权过期时服务端会带回授权页地址：直接把授权区块拉出来，别让用户对着「空响应」猜
    /*
     * 授权重构：发送失败时**不再自动去要授权链接**。
     * 自动要链接 = 一次 preAuth = 可能消耗验证码，正是之前被风控锁死的路径。
     * 现在只把服务端给的可读原因告诉用户；要重新授权必须管理员手动点。
     */
    if (err.data && err.data.needReauth) {
      toast('短信授权已失效：点「扫码授权」重新绑定（系统不会自动重试）', 'err');
      const card = $('#smsCard');
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (/请求超时/.test(err.message || '')) {
      toast('测试等待超时：通道可能仍在后台重试，可稍后在「发送记录」里看结果', 'err');
    } else {
      toast(err.message, 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------ 事件绑定 */

function bind() {
  bindChannelTabs();

  // 设置页：点未配置渠道的标题行展开（委托到 document，卡片重建后照样生效）
  document.addEventListener('click', (e) => {
    const head = e.target.closest('.ch-fold-head');
    if (!head) return;
    e.preventDefault();
    toggleFoldCard(head);
  });

  /* 用 div/span 做的可点击卡片：Enter / Space 等价于鼠标点击，已有的点击委托不用改 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const t = e.target;
    if (!t || !t.closest || /^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(t.tagName)) return;
    const card = t.closest('[role="button"][tabindex="0"]');
    if (!card) return;
    e.preventDefault();
    card.click();
  });

  /* 记录「用户改过但还没保存」的表单字段，避免轮询把草稿整段冲掉 */
  const markEdited = (e) => {
    const el = e.target;
    if (!el || !el.dataset || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (el.closest('#view-settings, #view-keep')) {
      el.dataset.userEdited = '1';
      el.dataset.editedAt = String(Date.now());
    }
  };
  document.addEventListener('input', markEdited, true);
  document.addEventListener('change', markEdited, true);

  /* 失焦后补一次被 renderAll 跳过的表单类渲染；还有草稿时不补，等保存或切页 */
  let focusTimer = null;
  document.addEventListener('focusout', () => {
    // 连续 Tab 切字段会连发失焦：合批成一次，避免每次全量重绘 + 连带发 3 个请求
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusTimer = null;
      if (!S.data || editingForm() || formDirty()) return;
      renderSettings();
      renderSmsRelay();
      renderEnvVars();
      renderKeepView();
      linkLabels();
      keyboardClickable();
    }, 0);
  });

  linkLabels();
  keyboardClickable();

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchView(btn.dataset.view);
  });

  // 隐藏页（保活 / 日志）从设置进入，顶栏「设置」按钮退回设置
  $('#viewBack').addEventListener('click', () => switchView('settings'));

  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (!goto) return;
    const target = goto.dataset.goto;
    // 三种格式：card:xxx → 设置页对应卡片；view:xxx → 切视图；纯视图名 → 兼容旧用法
    if (target.startsWith('card:')) {
      gotoCard(target.slice(5));
    } else if (target.startsWith('view:')) {
      const v = target.slice(5);
      if (S.view !== v) switchView(v);
      const list = document.getElementById('inbox');
      if (v === 'inbox' && list && S.view === v) {
        setTimeout(() => list.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
      }
    } else if (target) {
      if (target === 'logs') resetSysFilter();
      switchView(target);
    }
  });

  $('#refreshBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-spin');
    await load(true);
    btn.classList.remove('is-spin');
    toast('数据已刷新');
  });

  $('#newTaskBtn').addEventListener('click', () => openModal(null));

  // 多步骤：添加 / 删除
  $('#addStep').addEventListener('click', () => {
    const el = addStep({ method: 'POST', expectStatus: 200 });
    el.querySelector('.st-name').focus();
  });
  // 步骤卡片是动态插入的，删除按钮在 addStep 里单独绑定；这里兜住脚本注入的旧节点
  $('#fSteps').addEventListener('click', (e) => {
    const rm = e.target.closest('.step-remove');
    if (!rm) return;
    rm.closest('.step-item').remove();
    renumberSteps();
  });

  // 任务列表委托
  // ---- 日志页：筛选 ----
  $('#sysLogLevel').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lv]');
    if (!b) return;
    S.sysLevel = b.dataset.lv;
    [...$('#sysLogLevel').children].forEach((x) => x.classList.toggle('is-active', x === b));
    loadSysLogs();
  });

  $('#sysLogSource').addEventListener('change', (e) => {
    S.sysSource = e.target.value;
    loadSysLogs();
  });

  let sysSearchTimer = null;
  $('#sysLogSearch').addEventListener('input', (e) => {
    const v = e.target.value;
    clearTimeout(sysSearchTimer);
    sysSearchTimer = setTimeout(() => {
      S.sysQuery = v.trim();
      loadSysLogs();
    }, 300);
  });

  $('#sysLogRefresh').addEventListener('click', () => loadSysLogs());

  $('#sysLogExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S.sysLogs || [], null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cronhub-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  $('#sysLogClear').addEventListener('click', async () => {
    if (!confirm('清空全部网站运行日志？任务执行记录不受影响。')) return;
    try {
      await api('/api/system-logs', { method: 'DELETE' });
      toast('运行日志已清空');
      loadSysLogs(true);
    } catch (e) {
      toast('清空失败：' + e.message, 'err');
    }
  });

  $('#sysLogList').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row');
    if (!row) return;
    const d = document.querySelector(`[data-detail="${row.dataset.log}"]`);
    if (d) d.hidden = !d.hidden;
  });

  // ---- 任务运行日志弹窗 ----
  $('#taskLogModal').addEventListener('click', (e) => {
    if (e.target.closest('[data-tl-close]')) $('#taskLogModal').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#taskLogModal').hidden) $('#taskLogModal').hidden = true;
  });

  $('#taskList').addEventListener('click', (e) => {
    // 刚拖完的那一下 click 是手指抬起带出来的，吃掉，别让它顺手执行了任务
    if (Date.now() - S.lastSortAt < 500) return;
    const gh = e.target.closest('.task-group-head');
    if (gh) {
      const fold = readGroupFold();
      const g = gh.dataset.group;
      if (fold[g]) delete fold[g]; else fold[g] = true;
      writeGroupFold(fold);
      renderTasks();
      return;
    }
    const check = e.target.closest('[data-check]');
    if (check) {
      // 复选框：加入/移出批量选择（阻止卡片其他交互）
      if (check.checked) S.taskSel.add(check.dataset.check);
      else S.taskSel.delete(check.dataset.check);
      renderTasks();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.task').dataset.id;
    const act = btn.dataset.act;
    if (act === 'run') runTask(id, btn);
    if (act === 'toggle') toggleTask(id);
    if (act === 'del') deleteTask(id);
    if (act === 'pin') pinTask(id);
    if (act === 'logs') openTaskLogs(id);
    if (act === 'edit') {
      const t = S.data.tasks.find((x) => x.id === id);
      if (t) openModal(t);
    }
  });

  // 批量操作（青龙面板式）
  $('#batchEnable').addEventListener('click', () => batchAction('enable'));  $('#batchDisable').addEventListener('click', () => batchAction('disable'));
  $('#batchDelete').addEventListener('click', () => batchAction('delete'));
  $('#batchClear').addEventListener('click', () => { S.taskSel.clear(); renderTasks(); });
  // 手机端多选框默认隐藏，批量操作从工具栏进入，退出时清掉已选，免得留着看不见的选择集
  $('#batchMode').addEventListener('click', () => {
    S.batchMode = !S.batchMode;
    if (!S.batchMode) S.taskSel.clear();
    renderTasks();
  });

  async function batchAction(action) {
    const ids = [...S.taskSel];
    if (!ids.length) return;
    if (action === 'delete' && !confirm(`确定删除选中的 ${ids.length} 个任务？此操作不可撤销。`)) return;
    try {
      const r = await api('/api/tasks/batch', { method: 'POST', body: { action, ids } });
      toast(`已${action === 'enable' ? '启用' : action === 'disable' ? '停用' : '删除'} ${r.affected} 个任务`);
      S.taskSel.clear();
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function pinTask(id) {
    try {
      await api(`/api/tasks/${id}/pin`, { method: 'POST' });
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---- 拖动排序 ---- */

  // 筛选栏顺序属于「这台设备看着顺眼」的偏好，存 localStorage，不占服务端设置
  applySortOrder($('#taskFilter'), 'cronhub.sort.taskFilter');
  applySortOrder($('#inboxFilter'), 'cronhub.sort.inboxFilter');

  // 任务列表：长按卡片拖动，顺序直接落库（换设备、换浏览器都一样）
  enableLongPressSort($('#taskList'), {
    itemSel: '.task',
    ignoreSel: 'button,input,label',
    canSwap: (a, b) => a.dataset.group === b.dataset.group,
    onDrop: reorderTasks,
  });
  enableLongPressSort($('#taskFilter'), {
    itemSel: 'button',
    axis: 'x',
    onDrop: (keys) => saveSortOrder('cronhub.sort.taskFilter', keys),
  });
  enableLongPressSort($('#inboxFilter'), {
    itemSel: 'button',
    axis: 'x',
    onDrop: (keys) => saveSortOrder('cronhub.sort.inboxFilter', keys),
  });

  async function reorderTasks(keys) {
    /*
     * 拖到的可能只是「筛选后的那一小部分」。
     * 直接把 keys 当成全量顺序发给后端，被筛掉的任务会被甩到末尾；
     * 所以这里把新顺序按位填回原列表的可见槽位，隐藏的任务留在原处不动。
     */
    const visible = new Set(keys);
    let k = 0;
    const ids = S.data.tasks.map((t) => (visible.has(t.id) ? keys[k++] : t.id));
    const map = new Map(S.data.tasks.map((t) => [t.id, t]));
    S.data.tasks = ids.map((id) => map.get(id)).filter(Boolean);
    renderTasks();
    try {
      await api('/api/tasks/reorder', { method: 'POST', body: { ids } });
    } catch (err) {
      toast('新顺序没保存住：' + err.message, 'err');
      await load();
    }
  }

  $('#taskFilter').addEventListener('click', (e) => {
    if (Date.now() - S.lastSortAt < 500) return;
    const b = e.target.closest('button');
    if (!b) return;
    // 分段控件尾部的「执行日志」是动作按钮，不参与筛选
    if (b.dataset.act === 'tasklogs') { openTaskLogs(null); return; }
    S.taskFilter = b.dataset.filter;
    $$('#taskFilter button').forEach((x) => x.classList.toggle('is-active', x === b));
    renderTasks();
  });

  // 与日志搜索一致加 200ms 防抖：任务多时每敲一个键就全量重建列表会明显卡顿
  let taskSearchTimer = null;
  $('#taskSearch').addEventListener('input', (e) => {
    S.taskQuery = e.target.value.trim();
    clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(renderTasks, 200);
  });

  // 通知
  $('#inboxFilter').addEventListener('click', (e) => {
    if (Date.now() - S.lastSortAt < 500) return;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'tasklogs') { openTaskLogs(null); return; }
    S.inboxFilter = b.dataset.filter;
    $$('#inboxFilter button').forEach((x) => x.classList.toggle('is-active', x === b));
    renderInbox();
  });

  $('#markAllRead').addEventListener('click', async () => {
    await api('/api/notifications/read', { method: 'POST', body: {} });
    await load();
    toast('已全部标记为已读');
  });

  $('#clearInbox').addEventListener('click', async () => {
    if (!confirm('确定清空所有通知？')) return;
    await api('/api/notifications', { method: 'DELETE' });
    await load();
    toast('通知已清空');
  });

  $('#inbox').addEventListener('click', async (e) => {
    /*
     * 「原文与依据」：把 AI 之前的正文和它实际读到的接口材料一起展开在下面。
     * 用户判断播报有没有抄错数，只能靠逐条对照。
     */
    const rw = e.target.closest('[data-raw]');
    if (rw) {
      e.stopPropagation();
      const n = (S.data.notifications || []).find((x) => x.id === rw.dataset.raw);
      const box = rw.parentElement && rw.parentElement.querySelector('.inbox-raw');
      if (n && box) {
        box.hidden = !box.hidden;
        box.textContent = n.rawBody || '';
        rw.textContent = box.hidden ? '原文与依据' : '收起';
      }
      return;
    }
    // 死信重放：链路在 /api/sms 下，需要管理员二次认证（复用同一个口令弹窗）
    const rp = e.target.closest('[data-replay]');
    if (rp) {
      e.stopPropagation();
      const okAdmin = await smsEnsureAdmin();
      if (!okAdmin) return;
      rp.disabled = true;
      rp.textContent = '重放中…';
      try {
        const r = await fetch('/api/sms/dead-letters/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ id: rp.dataset.replay }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          toast(data.message || '已重放');
          await load();
        } else {
          toast(data.error || '重放失败', 'warn');
          rp.disabled = false;
          rp.textContent = '重放这条';
        }
      } catch (err) {
        toast('重放失败：' + err.message, 'err');
        rp.disabled = false;
        rp.textContent = '重放这条';
      }
      return;
    }
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const n = S.data.notifications.find((x) => x.id === item.dataset.id);
    if (!n || n.read) return;
    await api('/api/notifications/read', { method: 'POST', body: { id: n.id } });
    await load();
  });

  $('#tlClear').addEventListener('click', async () => {
    if (!confirm('确定清空所有任务的执行记录？系统日志不受影响。')) return;
    await api('/api/logs', { method: 'DELETE' });
    $('#taskLogModal').hidden = true;
    await load();
    toast('执行记录已清空');
  });

  // 设置
  $('#saveWebhook').addEventListener('click', async () => {
    const url = $('#whUrl').value.trim();
    const isNm = $('#whFormat').value === 'notifyme';
    const enabled = $('#whEnabled').checked;
    // NotifyMe 的网关能按凭据类型推导，地址允许留空；其他格式必须有地址
    if (enabled && !url && !isNm) { toast('启用 Webhook 需要填写地址', 'warn'); return; }
    if (isNm) {
      const u = $('#whUuid').value.trim();
      const f = $('#whFcm').value.trim();
      if (u && f) { toast('UUID 与 FCM token 只填一个，混填会报 invalid UUID', 'warn'); return; }
      const saved = $('#whUuid').dataset.hasSecret === '1' || $('#whFcm').dataset.hasSecret === '1';
      if (enabled && !u && !f && !saved) { toast('NotifyMe 需要填 UUID 或 FCM token（二选一）', 'warn'); return; }
    }
    const ok = await persistChannel('webhook', 'Webhook 设置已保存');
    if (ok) { renderChannelTabs(); await load(); }
  });
  $('#whFormat').addEventListener('change', syncWhTokenHint);
  // 点击动作换了，目标值字段的标签/提示要跟着换；旧预览串就不再有效，先收起来
  if ($('#whActionType')) {
    $('#whActionType').addEventListener('change', () => {
      syncWhTokenHint();
      if ($('#whPreview')) { $('#whPreview').hidden = true; $('#whPreview').textContent = ''; }
    });
  }
  if ($('#whPrevBtn')) $('#whPrevBtn').addEventListener('click', previewNmPayload);
  if ($('#fNmActionType')) $('#fNmActionType').addEventListener('change', syncNmTaskBlock);
  // 开始手输就清掉「已保存」标记，提示语回到「填新值」语义
  for (const sel of ['#whToken', '#whUuid', '#whFcm']) {
    const box = $(sel);
    if (!box) continue;
    box.addEventListener('input', () => {
      if (box.value) box.dataset.hasSecret = '';
      syncWhTokenHint();
    });
  }
  $('#testWebhook').addEventListener('click', (e) => testChannel('webhook', e.currentTarget));

  $('#saveSms').addEventListener('click', async () => {
    const ok = await persistChannel('sms', '短信通道设置已保存');
    if (!ok) return;
    // 分级 / 字数 / 操作链接是设备级设置（与实例无关），单独存进 settings.sms
    await saveSettings({
      sms: {
        minLevel: $('#smsMinLevel').value === 'all' ? 'all' : 'important',
        maxChars: Number($('#smsMaxChars').value) || 134,
        actionLink: $('#smsActionLink').checked,
      },
    });
    renderChannelTabs();
    await load();
    renderSmsPreview();
    loadSmsState();
  });
  $('#testSms').addEventListener('click', (e) => testChannel('sms', e.currentTarget));
  ['#smsMinLevel', '#smsMaxChars'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', renderSmsPreview);
  });
  const alEl = $('#smsActionLink');
  if (alEl) alEl.addEventListener('change', renderSmsPreview);
  const resumeEl = $('#smsResumeBtn');
  if (resumeEl) {
    resumeEl.addEventListener('click', async () => {
      const ok = await saveSettings({ sms: { optOut: false, mutedUntil: 0 } }, '已恢复短信接收');
      if (ok) { await load(); loadSmsState(); }
    });
  }

  /*
   * 短信网关与中转页面已下线（导航入口与整页都已移除）。
   * 控件不存在时整段跳过：否则 addEventListener 会抛 TypeError，
   * 把后面环境变量等无关初始化一起拖死。
   */
  if ($('#saveGateway')) {
  // ---- 短信网关 ----
  $('#saveGateway').addEventListener('click', async () => {
    const ok = await saveSettings(
      { gatewaySms: { enabled: $('#gwEnabled').checked, token: $('#gwToken').value.trim() } },
      '短信网关设置已保存'
    );
    if (ok) { await load(); updateGatewaySnippet(); }
  });
  $('#gwEnabled').addEventListener('change', updateGatewaySnippet);
  $('#gwToken').addEventListener('input', () => {
    // 用户开始手输 = 要替换，此时别再提示「已保存」
    if ($('#gwToken').value) $('#gwToken').dataset.hasSecret = '';
    updateGatewaySnippet();
  });
  bindRevealButton('#gwReveal', '#gwToken', ['gatewaySms.token'], '查看网关令牌需要管理口令');
  $('#gwRegenToken').addEventListener('click', () => {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    $('#gwToken').value = 'gw_' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
    updateGatewaySnippet();
    toast('已生成新令牌，点「保存」后生效');
  });
  $('#gwCopyToken').addEventListener('click', async () => {
    let t = $('#gwToken').value.trim();
    // 输入框空着但服务端有令牌（掩码不回填）：先换一次明文再复制
    if (!t && $('#gwToken').dataset.hasSecret === '1') {
      const vals = await revealSecret(['gatewaySms.token'], '复制网关令牌需要管理口令');
      if (!vals) return;
      t = String(vals['gatewaySms.token'] || '');
      $('#gwToken').value = t;
    }
    if (!t) { toast('还没有令牌', 'warn'); return; }
    try { await navigator.clipboard.writeText(t); toast('令牌已复制'); } catch { toast('复制失败，请手动选择', 'warn'); }
  });
  $('#gwCopyUrl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#gwUrl').value); toast('调用地址已复制'); } catch { toast('复制失败，请手动选择', 'warn'); }
  });
  $('#gwTest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '发送中…';
    try {
      const r = await api('/api/gateway-sms/test', { method: 'POST' });
      if (!r.ok && r.authPageUrl) {
        toast('短信授权已过期：去 设置 → 短信通知 点「凭据检查 / 重新授权」', 'err');
      } else {
        toast(r.message || (r.ok ? '自测通过' : '自测失败'), r.ok ? undefined : 'err');
      }
      loadGatewayLog();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  }

  if ($('#srEnabled')) {
  // ---- 短信转发中转（总览控制项） ----
  $('#srEnabled').addEventListener('change', async (e) => {
    const ok = await saveSettings({ smsRelay: { enabled: e.target.checked } },
      e.target.checked ? '短信转发已启用' : '短信转发已停用');
    if (ok) await load();
  });
  $('#srPush').addEventListener('change', (e) => {
    saveSettings({ smsRelay: { pushNotify: e.target.checked } },
      e.target.checked ? '收到转发将推送到手机' : '收到转发只记录不推送');
  });
  $('#srHide').addEventListener('change', async (e) => {
    renderRelayList();
    renderRelayInbox();
    await saveSettings({ smsRelay: { hideContent: e.target.checked } },
      e.target.checked ? '已隐藏转发内容' : '已显示转发内容');
  });
  // 中转通知中心：点击显示内容；未读的顺便标记已读
  $('#relayInbox').addEventListener('click', async (e) => {
    const item = e.target.closest('.relay-item');
    if (!item) return;
    const c = item.querySelector('.relay-content');
    const n = (S.data.notifications || []).find((x) => x.id === item.dataset.ntf);
    if (c && c.classList.contains('is-masked') && n) {
      c.classList.remove('is-masked');
      c.textContent = n.body || '';
    } else if (c && $('#srHide').checked && n) {
      c.classList.add('is-masked');
      c.textContent = `已隐藏 · ${(n.body || '').length} 字（点击显示）`;
    }
    if (n && !n.read) {
      try {
        await api('/api/notifications/read', { method: 'POST', body: { id: n.id } });
        n.read = true;
        item.classList.remove('is-unread');
        renderRelayStats((S.data.settings && S.data.settings.smsRelay) || {});
      } catch { /* 静默 */ }
    }
  });
  $('#srLog').addEventListener('click', (e) => {
    const item = e.target.closest('.relay-item');
    if (!item) return;
    const entry = (S.relayEntries || []).find((x) => x.id === item.dataset.id);
    if (!entry) return;
    const c = item.querySelector('.relay-content');
    if (c.classList.contains('is-masked')) {
      c.classList.remove('is-masked');
      c.textContent = entry.content;
    } else if ($('#srHide').checked) {
      c.classList.add('is-masked');
      c.textContent = `已隐藏 · ${entry.content.length} 字（点击显示）`;
    }
  });
  $('#srCopyUrl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#srUrl').value); toast('Webhook 地址已复制'); } catch { toast('复制失败，请手动选择', 'warn'); }
  });
  $('#srCopyToken').addEventListener('click', async () => {
    let t = $('#srToken').value;
    // 显示的是掩码串时，先换明文（否则复制出去的是打码后的垃圾）
    if ($('#srToken').dataset.hasSecret === '1' || isMaskedVal(t)) {
      const vals = await revealSecret(['smsRelay.token'], '复制中转令牌需要管理口令');
      if (!vals) return;
      t = String(vals['smsRelay.token'] || '');
      if (!t) { toast('还没有令牌，先点「重新生成」', 'warn'); return; }
      $('#srToken').value = t;
      $('#srToken').dataset.hasSecret = '';
      $('#srUrl').value = smsRelayBaseUrl() + (smsRelayBaseUrl().includes('?') ? '&' : '?') + 'token=' + t;
    }
    try { await navigator.clipboard.writeText(t); toast('Token 已复制'); } catch { toast('复制失败，请手动选择', 'warn'); }
  });
  $('#srRegen').addEventListener('click', async () => {
    if (!confirm('重新生成后，手机 SmsForwarder 里的旧 Token 立即失效，需要重新配置。确定？')) return;
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const token = 'sr_' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ok = await saveSettings({ smsRelay: { enabled: true, token } }, '已生成新 Token 并启用');
    if (ok) await load();
  });
  $('#srClear').addEventListener('click', async () => {
    if (!confirm('确定清空所有转发记录？')) return;
    await api('/api/sms-relay/log', { method: 'DELETE' });
    S.relayEntries = [];
    renderRelayList();
    toast('转发记录已清空');
  });

  }

  // ---- 环境变量（青龙面板式） ----
  $('#envAdd').addEventListener('click', () => {
    const key = $('#envKey').value.trim().toUpperCase().replace(/[^\w]/g, '');
    const value = $('#envVal').value;
    if (!key) { toast('请填写变量名（字母/数字/下划线）', 'warn'); return; }
    const list = envVarsFromUI();
    if (list.some((v) => v.key === key)) { toast(`变量 ${key} 已存在，请直接在列表中修改`, 'warn'); return; }
    list.push({ key, value, note: $('#envNote').value.trim(), enabled: true });
    S.data.settings.envVars = list;
    renderEnvVars();
    $('#envKey').value = ''; $('#envVal').value = ''; $('#envNote').value = '';
    toast(`已添加 ${key}，点「保存变量」生效`);
  });
  $('#envTable').addEventListener('click', async (e) => {
    const eye = e.target.closest('[data-eye]');
    const del = e.target.closest('[data-del]');
    const list = envVarsFromUI();
    if (eye) {
      const i = Number(eye.dataset.eye);
      const val = list[i];
      if (!val) return;
      const span = $('#envTable').querySelector(`.env-row[data-i="${i}"] .env-val`);
      if (span.dataset.shown === '1') {
        span.textContent = val.enabled ? '••••••' : '(已停用)';
        span.dataset.shown = '';
        return;
      }
      /*
       * 变量值在服务端也是掩码下发的（{{ACCESS_TOKEN}} 这类占位符的真值就是凭据），
       * 所以「显示」= 当场输口令换一次明文，换完直接摊在行内，不再二次下发。
       */
      if (isMaskedVal(val.value)) {
        toast('变量值已加密，正在请求明文…');
        const vals = await revealSecret([`envVars.${val.key}`], `查看变量 ${val.key} 需要管理口令`);
        if (!vals) return;
        const real = String(vals[`envVars.${val.key}`] || '');
        val.value = real;
        S.data.settings.envVars = list;
        span.textContent = real || '(空)';
        span.dataset.shown = '1';
        return;
      }
      span.textContent = val.value || '(空)';
      span.dataset.shown = '1';
    }
    if (del) {
      const i = Number(del.dataset.del);
      if (!confirm(`删除变量 ${list[i].key}？`)) return;
      list.splice(i, 1);
      S.data.settings.envVars = list;
      renderEnvVars();
      toast('已删除，点「保存变量」生效');
    }
  });
  $('#envTable').addEventListener('change', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (!tg) return;
    const i = Number(tg.dataset.toggle);
    const list = envVarsFromUI();
    list[i].enabled = tg.checked;
    S.data.settings.envVars = list;
    renderEnvVars();
  });
  $('#saveEnv').addEventListener('click', async () => {
    const ok = await saveSettings({ envVars: envVarsFromUI() }, '环境变量已保存');
    if (ok) await load();
  });

  // ---- AI 通知优化 ----
  $('#aiProvider').addEventListener('change', () => {
    const preset = AI_PROVIDERS[$('#aiProvider').value];
    if (preset) {
      $('#aiBaseUrl').value = preset.baseUrl;
      $('#aiModel').value = preset.model;
    }
  });
  $('#aiFetchModels').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const list = $('#aiModelList');
    if (!list.hidden) { list.hidden = true; return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '获取中…';
    try {
      const r = await api('/api/ai/models');
      if (!r.models || !r.models.length) { toast('该接口未返回模型列表', 'warn'); return; }
      list.hidden = false;
      list.innerHTML = r.models.map((m) =>
        `<div class="ai-model-item" data-m="${esc(m)}">${esc(m)}</div>`
      ).join('');
      list.querySelectorAll('.ai-model-item').forEach((el) => {
        el.addEventListener('click', () => {
          $('#aiModel').value = el.dataset.m;
          list.hidden = true;
          toast('已选择模型：' + el.dataset.m);
        });
      });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
  $('#saveAi').addEventListener('click', async () => {
    const apiKey = ($('#aiApiKey').value || '').trim();
    const isMasked = !apiKey || apiKey.includes('…') || apiKey === '••••';
    const ok = await persistChannel('ai', isMasked ? 'AI 设置已保存（Key 未改动）' : 'AI 设置已保存');
    if (ok) { renderChannelTabs(); await load(); }
  });
  $('#testAi').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '测试中…';
    try {
      const r = await api('/api/ai/test', { method: 'POST' });
      toast(r.message || 'AI 连通正常');
    } catch (err) {
      toast('AI 测试失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('#smsDiag').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = $('#smsAuthState');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '探测中…';
    box.textContent = '正在探测 DNS 与 TCP 连通性…';
    try {
      const d = await api('/api/sms/diag');
      const rows = (d.targets || []).map((t) => {
        const where = t.target + (t.port === 443 ? '' : ':' + t.port);
        return t.ok
          ? `<li>✅ ${esc(where)} 可连接（${t.ms}ms）</li>`
          : `<li>❌ ${esc(where)} <strong>${esc(t.code || '失败')}</strong>（${t.ms}ms）</li>`;
      }).join('');
      const gateway = (d.targets || []).find((t) => t.target === d.host && t.port === 443);
      const authOk = (d.targets || []).some((t) => t.target === 'idaas.cmpassport.com' && t.ok);
      const netOk = (d.targets || []).some((t) => t.target === 'www.baidu.com' && t.ok);
      let verdict = '';
      if (gateway && !gateway.ok && netOk) {
        verdict = authOk
          ? '结论：本服务器出网正常，授权服务也通，<strong>只有短信发送网关拒绝本服务器的连接</strong>（IP 层拦截）。短信无法从这个云端环境发出，代码侧无法绕过。'
          : '结论：本服务器连不上短信发送网关，且授权服务也不通。';
      } else if (gateway && gateway.ok) {
        const tlsBaiduOk = d.tls && d.tls.baidu && d.tls.baidu.ok;
        const tlsGwOk = d.tls && d.tls.gateway && d.tls.gateway.ok;
        if (!tlsGwOk && tlsBaiduOk) {
          verdict = '结论：TCP 能连通，但 <strong>TLS 握手到网关被掐断</strong>（对照：百度的 TLS 正常）。'
            + '这是链路对本服务器出口 IP 的针对性拦截，发送请求根本到不了平台 —— 属于环境级阻断，代码侧无法绕过。';
        } else if (!tlsGwOk && !tlsBaiduOk) {
          verdict = '结论：所有 HTTPS 直连的 TLS 握手都被掐断（含百度对照）。'
            + '本环境要求出网走代理，而短信子进程是直连 —— 请把诊断结果发给维护者处理代理配置。';
        } else {
          verdict = '结论：网关可连接。若仍发送失败，请看下方 HTTP 返回。';
        }
      }
      const tv = d.tokenState || {};
      const direct = d.direct || {};
      const tls = d.tls || {};
      const tlsRow = (name, v) => (v && (v.ok || v.error))
        ? `<li>${v.ok ? '✅' : '❌'} ${name}${v.ok ? ' TLS 握手成功（HTTP ' + v.status + '）' : ' TLS 握手失败：' + esc(v.error || '')}（${v.ms}ms）</li>`
        : '';
      const proxyKeys = Object.keys(d.proxyEnv || {});
      box.innerHTML =
        `<div style="margin-bottom:6px">DNS：${esc((d.dns || []).map((x) => x.address + '/IPv' + x.family).join('、') || '解析失败')}</div>` +
        `<ul style="margin:0 0 6px;padding-left:2px;list-style:none;line-height:1.8">${rows}</ul>` +
        (tls.gateway || tls.baidu
          ? `<div style="margin-bottom:2px">TLS 对照：</div><ul style="margin:0 0 6px;padding-left:2px;list-style:none;line-height:1.8">${tlsRow('短信网关', tls.gateway)}${tlsRow('百度（对照）', tls.baidu)}</ul>`
          : '') +
        (proxyKeys.length
          ? `<div style="margin-bottom:6px">出网代理环境变量：<code style="font-size:11px">${esc(proxyKeys.map((k) => k + '=' + d.proxyEnv[k]).join('；'))}</code></div>`
          : '') +
        (tv.resultCode && tv.resultCode !== 'SKIPPED'
          ? `<div style="margin-bottom:6px">取令牌：<strong>${esc(tv.resultCode)}</strong> ${esc(tv.resultDesc || '')}</div>`
          : '') +
        (direct.status || direct.error
          ? `<div style="margin-bottom:6px">直连探测：${direct.status ? ('HTTP ' + direct.status + '，' + (direct.len || 0) + ' 字节') : esc(direct.error || '')}${direct.body ? '<br><code style="font-size:11px">' + esc(direct.body.slice(0, 120)) + '</code>' : ''}</div>`
          : '') +
        (verdict ? `<div>${verdict}</div>` : '');
    } catch (err) {
      box.textContent = '❌ 诊断失败：' + (err.message || err);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  /*
   * 唯一的短信管理入口。
   * 它本身不消耗任何配额、不改任何配置，所以可以常驻显示；
   * 而「重新授权 / 吊销」这类有真实副作用的按钮，一律等认证通过后才出现。
   */
  const adminBtn = $('#smsAdminBtn');
  if (adminBtn) {
    adminBtn.addEventListener('click', async () => {
      const isAdmin = !!(S.smsState && S.smsState.canManage);
      if (isAdmin) {
        try {
          await fetch('/api/sms/admin-lock', { method: 'POST', credentials: 'same-origin' });
          toast('已退出管理员模式，短信操作重新上锁');
        } catch {
          toast('退出失败，请刷新页面', 'err');
        }
        await loadSmsState();
        return;
      }
      await smsEnsureAdmin();
    });
  }

  /*
   * 扫码授权：一个按钮走完全程。
   *
   * 以前是「申请链接 → 手点『我已扫码』→ 再检测」三步，走到第二步之后
   * 只要有任何一次自动刷新盖掉了提示，用户就会以为按钮坏了。现在的顺序：
   *   1) 先问一次「现在通不通」（只读，不产生链接）
   *   2) 不通才申请二维码
   *   3) 挂上二维码后每 6 秒自动检测，扫完自动变绿，不用点任何东西
   * 本地已有二维码时再点按钮只做检测，不会把手里那张换掉。
   */
  let smsPollTimer = null;
  function stopSmsPoll() {
    if (smsPollTimer) { clearTimeout(smsPollTimer); smsPollTimer = null; }
  }

  function smsAuthPanel(cls, html) {
    const box = $('#smsAuthResult');
    if (!box) return null;
    box.hidden = false;
    box.className = 'sms-auth-result' + (cls ? ' ' + cls : '');
    box.innerHTML = html;
    return box;
  }

  function smsAuthDone(msg) {
    stopSmsPoll();
    const box = smsAuthPanel('is-ok', '✅ ' + esc(msg));
    if (box) delete box.dataset.hasQr;
    toast(msg);
  }

  function smsAuthAppCredMissing(r) {
    stopSmsPoll();
    const miss = Array.isArray(r.missing) && r.missing.length ? r.missing.join(' / ') : 'code / kid / strategyId';
    smsAuthPanel('is-err',
      `❌ 不是网关问题：<strong>应用凭据缺失（${esc(miss)}）</strong><br>`
      + '<div style="margin-top:6px">保险库 app 分区里没有平台分配的应用凭据，所以取令牌时 clientId 为空。这一项丢了不会自己恢复，扫码也救不回来。</div>'
      + '<div style="margin-top:6px">修复：<code>POST /api/sms/bootstrap</code> 写入 '
      + '<code>{"app":{"code":"…","kid":"…","strategyId":"…"}}</code>，然后回来再点一次「扫码授权」。</div>');
    toast('应用凭据缺失，需先写回 code/kid/strategyId', 'err');
  }

  /** 挂上二维码后自动盯着状态：用户扫完即可，不需要回来点确认 */
  function startSmsPoll() {
    stopSmsPoll();
    let n = 0;
    const startedAt = Date.now();
    /*
     * 退避轮询：每 6 秒一次太浪费——每次检测都是一次真实 preAuth。
     * 按 6→8→10→12→14→16→18→20→24 秒递进，约 2 分钟 9 次。
     *
     * 但 2 分钟不够：真实情况是「拿手机、开相机、扫码、在手机上点确认」，
     * 中间还要输验证码，5 分钟很常见。窗口一关，用户扫完回来页面还写着
     * 「没检测到授权」——这就是「我明明授权了，怎么显示没有」的由来。
     * 所以窗口到 2 分钟不结束，只是转入 30 秒一次的慢心跳，再撑 6 分钟。
     */
    const GAPS = [6, 8, 10, 12, 14, 16, 18, 20, 24];
    const SLOW_GAP = 30;
    const SLOW_TIMES = 12;      // 慢心跳 12 次 ≈ 6 分钟，总计约 8 分钟
    const tick = async () => {
      n++;
      const tip = document.querySelector('#smsAuthResult [data-poll-tip]');
      try {
        const r = await authCheckUrl();
        if (r && r.valid) { smsAuthDone(r.message || '授权已生效'); await loadSmsState(); return; }
        if (r && r.appCredMissing) { smsAuthAppCredMissing(r); return; }
        if (r && r.stale) {
          /*
           * 平台对「链接已发、还没扫」的设备也返回 130088，跟「真失效」同一个码。
           * 所以不能一看到就判死：刚生成的头 60 秒一律当「还没扫」继续等，
           * 超过 60 秒才提示可能过期（仍不改判定，用户重扫一次照样能成）。
           */
          const age = Math.round((Date.now() - startedAt) / 1000);
          if (age < 60) {
            if (tip) tip.textContent = `已等待 ${age} 秒 · 还没检测到你扫码，扫完会自动变绿`;
            return;
          }
          // 超过 60 秒也不停：延迟生效很常见，继续慢心跳，只是在提示里说明可能过期
          if (tip) tip.textContent = `已等待 ${age} 秒 · 还没检测到（若二维码已过期，点「重新生成二维码」）· 仍在自动检测`;
          return;
        }
        if (tip) {
          tip.textContent = r && r.blocked
            ? (r.message || '通道熔断中，稍后再试')
            : `已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒 · 扫码完成后这里会自动变绿`;
        }
      } catch { /* 单次检测失败不影响继续等 */ }
      if (n >= GAPS.length + SLOW_TIMES) {
        stopSmsPoll();
        if (tip) {
          tip.innerHTML = `已等待约 ${Math.round((Date.now() - startedAt) / 60000)} 分钟，仍没检测到授权。`
            + '如果你已经在手机上完成验证，点下面这个按钮再问一次（不会换掉二维码、也不消耗验证码）；'
            + '也可以点「重新生成二维码」重来。'
            + '<div class="sms-auth-acts"><button class="btn btn--ghost btn--xs" data-auth-recheck>再检测一次</button></div>';
        }
        return;
      }
      const next = n < GAPS.length ? GAPS[n] : SLOW_GAP;
      smsPollTimer = setTimeout(tick, next * 1000);
    };
    smsPollTimer = setTimeout(tick, GAPS[0] * 1000);
  }

  /**
   * 只再问一次「现在通了没」，不申请新码、不清本地 uuid、不烧验证码。
   * 手机端验证有时会延迟几分钟才在平台侧落库，用户回到电脑点一下就够。
   */
  async function smsRecheckNow() {
    const tip = document.querySelector('#smsAuthResult [data-poll-tip]');
    if (tip) tip.textContent = '正在重新检测…';
    try {
      const r = await authCheckUrl();
      if (r && r.valid) { smsAuthDone(r.message || '授权已生效'); await loadSmsState(); return; }
      if (r && r.appCredMissing) { smsAuthAppCredMissing(r); return; }
      if (tip) {
        const why = r && r.stale
          ? '平台仍没有记录到这次扫码，二维码可能已过期。'
          : `仍未检测到：${(r && r.message) || '手机端可能还没完成验证'}。`;
        tip.innerHTML = esc(why)
          + '<div class="sms-auth-acts">'
          + '<button class="btn btn--ghost btn--xs" data-auth-recheck>再检测一次</button>'
          + '<button class="btn btn--ghost btn--xs" data-auth-renew>重新生成二维码</button>'
          + '</div>';
      }
    } catch (err) {
      if (!smsHandleAuthError(err) && tip) tip.textContent = '检测失败：' + (err.message || err);
    }
  }

  /*
   * 按号授权：点号码行里的「扫码授权」时记住是哪个号，
   * 之后的 auth-link / auth-check 全部带上 ?binding= ——
   * 两个号各自扫码，检测不能落到另一个号上。
   */
  let smsAuthBindingId = '';
  const authQs = () => (smsAuthBindingId ? '?binding=' + encodeURIComponent(smsAuthBindingId) : '');
  const authCheckUrl = () => '/api/sms/auth-check' + authQs();
  const authLinkUrl = () => '/api/sms/auth-link' + authQs();

  async function runSmsAuth(bindingId) {
    smsAuthBindingId = typeof bindingId === 'string' ? bindingId : '';
    const btn = $('#smsAuthBtn');
    const box = $('#smsAuthResult');
    const targetLabel = smsAuthBindingId || '主号码';
    if (!await smsEnsureAdmin()) return;
    stopSmsPoll();
    const hasQr = !!(box && box.dataset.hasQr === '1');
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
    smsAuthPanel('is-busy', `正在检查「${esc(targetLabel)}」的授权状态…`);
    try {
      const c = await authCheckUrl();
      if (c && c.valid) { smsAuthDone(c.message || '授权已生效'); await loadSmsState(); return; }
      if (c && c.appCredMissing) { smsAuthAppCredMissing(c); return; }

      if (hasQr) {
        // 手里已经有二维码：继续等它变绿，不重新申请（重新申请会让手里那张作废）
        smsAuthPanel('is-busy', '还没检测到扫码授权。<div class="sms-auth-warn" data-poll-tip>开始自动检测…</div>');
        const b2 = $('#smsAuthResult');
        if (b2) b2.dataset.hasQr = '1';
        startSmsPoll();
        return;
      }

      if (btn) btn.textContent = '申请中…';
      smsAuthPanel('is-busy', '正在申请二维码（会消耗一条验证码，通常 1~5 秒）…');
      const r = await authLinkUrl();
      const warn = r.warning ? `<div class="sms-auth-warn">💡 ${esc(r.warning)}</div>` : '';
      if (r.appCredMissing) { smsAuthAppCredMissing(r); return; }
      if (!r.ok) {
        smsAuthPanel('is-err', `❌ 申请失败：${esc(r.error || '未知错误')}${warn}`);
        toast('授权申请失败：' + (r.error || '未知错误'), 'err');
        return;
      }
      if (r.valid) { smsAuthDone(r.message || '凭据有效，无需重新扫码'); await loadSmsState(); return; }

      const link = esc(r.authPageUrl);
      const img = r.qrUrl ? `<img class="sms-auth-qr" src="${esc(r.qrUrl)}" alt="授权二维码">` : '';
      smsAuthPanel('',
        '<strong>用手机扫码完成验证</strong>'
        + img
        + `<a href="${link}" target="_blank" rel="noopener">${link}</a>`
        + '<div class="sms-auth-warn" data-poll-tip>扫码完成后这里会自动变绿，不用点任何按钮。</div>'
        + '<div class="sms-auth-acts">'
        + '<button class="btn btn--ghost btn--xs" data-auth-renew>重新生成二维码</button>'
        + `<a class="btn btn--ghost btn--xs" href="${link}" target="_blank" rel="noopener">手机上打开</a>`
        + '</div>'
        + warn);
      const b = $('#smsAuthResult');
      if (b) b.dataset.hasQr = '1';
      try { b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* 老浏览器 */ }
      toast('二维码已生成，扫码即可');
      startSmsPoll();
    } catch (err) {
      if (!smsHandleAuthError(err)) {
        smsAuthPanel('is-err', '❌ 操作失败：' + esc(err.message || err));
        toast('操作失败', 'err');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '扫码授权'; }
    }
  }

  $('#smsAuthBtn').addEventListener('click', runSmsAuth);

  /*
   * 从手机回来就问一次。
   * 真实动作永远是「在电脑上点二维码 → 拿手机扫 → 回到电脑」，
   * 切回标签页这个瞬间才是「可能刚授权完」的时刻。此时主动探活一次，
   * 用户看到的就是自动变绿 —— 而不是先看到一句「没检测到授权」再去怀疑自己。
   * 只在「确实需要授权」或「手里挂着二维码」时探，正常状态不打扰平台。
   */
  let smsLastAutoProbe = 0;
  /**
   * 统一的一次静默探活（带节流）。
   * 为什么要节流：授权状态是「需要人去做动作」的状态，人在这期间会反复刷新页面、
   * 反复切标签页。每次刷新都打一次 preAuth 既没必要，也容易撞平台频率限制。
   * 60 秒内只问一次，跨页面的记忆放 localStorage。
   */
  async function smsProbeOnce(force) {
    if (!S.smsState || !S.smsState.canManage) return;
    let last = 0;
    try { last = Number(localStorage.getItem('cronhub_sms_probe_at')) || 0; } catch { /* 隐私模式 */ }
    if (!force && Date.now() - last < 60000) return;
    try { localStorage.setItem('cronhub_sms_probe_at', String(Date.now())); } catch { /* 隐私模式 */ }
    smsLastAutoProbe = Date.now();
    try {
      const r = await authCheckUrl();
      if (r && r.valid) {
        smsAuthDone(r.message || '授权已生效');
        await loadSmsState();
        return true;
      }
      if (r && r.appCredMissing) smsAuthAppCredMissing(r);
    } catch { /* 探活失败就等下一次触发 */ }
    return false;
  }

  async function smsAutoProbeOnReturn() {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    if (!S.smsState || !S.smsState.canManage) return;
    const cred = S.smsState.credential || {};
    const needAuth = cred.state === 'NEED_REAUTH' || cred.state === 'REVOKED';
    const box = $('#smsAuthResult');
    const hasQr = !!(box && box.dataset.hasQr === '1');
    if (!needAuth && !hasQr) return;
    if (Date.now() - smsLastAutoProbe < 45000) return;
    const got = await smsProbeOnce(false);
    if (!got && hasQr && !smsPollTimer) startSmsPoll();   // 挂着码就接着慢心跳等
  }
  document.addEventListener('visibilitychange', smsAutoProbeOnReturn);
  window.addEventListener('focus', smsAutoProbeOnReturn);

  // 「重新生成二维码」是动态插入的，用事件委托
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-auth-renew]');
    if (!b) return;
    const box = $('#smsAuthResult');
    if (box) delete box.dataset.hasQr;
    runSmsAuth();
  });

  // 「再检测一次」：只探活，不换二维码（重新生成会让手里那张作废）
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-auth-recheck]');
    if (!b) return;
    smsRecheckNow();
  });

  /* ---- 接收号码列表的动态按钮（事件委托：列表每次刷新都重建 DOM）---- */
  document.addEventListener('click', async (e) => {
    const t = e.target.closest;
    if (!t) return;

    const authBtn = e.target.closest('[data-bind-auth]');
    if (authBtn) {
      runSmsAuth(authBtn.getAttribute('data-bind-auth'));
      return;
    }

    const addBtn = e.target.closest('[data-bind-add]');
    if (addBtn) {
      if (!await smsEnsureAdmin()) return;
      const label = prompt('给新号码起个备注名（如「家人」「备用」），可留空：');
      if (label === null) return;
      try {
        const r = await api('/api/sms/bindings', { method: 'POST', body: { label } });
        if (!r.ok) { toast(r.error || '添加失败', 'err'); return; }
        toast(`已添加「${r.binding.label || r.binding.id}」，点它旁边的「扫码授权」绑定手机`);
        await loadSmsState();
      } catch (err) { toast('添加失败：' + (err.message || err), 'err'); }
      return;
    }

    const delBtn = e.target.closest('[data-bind-del]');
    if (delBtn) {
      if (!await smsEnsureAdmin()) return;
      const id = delBtn.getAttribute('data-bind-del');
      if (!confirm(`解绑号码 ${id}？\n\n该号码的授权凭据会一并删除，重新绑定需再次扫码；其它号码不受影响。`)) return;
      try {
        const r = await api('/api/sms/bindings', { method: 'DELETE', body: { binding: id } });
        if (!r.ok) { toast(r.error || '解绑失败', 'err'); return; }
        toast('已解绑 ' + id);
        await loadSmsState();
      } catch (err) { toast('解绑失败：' + (err.message || err), 'err'); }
    }
  });

  // 展开细节面板才拉发送记录（懒加载，不进 45 秒轮询）
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.classList && d.classList.contains('sms-adv') && d.open) {
      loadSmsRecords().catch(() => {});
      enrichSmsPreview().catch(() => {});
    }
  }, true);

  /** 用服务端预览接口给本地预览补风控/条数/建议（与真实发送同一份规则） */
  async function enrichSmsPreview() {
    const box = $('#smsPreviewBody');
    if (!box || !box.textContent || box.textContent === '—') return;
    try {
      const r = await api('/api/sms/preview', { method: 'POST', body: { text: box.textContent } });
      if (!r || !r.ok) return;
      const lenEl = $('#smsPreviewLen');
      if (lenEl) {
        const bits = [r.length.charCount + ' 字', '约 ' + r.length.segments + ' 条'];
        if (r.risk.level > 0) bits.push('风控·' + r.risk.levelText);
        lenEl.textContent = bits.join(' · ');
        lenEl.className = r.risk.level >= 2 ? 'hint hint--warn' : 'hint';
      }
      const tipEl = $('#smsPreviewTips');
      if (tipEl) {
        tipEl.textContent = (r.tips || []).map((t) => '💡 ' + t).join('\n');
        tipEl.hidden = !(r.tips || []).length;
      }
    } catch { /* 预览失败不碍事，本地估算还在 */ }
  }

  $('#smsResetBtn').addEventListener('click', async () => {
    if (!await smsEnsureAdmin()) return;   // 吊销比授权更狠，同样要过二次认证
    /*
     * 吊销是不可撤销的：清空本地全部凭据副本 + 状态置 REVOKED + 熔断 24 小时。
     * 二次确认必须把后果说清楚，而不是一句「确定吗」。
     */
    const yes = confirm(
      '吊销短信凭据？\n\n'
      + '· 立刻清空「用户身份」凭据（长期 / 短期两类）\n'
      + '· 应用凭据（code / kid / strategyId）保留 —— 它跟手机号授权无关，清掉就没法再取令牌\n'
      + '· 状态置为「已吊销」并熔断，期间不发任何请求\n'
      + '· 不能点按钮恢复，必须重新扫码绑定\n\n'
      + '这一步用于凭据泄露应急，不可撤销。确定继续？'
    );
    if (!yes) return;
    const box = $('#smsAuthState');
    try {
      const r = await api('/api/sms/revoke', { method: 'POST' });
      box.textContent = r.ok ? '🛑 ' + (r.message || '凭据已吊销') : '❌ ' + (r.error || '操作失败');
      await loadSmsState();
    } catch (err) {
      if (!smsHandleAuthError(err)) box.textContent = '❌ 操作失败：' + (err.message || err);
    }
  });

  // 清空发送记录（只清记录，不碰凭据与配额）
  const recClear = $('#smsRecordsClear');
  if (recClear) {
    recClear.addEventListener('click', async () => {
      if (!await smsEnsureAdmin()) return;
      if (!confirm('清空全部发送记录？\n\n只影响历史展示，不影响凭据、配额与发送。')) return;
      try {
        await api('/api/sms/records', { method: 'DELETE' });
        smsRecordsLoadedAt = 0;
        await loadSmsRecords(true);
        toast('发送记录已清空');
      } catch (err) { toast('清空失败：' + (err.message || err), 'err'); }
    });
  }


  $('#saveSmtp').addEventListener('click', async () => {
    const ok = await persistChannel('email', '邮件设置已保存');
    if (ok) { renderChannelTabs(); await load(); }
  });
  $('#testSmtp').addEventListener('click', (e) => testChannel('email', e.currentTarget));

  /* ---- 保险一：自探活 ---- */
  const kaInput = $('#keepAliveUrl');
  if (kaInput) {
    kaInput.addEventListener('click', () => kaInput.select());
    kaInput.addEventListener('input', () => { kaInput.dataset.userEdited = '1'; });
  }
  const copyKa = $('#copyKeepAlive');
  if (copyKa) {
    copyKa.addEventListener('click', async () => {
      const url = $('#keepAliveUrl').value;
      try {
        await navigator.clipboard.writeText(url);
        toast('探活地址已复制');
      } catch {
        // 剪贴板权限被拒时退回手动选中
        const inp = $('#keepAliveUrl');
        inp.focus();
        inp.select();
        toast('请按 Ctrl+C 复制');
      }
    });
  }

  /* ---- 保活：统一走 /api/keepalive/*，保存后立即刷新控制台 ---- */
  const saveKw = $('#saveKeepWarm');
  if (saveKw) {
    saveKw.addEventListener('click', async () => {
      const enabled = !!($('#kwEnabled') && $('#kwEnabled').checked);
      const url = ($('#keepAliveUrl') && $('#keepAliveUrl').value.trim()) || '';
      const intervalMin = Math.min(60, Math.max(1, Number($('#kwInterval') && $('#kwInterval').value) || 2));
      try {
        await api('/api/keepalive/self', { method: 'POST', body: { enabled, url, intervalMin } });
        toast(enabled ? `保险一已开启：每 ${intervalMin} 分钟自动探活` : '保险一已关闭', 'ok');
        await refreshKeep();
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        await refreshKeep();
      }
    });
  }

  const kwPingBtn = $('#kwPingNow');
  if (kwPingBtn) {
    kwPingBtn.addEventListener('click', async () => {
      kwPingBtn.disabled = true;
      const old = kwPingBtn.textContent;
      kwPingBtn.textContent = '探测中…';
      try {
        const r = await api('/api/keepwarm/ping', { method: 'POST' });
        toast((r.ok ? '探活成功：' : '探活失败：') + r.message, r.ok ? 'ok' : 'err');
        await refreshKeep();
      } catch (e) {
        toast('探活请求失败：' + e.message, 'err');
      } finally {
        kwPingBtn.disabled = false;
        kwPingBtn.textContent = old;
      }
    });
  }

  // 保险二：复制 / 测试 / 重置
  const wUrlInput = $('#wakeUrl');
  if (wUrlInput) wUrlInput.addEventListener('click', () => wUrlInput.select());

  const copyWake = $('#copyWakeUrl');
  if (copyWake) {
    copyWake.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#wakeUrl').value);
        toast('唤醒链接已复制，去 cron-job.org 建个 5 分钟的定时任务就齐了');
      } catch {
        const inp = $('#wakeUrl');
        inp.focus();
        inp.select();
        toast('请按 Ctrl+C 复制');
      }
    });
  }

  const openWake = $('#openWakeUrl');
  if (openWake) {
    openWake.addEventListener('click', async () => {
      openWake.disabled = true;
      try {
        const r = await api('/api/keepalive/wake/test', { method: 'POST' });
        toast(r.ok ? `唤醒成功（累计 ${r.count} 次 · ${r.ms}ms）` : `唤醒失败：${r.message || r.error || ''}`, r.ok ? 'ok' : 'err');
        await refreshKeep();
      } catch (e) {
        toast('请求失败：' + e.message, 'err');
      } finally {
        openWake.disabled = false;
      }
    });
  }

  const regenWake = $('#regenWake');
  if (regenWake) {
    regenWake.addEventListener('click', async () => {
      if (!confirm('重置后旧链接立刻失效，已配置好的外部定时器要换新链接。继续？')) return;
      try {
        await api('/api/wake/regen', { method: 'POST' });
        toast('唤醒令牌已重置，请复制新链接');
        await refreshKeep();
      } catch (e) {
        toast('重置失败：' + e.message, 'err');
      }
    });
  }

  // 保险三：页面心跳配置
  const savePage = $('#savePageBeat');
  if (savePage) {
    savePage.addEventListener('click', async () => {
      const enabled = !!($('#kwPageEnabled') && $('#kwPageEnabled').checked);
      const beatSec = Math.min(300, Math.max(10, Number($('#kwPageSec') && $('#kwPageSec').value) || 30));
      try {
        await api('/api/keepalive/page', { method: 'POST', body: { enabled, beatSec } });
        toast(enabled ? `页面心跳已开：每 ${beatSec} 秒` : '页面心跳已关闭', 'ok');
        await refreshKeep();
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
      }
    });
  }

  const keepRefreshBtn = $('#keepRefresh');
  if (keepRefreshBtn) {
    keepRefreshBtn.addEventListener('click', async () => {
      await load();
      await refreshKeep();
      toast('已刷新');
    });
  }

  const clearKeepLog = $('#clearKeepLog');
  if (clearKeepLog) {
    clearKeepLog.addEventListener('click', async () => {
      if (!confirm('清空保活日志？')) return;
      try {
        await api('/api/keepalive/log', { method: 'DELETE' });
        toast('保活日志已清空');
        await refreshKeep();
      } catch (e) {
        toast('清空失败：' + e.message, 'err');
      }
    });
  }

  /* ---- 可点击卡片：总览统计卡 → 对应视图（通道卡由 data-goto 委托统一处理）---- */
  $('#stats').addEventListener('click', (e) => {
    const card = e.target.closest('.stat[data-view], .stat[data-act]');
    if (!card) return;
    if (card.dataset.act === 'tasklogs') { openTaskLogs(null); return; }
    if (card.dataset.view === 'logs') resetSysFilter();
    switchView(card.dataset.view);
  });

  /* ---- 错过补跑策略：点了立即生效 ---- */
  $$('#missedPolicy input').forEach((i) => {
    i.addEventListener('change', async () => {
      if (!i.checked) return;
      const okSaved = await saveSettings(
        { missedPolicy: i.value },
        i.value === 'skip' ? '已切换：错过的任务将跳过并通知' : '已切换：错过的任务将补跑一次'
      );
      if (!okSaved) await load(); // 失败时回读真实状态，避免界面与服务端不一致
    });
  });

  /* ---- 补跑细则：改了即存，不必再点保存 ---- */
  $$('#catchupOpts input').forEach((el) => {
    el.addEventListener('change', async () => {
      const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      const okSaved = await saveSettings({
        catchup: {
          enabled: $('#cuEnabled').checked,
          windowMinutes: numOr($('#cuWindow').value, 120),
          maxPerStart: numOr($('#cuMax').value, 5),
          minGapSec: numOr($('#cuMinGap').value, 45),
          // 页面按秒填，后端按毫秒存
          jitterMaxMs: Math.round(numOr($('#cuJitter').value, 20) * 1000),
        },
      }, '补跑设置已保存');
      if (!okSaved) await load();
    });
  });

  /* ---- 凭据自动续期 ---- */
  $('#saveToken').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const rt = $('#tkRefresh').value.trim();
    if (!rt) { toast('请先填写长效令牌 refreshToken', 'warn'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '验证中…';
    try {
      const r = await api('/api/settings/token', {
        method: 'PUT',
        body: { refreshToken: rt, enabled: $('#tkEnabled').checked },
      });
      toast(r.message || '凭据已保存');
      await load();
      renderTokenStatus(r);
    } catch (err) {
      toast('验证失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('#refreshTokenBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '续期中…';
    try {
      const r = await api('/api/settings/token/refresh', { method: 'POST' });
      toast(r.message || '已续期');
      await load();
      renderTokenStatus(r);
    } catch (err) {
      toast('续期失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('#exportData').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cronhub-${keyOf(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('数据已导出');
  });

  // 管理身份验证
  $('#authLoginBtn').addEventListener('click', doLogin);
  $('#authPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#logoutBtn').addEventListener('click', doLogout);

  const skip = $('#authSkip');
  if (skip) {
    skip.addEventListener('click', async () => {
      // 开了访问控制就不能跳过；否则直接进
      if (authState.passwordRequired) {
        $('#authErr').textContent = '当前实例已开启密码访问，必须登录';
        return;
      }
      showApp();
      await load(true);
    });
  }

  const entry = $('#adminEntryBtn');
  if (entry) {
    entry.addEventListener('click', () => {
      if (document.body.classList.contains('is-admin')) {
        toast('你已经是管理员身份');
        return;
      }
      showAuth('login');
    });
  }

  const unlockBtn = $('#adminUnlock');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', async () => {
      try {
        await api('/api/admin/unlock', { method: 'POST' });
        toast('已解除登录锁定');
        loadAdmin();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  // 弹窗
  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#modal').hidden) saveTask();
  });

  $('#fType').addEventListener('click', (e) => {
    const b = e.target.closest('.type-opt');
    if (b) setFormType(b.dataset.type);
  });

  // 节奏行：切模式 / 删除 / 改表达式 / 加一条
  $('#fSchedules').addEventListener('click', (e) => {
    const modeBtn = e.target.closest('.sched-mode button');
    if (modeBtn) {
      readSchedRows();
      const i = Number(modeBtn.closest('.sched-row').dataset.i);
      S.schedRows[i].mode = modeBtn.dataset.mode;
      S.schedFocus = i;
      renderScheduleRows();
      return;
    }
    const del = e.target.closest('.sched-del');
    if (del) {
      readSchedRows();
      const i = Number(del.closest('.sched-row').dataset.i);
      if (S.schedRows.length <= 1) return;
      S.schedRows.splice(i, 1);
      S.schedFocus = Math.max(0, i - 1);
      renderScheduleRows();
    }
  });
  $('#fSchedules').addEventListener('input', (e) => {
    if (e.target.closest('.sched-cron, .sched-every, .sched-start')) updateSchedPreviews();
  });
  // select / datetime-local 在部分浏览器只发 change，单位切换要跟着刷新预览
  $('#fSchedules').addEventListener('change', (e) => {
    if (e.target.closest('.sched-unit, .sched-start')) updateSchedPreviews();
  });
  $('#fSchedules').addEventListener('focusin', (e) => {
    const row = e.target.closest('.sched-row');
    if (row) S.schedFocus = Number(row.dataset.i) || 0;
  });
  $('#addSched').addEventListener('click', () => {
    readSchedRows();
    if (S.schedRows.length >= 6) { toast('一个任务最多 6 条节奏', 'err'); return; }
    S.schedRows.push({ mode: 'cron', cron: '0 12 * * *', every: 1, unit: 'hour', startAt: '', everyMinutes: 60 });
    S.schedFocus = S.schedRows.length - 1;
    renderScheduleRows();
  });
  $('#cronPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    readSchedRows();
    const i = Math.min(S.schedFocus || 0, S.schedRows.length - 1);
    S.schedRows[i] = { ...S.schedRows[i], mode: 'cron', cron: b.dataset.cron };
    renderScheduleRows();
  });
  const sceneBox = $('#scenePresets');
  if (sceneBox) {
    sceneBox.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.scene === 'weather') applyWeatherScene();
    });
  }
  $('#fNotify').addEventListener('change', syncNotifyOpts);
  /*
   * 渠道勾选框的两个统一处理（两处 chips 共用同一段逻辑）：
   *  ① 站内通知点不掉 —— 以前用 disabled + 🔒，看着像被禁用；现在拦 change 并提示一句。
   *  ② 勾没勾 NotifyMe 决定「NotifyMe 推送选项」要不要露出来。
   */
  for (const sel of ['#fChannels', '#fNotifyChannels']) {
    const box = $(sel);
    if (!box) continue;
    box.addEventListener('change', (e) => {
      const i = e.target;
      if (!i || i.type !== 'checkbox') return;
      if (i.dataset.req === '1' && !i.checked) {
        i.checked = true;
        toast('站内通知是必选项，不能取消');
        return;
      }
      if (sel === '#fNotifyChannels') syncNmTaskBlock();
    });
  }
  $('#fAiEnabled').addEventListener('change', syncAiOpts);
  // 提示词字数实时提示 + 「看实际提示词」：后者是唯一能验证「要求有没有进提示词」的入口
  if ($('#fNotifyPrompt')) $('#fNotifyPrompt').addEventListener('input', syncAiPromptCount);
  if ($('#fAiPreviewBtn')) $('#fAiPreviewBtn').addEventListener('click', showAiPreview);
  $('#modalSave').addEventListener('click', saveTask);
}

/* ------------------------------------------------------------ 启动 */

function startClock() {
  const el = $('#clock');
  const tick = () => {
    const d = new Date();
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

bind();
startClock();

(async () => {
  /*
   * 并行发起两个请求：status 定身份，state 拉数据。
   * 开放模式下两者同时飞，省掉一次串行往返（移动/电信高 RTT 下能省几百毫秒）；
   * 密码模式下 state 会 401，api() 自动切到登录页，不影响后续登录流程。
   */
  const stateP = api('/api/state').then(
    (d) => ({ ok: true, d }),
    (err) => ({ ok: false, err })
  );
  const ok = await checkAuth();
  if (!ok) return;

  const r = await stateP;
  if (r.ok) {
    S.data = r.d;
    setSrvStatus(true);
    renderAll();
    /*
     * 记住 sharecode：网关转发时会剥掉 query，服务端自己看不到；
     * 浏览器在带 sharecode 的页面里上报一次，裸域名访问时才能拼出完整探活地址。
     */
    const scm = location.search.match(/[?&]sharecode=([^&]+)/);
    if (scm && scm[1] !== S.data.settings.sharecode) {
      api('/api/settings', { method: 'PUT', body: { sharecode: scm[1] } }).catch(() => {});
    }
  } else {
    setSrvStatus(false);
    if (!String(r.err.message || '').includes('401')) {
      toast('无法连接服务：' + r.err.message, 'err');
    }
  }
  // 倒计时/相对时间每分钟刷新一次，避免要求频繁请求
  // 后台标签页不做全量轮询/重渲染：手机锁屏后每 45 秒拉一次 /api/state（连带 5 个
  // 附属请求）纯属耗电耗流量，服务端也跟着产生访问日志。回到前台立即补一次。
  setInterval(() => {
    if (document.hidden || !S.data || $('#appRoot').hidden) return;
    renderNext();
    renderFeed();
  }, 30000);
  setInterval(() => {
    if (document.hidden || $('#appRoot').hidden) return;
    load();
  }, 45000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.data && !$('#appRoot').hidden) load();
  });
})();

/*
 * 附加保活：页面心跳。
 * 间隔与开关都由保活控制台统一管理（存在服务端 settings.keepWarm.pageBeat/pageBeatSec），
 * 页面开着时才打 /api/health —— 成本极低（不读 state、不写盘），切后台/关页面自动停。
 */
(function pageHeartbeat() {
  let lastBeat = 0;
  // 每 5 秒检查一次是否到了该探活的时刻（而不是固定 30 秒硬编码）
  setInterval(() => {
    if (document.hidden || !S.data) return;
    const pg = (S.keep && S.keep.page) || {};
    if (pg.enabled === false) return;
    const everySec = Math.max(10, Number(pg.beatSec) || 30);
    if (Date.now() - lastBeat < everySec * 1000 - 800) return;
    lastBeat = Date.now();
    fetch('/api/health?hb=' + Date.now(), { cache: 'no-store' }).catch(() => {});
  }, 5000);
})();
