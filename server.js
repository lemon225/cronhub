'use strict';
/**
 * CronHub — 在线定时任务控制中心
 * 零第三方依赖。自带 HTTP 服务、cron 解析、调度引擎、JSON 持久化、SMTP 客户端。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const net = require('node:net');
const https = require('node:https');
const dns = require('node:dns');
/*
 * 脱敏函数提到文件顶部：pushSysLog（第 386 行附近）是**所有**日志的入口，
 * 它必须能在任何调用点之前用上 scrubText —— 放在文件后半段 require 会撞上
 * const 的暂时性死区（TDZ），只能写成惰性 require，那比这样差。
 */
const { scrubText: scrubLogText } = require('./lib/credential-vault');

/* 版本标记：发布后 GET /api/health 看 build，确认云端 Node 侧跑的是不是最新代码 */
const SMS_BUILD = 'audit-batch-21';

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/*
 * 启动时把前端资源读进内存，并做一次自检。
 * 旧实现四处读盘全部静默兜底：app.min.js 空/截断仍下发 200、index.html 读取失败
 * 返回空白 HTML，而 /api/health 与进程状态全绿 —— 白屏了完全查不出来。
 * 现在结果一律记进 ASSET_STATUS，banner / /api/health 可见，异常写系统日志。
 */
const ASSET_STATUS = { js: 'source', css: 'link', html: 'missing', staleBuild: false, warnings: [] };

let INLINE_CSS = '';
try {
  INLINE_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  if (INLINE_CSS.length > 512) ASSET_STATUS.css = 'inline(' + INLINE_CSS.length + ' chars)';
  else ASSET_STATUS.warnings.push('style.css 过小或为空，已保留外链');
} catch { ASSET_STATUS.warnings.push('style.css 读取失败，已保留外链'); }

let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  ASSET_STATUS.html = INDEX_HTML.includes('</html>') ? 'memory' : 'missing';
} catch { ASSET_STATUS.warnings.push('index.html 启动时读取失败，请求时将回源磁盘'); }
if (ASSET_STATUS.html === 'missing') ASSET_STATUS.warnings.push('index.html 内容不完整（缺 </html>）');
if (INDEX_HTML && !INDEX_HTML.includes('src="/app.js"')) {
  ASSET_STATUS.warnings.push('index.html 里找不到 src="/app.js"，版本号注入会失效（资源退回 no-cache）');
}

let APP_MIN_BUF = null;
let APP_MIN_GZ = null;
try {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'app.min.js'));
  if (raw.length < 1024) {
    ASSET_STATUS.warnings.push('app.min.js 仅 ' + raw.length + 'B，疑似空产物，已回源 app.js');
  } else {
    APP_MIN_BUF = raw;
    APP_MIN_GZ = zlib.gzipSync(raw);
    ASSET_STATUS.js = 'minified(' + raw.length + 'B)';
  }
} catch { ASSET_STATUS.warnings.push('app.min.js 读取失败，已回源 app.js'); }

/* 忘了 node build.js 的早期预警：源码比产物新，浏览器拿到的是旧逻辑。 */
try {
  const stSrc = fs.statSync(path.join(PUBLIC_DIR, 'app.js'));
  const stMin = fs.statSync(path.join(PUBLIC_DIR, 'app.min.js'));
  if (stSrc.mtimeMs > stMin.mtimeMs + 2000) {
    ASSET_STATUS.staleBuild = true;
    ASSET_STATUS.warnings.push('app.js 比 app.min.js 新（疑似忘记 node build.js），当前下发旧产物');
  }
} catch { }

/*
 * 版本指纹必须按「真正下发的字节」算。旧版 hash 的是源文件 app.js，
 * 但 /app.js 返回的是产物 app.min.js —— 改了源却忘构建时：源变了 → URL 变了 →
 * 服务端仍返回旧产物，还被 immutable 缓存一年，用户会一直停在上一版。
 * 把 index.html 也纳入，HTML 改了 ETag 才不会误回 304。
 */
let ASSET_VER = '0';
try {
  const h = crypto.createHash('md5');
  h.update(APP_MIN_BUF || fs.readFileSync(path.join(PUBLIC_DIR, 'app.js')));
  h.update(INLINE_CSS || fs.readFileSync(path.join(PUBLIC_DIR, 'style.css')));
  h.update(INDEX_HTML || '');
  ASSET_VER = h.digest('hex').slice(0, 10);
} catch { ASSET_STATUS.warnings.push('静态资源指纹计算失败，使用兜底版本 0'); }
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
let STATE_FILE = path.join(DATA_DIR, 'state.json');

/*
 * ---------------------------------------------------------------- 运行环境
 * 目的：dev 调试不消耗生产短信配额（规范第五节、验收第 7 条）。
 * 判定顺序（宁可判 prod 漏 dry-run，也不能判 dev 让线上静默不发）：
 *   1. CRONHUB_ENV / NODE_ENV 显式指定
 *   2. Windows 本机 → dev（这个项目只跑在 Windows 开发机 + Linux 容器）
 *   3. Linux 且检测到容器特征 → prod
 *   4. 其余 → prod
 */
function detectEnv() {
  const explicit = String(process.env.CRONHUB_ENV || '').trim().toLowerCase();
  if (explicit === 'prod' || explicit === 'production') return { env: 'prod', reason: 'CRONHUB_ENV' };
  if (explicit === 'dev' || explicit === 'development' || explicit === 'test') return { env: 'dev', reason: 'CRONHUB_ENV' };
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return { env: 'prod', reason: 'NODE_ENV' };
  if (process.platform === 'win32') return { env: 'dev', reason: 'windows-host' };
  try {
    if (fs.existsSync('/.dockerenv')) return { env: 'prod', reason: 'dockerenv' };
    if (fs.existsSync('/proc/self/mountinfo')) {
      const mi = fs.readFileSync('/proc/self/mountinfo', 'utf8');
      if (/\soverlay\s|docker|containerd|kubepods|gvisor/i.test(mi)) return { env: 'prod', reason: 'container-mount' };
    }
  } catch { /* 读不到就按下面兜底 */ }
  return { env: process.platform === 'linux' ? 'prod' : 'dev', reason: 'fallback' };
}

const RUNTIME_ENV = detectEnv();
/*
 * 是否处在守护进程之下（watchdog.cjs 会注入这个变量）。
 * 用途只有一个：决定「未捕获异常」之后该不该退出。
 *   - 有守护 → 退出，让守护拉起一个干净进程（Node 官方立场：异常后进程状态不可信）；
 *   - 没守护 → 退出等于站点永久挂掉，只能降级继续跑，但把事实写进系统日志与健康接口。
 * 平台会不会自动重启进程我们无法确认，所以两种路径都要能活。
 */
const SUPERVISED = /^(1|true|yes)$/i.test(String(process.env.CRONHUB_SUPERVISED || ''));
const SMS_DRY_RUN = RUNTIME_ENV.env !== 'prod'
  && !/^(1|true|yes)$/i.test(String(process.env.CRONHUB_SMS_REAL || ''));
const SMS_ENV_TAG = SMS_DRY_RUN
  ? 'dry-run（' + RUNTIME_ENV.env + ' · ' + RUNTIME_ENV.reason + '，不产生真实短信）'
  : '真实发送（' + RUNTIME_ENV.env + ' · ' + RUNTIME_ENV.reason + '）';

/*
 * 短信「中转」（入站转发，手机 → 网站）：已下线，默认关闭。
 * 它与「短信通知」（网站 → 手机）方向相反，是两回事 —— 后者不受这里影响。
 *
 * 关闭时的行为：/gateway/sms/receive、/api/sms-relay/log 一律 404，
 * 与「这个接口根本不存在」不可区分，不给探测者留下「这里曾经有入口」的线索。
 * 代码与数据结构都保留，需要恢复时设置 CRONHUB_SMS_RELAY=1 并重启即可，
 * 但界面入口（导航「中转」与整页）已经移除，恢复需要同时改前端。
 */
const SMS_RELAY_ENABLED = /^(1|true|yes)$/i.test(String(process.env.CRONHUB_SMS_RELAY || ''));

/* 可选的管理面 IP 白名单：CRONHUB_ADMIN_IPS=1.2.3.4,5.6.7.8（留空 = 不启用） */
const ADMIN_IP_ALLOW = String(process.env.CRONHUB_ADMIN_IPS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);

let storageWritable = true;
let lastStorageError = '';

/*
 * ------------------------------------------------------------ 落盘可靠性
 * 起因（第 16 批审计）：saveStateSync 只做 writeFileSync + renameSync，没有 fsync。
 * tmp+rename 保证的是「目录项要么旧要么新」，不保证数据页已经落盘 —— 宿主强杀或断电
 * 时可能留下 0 字节 / 半截 JSON；而 loadState 的 catch 分支直接换空状态，第一次写盘
 * 就把坏文件盖掉。三件事连起来就是：写坏一次 → 静默清零 → 无法恢复。
 *
 * 这里补三级保护：fsync 四步写 → 备份轮转 → 损坏隔离 + 回退 + 独立通道告警。
 * 恢复只回退、不补跑错过的任务：签到类任务补跑等于重复副作用。
 */
const STATE_BAK_SLOTS = 3;
/** 备份粒度：10 分钟一次。一天写入约 1150 次，每次都复制 460KB 会把写放大翻一倍。 */
const STATE_BAK_INTERVAL_MS = 10 * 60 * 1000;

const stateHealth = {
  at: null,            // 最近一次成功写盘时间
  ms: 0,               // 最近一次写盘耗时
  bytes: 0,            // 最近一次写盘体积
  fsync: false,        // 本进程内 fsync 是否真的成功过
  backupAt: null,      // 最近一次备份轮转时间
  recovered: false,    // 启动时是否发生过损坏回退
  recoveredFrom: '',   // 从哪个备份恢复（bak1/bak2/bak3）
  recoveredAt: null,
  recoveredTasks: 0,
  corruptFile: '',     // 隔离出来的坏文件（保留取证，不覆盖）
  loadSource: '',      // main | bak1..3 | seed
  errors: 0,           // 写盘/读盘失败次数
  lastError: '',
};

function bakPath(i) {
  return STATE_FILE + '.bak.' + i;
}

/*
 * fsync 四步写：open → write → fsync → close，之后调用方再 rename。
 * fsync 失败不算致命（部分文件系统/容器不支持），但要在状态里留痕。
 */
function fsyncWriteSync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, data, null, 'utf8');
    try { fs.fsyncSync(fd); stateHealth.fsync = true; } catch { /* 文件系统不支持就退化为普通写 */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
  }
}

/** 目录项也要 fsync 才算真落地；Windows 上目录不能 fsync，跳过。 */
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* 不支持则忽略 */ }
}

/**
 * 备份轮转：state.json → bak.1 → bak.2 → bak.3。
 * 只在写盘前调用，此刻 state.json 是上一份「已知可用」的内容，正好当最新备份。
 */
function rotateStateBackup(force) {
  if (!fs.existsSync(STATE_FILE)) return false;
  const last = stateHealth.backupAt ? Date.parse(stateHealth.backupAt) : 0;
  if (!force && Date.now() - last < STATE_BAK_INTERVAL_MS) return false;
  try {
    for (let i = STATE_BAK_SLOTS - 1; i >= 1; i--) {
      const src = bakPath(i);
      if (!fs.existsSync(src)) continue;
      try { fs.rmSync(bakPath(i + 1), { force: true }); } catch { /* 目标不存在 */ }
      fs.copyFileSync(src, bakPath(i + 1));
    }
    fs.copyFileSync(STATE_FILE, bakPath(1));
    stateHealth.backupAt = nowISO();
    return true;
  } catch (e) {
    stateHealth.lastError = '备份轮转失败：' + e.message;
    return false;
  }
}

/**
 * 严格读取一份状态文件。抛错即「不可用」，由调用方决定回退到哪一档。
 * 空文件、截断 JSON、顶层非对象、缺 tasks 数组都算损坏 —— 最后一条很关键：
 * 一份结构不完整的 state 会静默清空任务，和 JSON 语法错误一样致命。
 */
function readStateFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw || raw.trim().length < 2) throw new Error('文件为空');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('顶层不是对象');
  if (!Array.isArray(parsed.tasks)) throw new Error('缺少 tasks 数组（结构不完整）');
  return parsed;
}

/**
 * 三级加载：主文件 → bak.1..3 → 交给调用方起空状态。
 * 主文件解析失败时先改名隔离（.corrupt.<时间戳>），绝不直接覆盖。
 */
function readStateWithFallback() {
  const out = { parsed: null, source: 'seed', path: '', recovered: false, corruptFile: '', error: '' };
  try {
    out.parsed = readStateFile(STATE_FILE);
    out.source = 'main';
    out.path = STATE_FILE;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err);
    console.error('[state] 主状态文件不可用：' + out.error);
    stateHealth.errors += 1;
    stateHealth.lastError = out.error;
    if (fs.existsSync(STATE_FILE)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bad = STATE_FILE + '.corrupt.' + stamp;
      try {
        fs.renameSync(STATE_FILE, bad);
        out.corruptFile = bad;
      } catch (e2) {
        console.error('[state] 坏文件隔离失败：' + e2.message);
        try { fs.copyFileSync(STATE_FILE, bad); out.corruptFile = bad; } catch { /* 连复制都不行 */ }
      }
    }
  }
  for (let i = 1; i <= STATE_BAK_SLOTS; i++) {
    const p = bakPath(i);
    if (!fs.existsSync(p)) continue;
    try {
      out.parsed = readStateFile(p);
      out.source = 'bak' + i;
      out.path = p;
      out.recovered = true;
      return out;
    } catch (err) {
      console.error('[state] 备份 ' + i + ' 也不可用：' + String((err && err.message) || err));
    }
  }
  return out;
}

/**
 * 回退事实的对外表达：系统日志 + 健康快照 + **独立通道**手机推送。
 * 为什么不用站内通知：这时候站内数据结构可能刚重建，通知中心本身就可能空着。
 */
function reportStateRecovery(loaded, taskCount) {
  stateHealth.recovered = true;
  stateHealth.recoveredAt = nowISO();
  stateHealth.recoveredTasks = taskCount;
  stateHealth.recoveredFrom = loaded && loaded.source && loaded.source !== 'seed' ? loaded.source : '';
  stateHealth.corruptFile = (loaded && loaded.corruptFile) || '';
  const kept = stateHealth.corruptFile ? '，原文件已隔离为 ' + path.basename(stateHealth.corruptFile) : '';
  const msg = taskCount > 0
    ? '状态文件损坏，已从 ' + (stateHealth.recoveredFrom || '备份') + ' 恢复 ' + taskCount + ' 个任务' + kept
    : '状态文件损坏且没有可用备份，已重置为空状态' + kept;
  console.error('[state] ' + msg);
  try {
    pushSysLog({ level: 'error', source: 'state', msg, detail: { from: stateHealth.recoveredFrom, corrupt: stateHealth.corruptFile, tasks: taskCount } });
  } catch { /* 日志失败不影响启动 */ }
  const title = taskCount > 0 ? 'CronHub 状态文件已自动恢复' : 'CronHub 状态损坏且无备份';
  const body = msg + '\n请打开设置页确认任务与凭据是否完整。';
  try {
    sendNotifyMe((state.settings || {}).notifyme, { title, body, level: 'error' }).catch(() => {});
  } catch { /* 推送失败不阻塞启动 */ }
}

let DATA_DIR_FALLBACK = '';
/** 返回一个确定可写的目录：优先用请求的目录，不可写时退到系统临时目录。 */
function resolveWritableDir(dir) {
  const candidates = process.env.DATA_DIR ? [dir] : [dir, path.join(os.tmpdir(), 'cronhub-data')];
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return d;
    } catch {
      if (d !== dir) DATA_DIR_FALLBACK = '目标目录不可写，已降级到 ' + d + '（state.json 与主密钥会落在临时目录，实例回收即丢）';
    }
  }
  // 全部候选都失败：不静默，后面启动段会写 error 日志与系统日志
  if (!DATA_DIR_FALLBACK) DATA_DIR_FALLBACK = '数据目录 ' + dir + ' 不可写，落盘将持续失败';
  return dir;
}

const MAX_LOGS = 300;

/*
 * 日志保留期：7 天。
 *
 * 条数上限（300 条）只管「多」，不管「旧」—— 一天跑 300 次的任务会把一周前的记录也留着，
 * 而一周只跑一次的任务，一条两年前的失败记录还挂在列表里。两种都不合理。
 * 现在双约束：超过 7 天的先删，剩下的再按条数截。系统日志同理（持久化尾部 300 条）。
 * 只清「日志」，不动任务、通知、配置。
 */
const LOG_RETENTION_DAYS = 7;
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 删掉超过保留期的日志条目，返回删了多少条（用于决定是否落盘）。 */
function pruneExpiredLogs() {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const expired = (at) => {
    const t = Date.parse(at);
    return Number.isFinite(t) && t < cutoff;
  };
  let removed = 0;
  for (const key of ['logs', 'systemLogs', 'keepAliveLog']) {
    const list = state[key];
    if (!Array.isArray(list) || !list.length) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (expired(list[i] && list[i].at)) { list.splice(i, 1); removed++; }
    }
  }
  return removed;
}

/**
 * 单条执行结果里保留的响应正文上限（字符）—— 安全阀，不是业务限制。
 *
 * 第二十一批：以前这里只有 8000 字，步骤日志又把每步响应单独截到 2000 字，
 * 和风天气 14173 字的逐时预报被砍掉大半；AI 材料另有 5000 字上限、AI 前原文只留 800 字。
 * 用户明确「允许全部接受」，于是展示 / 落盘 / AI 材料统一到这一处上限，
 * 默认 20 万字（约 400KB），正常接口永远碰不到，不会再出现业务数据被截。
 *
 * 仍保留上限的理由：state.json 是整份 JSON 落盘的，300 条 × 无限长正文
 * 会把写盘拖慢甚至撑爆内存。真遇到异常大响应会显式标注被截断。
 * CRONHUB_BODY_MAX=0 完全关闭截断；也可设成具体字符数。
 */
const RESULT_BODY_MAX = (() => {
  const raw = Number(process.env.CRONHUB_BODY_MAX);
  if (!Number.isFinite(raw) || raw < 0) return 200000;
  return Math.round(raw);
})();

/**
 * 任务失败自动重试的次数上限。
 *
 * 声明在这里而不是紧挨着重试逻辑，是因为 sanitizeHttpConfig（保存/导入路径）也要用它
 * clamp —— 常量在模块初始化阶段就要可用，不能依赖后面才执行的 const 声明。
 */
const RETRY_MAX_TIMES = 3;

/** 把正文裁到上限，被裁时明确告诉读者「这里少了一截」以及原文有多长。 */
function clipBody(text, max = RESULT_BODY_MAX) {
  const s = String(text == null ? '' : text);
  const lim = max == null ? RESULT_BODY_MAX : Number(max);
  if (!Number.isFinite(lim) || lim <= 0 || s.length <= lim) return s;
  return s.slice(0, lim) + `\n…（已截断：原文共 ${s.length} 字，仅保留前 ${lim} 字）`;
}

/** 多步骤任务的响应拼成一段，每步加分隔标题，方便在一条日志里顺着看下去。 */
function joinStepBodies(steps) {
  const list = (steps || []).filter((s) => s && s.response);
  if (!list.length) return '';
  if (list.length === 1) return clipBody(list[0].response);
  // 每步各自受安全阀约束，合计不再二次截断 —— 5 个步骤都返回长正文时，
  // 旧的「合计 8000」会把后面几步整段吃掉，正是这次要修的问题。
  return list.map((s) => `── ${s.name || '步骤'}${s.ok === false ? '（失败）' : ''} ──\n${clipBody(s.response)}`).join('\n\n');
}

/* ---------------------------------------------------------------- 状态层 */

const DEFAULT_SETTINGS = {
  /*
   * 仅用于通知文案里的时间格式化（buildNotice 的 toLocaleString），**不参与 cron 调度**：
   * nextCronRun 一律按进程所在时区解析。UI 没有暴露这个字段的编辑入口，所以不存在
   * 「改了却没生效」的误导；真要让调度换时区，应该设进程级 TZ 并整体重算 nextRun。
   */
  timezone: 'Asia/Shanghai',
  /* 私网 URL 防护开关，默认关（自用站可能有内网任务）。也可用 CRONHUB_BLOCK_PRIVATE_URL=1 打开。 */
  blockPrivateUrls: false,
  inappEnabled: true,
  browserEnabled: true,
  /*
   * Webhook 这一栏其实是「推送方案」容器：format 决定真正发给谁。
   * 后五个字段只对 NotifyMe 生效（见 buildNotifyMePayload）：
   *   bigText    通知栏展开多行（长正文靠它铺开，关掉就只剩一行）
   *   actionType 点通知干什么：0 不动作 / 1 打开链接 / 2 打开应用 / 4 复制到剪贴板 / 5 提取验证码
   *   action     上面那个动作的目标值（链接 / 包名 / 要复制的文本；5 不需要）
   *   group      通知分组名，**留空表示不分组**（带了这个字段 Android 会把同组折成一条）
   *   urgent     紧急：持续响铃，依赖 quicker_channel
   */
  webhook: {
    enabled: false, format: 'generic', url: '', token: '', uuid: '', fcm: '',
    bigText: true, actionType: 0, action: '', group: '', urgent: false,
  },
  /*
   * 每个通知渠道独立的推送时机（通知页点渠道卡展开配置）。
   * onSuccess 默认 true 保持历史行为（任务要求推成功时所有渠道都收到）。
   */
  notifyTiming: {
    notifyme: { onSuccess: true, onFailure: true },
    webhook: { onSuccess: true, onFailure: true },
    sms: { onSuccess: true, onFailure: true },
    email: { onSuccess: true, onFailure: true },
  },
  /* AI 通知优化：任意 OpenAI 兼容接口（智谱 / DeepSeek / 硅基流动等）
     timeoutMs / maxAttempts 是「单次超时」和「最多尝试几次」，设置页可调；这里写字面量是因为
     常量 AI_TIMEOUT_MS 在文件后面才声明（const 有 TDZ，顺序不能提前引用） */
  ai: { enabled: false, provider: '', baseUrl: '', apiKey: '', model: '', defaultPrompt: '', timeoutMs: 20000, maxAttempts: 2 },
  /*
   * 短信网关：把本机短信能力封装成对外 HTTP 接口（兼容 sms-webhook 协议），
   * 外部系统 / 转发器带 token 调 /gateway/sms/send 即可发短信，无需部署独立服务。
   */
  gatewaySms: { enabled: false, token: '' },
  /*
   * 短信转发中转：手机 SmsForwarder App 把收到的短信 POST 到 /gateway/sms/receive，
   * CronHub 落记录并可选推送到手机（NotifyMe）。token 独立于短信网关。
   */
  smsRelay: { enabled: false, token: '', pushNotify: true, hideContent: true },
  /*
   * 短信发送中继（可选）：云端出口到 5gvas01 网关的 TLS 可能被「按来源」拦截时，
   * 把发送 POST 原样转给一个能直连网关的 HTTPS 中继（如 Cloudflare Worker）。
   * url 只填 origin；发送时路径仍用网关原路径，加密体与令牌完全不动；
   * secret 以 X-Relay-Secret 头交给中继鉴权，中继转发前会删掉，不会到达网关。
   * 留空 = 直连网关（保持原有行为）。
   */
  smsGatewayRelay: { enabled: false, url: '', urls: [], secret: '' },
  /*
   * 白名单 SNI 伪装（可选，只在直连网关时生效）：
   * 云端出口到 5gvas01 的 TLS 握手若被「按明文 SNI 白名单」拦截，把 ClientHello
   * 里的 SNI 换成云端实测放行的域名（默认 www.baidu.com）即可绕过，连中继都不用。
   * 连接目标、Host 头、证书校验仍锚定网关原域名；网关不校验 SNI（已实测），
   * 所以无需关闭证书校验。启用发送中继时本项自动失效（真正要连的是中继主机）。
   * 关闭或留空 = 用网关自己的 SNI，保持原有行为。
   */
  smsGatewaySni: { enabled: false, sni: 'www.baidu.com' },
  /*
   * 通知渠道「多实例」：同一个渠道可以配多套（多组 Webhook、多个收件箱、多个 AI 档位）。
   * 卡片里以「标签页」形式并排展示，长按通道标题即可新增一个标签（带备注）。
   * 老的单套配置仍是「默认」标签，不用迁移；实例存这里：
   *   { sms: [{id, remark, enabled, config}], webhook: [...], email: [...], ai: [...] }
   * 任务的渠道写法：'webhook' = 默认那套，'webhook:ci_xxxx' = 指定的那个实例。
   */
  channelInstances: { sms: [], webhook: [], email: [], ai: [] },
  /*
   * 「默认」那套配置的标识：多用户时用来区分（如 张三 / 李四），显示在标签小字和通知里。
   * 实例的标识存在各实例的 remark 上，这里只放默认标签的。
   */
  channelMarks: { sms: '', webhook: '', email: '', ai: '' },
  /*
   * 环境变量（青龙面板式）：集中管理敏感凭据与公共参数。
   * 任务里的 {{KEY}} 占位符执行前自动替换（url / headers / body / 步骤均生效）。
   */
  envVars: [],
  smtp: { enabled: false, host: '', port: 465, user: '', pass: '', from: '', to: '' },
  /*
   * 凭据自动续期（WorkBuddy 专用）。
   * 任务 headers 里写 {{ACCESS_TOKEN}} 占位符，执行前由服务端换成真实 accessToken。
   * 有了 refreshToken，accessToken 过期不会被写成死字符串，也就不必每次手工替换。
   */
  tokenVault: {
    enabled: false,
    refreshToken: '',
    accessToken: '',
    accessExpiresAt: 0,
    refreshExpiresAt: 0,
    endpoint: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
  },
  /*
   * NotifyMe 手机推送（个人自用第三方中转，国内可直连）。
   * mode = 'uuid' 打新版端点，mode = 'token' 打旧版 FCM 端点；两种凭据互不通用。
   */
  notifyme: {
    enabled: false,
    mode: 'token',
    uuid: '',
    token: '',
    group: '',
    urgent: false,
    /* 与 webhook 侧同名同义（见上），两条 NotifyMe 路径共用同一套拼装函数 */
    bigText: true,
    actionType: 0,
    action: '',
    onFailure: true,
    onSuccess: false,
  },
  /*
   * 错过补跑策略：云端实例空闲会休眠，唤醒后才发现错过了计划时间。
   *   run  → 迟到也补跑一次（适合每日签到：晚点跑总比不跑强，默认）
   *   skip → cron 任务迟到超过 15 分钟就跳过本次，发一条站内说明
   */
  missedPolicy: 'run',
  /*
   * 服务中断后的补跑细则（第十六批之二）。
   *
   * 背景：云端实例会休眠，醒来时 nextRun 可能已经过去几小时。原实现是
   * 「missedPolicy=run 就立刻跑」——8 个任务同一秒一起打出去，对上游是风控高风险，
   * 而且如果那次其实已经跑过（只是没落下 nextRun），就是重复执行。
   *
   * 现在的口径是「补，但要克制」：
   *   enabled        总开关（关掉就只推进 nextRun，不执行）
   *   windowMinutes  只补这么久以内的错过；更久的视为已失效，只记日志
   *   maxPerStart    一次启动最多补几个（其余丢弃并说明，避免启动风暴）
   *   minGapSec      同任务两次执行的最小间隔（防「补跑 + 准点」连打上游）
   *   jitterMaxMs    补跑前的随机等待上限（错峰，防同秒并发）
   */
  catchup: { enabled: true, windowMinutes: 120, maxPerStart: 5, minGapSec: 45, jitterMaxMs: 20000 },
  /*
   * 持续保活：开启后服务端每 intervalMin 分钟访问一次自己的公网探活地址，
   * 平台看到持续流量就不会让实例休眠 —— 任务永远准时，代价是实例常驻运行。
   * url 必须是带 sharecode 的完整公网探活地址（设置页「保活探针」卡片里那个）。
   */
  keepWarm: { enabled: false, url: '', intervalMin: 10, pageBeat: true, pageBeatSec: 30 },
  /*
   * 外部唤醒令牌（第二重保活保险）。
   * 实例休眠后进程完全停摆，自己叫不醒自己；只能由外部请求唤醒。
   * 把 /api/wake?token=xxx 交给任何外部定时器（cron-job.org、UptimeRobot、
   * 手机快捷指令、另一台机器的 crontab、浏览器书签）定期访问即可。
   */
  wake: { token: '' },
  /*
   * 短信通知（中国移动「短信通知」skill 的移植）：凭据/授权在 lib/sms/ 目录里，
   * 设置侧只有一个总开关。仅支持中国移动号码；授权过期时任务日志会提示重新授权。
   */
  sms: {
    enabled: false,
    /*
     * 短信是「强打扰 + 按条计费」的通道：默认只发重要事件（失败 / 告警 / 提醒），
     * 成功通知留在站内与 App 推送里。想恢复全量推送改成 'all'。
     */
    minLevel: 'important',
    /*
     * 正文上限（字）：移动长短信按 67 字/条计费，134 = 2 条。
     * 默认掐在 2 条内，免得 AI 优化后的长文变成 7 条短信。
     */
    maxChars: 134,
    /*
     * 正文末尾附「操作链接」：收到短信点开即可静音 / 退订，不用登录。
     * 第 45 轮实测：裸域名链接本身约 64 字，在 134 字上限里会挤掉大半正文，
     * 天气播报被掐成「建议 🧥 早…」，手机上还占三行。默认关掉，需要再手动开。
     */
    actionLink: false,
    /* 下面两个由短信操作页或设置页改写：optOut=不再发短信；mutedUntil=静音到某时刻 */
    optOut: false,
    mutedUntil: 0,
  },
  /* 站点公网根地址：由请求头自动记录，短信里的操作链接靠它拼绝对地址 */
  siteBase: '',
  /* 短信操作链接的令牌（首次生成后长期不变，重部署也不会让旧短信失效） */
  smsActionToken: '',
  /* 网关分配的 sharecode：带 sharecode 的请求进来时自动记住，裸域名访问时也能拼出完整探活地址 */
  sharecode: '',
};

function uid(prefix) {
  return (prefix || 'x') + '_' + crypto.randomBytes(6).toString('hex');
}

function nowISO() {
  return new Date().toISOString();
}

function emptyState() {
  return { tasks: [], notifications: [], logs: [], settings: { ...DEFAULT_SETTINGS }, smsRelay: [], keepAliveLog: [], auth: null, authLog: [], systemLogs: [], deadLetters: [], smsAuthStats: null, smsRecords: [], smsBindings: null };
}

let state = emptyState();
let saveTimer = null;

function loadState() {
  const usableDir = resolveWritableDir(DATA_DIR);
  if (usableDir !== DATA_DIR) {
    console.warn(`[state] ${DATA_DIR} 不可写，改用 ${usableDir}`);
    STATE_FILE = path.join(usableDir, 'state.json');
  } else {
    STATE_FILE = path.join(usableDir, 'state.json');
  }

  try {
    if (!fs.existsSync(STATE_FILE)) {
      state = seedState();
      stateHealth.loadSource = 'seed';
      saveStateSync();
      return;
    }
    // 三级加载：主文件 → bak.1..3 → 空状态。坏文件已被改名隔离，不会被覆盖。
    const loaded = readStateWithFallback();
    if (!loaded.parsed) {
      state = seedState();
      stateHealth.loadSource = 'seed';
      stateHealth.errors += 1;
      stateHealth.lastError = loaded.error || '主文件与全部备份均不可解析';
      reportStateRecovery(loaded, 0);
      saveStateSync();
      return;
    }
    stateHealth.loadSource = loaded.source;
    const parsed = loaded.parsed;
    state = {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      settings: deepMerge(DEFAULT_SETTINGS, parsed.settings || {}),
      // 短信转发中转记录：必须一起读回，否则重启后中转日志/通知中心会凭空清空
      smsRelay: Array.isArray(parsed.smsRelay) ? parsed.smsRelay : [],
      // 连续运行统计（跨重启累计）
      runtime: parsed.runtime && typeof parsed.runtime === 'object' ? parsed.runtime : null,
      // 保活日志：统一控制台的探活/唤醒历史，重启后还能看
      keepAliveLog: Array.isArray(parsed.keepAliveLog) ? parsed.keepAliveLog : [],
      auth: parsed.auth && parsed.auth.hash ? parsed.auth : null,
      authLog: Array.isArray(parsed.authLog) ? parsed.authLog : [],
      // 网站运行日志：重启后还能看到上一次运行的尾部记录
      systemLogs: Array.isArray(parsed.systemLogs) ? parsed.systemLogs : [],
      /*
       * 短信凭据状态机：熔断截止时间、今日计数、加密后的令牌全在这。
       * 漏了这一段，重启就等于「熔断解除 + 配额清零 + 令牌丢失」，
       * 会把「重启 5 次刷新增量 ≤1」和「熔断期内重启仍不发请求」两条验收直接打穿。
       */
      smsCredential: parsed.smsCredential && typeof parsed.smsCredential === 'object' ? parsed.smsCredential : null,
      /*
       * 号码绑定：一个号码一份独立授权（clawUid / uuid / accessToken 各自独立）。
       * 老部署没有这个字段，由 lib/sms-bindings.js 的 ensure() 从 smsCredential 迁移过来。
       */
      smsBindings: Array.isArray(parsed.smsBindings) ? parsed.smsBindings : null,
      /*
       * 发送记录：摘要 + 结果 + 条数（不含正文全文，见 sendSms putRecord）。
       * 重启后还能查「昨天那条短信到底发出去没有」。
       */
      smsRecords: Array.isArray(parsed.smsRecords) ? parsed.smsRecords : [],
      smsCredentialLegacy: parsed.smsCredentialLegacy && typeof parsed.smsCredentialLegacy === 'object' ? parsed.smsCredentialLegacy : null,
      /*
       * 凭据保险库：三类分区密文 + 硬过期日 + 轮换记账。
       * 与 smsCredential（状态与计数）刻意分开两棵树 —— 状态丢了可以重建，凭据丢了要重新授权。
       */
      credentialVault: parsed.credentialVault && typeof parsed.credentialVault === 'object' ? parsed.credentialVault : null,
      /*
       * 推送死信：渠道重试耗尽后留一份完整载荷，重启后还能重放。
       * 以前推送失败只在内存日志里留一行，进程一重启就彻底没了。
       */
      deadLetters: Array.isArray(parsed.deadLetters) ? parsed.deadLetters : [],
      /*
       * 短信管理面「授权次数」计数：免认证模式下唯一的痕迹就是它，
       * 不随状态持久化的话每次重启都归零，等于没统计。
       */
      smsAuthStats: parsed.smsAuthStats && typeof parsed.smsAuthStats === 'object' ? parsed.smsAuthStats : null,
      /*
       * 运行指标（第十八批）：24 小时 × 5 分钟桶的执行计数。
       * 只保留结构合法的桶 —— 手改过 state.json 的桶可能是字符串或 null，
       * metricsSnapshot 会按 typeof b.t === 'number' 再滤一次，两边都不信任输入。
       */
      metrics: (() => {
        const m = parsed.metrics;
        const buckets = Array.isArray(m && m.buckets) ? m.buckets : [];
        return {
          buckets: buckets.filter((b) => b && typeof b.t === 'number' && Number.isFinite(b.t)).slice(-METRIC_BUCKETS),
          startedAt: (m && typeof m.startedAt === 'string' ? m.startedAt : '') || '',
        };
      })(),
      // 死信水位：跨重启记住「已经告警到第几档」，否则每次重启都会重发一遍同样的告警
      deadLetterAlert: Number(parsed.deadLetterAlert) > 0 ? Number(parsed.deadLetterAlert) : 0,
    };
    if (loaded.recovered) {
      reportStateRecovery(loaded, (state.tasks || []).length);
      // 回退后立刻写回主文件：否则下一次启动读到的还是「主文件缺失 → 再回退一遍」
      saveStateSync();
    } else {
      // 主文件正常：顺手把它复制成 bak.1，保证首次损坏时至少有东西可回退
      rotateStateBackup(true);
    }
  } catch (err) {
    console.error('[state] 读取失败，使用初始状态:', err.message);
    state = seedState();
    stateHealth.loadSource = 'seed';
    stateHealth.errors += 1;
    stateHealth.lastError = String((err && err.message) || err);
  }
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/*
 * 上一次成功写盘的内容指纹。state.json 已经 330KB+，而 saveState() 的调用点有 45 处：
 * 45 秒一次的日志持久化、每次轮询触碰的状态、甚至内容根本没变的操作都会把整份 JSON
 * 重写一遍。用 sha1 对比内容，没变就跳过写盘 —— 省掉 IO，也少一次「写 tmp → rename」
 * 窗口里被平台回收留下半截文件的机会。
 * 注意 flushState() 的语义不受影响：内容没变说明磁盘上已经是这份，跳过是安全的。
 */
let lastStateHash = '';
let stateWriteCount = 0;
let stateSkipCount = 0;
/** /api/health 里带一份，用来确认去重确实在生效，而不是「看起来省了」。 */
function stateWriteStats() {
  return { writes: stateWriteCount, skipped: stateSkipCount };
}

/**
 * 落盘健康快照：运维只需看这一块就能判断「数据安不安全」。
 * /api/health 与 /api/state 共用同一份口径，避免两处各写一套后互相漂移。
 */
function stateStorageSnapshot() {
  return {
    writable: storageWritable,
    lastStorageError,
    fsync: stateHealth.fsync,
    backup: { at: stateHealth.backupAt, slots: STATE_BAK_SLOTS, intervalSec: STATE_BAK_INTERVAL_MS / 1000 },
    lastWrite: { at: stateHealth.at, ms: stateHealth.ms, bytes: stateHealth.bytes },
    loadSource: stateHealth.loadSource,
    recovered: stateHealth.recovered,
    recoveredFrom: stateHealth.recoveredFrom,
    recoveredAt: stateHealth.recoveredAt,
    recoveredTasks: stateHealth.recoveredTasks,
    corruptFile: stateHealth.corruptFile,
    errors: stateHealth.errors,
    lastError: stateHealth.lastError,
  };
}

function saveStateSync() {
  try {
    const json = JSON.stringify(state, null, 2);
    const hash = crypto.createHash('sha1').update(json).digest('hex');
    if (hash === lastStateHash && fs.existsSync(STATE_FILE)) {
      stateSkipCount++;
      // 文件被外部删掉 / 换过挂载时，即使指纹相同也要重写回来
      if (!storageWritable) {
        storageWritable = true;
        lastStorageError = '';
        console.log('[state] 存储已恢复写入');
      }
      return;
    }
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    const t0 = Date.now();
    // 先轮转：此刻 state.json 还是上一份已知可用的内容，正好做 bak.1
    rotateStateBackup(false);
    // fsync 四步写：只 write+rename 不保证数据页落盘，强杀/断电会留下半截文件
    fsyncWriteSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
    fsyncDir(dir);
    stateHealth.at = nowISO();
    stateHealth.ms = Date.now() - t0;
    stateHealth.bytes = Buffer.byteLength(json);
    stateHealth.lastError = '';
    lastStateHash = hash;
    stateWriteCount++;
    if (!storageWritable) {
      storageWritable = true;
      lastStorageError = '';
      console.log('[state] 存储已恢复写入');
    }
  } catch (err) {
    // 极端情况下目录仍不可写：继续在内存里跑，但要让前端看到告警
    storageWritable = false;
    lastStorageError = err.message;
    stateHealth.errors += 1;
    stateHealth.lastError = String((err && err.message) || err);
    console.error('[state] 写入失败（数据仅存于内存，重启会丢）:', err.message);
    // 重新排队一次：flushState() 会清掉 lazyTimer，若不重排，之后服务一旦空闲
    // 就没有任何落盘触发源，这批改动只留在内存里，进程被硬杀即丢。
    // lastStateHash 只在成功时更新，下次重试自然写出最新 state；saveStateLazy 自带幂等。
    saveStateLazy();
  }
}

function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateSync();
  }, 400);
}

/**
 * 立即落盘（吃掉 400ms 防抖）。
 *
 * 用在「先记事实、再发通知」这种中间态上：任务已经跑完了，但推送还没发出去。
 * 平台回收实例是直接杀进程，防抖窗口里的改动一样会丢 —— 丢的后果不是少一条日志，
 * 而是重启后把同一个时刻再跑一遍（签到、下单这类任务就是重复副作用）。
 */
function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (lazyTimer) {
    clearTimeout(lazyTimer);
    lazyTimer = null;
  }
  saveStateSync();
}

/**
 * 「不急」的落盘：合并 5 分钟。
 *
 * 专门给纯观测数据用（保活日志、保活统计、系统日志尾部）。这类数据的特点是：
 * 每次自保活 ping、每条访问日志都会改一点，但它们**不影响任务执行语义** ——
 * 丢了最多少几条历史记录，不会重复发短信、不会重复签到。
 *
 * 而 saveStateSync 是全量写（280KB+，tmp + rename）。线上实测自保活每 ping 一次
 * 就写一遍整份 state（keepLog 一次、persistKeepStat 一次），4 小时累计 690 次写。
 * 换成这条通道后，观测数据跟任务结果彻底分开：任务结果仍走 flushState() 立即落盘。
 */
const LAZY_PERSIST_MS = 5 * 60 * 1000;
let lazyTimer = null;
function saveStateLazy() {
  if (lazyTimer) return;
  lazyTimer = setTimeout(() => {
    lazyTimer = null;
    saveStateSync();
  }, LAZY_PERSIST_MS);
}

/* ---------------------------------------------------------------- 网站运行日志 */

/*
 * 与 state.logs（任务执行结果）分开：这里是「网站自己怎么跑的」——
 * 每个 API 请求、每轮调度、每次通道发送、登录、异常都落一条，用来回看历史。
 * 只放内存环形缓冲（1200 条），每 45 秒把尾部 300 条写进 state 做持久化，
 * 避免每个请求都触发写盘。
 */
const SYS_LOG_MAX = 1200;
const SYS_LOG_PERSIST = 300;
const SYS_LOG_LEVELS = ['info', 'warn', 'error'];
let sysLogSeq = 0;
let sysLogBooted = false;
const sysLogRing = [];

/** 首次访问时把持久化的日志载入环形缓冲 */
function sysLogBuffer() {
  if (!sysLogBooted) {
    sysLogBooted = true;
    if (Array.isArray(state.systemLogs) && state.systemLogs.length) {
      sysLogRing.push(...state.systemLogs.slice(0, SYS_LOG_MAX));
      sysLogSeq = sysLogRing.length;
    }
  }
  return sysLogRing;
}

/*
 * 系统日志落盘的节奏分两档。
 *
 * 原来只有一档：任何一条日志进缓冲，45 秒后就把 state.systemLogs 写回 state.json，
 * 而 saveStateSync 是全量写（280KB+，tmp + rename）。于是「每分钟一次心跳 + 每次探活
 * 一条访问日志」= 每 45 秒一次全量写盘，线上实测 4 小时 690 次写、约 190MB —— 日志
 * 只是观测数据，没必要为它付出这个代价。
 *
 * 现在：warn/error 仍然 45 秒内落盘（排障时刚出的错不能丢），info 级别的访问日志
 * 走 5 分钟一档（进程被硬杀最多丢 5 分钟访问记录，不影响任务结果 —— 任务结果走
 * flushState() 立即落盘，这条路径没动）。
 */
const SYSLOG_PERSIST_URGENT = 45 * 1000;
const SYSLOG_PERSIST_LAZY = 5 * 60 * 1000;
let sysLogPersistTimer = null;
let sysLogPersistDue = 0;

function sysLogPersistSoon(urgent = false) {
  const delay = urgent ? SYSLOG_PERSIST_URGENT : SYSLOG_PERSIST_LAZY;
  const due = Date.now() + delay;
  // 已经排了一个更早的落盘点，就不要把它往后推
  if (sysLogPersistTimer && sysLogPersistDue <= due) return;
  if (sysLogPersistTimer) clearTimeout(sysLogPersistTimer);
  sysLogPersistDue = due;
  sysLogPersistTimer = setTimeout(() => {
    sysLogPersistTimer = null;
    sysLogPersistDue = 0;
    state.systemLogs = sysLogBuffer().slice(0, SYS_LOG_PERSIST);
    flushState();
  }, delay);
}

/** 记一条运行日志。detail 会原样存下，便于展开看请求头/响应片段等。 */
/**
 * 日志条目落地前的第二道防线（规范第九条第 4 条：凭据不得进日志）。
 *
 * 调用方大多已经自己 scrub 过，但「入口不设防」意味着任何一个新写的调用方
 * 忘一次就漏一次 —— 而系统日志会被导出、截图、贴进工单，是最容易外流的路径。
 * 所以入口这一层无条件再清一遍：字符串走 scrubText，键名敏感的整段打码。
 */
function scrubLogDetail(obj, depth = 0) {
  if (obj == null || typeof obj !== 'object') return obj;
  /*
   * 以前 depth > 2 直接「原样返回」：detail.steps[].json 里的 access_token /
   * refresh_token 就这样完整进了可导出的系统日志，等于入口这道防线白设。
   * 改成「超深整段打码」而不是「超深不检查」，字符串仍一律走 scrubText。
   */
  if (depth > 6) return '[TRUNCATED]';
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/token|secret|passw|apikey|api_key|authorization|cookie|sharecode/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (typeof v === 'string') out[k] = scrubLogText(v);
    else if (v && typeof v === 'object') out[k] = scrubLogDetail(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

/*
 * 高频相同 4xx/5xx 访问日志的时间窗聚合。
 * 典型场景：已下线的 /api/sms/agent/claim 被外部旧客户端每 21 秒打一次，线上最近
 * 300 条系统日志里有 287 条是同一条 404，真实错误被挤出环形缓冲，每 45 秒还顺带
 * 触发一次 state 全量落盘。相同 (method, path, status) 在 5 分钟内只留一条，
 * 用 count 记录次数、保留最后一次的 detail，既不刷屏也不丢可观测性。
 */
const ACCESS_AGG_MS = 5 * 60 * 1000;
const accessLogAgg = new Map();

function aggregatedAccess(aggKey, update) {
  if (!aggKey) return null;
  const now = Date.now();
  const buf = sysLogBuffer();
  const prev = accessLogAgg.get(aggKey);
  if (prev && now - prev.at < ACCESS_AGG_MS && buf.includes(prev.item)) {
    prev.item.count = (prev.item.count || 1) + 1;
    prev.at = now;
    prev.item.at = nowISO();
    update(prev.item);
    sysLogPersistSoon();
    return prev.item;
  }
  // 顺手清掉过期或已被环形缓冲裁掉的条目，Map 不无限增长
  if (accessLogAgg.size > 200) {
    for (const [k, v] of accessLogAgg) {
      if (now - v.at >= ACCESS_AGG_MS || !buf.includes(v.item)) accessLogAgg.delete(k);
    }
  }
  return null;
}

function pushSysLog({ level = 'info', source = 'system', msg = '', detail = null }) {
  const buf = sysLogBuffer();
  const item = {
    id: 'slg_' + (++sysLogSeq).toString(36),
    at: nowISO(),
    level: SYS_LOG_LEVELS.includes(level) ? level : 'info',
    source: String(source || 'system').slice(0, 16),
    msg: scrubLogText(String(msg || '')).slice(0, 600),
  };
  if (detail && typeof detail === 'object') {
    try {
      item.detail = scrubLogDetail(JSON.parse(JSON.stringify(detail)));
    } catch {
      item.detail = { note: 'detail 无法序列化' };
    }
  }
  buf.unshift(item);
  if (buf.length > SYS_LOG_MAX) buf.length = SYS_LOG_MAX;
  // warn/error 快速落盘，info 走 5 分钟一档（见 sysLogPersistSoon 注释）
  sysLogPersistSoon(item.level === 'warn' || item.level === 'error');
  return item;
}

/** sharecode 是访问凭据，进日志前必须脱敏 */
function maskSecrets(text) {
  return String(text || '')
    .replace(/(sharecode=)[A-Za-z0-9]+/gi, '$1***')
    .replace(/(token=)[A-Za-z0-9_-]{6,}/gi, '$1***');
}

/* ---------------------------------------------------------------- 运行指标 */

/*
 * 「看得见」：把执行情况按 5 分钟一桶记 24 小时。
 *
 * 现状只能回答「累计跑了多少次、累计失败多少次」，回答不了真正被问到的问题：
 * 「今天下午是不是整体变慢了」「失败是零星抖动，还是从 14:00 起全挂」
 * 「重试救回来几次，还是每次都靠人手动补」。日志能翻，但要一条条数。
 *
 * 桶里只放计数和一个耗时分母/分子，不存明细；288 个桶约 20KB，随 state.json 一起落盘，
 * 重启不清零（否则「昨天夜里到底稳不稳」永远查不到）。
 */
const METRIC_BUCKET_MS = 5 * 60 * 1000;
const METRIC_BUCKETS = 288;
const METRIC_HOURS = 24;

function metricsState() {
  if (!state.metrics || !Array.isArray(state.metrics.buckets)) {
    state.metrics = { buckets: [], startedAt: nowISO() };
  }
  return state.metrics;
}

/** 取（必要时新建）当前时间所属的桶。桶永远按时间递增推进。 */
function metricBucket(atMs) {
  const ms = metricsState();
  const key = Math.floor((Number(atMs) || Date.now()) / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
  let b = ms.buckets.length ? ms.buckets[ms.buckets.length - 1] : null;
  if (!b || b.t !== key) {
    // 时间回拨（对时、DST）时不新建更早的桶，直接记到当前桶，避免环形缓冲被旧时间戳填满
    if (b && key < b.t) return b;
    b = { t: key, ok: 0, fail: 0, retry: 0, dl: 0, msSum: 0, msN: 0, maxMs: 0 };
    ms.buckets.push(b);
    if (ms.buckets.length > METRIC_BUCKETS) ms.buckets.splice(0, ms.buckets.length - METRIC_BUCKETS);
  }
  return b;
}

/**
 * 记一笔。kind: ok | fail | retry（重试后成功救回）| dl（进死信）。
 * 纯观测，绝不因为统计抛错影响任务执行 —— 整段 try 包住。
 */
function recordMetric(kind, info) {
  try {
    const b = metricBucket();
    if (kind === 'ok' || kind === 'fail') {
      b[kind] += 1;
      const d = Number(info && info.duration);
      if (Number.isFinite(d) && d >= 0) {
        b.msSum += d;
        b.msN += 1;
        if (d > b.maxMs) b.maxMs = d;
      }
    } else if (kind === 'retry') {
      b.retry += 1;
    } else if (kind === 'dl') {
      b.dl += 1;
    } else {
      return;
    }
    saveStateLazy();
  } catch (err) {
    console.error('[metrics] 记录失败（已忽略）:', err.message);
  }
}

/** 供 /api/health 与 /api/state 用的快照：24 根小时柱 + 三段汇总 */
function metricsSnapshot() {
  const ms = metricsState();
  const now = Date.now();
  const hourMs = 3600 * 1000;
  const hourly = [];
  for (let i = 0; i < METRIC_HOURS; i += 1) hourly.push({ ok: 0, fail: 0, retry: 0, dl: 0, msSum: 0, msN: 0, maxMs: 0 });
  const horizon = now - METRIC_HOURS * hourMs;
  let ok24 = 0;
  let fail24 = 0;
  let retry24 = 0;
  let dl24 = 0;
  let msSum24 = 0;
  let msN24 = 0;
  let ok1 = 0;
  let fail1 = 0;
  let retry1 = 0;
  for (const b of ms.buckets) {
    if (!b || typeof b.t !== 'number' || b.t < horizon) continue;
    const idx = METRIC_HOURS - 1 - Math.min(METRIC_HOURS - 1, Math.floor((now - b.t) / hourMs));
    const h = hourly[idx];
    h.ok += b.ok || 0;
    h.fail += b.fail || 0;
    h.retry += b.retry || 0;
    h.dl += b.dl || 0;
    h.msSum += b.msSum || 0;
    h.msN += b.msN || 0;
    if ((b.maxMs || 0) > h.maxMs) h.maxMs = b.maxMs;
    ok24 += b.ok || 0;
    fail24 += b.fail || 0;
    retry24 += b.retry || 0;
    dl24 += b.dl || 0;
    msSum24 += b.msSum || 0;
    msN24 += b.msN || 0;
    if (now - b.t <= hourMs) {
      ok1 += b.ok || 0;
      fail1 += b.fail || 0;
      retry1 += b.retry || 0;
    }
  }
  const avg = (sum, n) => (n ? Math.round(sum / n) : 0);
  return {
    buckets: ms.buckets.length,
    startedAt: ms.startedAt || '',
    hourly: hourly.map((h) => ({
      ok: h.ok,
      fail: h.fail,
      retry: h.retry,
      dl: h.dl,
      avgMs: avg(h.msSum, h.msN),
      maxMs: h.maxMs,
    })),
    last1h: { ok: ok1, fail: fail1, retry: retry1 },
    last24h: { ok: ok24, fail: fail24, retry: retry24, dl: dl24, avgMs: avg(msSum24, msN24) },
    // 成功率按 24 小时算；没有样本时给 null，前端显示「—」而不是假的 100%
    successRate: ok24 + fail24 ? Math.round((ok24 / (ok24 + fail24)) * 1000) / 10 : null,
  };
}

function seedState() {
  const s = emptyState();
  // 自检任务打自己的健康检查接口；端口取实际监听端口，部署到任何环境都成立
  const self = `http://127.0.0.1:${PORT}/api/health`;
  s.tasks.push({
    id: uid('task'),
    name: '服务健康自检（每小时）',
    type: 'http',
    enabled: true,
    schedule: { mode: 'interval', everyMinutes: 60, cron: '0 * * * *' },
    config: { url: self, method: 'GET', headers: '', body: '', expectStatus: 200, timeoutSec: 15 },
    lastRun: null,
    lastResult: null,
    runCount: 0,
    failCount: 0,
    createdAt: nowISO(),
  });
  s.tasks.push({
    id: uid('task'),
    name: '工作日站会提醒',
    type: 'remind',
    enabled: true,
    schedule: { mode: 'cron', everyMinutes: 60, cron: '0 9 * * 1-5' },
    config: { message: '该开站会了，准备一下昨天完成的、今天要做的、以及卡住的事。', channels: ['inapp'] },
    lastRun: null,
    lastResult: null,
    runCount: 0,
    failCount: 0,
    createdAt: nowISO(),
  });
  for (const t of s.tasks) t.nextRun = computeNextRun(t, new Date())?.toISOString() || null;
  return s;
}

/* ---------------------------------------------------------------- cron */

function parseField(field, min, max, name) {
  const out = new Set();
  for (const partRaw of String(field).split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    let step = 1;
    let range = part;
    const slash = part.split('/');
    if (slash.length === 2) {
      range = slash[0];
      step = Number(slash[1]);
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name} 步长非法: ${part}`);
    } else if (slash.length > 2) {
      throw new Error(`cron ${name} 字段非法: ${part}`);
    }
    let lo, hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = slash.length === 2 ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`cron ${name} 含非数字: ${part}`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${name} 超出范围 ${min}-${max}: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron ${name} 为空`);
  return out;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  const minute = parseField(parts[0], 0, 59, '分钟');
  const hour = parseField(parts[1], 0, 23, '小时');
  const dom = parseField(parts[2], 1, 31, '日');
  const month = parseField(parts[3], 1, 12, '月');
  const dowRaw = parseField(parts[4], 0, 7, '周');
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  const domRestricted = parts[2].trim() !== '*';
  const dowRestricted = parts[4].trim() !== '*';
  return { minute, hour, dom, month, dow, domRestricted, dowRestricted };
}

function matchesCron(d, p) {
  if (!p.minute.has(d.getMinutes())) return false;
  if (!p.hour.has(d.getHours())) return false;
  if (!p.month.has(d.getMonth() + 1)) return false;
  const domOk = p.dom.has(d.getDate());
  const dowOk = p.dow.has(d.getDay());
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true;
}

/** 从 from 之后开始，逐分钟寻找下一次匹配；上限 366 天。 */
function nextCronRun(expr, from) {
  let p;
  try {
    p = parseCron(expr);
  } catch {
    return null;
  }
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(d, p)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** 一个任务最多能配几个节奏（09:00 一次、12:00 再一次这种）。 */
const SCHED_MAX = 6;

/**
 * 间隔节奏的单位。换算成「分钟」镜像字段 everyMinutes 是刻意保留的：
 * 老任务只有 everyMinutes，调度/预览/导出都读它，新增单位不能把老数据甩下车。
 * 月按 30 天计（自然月长短不一，固定周期才不会越跑越飘），UI 上如实标注。
 */
const INTERVAL_UNITS = {
  minute: { minutes: 1, max: 10080 },
  hour: { minutes: 60, max: 8760 },
  day: { minutes: 1440, max: 366 },
  week: { minutes: 10080, max: 52 },
  month: { minutes: 43200, max: 12 },
};

/** 归一化单个节奏：cron 非法时抛 400 级错误，由统一出口转成可读提示（别落到 500）。 */
function normalizeSchedule(s) {
  const src = s || {};
  if (src.mode === 'interval') {
    const unit = Object.prototype.hasOwnProperty.call(INTERVAL_UNITS, src.unit) ? src.unit : 'minute';
    const spec = INTERVAL_UNITS[unit];
    // 老前端只带 everyMinutes：换算回「分钟」单位，行为跟改版前完全一致
    const raw = src.every != null ? Number(src.every) : Number(src.everyMinutes) / spec.minutes;
    const every = Math.min(spec.max, Math.max(1, Math.round(raw || 1)));
    const everyMinutes = Math.min(366 * 24 * 60, Math.max(1, every * spec.minutes));
    const rawStart = String(src.startAt || '').trim();
    const startAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawStart)
      && !Number.isNaN(new Date(rawStart).getTime()) ? rawStart : '';
    return { mode: 'interval', every, unit, startAt, everyMinutes };
  }
  const cron = String(src.cron || '0 9 * * *').trim().replace(/\s+/g, ' ');
  try {
    parseCron(cron);
  } catch (e) {
    const err = new Error(`节奏表达式不合法（${cron}）：${e.message || '请按「分 时 日 月 周」填写'}`);
    err.httpStatus = 400;
    throw err;
  }
  return { mode: 'cron', cron };
}

/** 任务的节奏列表：优先读新字段 schedules，老任务回落到单个 schedule。 */
function taskSchedules(task) {
  const arr = Array.isArray(task && task.schedules) && task.schedules.length
    ? task.schedules
    : [task && task.schedule].filter(Boolean);
  return arr.length ? arr : [{ mode: 'cron', cron: '0 9 * * *' }];
}

/** 单个节奏的下一次执行时间。 */
function nextRunOf(sched, from) {
  const base = from || new Date();
  if (sched.mode === 'interval') {
    const period = Math.max(1, Number(sched.everyMinutes) || 60) * 60000;
    const anchor = sched.startAt ? new Date(sched.startAt) : null;
    if (anchor && !Number.isNaN(anchor.getTime())) {
      // 有「开始时间」就从那个点起算：没到点 = 首次执行；过了就跳到之后的第 k 个周期，
      // 不会因为服务重启/补跑把节奏整体往后推。
      if (anchor.getTime() > base.getTime()) return anchor;
      const k = Math.floor((base.getTime() - anchor.getTime()) / period) + 1;
      return new Date(anchor.getTime() + k * period);
    }
    return new Date(base.getTime() + period);
  }
  return nextCronRun(sched.cron, base);
}

/** 未来 N 次执行时间：列表里「接下来：…」用。 */
function nextRunsOf(sched, from, count = 3) {
  const out = [];
  let cursor = from || new Date();
  for (let i = 0; i < count; i++) {
    const n = nextRunOf(sched, cursor);
    if (!n) break;
    out.push(n.toISOString());
    cursor = n;
  }
  return out;
}

/** 多节奏任务取「所有节奏里最近的一次」。 */
function computeNextRun(task, from) {
  const fromD = from || new Date();
  let best = null;
  for (const sched of taskSchedules(task)) {
    const n = nextRunOf(sched, fromD);
    if (n && (!best || n < best)) best = n;
  }
  return best;
}

/* ---------------------------------------------------------------- 通知通道 */

function pushNotification({ level = 'info', title, body, source = 'system', taskName = '', trigger = '', channels = null, deadLetterId = '', aiNote = '', rawBody = '' }) {
  const item = { id: uid('ntf'), level, title, body, source, taskName, trigger, at: nowISO(), read: false };
  if (channels) item.channels = channels;
  if (aiNote) item.aiNote = aiNote;
  // AI 改写前的原文，仅在与最终正文不同时保留（相等时白占体积）
  if (rawBody && rawBody !== body) item.rawBody = rawBody;
  // 死信通知带上源条目 id，前端才能在卡片上直接给「重放」
  if (deadLetterId) item.deadLetterId = deadLetterId;
  state.notifications.unshift(item);
  if (state.notifications.length > 200) state.notifications.length = 200;
  saveState();
  return item;
}

/** 取 URL 的 host；解析不了返回空串（当作"只填了网关根域"处理） */
function hostOf(u) {
  try { return new URL(String(u)).host; } catch { return ''; }
}

async function sendWebhook(cfg, payload) {
  const scheme = cfg ? whSchemeName(cfg.format) : 'Webhook';
  if (!cfg || !cfg.enabled) return { ok: false, skipped: true, message: `${scheme} 未启用` };
  /*
   * NotifyMe 的网关地址能按凭据类型推导（UUID → 新版，FCM → 旧版），所以地址允许留空；
   * 其他格式的地址就是必填，空地址直接跳过，别白发一次空请求。
   */
  if (!cfg.url && (cfg.format || 'generic') !== 'notifyme') {
    return { ok: false, skipped: true, message: `${scheme} 地址为空` };
  }
  const title = payload.title || 'CronHub 提醒';
  const body = payload.body || '';
  let url = cfg.url;
  let init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const format = cfg.format || 'generic';

  if (format === 'feishu') {
    init.body = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${body}` } });
  } else if (format === 'dingtalk') {
    init.body = JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}` } });
  } else if (format === 'notifyme') {
    /*
     * NotifyMe 两套凭据互不通用：UUID 打新版端点，FCM token 打旧版端点。
     * 混搭的典型症状是 400 invalid UUID（网关拿 token 当 UUID 解析）。
     * 现在 UI 把两种凭据分成两个字段，这里按「哪个填了用哪个」决定：
     *   uuid 有值 → 新版端点；fcm 有值 → 旧版端点；都没有则回退老的 token 字段，
     *   仍按形态（含不含冒号）自动判断，保证旧配置不改也能继续发。
     *
     * 请求体统一交给 buildNotifyMePayload 拼：以前这里手写一份简化版，
     * 结果 webhook 路径永远拿不到 bigText/点击动作/紧急这些高级选项 ——
     * 同一个出口两套拼装，是「设置里配了却不生效」的经典来源。
     */
    const uuid = String(cfg.uuid || '').trim();
    const fcm = String(cfg.fcm || '').trim();
    const legacy = String(cfg.token || '').trim();
    if (uuid && fcm) throw new Error('NotifyMe 的 UUID 与 FCM token 只能填一个');
    const cred = uuid || fcm || legacy;
    if (!cred) throw new Error('NotifyMe 格式要填凭据：UUID（22 位）或 FCM token（含冒号）');
    const isUuid = uuid ? true : (fcm ? false : !cred.includes(':'));
    const host = hostOf(url);
    const gatewayHost = !host || /notifyme/i.test(host);
    if (isUuid) {
      if (gatewayHost) url = NOTIFYME_UUID_ENDPOINT;
    } else if (gatewayHost) {
      url = NOTIFYME_TOKEN_ENDPOINTS[0];
    }
    const wire = isUuid ? { ...cfg, mode: 'uuid', uuid: cred } : { ...cfg, mode: 'token', token: cred };
    init.body = JSON.stringify(buildNotifyMePayload(wire, payload));
  } else if (format === 'serverchan') {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams({ title, desp: body }).toString();
  } else if (format === 'bark') {
    url = url.replace(/\/+$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
    init = { method: 'GET' };
  } else {
    init.body = JSON.stringify({ title, body, at: payload.at || nowISO(), source: payload.source || 'cronhub' });
  }

  // 可选鉴权：配置了 token 就加 Authorization 头（notifyme 格式的 token 在信封里，不走头）
  if (cfg.token && format !== 'notifyme') {
    init.headers = { ...(init.headers || {}), Authorization: `Bearer ${cfg.token}` };
  }

  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = (await res.text().catch(() => '')).slice(0, 200);
  if (!res.ok) {
    let hint = '';
    if (/invalid UUID/i.test(text)) {
      hint = '（凭据与端点不匹配：UUID 走新版网关 notifyme-server，FCM token 走旧版 send-notifyme，两套不通用；现已自动纠正，请保存后再试）';
    }
    throw new Error(`${scheme} 返回 ${res.status} ${text}${hint}`);
  }
  return { ok: true, message: `${scheme} 已送达（${res.status}）` };
}

/* ---------------------------------------------------------------- NotifyMe 推送 */

/*
 * NotifyMe 是第三方中转（手机装 NotifyMe App），国内网络可直连，不需要自建 FCM 项目。
 * 两种凭据、两个端点，请求体结构互不通用：
 *   uuid  → 新版端点，data.data 里除 title/body 外还支持 markdown/urgent/callback 等
 *   token → 旧版 FCM legacy 结构，data 第一层必须带 to 与 priority，ttl 必须是整数
 *
 * 必须显式给浏览器 UA：NotifyMe 前置 Cloudflare，缺 UA 会被拦成 403 error code 1010，
 * 请求根本到不了业务层。这也是不能用 Node 默认 UA 的原因。
 */
const NOTIFYME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const NOTIFYME_UUID_ENDPOINT = 'https://notifyme-server.wzn556.top';
const NOTIFYME_TOKEN_ENDPOINTS = [
  'https://send-notifyme.521933.xyz',
  'https://send.notifyme-f7507.521933.xyz',
  'https://send1.notifyme-f7507.521933.xyz',
];

/** 按模式构造 NotifyMe 请求体。md 为详情页 markdown（可选）。 */
/* ---------------------------------------------------------------- 凭据自动续期 */

/*
 * WorkBuddy 的 accessToken 有效期 30 天，refreshToken 60 天且每次刷新会轮换。
 * 如果把 accessToken 硬编码进任务 headers，30 天后所有任务会一起 401 —— 这几乎是
 * 必然会踩到的坑。这里改成「存 refreshToken，执行前按需换新 accessToken」：
 *   - 任务 headers 里写 {{ACCESS_TOKEN}}，运行时替换成当前有效的 accessToken；
 *   - 距过期不足 1 天时自动刷新，刷出来的新 refreshToken 立即回写，滚动续命；
 *   - 刷新失败时用旧 accessToken 兜底，任务报错信息里会点明是凭据问题。
 */
const TOKEN_PLACEHOLDER = '{{ACCESS_TOKEN}}';
const TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // 提前 1 天换新

function tokenVault() {
  return { ...DEFAULT_SETTINGS.tokenVault, ...(state.settings.tokenVault || {}) };
}

/** 从 JWT 的 exp 字段读过期时间；读不出就返回 0（当作已过期处理）。 */
function jwtExpiry(tok) {
  try {
    const part = String(tok || '').split('.')[1];
    if (!part) return 0;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json.exp) > 0 ? Number(json.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

/** 用 refreshToken 换一对新的 access/refresh token。失败抛错。 */
async function refreshAccessToken(cfg) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Refresh-Token': cfg.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': 'copilot.tencent.com',
    },
    body: '{}',
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => '');
  let json = {};
  try { json = JSON.parse(text); } catch { /* 非 JSON 应答 */ }
  if (!res.ok || json.code !== 0 || !json.data || !json.data.accessToken) {
    throw new Error(`续期失败 HTTP ${res.status} ${json.msg || text.slice(0, 120) || '(空响应)'}`);
  }
  const d = json.data;
  const v = tokenVault();
  v.accessToken = d.accessToken;
  v.accessExpiresAt = jwtExpiry(d.accessToken) || Date.now() + (Number(d.expiresIn) || 0) * 1000;
  // refreshToken 会轮换，必须回写，否则用旧的会失效
  if (d.refreshToken && d.refreshToken !== v.refreshToken) v.refreshToken = d.refreshToken;
  v.refreshExpiresAt = Date.now() + (Number(d.refreshExpiresIn) || 0) * 1000;
  state.settings.tokenVault = v;
  saveState();
  return v.accessToken;
}

/** 拿到当前可用的 accessToken：够用就直接返回，快过期/已过期则先续期。 */
async function currentAccessToken(force = false) {
  const v = tokenVault();
  if (!v.enabled || !v.refreshToken) return '';
  const stillGood = v.accessToken && v.accessExpiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
  if (stillGood && !force) return v.accessToken;
  try {
    return await refreshAccessToken(v);
  } catch (err) {
    if (v.accessToken) {
      console.error('[token] 续期失败，沿用旧凭据:', err.message);
      return v.accessToken;
    }
    throw err;
  }
}

/** 把 headers 里的 {{ACCESS_TOKEN}} 占位符换成真实凭据。 */
function applyTokenPlaceholder(headersStr) {
  const raw = String(headersStr || '');
  if (!raw.includes(TOKEN_PLACEHOLDER)) return raw;
  const v = tokenVault();
  if (!v.enabled) return raw.replace(TOKEN_PLACEHOLDER, '');
  if (!v.accessToken) return raw; // 留给 runHttpTask 报出可读的错误
  return raw.split(TOKEN_PLACEHOLDER).join(v.accessToken);
}

/** 这个任务（含各步骤）是否用到凭据占位符。 */
function usesTokenPlaceholder(task) {
  const cfg = (task && task.config) || {};
  const all = Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : [cfg];
  return all.some((s) => String((s && s.headers) || '').includes(TOKEN_PLACEHOLDER));
}

/* ---------------------------------------------------------------- 环境变量（青龙面板式） */

/** 清洗环境变量数组：key 合法、值限长，非法项丢弃。 */
function sanitizeEnvVars(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => ({
      key: String((v && v.key) || '').trim().toUpperCase().replace(/[^\w]/g, ''),
      value: String((v && v.value) ?? ''),
      note: String((v && v.note) || '').slice(0, 100),
      enabled: !!(v && v.enabled),
    }))
    .filter((v) => v.key)
    .slice(0, 100);
}

/** 把 {{KEY}} 占位符换成环境变量值（仅启用的变量；KEY 不区分大小写）。 */
function applyEnvVars(str) {
  const raw = String(str || '');
  if (!raw.includes('{{')) return raw;
  const map = new Map();
  for (const v of state.settings.envVars || []) {
    if (v.enabled && v.value != null) map.set(v.key.toUpperCase(), v.value);
  }
  if (!map.size) return raw;
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (map.has(key.toUpperCase()) ? map.get(key.toUpperCase()) : m));
}

/* ---------------------------------------------------------------- NotifyMe 手机推送 */

/** 点击动作白名单：0 不动作 / 1 打开链接 / 2 打开应用 / 4 复制到剪贴板 / 5 提取验证码。 */
const NM_ACTIONS = [0, 1, 2, 4, 5];
function nmActionType(v) {
  const n = Number(v);
  return NM_ACTIONS.includes(n) ? n : 0;
}

/*
 * NotifyMe 的「高级选项」统一在这里读。两条路径（webhook 的 notifyme 格式、
 * 独立的 notifyme 通道）字段名一致，所以发送层只需要一个函数。
 */
function nmAdvanced(cfg) {
  const c = cfg || {};
  return {
    bigText: c.bigText !== false,
    actionType: nmActionType(c.actionType),
    action: String(c.action || '').trim(),
    group: String(c.group || '').trim(),
    urgent: c.urgent === true,
  };
}

/**
 * 任务级覆盖：任务里单独设了就用任务的，没设的跟随全局。
 *
 * 为什么要有：同一个任务可能「成功时点开看报表」而别的任务「不需要点击」，
 * 全局只有一个值就必然有一边被将就。空串 / 0 / undefined 一律视为「没设」，
 * 这样用户清空任务里的输入框就能回退到全局值，而不用猜哪个才是默认。
 */
function nmForTask(base, task) {
  const o = (task && task.config && task.config.nmPush) || null;
  if (!o || typeof o !== 'object') return nmAdvanced(base);
  const g = nmAdvanced(base);
  const pick = (k, dflt) => (o[k] === undefined || o[k] === null || o[k] === '' ? dflt : o[k]);
  return {
    bigText: pick('bigText', g.bigText) !== false,
    actionType: o.actionType === undefined || o.actionType === '' ? g.actionType : nmActionType(o.actionType),
    action: String(pick('action', g.action)).trim(),
    group: String(pick('group', g.group)).trim(),
    urgent: o.urgent === undefined ? g.urgent : o.urgent === true,
  };
}

function buildNotifyMePayload(cfg, { title, body, markdown, nm }) {
  const mode = cfg.mode === 'uuid' ? 'uuid' : 'token';
  const adv = nm || nmAdvanced(cfg);
  const inner = { title: String(title || 'CronHub'), body: String(body || '') };
  if (markdown) inner.markdown = String(markdown);
  // 不带 group = 每条独立占一行；带了同组名 Android 会折成一条摘要
  if (adv.group) inner.group = adv.group;
  inner.bigText = adv.bigText;
  if (adv.actionType) {
    inner.actionType = adv.actionType;
    // 5（提取验证码）从正文抓数字，不需要 action；其余动作必须带目标值，
    // 否则手机点了没反应 —— 与其发一条点了没用的通知，不如不发这个字段。
    if (adv.actionType !== 5 && adv.action) inner.action = adv.action;
  }
  if (adv.urgent) {
    inner.urgent = true;
    inner.channel = 'quicker_channel'; // 持续响铃依赖该通道
  }

  if (mode === 'uuid') {
    return { data: { uuid: cfg.uuid, ttl: 86400, priority: 'high', data: inner } };
  }
  return {
    data: {
      to: cfg.token,
      pushType: 'fcm',
      priority: 'high',
      ttl: 86400, // 必须是整数秒，字符串会让 FCM 报 failed to parse seconds
      data: inner,
    },
  };
}

/** 发一条手机推送。返回 { ok, message }；失败不抛错，由调用方决定是否记录。 */
async function sendNotifyMe(cfg, msg) {
  if (!cfg || !cfg.enabled) return { ok: false, skipped: true, message: 'NotifyMe 未启用' };
  const mode = cfg.mode === 'uuid' ? 'uuid' : 'token';
  const cred = mode === 'uuid' ? cfg.uuid : cfg.token;
  if (!cred) return { ok: false, skipped: true, message: `NotifyMe 未配置 ${mode} 凭据` };

  const payload = buildNotifyMePayload(cfg, msg);
  // uuid 只有单一端点；token 主域名网络不通时依次回退备用域名
  const urls = mode === 'uuid' ? [NOTIFYME_UUID_ENDPOINT] : NOTIFYME_TOKEN_ENDPOINTS;

  let lastErr = '';
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': NOTIFYME_UA },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // 网络层失败（超时 / DNS / 连接被拒）才换下一个端点
      lastErr = (err.cause && (err.cause.code || err.cause.message)) || err.message || '网络异常';
      continue;
    }
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (!res.ok) {
      lastErr = `HTTP ${res.status} ${text}`;
      // 服务端已应答（说明端点可达），不再换域名；但 5xx 值得重试一次备用域名
      if (res.status < 500) break;
      continue;
    }
    // 服务端受理 ≠ 手机收到。这里只能说「已提交」。
    return { ok: true, message: `已提交 NotifyMe（${res.status}，需手机侧确认收到）` };
  }
  throw new Error(`NotifyMe 推送失败：${lastErr}`);
}

/* ------------------------------------------------ 通知渠道多实例 */

const CH_TYPES = ['sms', 'webhook', 'email', 'ai'];
const CH_LABEL = { sms: '短信', webhook: 'Webhook', email: '邮件', ai: 'AI' };

/*
 * Webhook 只是「容器」，真正发给谁由 format 决定。
 * 设置页保留 Webhook 这个名字（那里本来就是在填地址/凭据），但**对外一律用方案名**：
 * 任务渠道勾选、通知记录的渠道名、系统日志、死信标签 —— 用户看到「NotifyMe」
 * 才知道这条消息是从哪条路走的，看到「Webhook」等于什么都没说。
 */
const WH_SCHEME = {
  notifyme: 'NotifyMe（手机推送）',
  generic: '通用 JSON',
  serverchan: 'Server酱',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  bark: 'Bark (iOS)',
};
function whSchemeName(format) {
  const f = String(format || 'generic');
  return WH_SCHEME[f] || WH_SCHEME.generic;
}
/** 各渠道里属于「凭证」的字段：新建账号时只抄配置、不抄这些。 */
const CH_SECRET_FIELDS = { sms: [], webhook: ['token', 'uuid', 'fcm'], email: ['pass'], ai: ['apiKey'] };
const CI_ID_RE = /^ci_[0-9a-f]{6,20}$/;

/** 某个渠道已有的实例列表（不含「默认」那套，默认仍存在 settings 里）。 */
function channelInstances(type) {
  const all = (state.settings && state.settings.channelInstances) || {};
  return CH_TYPES.includes(type) && Array.isArray(all[type]) ? all[type] : [];
}

function findChannelInstance(type, id) {
  return channelInstances(type).find((x) => x.id === id) || null;
}

/** 渠道配置底稿：新建实例、以及「默认」标签缺字段时的补全都用它。 */
function defaultChannelConfig(type) {
  if (type === 'webhook') {
    return {
      enabled: false, format: 'generic', url: '', token: '', uuid: '', fcm: '',
      bigText: true, actionType: 0, action: '', group: '', urgent: false,
    };
  }
  if (type === 'email') return { enabled: false, host: '', port: 465, user: '', pass: '', from: '', to: '' };
  if (type === 'ai') return { enabled: false, baseUrl: '', provider: '', apiKey: '', model: '', defaultPrompt: '' };
  return { enabled: false };
}

/**
 * 渠道上展示的名字：默认标签用 channelMarks 里的标识，没写就只显示渠道名。
 * Webhook 例外：显示它当前配置的方案名（NotifyMe / Bark / 飞书…），
 * 传 cfg 才能拿到 format；不传时退回「Webhook」。
 */
function channelLabelOf(type, cfg) {
  const marks = (state.settings && state.settings.channelMarks) || {};
  const mark = String(marks[type] || '').trim();
  // 没传 cfg 说明调用方只想要标识（比如复制账号），此时没有 format 可判断，
  // 退回「Webhook」比猜成「通用 JSON」诚实
  const base = type === 'webhook'
    ? (cfg ? whSchemeName(cfg.format) : CH_LABEL.webhook)
    : CH_LABEL[type];
  return { mark, base, text: mark ? `${base}·${mark}` : base };
}

/** 取某套配置的原始值（不脱敏），复制实例时用。id 传 'main' 表示默认那套。 */
function rawChannelConfig(type, id) {
  if (!id || id === 'main') {
    const legacy = type === 'email' ? state.settings.smtp
      : type === 'webhook' ? state.settings.webhook
        : type === 'ai' ? state.settings.ai : state.settings.sms;
    return { ...defaultChannelConfig(type), ...(legacy || {}) };
  }
  const inst = findChannelInstance(type, id);
  if (!inst) return null;
  return { ...defaultChannelConfig(type), ...(inst.config || {}) };
}

/**
 * 解析渠道标识，返回最终生效的配置。
 *   'sms' / 'webhook' / 'email'  → 默认那套（沿用老字段 settings.webhook 等）
 *   'webhook:ci_ab12...'         → 指定实例，配置取实例自己的，缺字段用底稿补
 */
function resolveChannel(ch) {
  const raw = String(ch || '');
  const idx = raw.indexOf(':');
  const type = idx >= 0 ? raw.slice(0, idx) : raw;
  const instId = idx >= 0 ? raw.slice(idx + 1) : '';
  if (!CH_TYPES.includes(type)) return null;
  const base = defaultChannelConfig(type);
  if (!instId) {
    const legacy = type === 'email' ? state.settings.smtp
      : type === 'webhook' ? state.settings.webhook
        : type === 'ai' ? state.settings.ai : state.settings.sms;
    const cfg = { ...base, ...(legacy || {}) };
    return { type, instId: '', label: channelLabelOf(type, cfg).text, cfg };
  }
  const inst = findChannelInstance(type, instId);
  if (!inst) return { type, instId, label: `已删除的${CH_LABEL[type]}`, cfg: null, missing: true };
  const cfg = { ...base, ...(inst.config || {}) };
  // Webhook 实例也显示方案名，多套按出现顺序编号（NotifyMe 2 / Bark (iOS) 2 …）
  const baseName = type === 'webhook' ? whSchemeName(cfg.format) : CH_LABEL[type];
  const nth = type === 'webhook' ? channelInstances('webhook').indexOf(inst) + 2 : 0;
  const label = inst.remark
    ? `${baseName}·${inst.remark}`
    : (nth ? `${baseName} ${nth}` : `${baseName} ${instId.slice(-4)}`);
  // 短信凭据全局共用，实例只决定「发不发」+ 备注名
  const legacy = type === 'sms' ? state.settings.sms : null;
  return { type, instId, label, cfg: { ...cfg, ...(legacy || {}) }, enabled: inst.enabled !== false };
}

/** 渠道此刻是否可发：默认标签看自己的开关，实例看实例开关。 */
function channelReady(ch) {
  const rc = resolveChannel(ch);
  if (!rc || !rc.cfg) return false;
  if (rc.instId) return rc.enabled !== false;
  return !!rc.cfg.enabled;
}

/** 统一渠道清单清洗：允许 inapp / notifyme / type / type:实例id。 */
function sanitizeChannelList(list) {
  const raw = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const c = String(item || '').trim();
    if (!c || seen.has(c)) continue;
    if (c === 'inapp' || c === 'notifyme') { seen.add(c); out.push(c); continue; }
    const m = c.match(/^(sms|webhook|email)(?::([A-Za-z0-9_]+))?$/);
    if (!m) continue;
    if (m[2] && !CI_ID_RE.test(m[2])) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/** 站内通知必选：不管怎么组合，都补上 inapp 并放在第一位。 */
function withInapp(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes('inapp') ? arr : ['inapp', ...arr];
}

/** 渠道实例配置清洗（保存设置时用）。 */
function sanitizeChannelInstances(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const type of CH_TYPES) {
    const list = Array.isArray(src[type]) ? src[type] : [];
    const seen = new Set();
    out[type] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      let id = String(item.id || '').trim();
      if (!CI_ID_RE.test(id) || seen.has(id)) id = 'ci_' + crypto.randomBytes(6).toString('hex');
      if (seen.has(id)) continue;
      seen.add(id);
      const cfg = { ...defaultChannelConfig(type), ...(item.config && typeof item.config === 'object' ? item.config : {}) };
      const prev = findChannelInstance(type, id);
      if (type === 'webhook') {
        cfg.enabled = !!cfg.enabled;
        cfg.format = ['notifyme', 'generic', 'serverchan', 'feishu', 'dingtalk', 'bark'].includes(cfg.format) ? cfg.format : 'generic';
        cfg.url = String(cfg.url || '').trim();
        cfg.token = String(cfg.token || '').trim();
        if (isMaskedValue(cfg.token)) cfg.token = (prev && prev.config && prev.config.token) || '';
        // NotifyMe 两套凭据分列存放，混在一个 token 里最容易填错
        cfg.uuid = String(cfg.uuid || '').trim();
        cfg.fcm = String(cfg.fcm || '').trim();
        if (isMaskedValue(cfg.uuid)) cfg.uuid = (prev && prev.config && prev.config.uuid) || '';
        if (isMaskedValue(cfg.fcm)) cfg.fcm = (prev && prev.config && prev.config.fcm) || '';
        // NotifyMe 高级选项随实例走（每套账号可以有不同的点击动作/分组）
        cfg.bigText = cfg.bigText !== false;
        cfg.actionType = nmActionType(cfg.actionType);
        cfg.action = String(cfg.action || '').slice(0, 500);
        cfg.group = String(cfg.group || '').slice(0, 32);
        cfg.urgent = cfg.urgent === true;
      } else if (type === 'email') {
        cfg.enabled = !!cfg.enabled;
        cfg.host = String(cfg.host || '').trim();
        cfg.port = Math.max(1, Number(cfg.port) || 465);
        cfg.user = String(cfg.user || '').trim();
        cfg.pass = String(cfg.pass || '');
        if (cfg.pass === '••••••' || isMaskedValue(cfg.pass)) cfg.pass = (prev && prev.config && prev.config.pass) || '';
        cfg.from = String(cfg.from || '').trim();
        cfg.to = String(cfg.to || '').trim();
      } else if (type === 'ai') {
        cfg.enabled = !!cfg.enabled;
        cfg.baseUrl = String(cfg.baseUrl || '').trim();
        cfg.provider = String(cfg.provider || '').trim();
        cfg.apiKey = String(cfg.apiKey || '');
        if (isMaskedValue(cfg.apiKey)) cfg.apiKey = (prev && prev.config && prev.config.apiKey) || '';
        cfg.model = String(cfg.model || '').trim();
        // 全局默认是「补充」，500 字连一条完整的播报规范都放不下（线上已写到 106 字
        // 只够三句）。放到 2000，允许把「先结论后细节」这类通用规范写全。
        cfg.defaultPrompt = String(cfg.defaultPrompt || '').slice(0, AI_DEFAULT_PROMPT_MAX);
        // 每个 AI 账号可以有自己的超时/重试；没填就留空，运行时跟随全局默认值
        if (cfg.timeoutMs !== undefined && cfg.timeoutMs !== '') {
          cfg.timeoutMs = Math.min(AI_TIMEOUT_MAX, Math.max(AI_TIMEOUT_MIN, Number(cfg.timeoutMs) || AI_TIMEOUT_MS));
        } else { delete cfg.timeoutMs; }
        if (cfg.maxAttempts !== undefined && cfg.maxAttempts !== '') {
          cfg.maxAttempts = Math.min(AI_ATTEMPTS_MAX, Math.max(1, Number(cfg.maxAttempts) || AI_MAX_ATTEMPTS));
        } else { delete cfg.maxAttempts; }
      } else {
        cfg.enabled = !!cfg.enabled;
      }
      out[type].push({
        id,
        remark: String(item.remark || '').slice(0, 24) || `${CH_LABEL[type]} ${out[type].length + 2}`,
        enabled: item.enabled !== false,
        config: cfg,
      });
    }
    if (out[type].length > 12) out[type] = out[type].slice(0, 12);
  }
  return out;
}

/** 接口回显前脱敏：实例里的 token / pass / apiKey 一律打码。 */
function maskChannelInstances(ci, plain) {
  const src = ci && typeof ci === 'object' ? ci : {};
  const out = {};
  for (const type of CH_TYPES) {
    out[type] = (Array.isArray(src[type]) ? src[type] : []).map((inst) => {
      const cfg = { ...(inst.config || {}) };
      if (!plain) {
        if (cfg.token) cfg.token = maskSecret(cfg.token);
        if (cfg.uuid) cfg.uuid = maskSecret(cfg.uuid);
        if (cfg.fcm) cfg.fcm = maskSecret(cfg.fcm);
        if (cfg.pass) cfg.pass = '••••••';
        if (cfg.apiKey) cfg.apiKey = maskSecret(cfg.apiKey);
      }
      return { ...inst, config: cfg };
    });
  }
  return out;
}

/* ---------------------------------------------------------------- 推送重试与死信 */

/*
 * 判断一次失败值不值得再试。
 *
 * 推送失败分两类，混在一起处理是错的：
 *   ① 这一秒没送达，下一秒可能行 —— 网络抖动、超时、被限流、对方 5xx；
 *   ② 怎么试都不行 —— 地址写错、token 失效（4xx）、渠道没启用。
 * 对 ② 重试只是白烧短信条数（短信按条计费），所以只对 ① 重试。
 * 短信渠道例外：lib/sms 有自己的退避重试 + 死信，这里再套一层就会发出多条。
 */
function retryableFailure(message) {
  const m = String(message || '');
  if (!m) return false;
  if (/返回 4\d\d/.test(m) && !/返回 429/.test(m)) return false;
  if (/未启用|未配置|配置已删除|不支持的渠道|要填凭据|缺少|格式/.test(m)) return false;
  return /超时|timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|fetch failed|返回 5\d\d|返回 429/i.test(m);
}

const DEAD_LETTER_MAX = 50;

/** 推送三次都没送出去：留一份完整载荷，站内通知也记一条，免得静默丢消息。 */
function pushDeadLetter({ channel, label, title, body, markdown, message, attempts, taskName }) {
  if (!Array.isArray(state.deadLetters)) state.deadLetters = [];
  const entry = {
    id: uid('dl'),
    at: nowISO(),
    channel,
    label,
    title: String(title || ''),
    body: String(body || ''),
    markdown: String(markdown || ''),
    message: String(message || '').slice(0, 400),
    attempts: Number(attempts) || 0,
    taskName: String(taskName || ''),
  };
  state.deadLetters.unshift(entry);
  if (state.deadLetters.length > DEAD_LETTER_MAX) state.deadLetters.length = DEAD_LETTER_MAX;
  pushNotification({
    level: 'error',
    title: `📮 投递失败：${label}`,
    body: `${entry.taskName ? '任务「' + entry.taskName + '」的通知' : '一条通知'}向 ${label} 发送 ${entry.attempts} 次都没成功，已存入死信队列等待重放。\n原因：${entry.message}`,
    source: 'deadletter',
    deadLetterId: entry.id,
  });
  pushSysLog({
    level: 'error',
    source: 'channel',
    msg: `推送重试 ${entry.attempts} 次仍失败，已入死信：${label} · ${entry.message.slice(0, 150)}`,
    detail: { channel: entry.channel, label, taskName: entry.taskName, attempts: entry.attempts },
  });
  recordMetric('dl');
  checkDeadLetterWatermark();
  return entry;
}

/*
 * 死信水位告警（第十八批）。
 *
 * 死信队列以前是「只进不出、无人看」：每失败一条就推一条站内通知，混在几十条正常通知里，
 * 真到「短信通道整体挂了、一晚上堆了 20 条」时，反而没人能判断这是故障还是偶然。
 * 这里按水位分档，跨档才推一次手机告警，档位写进 state 跨重启记忆（否则每次重启都重发）。
 * 队列被清空或重放降到低水位时档位归零，下一次堆积能重新提醒。
 */
const DL_ALERT_STEPS = [5, 10, 20, 35, 50];

function checkDeadLetterWatermark() {
  try {
    const n = (state.deadLetters || []).length;
    if (!n) {
      state.deadLetterAlert = 0;
      return;
    }
    let level = 0;
    for (const s of DL_ALERT_STEPS) if (n >= s) level = s;
    const prev = Number(state.deadLetterAlert) || 0;
    if (level <= prev) return;
    state.deadLetterAlert = level;
    const last = state.deadLetters[0] || {};
    pushNotification({
      level: 'error',
      title: `📮 死信堆积 ${n} 条（跨过 ${level} 档）`,
      body: `推送死信队列已堆到 ${n} 条（上限 ${DEAD_LETTER_MAX}），说明某个渠道在一段时间里持续送不出去。\n最近一条：${last.label || last.channel || '未知渠道'}${last.taskName ? ' · 任务「' + last.taskName + '」' : ''}\n原因：${String(last.message || '').slice(0, 200)}\n建议：确认该渠道凭据/额度是否正常，再到「死信」里重放或清空。`,
      source: 'deadletter',
    });
    pushSysLog({
      level: 'error',
      source: 'channel',
      msg: `死信堆积跨过 ${level} 档（当前 ${n} 条），已发水位告警`,
      detail: { count: n, level, lastChannel: last.channel || '', lastLabel: last.label || '' },
    });
  } catch (err) {
    console.error('[dead-letter] 水位检查失败（已忽略）:', err.message);
  }
}

/** 统一发送：payload = {title, body, markdown}。 */
async function sendChannel(rc, { title, body, markdown, level }, opt) {
  const cfg = rc.cfg || {};
  if (rc.type === 'sms') {
    // 短信的关键配置（分级 / 字数 / 操作链接）是设备级的，放 settings.sms；实例配置可覆盖分级
    const merged = { ...(state.settings.sms || {}), enabled: true };
    if (cfg && (cfg.minLevel === 'all' || cfg.minLevel === 'important')) merged.minLevel = cfg.minLevel;
    return sendSms(merged, { title, body, markdown, level }, opt);
  }
  if (rc.type === 'webhook') {
    // NotifyMe 任务级高级选项只对 notifyme 格式有意义；其他方案（Bark/飞书）没有这些字段
    const nm = String(cfg.format || '') === 'notifyme' ? nmForTask(cfg, opt && opt.task) : null;
    return sendWebhook(cfg, { title, body, markdown, source: 'cronhub', nm: nm || undefined });
  }
  if (rc.type === 'email') {
    return sendMail(cfg, {
      subject: title,
      text: [body, markdown].filter(Boolean).join('\n\n') + '\n\n—— 由 CronHub 定时发送',
    });
  }
  return { ok: false, message: `不支持的渠道 ${rc.type}` };
}

/** 任务事件是否该触发手机推送。 */
function notifyMePrefs() {
  const cfg = state.settings.notifyme || {};
  return { enabled: !!cfg.enabled, onFailure: cfg.onFailure !== false, onSuccess: !!cfg.onSuccess };
}

/**
 * 任务没点名渠道时的默认值。
 *
 * 站内是地板：消息无论如何都留一条在收件箱里，用户回来看得到。
 * 手机推送只在这个通道真的配好了（有开关 + 有凭据）时才默认带上——
 * 以前无脑给 ['inapp','notifyme']，结果是任务编辑页里「手机推送」常年勾着一条
 * 根本没配过的渠道，看着像残留。
 */
function defaultNotifyChannels() {
  const nm = (state.settings && state.settings.notifyme) || {};
  const list = ['inapp'];
  if (nm.enabled && (nm.uuid || nm.fcm)) list.push('notifyme');
  return list;
}

/**
 * 单个任务自己的通知策略。
 *
 * 三态设计（config.notify 缺省 = 跟随全局，保证老任务行为不变）：
 *   - 未设置      → 完全跟随设置页的全局开关
 *   - enabled:false → 这个任务不推，别的任务照旧
 *   - enabled:true  → 按任务自己的 onSuccess / onFailure 决定时机
 * 全局「启用手机推送」仍是总闸：它关掉时任何任务都不推（凭据也一并失效）。
 */
function taskNotifyPolicy(task) {
  const g = notifyMePrefs();
  const n = task && task.config && task.config.notify;
  // 渠道缺省 = 站内（+ 已配好的手机推送），不再默认塞一个没配过的通道进去
  if (!n || typeof n !== 'object') return { ...g, channels: defaultNotifyChannels() };
  if (n.enabled === false) return { enabled: false, onFailure: false, onSuccess: false, channels: [] };
  const cleaned = Array.isArray(n.channels) && n.channels.length ? sanitizeChannelList(n.channels) : [];
  const channels = cleaned.length ? withInapp(cleaned) : defaultNotifyChannels();
  return { enabled: g.enabled, onFailure: n.onFailure !== false, onSuccess: n.onSuccess !== false, channels };
}

/** 凭据脱敏：只露出头尾，避免整串明文出现在接口响应和页面里。 */
function maskSecret(s) {
  const v = String(s || '');
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** 掩码值识别：接口返回的脱敏串绝不能当真凭据写回存储（uuid/token/apiKey 共用）。 */
function isMaskedValue(v) {
  const s = String(v || '');
  return !s || s === '••••' || s === '••••••' || s.includes('…');
}

function maskNotifyMe(cfg) {
  const c = { ...DEFAULT_SETTINGS.notifyme, ...(cfg || {}) };
  return { ...c, uuid: maskSecret(c.uuid), token: maskSecret(c.token) };
}

/*
 * 设置项的**唯一**脱敏出口。
 *
 * 以前 publicState 直接 {...state.settings} 整体展开，只单独打了 smtp/notifyme/ai/
 * channelInstances 四个掩码 —— 剩下四个凭据原样下发给任何人（打开 F12 看 /api/state 就拿到）：
 *   webhook.token        —— 通知 webhook 的鉴权 token
 *   gatewaySms.token     —— 短信网关令牌（可代本机发短信）
 *   smsRelay.token       —— 短信转发中转令牌（可伪造上行短信）
 *   tokenVault.refreshToken —— 完整 JWT，等于整份账号凭据
 * 还有 envVars[].value（{{ACCESS_TOKEN}} 这类占位符的真值）和 smsActionToken
 * （能直接改退订/静音状态）属于同类问题。
 *
 * 现在所有出站设置一律过这里。要看明文必须走 POST /api/settings/reveal（管理口令）。
 * opts.admin 只影响唤醒令牌：它要复制给外部定时器用，非管理员没必要拿到。
 */
/*
 * 凭据下发策略：**默认打码**（第十六批改的默认值）。
 *
 * 之前的默认是明文摊开，理由是「这些凭据泄露了也能接受损失」。但站点是开放模式，
 * 链接一传出去，短信中继密钥、NotifyMe token、AI key 就直接出现在页面上；
 * 截图、录屏、共享屏幕时的意外泄露成本远高于「点一下眼睛」的操作成本。
 *
 * 现在的取舍：
 *   - /api/state 一律下发掩码，页面输入框留空 + 占位提示「已保存（已隐藏）」；
 *   - 要看真值走「显示」按钮 → POST /api/settings/reveal（失败计数与登录共用防爆破）；
 *   - 开放模式（没设管理口令）下 reveal 直接放行并记审计 —— 此时本来也没有口令可输；
 *   - 需要回到过去的明文体验：设 CRONHUB_CRED_MASK=0 重启即可，代码路径保留。
 */
const CRED_MASK = !/^(0|false|no|off)$/i.test(String(process.env.CRONHUB_CRED_MASK || '1'));

function maskSettings(st, opts) {
  const src = st && typeof st === 'object' ? st : {};
  const asAdmin = !!(opts && opts.admin);
  // 明文条件：管理员登录，或根本没开掩码
  const plain = asAdmin || !CRED_MASK;
  const M = (v) => (plain ? String(v || '') : maskSecret(v));
  const P = (v) => (plain ? String(v || '') : v ? '••••••' : '');

  const out = { ...src };
  const wb = src.webhook || {};
  out.webhook = { ...wb, token: M(wb.token), uuid: M(wb.uuid), fcm: M(wb.fcm) };
  const gw = src.gatewaySms || {};
  out.gatewaySms = { ...gw, token: M(gw.token) };
  const rl = src.smsRelay || {};
  out.smsRelay = { ...rl, token: M(rl.token) };
  const sgr = src.smsGatewayRelay || {};
  out.smsGatewayRelay = { ...sgr, secret: M(sgr.secret) };
  // 旧 state 里没有这个字段时也要有默认值，免得前端开关回显成 undefined
  out.smsGatewaySni = { ...DEFAULT_SETTINGS.smsGatewaySni, ...(src.smsGatewaySni || {}) };
  const tv = src.tokenVault || {};
  out.tokenVault = {
    ...tv,
    refreshToken: M(tv.refreshToken),
    accessToken: M(tv.accessToken),
  };
  const sm = src.smtp || {};
  out.smtp = { ...sm, pass: P(sm.pass) };
  const ai = src.ai || {};
  out.ai = { ...ai, apiKey: M(ai.apiKey) };
  out.notifyme = plain
    ? { ...DEFAULT_SETTINGS.notifyme, ...(src.notifyme || {}) }
    : maskNotifyMe(src.notifyme);
  out.channelInstances = maskChannelInstances(src.channelInstances, plain);
  out.envVars = (Array.isArray(src.envVars) ? src.envVars : [])
    .map((v) => ({ ...v, value: M(v && v.value) }));
  out.smsActionToken = M(src.smsActionToken);
  const wk = src.wake || {};
  out.wake = { ...wk, token: plain ? String(wk.token || '') : (wk.token ? '••••••' : '') };
  return out;
}

/* ---------------------------------------------------------------- 迷你 SMTP */

function createSmtpSession(socket) {
  let acc = '';
  let resolver = null;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    acc += chunk;
    flush();
  });

  function flush() {
    if (!resolver) return;
    let idx = 0;
    let end = -1;
    while (idx < acc.length) {
      const nl = acc.indexOf('\r\n', idx);
      if (nl === -1) break;
      const line = acc.slice(idx, nl);
      if (/^\d{3} /.test(line)) {
        end = nl + 2;
        break;
      }
      idx = nl + 2;
    }
    if (end !== -1) {
      const resp = acc.slice(0, end);
      acc = acc.slice(end);
      const r = resolver;
      resolver = null;
      r(resp);
      flush();
    }
  }

  function read() {
    return new Promise((res) => {
      resolver = res;
      flush();
    });
  }

  async function cmd(line) {
    socket.write(line + '\r\n');
    return read();
  }

  return { read, cmd };
}

/*
 * 短信通知：移植自 WorkBuddy「短信通知」skill（中国移动新消息/短信通道，仅限移动号码）。
 * lib/sms/ 里是原 skill 脚本（零外部依赖），这里以子进程调用——
 * stdout 里可能带手机号，本函数只解析成败、不落盘原文。
 */
const SMS_SCRIPT = path.join(ROOT, 'lib', 'sms', 'send.cjs');

/*
 * 短信发送中继连通性自检：只从本站服务端打中继的 /__probe，
 * 完全不碰 5gvas01 网关（不消耗网关请求、不带令牌、无发送副作用）。
 * 验证的是「云端 → Worker」这一跳；Worker → 网关由中继自己测并回传 result。
 */
/*
 * 中继健康快照（内存，不落盘）：中继是短信的唯一出口，一旦挂掉短信会全部静默失败，
 * 而 3 小时一次的自检最长要 3 小时才吭声。这里把「最近一次真实发送」和「最近一次探针」
 * 的结果留一份，随 /api/state 一起下发，设置页一眼就能看到中继是否还活着 —— 零额外请求。
 * 正向证据优先取真实发送（中继 + 网关 + 送达全通才算数）；负面证据只由探针提供，
 * 因为发送失败可能只是业务原因（额度、令牌），不能据此判定中继挂了。
 */
const relayHealth = { at: null, ok: null, ms: 0, src: '', status: 0, edge: '', error: '', via: '', timing: null, endpoints: 0, upCount: 0 };
function noteRelayHealth(patch) {
  Object.assign(relayHealth, patch, { at: nowISO() });
}

/*
 * 中继地址列表：`url` 是主地址（兼容老配置），`urls` 是备用地址列表。
 * 统一去重、只留 https origin —— 明文地址会让短信令牌在公网上裸奔，直接剔除。
 * 多个中继共用一个密钥（同一套 Worker 代码可以部署成多个 Pages 项目）。
 */
function relayEndpoints(cfg) {
  const c = cfg || state.settings.smsGatewayRelay || {};
  const raw = [];
  if (c.url) raw.push(c.url);
  if (Array.isArray(c.urls)) raw.push(...c.urls);
  else if (typeof c.urls === 'string') raw.push(...c.urls.split(/[,;\s]+/));
  const out = [];
  for (const item of raw) {
    const s = String(item || '').trim().replace(/\/+$/, '');
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:') continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch { /* 一条坏配置不该废掉整条链路，跳过继续 */ }
  }
  return out;
}

/**
 * 中继探活：多地址并行探，取最快可用的一条。
 * 这样「主中继挂了但备用还活着」在设置页上是可见的，而不是笼统一个红点。
 */
async function probeSmsRelay() {
  const cfg = state.settings.smsGatewayRelay || {};
  const eps = relayEndpoints(cfg);
  if (!eps.length) return { configured: false };
  const out = { configured: true, url: eps[0], urls: eps, enabled: !!cfg.enabled };
  const headers = cfg.secret ? { 'X-Relay-Secret': String(cfg.secret) } : {};
  const t0 = Date.now();
  const list = await Promise.all(eps.map(async (ep) => {
    const timing = {};
    const st = Date.now();
    try {
      const rr = await httpClient.request(new URL('/__probe', ep).toString(), {
        headers, timeoutMs: 15000, timing,
      });
      const txt = await rr.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch { /* 非 JSON 回原文片段 */ }
      return { url: ep, ok: rr.ok, status: rr.status, ms: Date.now() - st, timing, result: parsed || txt.slice(0, 200) };
    } catch (e) {
      return { url: ep, ok: false, status: 0, ms: Date.now() - st, timing, error: String((e && e.message) || e) };
    }
  }));
  const best = list.filter((x) => x.ok).sort((a, b) => a.ms - b.ms)[0] || null;
  const failed = list.filter((x) => !x.ok);
  noteRelayHealth({
    ok: !!best,
    ms: best ? best.ms : Date.now() - t0,
    status: best ? best.status : (list[0] && list[0].status) || 0,
    src: 'probe',
    edge: (best && best.result && best.result.edge) || '',
    via: best ? best.url : '',
    timing: (best && best.timing) || null,
    endpoints: list.length,
    upCount: list.length - failed.length,
    error: best ? '' : String((failed[0] && failed[0].error) || '全部中继探活失败'),
  });
  return { ...out, ok: !!best, ms: Date.now() - t0, endpoints: list };
}

/*
 * 双向陪护：网站主动打中继的 /__guard，一次拿回两侧结果。
 *   · 中继测「CF → 短信网关」TLS；同时回打本站只读 /api/health（不触发 tick，无回环）
 *   · 本站把结果记进 relayGuard / relayHealth，随 /api/state 与 /api/health 下发
 * 只在状态由「通」转「不通」时写一条系统日志，避免每小时刷屏。
 * 注意：这里绝不能改打 /api/wake —— 那会触发 tick，而 tick 又可能再打 /__guard。
 */
const relayGuard = { at: null, ok: null, ms: 0, status: 0, upstreamOk: null, siteOk: null, build: '', edge: '', error: '', lastOk: undefined, via: '', timing: null, tried: [], cached: false };
let relayGuardRunning = false;
/*
 * 连续失败计数。中继是短信的唯一出口，它挂了短信就是全静默失败，
 * 而告警不能靠短信本身 —— 所以第 2 次连续失败起推 NotifyMe（手机推送，独立通道）。
 * 恢复时清零，不重复打扰。
 */
let relayFailStreak = 0;
let relayAlertedAt = 0;

/*
 * 连接预热快照：把「网站 → 中继」这条链路提前握好。
 * 只对本站进程内的探针/体检有效 —— 真正发短信是另一个短命子进程，
 * 那边有自己的连接池（见 lib/sms/send.cjs），两条链路不要混为一谈。
 */
const relayWarm = { at: null, ok: null, ms: 0, via: '', error: '' };
let relayWarmRunning = false;

async function warmRelay(reason) {
  const eps = relayEndpoints();
  if (!eps.length || relayWarmRunning) return { configured: eps.length > 0, skipped: true };
  relayWarmRunning = true;
  const t0 = Date.now();
  try {
    // 预热用 OPTIONS：不触发业务、不带令牌，只为把 TCP + TLS 握好放进池子
    const r = await Promise.all(eps.map(async (ep) => {
      const st = Date.now();
      const ok = await httpClient.prewarm(ep + '/', { timeoutMs: 8000 });
      return { url: ep, ok, ms: Date.now() - st };
    }));
    const best = r.filter((x) => x.ok).sort((a, b) => a.ms - b.ms)[0] || null;
    Object.assign(relayWarm, {
      at: nowISO(), ok: !!best, ms: Date.now() - t0,
      via: best ? best.url : '', error: best ? '' : '预热失败（不影响业务，仅首次请求会慢一点）',
    });
    if (reason) console.log(`[relay] 连接预热 ${best ? '完成 ' + relayWarm.ms + 'ms 经 ' + best.url : '失败'}（${reason}）`);
    return { configured: true, ok: !!best, ms: relayWarm.ms, endpoints: r };
  } finally {
    relayWarmRunning = false;
  }
}

/** 打一次某地址的 /__guard，返回解析后的结果（不做任何记账） */
async function guardOnce(ep, headers) {
  const timing = {};
  const t0 = Date.now();
  try {
    /*
     * 超时给到 32s：中继的站点腿（CF 边缘 → 国内实例）冷启动可能要十几秒，
     * 中继侧 SITE_TIMEOUT 已放宽到 20s，本站这一层必须比它长，否则先把自己 abort 了
     * —— 那就是之前「陪护恒定失败」的另一半原因（The operation was aborted）。
     */
    const rr = await httpClient.request(new URL('/__guard', ep).toString(), { headers, timeoutMs: 32000, timing });
    const txt = await rr.text();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch { /* 非 JSON 忽略 */ }
    return { url: ep, ok: rr.ok, status: rr.status, ms: Date.now() - t0, parsed, timing };
  } catch (e) {
    return { url: ep, ok: false, status: 0, ms: Date.now() - t0, parsed: null, timing, error: String((e && e.message) || e) };
  }
}

/** 体检结果缓存窗口：手动连点 / 外部轮询不必每次都真跑一轮十几秒的出站 */
const RELAY_GUARD_CACHE_MS = 60000;
async function guardSmsRelay(opt) {
  const force = !!(opt && opt.force);
  const cfg = state.settings.smsGatewayRelay || {};
  const eps = relayEndpoints(cfg);
  if (!eps.length) return { configured: false, ok: null, note: '未配置短信中继' };
  if (relayGuardRunning) return { configured: true, busy: true, ok: relayGuard.ok, at: relayGuard.at };
  const lastAt = relayGuard.at ? Date.parse(relayGuard.at) : 0;
  if (!force && lastAt && Date.now() - lastAt < RELAY_GUARD_CACHE_MS) {
    return {
      configured: true, cached: true, cacheAgeMs: Date.now() - lastAt,
      ok: relayGuard.ok, status: Number(relayGuard.status) || 0, ms: relayGuard.ms,
      upstreamOk: relayGuard.upstreamOk, siteOk: relayGuard.siteOk,
      via: relayGuard.via, error: relayGuard.error, at: relayGuard.at,
    };
  }
  relayGuardRunning = true;
  const headers = cfg.secret ? { 'X-Relay-Secret': String(cfg.secret) } : {};
  const g0 = Date.now();
  try {
    /*
     * 按主→备顺序试：只要某一条中继自己回了 JSON，说明「网站 ↔ 该中继」这段是通的，
     * 就用它带回的两侧结果。全部打不通才算中继整体不可用。
     */
    const tried = [];
    let hit = null;
    for (const ep of eps) {
      const r = await guardOnce(ep, headers);
      tried.push({ url: r.url, ok: r.ok, responded: !!(r.parsed && typeof r.parsed === 'object'), status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) });
      if (r.parsed && typeof r.parsed === 'object') { hit = r; break; }
    }
    const ms = Date.now() - g0;
    if (!hit) {
      const msg = String((tried[0] && tried[0].error) || '所有中继地址均不可达');
      noteRelayHealth({ ok: false, ms, status: 0, src: 'guard', edge: '', via: '', timing: null, error: msg, endpoints: eps.length, upCount: 0 });
      const prev = relayGuard.lastOk;
      Object.assign(relayGuard, { at: nowISO(), ok: false, ms, status: 0, upstreamOk: false, siteOk: false, edge: '', error: msg, lastOk: false, via: '', timing: null, tried });
      if (prev === true) {
        pushSysLog({ level: 'warn', source: 'relay', msg: `双向陪护体检请求失败：${msg}`, detail: { ms, tried } });
      }
      await noteRelayFailure(`中继全部不可达：${msg}`);
      return { configured: true, ok: false, ms, error: msg, tried };
    }

    const parsed = hit.parsed;
    const upstreamOk = !!(parsed && parsed.upstream && parsed.upstream.ok);
    const siteOk = !!(parsed && parsed.site && parsed.site.ok);
    /*
     * 通道健康只看上游腿（CF → 短信网关）。站点腿是「中继能否回探本站」，
     * 走的是 CF 边缘 → 国内实例，冷启动常越过超时；把它算进健康判定会得出
     * 「上游通、短信能发，却报中继异常」的假警报（2026-11-14 实测：upstream ok、
     * site aborted，failStreak 已累积）。所以 siteOk 只留作参考，不参与告警。
     */
    const channelOk = upstreamOk;
    const upstreamMs = Number(parsed && parsed.upstream && parsed.upstream.ms) || 0;
    const timing = { ...(hit.timing || {}), ...(upstreamMs ? { upstreamMs } : {}) };
    // 可达中继条数按「有没有回 JSON」算：回 502 也是可达，只是上游不通
    const reachable = tried.filter((x) => x.responded).length;
    const err = channelOk ? '' : String((parsed && parsed.upstream && parsed.upstream.error) || '上游探针失败');
    noteRelayHealth({
      ok: channelOk,
      // ms 统一取整轮体检耗时，上游那一段单列进 timing.upstreamMs —— 三个口径不再打架
      ms,
      status: (parsed && parsed.upstream && parsed.upstream.status) || 0,
      src: 'guard', edge: (parsed && parsed.edge) || '', error: err,
      via: hit.url, timing, endpoints: eps.length, upCount: reachable,
    });
    const prev = relayGuard.lastOk;
    const prevSite = relayGuard.siteOk;
    Object.assign(relayGuard, {
      at: nowISO(), ok: channelOk, ms, status: hit.status, upstreamOk, siteOk,
      build: (parsed && parsed.site && parsed.site.build) || '',
      edge: (parsed && parsed.edge) || '',
      error: channelOk ? '' : (err || `HTTP ${hit.status}`),
      lastOk: channelOk, via: hit.url, timing, tried,
    });
    if (prev === true && !channelOk) {
      pushSysLog({
        level: 'warn', source: 'relay',
        msg: `短信中继上游不通：${relayGuard.error}（HTTP ${hit.status}，${ms}ms，经 ${hit.url}）`,
        detail: { status: hit.status, ms, edge: relayGuard.edge, error: relayGuard.error, upstreamOk, siteOk, via: hit.url },
      });
    } else if (channelOk && prevSite === true && !siteOk) {
      // 站点腿降级只记一条 info：它不影响发短信，但排障时值得知道这一跳变慢了
      pushSysLog({
        level: 'info', source: 'relay',
        msg: `中继回探本站变慢/失败（参考项，通道正常）：${String((parsed && parsed.site && parsed.site.error) || '回探未通过')}`,
        detail: { siteOk, ms, siteMs: (parsed && parsed.site && parsed.site.ms) || 0, via: hit.url },
      });
    }
    if (channelOk) { relayFailStreak = 0; } else { await noteRelayFailure(relayGuard.error || '上游探针失败'); }
    return { configured: true, ok: channelOk, status: hit.status, ms, via: hit.url, upstreamOk, siteOk, result: parsed, tried };
  } catch (e) {
    const ms = Date.now() - g0;
    const msg = String((e && e.message) || e);
    noteRelayHealth({ ok: false, ms, status: 0, src: 'guard', edge: '', via: '', timing: null, error: msg, endpoints: eps.length, upCount: 0 });
    const prev = relayGuard.lastOk;
    Object.assign(relayGuard, { at: nowISO(), ok: false, ms, status: 0, upstreamOk: false, siteOk: false, edge: '', error: msg, lastOk: false, via: '', timing: null, tried: [] });
    if (prev === true) {
      pushSysLog({ level: 'warn', source: 'relay', msg: `双向陪护体检请求失败：${msg}`, detail: { ms } });
    }
    await noteRelayFailure(msg);
    return { configured: true, ok: false, ms, error: msg };
  } finally {
    relayGuardRunning = false;
  }
}

/**
 * 中继连续失败记账：第 2 次起推一次 NotifyMe（1 小时内不重复推）。
 * 绝不回落到短信 —— 短信正是那个挂掉的通道。
 */
async function noteRelayFailure(reason) {
  relayFailStreak += 1;
  if (relayFailStreak < 2) return;
  const now = Date.now();
  if (now - relayAlertedAt < 3600 * 1000) return;
  relayAlertedAt = now;
  const title = '短信中继异常（连续 ' + relayFailStreak + ' 次）';
  const body = '网站与 Cloudflare 中继的联通体检未通过：' + String(reason || '').slice(0, 200)
    + '\n短信可能发不出去，请打开设置页「短信中继」查看。';
  pushNotification({ level: 'error', title, body, source: 'relay' });
  try { await sendNotifyMe(state.settings.notifyme, { title, body, level: 'error' }); } catch { /* 推送失败不影响主流程 */ }
}

/*
 * 双向陪护快照：/api/health 和 /api/state 共用同一份口径。
 * 以前只在 /api/health 里手写一份，控制中心读的是 /api/state，结果第九批做的
 * 陪护状态在页面上一个字都看不到；抽成函数后两处不会再各自漂移。
 * 全是元数据，不含任何密钥（relayHealth / relayGuard 里也只存状态与耗时）。
 */
function companionSnapshot() {
  return {
    configured: relayEndpoints().length > 0,
    endpoints: relayEndpoints(),
    relay: { ...relayHealth },
    guard: {
      at: relayGuard.at, ok: relayGuard.ok, ms: relayGuard.ms, status: relayGuard.status,
      upstreamOk: relayGuard.upstreamOk, siteOk: relayGuard.siteOk,
      build: relayGuard.build, edge: relayGuard.edge, error: relayGuard.error,
      via: relayGuard.via, timing: relayGuard.timing, tried: relayGuard.tried,
    },
    // 连续失败次数与最近一次预热结果：中继这层最怕「静默失效」，这两个数要能直接看到
    failStreak: relayFailStreak,
    warm: { ...relayWarm },
    wake: {
      lastWokeAt: (state.settings.wake || {}).lastWokeAt || null,
      count: Number((state.settings.wake || {}).count) || 0,
    },
  };
}

/* ---------------------------------------------------------------- AI 通知优化 */

/** 统一的 JSON HTTP 客户端：超时 + 解析一次搞定，aiPolish / models 路由共用。 */
async function fetchJSON(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应交给调用方按原样处理 */ }
  return { status: res.status, ok: res.ok, json, text };
}

/*
 * 任意 OpenAI 兼容接口（/chat/completions）。只做一件事：把原始通知改写得更易读。
 * 失败自动重试：最多尝试 2 次（首次 + 1 次重试），单次超时 8s——
 * 实测正常改写 1~3s，8s ≈ 平常耗时 ×3 的安全冗余；两次都失败由调用方回退原文。
 * （不采用 3 次重试：通知是时效消息，AI 只是锦上添花，最坏阻塞 8×3+间隔≈27s 会让推送明显延迟）
 */
/*
 * 单次 AI 调用超时：第 46 轮起会把接口原始数据（约 2.4k 字）一起送进提示语，
 * 输入比原来只有 160 字状态行时大一个量级，8 秒经常不够（超时就退回原始数据）。
 * 放宽到 15 秒，两次尝试最坏约 31 秒，对定时任务的通知延迟可接受。
 */
const AI_TIMEOUT_MS = 20000;
const AI_MAX_ATTEMPTS = 2;
const AI_RETRY_DELAY_MS = 1500;
/*
 * 超时与重试次数从「设置 → AI 通知优化」里读（ai.timeoutMs / ai.maxAttempts），
 * 上面两个常量退化成默认值：老配置没有这两个字段，行为与之前完全一致。
 * 上限刻意收紧 —— 通知是时效消息，超时 2 分钟、重试 3 次会让推送延迟到没意义。
 */
const AI_TIMEOUT_MIN = 5000;
const AI_TIMEOUT_MAX = 120000;
const AI_ATTEMPTS_MAX = 3;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/* 提示词保存上限：1500 字装不下「事实规则 + 排版规则 + 风格约束」的完整要求，
 * 线上天气任务已经写到 1413 字，再多两句就会被静默截掉尾巴 —— 用户看到的
 * 就是「后面写的那些排版要求完全没生效」。上限放到 4000，前端同步显示字数。 */
const AI_NOTIFY_PROMPT_MAX = 4000;
const AI_DEFAULT_PROMPT_MAX = 2000;

/*
 * ── 第十二批：让「任务里写的 AI 要求」真的生效 ──────────────────────────
 *
 * 第十一批把任务要求挪进 system 并标了最高优先级，AI 确实开始「按任务要求」
 * 出文案了（线上 aiNote 写着「按任务要求」）。但 11-11 的对照实验暴露了三个
 * 更底层的问题 —— 不是「没照做」，而是「照做了也对不上」：
 *
 *   ① 结构漂移。同一输入连跑两次，油价播报一次 5 行一次 4 行，云音乐一次 1 行
 *      一次 6 行。温度 0.6 + 没有结构契约，每次排版都重新摇一次骰子。用户看到
 *      的就是「这次优化得挺好、下次又变回原样」，即「效果不明显」。
 *   ② 事实走形。模型把「92 号 8.89 元/升」写成「92号：8.89升」——单位丢了，
 *      数字对但含义全错。原提示词只说「不得编造」，没说「单位必须保留」。
 *   ③ 空话填充。默认要求里「如有必要…提出简短生活建议」被模型理解成必答项，
 *      热评通知都要加一句「建议理性看待竞技结果」，把有效信息挤掉。
 *
 * 所以这一批不再靠「语气更强硬的提示词」，而是三件事：
 *   · 提示词分层：材料类型判定（结构化数据 / 长文本）→ 事实纪律 → 禁止写法 →
 *     体例 → 任务要求。任务要求只压「体例」，压不了事实与禁写底线。
 *   · 机器校验：从要求里抽出可验证的条款（每行 ≤N 字、正文 ≤N 字、每行 1 个
 *     emoji、无空行、禁 markdown、禁空话），生成后逐条检查；不达标就带着
 *     「具体违反了哪一条」纠正一次，并保留违规更少的那一版。
 *     字数按**去空白**计 —— 用户数是可见字，「最低 -3.6°C，微风」里的空格
 *     不该算进 24 字里（实测按含空白算会把合规输出误判成超长）。
 *   · 结果留痕：aiNote 直接写「已校验 N 项」或「M 项未达标：第 2 行 27 字…」，
 *     通知详情同时保留 AI 之前的原文，用户能自己比对改了什么。
 */

/** 从要求文本里抽出可机器校验的条款；抽不到就只做通用底线检查。 */
function aiRules(text) {
  const t = String(text || '');
  const rules = [
    { kind: 'no-markdown', hard: true, label: '不用 markdown 标记' },
    { kind: 'no-blank-line', hard: true, label: '不留空行' },
    { kind: 'no-filler', hard: true, label: '不写空话套话' },
  ];
  const per = t.match(/每行\s*[≤<]?\s*(\d{1,3})\s*字/);
  if (per) rules.push({ kind: 'line-max', n: Number(per[1]), hard: true, label: `每行 ≤${per[1]} 字` });
  const tot = t.match(/(?:正文|全篇|全文|整体|总字数)\s*[≤<]?\s*(\d{2,4})\s*字/);
  if (tot) rules.push({ kind: 'total-max', n: Number(tot[1]), hard: true, label: `正文 ≤${tot[1]} 字` });
  if (/每行\s*(?:1|一)\s*个\s*emoji|每行一个\s*emoji/i.test(t)) {
    rules.push({ kind: 'emoji-per-line', hard: false, label: '每行 1 个 emoji' });
  }
  return rules;
}

/** 去空白字数：用户数的是可见字，空格与换行不计。 */
const aiCharCount = (s) => [...String(s || '').replace(/\s+/g, '')].length;

/** 逐条检查生成结果，返回 { msg, hard } —— 只有 hard 项才值得再花一次调用去纠正。 */
function aiReview(body, rules) {
  const text = String(body || '');
  const lines = text.split('\n');
  const out = [];
  const add = (msg, hard) => out.push({ msg, hard: !!hard });
  for (const r of rules) {
    if (r.kind === 'no-markdown') {
      // 只认真正的标记：**加粗**、反引号、表格竖线、行首「- 」/「# 」。行首「-3.6」
      // 是负号不是列表，所以要求破折号后面跟空格。
      if (/\*\*|`|\|\s*\S+\s*\||^[ \t]*(?:[-*+]|#{1,6})[ \t]+/m.test(text)) add('出现了 markdown 标记', r.hard);
    } else if (r.kind === 'no-blank-line') {
      if (/\n[ \t]*\n/.test(text.trim())) add('出现了空行', r.hard);
    } else if (r.kind === 'no-filler') {
      const hit = text.match(/关注后续|保持积极心态|注意安全|合理安排|希望对你有帮助|仅供参考|祝您|祝你/);
      if (hit) add(`出现空话「${hit[0]}」`, r.hard);
    } else if (r.kind === 'line-max') {
      const i = lines.findIndex((l) => aiCharCount(l) > r.n);
      if (i >= 0) add(`第 ${i + 1} 行 ${aiCharCount(lines[i])} 字，超过每行 ${r.n} 字`, r.hard);
    } else if (r.kind === 'total-max') {
      const n = aiCharCount(text);
      if (n > r.n) add(`正文 ${n} 字，超过 ${r.n} 字`, r.hard);
    } else if (r.kind === 'emoji-per-line') {
      const isEmoji = (ch) => /\p{Extended_Pictographic}/u.test(ch);
      const i = lines.findIndex((l) => [...l].filter(isEmoji).length !== 1);
      if (i >= 0) add(`第 ${i + 1} 行不是正好 1 个 emoji`, r.hard);
    }
  }
  return out;
}

/**
 * 拼装提示词。aiPolish 与「看实际提示词」预览接口共用这一份 —— 预览里看到的
 * 必须就是真实发出去的那段，否则用户点开一看和实际不符，比不预览更糟。
 */
function aiPrompts({ instruction, taskInstruction, taskName, title, body, rawData }) {
  const defaultNeed = String(instruction || '').trim() || '更简洁易读，突出关键数字';
  const taskNeed = String(taskInstruction || '').trim();
  const sys = [
    '你是中文通知编辑，把接口返回的结果改写成一条能直接发到手机上的通知。',
    '只输出一个 JSON 对象：{"title":"标题","body":"正文"}。不要解释、不要代码块围栏。',
    '',
    '【先判断材料类型，再决定写法】',
    '· 结构化数据（字段=值、逐时/逐日表格、价格列表）：按字段取值组织，挑出本次真正有用的几项，不要罗列全部字段。',
    '· 长文本（评论、文章、日志、新闻）：提炼 2~4 个要点；禁止逐句照抄，禁止把原文整段搬过来。',
    '',
    '【事实纪律｜任何情况下都不得违反】',
    '· 数字、时间、名称必须能在「接口原始数据」里逐字找到；不许换算、不许改精度、不许推算没给出的趋势。',
    '· 数字必须带原单位（8.89 元/升、-3.6 °C、1085 ms）；不要出现「8.89升」这种丢单位的写法。',
    '· 同一指标有多种口径时（如「当前价」与「预计价」）按本任务要求点明的口径写，并把口径词（如「预计」）写进正文，不能合并成一个数。',
    '· 数据里没有的项直接不写；不要用「暂无」「未知」「未提供」凑格式。',
    '',
    '【禁止的写法】',
    '· 禁止空话：「关注后续」「保持积极心态」「注意安全」「合理安排」「希望对你有帮助」这类放到任何通知里都成立的句子，一律不写。',
    '· 建议必须是数据推得出来的具体动作（带条件或对象），例如「13 日前加满」，而不是「合理安排加油」。',
    '· 禁止把字段名搬进正文（不要写 previous_price=8.61）。',
    '· 禁止自称：不写「AI 优化」「已为您整理」。',
    '',
    '【体例】',
    '· 未指定篇幅时正文 ≤160 字。',
    '· 第一行给最重要的结论（涨/跌、成功/失败、有/无预警），细节放后面。',
    '· 中文标点；不用 markdown 标记、不用序号、不留空行。',
    '· 数字与单位之间留一个空格（92 号、8.89 元/升、-3.6 °C）。',
    taskNeed
      ? `\n【本任务要求｜优先级高于上面「体例」与默认要求，必须逐条落实】\n${taskNeed}\n`
      + '上面的「事实纪律」「禁止的写法」是底线，任何情况下都不得违反；「体例」与本任务要求冲突时，以本任务要求为准。'
      : '',
  ].filter(Boolean).join('\n');
  const user = [
    `任务名：${taskName || ''}`,
    `原始标题：${title}`,
    `原始内容：${body}`,
    rawData ? `【接口原始数据】（事实唯一来源）\n${rawData}` : '',
    `【默认优化要求】（补充，与本任务要求冲突时让位）${defaultNeed}`,
    taskNeed
      ? '【交付前自检】逐条对照「本任务要求」：有没有漏项？有没有多塞没要求的内容？有没有出现上面禁止的空话？改完再输出。'
      : '【交付前自检】有没有漏掉最重要的结论？有没有出现数据里没有的数字？有没有空话？改完再输出。',
  ].filter(Boolean).join('\n');
  return { system: sys, user, rules: aiRules(`${taskNeed}\n${defaultNeed}`), taskNeed, defaultNeed };
}

async function aiPolish(cfg, { title, body, instruction, taskInstruction, taskName, rawData }) {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) throw new Error('AI 未配置完整（需接口地址 / API Key / 模型）');
  const timeoutMs = Math.min(AI_TIMEOUT_MAX, Math.max(AI_TIMEOUT_MIN, Number(cfg.timeoutMs) || AI_TIMEOUT_MS));
  const maxAttempts = Math.min(AI_ATTEMPTS_MAX, Math.max(1, Number(cfg.maxAttempts) || AI_MAX_ATTEMPTS));
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const plan = aiPrompts({ instruction, taskInstruction, taskName, title, body, rawData });
  const messages = [
    { role: 'system', content: plan.system },
    { role: 'user', content: plan.user },
  ];

  /* 单次调用：网络错误/非 2xx/解析失败都抛异常，由外层按 attempts 重试。 */
  const callOnce = async (msgs) => {
    const { ok, status, json, text } = await fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: msgs, temperature: 0.35 }),
      timeoutMs,
    });
    if (!ok) throw new Error(`AI 接口返回 ${status} ${text.slice(0, 120)}`);
    const raw = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 返回内容无法解析');
    const parsed = JSON.parse(m[0]);
    if (!parsed || !parsed.title) throw new Error('AI 返回缺少 title');
    return {
      title: String(parsed.title).slice(0, 40),
      // 模型有时把换行写成字面 \n 而非 JSON 转义，统一还原成真换行，
      // 否则分行卡片式会退化成一整段。不再静默截到 800 字：
      // 正常输出远短于此，异常跑飞时才裁，且裁了会明确标注。
      body: clipBody(String(parsed.body || '').replace(/\\n/g, '\n')),
    };
  };

  let lastErr = null;
  let best = null;   // 违规最少的那一版；全部调用都失败时才会是 null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleepMs(AI_RETRY_DELAY_MS);
    try {
      const got = await callOnce(messages);
      const bad = aiReview(got.body, plan.rules);
      const hardBad = bad.filter((v) => v.hard);
      if (!best || bad.length < best.violations.length) best = { ...got, violations: bad, attempts: attempt };
      // 只有硬规则（空行、markdown、空话、超长）才值得再花一次调用；emoji 数这类
      // 软规则只记账不返工，否则「每行 1 个 emoji」会稳定触发一次无效重试。
      if (!hardBad.length) break;
      /*
       * 不达标就纠正一次：把上一版和「具体违反了哪一条」一起回灌，只让它修这些点。
       * 不再多给轮次 —— 通知是时效消息，最多两次调用（默认 attempts=2）已是上限；
       * 纠正后仍不达标就照发，但要如实把违规项写进 aiNote，让人看得见。
       */
      if (attempt === 1 && maxAttempts >= 2) {
        messages.push({ role: 'assistant', content: JSON.stringify({ title: got.title, body: got.body }) });
        messages.push({
          role: 'user',
          content: '上一版没通过检查：\n· ' + hardBad.map((v) => v.msg).join('\n· ')
            + '\n只修这些问题，其余保持不变（不要删掉已合规的行，也不要补充数据里没有的数字或时间），'
            + '重新输出完整的 JSON。',
        });
      } else break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!best) throw lastErr || new Error('AI 未返回可用结果');
  return {
    title: best.title,
    body: best.body,
    attempts: best.attempts,
    usedTaskInstruction: !!plan.taskNeed,
    violations: best.violations,
    checks: plan.rules.length,
  };
}


const SMS_TOKEN_PROBE = path.join(ROOT, 'lib', 'sms', 'token_probe.cjs');
const { createSmsCredential } = require('./lib/sms-credential');
const { createVault, SCOPE, scrubText } = require('./lib/credential-vault');
const { createBindings } = require('./lib/sms-bindings');
const { toDataUrl: qrToDataUrl, toSvg: qrToSvg } = require('./lib/qr');
// 风控评估 + 长度分析：与 send.cjs 共用同一份规则（预览说没风险、发送时却加提示 = 规则漂移）
const { evaluateRiskLevel, analyzeSmsLength, beautifySuggestions } = require('./lib/sms/content');
const { createAuditLog } = require('./lib/sms-audit');

/*
 * ── 短信管理面二次认证 ──────────────────────────────────────────────
 *
 * 这里踩过一个把自己锁死的坑，值得写清楚：
 *
 * 凭据管理是全站最高危的操作（生成授权链接会消耗验证码配额，吊销会让短信立刻中断），
 * 所以最初把它收紧成「必须 isAdmin」。但 REQUIRE_PASSWORD 默认没开，此时页面
 * 根本没有登录入口（单用户自部署的常态）—— 于是 isAdmin 永远是 false，
 * 按钮永远 hidden，而凭据一旦失效就**再没有任何路径能重新授权**。
 * 安全做到了，可用性归零，等于把门焊死还没带钥匙。
 *
 * 正确的做法不是「谁都能点」，也不是「谁都点不到」，而是规范第二节的原话：
 * 「管理接口需二次认证（口令 + IP 白名单）」。所以：
 *
 *   · 按钮始终可见（否则用户不知道有这个能力）
 *   · 点击后要求输入管理口令，换一个**只对 /api/sms 生效**的短时令牌
 *   · 不认「已是站点管理员」—— 一次站点登录不该顺带获得消耗验证码配额的能力，
 *     这是权限放大。管理面独立，令牌也独立。
 *   · 令牌绑定 IP，被抄走换台机器也用不了
 */
const SMS_ADMIN_COOKIE = 'cronhub_sms_admin';
const SMS_ADMIN_TTL_MS = 30 * 60 * 1000;

/** 独立派生：SMS 管理令牌与会话令牌互不影响，一边泄露不波及另一边。 */
function smsAdminSecret() {
  const base = (state.auth && state.auth.secret) || 'cronhub-sms-admin-fallback';
  return crypto.createHash('sha256').update('cronhub-sms-admin|v1|' + base).digest();
}

function signSmsAdmin(ip, ts) {
  return crypto.createHmac('sha256', smsAdminSecret())
    .update('sms-admin|' + String(ip) + '|' + String(ts))
    .digest('base64url');
}

/**
 * 令牌签名里要不要带来源地址？
 *
 * 托管环境的请求都经平台网关转发，`x-forwarded-for` 在多副本网关下每次请求
 * 都可能不同 —— 线上实测「刚换的令牌下一次请求就失效」。所以默认**不绑定**，
 * 只在运维显式配置了 `CRONHUB_ADMIN_IPS`（说明他确知出口地址稳定）时才绑定。
 *
 * 不绑定后的补偿措施：30 分钟过期 + HttpOnly + Secure + 每次高危操作二次确认 + 全量审计。
 */
function smsAdminBindKey(req) {
  if (!ADMIN_IP_ALLOW.length) return '-';
  return clientIP(req);
}

/**
 * IP 的不可逆短标记，写审计用。
 * 目的是「能关联同一来源」，不是「记录地址」—— 原始 IP 不进审计日志。
 */
function ipTagOf(ip) {
  return crypto.createHash('sha256').update('ip|v1|' + String(ip || '')).digest('hex').slice(0, 8);
}

function issueSmsAdminToken(req) {
  const ts = Date.now();
  return String(ts) + '.' + signSmsAdmin(smsAdminBindKey(req), ts);
}

/*
 * 已注销令牌的集合。
 *
 * 只靠 Set-Cookie 过期清不掉「已经抄走的那个 cookie」—— 服务端仍然认它。
 * 「退出管理员」要成立，就必须在服务端留一笔黑名单，否则它只是让浏览器忘记，
 * 而不是让令牌失效。集合只存签名、不存原始 token，进程重启即清空（令牌本身就只活 30 分钟）。
 */
const smsAdminRevoked = new Set();

function revokeSmsAdminToken(req) {
  const raw = parseCookies(req)[SMS_ADMIN_COOKIE];
  if (!raw) return false;
  const idx = raw.indexOf('.');
  if (idx < 1) return false;
  const sig = raw.slice(idx + 1);
  if (!sig) return false;
  // 兜底别用 clear()：超过 500 条时清空整个黑名单，会让 30 分钟 TTL 内
  // 已「退出管理员」注销过的令牌集体复活。Set 保序，只淘汰最早的一批。
  if (smsAdminRevoked.size > 500) {
    let drop = smsAdminRevoked.size - 400;
    for (const old of smsAdminRevoked) {
      smsAdminRevoked.delete(old);
      if (--drop <= 0) break;
    }
  }
  smsAdminRevoked.add(sig);
  return true;
}

/** 校验 SMS 管理令牌：未过期 + 签名正确（配了 IP 白名单时还要求来源一致）。 */
function isSmsAdmin(req) {
  const raw = parseCookies(req)[SMS_ADMIN_COOKIE];
  if (!raw) return false;
  const idx = raw.indexOf('.');
  if (idx < 1) return false;
  const ts = Number(raw.slice(0, idx));
  const sig = raw.slice(idx + 1);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  if (Date.now() - ts >= SMS_ADMIN_TTL_MS) return false;
  if (smsAdminRevoked.has(sig)) return false;   // 已「退出管理员」，即使 cookie 被抄走也不再认
  const expect = signSmsAdmin(smsAdminBindKey(req), ts);
  if (sig.length !== expect.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch {
    return false;
  }
}

/*
 * 短信通道的操作权限 —— 一律要求管理员令牌，没有「环境宽松」这一档。
 *
 * 为什么不再给 dev 自动放行：短信是唯一能同时「消耗真实配额（验证码/条数）」与
 * 「让通知彻底中断」的通道，权限判定必须与运行环境无关，否则本地能过、线上能过、
 * 换个环境就漏。dev 想省掉输口令，请显式设 CRONHUB_SMS_DEV_OPEN=1（且 dev 下本身 dry-run）。
 */
/*
 * 短信管理面：默认**不需要认证**（只统计，不拦截）。
 *
 * 这是自用站，短信页本来就只有自己会开；一道口令挡住的不是攻击者，是每天点十几次的自己。
 * 所以默认放行，把「谁在什么时候动过管理面」记成计数 + 审计，事后能查即可。
 * 想恢复硬闸门（拒绝 + needAdmin + 管理员登录）就设 CRONHUB_SMS_GUARD=1。
 */
const SMS_GUARD = /^(1|true|yes|on)$/i.test(String(process.env.CRONHUB_SMS_GUARD || ''));

function smsDevOpen() {
  return RUNTIME_ENV.env === 'dev'
    && !REQUIRE_PASSWORD
    && /^(1|true|yes)$/i.test(String(process.env.CRONHUB_SMS_DEV_OPEN || ''));
}

function canManageSms(req) {
  // 免认证模式：所有人都按管理员对待，短信页的开关/保存/授权/吊销一律可用
  if (!SMS_GUARD) return true;
  if (isSmsAdmin(req)) {
    /*
     * 可选 IP 白名单：托管环境请求都经平台网关转发，remoteAddress 是内网地址，
     * 白名单在那种场景没有意义，所以默认不启用；一旦配了 CRONHUB_ADMIN_IPS 就按最严格执行。
     */
    if (!ADMIN_IP_ALLOW.length) return true;
    const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return ADMIN_IP_ALLOW.includes(ip);
  }
  // 本地调试的唯一放开路径：显式开关 + dev + 未开访问口令
  return smsDevOpen();
}

/*
 * 短信操作的统一闸门。所有写操作与所有「有外部副作用」的读操作都要先过这里。
 *
 * 只在前端把按钮藏起来不叫权限控制 —— 直接打接口照样通过。所以判定必须在服务端，
 * 而且必须每个端点各自调用一次，不做「登录过就整站放行」。
 */
const smsDenySeen = new Map(); // `${label}|${ipTag}` → 上次拒绝记录时间，防刷爆审计

/*
 * 「授权次数」计数器。
 *
 * 口径：每一次**穿过管理面**的操作算一次（读凭据状态、改设置、发测试、重新授权、
 * 吊销、清日志……），按动作分组存进 state.smsAuthStats，随状态文件持久化。
 * 同一动作同一来源 60 秒内只记一次 —— 前端一次渲染会连着打好几个接口，
 * 不去重的话数字会虚高，看不出真实使用频率。
 */
const smsAuthSeen = new Map();

function smsAuthStatsInit() {
  if (!state.smsAuthStats || typeof state.smsAuthStats !== 'object') {
    state.smsAuthStats = { count: 0, byAction: {}, lastAt: '', lastAction: '', lastTag: '' };
  }
  const st = state.smsAuthStats;
  if (!st.byAction || typeof st.byAction !== 'object') st.byAction = {};
  return st;
}

function countSmsAuth(req, action) {
  const tag = ipTagOf(clientIP(req));
  const key = action + '|' + tag;
  const now = Date.now();
  if (smsAuthSeen.has(key) && now - smsAuthSeen.get(key) < 60000) return;
  if (smsAuthSeen.size > 500) smsAuthSeen.clear();
  smsAuthSeen.set(key, now);

  const st = smsAuthStatsInit();
  st.count = Number(st.count || 0) + 1;
  st.byAction[action] = Number(st.byAction[action] || 0) + 1;
  st.lastAt = nowISO();
  st.lastAction = action;
  st.lastTag = tag;
  // 动作桶无限长会把 state.json 撑大，留计数最高的 40 个
  const keys = Object.keys(st.byAction);
  if (keys.length > 40) {
    keys.sort((a, b) => st.byAction[b] - st.byAction[a]).slice(40).forEach((k) => { delete st.byAction[k]; });
  }
  saveState();
  try { smsAudit.append({ event: 'sms_access', action, ipTag: tag, total: st.count }); } catch { /* 审计写失败不影响业务 */ }
}

/** 计数视图：给前端直接渲染，不带 IP 原文。 */
function smsAuthStatsView() {
  const st = smsAuthStatsInit();
  const byAction = Object.entries(st.byAction || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([action, n]) => ({ action, n }));
  return {
    count: Number(st.count || 0),
    lastAt: st.lastAt || '',
    lastAction: st.lastAction || '',
    byAction,
  };
}

/*
 * 短信操作的统一闸门。默认只统计不拦截（SMS_GUARD 未开）；
 * 设了 CRONHUB_SMS_GUARD=1 才恢复「拒绝 + needAdmin」。
 *
 * 保留函数名不动是有意的：17 个调用点全部写成 `if (!needSmsAdmin(...)) return;`，
 * 只要这里恒返回 true，改默认值就等于全站放开，不会漏掉某个端点。
 */
function needSmsAdmin(req, res, label) {
  const action = String(label || '该操作');
  // 统计前置：不管随后是放行还是拒绝，这次「授权动作」都要记上
  countSmsAuth(req, action);

  if (!SMS_GUARD || canManageSms(req)) return true;

  const tag = ipTagOf(clientIP(req));
  const key = action + '|' + tag;
  const now = Date.now();
  if (!smsDenySeen.has(key) || now - smsDenySeen.get(key) > 60000) {
    if (smsDenySeen.size > 500) smsDenySeen.clear();
    smsDenySeen.set(key, now);
    try { smsAudit.append({ event: 'sms_admin_denied', action, ipTag: tag }); } catch { /* 审计写失败不阻塞拒绝 */ }
  }
  sendJSON(res, 403, {
    ok: false,
    needAdmin: true,
    error: `${action}需要管理员权限：请点「管理员登录」输入管理口令后再操作`,
  });
  return false;
}

/** 当前管理面状态（给前端画身份条用，不含任何凭据）。 */
function smsAdminState(req) {
  const ok = canManageSms(req);
  return {
    canManage: ok,
    role: SMS_GUARD ? (ok ? 'admin' : 'guest') : 'open',
    guard: SMS_GUARD,
    devOpen: smsDevOpen(),
    ttlSec: Math.floor(SMS_ADMIN_TTL_MS / 1000),
    authStats: smsAuthStatsView(),
  };
}

/*
 * creditToken 进程内缓存：preAuth 链路约 2~3s，缓存令牌后发送只需一次 HTTPS（约 1s）。
 * 令牌短时效（expireTime），且可能被服务端提前作废——发送失败就清缓存重取，最多多花一次探测。
 */
/* 旧的内存令牌缓存已由 lib/sms-credential.js 的加密持久化存储取代（重启不丢） */
/*
 * 最近一次 103001 返回的授权页链接，按号码分开存（多号码各自有各自的二维码）。
 * 用 Map 而不是单个变量：绑第二个号时，不能把第一个号正在扫的链接覆盖掉。
 */
const smsAuthUrlByBinding = new Map();
const smsLastAuthUrl = () => smsAuthUrlByBinding.get(bindings.primaryId()) || null;

/**
 * 授权链接 → 二维码（本地生成，外发第三方那套已彻底摘掉）。
 * 失败时返回空串：调用方回落到「只给链接、让用户复制到手机打开」，
 * 绝不能因为画不出二维码就把整个授权流程判失败。
 */
function localQrDataUrl(text) {
  try {
    return qrToDataUrl(text, { size: 200, ecc: 'M' });
  } catch (e) {
    pushSysLog({ level: 'warn', source: 'sms', msg: '本地生成二维码失败：' + (e.code || e.message) });
    return '';
  }
}

/*
 * 调子进程。两点安全约束：
 *   1. 令牌走 stdin，绝不进命令行 —— `ps aux` 能看到 argv，看不到别人的 stdin。
 *   2. 凭据文件路径由 CRONHUB_SMS_CFG_DIR 指定到一个一次性临时目录（见 withCredentialSandbox）。
 */
function smsExec(script, args, timeout, extra) {
  const opt = extra || {};
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], {
      timeout,
      cwd: path.dirname(script),
      windowsHide: true,
      env: { ...process.env, ...(opt.env || {}) },
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({
      out: String(stdout || '') + String(stderr || ''),
      failed: !!err,
      killed: !!(err && err.killed),
    }));
    if (opt.stdin != null) {
      try { child.stdin.end(String(opt.stdin)); } catch { /* 子进程已退出 */ }
    }
  });
}

/*
 * 凭据沙箱：把子进程需要的那几个文件和值，从保险库解出来写进一次性目录，
 * 调用结束立即整目录销毁。明文在磁盘上只活一次调用的时间（秒级），
 * 而且目录名随机、权限 600 —— 这是「凭据不在磁盘上长期驻留」的落地方式。
 */
/*
 * 保证「设备标识」稳定 —— 这是授权能不能续上的唯一前提。
 *
 * 平台的授权是绑在 (clawUid, uuid) 这一对上的：手机扫码那一次，平台记住的是
 * 「某个 clawUid 被某个手机号授权了」。之后每次 preAuth 只要带同一个 clawUid 才会返回 103000。
 *
 * 老实现每次调用都新建一次性沙箱目录，里面没有 clawUid.json，
 * token_service 的 get_openclaw_device_id_with_fallback() 就会「生成一个新 UUID」——
 * 等于每次换一台新设备去敲门。扫码刚绑好 A，下一次用 B 去问，平台当然说未授权。
 * 这就是「扫完码点检测永远显示未授权」的根因（第 39 轮）。
 */
function ensureClawUid(bindingId) {
  const id = bindings.resolveIds(bindingId)[0];
  const cur = bindings.vaultGet(id, 'clawUid');
  if (cur) return cur;
  const uid = crypto.randomUUID();
  bindings.vaultSet(id, 'clawUid', uid);
  pushSysLog({
    level: 'info',
    source: 'sms',
    msg: `[${id}] 已生成并固定设备标识 clawUid（${uid.slice(0, 8)}…）：平台授权将绑定到它，之后不再变化`,
  });
  return uid;
}

/*
 * 把子进程写下的授权材料收回保险库 —— 沙箱目录销毁前的唯一机会。
 *
 * token_service 在 preAuth 成功后会把 uuid / accessToken 写进沙箱里的 auth_info_ydrz.json，
 * 但沙箱用完即删，以前没人读回来，于是「扫码成功」的凭据每次都随目录一起蒸发，
 * longterm 分区永远是 0 条，下次又得重新授权。
 */
function harvestCredentialDir(dir, bindingId) {
  const id = bindings.resolveIds(bindingId)[0];
  const changed = [];
  const put = (k, v) => {
    if (!v) return;
    const cur = bindings.vaultGet(id, k);
    if (cur !== v) { bindings.vaultSet(id, k, v); changed.push(k); }
  };
  try {
    const ai = JSON.parse(fs.readFileSync(path.join(dir, 'auth_info_ydrz.json'), 'utf8'));
    put('uuid', typeof ai.uuid === 'string' ? ai.uuid : '');
    put('accessToken', typeof ai.accessToken === 'string' ? ai.accessToken : '');
  } catch { /* 文件不存在 = 本次没产生新凭据 */ }
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(dir, 'clawUid.json'), 'utf8'));
    // 两条写路径字段名不同：save_clawUid 写 clawUid，兜底生成写 deviceId
    put('clawUid', cj.clawUid || cj.deviceId || '');
  } catch { /* 同上 */ }
  return changed;
}

async function withCredentialSandbox(fn, bindingId) {
  const bid = bindings.resolveIds(bindingId)[0];
  const base = path.join(DATA_DIR, '.sms-runtime');
  const dir = path.join(base, crypto.randomBytes(8).toString('hex'));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const app = credentialVault.materialize(SCOPE.APP);
    /*
     * 长期凭据按「号码绑定」取，不再 materialize 整个分区：
     * 分区里现在放着 N 个号码的 uuid/accessToken，整份塞给子进程会串号 ——
     * A 号码的授权材料配 B 号码的 clawUid，平台侧看到的就是一台设备拿别人的令牌。
     */
    const lng = { ok: true, values: {
      uuid: bindings.vaultGet(bid, 'uuid'),
      accessToken: bindings.vaultGet(bid, 'accessToken'),
    } };
    if (!app.ok || !lng.ok) {
      throw new Error((app.message || lng.message || '凭据保险库不可用') + '，已拒绝调用短信子进程');
    }
    /*
     * 应用凭据前置校验。
     * 缺 code 时子进程会走到 token_service 的参数校验，返回「200002 clientId不能为空」——
     * 这个码对用户毫无意义，看起来像网关抽风，实际上是我们自己库里没值（第 38 轮事故）。
     * 在这里就拦下来，报清楚缺什么、怎么补。
     */
    if (!app.values.code) {
      const err = new Error(
        '应用凭据缺失（code / clientId 为空）：短信通道的 application 凭据不在保险库里，'
        + '不是网络或网关问题。请用引导入口写入 code / kid / strategyId 后重试。'
      );
      err.code = 'APP_CRED_MISSING';
      err.missing = ['code', 'kid', 'strategyId'].filter((k) => !app.values[k]);
      err.hint = 'POST /api/sms/bootstrap { app: { code, kid, strategyId } }';
      throw err;
    }
    if (!app.values.kid || !app.values.strategyId) {
      pushSysLog({
        level: 'warn',
        source: 'sms',
        msg: `应用凭据不完整：缺少 ${['kid', 'strategyId'].filter((k) => !app.values[k]).join(' / ')}，取令牌可能继续失败`,
      });
    }
    /*
     * config.json：非敏感字段沿用仓库里的那份，敏感三项从保险库取。
     * ⚠️ 注意 key 是 RSA **公钥**（send.cjs:52 拿它加密载荷），不是秘密，
     *    必须原样带过去 —— 早期版本把它一起删了，结果子进程拿到 undefined，
     *    真实发送在加密那一步就会挂。
     */
    let base_cfg = {};
    try {
      base_cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'sms', 'config.json'), 'utf8'));
    } catch { /* 文件缺失就用空对象，字段从保险库补 */ }
    delete base_cfg.code; delete base_cfg.kid; delete base_cfg.strategyId;
    const cfg = {
      ...base_cfg,
      code: app.values.code || '',
      kid: app.values.kid || '',
      strategyId: app.values.strategyId || '',
    };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
    if (lng.values.uuid || lng.values.accessToken) {
      fs.writeFileSync(path.join(dir, 'auth_info_ydrz.json'), JSON.stringify({
        uuid: lng.values.uuid || '',
        accessToken: lng.values.accessToken || '',
      }), { mode: 0o600 });
    }
    /*
     * 设备标识：必须是「这一个」且一直不变。
     * 两个字段都写 —— token_service 有两条读路径，字段名不同（clawUid / deviceId），
     * 只写一个会让另一条路径读不到，又走回「生成新 UUID」的老路。
     */
    const clawUid = ensureClawUid(bid);
    fs.writeFileSync(
      path.join(dir, 'clawUid.json'),
      JSON.stringify({ clawUid, deviceId: clawUid }),
      { mode: 0o600 }
    );
    return await fn(dir);
  } finally {
    /*
     * 关键顺序：先把子进程写的授权材料收回保险库，再销毁目录。
     * 反了就等于把刚拿到的 uuid / accessToken 一起删掉。
     */
    try {
      const changed = harvestCredentialDir(dir, bid);
      if (changed.length) {
        pushSysLog({ level: 'info', source: 'sms', msg: `[${bid}] 已把本次授权材料写入保险库：${changed.join(' / ')}` });
      }
    } catch { /* 回收失败不影响结果 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 下次启动会清空 .sms-runtime */ }
  }
}

/* expireTime 解析已收敛到 lib/sms-credential.js 的 ttlMs()，这里不再保留第二套规则 */

/* 单独取一次令牌（token_probe.cjs 输出单行 JSON） */
async function smsFetchToken(bindingId) {
  return withCredentialSandbox(async (cfgDir) => {
    const r = await smsExec(SMS_TOKEN_PROBE, [], 30000, { env: { CRONHUB_SMS_CFG_DIR: cfgDir } });
    try {
      const line = r.out.split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
      return JSON.parse(line);
    } catch {
      return { resultCode: 'ERR_PROBE', resultDesc: (r.out.split('\n').filter(Boolean).pop() || '探测失败').slice(0, 120) };
    }
  }, bindingId);
}

/*
 * 清掉「这一次绑定」的凭据，让下次 preAuth 重新走「需要授权」并拿到新链接。
 *
 * 沙箱架构下没有本地绑定文件可删了 —— 真身是保险库 longterm 分区里的 uuid / accessToken。
 * ⚠️ clawUid 必须保留：它是设备身份，清掉就等于换了一台机器，平台侧已有的绑定全部作废。
 *    「重新扫码」要的是同一个设备重新授权，不是换设备。
 */
async function smsResetCreds(bindingId) {
  const id = bindings.resolveIds(bindingId)[0];
  const removed = [];
  for (const k of ['uuid', 'accessToken']) {
    try {
      const r = bindings.vaultDel(id, k);
      if (!r || r.ok !== false) removed.push(k);
    } catch { /* 本就不存在 */ }
  }
  if (removed.length) {
    pushSysLog({ level: 'info', source: 'sms', msg: `[${id}] 已清除本次绑定的 ${removed.join(' / ')}（设备标识 clawUid 保留）` });
  }
  return { ok: true, removed, kept: ['clawUid'] };
}

/*
 * ⚠️ 授权重构（第 37 轮）：这里原有一个「探测令牌」函数，发送失败后会自动再探一次，
 * 探到 130088 还会清凭据再递归探测 —— 正是「反复请求令牌接口触发 140005」的元凶之一。
 * 现已删除：所有 preAuth 调用收敛到 lib/sms-credential.js 的 doRefresh()，全局仅 1 处。
 * 需要授权链接时只能走管理员显式触发的授权入口（受日 / 小时配额限制）。
 */

/* ---------------------------------------------------- 凭据保险库 / 审计 */
/*
 * 审计日志单独落在 data/audit/，与业务日志（state.systemLogs 环形缓冲）分开：
 * 业务日志会被覆盖，审计日志只追加、带哈希链、保留 90 天。
 */
const smsAudit = createAuditLog({
  dataDir: DATA_DIR,
  onLog: (e) => pushSysLog({ level: e.level, source: 'sms', msg: e.msg }),
});

const credentialVault = createVault({
  dataDir: DATA_DIR,
  getStore: () => state.credentialVault,
  putStore: (v) => { state.credentialVault = v; saveStateSync(); },
  audit: (evt) => smsAudit.append(evt),
  onLog: (e) => pushSysLog({ level: e.level, source: 'sms', msg: e.msg }),
});

/* 短期凭据分区：令牌本体只存在这里，state 里连密文都不放 */
const shortTermScope = credentialVault.scope(SCOPE.SHORTTERM);

/*
 * 号码绑定层：一个号码 = 一份独立授权（各自的 clawUid / uuid / accessToken）。
 *
 * 平台把授权绑在 (clawUid, uuid) 上，一条授权只能发给本人那个号；
 * 想同时发两个号，就必须有两份授权。原来的「全局单份」在数据层放不下第二份，
 * 于是「多号码」这件事从根上做不了。
 *
 * ensure() 是一次性迁移：老的「单份 state.smsCredential + 无前缀凭据键」原样搬成 b1:*，
 * 值一个都不重新生成 —— 重新生成 clawUid 等于换设备，已经扫过的授权会立刻作废。
 */
const bindings = createBindings({
  getState: () => state,
  putState: (st) => { state = st; },
  saveSync: () => saveStateSync(),
  longterm: credentialVault.scope(SCOPE.LONGTERM),
  shortterm: shortTermScope,
  onLog: (e) => pushSysLog(e),
  audit: (evt) => smsAudit.append(evt),
});
/*
 * ensure() 不能在模块顶层立即跑：此时 loadState() 还没执行（它在文件末尾、
 * 监听端口之前才调用），读到的是空 state，会把「从旧格式迁移」做在空气上，
 * 等真正的 state.json 读进来时迁移早已错过 —— 绑定列表为空、授权凭据悬空。
 * 真正的 ensure() 调用在文件末尾 loadState() 之后。
 */

/*
 * 每个绑定一个凭据实例。
 * 熔断、配额、令牌缓存、单飞锁全是实例内状态：共用一个实例会导致
 * 「A 号被平台限流熔断，B 号也跟着发不出去」，两号码的令牌也会互相覆盖。
 */
const smsCredInstances = new Map();
function smsCredFor(bindingId) {
  const id = bindings.resolveIds(bindingId)[0];
  if (smsCredInstances.has(id)) return smsCredInstances.get(id);
  const lockDir = path.join(DATA_DIR, '.sms-locks', id);
  try { fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 }); } catch { /* 建不了就由 FileLock 自己处理 */ }
  const inst = createSmsCredential({
    getStore: () => {
      const b = bindings.get(id);
      if (!b) return null;
      if (!b.cred || typeof b.cred !== 'object') b.cred = {};
      return b.cred;
    },
    /*
     * 凭据状态必须同步落盘：saveState() 是 300ms 节流的，进程被强杀 / 容器回收时
     * 最后一次写入会丢，熔断记录一丢就等于白熔断（下个进程照样发请求）。
     */
    putStore: (v) => {
      const b = bindings.get(id);
      if (b) b.cred = v;
      saveStateSync();
    },
    /*
     * dry-run 必须覆盖取令牌这一步。
     * 只在 sendRaw 拦是不够的：preAuth 才是最贵、最容易触发 140005 的调用。
     */
    probeToken: () => {
      if (SMS_DRY_RUN) {
        return Promise.resolve({
          resultCode: '103000',
          resultDesc: 'dry-run',
          creditToken: 'tk_dryrun_' + crypto.randomBytes(8).toString('hex'),
          expireTime: 300,
        });
      }
      return smsFetchToken(id);
    },
    sendRaw: async (text, token, opt) => {
      // dev：不发真实请求，也不消耗生产配额（显式 CRONHUB_SMS_REAL=1 才真发）
      if (SMS_DRY_RUN) {
        return {
          ok: true,
          dryRun: true,
          out: '✅ 发送成功（dry-run：' + RUNTIME_ENV.env + '，未真实发出，生产配额消耗 0）\n' + scrubText(text).slice(0, 80),
        };
      }
      /*
       * 父进程超时必须比子进程预算更长，否则子进程还没轮到重试就被 kill：
       * 之前是「父 30s vs 子单次 30s」，第二次尝试必然被砍，重试等于没有，
       * 而网关若已受理只是回包慢，父进程超时 → 任务判失败 → 下轮再发一遍（重复短信）。
       * 现在自动 45s / 手动 40s（手动仍在前端 90s 等待窗口内），
       * 子进程预算再减 5s，留出收尾与打印结果的时间。
       */
      const execTimeout = opt && opt.manual ? 40000 : 45000;
      const sgrRun = state.settings.smsGatewayRelay || {};
      const relayEps = relayEndpoints(sgrRun);
      const relayOn = !!(sgrRun.enabled && relayEps.length);
      const sniRun = state.settings.smsGatewaySni || {};
      // 走中继时连的是中继主机，SNI 伪装没有意义，直接不注入，避免连错主机
      const sniOn = !relayOn && !!(sniRun.enabled && sniRun.sni);
      return withCredentialSandbox(async (cfgDir) => {
        const r = await smsExec(
          SMS_SCRIPT,
          [text, '--raw', '--channel', 'cronhub', '--token-stdin'],
          execTimeout,
          {
            env: {
              CRONHUB_SMS_CFG_DIR: cfgDir,
              // 子进程总预算：父进程 execTimeout 留 5s 收尾，避免被 kill 在半途
              CRONHUB_SMS_BUDGET_MS: String(execTimeout - 5000),
              ...(relayOn ? {
                // 多地址用逗号分隔：子进程按顺序试，首个成功即停（主挂备上）
                CRONHUB_SMS_RELAY_URL: relayEps.join(','),
                CRONHUB_SMS_RELAY_SECRET: String(sgrRun.secret || ''),
              } : {}),
              ...(sniOn ? { CRONHUB_SMS_SNI: String(sniRun.sni) } : {}),
            },
            stdin: token,
          }
        );
        const sentOk = r.out.includes('✅ 发送成功');
        /*
         * 分段耗时只用于诊断，不进用户可见的发送结果：
         * 子进程会打一行 [relay-timing] {...}，这里解析掉再从正文里剔掉。
         */
        let sendTiming = null;
        const keep = [];
        for (const line of r.out.split('\n')) {
          if (line.startsWith('[relay-timing] ')) {
            try { sendTiming = JSON.parse(line.slice(15)); } catch { /* 坏行忽略 */ }
            continue;
          }
          keep.push(line);
        }
        if (relayOn && sendTiming) {
          noteRelayHealth({
            timing: sendTiming,
            via: sendTiming.via && sendTiming.via !== 'direct' ? sendTiming.via : (relayHealth.via || ''),
            ms: Number(sendTiming.totalMs) || relayHealth.ms,
          });
        }
        // 真实发送成功是中继健康最硬的证据：中继 → 网关 → 送达全链路都通才会走到这里
        if (relayOn && sentOk) noteRelayHealth({ ok: true, status: 0, src: 'send', edge: '', error: '' });
        return { ok: sentOk, out: keep.join('\n') };
      }, id);
    },
    onLog: (e) => pushSysLog(e),
    onAlert: async (a) => {
      pushNotification({ level: 'warn', title: a.title, body: a.body, source: 'sms' });
      // 告警必须走别的通道：这里用手机推送（NotifyMe），绝不回落到短信本身
      try { await sendNotifyMe(state.settings.notifyme, { title: a.title, body: a.body, level: 'warn' }); } catch { /* 推送失败不影响熔断 */ }
    },
    /*
     * 短期凭据存取：保险库 shortterm 分区，键名带绑定前缀，各号码的令牌互不可见。
     */
    tokenStore: {
      read: () => shortTermScope.get(bindings.keyOf(id, 'creditToken')),
      write: (plain) => shortTermScope.set(bindings.keyOf(id, 'creditToken'), plain),
      clear: () => shortTermScope.remove(bindings.keyOf(id, 'creditToken')),
    },
    audit: (evt) => smsAudit.append(evt),
    // 每次发送前先做保险库体检：密钥问题必须在配额提示之前暴露
    checkVault: () => credentialVault.health(),
    keyFromEnv: credentialVault.meta.keySource === 'env',
    hardExpiryDays: Number(state.settings.sms && state.settings.sms.hardExpiryDays) || 180,
    lockDir,
    resetLocalCreds: () => smsResetCreds(id),
    lastAuthPageUrl: () => smsAuthUrlByBinding.get(id) || null,
  });
  smsCredInstances.set(id, inst);
  return inst;
}

/*
 * 老路由全部写的是 smsCred.xxx()（不带号码）。
 * 用代理转发到「主号码」实例，等于默认号码的旧行为一字不变；
 * 需要指定号码的地方改调 smsCredFor(id)，不必给每个调用点加参数。
 */
const smsCred = new Proxy({}, {
  get(_t, prop) {
    const inst = smsCredFor(bindings.primaryId());
    const v = inst[prop];
    return typeof v === 'function' ? v.bind(inst) : v;
  },
});

/**
 * 从请求里解析「要操作哪个号码」：query.binding 或 body.binding，缺省落主号码。
 * 不做这个解析、一律用主号码，第二号码就永远只能看不能动。
 */
function bindingFromReq(url, body) {
  let raw = '';
  try {
    if (url && url.searchParams && typeof url.searchParams.get === 'function') raw = url.searchParams.get('binding') || '';
  } catch { /* 没有 query 就用 body */ }
  if (!raw && body && typeof body === 'object') raw = body.binding || '';
  return bindings.resolveIds(raw)[0];
}

/**
 * 一次性迁移：把 lib/sms 下仍以明文存在的凭据搬进保险库，然后移走原件。
 * 规范第九条第 1 条：凭据不得写在代码 / 配置文件里。
 * 原件不删除，移到系统临时目录（本机是 C:/Temp → D 盘 junction），便于人工核验。
 */
function migratePlaintextCredentials() {
  const dir = path.join(ROOT, 'lib', 'sms');
  const apps = credentialVault.scope(SCOPE.APP);
  const lng = credentialVault.scope(SCOPE.LONGTERM);
  if (!apps.available() || !lng.available()) {
    pushSysLog({ level: 'error', source: 'sms', msg: '保险库不可用，跳过明文凭据迁移（不会降级为明文继续用）' });
    return { ok: false };
  }

  const haveApp = new Set(apps.keys());
  const haveLong = new Set(lng.keys());
  const moved = [];
  let wrote = 0;

  // 1) config.json → 应用凭据分区
  const cfgFile = path.join(dir, 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    let dirty = false;
    for (const k of ['code', 'kid', 'strategyId']) {
      if (cfg[k] && !haveApp.has(k)) { apps.set(k, String(cfg[k])); wrote += 1; }
      if (cfg[k]) { delete cfg[k]; dirty = true; }
    }
    // 公钥不是秘密（本来就发给客户端验签用），但放在配置里也没必要，删掉减少误判
    if (dirty) {
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
      pushSysLog({ level: 'info', source: 'sms', msg: '已从 config.json 移除明文应用凭据（code / kid / strategyId），改由保险库提供' });
    }
  } catch { /* 文件不存在就算了 */ }

  // 2) auth_info_ydrz.json / clawUid.json → 长期凭据分区，然后移走
  for (const [file, map] of [
    ['auth_info_ydrz.json', { uuid: 'uuid', accessToken: 'accessToken' }],
    ['clawUid.json', { clawUid: 'clawUid' }],
  ]) {
    const p = path.join(dir, file);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [src, dst] of Object.entries(map)) {
        if (j[src] && !haveLong.has(dst)) { lng.set(dst, String(j[src])); wrote += 1; }
      }
      moved.push(p);
    } catch { /* 不存在或不是 JSON */ }
  }

  if (moved.length) {
    const backup = path.join(os.tmpdir(), 'cronhub-credential-backup-' + Date.now());
    try {
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const p of moved) {
        const to = path.join(backup, path.basename(p));
        fs.renameSync(p, to);
      }
      pushSysLog({
        level: 'info', source: 'sms',
        msg: '已把明文长期凭据移入保险库，原件移至 ' + backup + '（确认无误后可自行删除）',
      });
    } catch (e) {
      pushSysLog({ level: 'warn', source: 'sms', msg: '长期凭据迁移完成，但原件移走失败：' + (e.code || e.message) });
    }
  }

  if (wrote) {
    smsAudit.append({ event: 'credential_migrated', entries_written: wrote, files_moved: moved.length });
    pushSysLog({ level: 'info', source: 'sms', msg: '明文凭据已加密入库（' + wrote + ' 项），此后不再以明文落盘' });
  }
  return { ok: true, wrote, moved: moved.length };
}

async function sendSms(cfg, msg, opt) {
  if (!cfg || cfg.enabled === false) return { ok: false, skipped: true, message: '短信通道未启用' };
  /*
   * 前三道闸门（短信又贵又吵，默认只发要紧的）：重要级别 → 退订 → 静音
   *
   * minLevel 是「默认降噪」，管的是「没人点名要发」的批量通知；
   * 用户在某条任务通知里逐个勾了短信渠道，那是点过名的显式选择，
   * 不该再被默认值否决——否则表现为「我明明勾了短信却没收到」（第 43 轮踩到）。
   * opt.explicit=true 只跳过这一道；退订与静音是用户主动表达的意愿，仍然尊重。
   */
  const lv = String(msg.level || '').toLowerCase();
  const explicit = !!(opt && opt.explicit);
  if (!explicit && cfg.minLevel !== 'all' && lv === 'success') {
    return { ok: false, skipped: true, message: '按设置跳过：成功通知不发短信（设置页可改回「全部通知」）' };
  }
  if (cfg.optOut) return { ok: false, skipped: true, message: '短信已退订，可在短信操作页或设置页恢复' };
  const mutedTo = Number(cfg.mutedUntil) || 0;
  if (mutedTo > Date.now()) {
    return { ok: false, skipped: true, message: '短信静音至 ' + new Date(mutedTo).toLocaleString('zh-CN', { hour12: false }) };
  }
  /*
   * 多号码发送。
   *
   * 默认发到**全部已绑定号码**：用户多绑一个号，本意就是「这条也发给我家人」，
   * 而不是「多绑一个备用、默认不用」。想只发某一个时显式传 opt.binding / opt.bindings。
   *
   * 每个号码是一个独立实例：各自取令牌、各自配额、各自熔断。
   * 所以两个号可以在同一秒发出去（60 秒间隔是按号码算的，不是全局）。
   */
  const text = composeSmsText(msg, cfg);
  const manual = !!(opt && opt.manual);

  /*
   * 发送留痕（官方文档 4.3 /records 的数据来源）：
   * 只存「摘要 + 结果 + 条数」，不存全文 —— 中转短信全文落盘曾是审查扣分项，
   * 发送记录同理：正文里常有验证码/账单尾号，落盘等于把敏感内容多复制一份。
   * scrubText 先过一遍密钥/令牌类敏感值，再截 40 字。
   */
  const recordBase = {
    at: Date.now(),
    summary: scrubText(text).replace(/\s+/g, ' ').slice(0, 40),
    segments: analyzeSmsLength(text).segments,
    risk: evaluateRiskLevel(text).level,   // 0 无 / 1 轻度 / 2 高危
    level: String(msg.level || '').toLowerCase(),
  };
  const putRecord = (r) => {
    try {
      if (!Array.isArray(state.smsRecords)) state.smsRecords = [];
      state.smsRecords.unshift({ ...recordBase, bindingId: r.bindingId, label: r.label, ok: !!r.ok, dryRun: !!r.dryRun, message: String(r.message || '').slice(0, 120) });
      state.smsRecords = state.smsRecords.slice(0, 200);
    } catch { /* 留痕失败不影响发送结果 */ }
  };
  const withLabel = (id) => ({ bindingId: id, label: (bindings.get(id) || {}).label || id });

  const wantIds = (opt && (opt.bindings || opt.binding))
    ? bindings.resolveIds(opt.bindings || opt.binding)
    : bindings.list().map((b) => b.id);
  const targets = wantIds.length ? wantIds : [bindings.primaryId()];

  if (targets.length === 1) {
    const r = await smsCredFor(targets[0]).send({ text, manual });
    putRecord({ ...withLabel(targets[0]), ok: !!(r && r.ok), dryRun: r && r.dryRun, message: r && r.message });
    return { ...r, bindingId: targets[0] };
  }

  /*
   * 逐号顺序发（不是并行）：两个号共用同一个上游网关的调用频次，
   * 并行只会更容易撞上平台侧频率限制；而且串行结果便于在通知里逐个说明。
   */
  const results = [];
  for (const id of targets) {
    const label = (bindings.get(id) || {}).label || id;
    try {
      const r = await smsCredFor(id).send({ text, manual });
      putRecord({ ...withLabel(id), ok: !!(r && r.ok), dryRun: r && r.dryRun, message: r && r.message });
      results.push({ bindingId: id, label, ok: !!(r && r.ok), message: (r && r.message) || '' });
    } catch (e) {
      putRecord({ ...withLabel(id), ok: false, dryRun: false, message: e.message || '发送异常' });
      results.push({ bindingId: id, label, ok: false, message: e.message || '发送异常' });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount === results.length,
    partial: okCount > 0 && okCount < results.length,
    message: results.map((r) => `${r.label}：${r.message || (r.ok ? '已发送' : '未发送')}`).join('；'),
    results,
    bindingId: targets[0],
  };
}

/* ------------------------------------------------ 短信直连发送
 *
 * 服务端直接调用发送接口（lib/sms/send.cjs → 网关 5gvas01）：取令牌（preAuth，走云端可达的
 * idaas）+ 真发都在服务端进程内完成，不再经过本机 agent 轮询中转。发送失败（含网络不可达）
 * 由 sendSms 直接把真实错误回传前端，不做静默转队列。
 */
/* ---------------------------------------------------------------- 短信正文 / 操作链接 */

/** 站点公网根地址：优先用落库的 siteBase，退化到保活 / 唤醒链接里的 origin */
function siteBase() {
  const s = state.settings || {};
  const origin = (u) => {
    try {
      const t = new URL(String(u || ''));
      return t.host ? t.origin : '';
    } catch {
      return '';
    }
  };
  const pretty = (u) => {
    const o = origin(u);
    return /.workbuddy.host(:\d+)?$/i.test(o.replace(/^https?:\/\//, '')) ? o : '';
  };
  // 好记域名（*.workbuddy.host）优先：短信里的链接要一眼看出是自己的站，而不是一长串网关地址
  return pretty((s.keepWarm && s.keepWarm.url) || '')
    || String(s.siteBase || '').trim().replace(/\/+$/, '')
    || origin((s.wake && s.wake.url) || '');
}

/**
 * 操作链接令牌：首次用到时生成一次，存在 settings 里（跟着 state.json 走）。
 * 不能用登录密钥派生——那个每次部署会重算，旧短信里的链接就会集体失效。
 */
function actionToken() {
  const st = state.settings || (state.settings = {});
  if (!st.smsActionToken) {
    st.smsActionToken = crypto.randomBytes(5).toString('hex');
    saveState();
  }
  return st.smsActionToken;
}

function actionUrl() {
  const base = siteBase();
  if (!base) return '';
  // 托管平台要求所有路径都带 sharecode，短信里点开的链接也得带上，否则会被网关挡成 403
  const sc = String((state.settings && state.settings.sharecode) || '').trim();
  return base + '/a/' + actionToken() + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
}

/**
 * 短信正文：三行结构「标题 · 时间 / 正文 / 操作链接」。
 * 移动长短信按 67 字/条计费，超了既贵又容易被手机折叠成「显示不全」，所以按 maxChars 掐断。
 */
function composeSmsText(msg, cfg) {
  const maxChars = Math.min(480, Math.max(67, Number(cfg && cfg.maxChars) || 134));
  // 与默认设置一致：只有显式开着的才拼链接，配置里没带这个字段就当关
  const withLink = !!cfg && cfg.actionLink === true;
  const title = String(msg.title || '').replace(/\s+/g, ' ').trim();
  let body = String(msg.body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 只压平「行内」空白，必须保留 \n：手机通知栏靠换行分层。
    // 原来一刀切 \s+ → 空格，把提示词要求的三行卡片压成了一整坨（第 47 轮实测）。
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  /*
   * 标题行不再拼「· HH:MM」：手机短信/通知本身带发送时间，这串是重复信息，
   * 却固定吃掉 8 units（「空格+·+空格+2:23」），把单条短信的 140 units 挤到 138（第 47 轮实测），
   * AI 正文只要多写两个字就溢出成 2 条。去掉后正文预算立刻多出 8 units。
   */
  const head = title.slice(0, 64);
  /*
   * 链接风控（第 45 轮实测）：带 https:// 的链接 100% 命中平台「可疑链接」高危诈骗特征，
   * 追加免责声明后重试仍被拒——整条短信发不出去。
   * 折中：拼裸域名（无协议头），不命中风控正则，手机上长按/复制仍可达操作页；
   * 通道自检这类纯验证消息传 noLink，连域名都不带。
   */
  const fullLink = withLink && !msg.noLink ? actionUrl().replace(/^https?:\/\//, '') : '';
  // 67 字档位装不下「域名 + 令牌」这 48 个字，硬塞会把正文挤没，这时自动省略链接
  const link = fullLink && fullLink.length + head.length + 20 <= maxChars ? fullLink : '';
  const tail = link ? '\n' + link : '';
  const budget = Math.max(16, maxChars - head.length - tail.length - 1);
  if (body.length > budget) body = body.slice(0, Math.max(0, budget - 1)) + '…';
  let out = [head, body, link].filter(Boolean).join('\n');
  /*
   * 单条兜底（第 47 轮实测）：提示词写了「正文 ≤72 字」，AI 仍可能写到 97 字 / 164 units，
   * 直接变成 2 条计费。字数上限只管「字符数」，真正决定条数的是 units（中文 2、数字英文 1），
   * 所以这里按 units 再兜一层：从最后一行往前逐句删，每行至少留 1 句，
   * 保证「不超 1 条」的同时也不会把一句话拦腰截断。
   */
  if (analyzeSmsLength(out).units > SMS_FIT_UNITS) {
    body = shrinkSmsBody(head, body, SMS_FIT_UNITS);
    out = [head, body, link].filter(Boolean).join('\n');
  }
  return out;
}

/** 单条短信 units 上限：平台 140，留 2 给平台间差异 */
const SMS_FIT_UNITS = 138;

/**
 * 把正文按「整句」缩到 limit units 以内。
 * 每行拆成 [emoji 前缀, 分句…]，从最后一行往前删分句，每行至少保留 1 句。
 * 删过的行末尾若是逗号，改回句号，避免出现半截话。
 */
function shrinkSmsBody(head, body, limit) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return body;
  const parsed = lines.map((l) => {
    // 行首 emoji / 标点前缀（非中文文字、非字母数字）单独保留，不参与删句
    const m = l.match(/^([^\u4e00-\u9fffA-Za-z0-9]*)([\s\S]*)$/);
    const lead = m && m[1] ? m[1] : '';
    const rest = m && m[1] ? m[2] : l;
    const parts = rest.split(/(?<=[，；、。！？])/).filter((s) => s);
    return { lead, parts: parts.length ? parts : [rest] };
  });
  const render = () => parsed.map((p) => p.lead + p.parts.join('')).join('\n');
  let guard = 0;
  while (analyzeSmsLength(head + '\n' + render()).units > limit && guard++ < 30) {
    let removed = false;
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].parts.length > 1) {
        parsed[i].parts.pop();
        removed = true;
        break;
      }
    }
    if (!removed) break;   // 每行都只剩 1 句，再删就成空行了
  }
  return parsed.map((p) => {
    let t = p.parts.join('');
    if (t && !/[。！？；]$/.test(t)) t = t.replace(/[，、；]+$/, '') + '。';
    return p.lead + t;
  }).join('\n');
}

/* ---------------------------------------------------------------- 短信操作页（免登录） */

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 读 application/x-www-form-urlencoded（readBody 只认 JSON，表单得单独解析） */
function readFormBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8192) req.destroy();
    });
    req.on('end', () => {
      const out = {};
      for (const kv of raw.split('&')) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        try {
          out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
        } catch { /* 坏字段直接忽略 */ }
      }
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

/** 当前短信接收状态：正常 / 静音到某刻 / 已退订 */
function smsRecvState() {
  const sms = state.settings.sms || {};
  if (sms.optOut) return { ok: false, text: '已退订' };
  const until = Number(sms.mutedUntil) || 0;
  if (until > Date.now()) {
    return { ok: false, text: '静音至 ' + new Date(until).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) };
  }
  return { ok: true, text: '正常接收' };
}

const SMS_ACTION_LABEL = { mute: '静音 1 小时', stop: '已退订短信', resume: '已恢复接收', ok: '已记录' };

/** 执行操作并落盘；返回动作名供页面回显 */
function applySmsAction(action) {
  const sms = state.settings.sms || (state.settings.sms = {});
  const now = Date.now();
  if (action === 'mute') {
    sms.optOut = false;
    sms.mutedUntil = now + 3600 * 1000;
  } else if (action === 'stop') {
    sms.optOut = true;
    sms.mutedUntil = 0;
  } else if (action === 'resume') {
    sms.optOut = false;
    sms.mutedUntil = 0;
  } else if (action !== 'ok') {
    return '';
  }
  saveState();
  pushSysLog({
    level: action === 'ok' ? 'info' : 'warn',
    source: 'sms',
    msg: '短信操作页收到指令：' + (SMS_ACTION_LABEL[action] || action) + '（来源：短信操作链接）',
    detail: { action, optOut: !!sms.optOut, mutedUntil: sms.mutedUntil, ua: 'sms-action-page' },
  });
  return action;
}

function htmlPage(res, code, title, inner) {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="robots" content="noindex,nofollow"><title>' + escHtml(title) + ' · CronHub</title>'
    + '<style>'
    + ':root{color-scheme:light}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}'
    + 'body{margin:0;padding:26px 18px 40px;background:#eef2f7;color:#111827;'
    + 'font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}'
    + '.wrap{max-width:420px;margin:0 auto}'
    + '.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:#2563eb;margin-bottom:14px}'
    + '.dot{width:9px;height:9px;border-radius:50%;background:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}'
    + '.card{background:#fff;border-radius:18px;padding:20px 18px;box-shadow:0 10px 30px rgba(15,23,42,.07)}'
    + 'h1{margin:0 0 8px;font-size:20px;letter-spacing:.3px}'
    + '.state{display:inline-block;font-size:13px;padding:4px 10px;border-radius:999px;margin-bottom:14px}'
    + '.state--ok{background:#e8f5ec;color:#17703a}.state--off{background:#fdeaea;color:#a52121}'
    + '.tip{margin:0 0 16px;font-size:14px;color:#5b6472}'
    + 'form{display:flex;flex-direction:column;gap:10px;margin:0}'
    + 'button{font:inherit;font-weight:600;padding:14px;border-radius:14px;border:0;background:#2563eb;color:#fff;letter-spacing:.4px;cursor:pointer}'
    + 'button.ghost{background:#eef2f7;color:#334155}button.danger{background:#fee2e2;color:#b91c1c}'
    + '.flash{margin:0 0 14px;padding:11px 13px;border-radius:12px;background:#e8f5ec;color:#17703a;font-size:14px}'
    + '.stats{margin:16px 0 0;padding-top:14px;border-top:1px solid #eef2f7;font-size:13px;color:#6b7280}'
    + 'a.home{display:inline-block;margin-top:12px;color:#2563eb;font-size:14px;text-decoration:none}'
    + '</style></head><body><div class="wrap"><div class="brand"><span class="dot"></span>CronHub</div>'
    + '<div class="card">' + inner + '</div></div></body></html>';
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(html);
}

/**
 * 短信里的操作页：/a/<token>。
 * 移动端一点即用，不用登录 —— 短信本身就是凭据（令牌由实例密钥派生）。
 */
function handleActionPage(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const token = parts[1] || '';
  if (token !== actionToken()) {
    return htmlPage(res, 404, '链接已失效',
      '<h1>链接已失效</h1><p class="tip">这个链接不属于当前实例（重新部署或清除数据后令牌会变）。请打开 CronHub 设置页调整短信通知。</p>');
  }
  // 自身路径自己拼（不信任网关转发过来的 query）：平台要求每个请求都带 sharecode
  const selfPath = '/a/' + token;
  const scq = String((state.settings && state.settings.sharecode) || '').trim();
  const selfUrl = selfPath + (scq ? '?sharecode=' + encodeURIComponent(scq) : '');
  if (req.method === 'POST') {
    return readFormBody(req).then((body) => {
      const done = applySmsAction(String(body.do || ''));
      res.writeHead(303, {
        Location: selfUrl + (scq ? '&' : '?') + 'done=' + encodeURIComponent(done || '1'),
        'Cache-Control': 'no-store',
      });
      res.end();
    });
  }

  const done = String(url.searchParams.get('done') || '');
  const st = smsRecvState();
  const sms = state.settings.sms || {};
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recent = (Array.isArray(state.logs) ? state.logs : []).filter((l) => Date.parse(l.at) >= dayAgo);
  const fails = recent.filter((l) => !l.ok).length;
  const sc = String(state.settings.sharecode || '').trim();
  const home = siteBase() ? siteBase() + '/' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '') : '';

  const flash = done && SMS_ACTION_LABEL[done]
    ? '<div class="flash">✓ ' + escHtml(SMS_ACTION_LABEL[done]) + '</div>'
    : '';
  const inner = ''
    + '<h1>短信通知</h1>'
    + '<div class="state ' + (st.ok ? 'state--ok' : 'state--off') + '">' + (st.ok ? '● ' : '○ ') + escHtml(st.text) + '</div>'
    + flash
    + '<p class="tip">这条短信来自你自己的 CronHub 定时任务。下面点一下就好，<b>不用登录</b>：静音后重要事件仍会走 App 推送与站内消息，只是不再发短信。</p>'
    + '<form method="post" action="' + escHtml(selfUrl) + '">'
    + '<button name="do" value="mute">静音 1 小时</button>'
    + '<button name="do" value="stop" class="danger">退订短信</button>'
    + '<button name="do" value="resume" class="ghost">恢复接收</button>'
    + '</form>'
    + '<p class="stats">最近 24 小时：执行 ' + recent.length + ' 次 · 失败 ' + fails + ' 次'
    + (sms.maxChars ? ' · 单条短信上限 ' + sms.maxChars + ' 字' : '') + '</p>'
    + (home ? '<a class="home" href="' + escHtml(home) + '">打开 CronHub →</a>' : '');
  return htmlPage(res, 200, '短信通知', inner);
}

/* ---------------------------------------------------------------- 短信网关 */

/* 网关调用记录：只留内存最近 30 条（重启即清，诊断用，不入库） */
const gatewaySmsLog = [];
function gatewayLog(entry) {
  gatewaySmsLog.push({ at: nowISO(), ...entry });
  if (gatewaySmsLog.length > 30) gatewaySmsLog.splice(0, gatewaySmsLog.length - 30);
}

/* 网关令牌鉴权：兼容 sms-webhook 包协议，三选一 —— ?token= / X-Token / Authorization: Bearer。
 * 注意顺序：平台反向代理会用它自己的 JWT 覆盖 Authorization 头，所以 Bearer 必须放最后兜底，
 * 外部系统经平台访问时请用 ?token= 或 X-Token 头。 */
function gatewayTokenOf(req, url) {
  return String(url.searchParams.get('token') || '').trim()
    || String(req.headers['x-token'] || '').trim()
    || (String(req.headers.authorization || '').startsWith('Bearer ')
      ? String(req.headers.authorization).slice(7).trim()
      : '');
}

/* 提取短信内容：JSON body 的 content/text/message，或 URL 参数 content */
function gatewayContentOf(url, body) {
  const b = body || {};
  return String(b.content || b.text || b.message || url.searchParams.get('content') || '').trim().slice(0, 480);
}

async function sendMail(cfg, { subject, text }) {
  if (!cfg || !cfg.enabled) return { ok: false, skipped: true, message: '邮件通道未启用' };
  if (!cfg.host || !cfg.to || !cfg.from) throw new Error('SMTP 配置不完整（需 host / from / to）');

  const port = Number(cfg.port) || 465;
  const useImplicitTLS = port === 465;
  let socket = useImplicitTLS
    ? tls.connect({ host: cfg.host, port, servername: cfg.host, rejectUnauthorized: false })
    : net.connect({ host: cfg.host, port });

  try {
    await new Promise((res, rej) => {
      const ev = useImplicitTLS ? 'secureConnect' : 'connect';
      socket.once(ev, res);
      socket.once('error', rej);
      socket.setTimeout(20000, () => rej(new Error('SMTP 连接超时')));
    });

    // 握手阶段用临时会话；STARTTLS 升级后必须重建会话，否则读不到新 socket 的数据
    let s = createSmtpSession(socket);
    const greet = await s.read();
    if (!greet.startsWith('220')) throw new Error('SMTP 握手失败: ' + greet.trim());

    await s.cmd('EHLO cronhub.local');

    if (!useImplicitTLS) {
      const r = await s.cmd('STARTTLS');
      if (r.startsWith('220')) {
        const plain = socket;
        socket = tls.connect({ socket: plain, servername: cfg.host, rejectUnauthorized: false });
        await new Promise((res, rej) => {
          socket.once('secureConnect', res);
          socket.once('error', rej);
        });
        s = createSmtpSession(socket);
        await s.cmd('EHLO cronhub.local');
      } else if (cfg.user) {
        throw new Error('服务器拒绝 STARTTLS，明文认证存在风险，已中止');
      }
    }

    if (cfg.user) {
      const authInit = await s.cmd('AUTH LOGIN');
      if (!authInit.startsWith('334')) throw new Error('服务器不接受 AUTH LOGIN: ' + authInit.trim());
      await s.cmd(Buffer.from(cfg.user, 'utf8').toString('base64'));
      const authRes = await s.cmd(Buffer.from(cfg.pass || '', 'utf8').toString('base64'));
      if (!authRes.startsWith('235')) throw new Error('SMTP 认证失败，请检查账号或授权码');
    }

    const fromRes = await s.cmd(`MAIL FROM:<${cfg.from}>`);
    if (!fromRes.startsWith('250')) throw new Error('MAIL FROM 被拒: ' + fromRes.trim());
    for (const rcpt of String(cfg.to).split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      const r = await s.cmd(`RCPT TO:<${rcpt}>`);
      if (!r.startsWith('250')) throw new Error(`RCPT TO ${rcpt} 被拒: ${r.trim()}`);
    }

    const dataRes = await s.cmd('DATA');
    if (!dataRes.startsWith('354')) throw new Error('DATA 被拒: ' + dataRes.trim());

    const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const headers = [
      `From: CronHub <${cfg.from}>`,
      `To: ${cfg.to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `Date: ${new Date().toUTCString()}`,
      '',
      body,
      '.',
    ].join('\r\n');

    socket.write(headers + '\r\n');
    const done = await s.read();
    if (!done.startsWith('250')) throw new Error('邮件投递失败: ' + done.trim());
    await s.cmd('QUIT').catch(() => {});
    return { ok: true, message: '邮件已发送' };
  } finally {
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
  }
}

/* ---------------------------------------------------------------- 任务执行 */

/**
 * 统一出口。两个理由要自己包一层，而不是直接用全局 fetch：
 *
 * 1. 回环地址不能走 HTTP_PROXY —— 云沙箱常设全局代理，会让发往 127.0.0.1 的请求
 *    被转发到代理上，表现为「连接被拒绝」。
 * 2. 全局 fetch（undici）的连接池 keepAliveTimeout 只有 4 秒且改不了，定时任务之间
 *    隔着几小时，等于每次执行都重新握手。lib/http-client.cjs 里用常驻 Agent 把连接
 *    保活 60 秒、缓存 DNS 与 TLS 会话，实测同一个接口从 1.5 秒降到 175 毫秒。
 *
 * 想临时回到旧引擎排查兼容性问题：CRONHUB_HTTP_ENGINE=fetch
 */
const HTTP_ENGINE = String(process.env.CRONHUB_HTTP_ENGINE || 'agent').toLowerCase();
const httpClient = require('./lib/http-client.cjs');

async function fetchNoProxy(url, init) {
  const u = new URL(url);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(u.hostname);
  // 回环请求永远走自家 Agent（顺带避开代理），公网请求默认也走，除非显式要求 fetch
  if (!isLoopback && HTTP_ENGINE === 'fetch') return fetch(url, init);

  // 调用方给了 AbortSignal（runHttpTask 会传）就由它控制超时，这里只留一个宽松兜底
  const timeoutMs = init && init.signal ? 120000 : 20000;
  return httpClient.request(url, {
    method: (init && init.method) || 'GET',
    headers: (init && init.headers) || {},
    body: init && init.body,
    signal: init && init.signal,
    timeoutMs,
  });
}

/* ---------------------------------------------------------------- 私网 URL 防护（可选）
 * 云端实例如果能被外部触发建任务，理论上可以拿它当跳板打内网 / 云元数据。
 * 但本项目是自用开放站，也可能真有内网任务，所以**默认关闭**：
 *   CRONHUB_BLOCK_PRIVATE_URL=1 或 settings.blockPrivateUrls = true 才启用。
 * 只按字面 host 判断、不解析 DNS：不防 DNS 重绑定，也不追 302 跳转后的地址。
 * 定位是「防手滑填错 / 挡住最直白的探测」，不是完整的 SSRF 防御体系。
 */
function privateUrlGuardOn() {
  const env = process.env.CRONHUB_BLOCK_PRIVATE_URL;
  if (env != null && String(env).trim() !== '') return /^(1|true|on|yes)$/i.test(String(env).trim());
  return !!(state.settings && state.settings.blockPrivateUrls);
}

function isPrivateHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (net.isIPv6(h)) {
    return h === '::1' || h === '::'
      || h.startsWith('fc') || h.startsWith('fd')          // fc00::/7 唯一本地
      || /^fe[89ab]/.test(h)                               // fe80::/10 链路本地
      || h.startsWith('::ffff:');                          // IPv4 映射
  }
  if (net.isIPv4(h)) {
    const p = h.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 169 && p[1] === 254)                    // 含 169.254.169.254 元数据
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 192 && p[1] === 0 && p[2] === 0)
      || (p[0] === 192 && p[1] === 0 && p[2] === 2)
      || (p[0] === 198 && (p[1] === 18 || p[1] === 19))
      || (p[0] === 198 && p[1] === 51 && p[2] === 100)
      || (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  return false;
}

function assertUrlAllowed(raw, taskName) {
  if (!privateUrlGuardOn()) return;
  let u;
  try { u = new URL(raw); } catch { return; } // 格式错误交给请求层自己报，不重复造错
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`请求地址协议不允许：${u.protocol}（只允许 http/https）`);
  }
  if (isPrivateHost(u.hostname)) {
    pushSysLog({
      level: 'warn', source: 'security',
      msg: '已拦截指向私网地址的任务请求',
      detail: { task: taskName || '', host: u.hostname },
    });
    throw new Error(`请求地址被私网防护拦截：${u.hostname}`);
  }
}

async function runHttpTask(task) {
  const cfg = task.config || {};
  if (!cfg.url) throw new Error('未填写请求地址');
  assertUrlAllowed(cfg.url, task.name);
  const method = (cfg.method || 'GET').toUpperCase();
  // 环境变量先替换（{{KEY}} → 值），再处理凭据占位符
  const url = applyEnvVars(cfg.url);
  let headers = {};
  // 先解析占位符再 JSON.parse —— 占位符本身是合法 JSON 字符串内容
  const headersRaw = applyTokenPlaceholder(applyEnvVars(cfg.headers));
  if (headersRaw && headersRaw.trim()) {
    try {
      headers = JSON.parse(headersRaw);
    } catch {
      throw new Error('请求头不是合法 JSON');
    }
  }
  // 占位符还在（说明 vault 没配好），给一句能定位的话，而不是让上游返回 401 谜语
  if (String(headersRaw || '').includes(TOKEN_PLACEHOLDER)) {
    throw new Error('请求头里的 {{ACCESS_TOKEN}} 未替换：请先在设置里配置凭据续期（refreshToken）');
  }
  const init = { method, headers, signal: AbortSignal.timeout(Math.max(3, Number(cfg.timeoutSec) || 15) * 1000) };
  if (method !== 'GET' && method !== 'HEAD' && cfg.body) init.body = applyEnvVars(cfg.body);

  const t0 = Date.now();
  let res;
  try {
    res = await fetchNoProxy(url, init);
  } catch (err) {
    const cause = (err.cause && (err.cause.code || err.cause.message)) || err.message || '';
    const friendly = {
      ECONNREFUSED: '连接被拒绝，目标端口未监听',
      ENOTFOUND: '域名无法解析，请检查地址拼写',
      ETIMEDOUT: '连接超时',
      UND_ERR_CONNECT_TIMEOUT: '连接超时',
      CERT_HAS_EXPIRED: '目标站点证书已过期',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: '目标站点证书不受信任',
    };
    const key = String(cause).split(':')[0];
    const hint = friendly[key] || (err.name === 'TimeoutError' ? '请求超时，可适当调大超时时间' : String(cause || '网络请求失败'));
    throw new Error(`请求失败：${hint}`);
  }
  // 完整正文用于解析，展示时才裁到安全阀 —— 先截断会导致 JSON 残缺解析失败
  const fullText = await res.text().catch(() => '');
  const expect = Number(cfg.expectStatus) || 200;
  // 除主状态码外，允许额外声明「也算成功」的状态码（数组或逗号分隔）。
  // 典型用途：签到接口在今日已签时返回 400，那不是故障，不该报红。
  const okCodes = [expect]
    .concat(parseStatusList(cfg.alsoOkStatus))
    .filter((v, i, a) => a.indexOf(v) === i);
  if (!okCodes.includes(res.status)) {
    // 失败更要看正文 —— 上游的报错原因（余额不足、令牌过期、参数缺失）全在里面。
    // 挂在 error 对象上带出去，由 runTask 写进执行记录。
    const e = new Error(`状态码 ${res.status}，期望 ${okCodes.join('/')}。响应：${clipBody(fullText) || '(空)'}`);
    e.httpStatus = res.status;
    e.responseBody = clipBody(fullText);
    throw e;
  }
  const soft = res.status !== expect ? `（${res.status}，属可接受状态）` : '';
  return {
    // 正文不再截到 2000 字：和风天气单步就有 14173 字，砍掉后半段等于把
    // 明天傍晚的雨雪数据弄丢。message / text / response 现在都是同一份完整正文，
    // 只受 RESULT_BODY_MAX 这个异常安全阀约束。
    message: `请求成功${soft} ${res.status}，耗时 ${Date.now() - t0}ms。响应：${clipBody(fullText) || '(空)'}`,
    ok: true,
    status: res.status,
    soft: res.status !== expect,
    ms: Date.now() - t0,
    json: tryParseJSON(fullText),
    text: clipBody(fullText),
    response: clipBody(fullText),
    stepName: cfg.name || '',
  };
}

/** 尝试把响应正文解析成 JSON；不是 JSON 就返回 null（不抛错）。 */
function tryParseJSON(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  if (!/^[[{]/.test(raw)) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 把 "400,409" 或 [400,409] 统一成数字数组，非法项丢弃。 */
function parseStatusList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[\s,;]+/);
  return arr
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
}

/**
 * 任务级通知策略清洗。返回 null 表示「没表态」——不写进 config，执行时跟随全局。
 * 前端只有在用户动过这个开关时才会带上它。
 */
function sanitizeNotifyPolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    enabled: raw.enabled !== false,
    onSuccess: raw.onSuccess !== false,
    onFailure: raw.onFailure !== false,
  };
  // 通知渠道可多选；站内是必选项，前端虽然已经锁死，服务端再兜一次底
  if (Array.isArray(raw.channels)) {
    const ch = sanitizeChannelList(raw.channels);
    if (ch.length) out.channels = withInapp(ch);
  }
  return out;
}

/**
 * 取出这个任务要执行的请求步骤。
 * 老任务只有 config 里的单条请求；新任务可以用 config.steps 数组声明多步，
 * 按顺序串行执行 —— 「先签到、再领旅行奖励、再派遣」这种链式动作靠它表达。
 */
function stepsOf(task) {
  const cfg = task.config || {};
  /*
   * 步骤的 url 允许留空继承任务级（与下面 INHERIT_IF_EMPTY 的约定一致）。
   * 以前用 s.url 过滤，会把「只覆盖 headers/body、url 继承」的步骤整个丢掉；
   * 全部步骤都留空 url 时甚至静默回落成单请求任务，多步骤配置凭空消失。
   */
  const raw = Array.isArray(cfg.steps) ? cfg.steps.filter((s) => s && (s.url || cfg.url)) : [];
  if (!raw.length) return [{ ...cfg, name: cfg.name || '' }];
  /*
   * 空字符串要当成「没填」，不能当成「就是空」。
   *
   * 前端表单里每个步骤的 headers/body 都读成 ''（语义是「留空继承任务级」），
   * 直接 {...cfg, ...s} 展开会把这些字段从任务级覆盖成空值——任务级配的
   * Authorization / X-QW-Api-Key 就这样被抹掉，多步骤任务一跑就是 401。
   * 这里逐字段判断：空值跳过，才真正实现「留空继承」。
   */
  const INHERIT_IF_EMPTY = new Set(['url', 'method', 'headers', 'body', 'expectStatus', 'alsoOkStatus', 'timeoutSec']);
  return raw.map((s, i) => {
    const merged = { ...cfg };
    for (const [k, v] of Object.entries(s)) {
      if (INHERIT_IF_EMPTY.has(k) && (v === '' || v === null || v === undefined)) continue;
      merged[k] = v;
    }
    merged.name = s.name || merged.name || `第 ${i + 1} 步`;
    return merged;
  });
}

/**
 * 串行跑完所有步骤。
 * - 某步失败时，其余步骤不再执行（后续步骤通常依赖前一步的结果）；
 *   除非该步标了 optional，那就记一笔继续往下走。
 * - 任一步失败，整体算失败，但消息里会列出每一步的结果，便于定位。
 * - 返回 { message, steps[] }：steps 带上每步的响应 JSON，供推送时提取关键数据。
 */
async function runHttpSteps(task) {
  const steps = stepsOf(task);
  const collected = [];
  if (steps.length === 1) {
    /*
     * 必须传合并后的 step：stepsOf 已算好「步骤级覆盖 + 任务级继承」。
     * 以前直接传原 task，用户为单个步骤单独配的 url / method / headers / body
     * 会被静默忽略，实际跑的是任务级配置，现象与「老单请求任务」一模一样，极难排查。
     */
    const r = await runHttpTask({ ...task, config: steps[0] });
    collected.push({ name: steps[0].name || r.stepName || task.name, ...r });
    return { message: r.message, steps: collected };
  }

  const parts = [];
  // 失败步骤的响应正文要一路带最终 throw，否则多步骤任务报错时只剩一句「状态码 500」，
  // 上游到底说了什么（余额不足 / 令牌过期）全丢了。
  let failBody = '';
  let failStatus = null;
  for (const step of steps) {
    const label = step.name;
    try {
      const r = await runHttpTask({ ...task, config: step });
      collected.push({ name: label, ...r });
      parts.push(`[${label}] 成功：${r.message}`);
    } catch (err) {
      collected.push({
        name: label,
        ok: false,
        error: err.message,
        json: null,
        status: err.httpStatus == null ? null : err.httpStatus,
        response: err.responseBody || '',
      });
      if (err.responseBody) failBody = err.responseBody;
      if (err.httpStatus != null) failStatus = err.httpStatus;
      parts.push(`[${label}] 失败：${err.message}`);
      if (step.optional !== true) {
        const left = steps.length - parts.length;
        if (left > 0) parts.push(`余下 ${left} 步已跳过`);
        const e = new Error(parts.join(' ｜ '));
        if (failBody) e.responseBody = failBody;
        if (failStatus != null) e.httpStatus = failStatus;
        throw e;
      }
    }
  }
  return { message: parts.join(' ｜ '), steps: collected };
}

/* ---------------------------------------------------------------- 运行结果提取 */

/*
 * 把「一堆原始 JSON」变成「通知栏能看懂的一句话」。
 *
 * 直推原始响应片段的体验很差：通知栏会是
 *   [签到] 成功：请求成功（400，属可接受状态） 400，耗时 279ms。响应片段：{"code":10001,"msg":"今天已签到…
 * 用户要的是「签到成功 +100，连签 5 天，猫猫在咖啡馆旅行中」这种结论。
 *
 * 两条路：
 *   1. 任务里显式声明 extract（推荐，精确可控）—— 用点号路径从响应里取值；
 *   2. 没声明时走通用启发式：自动挑 msg / 关键数值字段拼一句话。
 */

/** 按 "data.streak_days" 这样的点号路径取值；取不到返回 undefined。 */
function pickPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, k) => {
    if (acc == null) return undefined;
    if (Array.isArray(acc) && /^\d+$/.test(k)) return acc[Number(k)];
    return acc[k];
  }, obj);
}

/** 从单步响应里按声明提取 { label: value }。 */
function extractFromStep(step, fields) {
  const out = {};
  if (!fields || !Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || !f.path) continue;
    const v = pickPath(step.json, f.path);
    if (v === undefined || v === null) continue;
    const label = f.label || f.path;
    out[label] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

/**
 * 把执行消息洗成「能上通知栏」的一句话。
 * 原始消息里常带「响应片段：{"code":...}」，直接推给手机就是一堆 JSON，必须去掉。
 */
function cleanRunMessage(msg) {
  let s = String(msg || '');
  s = s.replace(/响应片段：[\s\S]*$/, '');       // 丢掉报文尾巴
  s = s.replace(/[，,、]\s*$/, '').trim();
  if (!s) s = '执行完成';
  return s.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 通用启发式：从响应 JSON 里找「能说明结果」的字段。
 * 重点是 msg / message（业务方几乎都靠它表达结果），再补充少量常见计数字段。
 */
function heuristicFacts(json) {
  if (!json || typeof json !== 'object') return [];
  const d = (json.data && typeof json.data === 'object') ? json.data : json;
  const facts = [];

  // 常见英文业务提示转中文 —— 通知栏出现 "no unclaimed travel" 对用户没意义
  const ZN = {
    'ok': '',
    'success': '',
    'no unclaimed travel': '暂无待领奖励',
    'not arrived yet': '猫猫还在路上',
    'already traveling': '猫猫正在旅行',
    'daily limit reached': '今日已派满',
    'already checked in': '今日已签到',
    'already signed': '今日已签到',
    'not found': '未找到',
    'unauthorized': '未授权',
    'forbidden': '无权限',
    'invalid token': '凭据失效',
    'token expired': '凭据已过期',
    'too many requests': '请求过于频繁',
    'internal error': '服务端异常',
  };
  const rawMsg = json.msg || json.message || json.error;
  const msg = typeof rawMsg === 'string' ? rawMsg.trim() : '';
  const norm = msg.toLowerCase();
  let msgCn = (norm in ZN) ? ZN[norm] : msg;
  // 未收录的纯英文消息（多为 no-xxx / already-xxx 这类状态语句），
  // 直推英文对用户没意义，给一句通用中文，原始信息留在详情页里
  if (msgCn && /^[a-z][a-z0-9 ,.'_-]*$/i.test(msgCn) && norm !== 'ok' && norm !== 'success') {
    msgCn = `接口提示 ${msg}`;
  }

  const nice = {
    streak_days: '连签', total_credits: '累计', today_credit: '今日',
    balance: '余额', points: '积分', reward_credit: '奖励',
    state: '状态', daily_limit_reached: '今日已派满',
  };
  const counted = [];
  for (const [k, label] of Object.entries(nice)) {
    if (!(k in d)) continue;
    const v = d[k];
    if (v === null || typeof v === 'object') continue;
    if (typeof v === 'boolean') { if (v) counted.push(label); continue; }
    counted.push(`${label} ${v}`);
  }

  // 「OK / 成功」这类空话在有具体数据时就不必占了
  if (msgCn && counted.length && (norm === 'ok' || norm === 'success')) {
    /* 跳过 */
  } else if (msgCn) {
    facts.push({ text: msgCn });
  }

  for (const c of counted) facts.push({ text: c });
  if (d.location && typeof d.location === 'object' && d.location.name) {
    facts.push({ text: `位置 ${d.location.name}` });
  }
  return facts;
}

/**
 * 把 HTTP 步骤的响应 JSON 压成「AI 读得懂、人也能看」的紧凑事实文本。
 *
 * 背景（第 46 轮）：任务的 notifyPrompt 写着「所有事实以输入数据的 elevation
 * 和逐小时字段为准」，但此前只把「HTTP 200，耗时 xxx ms」喂给 AI。
 * 结果 AI 只能按任务名 + 提示语里的气候常识编一段天气，还顺手把标题改掉；
 * 用户看到的「任务列表里找不到的任务名」和「通知里发日志」是同一处漏传。
 *
 * 只做无损压缩，不猜业务含义：daily 前两天全给，hourly 按关键时段抽样
 * （按 time 索引对齐各数值数组），顶层标量作元信息垫在最后。
 * 纯函数，便于离线回归。
 */
/**
 * 和风天气 v1 的摘要。
 *
 * Open-Meteo 是「列式」（hourly.temperature_2m 是数组），和风 v1 是「行式」
 * （days[] / hours[] / alerts[] 每个元素自带全部字段），上面那套通用逻辑完全读不出来——
 * 结果就是 AI 只能对着被截断的原始 JSON 猜数字，实测会把白天的「雨夹雪」写成「今晚」。
 * 这里按接口族把结构拍扁成一行行「字段=值」，附带把 0~1 的比例换成百分比。
 *
 * 认不出形状就返回空数组，交回通用逻辑，不影响 OpenAI 风格的老任务。
 */
function summarizeQWeatherStep(j) {
  const lines = [];
  const n1 = (v, unit = '') => (v == null || v === '' ? '' : `${Math.round(Number(v) * 10) / 10}${unit}`);
  const pct = (v) => (v == null ? '' : `${Math.round(Number(v) * 100)}%`);
  const cond = (c) => (c && c.text ? c.text : '');
  const DIR = {
    n: '北', nne: '北东北', ne: '东北', ene: '东东北', e: '东', ese: '东东南', se: '东南', sse: '南东南',
    s: '南', ssw: '南西南', sw: '西南', wsw: '西西南', w: '西', wnw: '西西北', nw: '西北', nnw: '北西北', vrb: '不定',
  };
  // 和风给的是英文方位码 + 蒲福风级，直接扔给模型会写成「ne1级」，先翻成中文
  const wind = (w) => {
    if (!w || w.scale == null) return '';
    const s = Number(w.scale);
    if (s === 0) return '静风';
    const d = DIR[(w.direction && w.direction.compass) || ''] || '';
    return `${d}${s}级`;
  };

  // 单个时间点的天气（实况与逐小时共用同一套字段名）
  const point = (o) => {
    const bits = [];
    if (cond(o.condition)) bits.push(`现象=${cond(o.condition)}`);
    if (o.temperature) bits.push(`温度=${n1(o.temperature.value, '°C')}`);
    if (o.feelsLike) bits.push(`体感=${n1(o.feelsLike.value, '°C')}`);
    if (o.humidity != null) bits.push(`湿度=${pct(o.humidity)}`);
    if (o.wind) bits.push(`风=${wind(o.wind)}`);
    if (o.precipitation) {
      const p = o.precipitation;
      if (p.type && p.type !== 'none') bits.push(`降水=${p.type}${n1(p.amount && p.amount.value, 'mm')}`);
      if (p.probability != null) bits.push(`降水概率=${pct(p.probability)}`);
    }
    if (o.uvIndex != null) bits.push(`紫外线=${o.uvIndex}`);
    return bits.join(' ');
  };

  // ① 实况
  if (j.condition && j.temperature) lines.push(`实况 ${point(j)}`);

  // ② 逐日：白天/夜间分开给，提示词里的「今晚」要取 nighttime
  if (Array.isArray(j.days)) {
    j.days.slice(0, 2).forEach((d, i) => {
      const day = d.daytime || {};
      const night = d.nighttime || {};
      const bits = [];
      const date = String(d.forecastStartTime || '').slice(5, 10);
      if (date) bits.push(`日期=${date}`);
      if (d.temperatureMin) bits.push(`全天最低=${n1(d.temperatureMin.value, '°C')}`);
      if (d.temperatureMax) bits.push(`全天最高=${n1(d.temperatureMax.value, '°C')}`);
      if (cond(day.condition)) bits.push(`白天=${cond(day.condition)}`);
      if (cond(night.condition)) bits.push(`夜间=${cond(night.condition)}`);
      if (night.temperatureMin) bits.push(`夜间最低=${n1(night.temperatureMin.value, '°C')}`);
      if (day.wind) bits.push(`白天风=${wind(day.wind)}`);
      if (day.precipitation) {
        const p = day.precipitation;
        if (p.probability != null) bits.push(`降水概率=${pct(p.probability)}`);
        if (p.amount) bits.push(`降水量=${n1(p.amount.value, 'mm')}`);
        if (p.type && p.type !== 'none') bits.push(`降水类型=${p.type}`);
      }
      if (d.uvIndexMax != null) bits.push(`紫外线最大=${d.uvIndexMax}`);
      lines.push(`daily[${i}] ${bits.join(' ')}`);
    });
  }

  // ③ 逐小时：只抽关键时段，24 条全给会把提示词撑爆
  if (Array.isArray(j.hours)) {
    const KEY = new Set(['20:00', '23:00', '02:00', '05:00', '08:00', '11:00', '14:00', '17:00']);
    for (const h of j.hours) {
      if (!KEY.has(String(h.forecastTime || '').slice(11, 16))) continue;
      lines.push(`hourly ${String(h.forecastTime || '').slice(5, 16)} ${point(h)}`);
    }
  }

  // ④ 预警：空也要写明「无」，否则模型容易自己编一条 ⚠
  if (Array.isArray(j.alerts)) {
    if (!j.alerts.length) lines.push('预警 无');
    for (const a of j.alerts.slice(0, 3)) {
      const t = (a.eventType && a.eventType.name) || a.headline || '';
      const lv = (a.color && a.color.code) || '';
      lines.push(`预警 ${t}/${lv} 发布=${a.senderName || ''} 失效至=${String(a.expireTime || '').slice(0, 16)} 摘要=${String(a.headline || '').slice(0, 30)}`);
    }
  }

  // ⑤ 空气质量
  if (Array.isArray(j.indexes) && j.indexes.length) {
    const i0 = j.indexes[0];
    lines.push(`空气质量 AQI=${i0.aqi} 等级=${i0.category || ''}`);
  }

  return lines;
}

function summarizeStepData(steps, cap) {
  // 只有调用方显式给 cap（通知栏兜底摘要 600 字）才压缩；
  // 给 AI 的事实材料默认全部给出 —— 旧的 5000/8000 上限会把「明天傍晚」那段吃掉，
  // 雨雪判断直接漏掉。上限统一到 RESULT_BODY_MAX 这个异常安全阀。
  const limit = cap == null
    ? RESULT_BODY_MAX
    : Math.max(400, Math.min(RESULT_BODY_MAX, Number(cap) || 5000));
  // 覆盖傍晚到次日傍晚的完整 24 小时，约每 2 小时一个采样点
  const KEY_HOURS = new Set(['17:00', '18:00', '20:00', '22:00', '00:00', '02:00',
    '06:00', '08:00', '10:00', '12:00', '14:00', '16:00']);
  const UNIT = {
    temperature_2m: '°C', apparent_temperature: '°C',
    precipitation_probability: '%', precipitation: 'mm', wind_speed_10m: 'km/h',
    snowfall: 'cm',
  };
  const out = [];
  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (!s || s.ok === false || !s.json || typeof s.json !== 'object') continue;
    const j = s.json;
    const tag = `[${String(s.name || '步骤').slice(0, 24)}]`;
    const fmt = (k, v) => `${k}=${v}${UNIT[k] || ''}`;

    /*
     * 和风 v1 先行：行式对象数组（days/hours/alerts/indexes），通用列式逻辑读不出来。
     * 也不用再补「元信息」那行——v1 的顶层标量是 humidity=0.8 这类比例值，
     * 和我们拍扁后的「湿度=80%」并存会自相矛盾，模型容易抄错。
     */
    const qw = summarizeQWeatherStep(j);
    if (qw.length) {
      for (const line of qw) out.push(`${tag} ${line}`);
      continue;
    }

    // ① 顶层标量先给：提示语常点名要 elevation / timezone，别让它被后面的长表挤掉
    const meta = [];
    for (const [k, v] of Object.entries(j)) {
      if (meta.length >= 10) break;
      if (v === null || typeof v === 'object') continue;
      meta.push(`${k}=${v}`);
    }
    if (meta.length) out.push(`${tag} 元信息 ${meta.join(' · ')}`);

    // ② daily：逐天列，最多 2 天（天气类接口的「今天 / 明天」落在这里）
    const daily = j.daily;
    if (daily && typeof daily === 'object') {
      const keys = Object.keys(daily).filter((k) => Array.isArray(daily[k]));
      let days = 0;
      for (const k of keys) days = Math.max(days, daily[k].length);
      days = Math.min(2, days);
      for (let i = 0; i < days; i++) {
        const bits = keys.map((k) => `${k}=${daily[k][i]}`);
        if (bits.length) out.push(`daily[${i}] ${bits.join(' ')}`);
      }
    }

    // ③ hourly：抽关键时段，按 time 索引对齐各数值数组
    const hourly = j.hourly;
    if (hourly && typeof hourly === 'object' && Array.isArray(hourly.time)) {
      const keys = Object.keys(hourly).filter((k) => k !== 'time' && Array.isArray(hourly[k]));
      const pick = (k, i) => Number((hourly[k] || [])[i] ?? 0);
      /*
       * 雨雪 / 大雾 / 强降水可能只落在两个采样点之间。
       * 光靠固定时段抽样，「下雨带伞」「下雪出行平安」就会因为一场短时阵雨漏判，
       * 所以额外把出现天气编码或降水的时刻补进来（最多 6 个，防止把摘要撑爆）。
       */
      const extra = new Set();
      for (let i = 0; i < hourly.time.length && extra.size < 6; i++) {
        const hm = String(hourly.time[i] || '').slice(11, 16);
        if (KEY_HOURS.has(hm)) continue;
        if (pick('weather_code', i) >= 45 || pick('precipitation', i) > 0
          || pick('snowfall', i) > 0 || pick('precipitation_probability', i) >= 60) extra.add(i);
      }
      const seen = new Set();
      for (let i = 0; i < hourly.time.length; i++) {
        const t = String(hourly.time[i] || '');
        const hm = t.slice(11, 16);
        if (!KEY_HOURS.has(hm) && !extra.has(i)) continue;
        const key = t.slice(0, 10) + hm;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(`hourly ${t} ${keys.map((k) => fmt(k, hourly[k][i])).join(' ')}`);
      }
    }

    // ④ 没有 hourly/daily 的普通 JSON：原样给，让 AI 自己读（不猜字段名）
    if (!daily && !hourly) {
      const raw = JSON.stringify(j);
      if (raw && raw.length > 2) out.push(`${tag} 响应 ${raw}`);
    }
  }
  const text = out.join('\n');
  return limit > 0 && text.length > limit ? text.slice(0, limit) + '\n…（数据已截断）' : text;
}

/**
 * 生成推送内容：通知栏一句话 + 详情页 markdown。
 * 返回 { title, body, markdown }。
 */
function buildRunNotice(task, { ok, message, duration, stepResults, trigger }) {
  const fields = (task.config && Array.isArray(task.config.extract)) ? task.config.extract : null;
  const title = (ok ? '✅ ' : '❌ ') + task.name;

  // 逐步骤收集事实
  const lines = [];
  const facts = [];
  for (const s of (stepResults || [])) {
    if (!s) continue;
    if (s.ok === false) {
      lines.push(`- ❌ **${s.name}**：${String(s.error || '').slice(0, 120)}`);
      continue;
    }
    const ext = fields ? extractFromStep(s, fields) : {};
    const bits = [];
    if (Object.keys(ext).length) {
      for (const [k, v] of Object.entries(ext)) bits.push(`${k} ${v}`);
    } else {
      for (const f of heuristicFacts(s.json)) bits.push(f.text);
    }
    const tail = bits.length ? `：${bits.join(' · ')}` : `：HTTP ${s.status == null ? '-' : s.status}`;
    lines.push(`- ✅ **${s.name}**${tail}`);
    if (bits.length) facts.push(...bits);
  }

  // 通知栏正文：优先用提取到的业务事实，退化时用步骤结论
  let body;
  if (facts.length) {
    body = facts.join(' · ');
  } else if ((stepResults || []).length === 1 && ok) {
    /*
     * 单步骤又没提取到业务字段时，过去直接推「HTTP 200，耗时 xxx ms」——
     * 那是执行状态，不是任务抓到的结果（用户原话：「发日志内容干嘛」）。
     * 现在优先给接口返回的真实数据摘要；只有连摘要都没有才退回状态行。
     */
    const rows = summarizeStepData(stepResults, 600).split('\n');
    // 兜底正文只有 160 字，优先露出「今天/明天」的业务数值，元信息等技术字段排后面
    const ranked = [...rows.filter((l) => l.startsWith('daily[')), ...rows.filter((l) => !l.startsWith('daily['))];
    const digest = ranked.join(' ').replace(/\s+/g, ' ').trim();
    const s0 = stepResults[0] || {};
    body = digest || `HTTP ${s0.status == null ? '-' : s0.status}，耗时 ${duration} ms`;
  } else if (lines.length) {
    body = lines.join('；').replace(/[*✅❌-]/g, '').trim();
  } else {
    body = cleanRunMessage(message);
  }
  body = body.replace(/\s+/g, ' ').slice(0, 160);

  // 详情页：结构化列表，比通知栏完整
  const md = [];
  md.push(`## ${ok ? '执行成功' : '执行失败'}：${task.name}`);
  md.push('');
  for (const l of lines) md.push(l);
  md.push('');
  md.push(`> 耗时 ${duration} ms ｜ 触发方式 ${trigger || 'schedule'} ｜ ${new Date().toLocaleString('zh-CN', { timeZone: state.settings.timezone || 'Asia/Shanghai' })}`);
  if (!ok) {
    md.push('');
    md.push('```');
    md.push(String(message || '').slice(0, 500));
    md.push('```');
  }

  return { title, body, markdown: md.join('\n') };
}

/* ------------------------------------------------------------ 任务级失败重试 */

/*
 * 为什么要重试：定时任务跑在云端出口，偶发一次 ECONNRESET / 5xx 就判失败，
 * 用户收到「执行失败」告警点进去看，上游其实一切正常 —— 这类假告警最消耗信任。
 *
 * 但重试是把双刃剑：签到、下单、领券这类请求执行两次就是两个副作用。
 * 所以默认 0 次（老任务行为完全不变），由用户按任务自己开。
 * 判定也只认「重试有意义」的错误：
 *   · 没有状态码 —— 连接层失败（超时、连接重置、DNS、TLS 握手）
 *   · 5xx / 408 / 429 —— 上游临时故障或限流
 *   · 其余 4xx（401/403/404/422…）重试只是重复撞墙，直接判失败
 */
function retryPolicyOf(task) {
  const r = (task && task.config && task.config.retry) || {};
  const times = Math.max(0, Math.min(RETRY_MAX_TIMES, Number(r.times) || 0));
  const delayMs = Math.max(500, Math.min(30000, Number(r.delayMs) || 3000));
  return { times, delayMs };
}

function isTransientFailure(err) {
  const st = err && err.httpStatus;
  if (st == null || st === '') return true; // 无状态码 = 连接层失败
  const n = Number(st);
  if (!Number.isFinite(n)) return true;
  return n >= 500 || n === 408 || n === 429;
}

async function runTask(task, trigger) {
  const startedAt = Date.now();
  /*
   * 运行中标记：进程如果在这一句和结尾之间被回收，重启后 state.json 里会留下 runningAt，
   * 启动扫描（recoverInterruptedRuns）据此提示「上次执行中途中断」。
   * 只是留痕，不自动补跑 —— 补跑会让「已经签到成功但没来得及记」变成签到两次。
   */
  task.runningAt = nowISO();
  flushState();
  let ok = true;
  let message = '';
  let stepResults = [];
  // 最近一次拿到的响应正文：成功时从步骤结果里拼，失败时从 error 上取。
  // 单独存一份是因为日志要展示「接口到底返回了什么」，而 message 只是给人看的一句话。
  let responseBody = '';
  // 实际尝试了几次（含首次）。1 = 没触发重试；>1 表示重试过，日志里要写清楚。
  let attempts = 0;
  try {
    // 用到 {{ACCESS_TOKEN}} 的任务，执行前先确保凭据可用（快到期就顺手续上）
    if (task.type === 'http' && usesTokenPlaceholder(task)) {
      await currentAccessToken();
    }
    if (task.type === 'http') {
      const policy = retryPolicyOf(task);
      for (;;) {
        attempts += 1;
        try {
          const rr = await runHttpSteps(task);
          message = rr.message;
          stepResults = rr.steps || [];
          responseBody = joinStepBodies(stepResults);
          if (attempts > 1) {
            /*
             * 重试成功必须留下痕迹：结果看着是「成功」，但上游第一次确实挂了，
             * 不标注的话用户会以为一切正常，等到重试也救不回来那天才发现问题。
             */
            const note = `第 ${attempts} 次尝试成功（前 ${attempts - 1} 次为可重试失败）`;
            message = note + '｜' + message;
            pushSysLog({
              level: 'warn',
              source: 'task',
              msg: `任务「${task.name}」${note}`,
              detail: { taskId: task.id, taskName: task.name, attempts },
            });
          }
          break;
        } catch (err) {
          const canRetry = attempts <= policy.times && isTransientFailure(err);
          if (!canRetry) throw err;
          // 线性退避：第 n 次失败等 n×间隔。总等待有上限（3×30s），不会把调度卡死。
          const wait = policy.delayMs * attempts;
          pushSysLog({
            level: 'warn',
            source: 'task',
            msg: `任务「${task.name}」第 ${attempts} 次失败（${String(err.message || '').slice(0, 120)}），${Math.round(wait / 1000)}s 后重试`,
            detail: { taskId: task.id, taskName: task.name, attempt: attempts, delayMs: wait },
          });
          await sleepMs(wait);
        }
      }
    } else {
      const cfg = task.config || {};
      const channels = withInapp(sanitizeChannelList(Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : ['inapp']));
      const results = [];
      if (channels.includes('inapp')) {
        pushNotification({ level: 'remind', title: task.name, body: cfg.message || '', source: 'task:' + task.id });
        results.push('站内提醒已记录');
      }
      // 其余渠道统一走 resolveChannel：默认那套与多实例实例用同一套发送逻辑
      for (const ch of channels.filter((c) => c !== 'inapp')) {
        if (ch === 'notifyme') {
          try {
            const r = await sendNotifyMe(state.settings.notifyme, {
              title: task.name, body: cfg.message || '',
              nm: nmForTask(state.settings.notifyme, task),
            });
            results.push(r.message);
            pushSysLog({
              level: r.ok ? 'info' : 'warn',
              source: 'channel',
              msg: `渠道 NotifyMe 手机推送 ${r.ok ? '已提交' : '未成功'}：${String(r.message || '').slice(0, 200)}`,
              detail: { channel: 'NotifyMe', task: task.name, ok: !!r.ok, message: String(r.message || '').slice(0, 400) },
            });
          } catch (e) {
            ok = false;
            results.push('手机推送失败：' + e.message);
            pushSysLog({
              level: 'error',
              source: 'channel',
              msg: '渠道 NotifyMe 手机推送失败：' + String(e.message || '').slice(0, 200),
              detail: { channel: 'NotifyMe', task: task.name, error: String(e.message || '').slice(0, 400) },
            });
          }
          continue;
        }
        const rc = resolveChannel(ch);
        if (!rc || !rc.cfg) {
          results.push(`${rc ? rc.label : ch} 不可用（配置已删除或未启用）`);
          continue;
        }
        if (!channelReady(ch)) {
          results.push(`${rc.label} 未启用，跳过`);
          continue;
        }
        try {
          const r = await sendChannel(rc, { title: task.name, body: cfg.message || '', markdown: '', level: 'remind' });
          results.push(r.message || `${rc.label} 已发送`);
          pushSysLog({
            level: r.ok ? 'info' : 'warn',
            source: 'channel',
            msg: `渠道 ${rc.label} ${r.ok ? '发送成功' : '发送失败'}：${String(r.message || '').slice(0, 200)}`,
            detail: { channel: rc.label, task: task.name, ok: r.ok, message: String(r.message || '').slice(0, 400) },
          });
          if (!r.ok) ok = false;
        } catch (e) {
          ok = false;
          results.push(`${rc.label} 失败：${e.message}`);
        }
      }
      message = results.join('；') || '无可用通道';
      if (!ok) throw new Error(message);
    }
  } catch (err) {
    ok = false;
    message = err.message || String(err);
    if (err && err.responseBody) responseBody = clipBody(err.responseBody, RESULT_BODY_MAX);
  }

  const duration = Date.now() - startedAt;
  /*
   * 从这里到返回之间还有一大段同步逻辑（写执行日志、发通知、落盘）。任何一步抛错，
   * 都会跳过函数末尾的 runningAt 清理；标记一旦残留，这个任务以后每次手动执行
   * 都会被 /api/tasks/:id/run 的 409「正在执行中」挡住，直到重启才由
   * recoverInterruptedRuns 救回来。用 finally 兜住清理，异常照常冒泡。
   * （内部代码保持原缩进，只为让这次改动的 diff 最小、不引入无关重排。）
   */
  try {
  const at = nowISO();
  task.lastRun = at;
  // 存一份精简的步骤结果：既能让「预览通知」复现真实内容，也方便事后查是哪个字段没取到
  const stepDigest = (stepResults || []).map((s) => ({
    name: s.name,
    ok: s.ok !== false,
    status: s.status == null ? null : s.status,
    json: s.json || null,
    ...(s.ok === false ? { error: clipBody(s.error || '') } : {}),
  }));
  task.lastResult = { ok, message, duration, trigger, steps: stepDigest, response: responseBody || '', ...(attempts > 1 ? { attempts } : {}) };
  task.runCount = (task.runCount || 0) + 1;

  pushSysLog({
    level: ok ? 'info' : 'error',
    source: 'task',
    msg: `任务「${task.name}」${ok ? '执行成功' : '执行失败'}（${duration}ms，${trigger === 'manual' ? '手动触发' : '定时触发'}）`,
    detail: {
      taskId: task.id,
      taskName: task.name,
      ok,
      duration,
      trigger,
      message: clipBody(message || ''),
      attempts: attempts > 1 ? attempts : undefined,
      steps: stepDigest.length ? stepDigest : undefined,
    },
  });

  /*
   * ★ 两段提交的第一段：执行结果先落盘，再谈推送。
   *
   * 原实现把 lastResult / state.logs / saveState 全部放在推送之后，而推送要等短信
   * 5~45 秒（多渠道路径并行，取最慢的那个）。这段时间里进程被平台回收，后果是
   * 「任务其实已经执行了（签到已到账、订单已下），但状态、日志、nextRun 一个都没落盘」，
   * 重启后把同一时刻再跑一遍 —— 重复副作用。
   * 现在先把事实写进 state.json：推送失败最多丢一条通知，绝不会重复执行。
   */
  if (!ok) {
    task.failCount = (task.failCount || 0) + 1;
  } else {
    task.failCount = 0;
  }
  /*
   * 运行指标（第十八批）：成功 / 失败各记一笔，重试后成功另记「救回」。
   *
   * 「重试救回」是这一批真正想看见的数：失败次数只说明「有抖动」，
   * 救回次数说明「抖动被自愈了，不用管」，两者混在一个数里就完全读不出结论。
   * 放在告警之前 —— 统计不该被推送链路的任何异常牵连。
   */
  recordMetric(ok ? 'ok' : 'fail', { duration });
  // 重试救回：重试循环里已经打了 warn 日志（见 runTask 的 attempts 分支），
  // 这里只补一个指标计数 —— 日志是一次性的，指标才能看出「这周自愈了几次」。
  if (ok && attempts > 1) recordMetric('retry');
  /*
   * 连续失败升级为告警。
   *
   * 以前 failCount 只是个数字，挂在任务卡上等人自己发现 —— 签到连续失败一周也没人知道，
   * 直到想起来去看一眼。这里在第 3 次和第 10 次各提醒一次（不刷屏），
   * 并且明确写出「最后一次的错误」，免得还要点进去翻日志。
   */
  // 第 11 次起每 10 次再提醒一次：凭据过期这类持续故障，以前恰好在第 10 次之后
  // 进入永久静默，反而最需要提醒的时间段没人知道。
  if (!ok && (task.failCount === 3 || task.failCount === 10
      || (task.failCount > 10 && task.failCount % 10 === 0))) {
    pushNotification({
      level: 'error',
      title: `⚠ 连续失败 ${task.failCount} 次：${task.name}`,
      body: `任务「${task.name}」已经连续失败 ${task.failCount} 次。\n最近一次：${String(message || '').slice(0, 300)}\n建议去任务详情看一眼请求配置或凭据是否过期。`,
      source: 'task:' + task.id,
      taskName: task.name,
      trigger,
    });
    pushSysLog({
      level: 'error',
      source: 'task',
      msg: `任务「${task.name}」连续失败 ${task.failCount} 次，已发告警`,
      detail: { taskId: task.id, taskName: task.name, failCount: task.failCount, message: String(message || '').slice(0, 300) },
    });
  }
  /*
   * 手动执行不该推进节奏：从「现在」重算会把 interval 任务的下一次执行整体往后推
   * （09:30 手跑一次每小时任务，原定 10:00 会被推到 10:30）。
   * 只有 nextRun 已经过期（这次属于补跑）才重算，否则下一轮 tick 会立刻再跑一遍。
   */
  if (trigger === 'manual' && task.enabled
      && (!task.nextRun || Date.parse(task.nextRun) <= Date.now())) {
    task.nextRun = computeNextRun(task, new Date())?.toISOString() || null;
  }
  state.logs.unshift({
    id: uid('log'),
    taskId: task.id,
    taskName: task.name,
    ok,
    message,
    duration,
    trigger,
    at,
    // 响应正文按需带：空就不写字段，免得每条日志都挂一个空字符串
    ...(responseBody ? { response: responseBody } : {}),
  });
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
  flushState();

  // HTTP 任务的推送内容从响应里提取，remind 任务用自己的消息
  const isHttp = task.type === 'http';
  const notice = isHttp
    ? buildRunNotice(task, { ok, message, duration, stepResults, trigger })
    : { title: (ok ? '🔔 ' : '❌ ') + task.name, body: String((task.config && task.config.message) || '').slice(0, 160), markdown: '' };

  // 通知优化管线（均可选，失败一律回退原文）：① 任务级模版替换正文 ② AI 按提示词改写
  // AI 结尾状态标注：成功 →「✨ 已由 AI 优化」；失败 →「⚠ AI 优化未采用（原因），本次为原文」
  let aiNote = '';
  try {
    const tpl = isHttp && task.config && task.config.notifyTemplate;
    if (tpl) {
      const vars = {
        title: notice.title,
        body: notice.body,
        result: String(message || ''),
        duration: `${Math.round((duration || 0) / 100) / 10}s`,
        time: new Date().toLocaleString('zh-CN'),
        status: ok ? '成功' : '失败',
      };
      notice.body = String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? '')).slice(0, 480);
    }
    // AI 实例：任务可以指定用哪一套（多供应商/多 Key），不指定就用「默认」那套
    let aiCfg = state.settings.ai;
    const aiInstId = isHttp && task.config && task.config.aiInstance;
    if (aiInstId) {
      const rcAi = resolveChannel('ai:' + aiInstId);
      if (rcAi && rcAi.cfg) {
        // 多账号实例没单独调过超时/重试时跟随全局设置（老实例配置里没有这两个字段）
        const g = state.settings.ai || {};
        aiCfg = {
          ...rcAi.cfg,
          enabled: rcAi.enabled !== false,
          timeoutMs: Number(rcAi.cfg.timeoutMs) || Number(g.timeoutMs) || AI_TIMEOUT_MS,
          maxAttempts: Number(rcAi.cfg.maxAttempts) || Number(g.maxAttempts) || AI_MAX_ATTEMPTS,
        };
      }
    }
    /*
     * 任务级 AI 开关（第十一批）：显式 false = 这个任务完全不优化，连接口都不调。
     * 老任务没存过这个字段按 true 处理，线上已有任务的行为不变。
     * 以前「有没有提示词」被当成隐含开关：全局默认提示语一写，所有 HTTP 任务一律跑 AI，
     * 想单独关掉某个任务只能清空全局那句（会影响全部任务）；两处都空则 AI 配置
     * 再完整也不调用。现在开关归开关、提示语归提示语，空提示语用内置兜底。
     */
    const taskAiOn = isHttp && task.config && task.config.aiEnabled !== false;
    // 全局默认只是「补充」；任务里写的要求单独进 system，当硬性约束（见 aiPolish 注释）
    const aiHead = String((aiCfg && aiCfg.defaultPrompt) || '').trim();
    const aiTaskNeed = String((isHttp && task.config && task.config.notifyPrompt) || '').trim();
    if (isHttp && taskAiOn && aiCfg && aiCfg.enabled) {
      // 与兜底正文共用同一份接口事实，避免出现「AI 编的播报」和「状态日志」两套内容
      const rawData = summarizeStepData(stepResults);
      const polished = await aiPolish(aiCfg, {
        title: notice.title, body: notice.body,
        instruction: aiHead, taskInstruction: aiTaskNeed,
        taskName: task.name, rawData,
      });
      if (polished) {
        /*
         * 标题固定用任务名。AI 曾把「24 h天气三甲集」改写成
         * 「甘肃广河三甲集 24h 天气播报」，又长又不在任务列表里，
         * 用户按任务名找不到对应通知。AI 只负责正文，不碰标题。
         */
        // 留一份 AI 之前的原文：通知详情里能直接切换比对「到底改了什么」，
        // 这是用户判断「AI 有没有用」唯一靠得住的依据。以前只留 800 字，
        // 多步骤任务的原文后半段直接消失；现在完整保留，只受统一安全阀约束。
        notice.rawBody = clipBody(notice.body || '');
        notice.body = polished.body;
        /*
         * 标注要能核对：以前只写「按任务要求」，但模型可能压根没照做，用户看到的
         * 是一句无法验证的自我声明。现在带上机器校验结果 —— 全过写「已校验 N 项」，
         * 有漏项就直接点名违反了哪条，用户不用猜。
         */
        const tag = polished.usedTaskInstruction ? '按任务要求' : '用默认要求';
        const bad = polished.violations || [];
        if (bad.length) {
          aiNote = `✨ 已由 AI 优化（${tag}，${bad.length} 项未达标：${bad[0].msg}）`;
        } else {
          aiNote = polished.attempts > 1
            ? `✨ 已由 AI 优化（${tag}，已校验 ${polished.checks} 项 · 纠正后达标）`
            : `✨ 已由 AI 优化（${tag}，已校验 ${polished.checks} 项）`;
        }
      }
    }
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    // 英文超时堆栈不该占短信字数（还容易撞风控），正文只留一句中文标识，原因进系统日志
    // 正文只留一句中文标识（英文堆栈会占短信字数、还容易撞风控），但原因要能一眼看出来：
    // 超时（模型慢）和网络不通是两种完全不同的处置，都写成「原始数据」等于没说。
    const kind = /timeout|timed out|aborted/i.test(why) ? '超时'
      : /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(why) ? '网络'
        : '未返回';
    aiNote = `⚠ 本次为接口原始数据（AI ${kind}）`;
    pushSysLog({
      level: 'warn', source: 'ai',
      msg: `「${task.name}」AI 优化失败，已用接口原始数据`,
      detail: { taskId: task.id, error: why },
    });
    console.log(`[notify] 「${task.name}」AI 优化失败（用原始数据）: ${why}`);
  }
  // AI 状态标注不再并进正文：短信/通知栏里「✨ 已由 AI 优化」是纯元信息，
  // 既占字数又打断分行。改为独立字段，站内通知详情以小字留痕。
  if (aiNote) notice.aiNote = aiNote;

  // 手机推送要不要发，由「全局开关 + 任务自己的开关」共同决定
  const np = taskNotifyPolicy(task);

  /*
   * 哪些渠道是「任务里逐个点过名」的。
   * 点了名的渠道走显式通道：跳过通道类型级的默认降噪（notifyTiming / sms.minLevel），
   * 因为用户在那个任务的编辑页里已经明确表达了「这个时机用这个渠道」。
   */
  const explicitChannels = new Set(
    (Array.isArray(task.config && task.config.notify && task.config.notify.channels)
      ? sanitizeChannelList(task.config.notify.channels)
      : []).filter((c) => c !== 'inapp'),
  );

  /*
   * 双层闸门：任务级（成功时/失败时）→ 渠道级（notifyTiming，通道类型级配置）
   *
   * 第二层（notifyTiming）是「通道类型级」的历史设置，页面上没有入口。
   * 它只对「没被逐个点名的渠道」生效：任务里明确勾了某个渠道时，用户意图更具体，
   * 由任务级的 onSuccess / onFailure 说了算——两层 AND 只会造成「勾了却没收到」。
   */
  const channelAllows = (ch, ok) => {
    if (ch === 'inapp') return true; // 站内消息始终记录
    /*
     * notifyme 是独立通道，不参与 resolveChannel（那里只认 sms/webhook/email/ai）。
     * 以前这里直接走 resolveChannel → 拿到 null → 永远返回 false，
     * 结果是「任务里勾了 NotifyMe 却一条都不发」，只能靠 webhook 的 notifyme 格式绕过去。
     */
    if (ch === 'notifyme') {
      const nm = state.settings.notifyme || {};
      if (!nm.enabled || !(nm.uuid || nm.token)) return false;
      if (explicitChannels.has('notifyme')) return true;
      const t = (state.settings.notifyTiming || {}).notifyme || {};
      return ok ? !!t.onSuccess : t.onFailure !== false;
    }
    const rc = resolveChannel(ch);
    if (!rc || !rc.cfg) return false;
    if (!channelReady(ch)) return false;
    if (explicitChannels.has(ch)) return true;   // 任务里点过名：时机由任务级决定
    const t = (state.settings.notifyTiming || {})[rc.type] || {};
    return ok ? !!t.onSuccess : t.onFailure !== false;
  };
  if (task.type === 'http' && (ok ? np.onSuccess : np.onFailure)) {
    // 各渠道并行发送：慢渠道（如短信 5~45s）不再拖累其他渠道
    const sendOneRaw = async (ch) => {
      try {
        if (ch === 'notifyme') {
          // 任务里单独设过 NotifyMe 高级选项就用任务的，没设跟随全局
          return await sendNotifyMe(state.settings.notifyme, {
            title: notice.title, body: notice.body, markdown: notice.markdown,
            nm: nmForTask(state.settings.notifyme, task),
          });
        }
        const rc = resolveChannel(ch);
        if (!rc || !rc.cfg) return { ok: false, message: `${rc ? rc.label : ch} 的配置已删除` };
        // 手动执行要能马上看到结果：短信走 3s 快速退避，失败即转本机通道，
        // 不要用定时任务那套 60s→300s 的退避把人晾几分钟
        return await sendChannel(rc, { title: notice.title, body: notice.body, markdown: notice.markdown, level: ok ? 'success' : 'error' }, { explicit: explicitChannels.has(ch), manual: trigger === 'manual', task });
      } catch (e) {
        return { ok: false, message: e.message };
      }
    };
    /*
     * 单渠道发送 + 重试（最多 3 次，退避 800ms / 2400ms）。
     * 原来每个渠道只发一次，网络抖一下这条通知就永久没了。
     * 短信不在这里重试：lib/sms 自己带退避与死信，套两层会发出重复短信。
     */
    const sendOne = async (ch) => {
      const isSms = (resolveChannel(ch) || {}).type === 'sms';
      const MAX = 3;
      const backoff = [800, 2400];
      let last = { ok: false, message: '未发送' };
      for (let i = 0; i < MAX; i++) {
        last = await sendOneRaw(ch);
        if (last && last.ok) return { ...last, attempts: i + 1 };
        if (isSms || !retryableFailure(last && last.message)) return { ...(last || {}), attempts: i + 1 };
        if (i < MAX - 1) await sleepMs(backoff[i]);
      }
      return { ...(last || {}), attempts: MAX, exhausted: true };
    };
    const labelOf = (ch) => {
      if (ch === 'notifyme') return 'NotifyMe（手机推送）';
      const rc = resolveChannel(ch);
      return rc ? rc.label : ch;
    };
    const external = np.channels.filter((ch) => ch !== 'inapp' && channelAllows(ch, ok));
    /*
     * 被挡下的渠道也要在通知记录里留一行原因。
     * 之前是静默过滤：任务里勾了短信、通道却没开（或时机不匹配），
     * 通知详情里只有「站内已记录」，用户只能得出「勾了没收到」——
     * 看不见原因就等于没救。现在每条被挡的渠道都写明为什么没发。
     */
    const skipReasonOf = (ch) => {
      // notifyme 是独立通道，不走 resolveChannel（那里只认 sms/webhook/email/ai）
      if (ch === 'notifyme') {
        const nm = state.settings.notifyme || {};
        if (!nm.enabled) return 'NotifyMe 未启用，去设置页打开后这里就会发';
        if (!(nm.uuid || nm.token)) return 'NotifyMe 缺凭据（UUID 或 FCM token），去设置页补上';
        return '该通道当前不发送';
      }
      const rc = resolveChannel(ch);
      if (!rc || !rc.cfg) return '配置已删除，请到设置页重新配置';
      if (!channelReady(ch)) return '该通道未启用，去设置页打开后这里就会发';
      const t = (state.settings.notifyTiming || {})[rc.type] || {};
      return ok ? '该通道设为「仅失败时发送」' : '该通道设为「仅成功时发送」';
    };
    const skipped = np.channels
      .filter((ch) => ch !== 'inapp' && !external.includes(ch))
      .map((ch) => ({ name: labelOf(ch), ok: false, message: '未发送：' + skipReasonOf(ch) }));
    /*
     * map 回调整体兜异常：labelOf() / resolveChannel() 这些同步求值在 sendOneRaw 的
     * try 之外，一处抛错会让 Promise.all 整体 reject，已成功渠道的结果全被丢弃，
     * 死信与通知记录都不写，异常再冒泡到 tick。改成单渠道失败各自成行。
     */
    const outcomes = await Promise.all(external.map(async (ch) => {
      try {
        return { ch, label: labelOf(ch), r: await sendOne(ch) };
      } catch (e) {
        return { ch, label: ch, r: { ok: false, message: '发送异常：' + String((e && e.message) || e).slice(0, 160) } };
      }
    }));
    // 重试耗尽仍未送达 → 进死信（站内另有一条 📮 提示，通知页可见；载荷留着可重放）
    for (const o of outcomes) {
      if (!o.r || o.r.ok || !o.r.exhausted) continue;
      pushDeadLetter({
        channel: o.ch,
        label: o.label,
        title: notice.title,
        body: notice.body,
        markdown: notice.markdown,
        message: o.r.message,
        attempts: o.r.attempts,
        taskName: task.name,
      });
    }
    // 站内消息统一最后落库，附上各渠道推送结果——通知页可直接看到「通知了什么、走了哪些渠道」
    pushNotification({
      level: ok ? 'success' : 'error',
      title: notice.title,
      body: notice.body,
      source: 'task:' + task.id,
      taskName: task.name,
      trigger,
      aiNote: notice.aiNote || '',
      rawBody: notice.rawBody || '',
      channels: [
        { name: '站内', ok: true, message: '已记录' },
        ...outcomes.map((o) => ({ name: o.label, ok: !!(o.r && o.r.ok), message: (o.r && o.r.message) || '' })),
        ...skipped,
      ],
    });
    console.log(`[notify] 「${task.name}」${ok ? '成功' : '失败'}通知: ${[...outcomes.map((o) => `${o.label}: ${(o.r && o.r.message) || ''}`), ...skipped.map((s) => `${s.name}: ${s.message}`)].join('；') || '无可用渠道'}`);
  } else if (task.type === 'http') {
    console.log(`[notify] 「${task.name}」${ok ? '成功' : '失败'}，未勾选该时机的通知或总开关关闭，跳过`);
  }
  /*
   * ★ 第二段提交：推送结果 + 站内记录落盘。
   * 执行结果在上面的第一段已经写过盘了，这里补的是「通知发了没、走了哪些渠道」。
   * 运行中标记放到 finally 里清，保证异常路径也不残留（见上面 try 的注释）。
   */
  } finally {
    task.runningAt = null;
    flushState();
  }
  return { ok, message, duration };
}

/* ---------------------------------------------------------------- 调度循环 */

let ticking = false;

/* ---------------------------------------------------------- 错过补跑（可控） */

/*
 * 与 tick 的分工：
 *   tick      负责「进程还活着时的迟到」—— 通常几秒到几分钟；
 *   这里负责「进程整段不在的缺口」—— 重启、休眠唤醒、崩溃自愈之后。
 *
 * 站点存在的意义就是把任务跑成，所以默认要补（catchup.enabled 默认 true）。
 * 但补跑必须有约束，否则会同时踩两个坑：
 *   ① 重复执行 —— 签到/下单类任务多跑一次就是副作用多发生一次；
 *   ② 服务方风控 —— 8 个任务在启动后同一秒一起打向同一个上游，形同攻击特征。
 *
 * 因此判据是「补得到 + 不重复 + 不扎堆」：
 *   1) 错过 5 次也只补 1 次，不补齐 N 次（补跑不是追债）；
 *   2) lastRun ≥ 错过时刻 → 那一次其实已经跑过，绝不补；
 *   3) 距上次执行不足最小间隔 → 不补（防「补跑 + 准点」连打）；
 *   4) 超出补跑窗口 → 不补，只推进 nextRun 并留痕；
 *   5) 执行前先推进 nextRun 并落盘（认领），补跑中途被回收也不会再来一次；
 *   6) 串行执行 + 随机抖动，同一时刻只有一条请求出去。
 */

// 等首轮预热/启动流程走完再动手；测试与排障可用 CRONHUB_CATCHUP_DELAY_MS 压到 0
const CATCHUP_DELAY_RAW = String(process.env.CRONHUB_CATCHUP_DELAY_MS || '').trim();
const CATCHUP_START_DELAY_MS = CATCHUP_DELAY_RAW && Number.isFinite(Number(CATCHUP_DELAY_RAW))
  ? Math.max(0, Number(CATCHUP_DELAY_RAW))
  : 12 * 1000;
const CATCHUP_TOTAL_MS = 5 * 60 * 1000;     // 补跑总时长上限：再久就放弃剩余，交给正常调度

const catchupQueue = [];
const catchupRuntime = {
  at: null,          // 最近一次规划时间
  planned: 0,        // 本次启动计划补跑的数量
  done: 0,
  failed: 0,
  skipped: 0,
  reasons: [],       // [{ id, name, reason, label, lateMin }]
  running: false,
  stopped: false,
  lastEndAt: null,
  windowMinutes: 120,
};

function catchupPolicy() {
  const c = (state.settings && state.settings.catchup) || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: c.enabled !== false,
    windowMs: Math.round(num(c.windowMinutes, 120, 5, 1440)) * 60000,
    maxPerStart: Math.round(num(c.maxPerStart, 5, 0, 50)),
    minGapMs: Math.round(num(c.minGapSec, 45, 0, 3600)) * 1000,
    jitterMaxMs: Math.round(num(c.jitterMaxMs, 20000, 0, 300000)),
  };
}

function lastRunAtOf(task) {
  const at = task && task.lastRun ? Date.parse(task.lastRun) : 0;
  return Number.isFinite(at) ? at : 0;
}

/**
 * 同任务最小间隔：取最短周期的 55%，再夹到策略上限。
 * 1 分钟任务 → 33 秒，正常执行永远不会被误拦；
 * 6 小时任务 → 45 秒（策略上限），足够让「补跑 + 准点」不在同一分钟内连打。
 */
function minGapFor(task, policy) {
  const p = policy || catchupPolicy();
  let period = Infinity;
  for (const s of taskSchedules(task || {})) {
    const ms = s.mode === 'interval'
      ? Math.max(1, Number(s.everyMinutes) || 60) * 60000
      : 60000; // cron 的最小粒度是 1 分钟
    if (ms < period) period = ms;
  }
  if (!Number.isFinite(period)) return p.minGapMs;
  return Math.min(p.minGapMs, Math.round(period * 0.55));
}

/**
 * 启动补跑规划：算出「确实错过、且值得补」的任务，认领 nextRun，入队。
 * 必须同步执行完（在 listen 之前），否则第一轮 tick 会先看到这些任务到期。
 */
function planCatchupOnBoot() {
  const policy = catchupPolicy();
  const now = Date.now();
  catchupRuntime.at = nowISO();
  catchupRuntime.windowMinutes = Math.round(policy.windowMs / 60000);
  catchupRuntime.planned = 0;
  catchupRuntime.done = 0;
  catchupRuntime.failed = 0;
  catchupRuntime.skipped = 0;
  catchupRuntime.reasons = [];

  const missed = [];
  for (const t of state.tasks || []) {
    if (!t || !t.enabled || !t.nextRun) continue;
    const at = Date.parse(t.nextRun);
    if (!Number.isFinite(at) || at > now) continue;
    missed.push({ task: t, at });
  }
  if (!missed.length) return { planned: 0, missed: 0 };

  missed.sort((a, b) => a.at - b.at); // 错过最久的优先补

  const picked = [];
  for (const item of missed) {
    const t = item.task;
    const late = now - item.at;
    const last = lastRunAtOf(t);
    const gap = minGapFor(t, policy);
    const skip = (reason, label) => {
      catchupRuntime.skipped += 1;
      catchupRuntime.reasons.push({ id: t.id, name: t.name, reason, label, lateMin: Math.round(late / 60000) });
    };
    if (!policy.enabled) skip('off', '自动补跑已关闭');
    else if ((t.config || {}).noCatchup === true) skip('task-off', '该任务单独关闭了补跑');
    else if (late > policy.windowMs) skip('window', `错过 ${Math.round(late / 60000)} 分钟，超出 ${Math.round(policy.windowMs / 60000)} 分钟窗口`);
    else if (last && last >= item.at) skip('already', '该时刻之后已成功执行过，不重复');
    else if (last && now - last < gap) skip('gap', `距上次执行不足 ${Math.round(gap / 1000)} 秒，避免连打上游`);
    else if (picked.length >= policy.maxPerStart) skip('limit', `超出单次上限 ${policy.maxPerStart} 个`);
    else picked.push(item);
  }

  /*
   * 无论补不补，nextRun 都必须推进到未来。
   * 停在过去会让第一轮 tick 把它们当「刚到期的任务」直接跑掉，
   * 那前面所有克制都白做了（这正是改造前的行为）。
   */
  for (const item of missed) {
    const nx = computeNextRun(item.task, new Date(Math.max(now, item.at)));
    item.task.nextRun = nx ? nx.toISOString() : null;
  }

  for (const item of picked) {
    catchupQueue.push({ task: item.task, at: item.at, plannedAt: new Date(item.at).toISOString() });
  }
  catchupRuntime.planned = picked.length;
  flushState();

  const skipSummary = {};
  for (const r of catchupRuntime.reasons) skipSummary[r.label] = (skipSummary[r.label] || 0) + 1;
  const msg = `服务重启扫描：${missed.length} 个错过，补跑 ${picked.length} 个`
    + (catchupRuntime.skipped ? `，跳过 ${catchupRuntime.skipped} 个（${Object.keys(skipSummary).join('；')}）` : '');
  pushSysLog({
    level: 'warn',
    source: 'scheduler',
    msg,
    detail: {
      missed: missed.length,
      windowMinutes: catchupRuntime.windowMinutes,
      planned: picked.map((x) => ({ id: x.task.id, name: x.task.name, plannedAt: new Date(x.at).toISOString() })),
      skipped: catchupRuntime.reasons.slice(0, 20),
    },
  });

  if (missed.length) {
    const lines = [];
    if (picked.length) {
      lines.push(`将补跑 ${picked.length} 个（错峰、串行，最多 ${Math.round(policy.jitterMaxMs / 1000)} 秒抖动）：`);
      lines.push(picked.map((x) => '· ' + x.task.name).join('\n'));
    }
    for (const [label, n] of Object.entries(skipSummary)) lines.push(`跳过 ${n} 个：${label}`);
    pushNotification({
      level: picked.length ? 'warn' : 'info',
      title: picked.length ? `服务中断后补跑 ${picked.length} 个任务` : '错过的执行已跳过（不重复跑）',
      body: lines.join('\n'),
      source: 'scheduler',
    });
  }
  return { planned: picked.length, missed: missed.length };
}

/**
 * 串行执行补跑队列。
 * 同一时刻只跑一个任务；每个任务前随机等一会儿。补跑期间 tick 会主动让路，
 * 保证不会有第二条请求同时打向同一个上游。
 */
async function drainCatchupQueue() {
  if (catchupRuntime.running) return 0;
  if (!catchupQueue.length) return 0;
  catchupRuntime.running = true;
  const policy = catchupPolicy();
  const deadline = Date.now() + CATCHUP_TOTAL_MS;
  let ran = 0;
  try {
    while (catchupQueue.length && !catchupRuntime.stopped) {
      if (Date.now() > deadline) {
        const rest = catchupQueue.splice(0).map((x) => x.task.name);
        pushSysLog({
          level: 'warn',
          source: 'scheduler',
          msg: `补跑超过 ${Math.round(CATCHUP_TOTAL_MS / 60000)} 分钟上限，放弃剩余 ${rest.length} 个：${rest.join('、')}`,
          detail: { rest },
        });
        break;
      }
      const item = catchupQueue.shift();
      const t = item.task;
      if (!t || !t.enabled) { catchupRuntime.skipped += 1; continue; }

      // 排队期间可能已被「立即执行」跑过：宁可少跑一次，也不能多跑
      const last = lastRunAtOf(t);
      if (last && last >= item.at) {
        catchupRuntime.skipped += 1;
        catchupRuntime.reasons.push({ id: t.id, name: t.name, reason: 'queued-done', label: '排队期间已执行过', lateMin: 0 });
        continue;
      }

      // 错峰：随机等待，避免多个任务在同一秒打向同一个上游
      if (policy.jitterMaxMs > 0) {
        const wait = Math.round(600 + Math.random() * Math.max(0, policy.jitterMaxMs - 600));
        await sleepMs(wait);
        const again = lastRunAtOf(t);
        if (again && again >= item.at) { catchupRuntime.skipped += 1; continue; }
        if (catchupRuntime.stopped) break;
      }

      pushSysLog({
        level: 'info',
        source: 'scheduler',
        msg: `补跑「${t.name}」：原定 ${new Date(item.at).toLocaleString('zh-CN')}，已迟到 ${Math.round((Date.now() - item.at) / 60000)} 分钟`,
        detail: { taskId: t.id, taskName: t.name, plannedAt: item.plannedAt },
      });
      try {
        await runTaskGuarded(t, 'catchup');
        ran += 1;
        catchupRuntime.done += 1;
      } catch (e) {
        catchupRuntime.failed += 1;
        pushSysLog({
          level: 'error',
          source: 'scheduler',
          msg: `补跑「${t.name}」失败：${String((e && e.message) || e).slice(0, 160)}`,
          detail: { taskId: t.id, taskName: t.name },
        });
      }

      /*
       * 补跑刚结束，如果下一次计划紧贴着来（< 最小间隔），往后顺延一次。
       * 只错开这一次，不改长期节奏：nextRun 之后仍按 cron/锚点正常走。
       */
      const gap = minGapFor(t, policy);
      const nextAt = t.nextRun ? Date.parse(t.nextRun) : 0;
      if (gap > 0 && nextAt && nextAt - Date.now() < gap) {
        const shifted = computeNextRun(t, new Date(Date.now() + gap));
        if (shifted) {
          t.nextRun = shifted.toISOString();
          pushSysLog({
            level: 'info',
            source: 'scheduler',
            msg: `「${t.name}」补跑后顺延下一次到 ${new Date(t.nextRun).toLocaleString('zh-CN')}（避免对上游连打）`,
            detail: { taskId: t.id, minGapSec: Math.round(gap / 1000) },
          });
        }
      }
      saveState();
    }
  } finally {
    catchupRuntime.running = false;
    catchupRuntime.lastEndAt = nowISO();
    if (ran) {
      pushSysLog({
        level: 'info',
        source: 'scheduler',
        msg: `补跑收尾：完成 ${catchupRuntime.done} 个，失败 ${catchupRuntime.failed} 个，跳过 ${catchupRuntime.skipped} 个`,
        detail: { done: catchupRuntime.done, failed: catchupRuntime.failed, skipped: catchupRuntime.skipped },
      });
    }
  }
  return ran;
}

function catchupSnapshot() {
  return {
    enabled: catchupPolicy().enabled,
    windowMinutes: catchupRuntime.windowMinutes,
    planned: catchupRuntime.planned,
    done: catchupRuntime.done,
    failed: catchupRuntime.failed,
    skipped: catchupRuntime.skipped,
    queued: catchupQueue.length,
    running: catchupRuntime.running,
    at: catchupRuntime.at,
    lastEndAt: catchupRuntime.lastEndAt,
    reasons: catchupRuntime.reasons.slice(0, 8),
  };
}

/*
 * ------------------------------------------------------------ 调度自我守护
 * ticking 是「同一时刻只有一个调度批在跑」的锁，但原实现只有一个 finally 释放它：
 * 只要有一个任务永久卡住（子进程不返回、上游半开连接、库函数死循环），
 * 锁就再也不会释放 —— 界面上只表现为「任务不跑了」，没有任何提示。
 * 2026-11 就真的踩过一次（readBody 在响应体异常结束时 Promise 永不 settle）。
 *
 * 所以加两个兜底：看门狗强制解锁 + 单任务总时长上限。
 */
const TICK_STUCK_MS = 5 * 60 * 1000;
/** 单任务总时长上限：3 步 × 15s 超时 × 3 次重试已经 135s，留一点余量。 */
const TASK_DEADLINE_MS = 150 * 1000;
let tickStartedAt = 0;
let tickStuckCount = 0;
let tickStuckAlertAt = 0;

/**
 * 调度看门狗：每 30 秒检查一次锁持有时间。
 * 超过 5 分钟就强制释放并告警 —— 强行解锁可能让两个批次短暂并行，
 * 但相比「调度永久停摆」，这是明显更小的代价。
 */
function tickWatchdog() {
  if (!ticking || !tickStartedAt) return;
  const held = Date.now() - tickStartedAt;
  if (held < TICK_STUCK_MS) return;
  ticking = false;
  tickStartedAt = 0;
  tickStuckCount += 1;
  const msg = `调度锁被占住 ${Math.round(held / 1000)} 秒，已强制释放（第 ${tickStuckCount} 次）`;
  console.error('[scheduler] ' + msg);
  pushSysLog({ level: 'error', source: 'scheduler', msg, detail: { heldMs: held, count: tickStuckCount } });
  const now = Date.now();
  if (now - tickStuckAlertAt > 3600 * 1000) {
    tickStuckAlertAt = now;
    try {
      sendNotifyMe(state.settings.notifyme, {
        title: 'CronHub 调度卡住已自愈',
        body: msg + '\n定时任务可能出现延迟，请打开「运行日志」确认有没有任务卡死。',
        level: 'error',
      }).catch(() => {});
    } catch { /* 推送失败不影响恢复 */ }
  }
}

/**
 * 带总时长上限的执行入口。
 * 注意：超时只是「让调度继续走」，任务本身不会被取消（Promise.race 没有取消语义），
 * 它稍后仍可能写回结果 —— 这比让整轮调度停摆要好，但不等于任务被中止。
 */
async function runTaskGuarded(task, trigger) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('任务总时长超过 ' + Math.round(TASK_DEADLINE_MS / 1000) + ' 秒，已放行调度')), TASK_DEADLINE_MS);
    if (timer && timer.unref) timer.unref();
  });
  try {
    return await Promise.race([runTask(task, trigger), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * 执行前连接预热。
 *
 * 连接池只对「间隔小于 60 秒」的请求有用，而定时任务通常隔几小时甚至几天才跑一次，
 * 空闲连接早被回收，于是每次执行都从 DNS + TCP + TLS 重新来一遍。实测一个境外接口：
 * 完整握手 981~1788ms，复用连接 175ms —— 也就是说用户看到的「慢」，绝大部分不是接口慢。
 *
 * 做法：任务到点前十几秒先握一次手（OPTIONS，不带 query），真正执行时直接命中连接池。
 * 必须用 OPTIONS：Node 的 https.Agent 对 HEAD 响应不把连接放回池，预热等于白做。
 * 代价是每个任务多一次 OPTIONS 请求（幂等、不取正文），并且要能接受「预热失败什么也不发生」。
 * 关掉：CRONHUB_PREWARM=0
 */
const PREWARM_WINDOW_MS = 18 * 1000;
const prewarmedAt = new Map();

function maybePrewarm(now) {
  if (process.env.CRONHUB_PREWARM === '0') return;
  for (const t of state.tasks) {
    if (!t.enabled || t.type !== 'http' || !t.nextRun) continue;
    const left = new Date(t.nextRun).getTime() - now;
    // 只处理「下一次扫描就要执行」的那批：太远没必要，已过期交给正常执行
    if (left <= 0 || left > PREWARM_WINDOW_MS) continue;
    if (now - (prewarmedAt.get(t.id) || 0) < 10000) continue;

    const first = stepsOf(t)[0] || {};
    const rawUrl = first.url || (t.config && t.config.url);
    if (!rawUrl) continue;
    let target;
    try {
      target = applyEnvVars(rawUrl);
      const pu = new URL(target);
      // 开了私网防护时，预热本身也不能绕过它去握手
      if (privateUrlGuardOn() && isPrivateHost(pu.hostname)) continue;
    } catch {
      continue;
    }
    prewarmedAt.set(t.id, now);
    httpClient.prewarm(target, { timeoutMs: 8000 }).catch(() => {});
  }
  if (prewarmedAt.size > 300) {
    const cut = now - 10 * 60 * 1000;
    for (const [id, at] of prewarmedAt) if (at < cut) prewarmedAt.delete(id);
  }
}

async function tick() {
  if (ticking) return 0;
  /*
   * 补跑队列在跑时主动让路。
   * 补跑本身就是「串行 + 抖动」，如果这时 tick 又并发跑别的任务，
   * 同一个上游会同时收到两条请求 —— 正是服务方风控最敏感的特征。
   * 让路的代价是正常任务最多延后几分钟，只发生在服务刚重启的异常期。
   */
  if (catchupRuntime.running) return 0;
  ticking = true;
  tickStartedAt = Date.now();
  let ranCount = 0;
  try {
    const now = Date.now();
    maybePrewarm(now);
    const skipMissed = (state.settings && state.settings.missedPolicy) === 'skip';
    const GRACE = 15 * 60 * 1000;
    // 手动执行在途时不能再被定时触发：两个 runTask 并发写同一 task 的结果与通知。
    // runningAt 由 .run 路由同步占位、runTask 的 finally 清理，启动扫描会收掉残留值。
    const due = state.tasks.filter((t) => t.enabled && t.nextRun && !t.runningAt
      && new Date(t.nextRun).getTime() <= now);
    if (due.length) {
      pushSysLog({
        level: 'info',
        source: 'tick',
        msg: `调度扫描：${due.length} 个任务到期（${due.map((t) => t.name).join('、').slice(0, 200)}）`,
        detail: { tasks: due.map((t) => ({ id: t.id, name: t.name, nextRun: t.nextRun })) },
      });
    }
    /*
     * 第一步：统一「认领」—— 先把所有到期任务的 nextRun 推到下一次，再一次性落盘。
     *
     * 原实现是「推进 nextRun → await 执行」，但推进只在内存里，没落盘：
     * 进程在执行期间被回收，重启后 state.json 里还是旧 nextRun，同一个时刻会再跑一遍。
     * 先落盘认领，语义就变成「至多执行一次」——宁可少跑一次并在日志里留痕（中断标记），
     * 也不要重复产生副作用。立即写入只在这一批任务到期时发生，平时不增加写盘。
     */
    const claimed = [];
    for (const task of due) {
      const plannedAt = new Date(task.nextRun).getTime();
      task.nextRun = computeNextRun(task, new Date(Math.max(now, plannedAt)))?.toISOString() || null;
      claimed.push({ task, plannedAt });
    }
    if (claimed.length) flushState();

    for (const { task, plannedAt } of claimed) {
      const late = now - plannedAt;
      // 「跳过」策略：cron 任务迟到超过 15 分钟就不再补跑，只发一条站内说明
      // （interval 任务不适用 —— 它没有「准点」概念，照常执行）
      // 多节奏任务：所有节奏都是 cron 时才按「跳过」处理
      if (skipMissed && late > GRACE && taskSchedules(task).every((s) => s.mode === 'cron')) {
        pushNotification({
          level: 'warn',
          title: '已跳过：' + task.name,
          body: `计划 ${new Date(plannedAt).toLocaleString('zh-CN')} 的执行因服务休眠错过（迟到约 ${Math.round(late / 60000)} 分钟），按「跳过」策略不补跑。下次：${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未排期'}`,
          source: 'scheduler',
        });
        // 跳过也要留痕：以前这一支只发通知不写日志，事后查「为什么这次没跑」查不到
        pushSysLog({
          level: 'warn',
          source: 'scheduler',
          msg: `跳过「${task.name}」：迟 ${Math.round(late / 60000)} 分钟，超过 ${Math.round(GRACE / 60000)} 分钟宽限（missedPolicy=skip）`,
          detail: { taskId: task.id, taskName: task.name, plannedAt: new Date(plannedAt).toISOString(), lateMs: late, policy: 'skip' },
        });
        saveState();
        continue;
      }
      /*
       * 补跑窗口上限：即使错过了 run 策略，迟到太久也不再执行。
       * 进程卡了几小时后突然恢复，把每一次积压都补出去，对上游就是一整波集中请求；
       * 「晚点跑总比不跑强」的前提是晚得不多，超过窗口就该交给下一次排期。
       */
      const cuPolicy = catchupPolicy();
      if (late > cuPolicy.windowMs) {
        pushNotification({
          level: 'info',
          title: '已放弃补跑：' + task.name,
          body: `原定 ${new Date(plannedAt).toLocaleString('zh-CN')} 的执行已迟到 ${Math.round(late / 60000)} 分钟，超出 ${Math.round(cuPolicy.windowMs / 60000)} 分钟补跑窗口，本次不执行。下次：${task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '未排期'}`,
          source: 'scheduler',
        });
        pushSysLog({
          level: 'warn',
          source: 'scheduler',
          msg: `放弃补跑「${task.name}」：迟 ${Math.round(late / 60000)} 分钟 > 窗口 ${Math.round(cuPolicy.windowMs / 60000)} 分钟`,
          detail: { taskId: task.id, taskName: task.name, plannedAt: new Date(plannedAt).toISOString(), lateMs: late, windowMs: cuPolicy.windowMs },
        });
        saveState();
        continue;
      }
      /*
       * 最小间隔守卫：同一任务距上次执行太近，这一次就不再打出去。
       * 典型是「启动补跑刚跑完，准点执行紧接着到点」——对签到类上游等于连打两下。
       */
      const cuGap = minGapFor(task, cuPolicy);
      const cuLast = lastRunAtOf(task);
      if (cuGap > 0 && cuLast && now - cuLast < cuGap) {
        pushSysLog({
          level: 'info',
          source: 'scheduler',
          msg: `跳过「${task.name}」本次：距上次执行仅 ${Math.round((now - cuLast) / 1000)} 秒，低于 ${Math.round(cuGap / 1000)} 秒下限`,
          detail: { taskId: task.id, taskName: task.name, sinceLastMs: now - cuLast, minGapMs: cuGap },
        });
        saveState();
        continue;
      }
      /*
       * 每个任务单独兜异常：以前整批共用一个 try/catch，任一 runTask 在通知段抛错
       * 就跳出 for 循环；而 nextRun 已在认领阶段推进并落盘，本轮不再执行、
       * 下轮 due 筛选也不会补 —— 剩余任务被静默丢掉，只有一行 console.error。
       */
      try {
        // 带总时长上限：任一任务卡死也不会把整轮调度一起拖住（第 17 批）
        await runTaskGuarded(task, late > 3 * 60 * 1000 ? 'catchup' : 'schedule');
        ranCount += 1;
      } catch (err) {
        pushSysLog({
          level: 'error', source: 'scheduler',
          msg: '「' + task.name + '」执行异常（同批其他任务继续）',
          detail: { taskId: task.id, taskName: task.name, error: String((err && err.message) || err).slice(0, 300) },
        });
      }
    }
  } catch (err) {
    console.error('[scheduler] 异常:', err.message);
  } finally {
    ticking = false;
    tickStartedAt = 0;
  }
  return ranCount;
}

/* ---------------------------------------------------------------- 日期工具 */

function dayKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ---------------------------------------------------------------- 鉴权 */

/*
 * 首次访问时设置密码（服务端只存 scrypt 哈希）。
 * 登录后发放 HMAC 签名的 token，放在 HttpOnly Cookie 里；
 * 签名密钥持久化在 state.json 中，因此服务重启后登录态不会失效。
 */

const SESSION_COOKIE = 'cronhub_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/*
 * 访问密码策略：
 *
 * 默认「进入即可见」—— 不设置任何环境变量时，访问控制是关闭的，
 * 打开链接直接进控制台，不需要密码。这是当前产品形态。
 *
 * 需要重新上锁时设置 REQUIRE_PASSWORD=1 启动，此时：
 *  - 主密码被强制锁定为 FORCED_PASSWORD（默认 7777），启动时校验并
 *    用固定值重写哈希 —— 这个密码谁都改不掉，除非改环境变量。
 *  - ADMIN_PASSWORDS 是一组隐藏的管理密码，在同一个登录框里输入即可，
 *    登录后 role = admin，页面才会出现「管理」面板。
 *
 * 无论开不开访问控制，管理面板都只能由 admin 身份看到。
 * 关闭访问控制时，可用 URL 加 ?admin 调出提权输入框。
 */
const REQUIRE_PASSWORD = /^(1|true|yes)$/i.test(String(process.env.REQUIRE_PASSWORD || ''));
const FORCED_PASSWORD = String(process.env.FORCE_PASSWORD || '7777');
const ADMIN_PASSWORDS = String(process.env.ADMIN_PASSWORDS || 'chneaki,chen')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_LOG_MAX = 200;

/** 定长比较，避免用密码长度/前缀泄漏信息。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

/** 判定是不是管理密码。 */
function adminPasswordMatch(password) {
  let hit = false;
  for (const p of ADMIN_PASSWORDS) {
    if (safeEqual(password, p)) hit = true;
  }
  return hit;
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, auth) {
  if (!auth || !auth.salt || !auth.hash) return false;
  try {
    const { hash } = hashPassword(password, auth.salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(auth.hash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function signToken(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(secret, role) {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), role: role === 'admin' ? 'admin' : 'user' }))
    .toString('base64url');
  return payload + '.' + signToken(payload, secret);
}

/** 校验 token，合法时返回 payload（含 role），否则返回 null。 */
function readToken(token, secret) {
  if (!token || !secret) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = signToken(payload, secret);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() - Number(data.iat) >= SESSION_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function tokenValid(token, secret) {
  return readToken(token, secret) !== null;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  // 反向代理下，真实协议在 x-forwarded-proto 里
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return !!req.socket.encrypted;
}

function sessionCookie(req, value, maxAgeSec) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) bits.push('Secure');
  return bits.join('; ');
}

function isAuthed(req) {
  return sessionOf(req) !== null;
}

/**
 * 读取当前会话。
 *  - 访问控制开启（REQUIRE_PASSWORD=1）：未登录返回 null，否则返回 { role }
 *  - 访问控制关闭（默认）：任何人都是「已进入」的访客身份，除非带了 admin token
 */
function sessionOf(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const data = state.auth ? readToken(token, state.auth.secret) : null;
  if (data) return { role: data.role === 'admin' ? 'admin' : 'user', iat: Number(data.iat) };
  if (!REQUIRE_PASSWORD) return { role: 'guest', iat: Date.now(), open: true };
  return null;
}

function isAdmin(req) {
  const s = sessionOf(req);
  return !!s && s.role === 'admin';
}

// 暴力破解防护：同一 IP 连续失败 10 次，锁定 15 分钟（成功登录后清零）
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function loginLockRemain(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first > LOGIN_LOCK_MS) {
    loginFailures.delete(ip);
    return 0;
  }
  return rec.count >= LOGIN_MAX_FAILURES
    ? Math.ceil((LOGIN_LOCK_MS - (Date.now() - rec.first)) / 60000)
    : 0;
}

function noteLoginFailure(ip) {
  const rec = loginFailures.get(ip) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > LOGIN_LOCK_MS) {
    rec.count = 0;
    rec.first = Date.now();
  }
  rec.count++;
  loginFailures.set(ip, rec);
}

/** 记录一次登录尝试（不存密码，只在 admin 面板可见）。 */
function pushAuthLog(req, info) {
  if (!Array.isArray(state.authLog)) state.authLog = [];
  state.authLog.push({
    at: nowISO(),
    ok: !!info.ok,
    role: info.role || null,
    ip: info.ip || clientIP(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  });
  if (state.authLog.length > AUTH_LOG_MAX) {
    state.authLog = state.authLog.slice(-AUTH_LOG_MAX);
  }
  pushSysLog({
    level: info.ok ? 'info' : 'warn',
    source: 'auth',
    msg: `登录${info.ok ? '成功' : '失败'}${info.role ? '（' + info.role + '）' : ''} 来自 ${info.ip || clientIP(req)}`,
    detail: {
      ok: !!info.ok,
      role: info.role || null,
      ip: info.ip || clientIP(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 120),
    },
  });
  saveState();
}

function clientIP(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/* ---------------------------------------------------------------- HTTP 服务 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  // 客户端支持 gzip 且体积可观时压缩 —— 网关不做，只能源头做
  const accepts = res.req && String(res.req.headers['accept-encoding'] || '').includes('gzip');
  if (accepts && body.length > 1024) {
    zlib.gzip(body, (e, gz) => {
      if (e) { base['Content-Length'] = body.length; res.writeHead(code, base); res.end(body); return; }
      res.writeHead(code, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    });
    return;
  }
  base['Content-Length'] = body.length;
  res.writeHead(code, base);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function publicState(role) {
  const asAdmin = role === 'admin';
  // 只读：唤醒令牌在启动阶段由 ensureWakeToken() 一次性备好。
  // 以前这里每次都调它，首次访问会写 state 并触发落盘 —— 只读接口不该有写副作用。
  const wakeToken = String((state.settings.wake && state.settings.wake.token) || '');
  const nowD = new Date();
  return {
    // 节奏列表连同「接下来 3 次」一起算好给前端，省得前端再实现一套 cron
    tasks: state.tasks.map((t) => {
      const schedules = taskSchedules(t);
      return {
        ...t,
        schedules,
        previews: schedules.map((sd) => ({ next: nextRunsOf(sd, nowD, 3) })),
      };
    }),
    notifications: state.notifications,
    logs: state.logs,
    // 统一脱敏出口：凭据类字段一律打码，要明文走 /api/settings/reveal
    settings: maskSettings(state.settings, { admin: asAdmin }),
    // 中继健康快照：中继是唯一短信出口，前端据此在设置页直接暴露「活着 / 挂了」
    relayHealth: { ...relayHealth },
    // 双向陪护快照（第十批）：控制中心读 /api/state，这一份让页面也能看到
    // 「上游网关 / 本站回探 / CF 唤醒 / 最近体检」四个状态，口径与 /api/health 完全一致。
    companion: companionSnapshot(),
    /*
     * 落盘健康（第十六批）：带上它前端才能在「最近一次启动发生过损坏回退」时
     * 在顶部挂一条警示 —— 数据被动过这么大的事，不该只留在系统日志里。
     */
    storage: stateStorageSnapshot(),
    // 补跑状态（第十六批）：页面据此显示「本次启动补跑了几 个、跳过了哪些、为什么跳过」
    catchup: catchupSnapshot(),
    /*
     * 运行指标（第十八批）：24 小时小时柱 + 1h/24h 汇总。
     * 与「累计失败次数」不同，它带时间轴 —— 能分辨「零星抖动」和「从某点起全挂」。
     */
    metrics: metricsSnapshot(),
    // 死信水位：条数与已告警档位，前端据此决定是否把死信入口标红
    deadLetter: { count: (state.deadLetters || []).length, alertLevel: Number(state.deadLetterAlert) || 0 },
    meta: {
      now: nowISO(),
      timezone: process.env.TZ || state.settings.timezone || 'Asia/Shanghai',
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      // 连续运行统计（跨重启累计）：前端「服务器信息」直接渲染
      runtime: runtimeSummary(),
      // 保活三重保险的实时状态
      keepAlive: {
        // 保险一：内置自探活
        self: {
          enabled: !!(state.settings.keepWarm && state.settings.keepWarm.enabled),
          url: keepWarm.url || normalizeKeepWarmUrl((state.settings.keepWarm || {}).url),
          urlValid: !!keepWarm.url,
          everyMin: keepWarm.everyMin,
          lastAt: keepWarm.lastAt,
          lastOk: keepWarm.lastOk,
          lastMsg: keepWarm.lastMsg,
          failStreak: keepWarm.failStreak,
          hits: keepWarm.hits,
          nextAt: keepWarm.nextAt,
        },
        // 保险二：外部唤醒端点
        wake: {
          // 唤醒令牌是要复制给 cron-job.org / UptimeRobot 用的，只有管理员会话下发明文；
          // 访客拿到它也能刷唤醒计数，属于「非必要不下发」的信息
          token: asAdmin ? wakeToken : (wakeToken ? '••••••' : ''),
          lastAt: (state.settings.wake && state.settings.wake.lastWokeAt) || '',
          count: Number((state.settings.wake && state.settings.wake.count) || 0),
        },
      },
      port: PORT,
      authEnabled: REQUIRE_PASSWORD,
      passwordLocked: REQUIRE_PASSWORD,
      role: role === 'admin' ? 'admin' : 'user',
      // 凭据是否被掩码：默认 false（明文摊开），设 CRONHUB_CRED_MASK=1 才为 true。
      // 前端据此决定要不要显示「👁 换明文」按钮、要不要把密码框改成可见。
      credMasked: CRED_MASK && role !== 'admin',
      storageWritable,
      storagePath: STATE_FILE,
      // 推送死信条数：前端只在「通知」页显示一行入口，内容要口令才看得到
      deadLetterCount: (state.deadLetters || []).length,
    },
  };
}

/** 校验并规范化单条 HTTP 请求配置（也是 steps 里每一步的形状）。 */
function sanitizeHttpStep(raw) {
  const c = raw || {};
  const step = {
    url: String(c.url || '').trim(),
    method: String(c.method || 'GET').toUpperCase(),
    headers: typeof c.headers === 'string' ? c.headers : (c.headers ? JSON.stringify(c.headers) : ''),
    body: String(c.body == null ? '' : c.body),
    expectStatus: Number(c.expectStatus) || 200,
    // 额外视为成功的状态码，例如签到接口在「今天已签」时返回 400
    alsoOkStatus: parseStatusList(c.alsoOkStatus),
    timeoutSec: Math.max(3, Number(c.timeoutSec) || 15),
  };
  if (c.name) step.name = String(c.name).slice(0, 40);
  if (c.optional === true) step.optional = true;
  return step;
}

/**
 * 任务级 NotifyMe 高级选项清洗。
 * 只认五个字段，空对象返回 null —— null 表示「完全跟随设置页」，不落库。
 * 为什么不用默认值补齐：补齐了就没法表达「这一项跟随全局」，用户在任务里
 * 清空一个下拉想回到全局值，会被默认值钉死。
 */
function sanitizeNmPush(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.actionType !== undefined) out.actionType = nmActionType(raw.actionType);
  if (raw.action !== undefined) out.action = String(raw.action || '').slice(0, 500);
  if (raw.bigText !== undefined) out.bigText = raw.bigText !== false;
  if (raw.group !== undefined) out.group = String(raw.group || '').slice(0, 32);
  if (raw.urgent !== undefined) out.urgent = raw.urgent === true;
  return Object.keys(out).length ? out : null;
}

/**
 * HTTP 任务配置：既支持老的「单请求」写法，也支持新的「多步骤」写法。
 * 多步骤时 config.steps 按顺序串行执行，取第一个非空 url 作为展示用的主地址。
 */function sanitizeHttpConfig(raw) {
  const c = raw || {};
  const base = sanitizeHttpStep(c);
  // 任务级字段提取声明（buildRunNotice 用来把响应变成可读通知）：路径必填，label 可选
  if (Array.isArray(c.extract)) {
    const ex = c.extract
      .filter((f) => f && String(f.path || '').trim())
      .slice(0, 20)
      .map((f) => ({ path: String(f.path).trim(), label: String(f.label || '').trim().slice(0, 24) }));
    if (ex.length) base.extract = ex;
  }
  // 通知优化：任务级模版与 AI 提示词（可选）
  const ntpl = String(c.notifyTemplate || '').trim();
  if (ntpl) base.notifyTemplate = ntpl.slice(0, 500);
  const nprompt = String(c.notifyPrompt || '').trim();
  // 300 字装不下「事实规则 + 排版规则 + 风格约束」的完整提示词，保存时被硬截成
  // 半句话（线上曾停在「…把最」）；1000→1500 仍然不够，天气任务写到 1413 就把
  // 余量吃光了。上限放到 4000，超限时前端会标红提示，不再静默丢尾巴。
  if (nprompt) base.notifyPrompt = nprompt.slice(0, AI_NOTIFY_PROMPT_MAX);
  /*
   * 任务级「是否使用 AI 优化」开关：只在显式关闭时落 false。
   * 缺省（老任务 / 新建任务）按开启处理，所以线上已有任务的行为完全不变，
   * state 里也不会凭空多出一批 true 字段。运行层 taskAiOn 用 !== false 判定。
   */
  if (c.aiEnabled === false) base.aiEnabled = false;
  /*
   * 任务级「不参与自动补跑」：只在显式关闭时落 true，老任务不受影响。
   * 用于「一次都不能重复」的任务（下单、抽奖类）：宁可错过，也不重跑。
   */
  if (c.noCatchup === true) base.noCatchup = true;
  // 指定用哪个 AI 实例做优化（不填 = 用默认那套）
  const aiInst = String(c.aiInstance || '').trim();
  if (aiInst && CI_ID_RE.test(aiInst)) base.aiInstance = aiInst;
  /*
   * 任务级 NotifyMe 高级选项（可选）。
   * 不填任何一项就不落库 —— 老任务的 state 不会凭空多出一个空对象，
   * 发送层 nmForTask() 看不到 nmPush 时自动跟随设置页的全局值。
   */
  const nmp = sanitizeNmPush(c.nmPush);
  if (nmp) base.nmPush = nmp;
  /*
   * 失败重试（默认关闭）：只有用户显式开了才落库，老任务读取时看不到这个字段，
   * 行为与以前完全一致。上限在发送层再 clamp 一次，防止手改 state 写出离谱值。
   */
  const retryRaw = c.retry || {};
  const retryTimes = Math.max(0, Math.min(RETRY_MAX_TIMES, Number(retryRaw.times) || 0));
  if (retryTimes > 0) {
    base.retry = {
      times: retryTimes,
      delayMs: Math.max(500, Math.min(30000, Number(retryRaw.delayMs) || 3000)),
    };
  }
  /*
   * 步骤的 url 允许留空继承任务级 —— 运行期 stepsOf 的 INHERIT_IF_EMPTY 就是这么约定的。
   * 以前这里只用 s.url 过滤，「只覆盖 headers/body、url 继承」的步骤在保存阶段就被丢掉，
   * 用户填了却永远不生效，且不会报错。任务级也没 url 时，才要求步骤必须自带地址。
   */
  const hasBaseUrl = !!String(base.url || '').trim();
  const stepsRaw = Array.isArray(c.steps)
    ? c.steps.filter((s) => s && (String(s.url || '').trim() || hasBaseUrl))
    : [];
  if (!stepsRaw.length) return base;

  const steps = stepsRaw.map((s) => sanitizeHttpStep(s));
  if (!base.url) {
    // 多步骤任务的主地址留空时，用第一步的地址占位（列表展示、自检修正都靠它）
    base.url = steps[0].url;
    base.method = steps[0].method;
  }
  base.steps = steps;
  return base;
}

function sanitizeTask(input, existing) {
  const base = existing || { id: uid('task'), runCount: 0, failCount: 0, lastRun: null, lastResult: null, createdAt: nowISO() };
  const type = input.type === 'remind' ? 'remind' : 'http';
  // 节奏：支持一个任务配多个（09:00、12:00 各来一次）；老前端只传 schedule 也能用
  const rawSchedules = Array.isArray(input.schedules) && input.schedules.length
    ? input.schedules
    : [input.schedule || {}];
  const seen = new Set();
  const schedules = [];
  for (const raw of rawSchedules) {
    if (schedules.length >= SCHED_MAX) break;
    let s;
    try {
      s = normalizeSchedule(raw);
    } catch (e) {
      e.message = `第 ${schedules.length + 1} 条节奏：${e.message}`;
      throw e;
    }
    // 间隔节奏按「单位 + 数值 + 开始时间」去重，不只看分钟数：
    // 「每 1 周」和「每 7 天」换算后都是 10080 分钟，含义却不同。
    const key = s.mode === 'cron'
      ? 'c:' + s.cron
      : `i:${s.unit}:${s.every}:${s.startAt}:${s.everyMinutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schedules.push(s);
  }
  if (!schedules.length) schedules.push(normalizeSchedule({}));
  const schedule = schedules[0]; // 老字段保留第一套，兼容旧读法

  const config = type === 'http'
    ? sanitizeHttpConfig(input.config)
    : {
        message: String((input.config && input.config.message) || ''),
        // 提醒类任务的推送通道：站内永远在，其余按用户勾的来
        channels: withInapp(
          Array.isArray(input.config && input.config.channels)
            ? sanitizeChannelList(input.config.channels)
            : ['inapp'],
        ),
      };

  // 任务级通知策略：只有前端明确传了才落库，缺省表示跟随全局（老任务行为不变）
  const notify = sanitizeNotifyPolicy(input.config && input.config.notify);
  if (notify) config.notify = notify;
  /*
   * 提醒类任务的手机推送也要能用任务级高级选项。
   * http 任务在 sanitizeHttpConfig 里已经处理过，这里只管 remind —— 两条分支
   * 都要落，否则「提醒任务里配了点击链接」会在保存时被静默丢掉。
   */
  if (type !== 'http') {
    const nmp = sanitizeNmPush(input.config && input.config.nmPush);
    if (nmp) config.nmPush = nmp;
    // 提醒任务同样支持「不参与自动补跑」（http 分支在 sanitizeHttpConfig 里处理）
    if (input.config && input.config.noCatchup === true) config.noCatchup = true;
  }

  // 单请求任务必须有 url；多步骤任务则要求 steps 里每步都有 url（由 sanitizeHttpConfig 校验）
  if (type === 'http' && !config.url && !(config.steps && config.steps.length)) {
    throw new Error('必须填写请求地址');
  }
  if (type === 'remind' && !config.message.trim()) throw new Error('必须填写提醒内容');

  // 任务组：纯展示用的自由文本，旧客户端保存时不带这个字段，就沿用原来的组
  const rawGroup = input.group === undefined ? (existing && existing.group) || '' : input.group;
  const group = String(rawGroup || '').trim().slice(0, 24);

  const task = {
    ...base,
    // 编辑任务时允许不带 name（保持原名），只有新建且为空才落「未命名任务」
    name: String(input.name || '').trim() || (existing && existing.name) || '未命名任务',
    group,
    type,
    enabled: input.enabled !== false,
    schedule,
    schedules,
    config,
  };
  task.nextRun = task.enabled ? computeNextRun(task, new Date())?.toISOString() || null : null;
  return task;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  /* ---- 公开接口：健康检查与鉴权状态 ---- */

  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      at: nowISO(),
      uptime: Math.round(process.uptime()),
      build: SMS_BUILD,
      // cron 永远按进程时区解析；settings.timezone 只影响通知文案里的本地时间
      cronTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      privateUrlGuard: privateUrlGuardOn(),
      // 任务级失败重试：单任务最多重试几次（默认 0，由任务自己开）
      taskRetryMax: RETRY_MAX_TIMES,
      // AI 通知优化当前生效的超时与尝试次数（设置页可调）
      aiPolicy: {
        timeoutMs: Math.min(AI_TIMEOUT_MAX, Math.max(AI_TIMEOUT_MIN, Number((state.settings.ai || {}).timeoutMs) || AI_TIMEOUT_MS)),
        maxAttempts: Math.min(AI_ATTEMPTS_MAX, Math.max(1, Number((state.settings.ai || {}).maxAttempts) || AI_MAX_ATTEMPTS)),
      },
      logRetentionDays: LOG_RETENTION_DAYS,
      logCounts: {
        logs: (state.logs || []).length,
        systemLogs: (state.systemLogs || []).length,
      },
      stateWrites: stateWriteStats(),
      /* 落盘健康：fsync 是否生效、备份轮转时间、是否发生过损坏回退 —— 数据安全一眼可查 */
      storage: stateStorageSnapshot(),
      /* 补跑：本次启动补成几个、跳过几个。跳过原因是「没重复跑」的证据，必须能看到 */
      catchup: catchupSnapshot(),
      /* 运行指标（第十八批）：只看汇总，小时柱在 /api/state 里给页面画图 */
      metrics: (() => {
        const m = metricsSnapshot();
        return {
          buckets: m.buckets,
          successRate: m.successRate,
          last1h: m.last1h,
          last24h: m.last24h,
        };
      })(),
      /* 死信水位：条数 + 已告警档位（档位为 0 表示从没跨档） */
      deadLetter: { count: (state.deadLetters || []).length, alertLevel: Number(state.deadLetterAlert) || 0, max: DEAD_LETTER_MAX },
      /*
       * 调度健康（第十七批）：ticking 卡住多久、被看门狗强制解开过几次。
       * 「任务不跑了」以前只能靠人发现，现在这一个对象就能看出来。
       */
      scheduler: {
        ticking,
        heldMs: ticking && tickStartedAt ? Date.now() - tickStartedAt : 0,
        stuckCount: tickStuckCount,
        stuckLimitSec: TICK_STUCK_MS / 1000,
        taskDeadlineSec: TASK_DEADLINE_MS / 1000,
      },
      // 是否跑在守护进程下：决定「未捕获异常」是退出重启还是降级续跑
      supervised: SUPERVISED,
      // 系统日志落盘节奏（秒）：告警 45s、普通访问日志 300s，见 sysLogPersistSoon
      sysLogPersist: { urgentSec: SYSLOG_PERSIST_URGENT / 1000, lazySec: SYSLOG_PERSIST_LAZY / 1000 },
      // 连接池快照：free 有数说明保活连接还在，任务再跑就能直接复用
      pool: httpClient.poolStats(),
      /*
       * 双向陪护快照：中继的 /__guard 会回打本接口，把这里的状态带回 Cloudflare；
       * 运维也能直接从 /api/health 一眼看到「CF 有没有按时唤醒我、我有没有探到中继」。
       * 全是元数据，不含任何密钥。
       */
      companion: companionSnapshot(),
      /* 部署一致性：版本指纹、产物是否过期、数据目录是否降级，运维一眼可查 */
      assets: { ver: ASSET_VER, ...ASSET_STATUS },
      dataDir: { stateFile: STATE_FILE, fallback: DATA_DIR_FALLBACK || '' },
    });
  }

  /*
   * 手动触发一次双向陪护体检：只读探针，不触发调度、不发短信。
   * 鉴权：开着访问控制时要求登录（它每次都是一次十几秒的出站，不该让访客免费放大）；
   * 缓存：60 秒内重复调用直接回上次结果，手动按钮用 ?force=1 强制重测。
   */
  if (pathname === '/api/relay/guard') {
    if (REQUIRE_PASSWORD && !isAuthed(req)) {
      return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
    }
    const force = /^(1|true|yes)$/i.test(String(url.searchParams.get('force') || ''));
    return sendJSON(res, 200, await guardSmsRelay({ force }));
  }

  /*
   * 第二重保活保险：外部唤醒端点。
   * 实例休眠后进程完全停摆，自己叫不醒自己 —— 只有外部请求能唤醒。
   * 任何外部定时器（cron-job.org / UptimeRobot / 手机快捷指令 / 别的机器的 crontab）
   * 用 /api/wake?token=xxx 定期打一次，实例就会被拉起，随后内置自探活接手保温。
   */
  if (pathname === '/api/wake') {
    const token = String(
      url.searchParams.get('token')
      || req.headers['x-token']
      || (String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7) : '')
      || ''
    ).trim();
    const expect = String((state.settings.wake && state.settings.wake.token) || '');
    if (!expect || token !== expect) {
      return sendJSON(res, 401, { ok: false, error: '唤醒令牌无效' });
    }
    const w = state.settings.wake;
    w.lastWokeAt = nowISO();
    w.count = (Number(w.count) || 0) + 1;
    /*
     * 这个环境是按请求拉起容器的（空闲约 1 分钟就停），15 秒一次的 tick 经常等不到。
     * 所以外部定时器打进来时当场跑一次调度：到期的任务就地执行，不用再等下一轮。
     */
    let ranNow = 0;
    try { ranNow = await tick(); } catch { /* 调度异常不影响唤醒结果 */ }
    keepLog('wake', true, `外部唤醒成功（累计 ${w.count} 次）` + (ranNow ? `，顺带执行 ${ranNow} 个到期任务` : ''));
    saveState();
    /*
     * 「唤醒即陪护」：Cloudflare 每 30 分钟叫醒我一次，我醒来顺手回探一次中继。
     * 用 fire-and-forget，不让体检拖慢唤醒响应；容器若被立刻回收就丢这一轮，
     * 还有每小时钩子、每日自检任务和 /api/relay/guard 兜底，不会静默失联。
     */
    void guardSmsRelay().catch(() => {});
    return sendJSON(res, 200, {
      ok: true,
      wokeAt: w.lastWokeAt,
      count: w.count,
      uptimeSec: Math.round(process.uptime()),
      ranNow,
      note: ranNow ? `实例已醒，已执行 ${ranNow} 个到期任务` : '实例已醒，当前没有到期任务',
    });
  }

  if (pathname === '/api/auth/status' && method === 'GET') {
    const s = sessionOf(req);
    return sendJSON(res, 200, {
      passwordRequired: REQUIRE_PASSWORD,
      authed: !!s,
      role: s ? s.role : null,
    });
  }

  // 首次设置密码：主密码被强制锁定，这里永远拒绝
  if (pathname === '/api/auth/setup' && method === 'POST') {
    return sendJSON(res, 403, { ok: false, error: '主密码由服务端锁定，无需也无法自行设置' });
  }

  /*
   * 登录接口。访问控制关闭时它只承担「提权到管理员」这一个作用，
   * 普通访客压根不需要走这里。
   */
  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip = clientIP(req);
    const body = await readBody(req);
    const password = String(body.password || '');

    /*
     * 先判管理密码，且不受「失败锁定」影响 ——
     * 否则有人在外面故意输错 10 次就能把管理员一起锁在门外。
     */
    if (adminPasswordMatch(password)) {
      if (!state.auth) {
        state.auth = { salt: '', hash: '', secret: crypto.randomBytes(32).toString('hex'), createdAt: nowISO() };
      }
      loginFailures.delete(ip);
      pushAuthLog(req, { ok: true, role: 'admin', ip });
      const token = issueToken(state.auth.secret, 'admin');
      res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { ok: true, role: 'admin' });
    }

    // 访问控制没开：除了管理密码，其他输入一律无效（也不需要）
    if (!REQUIRE_PASSWORD) {
      return sendJSON(res, 401, { ok: false, error: '当前未启用密码访问，直接打开即可进入' });
    }

    if (!state.auth) return sendJSON(res, 409, { ok: false, error: '尚未初始化密码' });

    const locked = loginLockRemain(ip);
    if (locked > 0) {
      return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${locked} 分钟后再试` });
    }

    if (!verifyPassword(password, state.auth)) {
      noteLoginFailure(ip);
      pushAuthLog(req, { ok: false, role: null, ip });
      return sendJSON(res, 401, { ok: false, error: '密码不正确' });
    }
    loginFailures.delete(ip);
    pushAuthLog(req, { ok: true, role: 'user', ip });
    const token = issueToken(state.auth.secret, 'user');
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
    return sendJSON(res, 200, { ok: true, role: 'user' });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 短信网关：对外 HTTP 发信入口，自鉴权（不走会话），不受访问控制影响 ---- */

  if (pathname === '/gateway/sms/health') {
    const g = state.settings.gatewaySms || {};
    return sendJSON(res, 200, { ok: true, service: 'cronhub-sms-gateway', enabled: !!(g.enabled && g.token), time: nowISO() });
  }

  if (pathname === '/gateway/sms/send' && (method === 'GET' || method === 'POST')) {
    const g = state.settings.gatewaySms || {};
    const ip = req.socket.remoteAddress || '';
    if (!g.enabled || !g.token) {
      gatewayLog({ ip, ok: false, message: '网关未启用' });
      return sendJSON(res, 404, { ok: false, error: '短信网关未启用' });
    }
    const provided = gatewayTokenOf(req, url);
    if (provided !== g.token) {
      gatewayLog({ ip, ok: false, message: '鉴权失败' });
      return sendJSON(res, 401, { ok: false, error: '鉴权失败：token 不正确' });
    }
    const body = method === 'POST' ? await readBody(req) : null;
    const content = gatewayContentOf(url, body);
    if (!content) {
      gatewayLog({ ip, ok: false, message: '缺少 content' });
      return sendJSON(res, 400, { ok: false, error: '缺少发送内容（content / text / message）' });
    }
    // async=1（URL 参数或 body 字段）：立即受理，后台发送——外部系统（如 Cronhub 任务）必须用这个，避免同步等待超时
    const isAsync = url.searchParams.get('async') === '1' || body && (body.async === 1 || body.async === true);
    const send = async () => {
      try {
        // 网关是「把调用方给的原文发出去」：不加时间戳、不截断、不附操作链接
        const r = await sendSms({ ...state.settings.sms, enabled: true, maxChars: 480, actionLink: false }, { title: content, body: '' });
        gatewayLog({ ip, content: content.slice(0, 60), mode: isAsync ? 'async' : 'sync', ok: r.ok, message: r.message });
        return r;
      } catch (e) {
        gatewayLog({ ip, content: content.slice(0, 60), mode: isAsync ? 'async' : 'sync', ok: false, message: e.message });
        return { ok: false, message: e.message };
      }
    };
    if (isAsync) {
      send();
      return sendJSON(res, 200, { ok: true, async: true, message: '已受理，后台发送中' });
    }
    const r = await send();
    return sendJSON(res, r.ok ? 200 : 500, r);
  }

  /* ---- 短信转发中转：接收手机 SmsForwarder 转发来的短信 ---- */

  if (pathname === '/gateway/sms/receive' && (method === 'GET' || method === 'POST')) {
    // 中转已下线：装作接口不存在，而不是回「未启用」（那等于告诉对方这里有开关可以打开）
    if (!SMS_RELAY_ENABLED) return sendJSON(res, 404, { ok: false, error: '接口不存在' });
    const sr = state.settings.smsRelay || {};
    const ip = req.socket.remoteAddress || '';
    if (!sr.enabled || !sr.token) return sendJSON(res, 404, { ok: false, error: '短信转发未启用' });
    const provided = gatewayTokenOf(req, url);
    if (provided !== sr.token) {
      gatewayLog({ ip, ok: false, message: '转发鉴权失败' });
      return sendJSON(res, 401, { ok: false, error: '鉴权失败：token 不正确' });
    }
    const body = method === 'POST' ? await readBody(req) : null;
    const b = body || {};
    // SmsForwarder JSON 模板字段宽容解析：内容 content/text/msg/message/sms，发件人 from/address/phone/mobile/sender/title
    const content = String(b.content || b.text || b.msg || b.message || b.sms || url.searchParams.get('content') || '').trim();
    const from = String(b.from || b.address || b.phone || b.mobile || b.sender || url.searchParams.get('from') || '未知号码').trim();
    if (!content) {
      gatewayLog({ ip, ok: false, message: '转发缺少内容' });
      return sendJSON(res, 400, { ok: false, error: '缺少短信内容（content / text / msg / message）' });
    }
    if (!Array.isArray(state.smsRelay)) state.smsRelay = [];
    state.smsRelay.unshift({ id: uid('srl'), at: nowISO(), from: from.slice(0, 40), content: content.slice(0, 500) });
    if (state.smsRelay.length > 50) state.smsRelay.length = 50;
    // 中转分发：始终落一条站内通知；pushNotify 开启时再推手机（NotifyMe）
    pushNotification({
      level: 'info',
      title: `📨 短信 ${from.slice(0, 24)}`,
      body: content.slice(0, 200),
      source: 'sms-relay',
    });
    let pushMsg = '已记录';
    if (sr.pushNotify) {
      try {
        const r = await sendNotifyMe(state.settings.notifyme, { title: `📱 短信 ${from.slice(0, 24)}`, body: content.slice(0, 180) });
        pushMsg = r.message || pushMsg;
      } catch (e) {
        pushMsg = '推送失败：' + e.message;
      }
    }
    gatewayLog({ ip, ok: true, message: `收到转发短信（${pushMsg}）`, content: `[${from}] ${content.slice(0, 30)}` });
    saveState();
    return sendJSON(res, 200, { ok: true, message: '已中转' });
  }

  /* ---- 业务接口：访问控制关闭时直接放行，开启时才要求登录 ---- */

  if (REQUIRE_PASSWORD && !isAuthed(req)) {
    return sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    // 主密码被强制锁定，任何角色都改不了（含 admin）
    return sendJSON(res, 403, {
      ok: false,
      error: `主密码已被服务端锁定为固定值，无法修改。如需变更请设置环境变量 FORCE_PASSWORD。`,
    });
  }

  /* ---- 管理接口：只有 admin 会话可用 ---- */

  if (pathname === '/api/admin/audit' && method === 'GET') {
    if (!isAdmin(req)) return sendJSON(res, 404, { ok: false, error: '接口不存在' });
    return sendJSON(res, 200, {
      ok: true,
      entries: state.authLog.slice(-AUTH_LOG_MAX).reverse(),
      forced: {
        passwordLocked: REQUIRE_PASSWORD,
        accessControlled: REQUIRE_PASSWORD,
        adminCount: ADMIN_PASSWORDS.length,
      },
      storage: { writable: storageWritable, path: STATE_FILE, error: lastStorageError },
      process: {
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        port: PORT,
        pid: process.pid,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      },
    });
  }

  if (pathname === '/api/admin/unlock' && method === 'POST') {
    if (!isAdmin(req)) return sendJSON(res, 404, { ok: false, error: '接口不存在' });
    loginFailures.clear();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/state' && method === 'GET') {
    const s = sessionOf(req);
    return sendJSON(res, 200, publicState(s && s.role === 'admin' ? 'admin' : 'user'));
  }

  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    const task = sanitizeTask(body, null);
    state.tasks.push(task);
    saveState();
    pushSysLog({
      level: 'info',
      source: 'config',
      msg: `新建任务 · ${task.name}（${task.type === 'http' ? 'HTTP' : '提醒'} · ${task.enabled ? '启用' : '暂停'}）· 任务总数 ${state.tasks.length}`,
      detail: { action: 'task.create', taskId: task.id, name: task.name, type: task.type, enabled: task.enabled, total: state.tasks.length },
    });
    return sendJSON(res, 200, { ok: true, task });
  }

  /*
   * 批量 upsert：给 Agent / 脚本用，一次调用就能把一组任务建成想要的样子。
   * 按 name 匹配已有任务：匹配到就更新（保留 id 与统计数据），否则新建。
   * 传 prune:true 时，会把「本次没出现在 items 里、且名字带同一 tag 前缀」的任务删掉，
   * 方便把「一套任务」当成一个整体反复同步，而不会越建越多。
   *
   * items 里每项除了标准任务字段，还可以给 keep:false 表示「确保它不存在」。
   */
  if (pathname === '/api/tasks/upsert' && method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return sendJSON(res, 400, { ok: false, error: 'items 不能为空' });

    const created = [];
    const updated = [];
    const removed = [];
    const failed = [];

    for (const item of items) {
      const name = String((item && item.name) || '').trim();
      if (!name) { failed.push({ name: '', error: '缺少任务名称' }); continue; }

      const existing = state.tasks.find((t) => t.name === name);
      if (item.keep === false) {
        if (existing) {
          state.tasks = state.tasks.filter((t) => t.id !== existing.id);
          removed.push({ name, id: existing.id });
        }
        continue;
      }
      try {
        if (existing) {
          const next = sanitizeTask({ ...item, type: item.type || existing.type }, existing);
          Object.assign(existing, next);
          updated.push({ name, id: existing.id, nextRun: existing.nextRun });
        } else {
          const task = sanitizeTask(item, null);
          state.tasks.push(task);
          created.push({ name, id: task.id, nextRun: task.nextRun });
        }
      } catch (err) {
        failed.push({ name, error: err.message });
      }
    }

    // 前缀清理：把 tag 相同、但这次没被声明的历史任务删掉
    if (body.pruneTag) {
      const tag = String(body.pruneTag);
      const names = new Set(items.map((i) => String(i.name || '')));
      const stale = state.tasks.filter((t) => t.name.startsWith(tag) && !names.has(t.name));
      for (const t of stale) removed.push({ name: t.name, id: t.id });
      if (stale.length) {
        const ids = new Set(stale.map((t) => t.id));
        state.tasks = state.tasks.filter((t) => !ids.has(t.id));
      }
    }

    saveState();
    return sendJSON(res, 200, { ok: failed.length === 0, created, updated, removed, failed });
  }

  /*
   * 预览某个任务最近一次运行会生成的通知内容（不真发）。
   * 用途：确认「一堆 JSON 被提炼成一句人话」的效果，避免盲发。
   */
  /*
   * 批量配置手机推送通道。Agent 一次性写入凭据，避免在对话里反复贴。
   * 只回传脱敏后的凭据，不把明文再吐回去。
   */
  if (pathname === '/api/settings/notifyme' && method === 'PUT') {
    const body = await readBody(req);
    const patch = { ...body };
    // 页面回显的是脱敏串（如 dz1h…cul0）。输入框带着掩码值点保存时，
    // 绝不能把它当真凭据写进去 —— 否则下次推送就是 FCM 400 invalid token。
    for (const k of ['uuid', 'token']) {
      const v = String(patch[k] || '');
      if (!v.trim() || v.includes('…') || v === '••••' || v === '••••••') delete patch[k];
    }
    state.settings.notifyme = { ...DEFAULT_SETTINGS.notifyme, ...state.settings.notifyme, ...patch };
    saveState();
    return sendJSON(res, 200, { ok: true, notifyme: maskNotifyMe(state.settings.notifyme) });
  }

  /*
   * 凭据续期状态与写入。
   * GET  只看状态（脱敏，含剩余天数），用来判断要不要换 refreshToken；
   * PUT  写入 refreshToken 并立刻换一次，验证有效性后再落盘；
   * POST 强制立刻续期一次（解决「已经 401 了」的救火场景）。
   */
  if (pathname === '/api/settings/token' || pathname === '/api/settings/token/refresh') {
    if (method === 'GET') {
      const v = tokenVault();
      const now = Date.now();
      return sendJSON(res, 200, {
        ok: true,
        enabled: v.enabled,
        configured: !!v.refreshToken,
        refreshToken: maskSecret(v.refreshToken),
        accessToken: maskSecret(v.accessToken),
        accessDaysLeft: v.accessExpiresAt ? Math.round((v.accessExpiresAt - now) / 86400000) : null,
        refreshDaysLeft: v.refreshExpiresAt ? Math.round((v.refreshExpiresAt - now) / 86400000) : null,
        accessExpiresAt: v.accessExpiresAt ? new Date(v.accessExpiresAt).toISOString() : null,
        refreshExpiresAt: v.refreshExpiresAt ? new Date(v.refreshExpiresAt).toISOString() : null,
      });
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      const rt = String(body.refreshToken || '').trim();
      if (!rt) return sendJSON(res, 400, { ok: false, error: 'refreshToken 不能为空' });
      const v = tokenVault();
      v.enabled = body.enabled !== false;
      v.refreshToken = rt;
      v.accessToken = '';
      v.accessExpiresAt = 0;
      state.settings.tokenVault = v;
      try {
        await refreshAccessToken(v); // 立刻验证：错的令牌当场报错，不会静默躺到 30 天后
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: '长效令牌验证失败：' + err.message });
      }
      return sendJSON(res, 200, {
        ok: true,
        message: '凭据已保存并完成首次续期',
        refreshToken: maskSecret(tokenVault().refreshToken),
        accessDaysLeft: 30,
        refreshDaysLeft: 60,
      });
    }

    if (method === 'POST') {
      try {
        const at = await currentAccessToken(true);
        const v = tokenVault();
        return sendJSON(res, 200, {
          ok: !!at,
          message: at ? '续期成功' : '尚未配置 refreshToken',
          accessDaysLeft: v.accessExpiresAt ? Math.round((v.accessExpiresAt - Date.now()) / 86400000) : null,
          refreshDaysLeft: v.refreshExpiresAt ? Math.round((v.refreshExpiresAt - Date.now()) / 86400000) : null,
        });
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: err.message });
      }
    }
  }

  /* ---- 拖动排序：按前端拖出来的顺序重排数组，数组顺序本身就是持久化的顺序 ---- */
  if (pathname === '/api/tasks/reorder' && method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
    if (!ids.length) return sendJSON(res, 400, { ok: false, error: '缺少任务顺序' });
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = byId.get(id);
      // 同一个 id 只认第一次，重复下发不会把任务复制出来
      if (t) { next.push(t); byId.delete(id); }
    }
    // 顺序里没提到的任务（并发新建、别的端刚建的）追加到末尾，宁可位置不对也不能丢
    for (const t of state.tasks) if (byId.has(t.id)) next.push(t);
    state.tasks = next;
    saveState();
    return sendJSON(res, 200, { ok: true, count: next.length });
  }

  /* ---- 任务批量操作（青龙面板式）：必须放在 /api/tasks/:id 路由之前 ---- */
  if (pathname === '/api/tasks/batch' && method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const found = state.tasks.filter((t) => ids.includes(t.id));
    if (!found.length) return sendJSON(res, 400, { ok: false, error: '未选中任何任务' });
    if (body.action === 'enable' || body.action === 'disable') {
      for (const t of found) {
        t.enabled = body.action === 'enable';
        t.nextRun = t.enabled ? computeNextRun(t, new Date())?.toISOString() || null : null;
      }
    } else if (body.action === 'delete') {
      state.tasks = state.tasks.filter((t) => !ids.includes(t.id));
    } else {
      return sendJSON(res, 400, { ok: false, error: '未知操作' });
    }
    saveState();
    return sendJSON(res, 200, { ok: true, affected: found.length });
  }

  if (pathname.startsWith('/api/tasks/')) {
    const rest = pathname.slice('/api/tasks/'.length).split('/');
    const id = rest[0];
    const action = rest[1];
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return sendJSON(res, 404, { ok: false, error: '任务不存在' });

    if (action === 'run' && method === 'POST') {
      /*
       * 后台执行，立即回 202。
       *
       * runTask 里串着 AI 改写（最长 ~31s）和各外部渠道重试（短信网关不可达时
       * 自动任务退避 60s→300s），整条链路轻松超过托管平台网关的 60 秒上限：
       * 用户点「立即跑」会收到 504，但任务其实还在后台跑，再点一次就重复发短信。
       * 执行结果照常落到通知 / 日志 / 发送记录，页面按几次延时刷新即可看到。
       */
      if (task.runningAt) return sendJSON(res, 409, { ok: false, error: '任务正在执行中，请稍候再试', taskId: id });
      /*
       * 入队前同步「占位」：runningAt 原先只在 runTask 的第一行设置，而 runTask 被
       * 下面的 setImmediate 推迟到下一轮事件循环 —— 在响应返回之前标记仍是空的，
       * 连点两次 / 两个并发请求都能通过上面的检查，各排一次执行，重复签到、重复发短信。
       * 这里占位并立即落盘（runTask 内部会再写一次同字段，幂等），finally 负责清掉；
       * 进程若在占位后被回收，启动扫描会照常留下「执行中断」痕迹，不会静默补跑。
       */
      task.runningAt = nowISO();
      flushState();
      setImmediate(() => {
        // 手动执行同样有总时长上限，避免一个卡死的任务把「运行中」永远挂在那里
        runTaskGuarded(task, 'manual').catch((e) => {
          pushSysLog({
            level: 'error', source: 'task',
            msg: `「${task.name}」手动执行异常`,
            detail: { taskId: task.id, error: String((e && e.message) || e).slice(0, 200) },
          });
        });
      });
      return sendJSON(res, 202, { ok: true, started: true, taskId: id, message: '已开始执行，完成后可在通知与日志查看结果' });
    }
    if (action === 'toggle' && method === 'POST') {
      task.enabled = !task.enabled;
      task.nextRun = task.enabled ? computeNextRun(task, new Date())?.toISOString() || null : null;
      saveState();
      pushSysLog({
        level: 'info',
        source: 'config',
        msg: `${task.enabled ? '启用' : '暂停'}任务 · ${task.name}`,
        detail: { action: 'task.toggle', taskId: task.id, name: task.name, enabled: task.enabled },
      });
      return sendJSON(res, 200, { ok: true, task });
    }
    if (action === 'pin' && method === 'POST') {
      // 置顶就是真的挪到数组最前：顺序现在由手动拖动决定，再靠「渲染时排序」会和手拖打架
      task.pinned = !task.pinned;
      if (task.pinned) state.tasks = [task, ...state.tasks.filter((t) => t.id !== task.id)];
      saveState();
      return sendJSON(res, 200, { ok: true, task });
    }
    if (!action && method === 'PUT') {
      const body = await readBody(req);
      const before = JSON.stringify({ name: task.name, type: task.type, schedules: task.schedules, config: task.config });
      const updated = sanitizeTask({ ...body, type: body.type || task.type }, task);
      Object.assign(task, updated);
      saveState();
      const after = JSON.stringify({ name: task.name, type: task.type, schedules: task.schedules, config: task.config });
      pushSysLog({
        level: 'info',
        source: 'config',
        msg: `修改任务 · ${task.name}${before === after ? '（无实质变更）' : ''}`,
        detail: {
          action: 'task.update',
          taskId: task.id,
          name: task.name,
          changed: before !== after,
          before: JSON.parse(before),
          after: JSON.parse(after),
        },
      });
      return sendJSON(res, 200, { ok: true, task });
    }
    if (!action && method === 'DELETE') {
      const goneName = task.name;
      state.tasks = state.tasks.filter((t) => t.id !== id);
      saveState();
      pushSysLog({
        level: 'warn',
        source: 'config',
        msg: `删除任务 · ${goneName} · 剩余 ${state.tasks.length} 个`,
        detail: { action: 'task.delete', taskId: id, name: goneName, total: state.tasks.length },
      });
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/notifications/read' && method === 'POST') {
    const body = await readBody(req);
    if (body.id) {
      const n = state.notifications.find((x) => x.id === body.id);
      if (n) n.read = true;
    } else {
      state.notifications.forEach((n) => { n.read = true; });
    }
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/notifications' && method === 'DELETE') {
    state.notifications = [];
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/system-logs' && method === 'GET') {
    const level = url.searchParams.get('level') || 'all';
    const source = url.searchParams.get('source') || 'all';
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(1000, Math.max(20, Number(url.searchParams.get('limit')) || 300));
    const buf = sysLogBuffer();
    const counts = { info: 0, warn: 0, error: 0 };
    for (const l of buf) counts[l.level] = (counts[l.level] || 0) + 1;
    let list = buf;
    if (level !== 'all') list = list.filter((l) => l.level === level);
    if (source !== 'all') list = list.filter((l) => l.source === source);
    if (q) {
      list = list.filter((l) => (l.msg + ' ' + JSON.stringify(l.detail || '')).toLowerCase().includes(q));
    }
    return sendJSON(res, 200, {
      ok: true,
      total: buf.length,
      counts,
      sources: [...new Set(buf.map((l) => l.source))].sort(),
      sys: sysInfo(),
      logs: list.slice(0, limit),
    });
  }

  if (pathname === '/api/system-logs' && method === 'DELETE') {
    sysLogRing.length = 0;
    state.systemLogs = [];
    saveState();
    return sendJSON(res, 200, { ok: true, message: '运行日志已清空' });
  }

  if (pathname === '/api/logs' && method === 'DELETE') {
    state.logs = [];
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  /*
   * 复制一套渠道配置：服务端直接抄原始值，绕开前端脱敏串（否则复制出来 token 会变空）。
   * body = { type, from }，from 传 'main' 表示复制默认那套。
   */
  if (pathname === '/api/channel-instances/copy' && method === 'POST') {
    const body = await readBody(req);
    const type = String((body && body.type) || '');
    if (!CH_TYPES.includes(type)) return sendJSON(res, 400, { ok: false, error: '渠道类型不对' });
    const from = String((body && body.from) || 'main');
    const cfg = rawChannelConfig(type, from);
    if (!cfg) return sendJSON(res, 404, { ok: false, error: '要复制的那套配置不存在' });
    const list = channelInstances(type);
    if (list.length >= 12) return sendJSON(res, 400, { ok: false, error: '每个渠道最多 12 套配置' });
    const srcMark = from === 'main'
      ? channelLabelOf(type).mark
      : String((findChannelInstance(type, from) || {}).remark || '');
    const id = 'ci_' + crypto.randomBytes(6).toString('hex');
    // stripSecrets：长按标题「新建账号」用——照抄配置但清掉凭证，逼用户填自己的账号
    const stripSecrets = !!(body && body.stripSecrets);
    const remark = (stripSecrets
      ? `${CH_LABEL[type]} ${list.length + 2}`
      : (srcMark || '').replace(/(·副本)+$/, '')
        ? `${(srcMark || '').replace(/(·副本)+$/, '')}·副本`
        : `${CH_LABEL[type]} ${list.length + 2}`).slice(0, 24);
    // 复制出来默认不启用：先去改标识/内容，再打开开关，免得刚复制就重复推送
    const cfgCopy = { ...cfg, enabled: false };
    if (stripSecrets) for (const k of CH_SECRET_FIELDS[type] || []) cfgCopy[k] = '';
    const inst = { id, remark, enabled: false, config: cfgCopy };
    state.settings.channelInstances = { ...(state.settings.channelInstances || {}), [type]: list.concat([inst]) };
    saveState();
    return sendJSON(res, 200, { ok: true, id, remark });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    /*
     * 短信相关的配置项一律要求管理员权限，且这里是**唯一**的写入落点：
     *   settings.sms（分级/字数/退订/静音）、settings.gatewaySms（含网关令牌）、
     *   settings.smsRelay（含中转令牌）、channelInstances.sms（短信通道实例）
     * 不拦的话，访客一条 PUT 就能把网关令牌换掉、把通道关掉、或把 optOut 置真。
     * 注意：短信正文里的「静音/退订」走的是 /a/<token> 独立链接，不经过这里，不受影响。
     */
    const b = body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const touchesSms = has('sms') || has('gatewaySms') || has('smsRelay') || has('smsGatewayRelay')
      || has('smsGatewaySni')
      || !!(b.channelInstances && Object.prototype.hasOwnProperty.call(b.channelInstances, 'sms'))
      || !!(b.channels && Object.prototype.hasOwnProperty.call(b.channels, 'sms'));
    if (touchesSms && !needSmsAdmin(req, res, '修改短信设置')) return;
    const next = deepMerge(state.settings, body || {});
    /*
     * 页面上的密码框是空的（掩码不回填），所以空串和掩码串都表示「不修改」。
     * 这里以前只判 '••••••'，导致空串会把已有 SMTP 密码直接抹成空。
     */
    if (next.smtp && isMaskedValue(next.smtp.pass)) next.smtp.pass = state.settings.smtp.pass || '';
    // 页面上看到的是脱敏串，原样回存时别把它当新凭据写进去
    // 凭据掩码拦截：脱敏串原样保存 = 不修改（isMaskedValue 统一识别）
    /*
     * 这里覆盖了所有「接口打码下发 → 页面可能原样回存」的字段。
     * 少了任何一项，用户只要在设置页点一次保存，凭据就被掩码串覆盖掉（变成永久失效），
     * 所以新增打码字段时必须同步加到这里。
     */
    const keepIfMasked = (obj, key, prevObj, allowEmpty) => {
      if (!obj || typeof obj !== 'object') return;
      const v = obj[key];
      if (!isMaskedValue(v)) return;
      /*
       * allowEmpty：空串表示「显式清空」，不能当掩码保留原值。
       * NotifyMe 的 uuid / fcm 必须这样 —— 从 UUID 换成 FCM token 时，
       * 前端会把另一格清空提交上来，若按掩码处理，旧凭据永远清不掉，
       * 发送时就会撞上「UUID 与 FCM token 只能填一个」。
       * 掩码模式下的「留空 = 不修改」由前端省略该 key 保证，不依赖这里。
       */
      if (allowEmpty && !String(v || '').trim()) return;
      obj[key] = (prevObj && prevObj[key]) || '';
    };
    keepIfMasked(next.webhook, 'token', state.settings.webhook);
    keepIfMasked(next.webhook, 'uuid', state.settings.webhook, true);
    keepIfMasked(next.webhook, 'fcm', state.settings.webhook, true);
    /*
     * NotifyMe 高级选项：webhook（notifyme 格式）和独立 notifyme 通道字段同名，
     * 统一夹一次。actionType 只认 0/1/2/4/5 —— 手改 body 塞别的值会让手机侧
     * 收到不认识的动作类型，点了没反应还查不出原因。
     */
    const clampNm = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      obj.actionType = nmActionType(obj.actionType);
      obj.action = String(obj.action || '').slice(0, 500);
      obj.group = String(obj.group || '').slice(0, 32);
      obj.bigText = obj.bigText !== false;
      obj.urgent = obj.urgent === true;
    };
    clampNm(next.webhook);
    clampNm(next.notifyme);
    keepIfMasked(next.gatewaySms, 'token', state.settings.gatewaySms);
    keepIfMasked(next.smsRelay, 'token', state.settings.smsRelay);
    keepIfMasked(next.smsGatewayRelay, 'secret', state.settings.smsGatewayRelay);
    keepIfMasked(next.tokenVault, 'refreshToken', state.settings.tokenVault);
    keepIfMasked(next.tokenVault, 'accessToken', state.settings.tokenVault);
    // 短信操作链接令牌只由服务端生成，前端改不动（和 smsActionToken 的处理保持一致）
    next.smsActionToken = String(state.settings.smsActionToken || '');
    if (next.notifyme) {
      for (const k of ['uuid', 'token']) {
        if (isMaskedValue(next.notifyme[k])) next.notifyme[k] = state.settings.notifyme[k] || '';
      }
    }
    if (next.ai && isMaskedValue(next.ai.apiKey)) next.ai.apiKey = state.settings.ai.apiKey || '';
    // AI 单次超时 / 重试次数（设置页可调）：UI 只给几档预设，这里再夹一次防越界
    if (next.ai) {
      next.ai.timeoutMs = Math.min(AI_TIMEOUT_MAX, Math.max(AI_TIMEOUT_MIN, Number(next.ai.timeoutMs) || AI_TIMEOUT_MS));
      next.ai.maxAttempts = Math.min(AI_ATTEMPTS_MAX, Math.max(1, Number(next.ai.maxAttempts) || AI_MAX_ATTEMPTS));
    }
    // 短信网关：启用但还没令牌时自动生成一个；令牌只在这里管理，不做掩码（属主自己用的凭据）
    if (next.gatewaySms) {
      next.gatewaySms.token = String(next.gatewaySms.token || '').trim();
      if (next.gatewaySms.enabled && !next.gatewaySms.token) {
        next.gatewaySms.token = 'gw_' + crypto.randomBytes(16).toString('hex');
      }
      if (!next.gatewaySms.enabled) next.gatewaySms.enabled = false;
    }
    // 短信转发中转：同上，令牌独立生成
    if (next.smsRelay) {
      next.smsRelay.token = String(next.smsRelay.token || '').trim();
      if (next.smsRelay.enabled && !next.smsRelay.token) {
        next.smsRelay.token = 'sr_' + crypto.randomBytes(16).toString('hex');
      }
      next.smsRelay.pushNotify = next.smsRelay.pushNotify !== false;
      next.smsRelay.hideContent = next.smsRelay.hideContent !== false;
    }
    // 短信发送中继：只接受 https origin；留空或非法就自动关掉，避免误把请求发给明文地址
    if (next.smsGatewayRelay) {
      const g = next.smsGatewayRelay;
      /*
       * 地址支持「主 + 备用」：url 是主地址，urls 是备用数组。
       * 主地址挂了短信就全发不出去，两条以上才是真的冗余。
       * 一律只留 https origin —— 明文地址会让短信令牌在公网上裸奔。
       */
      const toOrigin = (v) => {
        const s = String(v || '').trim().replace(/\/+$/, '');
        if (!s) return '';
        try {
          const parsed = new URL(s);
          return parsed.protocol === 'https:' ? parsed.origin : '';
        } catch { return ''; }
      };
      const list = [];
      const push = (v) => { const o = toOrigin(v); if (o && !list.includes(o)) list.push(o); };
      push(g.url);
      (Array.isArray(g.urls) ? g.urls : String(g.urls || '').split(/[,;\s]+/)).forEach(push);
      g.url = list[0] || '';
      g.urls = list.slice(1);
      g.secret = String(g.secret || '').trim();
      g.enabled = !!g.enabled && !!g.url;
    }
    // 白名单 SNI：只接受纯主机名（不允许协议/路径/端口），非法值回落到默认值并关掉开关
    if (next.smsGatewaySni) {
      const g = next.smsGatewaySni;
      let sni = String(g.sni || '').trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(sni)) sni = '';
      g.sni = sni || DEFAULT_SETTINGS.smsGatewaySni.sni;
      g.enabled = !!g.enabled && !!sni;
    }
    /*
     * 补跑参数一律夹到安全区间。
     * 窗口给 0 会让「所有错过都算过期」，maxPerStart 不限又会退化成启动风暴，
     * 两个方向都会让刚做好的保护失效。
     */
    if (next.catchup) {
      const c = next.catchup;
      const clampInt = (v, d, lo, hi) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
      };
      c.enabled = c.enabled !== false;
      c.windowMinutes = clampInt(c.windowMinutes, 120, 5, 1440);
      c.maxPerStart = clampInt(c.maxPerStart, 5, 0, 50);
      c.minGapSec = clampInt(c.minGapSec, 45, 0, 3600);
      c.jitterMaxMs = clampInt(c.jitterMaxMs, 20000, 0, 300000);
    }
    if (has('missedPolicy')) {
      next.missedPolicy = next.missedPolicy === 'skip' ? 'skip' : 'run';
    }
    // 短信通知：分级 / 字数 / 操作链接 / 退订与静音状态（页面与短信操作页都会改写这几个）
    if (next.sms) {
      next.sms.minLevel = next.sms.minLevel === 'all' ? 'all' : 'important';
      const mc = Number(next.sms.maxChars);
      next.sms.maxChars = [67, 134, 201, 480].indexOf(mc) >= 0 ? mc : 134;
      // 缺省一律关：以前用 !== false，设置里漏传这个字段就会被补成 true，链接悄悄回来
      next.sms.actionLink = next.sms.actionLink === true;
      next.sms.optOut = !!next.sms.optOut;
      next.sms.mutedUntil = Math.max(0, Number(next.sms.mutedUntil) || 0);
    }
    // 站点根地址只由服务端按请求头记录，前端传什么都不认（防止把短信链接写到别的域名）
    next.siteBase = String(state.settings.siteBase || '');
    // 操作链接令牌同理：只由服务端生成，前端改不动
    next.smsActionToken = String(state.settings.smsActionToken || '');
    // 环境变量：清洗（key 合法化、去重取后值）
    if (next.envVars) {
      const cleaned = sanitizeEnvVars(next.envVars);
      const seen = new Set();
      next.envVars = cleaned.reverse().filter((v) => (seen.has(v.key) ? false : (seen.add(v.key), true))).reverse();
      /*
       * 值也是掩码下发的（{{ACCESS_TOKEN}} 这类占位符的真值可能就是账号凭据）。
       * 按 key 找回原值：同名变量原样回存 = 不修改；换了个新值才覆盖。
       */
      const prevVals = new Map(
        (Array.isArray(state.settings.envVars) ? state.settings.envVars : [])
          .map((v) => [String((v && v.key) || '').toUpperCase(), String((v && v.value) ?? '')]),
      );
      for (const v of next.envVars) {
        if (isMaskedValue(v.value)) v.value = prevVals.has(v.key) ? prevVals.get(v.key) : '';
      }
    }
    // 保活地址：清洗掉说明文字 / 加粗符号 / 非法参数，避免「看着开着、实际哑了」
    if (next.keepWarm) {
      const raw = String(next.keepWarm.url || '').trim();
      next.keepWarm.url = normalizeKeepWarmUrl(raw);
      next.keepWarm.intervalMin = Math.min(60, Math.max(1, Number(next.keepWarm.intervalMin) || 10));
      next.keepWarm.enabled = !!next.keepWarm.enabled;
      // 附加保险（页面心跳）的配置：不传就保持原值
      next.keepWarm.pageBeat = next.keepWarm.pageBeat !== false;
      next.keepWarm.pageBeatSec = Math.min(300, Math.max(10, Number(next.keepWarm.pageBeatSec) || 30));
      if (raw && !next.keepWarm.url) {
        return sendJSON(res, 400, { ok: false, error: '探活地址不合法，请粘贴完整的 https:// 地址（保活控制台可一键获取）' });
      }
    }
    // 通知渠道多实例：逐类型清洗（id 合法化、备注长度、字段收口、脱敏串保留原值）
    if (next.channelInstances) next.channelInstances = sanitizeChannelInstances(next.channelInstances);
    // 「默认」标签的标识（多用户区分用）：只留四类渠道，去掉空白、限长 24
    if (next.channelMarks && typeof next.channelMarks === 'object') {
      const marks = {};
      for (const t of CH_TYPES) marks[t] = String(next.channelMarks[t] || '').trim().slice(0, 24);
      next.channelMarks = marks;
    }
    // 唤醒令牌只由服务端生成，前端不可能改（也不许清空）
    const prevWake = state.settings.wake || {};
    next.wake = {
      token: prevWake.token || ensureWakeToken(),
      lastWokeAt: prevWake.lastWokeAt || '',
      count: Number(prevWake.count) || 0,
    };
    const prevSettings = state.settings;
    const changedKeys = [];
    for (const k of new Set([...Object.keys(prevSettings || {}), ...Object.keys(next || {})])) {
      if (k === 'wake') continue;
      if (JSON.stringify(prevSettings?.[k]) !== JSON.stringify(next?.[k])) changedKeys.push(k);
    }
    state.settings = next;
    saveState();
    if (changedKeys.length) {
      pushSysLog({
        level: 'info',
        source: 'config',
        msg: `设置已保存 · 变更 ${changedKeys.length} 项：${changedKeys.slice(0, 8).join('、')}${changedKeys.length > 8 ? ' 等' : ''}`,
        detail: { action: 'settings.update', changed: changedKeys },
      });
    }
    // 保活开关随保存立即生效
    if (next.keepWarm && next.keepWarm.enabled && next.keepWarm.url) keepWarmStart();
    else keepWarmStop();
    return sendJSON(res, 200, {
      ok: true,
      // 和其它读接口走同一个出口，避免「保存后返回明文」这一条绕行路径
      settings: maskSettings(state.settings, { admin: ((sessionOf(req) || {}).role === 'admin') }),
    });
  }

  /*
   * 凭据明文查看（显式动作）。
   *
   * 既然 /api/state 里全是掩码，页面上的「显示 / 复制」就必须有地方拿真值。
   * 这里要求当场输管理口令，换一次性的明文，不落任何 cookie、不下发到 localStorage：
   *   POST { password, keys: ['gatewaySms.token', ...] } → { ok, values: { 'gatewaySms.token': '...' } }
   * 失败计数与登录共用 loginFailures（同一套防爆破规则），成功也记审计。
   * 只允许白名单里的 key，防止把这里变成「任意设置项读取器」。
   */
  if (pathname === '/api/settings/reveal' && method === 'POST') {
    const ip = clientIP(req);
    const locked = loginLockRemain(ip);
    if (locked > 0) {
      return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${locked} 分钟后再试` });
    }
    const body = await readBody(req);
    const password = String(body.password || '');
    /*
     * 开放模式（站点没设管理口令）：没有口令可输，直接放行但记审计。
     * 这不降低安全性 —— 开放模式本来就把整份状态摊在链接上；掩码在这里防的是
     * 截图 / 录屏 / 共享屏幕时的意外泄露，不是防访问者。
     */
    const openMode = !REQUIRE_PASSWORD;
    if (!openMode) {
      if (!password) return sendJSON(res, 400, { ok: false, error: '请输入管理口令' });
      if (!adminPasswordMatch(password)) {
        noteLoginFailure(ip);
        pushAuthLog(req, { ok: false, role: 'reveal', ip });
        pushSysLog({
          level: 'warn',
          source: 'config',
          msg: '凭据明文查看失败：管理口令不正确',
          detail: { action: 'settings.reveal', ok: false, ipTag: ipTagOf(ip) },
        });
        return sendJSON(res, 401, { ok: false, error: '管理口令不正确' });
      }
      loginFailures.delete(ip);
    }
    /*
     * 白名单取值器。envVars 是动态 key，单独按前缀匹配；
     * 其余都是固定路径，防止这里被当成「任意设置项读取器」。
     */
    const STATIC_REVEAL = {
      'webhook.token': () => (state.settings.webhook || {}).token,
      'webhook.uuid': () => (state.settings.webhook || {}).uuid,
      'webhook.fcm': () => (state.settings.webhook || {}).fcm,
      'gatewaySms.token': () => (state.settings.gatewaySms || {}).token,
      'smsRelay.token': () => (state.settings.smsRelay || {}).token,
      'tokenVault.refreshToken': () => (state.settings.tokenVault || {}).refreshToken,
      'smtp.pass': () => (state.settings.smtp || {}).pass,
      'ai.apiKey': () => (state.settings.ai || {}).apiKey,
      'notifyme.token': () => (state.settings.notifyme || {}).token,
      'notifyme.uuid': () => (state.settings.notifyme || {}).uuid,
      // 中继密钥：掩码后设置页也需要能看一眼（它是短信链路的唯一出口凭据）
      'smsGatewayRelay.secret': () => (state.settings.smsGatewayRelay || {}).secret,
      'wake.token': () => ensureWakeToken(),
    };
    const readSecret = (key) => {
      if (Object.prototype.hasOwnProperty.call(STATIC_REVEAL, key)) return STATIC_REVEAL[key]();
      const m = /^envVars\.([\w]+)$/.exec(key);
      if (m) {
        const k = m[1].toUpperCase();
        const hit = (state.settings.envVars || [])
          .find((v) => String((v && v.key) || '').toUpperCase() === k);
        return hit ? hit.value : '';
      }
      return null; // 不在白名单
    };
    const keys = (Array.isArray(body.keys) ? body.keys : [])
      .map((k) => String(k || ''))
      .filter((k) => readSecret(k) !== null)
      .slice(0, 10);
    if (!keys.length) return sendJSON(res, 400, { ok: false, error: '没有可查看的字段' });
    const values = {};
    for (const k of keys) values[k] = String(readSecret(k) || '');
    pushAuthLog(req, { ok: true, role: 'reveal', ip });
    pushSysLog({
      level: 'warn',
      source: 'config',
      // 只记「看了哪几项」，不记值、不记口令
      msg: `凭据明文查看${openMode ? '（开放模式）' : ''}：${keys.join('、')}`,
      detail: { action: 'settings.reveal', ok: true, keys, openMode, ipTag: ipTagOf(ip) },
    });
    return sendJSON(res, 200, { ok: true, values });
  }

  /* 本机代理通道（agent 配置 / claim / report 接口）已移除：短信现由服务端直接发送。 */

  /*
   * 接收号码（绑定）管理。
   *
   * 一个号码 = 一份独立授权：平台把授权绑在 (clawUid, uuid) 上，
   * 一条授权只能发给本人那个号，所以「多号码」必然是「多份授权」。
   * 列表只吐状态摘要，不吐任何凭据值，也不触发网络请求。
   */
  if (pathname === '/api/sms/bindings' && method === 'GET') {
    if (!needSmsAdmin(req, res, '查看接收号码')) return;
    const STATE_TEXT = {
      ACTIVE: '正常', NEED_REAUTH: '待授权', REVOKED: '已解绑',
      EXPIRING: '临近过期', CIRCUIT_OPEN: '熔断中',
    };
    const list = bindings.list().map((b) => {
      const c = (b && b.cred) || {};
      const st = c.state || 'ACTIVE';
      return {
        id: b.id,
        label: b.label,
        state: st,
        stateText: STATE_TEXT[st] || st,
        boundAt: Number(c.boundAt) || 0,
        hardExpiresAt: Number(c.hardExpiresAt) || 0,
        lastSendAt: Number(c.lastSendAt) || 0,
        sendCountToday: Number(c.sendCountToday) || 0,
        needAuth: st === 'NEED_REAUTH' || st === 'REVOKED',
        primary: b.id === bindings.primaryId(),
      };
    });
    return sendJSON(res, 200, { ok: true, bindings: list, max: bindings.MAX_BINDINGS, primary: bindings.primaryId(), agent: false });
  }

  if (pathname === '/api/sms/bindings' && method === 'POST') {
    if (!needSmsAdmin(req, res, '新增接收号码')) return;
    const body = await readBody(req);
    const r = bindings.add({ label: body && body.label });
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.message });
    /*
     * 新增即生成设备身份：clawUid 必须在这一刻就固定下来，
     * 否则第一次 preAuth 时才生成，扫码扫到一半又换一台「设备」，平台永远说未授权。
     */
    const uid = ensureClawUid(r.binding.id);
    pushSysLog({ level: 'info', source: 'sms', msg: `新增接收号码「${r.binding.label}」，设备身份 ${uid.slice(0, 8)}…，等待扫码授权` });
    return sendJSON(res, 200, { ok: true, binding: { id: r.binding.id, label: r.binding.label, state: 'NEED_REAUTH' } });
  }

  /*
   * 内容预览（官方文档 4.3 /api/sms/preview）：发送前看一眼
   * 风控等级、命中词、字数、预计条数、美化建议 —— 全部只读，不发请求。
   * 与真实发送共用 lib/sms/content.js 的规则：预览说什么，发送就做什么。
   */
  if (pathname === '/api/sms/preview' && (method === 'POST' || method === 'GET')) {
    if (!needSmsAdmin(req, res, '预览短信内容')) return;
    const body = method === 'POST' ? await readBody(req).catch(() => ({})) : {};
    const text = String((body && body.text) || url.searchParams.get('text') || '');
    if (!text.trim()) return sendJSON(res, 400, { ok: false, error: '缺少 text 参数' });
    const risk = evaluateRiskLevel(text);
    const len = analyzeSmsLength(text);
    // 实际发送时会追加免责声明（send.cjs 第 4 步），预览必须把它算进条数
    const finalText = risk.disclaimer && !text.includes(risk.disclaimer)
      ? text + '\n' + risk.disclaimer
      : text;
    const finalLen = analyzeSmsLength(finalText);
    return sendJSON(res, 200, {
      ok: true,
      risk: {
        level: risk.level,
        levelText: risk.level === 2 ? '高危' : risk.level === 1 ? '轻度' : '无',
        hits: risk.hits,
        disclaimer: risk.disclaimer || '',
      },
      length: {
        charCount: finalLen.charCount,
        units: finalLen.units,
        segments: finalLen.segments,
        lineCount: finalLen.lineCount,
        hasEmoji: finalLen.hasEmoji,
        hasBullet: finalLen.hasBullet,
      },
      tips: beautifySuggestions(finalText),
      preview: finalText,
    });
  }

  /*
   * 发送记录（官方文档 4.3 /api/sms/records）：
   * 摘要 + 每号结果 + 条数 + 风险等级。正文全文不落盘（隐私告知见 README-SECURITY）。
   */
  if (pathname === '/api/sms/records' && method === 'GET') {
    if (!needSmsAdmin(req, res, '查看发送记录')) return;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    const rows = (Array.isArray(state.smsRecords) ? state.smsRecords : []).slice(0, limit).map((r) => ({
      ...r,
      riskText: r.risk === 2 ? '高危' : r.risk === 1 ? '轻度' : '无',
      atText: new Date(Number(r.at) || 0).toLocaleString('zh-CN', { hour12: false }),
    }));
    return sendJSON(res, 200, { ok: true, records: rows, total: (state.smsRecords || []).length });
  }

  if (pathname === '/api/sms/records' && method === 'DELETE') {
    if (!needSmsAdmin(req, res, '清空发送记录')) return;
    state.smsRecords = [];
    saveState();
    return sendJSON(res, 200, { ok: true, message: '发送记录已清空' });
  }

  if (pathname === '/api/sms/bindings' && method === 'DELETE') {
    if (!needSmsAdmin(req, res, '解绑接收号码')) return;
    const body = await readBody(req);
    const bid = bindingFromReq(url, body);
    const r = bindings.remove(bid);
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.message });
    // 实例里的熔断/配额缓存跟着一起丢掉，避免「删了又建同名 id」捡到旧状态
    smsCredInstances.delete(bid);
    smsAuthUrlByBinding.delete(bid);
    return sendJSON(res, 200, { ok: true, removed: r.removed });
  }

  /*
   * 推送死信：重试耗尽的通知留在这里，可以重放。
   * 正文含通知原文（可能是任务结果、业务数据），所以和短信管理面同一道闸门。
   */
  if (pathname === '/api/sms/dead-letters' && method === 'GET') {
    if (!needSmsAdmin(req, res, '查看死信队列')) return;
    return sendJSON(res, 200, { ok: true, entries: state.deadLetters || [] });
  }
  if (pathname === '/api/sms/dead-letters/replay' && method === 'POST') {
    if (!needSmsAdmin(req, res, '重放死信')) return;
    const body = await readBody(req);
    const id = String(body.id || '');
    const list = Array.isArray(state.deadLetters) ? state.deadLetters : [];
    const entry = list.find((x) => x.id === id);
    if (!entry) return sendJSON(res, 404, { ok: false, error: '这条死信不存在（可能已被重放或清空）' });
    const rc = resolveChannel(entry.channel);
    let r;
    try {
      if (entry.channel === 'notifyme') {
        r = await sendNotifyMe(state.settings.notifyme, { title: entry.title, body: entry.body, markdown: entry.markdown });
      } else if (rc && rc.cfg) {
        r = await sendChannel(rc, { title: entry.title, body: entry.body, markdown: entry.markdown, level: 'error' });
      } else {
        r = { ok: false, message: `${entry.label || entry.channel} 的配置已删除，无法重放` };
      }
    } catch (e) {
      r = { ok: false, message: e.message };
    }
    pushSysLog({
      level: r.ok ? 'info' : 'warn',
      source: 'channel',
      msg: `死信重放 ${r.ok ? '成功' : '仍失败'}：${entry.label}${r.ok ? '' : ' · ' + String(r.message || '').slice(0, 120)}`,
      detail: { action: 'deadletter.replay', channel: entry.channel, taskName: entry.taskName, ok: !!r.ok },
    });
    if (r.ok) {
      state.deadLetters = list.filter((x) => x.id !== id);
      checkDeadLetterWatermark();
      saveState();
      return sendJSON(res, 200, { ok: true, message: `已重放：${r.message || '送达'}` });
    }
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.message = String(r.message || '').slice(0, 400);
    saveState();
    return sendJSON(res, 200, { ok: false, error: `重放失败：${r.message || '未知原因'}`, entry });
  }
  if (pathname === '/api/sms/dead-letters' && method === 'DELETE') {
    if (!needSmsAdmin(req, res, '清空死信队列')) return;
    const n = (state.deadLetters || []).length;
    state.deadLetters = [];
    // 清空 = 水位归零，下次再堆积能重新提醒（否则档位记着 50，永远不再告警）
    checkDeadLetterWatermark();
    saveState();
    pushSysLog({ level: 'info', source: 'channel', msg: `死信队列已清空（${n} 条）`, detail: { action: 'deadletter.clear', count: n } });
    return sendJSON(res, 200, { ok: true, cleared: n });
  }

  /*
   * 保活控制台（统一管理）。所有保活机制从这里读写，不再散落在设置里。
   */
  if (pathname === '/api/keepalive' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...keepAliveSnapshot(req) });
  }

  // 保险一：开/关 + 间隔 + 地址（地址留空时自动用当前访问域名拼一个）
  if (pathname === '/api/keepalive/self' && method === 'POST') {
    const body = await readBody(req);
    const cur = state.settings.keepWarm || {};
    const rawUrl = String(body.url || '').trim() || cur.url || '';
    const url = normalizeKeepWarmUrl(rawUrl) || autoKeepAliveUrl(req);
    if (!url) return sendJSON(res, 400, { ok: false, error: '无法确定探活地址，请手动填写完整网址' });
    state.settings.keepWarm = {
      ...cur,
      enabled: !!body.enabled,
      url,
      intervalMin: Math.min(60, Math.max(1, Number(body.intervalMin) || Number(cur.intervalMin) || 2)),
    };
    saveState();
    if (state.settings.keepWarm.enabled) keepWarmStart();
    else keepWarmStop();
    return sendJSON(res, 200, { ok: true, keepWarm: state.settings.keepWarm, ...keepAliveSnapshot(req) });
  }

  // 附加：页面心跳（纯前端行为，配置存服务端好跨设备一致）
  if (pathname === '/api/keepalive/page' && method === 'POST') {
    const body = await readBody(req);
    const cur = state.settings.keepWarm || {};
    state.settings.keepWarm = {
      ...cur,
      pageBeat: body.enabled !== false,
      pageBeatSec: Math.min(300, Math.max(10, Number(body.beatSec) || 30)),
    };
    saveState();
    return sendJSON(res, 200, { ok: true, page: keepAliveSnapshot(req).page });
  }

  // 保险二：服务端替你去打一次唤醒地址（浏览器打可能被跨域或缓存干扰）
  if (pathname === '/api/keepalive/wake/test' && method === 'POST') {
    const snap = keepAliveSnapshot(req);
    if (!snap.wake.url) return sendJSON(res, 400, { ok: false, error: '拿不到公网地址，请从浏览器里直接打开唤醒链接' });
    const t0 = Date.now();
    try {
      const r = await fetchNoProxy(snap.wake.url, { signal: AbortSignal.timeout(15000) });
      // fetchNoProxy 对回环地址返回的是轻量对象（只有 status/ok/text），统一走 text() 更稳
      const raw = await r.text();
      let j = {};
      try { j = JSON.parse(raw); } catch {}
      const ok = r.ok && j.ok !== false;
      if (!ok) keepLog('wake', false, `测试唤醒失败：HTTP ${r.status}`);
      return sendJSON(res, ok ? 200 : 502, {
        ok,
        status: r.status,
        ms: Date.now() - t0,
        count: j.count,
        message: ok ? `唤醒成功（累计 ${j.count} 次）` : (j.error || `HTTP ${r.status}`),
        ...keepAliveSnapshot(req),
      });
    } catch (e) {
      keepLog('wake', false, '测试唤醒失败：' + e.message);
      return sendJSON(res, 502, { ok: false, error: '请求失败：' + e.message, ...keepAliveSnapshot(req) });
    }
  }

  // 清空保活日志
  if (pathname === '/api/keepalive/log' && method === 'DELETE') {
    state.keepAliveLog = [];
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  // 手动探活一次：验证地址是否真的通（不改变自动保活的状态）
  if (pathname === '/api/keepwarm/ping' && method === 'POST') {
    const cfg = state.settings.keepWarm || {};
    keepWarm.url = normalizeKeepWarmUrl(cfg.url) || autoKeepAliveUrl(req);
    if (!keepWarm.url) return sendJSON(res, 400, { ok: false, error: '还没配置探活地址' });
    const saved = keepWarm.everyMin;
    const r = await keepWarmPing('manual');
    keepWarm.everyMin = saved;
    return sendJSON(res, r.ok ? 200 : 502, {
      ok: r.ok,
      message: r.message,
      url: keepWarm.url,
      at: keepWarm.lastAt,
    });
  }

  // 重新生成唤醒令牌（旧链接立刻失效）
  if (pathname === '/api/wake/regen' && method === 'POST') {
    state.settings.wake = { token: 'wk_' + crypto.randomBytes(16).toString('hex'), lastWokeAt: '', count: 0 };
    saveState();
    return sendJSON(res, 200, { ok: true, token: state.settings.wake.token });
  }

  if (pathname === '/api/ai/models' && method === 'GET') {
    // 拉取供应商可用模型列表（OpenAI 兼容 GET /models），服务端代理避免跨域
    const cfg = state.settings.ai || {};
    if (!cfg.baseUrl || !cfg.apiKey) return sendJSON(res, 400, { ok: false, error: '请先填写接口地址和 API Key 并保存' });
    try {
      const url = cfg.baseUrl.replace(/\/+$/, '') + '/models';
      const { ok, status, json } = await fetchJSON(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
      if (!ok) throw new Error(`接口返回 ${status}`);
      const ids = ((json && (json.data || json.models)) || [])
        .map((m) => m.id || m.name || m)
        .filter((x) => typeof x === 'string')
        .sort();
      return sendJSON(res, 200, { ok: true, models: ids });
    } catch (e) {
      return sendJSON(res, 502, { ok: false, error: '获取模型列表失败：' + e.message });
    }
  }

  if (pathname === '/api/ai/test' && method === 'POST') {
    const cfg = state.settings.ai || {};
    try {
      const r = await aiPolish(cfg, {
        title: 'CronHub AI 自检',
        body: '这是一条测试通知原文，用于验证 AI 接口连通性。',
        instruction: '原样保留关键信息，改得更简洁一点',
        taskName: 'AI 连通性测试',
      });
      return sendJSON(res, 200, { ok: true, message: `AI 连通正常，返回示例：「${r.title} / ${r.body}」` });
    } catch (e) {
      return sendJSON(res, 502, { ok: false, error: e.message });
    }
  }

  /*
   * NotifyMe 请求体预览：把「设置页当前配置 + 表单里还没保存的值」拼成**真正会发出去**的 JSON。
   * 和真实发送共用 buildNotifyMePayload，不是另写一份近似版 —— 否则预览说没问题、
   * 实际发出去字段丢了，等于又造一个「配了不生效」。
   * 凭据一律打码：这个接口只需要让人看清结构，不需要看到 token。
   */
  if (pathname === '/api/notifyme/preview' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const instId = String(body.channelId || '').trim();
    const src = instId ? rawChannelConfig('webhook', instId) : state.settings.webhook;
    const cfg = { ...defaultChannelConfig('webhook'), ...(src || {}) };
    // 表单里的值优先（还没保存也能先看效果）
    for (const k of ['format', 'actionType', 'action', 'group', 'urgent', 'bigText', 'uuid', 'fcm', 'token']) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') cfg[k] = body[k];
    }
    const uuid = String(cfg.uuid || '').trim();
    const fcm = String(cfg.fcm || '').trim();
    const legacy = String(cfg.token || '').trim();
    const isUuid = uuid ? true : (fcm ? false : !legacy.includes(':'));
    const cred = uuid || fcm || legacy;
    const wire = { ...cfg, mode: isUuid ? 'uuid' : 'token', uuid: isUuid ? (cred || '设备UUID') : '', token: isUuid ? '' : (cred || 'FCM设备token') };
    const adv = nmAdvanced(cfg);
    const payload = buildNotifyMePayload(wire, {
      title: String(body.title || '油价播报').slice(0, 60),
      body: String(body.body || '示例正文：这条只用来预览结构，不会真的推送。').slice(0, 400),
      nm: adv,
    });
    // 打码：外层 to / uuid 是设备凭据
    const outer = payload.data || {};
    if (outer.to) outer.to = maskSecret(outer.to);
    if (outer.uuid) outer.uuid = maskSecret(outer.uuid);
    return sendJSON(res, 200, {
      ok: true,
      mode: isUuid ? 'uuid' : 'token',
      scheme: whSchemeName(cfg.format),
      endpoint: isUuid ? NOTIFYME_UUID_ENDPOINT : NOTIFYME_TOKEN_ENDPOINTS[0],
      hasCred: !!cred,
      advanced: adv,
      payload,
    });
  }

  /*
   * 「看实际提示词」：返回拼装好的 system / user 原文 + 抽出来的校验条款。
   * 用户反复问「任务里写的要求到底有没有生效」，与其解释，不如让他直接看 ——
   * 所以这里必须复用 aiPrompts()，和真实调用是同一份代码，不允许另写一份近似版。
   * 用 POST 而不是 GET：新建任务时提示词还在输入框里没落库，要按当前表单值预览。
   */
  if (pathname === '/api/ai/preview' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { body = {}; }
    const task = state.tasks.find((t) => t.id === String(body.taskId || '')) || null;
    const c = (task && task.config) || {};
    const instId = String(body.aiInstance || c.aiInstance || '').trim();
    let aiDefault = String((state.settings.ai && state.settings.ai.defaultPrompt) || '');
    let modelName = String((state.settings.ai && state.settings.ai.model) || '');
    if (instId) {
      const rc = resolveChannel('ai:' + instId);
      if (rc && rc.cfg) {
        if (rc.cfg.defaultPrompt != null) aiDefault = String(rc.cfg.defaultPrompt);
        if (rc.cfg.model) modelName = String(rc.cfg.model);
      }
    }
    const taskPrompt = String(body.notifyPrompt != null ? body.notifyPrompt : c.notifyPrompt || '');
    const plan = aiPrompts({
      instruction: aiDefault,
      taskInstruction: taskPrompt,
      taskName: String(body.name || (task && task.name) || '（示例任务）'),
      title: '{{原始标题}}',
      body: '{{原始内容：这次执行得到的正文}}',
      rawData: '{{接口原始数据：按步骤汇总的真实字段}}',
    });
    const cfgOn = state.settings.ai && state.settings.ai.enabled;
    return sendJSON(res, 200, {
      ok: true,
      system: plan.system,
      user: plan.user,
      rules: plan.rules.map((r) => ({ kind: r.kind, label: r.label })),
      taskPromptLen: taskPrompt.length,
      promptMax: AI_NOTIFY_PROMPT_MAX,
      model: modelName,
      globalOn: !!cfgOn,
      aiOn: task ? c.aiEnabled !== false : true,
      note: plan.taskNeed
        ? '任务要求已进 system，优先级高于「体例」与默认要求；事实纪律与禁止写法是底线，不受它覆盖。'
        : '这个任务没写 AI 要求，只用下面的默认要求 + 通用规则；建议至少写一句口径或排版要求。',
    });
  }

  if (pathname === '/api/sms/reset-auth' && method === 'POST') {
    /*
     * 凭据疑似泄露 / 想彻底重绑时用。注意：清凭据只会把状态推到 NEED_REAUTH，
     * 不会凭空回到 ACTIVE —— 必须管理员真正扫码完成授权，状态才能由代码判定迁移。
     */
    if (!needSmsAdmin(req, res, '清除本地凭据')) return;
    const bid = bindings.resolveIds(url.searchParams.get('binding'))[0];
    await smsResetCreds(bid);
    smsAuthUrlByBinding.delete(bid);
    const b = bindings.get(bid);
    if (b) {
      if (!b.cred || typeof b.cred !== 'object') b.cred = {};
      b.cred.state = 'NEED_REAUTH';
      b.cred.accessTokenEnc = '';
      b.cred.accessExpiresAt = 0;
    }
    saveStateSync();
    pushSysLog({ level: 'warn', source: 'sms', msg: `[${bid}] 本地短信凭据已由管理员清除，状态置为需重新授权` });
    return sendJSON(res, 200, { ok: true, message: '本地凭据已清除。需管理员重新授权（扫码）后才能恢复发送。' });
  }

  // 中继连通性自检：轻量、不碰网关，供设置页「测试连通」按钮使用
  if (pathname === '/api/sms/relay-test' && method === 'GET') {
    if (!needSmsAdmin(req, res, '中继连通性自检')) return;
    return sendJSON(res, 200, { ok: true, relayProbe: await probeSmsRelay() });
  }

  /*
   * 白名单 SNI 对照探针（sni-probe-1）：只做 TLS 握手，不发 HTTP 请求、不碰令牌、
   * 不消耗网关配额。用来把「按明文 SNI 白名单拦」这个假设钉死：
   *   网关原 SNI 挂 + 无 SNI 挂，但某个白名单域名 SNI 能握手
   *   = 纯代码改 ClientHello 的 SNI 即可绕过，连中继都不用。
   * 每组独立 8s 超时，并发跑完最坏 8 秒。
   */
  if (pathname === '/api/sms/sni-probe' && method === 'GET') {
    if (!needSmsAdmin(req, res, 'SNI 链路探测')) return;
    let gwHost = '';
    try {
      const c = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'lib', 'sms', 'config.json'), 'utf8'));
      gwHost = new URL(c.apiUrl || '').hostname || '';
    } catch { /* 读不到就走下面的报错 */ }
    if (!gwHost) return sendJSON(res, 500, { ok: false, error: '读不到网关主机名' });

    const sniList = [
      { label: 'gateway', sni: gwHost },
      { label: 'noSni', sni: '' },
      { label: 'baidu', sni: 'www.baidu.com' },
      { label: 'idaas', sni: 'idaas.cmpassport.com' },
      { label: 'notifyme', sni: 'notifyme-server.wzn556.top' },
      { label: 'cloudflare', sni: 'www.cloudflare.com' },
    ];
    const one = (item) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve({ label: item.label, sni: item.sni || '(none)', ...v, ms: Date.now() - t0 });
      };
      try {
        const sock = tls.connect(443, gwHost, {
          servername: item.sni || '',
          rejectUnauthorized: false, // 只测握手，证书 CN 单独回报；真实发送仍严格校验
          family: 4,
        }, () => {
          let proto = '';
          let cn = '';
          try { proto = sock.getProtocol(); } catch { /* 非关键 */ }
          try { const c = sock.getPeerCertificate(); cn = (c && c.subject && c.subject.CN) || ''; } catch { /* 非关键 */ }
          sock.destroy();
          done({ ok: true, proto, certCN: cn });
        });
        sock.on('error', (e) => done({ ok: false, error: e.message, code: e.code || '' }));
        sock.setTimeout(8000, () => { sock.destroy(); done({ ok: false, error: 'Timeout' }); });
      } catch (e) { done({ ok: false, error: e.message }); }
    });
    const results = await Promise.all(sniList.map(one));
    const winners = results.filter((r) => r.ok && r.label !== 'gateway').map((r) => r.sni);
    return sendJSON(res, 200, {
      ok: true,
      build: SMS_BUILD,
      host: gwHost,
      results,
      winners,
      verdict: winners.length
        ? '有白名单 SNI 可握手：启用 SNI 伪装即可纯代码绕过'
        : '全部被拦：拦截不在 SNI 层，改用中继',
    });
  }

  if (pathname === '/api/sms/diag' && method === 'GET') {
    // 诊断会向外发 DNS / TCP / 一次带无效令牌的 HTTPS 请求，属于有外部副作用的操作
    if (!needSmsAdmin(req, res, '链路诊断')) return;
    let apiUrl = '';
    try {
      const c = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'lib', 'sms', 'config.json'), 'utf8'));
      apiUrl = c.apiUrl || '';
    } catch { /* 配置读不到就走下面的报错 */ }
    if (!apiUrl) return sendJSON(res, 500, { ok: false, error: '读不到 lib/sms/config.json 的 apiUrl' });

    let host = '';
    try { host = new URL(apiUrl).hostname; } catch { /* ignore */ }

    const dnsOut = await new Promise((resolve) => {
      dns.lookup(host, { all: true }, (e, a) => resolve(e ? { error: e.message } : a));
    });

    /*
     * 授权重构：自检只做网络连通性诊断，**完全不碰令牌接口**。
     * 这里读的是持久化的凭据状态，零出站调用 —— 自检再也不会消耗刷新配额。
     */
    const credNow = smsCredFor(bindingFromReq(url, null)).status();
    const probe = {
      resultCode: credNow.state,
      resultDesc: credNow.circuit.open
        ? '熔断中，剩余 ' + Math.ceil(credNow.circuit.remainSec / 60) + ' 分钟'
        : '未发起探测（只读状态：' + credNow.stateText + '，今日刷新 ' + credNow.today.refreshCount + '/' + credNow.today.refreshLimit + '）',
    };

    // TCP 可达性对照：确认是整段被封还是只有目标网关拒绝
    const tcp = (target, port = 443) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ target, port, ...v, ms: Date.now() - t0 }); } };
      let sock;
      try {
        sock = net.connect({ host: target, port, family: 4 });
      } catch (e) {
        done({ ok: false, code: e.code || 'ERR' });
        return;
      }
      sock.setTimeout(8000);
      sock.on('connect', () => { sock.destroy(); done({ ok: true }); });
      sock.on('error', (e) => done({ ok: false, code: e.code || e.message }));
      sock.on('timeout', () => { sock.destroy(); done({ ok: false, code: 'TIMEOUT' }); });
    });

    const targets = [];
    for (const [h, p2] of [[host, 443], [host, 80], ['idaas.cmpassport.com', 443], ['notifyme-server.wzn556.top', 443], ['www.baidu.com', 443]]) {
      targets.push(await tcp(h, p2));
    }

    const direct = await new Promise((resolve) => {
      const postData = 'text=' + encodeURIComponent('cronhub-diag');
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0 }); } };
      let req2;
      try {
        const u = new URL(apiUrl);
        req2 = https.request({
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname,
          method: 'POST',
          headers: {
            Authorization: 'cronhub-diag-invalid-token',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
          timeout: 15000,
          family: 4,
        }, (r2) => {
          let d = '';
          r2.on('data', (ch) => { d += ch; });
          r2.on('end', () => done({ status: r2.statusCode, len: d.length, body: d.slice(0, 200) }));
        });
        req2.on('error', (e) => done({ error: e.message, code: e.code || '' }));
        req2.on('timeout', () => { req2.destroy(); done({ error: 'Timeout' }); });
        req2.write(postData);
        req2.end();
      } catch (e) {
        done({ error: e.message });
      }
    });

    /*
     * TLS 层对照（第 45 轮）：TCP 可达 + TLS 握手被断 = 直连出网被中间设备拦截。
     * 云沙箱常见形态：出网必须走 HTTP 代理（env 注入），Node 原生 https 不理会代理 env，
     * 直连的 TLS ClientHello 一发出去就被 RST —— 表现正是「TCP 可连接但 ECONNRESET」。
     * 对百度的 TLS 握手做对照：百度也挂 = 沙箱全局直连被禁（必须走代理）；
     * 百度通只有网关挂 = 链路对出口 IP 的针对性拒绝。
     */
    const tlsProbe = (target) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ target, ...v, ms: Date.now() - t0 }); } };
      try {
        const rq = https.get({ host: target, path: '/', timeout: 8000, family: 4 }, (r3) => {
          r3.resume();
          r3.on('end', () => done({ ok: true, status: r3.statusCode }));
        });
        rq.on('error', (e) => done({ ok: false, error: e.message, code: e.code || '' }));
        rq.on('timeout', () => { rq.destroy(); done({ ok: false, error: 'Timeout' }); });
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    });
    const [tlsGw, tlsBaidu] = await Promise.all([tlsProbe(host), tlsProbe('www.baidu.com')]);

    /*
     * TLS 变体探针：判断 5gvas01 的 RST 是按 SNI 主机名拦、还是按目的 IP 拦。
     *  - tlsHandshake 用原生 tls.connect 直接做握手，可控 servername / 版本。
     *  - TLS1.2 变体：排除「出口只拦 1.3」的可能。
     *  - 去 SNI 变体：若拦截按明文 SNI 命中，去掉 SNI 可能 fail-open 放行。
     * 任一变体能握手 = 廉价代码修复（发送时强制该参数即可，纯云端零额外主机）；
     * 两者都仍 RST = 坐实按目的 IP 拦，只能换出口（中继/代理）。
     */
    const tlsHandshake = (target, opts = {}) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ target, ...v, ms: Date.now() - t0 }); } };
      try {
        const sock = tls.connect(443, target, Object.assign(
          { servername: target, rejectUnauthorized: false, family: 4 },
          opts
        ), () => {
          const proto = sock.getProtocol();
          sock.destroy();
          done({ ok: true, proto });
        });
        sock.on('error', (e) => done({ ok: false, error: e.message, code: e.code || '' }));
        sock.setTimeout(8000, () => { sock.destroy(); done({ ok: false, error: 'Timeout' }); });
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    });

    // IPv6 变体：强制解析 AAAA 并连，判断云端 IPv6 出口是否不被拦（只拦了 IPv4 的 36.133.1.9）
    const ipv6Probe = (target) => new Promise((resolve) => {
      const dnsMod = require('dns');
      const t0 = Date.now();
      dnsMod.resolve6(target, (err, addrs) => {
        if (err || !addrs || !addrs.length) {
          resolve({ target, ok: false, error: 'no AAAA ' + (err ? err.code : ''), ms: Date.now() - t0 });
          return;
        }
        const ip = addrs[0];
        const sock = tls.connect(443, ip, { servername: target, rejectUnauthorized: false }, () => {
          const proto = sock.getProtocol();
          sock.destroy();
          resolve({ target: target + '[' + ip + ']', ok: true, proto, ms: Date.now() - t0 });
        });
        sock.on('error', (e) => resolve({ target: target + '[' + ip + ']', ok: false, error: e.message, code: e.code || '', ms: Date.now() - t0 }));
        sock.setTimeout(8000, () => { sock.destroy(); resolve({ target: target + '[' + ip + ']', ok: false, error: 'Timeout', ms: Date.now() - t0 }); });
      });
    });

    const [gwTls12, gwNoSni, gwIpv6] = await Promise.all([
      tlsHandshake(host, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
      tlsHandshake(host, { servername: null }),
      ipv6Probe(host),
    ]);

    // 出网代理环境变量探测：只报「有没有 + 主机:端口」，凭据部分打码
    const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
    const proxyEnv = {};
    for (const k of proxyKeys) {
      const v = process.env[k] || '';
      if (!v) continue;
      proxyEnv[k] = v.includes('@')
        ? v.replace(/\/\/[^@]*@/, '//***@')   // user:pass@host 打码
        : v;
    }

    /*
     * 身份归因探针：区分三种根因
     *  (a) 按来源 IP/ASN 拦   —— 换什么客户端特征都没用，只能换出口
     *  (b) 按明文 SNI 白名单拦 —— SNI 伪装成已放行域名即可绕过（零成本修复）
     *  (c) 按 TLS 指纹 JA3 拦  —— 改 cipher 列表/ALPN 即可绕过（零成本修复）
     * 失败发生在 TLS 握手，网关看不到 HTTP 层的应用身份，
     * 因此「本网站被单独拉黑」在数据上不成立；这组探针用于钉死 a/b/c。
     */
    const sniSpoof = (target, fakeSni) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ target, sni: fakeSni, ...v, ms: Date.now() - t0 }); } };
      try {
        const sock = tls.connect(443, target, {
          servername: fakeSni, rejectUnauthorized: false, family: 4,
        }, () => {
          let cn = '';
          try { const c = sock.getPeerCertificate(); cn = c && c.subject && c.subject.CN || ''; } catch { /* 证书解析非关键 */ }
          const proto = sock.getProtocol();
          sock.destroy();
          done({ ok: true, proto, certCN: cn });
        });
        sock.on('error', (e) => done({ ok: false, error: e.message, code: e.code || '' }));
        sock.setTimeout(8000, () => { sock.destroy(); done({ ok: false, error: 'Timeout' }); });
      } catch (e) { done({ ok: false, error: e.message }); }
    });

    // 换 TLS 指纹：cipher 列表收窄 + 显式不同 ALPN，令 ClientHello 与默认 Node 明显不同
    const altStack = (target) => new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve({ target, ...v, ms: Date.now() - t0 }); } };
      try {
        const sock = tls.connect(443, target, {
          servername: target,
          rejectUnauthorized: false,
          family: 4,
          ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
          ALPNProtocols: ['http/1.1'],
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
        }, () => {
          const proto = sock.getProtocol();
          sock.destroy();
          done({ ok: true, proto });
        });
        sock.on('error', (e) => done({ ok: false, error: e.message, code: e.code || '' }));
        sock.setTimeout(8000, () => { sock.destroy(); done({ ok: false, error: 'Timeout' }); });
      } catch (e) { done({ ok: false, error: e.message }); }
    });

    // 云端出口 IP：走 Cloudflare trace 端点（独立于 Worker，不依赖中继配置）
    const exitIp = await (async () => {
      const t0 = Date.now();
      try {
        const rr = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
          signal: AbortSignal.timeout(10000),
        });
        const txt = await rr.text();
        const o = {};
        txt.split('\n').forEach((l) => {
          const i = l.indexOf('=');
          if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
        });
        return { ok: true, status: rr.status, ip: o.ip || null, loc: o.loc || null, colo: o.colo || null, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
    })();

    // 若已配置中继，让 Worker 回显它看到的调用方（可拿到 ASN / 组织）
    const echoWorker = await (async () => {
      const cfg = state.settings.smsGatewayRelay || {};
      if (!cfg.url) return { configured: false };
      const t0 = Date.now();
      try {
        const rr = await fetch(new URL('/__echo', cfg.url), {
          headers: cfg.secret ? { 'X-Relay-Secret': String(cfg.secret) } : {},
          signal: AbortSignal.timeout(12000),
        });
        let parsed = null;
        try { parsed = await rr.json(); } catch { /* 非 JSON 忽略 */ }
        return { configured: true, ok: rr.ok, status: rr.status, ms: Date.now() - t0, result: parsed };
      } catch (e) {
        return { configured: true, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
    })();

    const [gwSniSpoof, gwAltStack] = await Promise.all([
      sniSpoof(host, 'www.baidu.com'),
      altStack(host),
    ]);

    const relayProbe = await probeSmsRelay();
    return sendJSON(res, 200, {
      ok: true,
      apiUrl,
      host,
      dns: dnsOut,
      tokenState: { resultCode: probe.resultCode, resultDesc: probe.resultDesc, hasToken: !!probe.creditToken },
      targets,
      direct,
      tls: { gateway: tlsGw, baidu: tlsBaidu },
      tlsVariants: { tls12: gwTls12, noSni: gwNoSni, ipv6: gwIpv6 },
      identity: { sniSpoof: gwSniSpoof, altStack: gwAltStack, exitIp, echoWorker },
      proxyEnv,
      relayProbe,
    });
  }

  /*
   * 只读检测：扫完码后由前端每几秒问一次，通了自动变绿。
   * 它不生成新链接、不清本地 uuid、不计授权次数 —— 所以可以安全地反复调用。
   * 这条路由存在的唯一理由，是把「用户手动点『我已完成扫码』」这一步去掉。
   */
  if (pathname === '/api/sms/auth-check' && (method === 'GET' || method === 'POST')) {
    if (!needSmsAdmin(req, res, '检测授权状态')) return;
    if (SMS_DRY_RUN) {
      return sendJSON(res, 200, { ok: false, valid: false, error: 'dry-run 环境不会发起真实检测' });
    }
    try {
      // 带 binding 就检测那个号：两个号各自扫码，不能让第二个号的检测落到第一个号上
      const bid = bindingFromReq(url, null);
      const inst = smsCredFor(bid);
      const r = await inst.checkAuth();
      if (r && r.valid) {
        const st = inst.status();
        return sendJSON(res, 200, {
          ok: true, valid: true, bindingId: bid, rebound: !!r.rebound, message: r.message,
          hardExpiresAt: st.hardExpiresAt || 0, state: st.state,
        });
      }
      return sendJSON(res, 200, {
        ok: !!(r && r.ok !== false),
        valid: false,
        bindingId: bid,
        blocked: !!(r && r.blocked),
        stale: !!(r && r.stale),
        appCredMissing: !!(r && r.appCredMissing),
        missing: (r && r.missing) || [],
        message: (r && r.message) || '还没检测到手机端完成验证',
      });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, valid: false, error: '检测失败：' + (e && e.message ? e.message : '未知错误') });
    }
  }

  if (pathname === '/api/sms/auth-link' && method === 'GET') {
    /*
     * 鉴权先于环境判断：以前把 dry-run 提示放在最前面，访客在 dev 下打这个接口
     * 会拿到 200 + 「dry-run 环境」，等于绕过权限确认接口存在与否。
     * 顺序错了不算漏洞（dry-run 不会真发），但会让权限测试永远差一项。
     */
    if (!needSmsAdmin(req, res, '发起重新授权')) return;
    // dev 下绝不发起真实授权：那会消耗验证码配额，且本通道每小时只允许 1 次
    if (SMS_DRY_RUN) {
      return sendJSON(res, 200, {
        ok: false,
        valid: false,
        error: '当前是 dry-run 环境（' + RUNTIME_ENV.env + '），不会发起真实授权。请在线上实例操作，或设 CRONHUB_SMS_REAL=1。',
      });
    }
    /*
     * 全局唯一可能消耗验证码的入口。
     * 配额在这里只是**提示线**：超出会回 warning，但仍然把链接给出去。
     * 真正的硬拦只剩「熔断中」（上游风控 140005）——那是平台的限制，不拦会被封。
     * 内部只调一次 preAuth，失败不重试、不递归。
     */
    // verify=1：用户已扫码，只确认授权是否生效（不占授权配额，也不清本地绑定文件）
    const verify = String(url.searchParams.get('verify') || '') === '1';
    // 指定号码：不带 binding 时落到主号码，与旧行为完全一致
    const bid = bindings.resolveIds(url.searchParams.get('binding'))[0];
    // manual: true —— 页面按钮是用户明确要重扫：放行，只做「在烧验证码」的提醒
    const r = await smsCredFor(bid).requestAuthLink({ manual: true, verify });
    if (r.ok && r.needScan) {
      if (!r.authPageUrl) {
        // 明确说「服务端没给链接」，绝不谎报「凭据仍然有效」——那会把用户引到错误结论
        return sendJSON(res, 200, {
          ok: false,
          valid: false,
          error: '网关要求重新授权，但没有返回授权页链接（通常是网络被拦或服务端风控）。请稍后再试一次。',
          warning: r.warning || '',
          attempt: r.attempt || 0,
          bindingId: bid,
        });
      }
      smsAuthUrlByBinding.set(bid, r.authPageUrl);
      return sendJSON(res, 200, {
        ok: true,
        valid: false,
        bindingId: bid,
        authPageUrl: r.authPageUrl,
        qrUrl: localQrDataUrl(r.authPageUrl),
        message: '请用手机打开授权链接完成验证（或扫码）',
        warning: r.warning || '',
        attempt: r.attempt || 0,
      });
    }
    if (r.ok) return sendJSON(res, 200, { ok: true, valid: true, bindingId: bid, rebound: !!r.rebound, message: r.message, warning: r.warning || '', attempt: r.attempt || 0 });
    /*
     * 应用凭据缺失要单独一个分支，不能和「取链接失败」混在一起：
     * 前者是本地缺数据（可自助修复），后者是网络/网关问题（只能等）。
     * 混在一起用户只会看到一个 200002 的错误码，完全无法行动。
     */
    if (r.appCredMissing) {
      return sendJSON(res, 200, {
        ok: false,
        valid: false,
        appCredMissing: true,
        missing: r.missing || ['code', 'kid', 'strategyId'],
        error: r.message,
        hint: '应用凭据需要写回保险库：POST /api/sms/bootstrap {"app":{"code":"…","kid":"…","strategyId":"…"}}（仅分区为空时可用）',
        warning: r.warning || '',
        attempt: r.attempt || 0,
      });
    }
    // 需授权但没拿到链接时不暴露内部细节，只给可读原因
    return sendJSON(res, 200, { ok: false, valid: false, error: r.message || '取授权链接失败', warning: r.warning || '', attempt: r.attempt || 0 });
  }

  if (pathname === '/api/sms/credential' && method === 'GET') {
    /*
     * 只读仪表盘：不含任何敏感值，但含配额头（今日刷新/发送/授权）、硬过期日、
     * 保险库分区条目数与密钥来源 —— 这些是给攻击者做决策的情报（还剩几次配额、
     * 密钥是否就绪），所以同样只给管理员看。
     */
    if (!needSmsAdmin(req, res, '查看凭据状态')) return;
    /*
     * 号码维度：不带 binding 时给主号码的完整仪表盘（与旧行为一致），
     * 同时始终附带号码清单 —— 前端要靠它画出「两个号各自什么状态」。
     */
    const bid = bindingFromReq(url, null);
    const inst = smsCredFor(bid);
    return sendJSON(res, 200, {
      ok: true,
      bindingId: bid,
      bindings: bindings.list().map((b) => ({
        id: b.id,
        label: b.label,
        state: (b.cred && b.cred.state) || 'ACTIVE',
        primary: b.id === bindings.primaryId(),
      })),
      ...inst.status(),
      // 保险库健康：密钥来源、各分区条目数、轮换记账。全部不含值。
      vault: credentialVault.status(),
      // 环境：dev 时明确告诉调用方「这条短信根本没发出去」
      runtime: { env: RUNTIME_ENV.env, reason: RUNTIME_ENV.reason, dryRun: SMS_DRY_RUN, tag: SMS_ENV_TAG },
    });
  }

  if (pathname === '/api/sms/bootstrap' && method === 'POST') {
    /*
     * 凭据引导：把应用凭据（code/kid/strategyId）与长期凭据（uuid/clawUid）
     * 一次性写入保险库。
     *
     * 为什么需要它：这些值原本以明文躺在 lib/sms/*.json 里，按规范必须从仓库清掉；
     * 清掉之后，一个全新的部署没有任何凭据可用，连「生成授权链接」都做不到。
     * 引导入口就是补这个洞 —— 认一次，加密入库，之后再也没有明文文件。
     *
     * 防护：
     *   · 仅管理员会话（不受全局免密开关影响）
     *   · 分区已有内容则永久拒绝（409），不能当作后门反复写入
     *   · 写入后走 completeRebind，按全新生命周期计算硬过期日
     */
    if (!needSmsAdmin(req, res, '凭据引导')) return;
    const appSc = credentialVault.scope(SCOPE.APP);
    if (!appSc.available()) return sendJSON(res, 503, { ok: false, error: '凭据保险库不可用，无法引导' });
    if (appSc.keys().length > 0) {
      return sendJSON(res, 409, { ok: false, error: '保险库已有应用凭据，引导入口已关闭（要更换请走吊销 + 重新授权）' });
    }
    const body = await readBody(req);
    const app = (body && body.app) || {};
    const lng = (body && body.longterm) || {};
    let wrote = 0;
    for (const k of ['code', 'kid', 'strategyId']) {
      if (app[k]) { appSc.set(k, String(app[k])); wrote += 1; }
    }
    const lngSc = credentialVault.scope(SCOPE.LONGTERM);
    const bid = bindingFromReq(url, body);
    for (const k of ['uuid', 'clawUid', 'accessToken']) {
      // 长期凭据按号码分区：写错分区就等于把 A 号的授权挂到 B 号名下
      if (lng[k]) { bindings.vaultSet(bid, k, String(lng[k])); wrote += 1; }
    }
    if (!wrote) return sendJSON(res, 400, { ok: false, error: '没有可写入的凭据字段' });
    /*
     * 只有真的写进了长期凭据（uuid / clawUid / accessToken）才算「完成一次绑定」。
     * 只补应用凭据（code / kid / strategyId）时不能置 ACTIVE —— 那会谎报「一切正常」，
     * 实际下一次 preAuth 照样返回 103001，用户看到的就是「状态正常但发不出去」。
     */
    const wroteLong = ['uuid', 'clawUid', 'accessToken'].some((k) => lng[k]);
    const rb = wroteLong ? smsCredFor(bid).completeRebind({ via: 'bootstrap' }) : null;
    smsAudit.append({ event: 'credential_bootstrap', entries_written: wrote, long_term: wroteLong });
    pushSysLog({
      level: 'info',
      source: 'sms',
      msg: wroteLong
        ? `凭据引导完成：写入 ${wrote} 项，按全新绑定重置生命周期`
        : `应用凭据已写入 ${wrote} 项；长期凭据仍为空，需扫码授权后才会置为正常`,
    });
    return sendJSON(res, 200, {
      ok: true,
      wrote,
      longTermWritten: wroteLong,
      hardExpiresAt: rb ? rb.hardExpiresAt : 0,
      message: wroteLong
        ? `已写入 ${wrote} 项凭据（明文从未落盘，直接加密入保险库）`
        : `已写入 ${wrote} 项应用凭据。现在可以发起扫码授权了，扫码完成后状态才会变为正常。`,
    });
  }

  if (pathname === '/api/sms/vault/health' && method === 'GET') {
    /*
     * fail-safe 探针。这个端点要能被监控直接打（不需要口令），所以访客只能拿到
     * 「行 / 不行 + 一句话原因」；分区条目数、密钥来源、文件路径提示属于内部情报，
     * 只在管理员请求时附带。
     */
    const h = credentialVault.health();
    const detail = canManageSms(req);
    const body = { ok: h.ok, state: h.state, message: h.message };
    if (detail) body.vault = credentialVault.status();
    return sendJSON(res, h.ok ? 200 : 503, body);
  }

  if (pathname === '/api/sms/audit' && method === 'GET') {
    if (!needSmsAdmin(req, res, '查看审计日志')) return;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return sendJSON(res, 200, {
      ok: true,
      entries: smsAudit.tail(limit),
      stats: smsAudit.stats(),
      chain: smsAudit.verify(),
    });
  }

  if (pathname === '/api/sms/revoke' && method === 'POST') {
    /*
     * 泄露应急入口：只做「吊销 + 熔断」，不做任何网络请求、不尝试重新授权。
     * 这是唯一允许把状态推到 REVOKED 的接口，且推过去之后不能靠按钮撤回。
     *
     * ⚠️ 只吊销「用户身份」凭据（longterm / shortterm），保留 APP 分区。
     *    平台分配的应用凭据（code / kid / strategyId）与「谁授权了手机号」无关，
     *    抹掉它会让后续所有 preAuth 返回 200002 clientId不能为空，通道永久失联。
     *    确实要连应用凭据一起清（确认 code/kid 泄露）时显式传 includeApp。
     */
    if (!needSmsAdmin(req, res, '吊销凭据')) return;
    const body = await readBody(req).catch(() => ({}));
    const includeApp = !!(body && body.includeApp);
    /*
     * 号码维度吊销：带 binding 只吊销那个号（另一个号照常可用），
     * 不带则全量吊销 —— 泄露应急时要的是「一次性全停」，不能让用户挑着来。
     */
    const rawBid = (body && body.binding) || (() => {
      try { return url.searchParams.get('binding') || ''; } catch { return ''; }
    })();
    let r;
    let vr = { keptApp: true };
    if (rawBid && bindings.get(String(rawBid))) {
      const bid = String(rawBid);
      r = smsCredFor(bid).revoke('admin_manual');
      for (const k of ['uuid', 'accessToken', 'creditToken']) {
        try { bindings.vaultDel(bid, k); } catch { /* 本就没有 */ }
      }
      smsAudit.append({ event: 'credential_revoke_requested', by: 'admin', result: 'ok', binding_id: bid, include_app: false });
      pushSysLog({ level: 'warn', source: 'sms', msg: `管理员已吊销号码 ${bid} 的短信凭据：仅该号码停止发送，其它号码不受影响` });
      return sendJSON(res, 200, {
        ok: true, ...r, bindingId: bid, keptApp: true,
        message: '该号码的凭据已吊销，重新扫码即可恢复；其它号码不受影响。',
      });
    }
    for (const b of bindings.list()) {
      try { smsCredFor(b.id).revoke('admin_manual'); } catch { /* 单实例失败不阻断全量吊销 */ }
    }
    r = { ok: true, scope: 'all' };
    vr = credentialVault.revokeAll('admin_manual', { includeApp });
    for (const b of bindings.list()) {
      try { shortTermScope.remove(bindings.keyOf(b.id, 'creditToken')); } catch { /* 本就没有 */ }
    }
    smsAudit.append({ event: 'credential_revoke_requested', by: 'admin', result: 'ok', include_app: includeApp });
    pushSysLog({
      level: 'warn',
      source: 'sms',
      msg: '管理员已吊销短信凭据：本地缓存清空、状态置 REVOKED、不再发出任何请求'
        + (vr.keptApp ? '（保留应用凭据 code/kid/strategyId，重新扫码即可恢复）' : '（含应用凭据，需走引导入口重新写入才能恢复）'),
    });
    return sendJSON(res, 200, {
      ok: true,
      ...r,
      keptApp: !!vr.keptApp,
      message: vr.keptApp
        ? '凭据已吊销。系统不会再发出任何短信请求；应用凭据已保留，重新扫码绑定即可恢复。'
        : '凭据已吊销（含应用凭据）。系统不会再发出任何短信请求；恢复需先通过引导入口写入 code/kid/strategyId，再重新扫码绑定。',
    });
  }

  if (pathname === '/api/sms/credential/dead-letters' && method === 'DELETE') {
    if (!needSmsAdmin(req, res, '清空死信队列')) return;
    // 死信跟着号码走：只清主号码会留一半在别的号上，列表永远「清不干净」
    let cleared = 0;
    for (const b of bindings.list()) {
      try {
        const r = smsCredFor(b.id).clearDeadLetters();
        if (r && typeof r.cleared === 'number') cleared += r.cleared;
      } catch { /* 单号失败不影响其余 */ }
    }
    return sendJSON(res, 200, { ok: true, cleared });
  }

  /*
   * 短信管理面二次认证：用管理口令换一个只对 /api/sms 生效的 30 分钟令牌。
   * 独立 cookie、独立密钥派生、Path 限定到 /api/sms。
   * 失败计数与登录共用 loginFailures，防爆破规则一致。
   */
  if (pathname === '/api/sms/admin-unlock' && method === 'POST') {
    const ip = clientIP(req);
    const locked = loginLockRemain(ip);
    if (locked > 0) {
      return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${locked} 分钟后再试` });
    }
    const body = await readBody(req);
    const password = String(body.password || '');
    if (!password) return sendJSON(res, 400, { ok: false, error: '请输入管理口令' });

    if (!adminPasswordMatch(password)) {
      noteLoginFailure(ip);
      pushAuthLog(req, { ok: false, role: 'sms-admin', ip });
      /*
       * 解锁失败也算凭据相关操作 —— 规范第八节要求「每次凭据相关操作记一行」。
       * 只记事实，不记口令，连长度都不记（长度本身是信息）。
       */
      smsAudit.append({ event: 'sms_admin_unlock', ok: false, reason: 'bad_password', ipTag: ipTagOf(ip) });
      return sendJSON(res, 401, { ok: false, error: '管理口令不正确' });
    }
    loginFailures.delete(ip);
    pushAuthLog(req, { ok: true, role: 'sms-admin', ip });
    pushSysLog({ level: 'info', source: 'sms', msg: '短信管理面已通过二次认证（30 分钟内可执行高危操作）' });
    smsAudit.append({
      event: 'sms_admin_unlock',
      ok: true,
      ttlSec: Math.floor(SMS_ADMIN_TTL_MS / 1000),
      ipTag: ipTagOf(ip),
    });

    const token = issueSmsAdminToken(req);
    const bits = [
      `${SMS_ADMIN_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/api/sms',   // 缩到最小可见范围，其他接口拿不到这个 cookie
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SMS_ADMIN_TTL_MS / 1000)}`,
    ];
    if (isSecureRequest(req)) bits.push('Secure');
    res.setHeader('Set-Cookie', bits.join('; '));
    return sendJSON(res, 200, { ok: true, ttlSec: Math.floor(SMS_ADMIN_TTL_MS / 1000) });
  }

  // 主动上锁：高危操作做完就可以立即收回
  if (pathname === '/api/sms/admin-lock' && method === 'POST') {
    if (isSmsAdmin(req)) {
      // 先落黑名单再清 cookie：顺序反了的话，已经抄走 cookie 的人还能继续用满 30 分钟
      revokeSmsAdminToken(req);
      smsAudit.append({ event: 'sms_admin_lock', ok: true });
    }
    res.setHeader('Set-Cookie', `${SMS_ADMIN_COOKIE}=; Path=/api/sms; HttpOnly; SameSite=Strict; Max-Age=0`);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/sms/recv-state' && method === 'GET') {
    /*
     * 默认（免认证）走 admin 分支，全部字段下发；
     * 只有开了 CRONHUB_SMS_GUARD=1 才会走到下面的裁剪逻辑：
     *
     * 访客只能拿到「通道是不是在收」这一个事实 —— 连 actionUrl 都不能给：
     * 那是免登录的静音/退订令牌，拿到手就能把你的短信提醒关掉。
     * 配额计数、凭据状态、保险库分区、运行环境同理，都属于决策情报，只给管理员。
     */
    const st = smsRecvState();
    const sms = state.settings.sms || {};
    const admin = canManageSms(req);
    const body = {
      ok: true,
      receiving: st.ok,
      stateText: admin ? st.text : (st.ok ? '正常接收' : '已暂停接收'),
      optOut: !!sms.optOut,
      mutedUntil: Number(sms.mutedUntil) || 0,
      ...smsAdminState(req),
    };
    if (admin) {
      Object.assign(body, {
        minLevel: sms.minLevel === 'all' ? 'all' : 'important',
        maxChars: Number(sms.maxChars) || 134,
        actionLink: sms.actionLink === true,
        actionUrl: actionUrl(),
        siteBase: siteBase(),
        credential: smsCredFor(bindingFromReq(url, null)).status(),
        // 前端号码列表从这里拿：各号状态摘要一次性带出，避免再发一轮请求
        bindings: bindings.list().map((b) => ({
          id: b.id, label: b.label,
          state: (b.cred && b.cred.state) || 'NEED_REAUTH',
          primary: b.id === bindings.primaryId(),
        })),
        vault: credentialVault.status(),
        runtime: { env: RUNTIME_ENV.env, reason: RUNTIME_ENV.reason, dryRun: SMS_DRY_RUN, tag: SMS_ENV_TAG },
        // 本机发送通道状态：队列深度 / 最近领取 / 最近回报，随面板刷新一起带出
        agent: false,
      });
    }
    return sendJSON(res, 200, body);
  }

  if (pathname === '/api/gateway-sms/log' && method === 'GET') {
    // 日志里带短信正文片段（可能是验证码），只给管理员
    if (!needSmsAdmin(req, res, '查看短信网关日志')) return;
    return sendJSON(res, 200, { ok: true, entries: gatewaySmsLog.slice().reverse() });
  }

  if (pathname === '/api/sms-relay/log' && method === 'GET') {
    if (!SMS_RELAY_ENABLED) return sendJSON(res, 404, { ok: false, error: '接口不存在' });
    // 中转日志是转发进来的原始短信全文 —— 权限要求与凭据同级
    if (!needSmsAdmin(req, res, '查看短信中转日志')) return;
    if (!Array.isArray(state.smsRelay)) state.smsRelay = [];
    return sendJSON(res, 200, { ok: true, entries: state.smsRelay });
  }

  if (pathname === '/api/sms-relay/log' && method === 'DELETE') {
    if (!SMS_RELAY_ENABLED) return sendJSON(res, 404, { ok: false, error: '接口不存在' });
    if (!needSmsAdmin(req, res, '清空短信中转日志')) return;
    state.smsRelay = [];
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/cron-preview' && method === 'GET') {
    // cron 未来 3 次执行时间预览（任务编辑器防抖调用）
    const expr = String(url.searchParams.get('cron') || '').trim();
    try {
      const times = [];
      let cursor = new Date();
      for (let i = 0; i < 3; i++) {
        const next = computeNextRun({ schedule: { mode: 'cron', cron: expr, everyMinutes: 60 } }, cursor);
        if (!next) break;
        times.push(next.toISOString());
        cursor = new Date(next.getTime() + 60000);
      }
      return sendJSON(res, 200, { ok: true, times });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/gateway-sms/test' && method === 'POST') {
    // 自测：本机回环走一遍完整网关链路（鉴权 → 提取内容 → 发送），会真的发一条短信
    if (!needSmsAdmin(req, res, '短信网关自测')) return;
    const g = state.settings.gatewaySms || {};
    if (!g.enabled || !g.token) return sendJSON(res, 400, { ok: false, error: '请先启用短信网关并保存' });
    const port = PORT;
    try {
      const { status, json } = await fetchJSON(`http://127.0.0.1:${port}/gateway/sms/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'CronHub 短信网关自测：链路正常 ✅' }),
        timeoutMs: 45000,
      });
      return sendJSON(res, 200, {
        ok: status === 200 && json && json.ok,
        message: (json && json.message) || `网关返回 ${status}`,
        authPageUrl: (json && (json.authPageUrl || json.authUrl)) || null,
      });
    } catch (e) {
      return sendJSON(res, 200, { ok: false, message: '自测失败：' + e.message });
    }
  }

  if (pathname === '/api/settings/test-notify' && method === 'POST') {
    const body = await readBody(req);
    const channel = body.channel;
    // 短信测试会真的占用一次发送配额（间隔 ≥60 秒 + 每日上限），单独设权限
    if (channel === 'sms' && !needSmsAdmin(req, res, '发送短信测试')) return;
    try {
      if (channel === 'webhook') {
        const r = await sendWebhook(state.settings.webhook, { title: 'CronHub 测试消息', body: '如果你收到这条，说明 Webhook 配置正确。' });
        return sendJSON(res, 200, { ok: true, message: r.message });
      }
      if (channel === 'email') {
        const r = await sendMail(state.settings.smtp, { subject: 'CronHub 测试邮件', text: '如果你收到这封邮件，说明 SMTP 配置正确。' });
        return sendJSON(res, 200, { ok: true, message: r.message });
      }
      if (channel === 'notifyme') {
        // 允许带着页面上的临时凭据先试，不要求先保存；
        // 空值/掩码串直接丢掉，回退到已存配置，避免拿掩码值去打 FCM。
        const rawOverride = body.notifyme && typeof body.notifyme === 'object' ? { ...body.notifyme } : null;
        let override = null;
        if (rawOverride) {
          override = {};
          for (const k of ['mode', 'group', 'urgent']) if (k in rawOverride) override[k] = rawOverride[k];
          for (const k of ['uuid', 'token']) {
            const v = String(rawOverride[k] || '').trim();
            if (v && !isMaskedValue(v)) override[k] = v;
          }
        }
        const cfg = { ...DEFAULT_SETTINGS.notifyme, ...state.settings.notifyme, enabled: true, ...(override || {}) };
        const r = await sendNotifyMe(cfg, {
          title: 'CronHub 测试推送',
          body: '收到这条说明通道已打通，之后任务结果会推到这里。',
          markdown: '## 通道自检\n\n- 来源：**CronHub 定时任务控制台**\n- 模式：`' + (cfg.mode === 'uuid' ? 'uuid' : 'token') + '`\n- 时间：' + new Date().toLocaleString('zh-CN'),
        });
        return sendJSON(res, 200, { ok: true, message: r.message });
      }
      if (channel === 'sms') {
        // 自检是当面点按钮，忽略退订 / 静音（否则用户以为通道坏了）。
        // noLink：自检只验证通道，不带操作链接——链接会命中平台「可疑链接」高危风控（第 45 轮实测）。
        // 只测主号码：通道自检验证的是「通道本身通不通」，不是逐号群发；
        // 多号逐个 manual 发会叠加等待（每号最多约 43s），把请求拖过前端窗口。
        const r = await sendSms({ ...state.settings.sms, enabled: true, optOut: false, mutedUntil: 0 }, {
          title: 'CronHub 通道自检',
          body: '收到这条说明短信通知已打通，之后任务结果可推送到这里。',
          noLink: true,
        }, { manual: true, binding: bindings.primaryId() });
        if (r.ok) return sendJSON(res, 200, { ok: true, message: r.message });
        // 失败原因落系统日志：访问日志只有状态码，光看 502 查不出为什么
        pushSysLog({ level: 'warn', source: 'sms', msg: `通道自检失败（${bindings.primaryId()}）：${String(r.message || '未知原因').slice(0, 160)}` });
        return sendJSON(res, 502, { ok: false, error: r.message, authPageUrl: r.authUrl || null });
      }
      return sendJSON(res, 400, { ok: false, error: '未知通道' });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  return sendJSON(res, 404, { ok: false, error: '接口不存在' });
}

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml']);

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>页面不存在</p>');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');

    // index.html：动态注入资源版本号；用 ASSET_VER 作 ETag —— 内容没变时 304 空响应，省整页流量
    if (ext === '.html') {
      if (req.headers['if-none-match'] === ASSET_VER) {
        res.writeHead(304, { ETag: ASSET_VER });
        res.end();
        return;
      }
      let base = INDEX_HTML;
      if (!base || !base.includes('</html>')) {
        try { base = fs.readFileSync(file, 'utf8'); } catch { }
      }
      if (!base || !base.includes('</html>')) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html 不可用，请检查部署产物');
        return;
      }
      const html = base
        .replace('<link rel="stylesheet" href="/style.css">', () => (INLINE_CSS
          ? `<style>\n${INLINE_CSS}\n</style>`
          : '<link rel="stylesheet" href="/style.css">'))
        .replace('</head>', () => `<link rel="preload" as="script" href="/app.js?v=${ASSET_VER}"></head>`)
        .replace('href="/style.css"', `href="/style.css?v=${ASSET_VER}"`)
        .replace('src="/app.js"', `src="/app.js?v=${ASSET_VER}"`);
      sendMaybeGzip(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: ASSET_VER, Vary: 'Accept-Encoding' }, Buffer.from(html), true);
      return;
    }

    /*
     * 缓存策略：带 ?v= 的资源长缓存 immutable（版本随内容变，URL 一起变）；
     * 不带 ?v= 的维持 no-cache —— 兼容直接访问裸路径的场景，不会读到旧版。
     */
    const versioned = url.searchParams.has('v');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
    };
    // /app.js 有压缩版时直接回内存里的产物（预 gzip，零等待）
    if (APP_MIN_BUF && file === path.join(PUBLIC_DIR, 'app.js')) {
      const out = acceptsGzip ? APP_MIN_GZ : APP_MIN_BUF;
      res.writeHead(200, {
        ...headers,
        ...(acceptsGzip ? { 'Content-Encoding': 'gzip' } : {}),
        'Content-Length': out.length,
      });
      res.end(out);
      return;
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(500).end('read error'); return; }
      if (COMPRESSIBLE.has(ext) && acceptsGzip && buf.length > 1024) {
        zlib.gzip(buf, (e2, gz) => {
          if (e2) { headers['Content-Length'] = buf.length; res.writeHead(200, headers); res.end(buf); return; }
          res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
          res.end(gz);
        });
      } else {
        headers['Content-Length'] = buf.length;
        res.writeHead(200, headers);
        res.end(buf);
      }
    });
  });
}

/** 小工具：HTML/JSON 响应体按需 gzip。注意 writeHead 必须在压缩结果确定后调用。 */
function sendMaybeGzip(req, res, status, headers, buf, force = false) {
  const accepts = String((req && req.headers && req.headers['accept-encoding']) || '').includes('gzip');
  const plain = () => {
    const h = { ...headers, 'Content-Length': buf.length };
    res.writeHead(status, h);
    res.end(buf);
  };
  if ((force || buf.length > 1024) && accepts) {
    zlib.gzip(buf, (e, gz) => {
      if (e) return plain();
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    });
    return;
  }
  plain();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reqT0 = Date.now();
  // 请求结束时统一落一条访问日志。静态资源平时不记（一次刷新几十条噪声），失败一定记。
  res.on('finish', () => {
    try {
      const pathName = url.pathname;
      const status = res.statusCode || 0;
      const ms = Date.now() - reqT0;
      const isApi = pathName.startsWith('/api/') || pathName.startsWith('/gateway/');
      const isStatic = /\.(js|css|png|jpe?g|gif|svg|ico|webp|woff2?|map|txt)$/i.test(pathName);
      const isPage = pathName === '/' || pathName === '/index.html';
      if (!isApi && !isStatic && !isPage && status < 400) return;
      if (isStatic && status < 400) return;
      // 前端轮询/心跳类接口：成功时不记（否则每几秒刷满日志），失败一律记
      const uaRaw = String(req.headers['user-agent'] || '');
      const isNoise = pathName === '/api/state'
        || pathName === '/api/system-logs'
        || pathName === '/api/sms-relay/log'
        || pathName === '/api/gateway-sms/log'
        || pathName === '/api/keepalive'
        /*
         * 健康检查是最容易被探活打爆的端点：自保活、外部保活、自检任务、托管平台
         * 探针都会打它，成功时一条记录的价值极低，却会把 300 条持久化尾部全占满、
         * 把真正的错误挤掉。所以成功的 GET /api/health 不再入日志（失败照记）。
         */
        || (pathName === '/api/health' && req.method === 'GET')
        || /KeepWarm/i.test(uaRaw);
      if (status < 400 && isNoise) return;
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress) || '';
      const baseMsg = `${req.method} ${maskSecrets(pathName + (url.search || ''))} → ${status}（${ms}ms）`;
      const detail = {
        method: req.method,
        path: pathName,
        query: maskSecrets(url.search || '').slice(0, 200),
        status,
        ms,
        ip,
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        referer: String(req.headers.referer || '').slice(0, 120),
      };
      // 同一个 (method, path, status) 的失败请求在 5 分钟内合并成一条
      const aggKey = status >= 400 ? `${req.method} ${pathName} ${status}` : '';
      const hit = aggregatedAccess(aggKey, (item) => {
        item.msg = `${baseMsg}（5 分钟内重复 ${item.count} 次）`;
        item.detail = detail;
      });
      if (hit) return;
      const item = pushSysLog({
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        source: isApi ? 'api' : 'http',
        msg: baseMsg,
        detail,
      });
      if (aggKey) accessLogAgg.set(aggKey, { at: Date.now(), item });
    } catch { /* 日志失败绝不影响请求 */ }
  });
  try {
    /*
     * 旧版「本机代理通道」已整体下线，但外部仍有一个旧客户端（30 个云 IP、UA=node）
     * 按 21 秒周期 POST /api/sms/agent/claim。返回 410 Gone 而不是让路由兜底给 404，
     * 明确告诉对端「这个端点不会回来了」，再配合访问日志的时间窗聚合降噪。
     */
    if (url.pathname.startsWith('/api/sms/agent/')) {
      return sendJSON(res, 410, { ok: false, error: 'agent 通道已下线，请升级客户端' });
    }
    // 网关带 sharecode 的请求进来时记住它（只在变化时落盘），供探活地址拼接用
    const sc = url.searchParams.get('sharecode');
    if (sc && sc !== state.settings.sharecode) {
      state.settings.sharecode = sc;
      saveState();
      console.log(`[sharecode] 已记录: ${sc}`);
    }
    // 记住站点公网地址：短信里的操作链接要拼绝对地址（内网 / 本机地址直接忽略）
    const hostHdr = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (hostHdr && hostHdr.length < 120 && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(hostHdr)) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (req.socket && req.socket.encrypted ? 'https' : 'http');
      const base = proto + '://' + hostHdr;
      const cur = String(state.settings.siteBase || '');
      const newIsPretty = /.workbuddy.host$/i.test(hostHdr.split(':')[0]);
      const curIsPretty = /.workbuddy.host$/i.test(cur.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]);
      // 锁定好记域名后，网关长地址不再覆盖它（否则链接会来回跳）
      if (base !== cur && (newIsPretty || !curIsPretty)) {
        state.settings.siteBase = base;
        saveState();
      }
    }
    if (url.pathname === '/a' || url.pathname.startsWith('/a/')) {
      handleActionPage(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/gateway/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    // 参数类错误（如非法 cron）走 400 + 可读原因，别让前端只看到笼统的 500
    const status = err && err.httpStatus === 400 ? 400 : 500;
    if (!res.headersSent) sendJSON(res, status, { ok: false, error: err.message || '服务端异常' });
    else res.end();
  }
});

/* ---------------------------------------------------------------- 自保活 */

/**
 * 把「探活地址」清洗成真正能用的 URL。
 * 只保留 origin + 路径 + 合法的 sharecode，其余参数和杂质一律丢弃。
 *
 * 为什么需要它：休眠诊断时发现线上探活地址被粘成了
 *   https://.../api/health?sharecode=ZDRK2MO6CP**%EF%BC%88%E5%89%8D%E5%BE%80...
 * 里面混进了 Markdown 加粗符号和 URL 编码的中文说明，fetch 每次必失败，
 * 于是「自保活」看着开着、实际早就哑了。清洗后这类脏输入直接修好或明确报错。
 */
function normalizeKeepWarmUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const m = text.match(/https?:\/\/[^\s"'<>）)】」，。；]+/i);
  if (!m) return '';
  let u;
  try {
    u = new URL(m[0]);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  const out = new URL(u.origin + u.pathname);
  // sharecode 后面常跟一堆脏字符，只取开头那段合法的字母数字（如 ZDRK2MO6CP）
  const scRaw = String(u.searchParams.get('sharecode') || '').trim();
  const sc = (scRaw.match(/^[A-Za-z0-9]{4,32}/) || [''])[0];
  if (sc) out.searchParams.set('sharecode', sc);
  return out.toString();
}

/** 自保活运行时状态（只存内存，展示用；持久的是 settings.keepWarm） */
const keepWarm = {
  url: '',
  everyMin: 10,
  timer: null,
  lastAt: '',
  lastOk: null,
  lastMsg: '',
  failStreak: 0,
  hits: 0,
  nextAt: '',
};

function keepWarmClearTimer() {
  if (keepWarm.timer) {
    clearTimeout(keepWarm.timer);
    keepWarm.timer = null;
  }
}

/*
 * 保活日志：统一控制台里「谁、在什么时候、探活/唤醒成功没有」。
 * 持久化到 state.keepAliveLog（只留最近 60 条），重启后还能看历史。
 */
const KEEP_LOG_MAX = 60;
function keepLog(kind, ok, message, ms) {
  if (!Array.isArray(state.keepAliveLog)) state.keepAliveLog = [];
  state.keepAliveLog.unshift({
    at: nowISO(),
    kind,
    ok: !!ok,
    message: String(message || '').slice(0, 180),
    ms: Math.max(0, Number(ms) || 0),
  });
  if (state.keepAliveLog.length > KEEP_LOG_MAX) state.keepAliveLog.length = KEEP_LOG_MAX;
  // 保活日志是纯观测数据，走 5 分钟合并落盘，别为每次 ping 重写整份 state
  saveStateLazy();
}

function keepWarmSchedule(delayMs) {
  keepWarmClearTimer();
  keepWarm.nextAt = new Date(Date.now() + delayMs).toISOString();
  keepWarm.timer = setTimeout(keepWarmCycle, delayMs);
}

/** 保活统计写回 state，进程重启后不清零（否则「已探 N 次」永远是 0）。 */
function persistKeepStat() {
  const kw = state.settings.keepWarm;
  if (!kw) return;
  kw.stat = {
    hits: keepWarm.hits,
    lastAt: keepWarm.lastAt,
    lastOk: keepWarm.lastOk,
    lastMsg: keepWarm.lastMsg,
    failStreak: keepWarm.failStreak,
  };
  saveStateLazy();
}

async function pingUrl(u) {
  const r = await fetchNoProxy(u, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'CronHub-KeepWarm/1.0' },
  });
  return r.status;
}

/** 探活一次，返回 {ok, message}；失败只记录，不抛出。kind 用于区分自动/手动。 */
async function keepWarmPing(kind = 'self') {
  if (!keepWarm.url) return { ok: false, message: '未配置探活地址' };
  const t0 = Date.now();
  try {
    const status = await pingUrl(keepWarm.url);
    keepWarm.hits += 1;
    keepWarm.failStreak = 0;
    keepWarm.lastOk = true;
    keepWarm.lastAt = nowISO();
    keepWarm.lastMsg = `HTTP ${status} · ${Date.now() - t0}ms`;
    console.log(`[keepwarm] ${new Date().toLocaleString('zh-CN')} → HTTP ${status}`);
    keepLog(kind, true, keepWarm.lastMsg, Date.now() - t0);
    persistKeepStat();
    return { ok: true, message: keepWarm.lastMsg };
  } catch (e) {
    /*
     * 应用域名偶尔打不通（DNS/网关抖动）时，用「外部唤醒」链接再试一次。
     * 那条走部署平台的网关，和应用域名不是同一条链路，成功一次就够续命。
     */
    const alt = String((state.settings.wake && state.settings.wake.url) || '');
    if (alt && alt !== keepWarm.url) {
      try {
        const status = await pingUrl(alt);
        keepWarm.hits += 1;
        keepWarm.failStreak = 0;
        keepWarm.lastOk = true;
        keepWarm.lastAt = nowISO();
        keepWarm.lastMsg = `主地址失败，改用唤醒链接 HTTP ${status} · ${Date.now() - t0}ms`;
        console.log(`[keepwarm] 主地址失败，唤醒链接仍通（HTTP ${status}）`);
        keepLog(kind, true, keepWarm.lastMsg, Date.now() - t0);
        persistKeepStat();
        return { ok: true, message: keepWarm.lastMsg };
      } catch { /* 两条链路都不通，走下面的失败分支 */ }
    }
    keepWarm.failStreak += 1;
    keepWarm.lastOk = false;
    keepWarm.lastAt = nowISO();
    keepWarm.lastMsg = String((e && e.message) || e).slice(0, 120);
    console.warn(`[keepwarm] 探活失败（第 ${keepWarm.failStreak} 次）：${keepWarm.lastMsg}`);
    keepLog(kind, false, keepWarm.lastMsg, Date.now() - t0);
    persistKeepStat();
    return { ok: false, message: keepWarm.lastMsg };
  }
}

/** 一个保活周期：成功 → 等 next 周期；失败 → 10 秒后快速重试，连败 3 次才退回正常间隔。 */
async function keepWarmCycle() {
  const r = await keepWarmPing();
  keepWarmSchedule(!r.ok && keepWarm.failStreak < 3 ? 10000 : keepWarm.everyMin * 60000);
}

/** 开启持续保活：定期访问自己的公网探活地址，让平台认为实例一直活跃。 */
function keepWarmStart() {
  const cfg = state.settings.keepWarm || {};
  keepWarmClearTimer();
  const url = normalizeKeepWarmUrl(cfg.url);
  keepWarm.url = url;
  if (cfg.url && !url) {
    keepWarm.lastOk = false;
    keepWarm.lastMsg = '探活地址不合法（含说明文字或编码异常），已拒绝启动 —— 请重新复制设置页的地址';
    keepWarm.nextAt = '';
    console.warn('[keepwarm] 地址不合法，未启动：' + String(cfg.url).slice(0, 160));
    keepLog('start', false, '地址不合法，未启动自探活');
    return;
  }
  if (!cfg.enabled || !url) return;
  // 下限放到 1 分钟：托管环境无请求约 3 分钟就回收实例，间隔必须短于它才续得住
  keepWarm.everyMin = Math.min(60, Math.max(1, Number(cfg.intervalMin) || 10));
  // 统计持久化：重启后接着累加，不用从 0 开始
  const st = cfg.stat || {};
  keepWarm.hits = Number(st.hits) || 0;
  keepWarm.lastAt = st.lastAt || '';
  keepWarm.lastOk = typeof st.lastOk === 'boolean' ? st.lastOk : null;
  keepWarm.lastMsg = st.lastMsg || '';
  keepWarm.failStreak = Number(st.failStreak) || 0;
  if (keepWarm.everyMin > 3) {
    pushSysLog({
      level: 'warn',
      source: 'keep',
      msg: `自探活间隔 ${keepWarm.everyMin} 分钟偏长（平台空闲约 3 分钟就回收），两次探活之间仍可能出现空档，建议改成 1–2 分钟`,
      detail: { everyMin: keepWarm.everyMin, suggestion: '1-2 分钟' },
    });
  }
  // 地址被清洗过就写回干净版本，避免同一个脏地址反复触发失败
  if (url !== cfg.url) {
    state.settings.keepWarm.url = url;
    saveState();
    console.log('[keepwarm] 探活地址已自动修正为：' + url);
    keepLog('start', true, '探活地址含脏字符，已自动修正');
  }
  keepWarmSchedule(500);
  console.log(`[keepwarm] 已启动：每 ${keepWarm.everyMin} 分钟访问 ${url}`);
  keepLog('start', true, `自探活启动：每 ${keepWarm.everyMin} 分钟`);
}

function keepWarmStop() {
  const wasRunning = !!keepWarm.timer;
  keepWarmClearTimer();
  keepWarm.nextAt = '';
  if (wasRunning) {
    console.log('[keepwarm] 已停止，实例回到「空闲休眠」模式');
    keepLog('stop', true, '自探活已关闭');
  }
}

/** 唤醒令牌：没有就生成一个（幂等）。外部定时器拿它才能叫醒休眠实例。 */
function ensureWakeToken() {
  const w = state.settings.wake || (state.settings.wake = { token: '' });
  if (!w.token) {
    w.token = 'wk_' + crypto.randomBytes(16).toString('hex');
    saveState();
  }
  return w.token;
}

/** 当前请求对应的公网基地址（平台反向代理会带 x-forwarded-*）。 */
function publicBase(req) {
  const h = (req && req.headers) || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

/** 用当前访问的域名拼一条干净的探活地址（带 sharecode），用户不用手填。 */
function autoKeepAliveUrl(req) {
  const base = publicBase(req);
  if (!base) return '';
  const sc = String(state.settings.sharecode || '').trim();
  return base + '/api/health' + (sc ? `?sharecode=${sc}` : '');
}

/** 保活统一快照：控制台一屏所需的全部数据。 */
function keepAliveSnapshot(req) {
  const kw = state.settings.keepWarm || {};
  const w = state.settings.wake || {};
  const token = ensureWakeToken();
  const base = publicBase(req);
  const sc = String(state.settings.sharecode || '').trim();
  const selfUrl = keepWarm.url || normalizeKeepWarmUrl(kw.url) || autoKeepAliveUrl(req);
  // 后台自探活拿不到 req，这里把最近一次拼出的唤醒链接缓存下来给它做兜底
  const wakeUrl = base ? `${base}/api/wake?token=${token}` + (sc ? `&sharecode=${sc}` : '') : '';
  if (wakeUrl && w.url !== wakeUrl) {
    w.url = wakeUrl;
    saveState();
  }
  return {
    runtime: runtimeSummary(),
    self: {
      enabled: !!kw.enabled,
      url: selfUrl,
      urlValid: !!normalizeKeepWarmUrl(kw.url) || !!autoKeepAliveUrl(req),
      everyMin: keepWarm.everyMin || Math.min(60, Math.max(1, Number(kw.intervalMin) || 10)),
      lastAt: keepWarm.lastAt || (kw.stat && kw.stat.lastAt) || '',
      lastOk: keepWarm.lastOk !== null ? keepWarm.lastOk : (kw.stat ? kw.stat.lastOk : null),
      lastMsg: keepWarm.lastMsg || (kw.stat && kw.stat.lastMsg) || '',
      failStreak: keepWarm.failStreak || (kw.stat && kw.stat.failStreak) || 0,
      hits: keepWarm.hits || (kw.stat && kw.stat.hits) || 0,
      nextAt: keepWarm.nextAt,
    },
    wake: {
      token,
      url: wakeUrl || w.url || '',
      lastAt: w.lastWokeAt || '',
      count: Number(w.count) || 0,
    },
    page: {
      enabled: kw.pageBeat !== false,
      beatSec: Math.min(300, Math.max(10, Number(kw.pageBeatSec) || 30)),
    },
    log: (state.keepAliveLog || []).slice(0, 60),
    uptimeSec: Math.round(process.uptime()),
    port: PORT,
    storageWritable,
    authEnabled: REQUIRE_PASSWORD,
    missedPolicy: state.settings.missedPolicy === 'skip' ? 'skip' : 'run',
  };
}

/* ------------------------------------------------- 连续运行时间统计 */

// 心跳间隔 60 秒；超过 3 分钟没有心跳就算「上一段运行被打断」（休眠/重启）
const RUNTIME_GAP_MS = 3 * 60 * 1000;
const RUNTIME_SEGMENTS_MAX = 10;

/**
 * 打一次运行心跳。
 * 用「当前连续段的起点 curStart」推算连续运行时长，避免累加误差；
 * 发现断档就把上一段归档（累计 + 最长 + 最近若干段明细），再开新段。
 */
function runtimeBeat() {
  const nowMs = Date.now();
  if (!state.runtime || typeof state.runtime !== 'object') state.runtime = {};
  const rt = state.runtime;
  if (!Array.isArray(rt.segments)) rt.segments = [];
  if (!rt.curStart || !rt.lastBeat) {
    rt.curStart = nowISO();
    rt.lastBeat = nowISO();
    rt.totalSec = Number(rt.totalSec) || 0;
    rt.longestSec = Number(rt.longestSec) || 0;
    rt.interruptions = Number(rt.interruptions) || 0;
    return { resumed: false };
  }
  const last = Date.parse(rt.lastBeat) || 0;
  if (last && nowMs - last > RUNTIME_GAP_MS) {
    const segSec = Math.max(0, Math.round((last - Date.parse(rt.curStart)) / 1000));
    rt.totalSec = (Number(rt.totalSec) || 0) + segSec;
    rt.longestSec = Math.max(Number(rt.longestSec) || 0, segSec);
    rt.interruptions = (Number(rt.interruptions) || 0) + 1;
    rt.segments.unshift({ start: rt.curStart, end: rt.lastBeat, sec: segSec });
    rt.segments = rt.segments.slice(0, RUNTIME_SEGMENTS_MAX);
    rt.curStart = nowISO();
    rt.lastBeat = nowISO();
    return { resumed: true, gapSec: Math.round((nowMs - last) / 1000) };
  }
  rt.lastBeat = nowISO();
  return { resumed: false };
}

/** 供接口展示的运行时长摘要。 */
function runtimeSummary() {
  const rt = state.runtime || {};
  const curSec = rt.curStart ? Math.max(0, Math.round((Date.now() - Date.parse(rt.curStart)) / 1000)) : Math.round(process.uptime());
  const longest = Math.max(Number(rt.longestSec) || 0, curSec);
  return {
    curSec,
    longestSec: longest,
    totalSec: (Number(rt.totalSec) || 0) + curSec,
    interruptions: Number(rt.interruptions) || 0,
    curStart: rt.curStart || nowISO(),
    lastBeat: rt.lastBeat || nowISO(),
    // 进程本体的 uptime：和「连续运行」不同，后者跨进程重启累计
    processSec: Math.round(process.uptime()),
    segments: (rt.segments || []).slice(0, 5),
  };
}

/* ---------------------------------------------------------------- 系统信息快照 */

/** 秒 → 人读时长 */
function fmtDur(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  if (v < 60) return v + ' 秒';
  const mn = Math.floor(v / 60);
  if (mn < 60) return v % 60 ? mn + ' 分 ' + (v % 60) + ' 秒' : mn + ' 分钟';
  const h = Math.floor(mn / 60);
  if (h < 24) return mn % 60 ? h + ' 小时 ' + (mn % 60) + ' 分' : h + ' 小时';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}

const BOOT_AT = Date.now();
let lastMemMB = 0;

/** 后台运行数据快照：休眠/运行时长、内存、进程、任务量。系统日志页顶部就用它。 */
function sysInfo() {
  let m = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
  try { m = process.memoryUsage(); } catch { /* 某些运行时拿不到，忽略 */ }
  const rt = runtimeSummary();
  const rssMB = +(m.rss / 1048576).toFixed(1);
  return {
    bootAt: new Date(BOOT_AT).toISOString(),
    bootAtText: new Date(BOOT_AT).toLocaleString('zh-CN', { hour12: false }),
    processSec: Math.round(process.uptime()),
    processText: fmtDur(process.uptime()),
    curSec: rt.curSec,
    curText: fmtDur(rt.curSec),
    totalSec: rt.totalSec,
    totalText: fmtDur(rt.totalSec),
    longestSec: rt.longestSec,
    longestText: fmtDur(rt.longestSec),
    interruptions: rt.interruptions,
    segments: rt.segments,
    mem: {
      rssMB,
      heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
      heapTotalMB: +(m.heapTotal / 1048576).toFixed(1),
      externalMB: +(m.external / 1048576).toFixed(1),
    },
    node: process.version,
    platform: process.platform + '/' + process.arch,
    pid: process.pid,
    port: PORT,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tasks: state.tasks.length,
    tasksEnabled: state.tasks.filter((t) => t.enabled).length,
    runLogs: (state.logs || []).length,
    sysLogs: sysLogBuffer().length,
  };
}


/* ---------------------------------------------------------------- 启动 */

process.on('uncaughtException', (err) => {
  pushSysLog({
    level: 'error',
    source: 'system',
    msg: '未捕获异常：' + (err && err.message ? err.message : String(err)),
    detail: { stack: String((err && err.stack) || '').slice(0, 2000), supervised: SUPERVISED },
  });
  console.error('[uncaughtException]', err);
  // 先把内存里的事实落盘，再决定去留
  try { saveStateSync(); } catch { /* 落盘失败也不能在这里再抛 */ }
  if (SUPERVISED) {
    /*
     * 有守护进程：立即退出。Node 官方明确不建议异常后继续跑 ——
     * 此时事件循环、锁、连接池的状态都不可信，带病运行比重启更难排查。
     * 200ms 是为了让日志先刷出去；watchdog 会马上拉起一个干净进程。
     */
    console.error('[uncaughtException] 处于守护模式，交由 watchdog 重启');
    setTimeout(() => process.exit(1), 200);
  } else {
    /*
     * 没有守护：退出等于站点永久挂掉，而平台是否会自动重启我们无法确认。
     * 选择降级续跑，但把这件事记进健康接口，别让人以为一切正常。
     */
    stateHealth.errors += 1;
    stateHealth.lastError = 'uncaughtException: ' + String((err && err.message) || err).slice(0, 200);
    console.error('[uncaughtException] 无守护进程，降级续跑（不建议长期如此，建议用 npm start 走 watchdog）');
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  pushSysLog({
    level: 'error',
    source: 'system',
    msg: '未处理的 Promise 拒绝：' + msg.slice(0, 300),
    detail: { stack: String((reason && reason.stack) || '').slice(0, 2000) },
  });
  console.error('[unhandledRejection]', reason);
});

loadState();

/*
 * 死信水位体检（第十八批）：启动时也看一眼。
 * 场景是「上一版没记档位就重启了」或者「进程被回收时队列里已经堆着 30 条」——
 * 只在 pushDeadLetter 里检查的话，这批历史死信要等到下一次投递失败才会被看见。
 * 档位持久化，所以同一个水位只会告警一次，重启不会重发。
 */
checkDeadLetterWatermark();

/*
 * 日志保留期清理：启动先扫一次，之后每小时扫一次。
 * 只在真的删了东西时落盘（pruneExpiredLogs 返回条数），空跑不产生写盘。
 */
(function pruneLogsOnBoot() {
  const n = pruneExpiredLogs();
  if (!n) return;
  flushState();
  console.log(`[logs] 启动清理：删除 ${n} 条超过 ${LOG_RETENTION_DAYS} 天的日志`);
})();
setInterval(() => {
  const n = pruneExpiredLogs();
  if (n) {
    flushState();
    console.log(`[logs] 定期清理：删除 ${n} 条超过 ${LOG_RETENTION_DAYS} 天的日志`);
  }
  // 网站 → Cloudflare：每小时主动体检一次中继（纯探针，不发短信、不落盘）
  // 短命实例可能等不到这一小时，所以 /api/wake 里另有一次「唤醒即陪护」
  void guardSmsRelay().catch(() => {});
}, 60 * 60 * 1000);

/*
 * 启动期预热中继连接：把 TCP + TLS 提前握好放进连接池，
 * 这样「设置页点自检 / 唤醒即陪护」这类交互触发的第一次请求不用再等握手
 * （实测首次 1.9s、复用后 0.47s）。延迟 3 秒是不和启动期其它探针抢连接。
 */
setTimeout(() => { void warmRelay('boot').catch(() => {}); }, 3000);

/*
 * 绑定迁移必须在 loadState() 之后：ensure() 要从刚读进来的 state 里找
 * 旧格式 smsCredential 并搬成 b1:*。放在模块顶层会在空 state 上空跑，
 * 真实数据永远等不到迁移（第 43 轮实测踩坑：迁移测试全空、凭据悬空）。
 */
bindings.ensure();

/*
 * 中断恢复：平台回收实例是直接杀进程，跑得好好的任务会被拦腰截断。
 * runTask 会在开始处写 task.runningAt 并立即落盘，正常结束前清掉；
 * 启动时还留着标记，说明「上一次执行没走完」。
 *
 * 这里只提示，不自动补跑 —— 补跑会让「签到已经生效、只是没来得及记」的操作再做一次。
 * 用户看到这条通知后自己去判断要不要补，比程序替他猜要安全。
 */
(function recoverInterruptedRuns() {
  const hit = (state.tasks || []).filter((t) => t && t.runningAt);
  if (!hit.length) return;
  for (const t of hit) {
    const raw = t.runningAt;
    const at = Date.parse(raw);
    const when = Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN') : String(raw);
    t.runningAt = null;
    pushSysLog({
      level: 'warn',
      source: 'scheduler',
      msg: `「${t.name}」上次执行在 ${when} 中途中断（进程被回收），未自动补跑`,
      // 以前先置 null 再读 t.runningAt，detail 里只剩本地化字符串，原始 ISO 时间戳丢失，
      // 事后无法和其它日志精确比对。
      detail: { taskId: t.id, taskName: t.name, runningAt: raw },
    });
    pushNotification({
      level: 'warn',
      title: '⚠ 执行中断：' + t.name,
      body: `上一次执行从 ${when} 开始，还没跑完进程就被回收了（云端实例休眠）。\n为免重复副作用，本次没有自动补跑；需要的话点「立即执行」手动补一次。下次计划：${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '未排期'}`,
      source: 'scheduler',
    });
  }
  saveState();
  console.log(`[scheduler] 发现 ${hit.length} 个上次中断的任务：${hit.map((t) => t.name).join('、')}`);
})();

/*
 * 启动补跑（第十六批之二）。
 *
 * recoverInterruptedRuns 只负责把「执行到一半被回收」的痕迹收干净，它不补跑；
 * 真正「错过的那些时刻」由这里处理。放在 listen 之前同步算完是必须的：
 * 只要第一轮 tick 先跑，就会把这些 nextRun 在过去的任务当到期任务直接执行，
 * 补跑的所有约束（窗口 / 去重 / 限速）就都没机会生效了。
 */
const bootCatchupPlan = planCatchupOnBoot();
if (bootCatchupPlan.missed) {
  console.log(`[scheduler] 补跑规划：错过 ${bootCatchupPlan.missed} 个，计划补跑 ${bootCatchupPlan.planned} 个`
    + (catchupRuntime.skipped ? `，跳过 ${catchupRuntime.skipped} 个` : ''));
}

/*
 * 主密码强制锁定：每次启动都用 FORCED_PASSWORD 重算哈希。
 * 这样即使有人改了 state.json 或走了改密接口，重启后依然回到固定密码。
 */
(function enforceForcedPassword() {
  // 访问控制关闭时不需要主密码，只保证有一个可签发 admin token 的密钥
  if (!REQUIRE_PASSWORD) {
    if (!state.auth || !state.auth.secret) {
      state.auth = {
        salt: '', hash: '',
        secret: crypto.randomBytes(32).toString('hex'),
        createdAt: (state.auth && state.auth.createdAt) || nowISO(),
      };
      console.log('[auth] 访问控制已关闭，进入即可见（管理入口仍受 admin 密码保护）');
    } else {
      console.log('[auth] 访问控制已关闭，进入即可见（管理入口仍受 admin 密码保护）');
    }
    return;
  }
  if (!state.auth) {
    const { salt, hash } = hashPassword(FORCED_PASSWORD);
    state.auth = { salt, hash, secret: crypto.randomBytes(32).toString('hex'), createdAt: nowISO() };
    console.log('[auth] 访问控制已开启，主密码初始化为服务端固定值');
    return;
  }
  if (!verifyPassword(FORCED_PASSWORD, state.auth)) {
    const { salt, hash } = hashPassword(FORCED_PASSWORD);
    state.auth = { ...state.auth, salt, hash, secret: crypto.randomBytes(32).toString('hex'), updatedAt: nowISO() };
    console.log('[auth] 主密码与固定值不一致，已强制重置');
  }
})();
if (!Array.isArray(state.authLog)) state.authLog = [];
// 自检任务的目标地址依赖端口；换了端口（比如部署到线上）要跟着修正，否则必然连不上
for (const t of state.tasks) {
  if (t.type === 'http' && t.config && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/health$/.test(t.config.url || '')) {
    const fixed = `http://127.0.0.1:${PORT}/api/health`;
    if (t.config.url !== fixed) {
      console.log(`[task] 修正自检任务地址: ${t.config.url} → ${fixed}`);
      t.config.url = fixed;
    }
  }
}
// 启动时重算：错过太久的任务直接跳到下一次，避免补跑堆积
for (const t of state.tasks) {
  if (!t.enabled) {
    t.nextRun = null;
    continue;
  }
  const prev = t.nextRun ? new Date(t.nextRun).getTime() : 0;
  if (!prev || prev < Date.now() - 24 * 3600 * 1000) {
    t.nextRun = computeNextRun(t, new Date())?.toISOString() || null;
  }
}
// 连续运行统计：开机先打一次心跳。若距上次心跳超过 3 分钟，
// 说明上一段运行被打断（休眠或重启），自动归档并开新段。
// 必须先读上次心跳再调 runtimeBeat —— 它会顺手把 lastBeat 刷成现在
const prevStopAt = (state.runtime && state.runtime.lastBeat) || null;
const bootBeat = runtimeBeat();
const offlineSec = prevStopAt ? Math.max(0, Math.round((BOOT_AT - Date.parse(prevStopAt)) / 1000)) : 0;
saveStateSync();
if (bootBeat.resumed) {
  const rt = state.runtime;
  console.log(`[runtime] 上一段连续运行 ${Math.round((rt.segments[0] || {}).sec / 60)} 分钟后中断（空档 ${Math.round(bootBeat.gapSec / 60)} 分钟），已累计`);
}

// 启动 / 中断（休眠、关机、崩溃）都记成系统事件
(function logBoot() {
  const info = sysInfo();
  pushSysLog({
    level: 'info',
    source: 'boot',
    msg: `服务启动 · 端口 ${PORT} · Node ${process.version} · ${info.tz}`
      + (offlineSec > 0 ? ` · 距上次运行 ${fmtDur(offlineSec)}` : ''),
    detail: { ...info, prevStopAt, offlineSec },
  });
  if (bootBeat.resumed) {
    const seg = (state.runtime.segments || [])[0] || {};
    pushSysLog({
      level: 'warn',
      source: 'sleep',
      msg: `检测到中断：上次连续运行 ${fmtDur(seg.sec)}，空档 ${fmtDur(bootBeat.gapSec)}（${prevStopAt ? new Date(prevStopAt).toLocaleString('zh-CN', { hour12: false }) : '—'} 之后无心跳）`,
      detail: { gapSec: bootBeat.gapSec, lastBeat: prevStopAt, prevSegment: seg, interruptions: state.runtime.interruptions },
    });
    // 空档超过半小时才提醒，偶尔重启不打扰
    if (bootBeat.gapSec >= 30 * 60) {
      const kw = state.settings.keepWarm || {};
      pushNotification({
        level: 'warn',
        title: `实例休眠了 ${fmtDur(bootBeat.gapSec)}`,
        body: `${prevStopAt ? new Date(prevStopAt).toLocaleString('zh-CN', { hour12: false }) : '上次'} 之后实例被托管环境回收，直到刚才有访问才恢复。`
          + `错过的定时任务已按「${state.settings.missedPolicy === 'skip' ? '跳过' : '补跑'}」策略处理。`
          + `想让实例常驻：在「设置 — 保活」里把自探活间隔调到 1–2 分钟`
          + (kw.intervalMin > 3 ? `（现在是 ${kw.intervalMin} 分钟，偏长）` : '')
          + `，或配一个外部定时器定期访问唤醒链接。`,
        source: 'runtime',
      });
    }
  }
})();

// 句柄留给 gracefulExit()：退出前要先停调度，避免收尾过程中又领走一批任务
const tickTimer = setInterval(tick, 15000);
// 调度看门狗：每 30 秒查一次锁，持锁超过 5 分钟强制释放并告警（第 17 批）
setInterval(tickWatchdog, 30000);
// 每分钟一次运行心跳：既刷新「连续运行」时长，也把 lastBeat 落盘，重启后能判断是否连续
let beatTick = 0;
setInterval(() => {
  const beat = runtimeBeat();
  // 心跳断了（休眠、合盖、进程被挂起）——醒来时补一条系统事件
  if (beat.resumed) {
    const seg = (state.runtime.segments || [])[0] || {};
    pushSysLog({
      level: 'warn',
      source: 'sleep',
      msg: `休眠恢复：空档 ${fmtDur(beat.gapSec)}，中断前已连续运行 ${fmtDur(seg.sec)}`,
      detail: { gapSec: beat.gapSec, resumedAt: nowISO(), prevSegment: seg },
    });
  }
  /*
   * 每 2 分钟落一次心跳就够了：中断判定阈值 RUNTIME_GAP_MS 是 3 分钟，
   * 落盘时间戳最多比真实时间旧 2 分钟，重启时算出的空档仍然落在阈值内，
   * 不会把「快速重启」误判成休眠。这样又把心跳写盘砍掉一半。
   */
  beatTick += 1;
  if (beat.resumed || beatTick % 2 === 0) saveState();
}, 60000);

// 每 30 分钟记一条运行态快照（内存/运行时长/任务量），用来回溯后台有没有异常变化
setInterval(() => {
  let info;
  try { info = sysInfo(); } catch { return; }
  const rss = info.mem.rssMB;
  const jump = lastMemMB ? rss - lastMemMB : 0;
  lastMemMB = rss;
  const high = rss >= 400;
  const spike = jump >= 80;
  if (!high && !spike) {
    pushSysLog({
      level: 'info',
      source: 'runtime',
      msg: `运行态 · 已连续运行 ${fmtDur(info.curSec)} · 内存 ${rss} MB · 任务 ${info.tasksEnabled}/${info.tasks} · 日志 ${info.runLogs} 条`,
      detail: info,
    });
    return;
  }
  pushSysLog({
    level: 'warn',
    source: 'runtime',
    msg: `内存偏高 · ${rss} MB（${spike ? '+' + jump.toFixed(1) + ' MB' : '超过 400 MB'}）· 已连续运行 ${fmtDur(info.curSec)}`,
    detail: info,
  });
}, 30 * 60 * 1000);
/*
 * 启动即做一次明文凭据迁移（幂等：已迁过的会跳过）。
 * 放在 listen 与定时器之前，保证第一条出站请求发生时仓库里已经没有明文凭据。
 * 这里用同步调用：内部全是同步 IO，且必须在事件循环开始前完成。
 */
try {
  const mig = migratePlaintextCredentials();
  if (mig && mig.wrote) console.log('[credential] 明文凭据已迁入保险库：' + mig.wrote + ' 项');
} catch (e) {
  console.error('[credential] 迁移失败：' + (e && e.message));
}

// 重启后恢复保活状态（上次保存时若开着，这里自动续上）
keepWarmStart();
setTimeout(tick, 1500);

/* GET /api/state 只读：启动阶段一次性备好唤醒令牌。 */
try { ensureWakeToken(); } catch (e) { console.error('[wake] 令牌初始化失败:', e.message); }

/* 自检结果不能只写 console：系统日志与 /api/health 也要能查到。 */
for (const w of ASSET_STATUS.warnings) {
  console.error('[assets] ' + w);
  try { pushSysLog({ level: 'error', source: 'system', msg: '静态资源自检：' + w }); } catch { }
}
if (DATA_DIR_FALLBACK) {
  console.error('[state] ' + DATA_DIR_FALLBACK);
  try { pushSysLog({ level: 'error', source: 'system', msg: '数据目录降级：' + DATA_DIR_FALLBACK }); } catch { }
}
console.log('  静态资源：版本 ' + ASSET_VER + ' · JS ' + ASSET_STATUS.js
  + ' · CSS ' + ASSET_STATUS.css + ' · HTML ' + ASSET_STATUS.html
  + (ASSET_STATUS.staleBuild ? ' · ⚠ 产物可能过期' : ''));
console.log('  构建标记：' + SMS_BUILD + (DATA_DIR_FALLBACK ? ' · ⚠ 数据目录降级' : ''));

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`\n  CronHub 已启动`);
  console.log(`  监听：${HOST}:${PORT}`);
  console.log(`  控制台：http://127.0.0.1:${PORT}`);
  console.log(`  数据文件：${STATE_FILE}`);
  console.log(`  时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log(`  访问控制：${REQUIRE_PASSWORD ? '已开启（需要密码登录）' : '已关闭（打开链接直接进入）'}`);
  console.log(`  管理入口：URL 加 ?admin 输入管理密码\n`);
  /*
   * 补跑延后十几秒动手：让连接预热、静态资源自检、首轮 tick 先走完。
   * 服务刚起来的头几秒最脆弱，不适合同时承担任务执行。
   */
  if (catchupQueue.length) {
    const t = setTimeout(() => { drainCatchupQueue().catch(() => {}); }, CATCHUP_START_DELAY_MS);
    if (t && t.unref) t.unref();
  }
});

/*
 * 优雅退出：先停调度、再等在途任务收尾（最多 5 秒），最后落盘退出。
 * 原实现直接 saveStateSync + exit(0)，正在发短信的任务会被硬切：
 * runningAt 留在文件里、通知却没发出去，重启后还得靠启动清理收尾。
 */
let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const t0 = Date.now();
  console.log('\n[' + signal + '] 收到退出信号，开始收尾…');
  try { clearInterval(tickTimer); } catch { /* 未启动 */ }
  // 补跑队列直接作废：正在跑的那一个由下面的 grace 等它收尾，排队中的不再开始
  catchupRuntime.stopped = true;
  const droppedByExit = catchupQueue.splice(0).length;
  if (droppedByExit) {
    console.log(`[exit] 补跑队列还有 ${droppedByExit} 个未开始，已放弃（下次启动会重新判定）`);
  }
  const deadline = Date.now() + 5000;
  while (ticking && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let wrote = true;
  try { saveStateSync(); } catch { wrote = false; }
  const still = ticking;
  console.log('[exit] 状态' + (wrote ? '已保存' : '保存失败（数据仅在内存）')
    + '，用时 ' + (Date.now() - t0) + 'ms' + (still ? '，仍有任务在途（已强制退出）' : ''));
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulExit('SIGINT'); });
process.on('SIGTERM', () => { void gracefulExit('SIGTERM'); });
