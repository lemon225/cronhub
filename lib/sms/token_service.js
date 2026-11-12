/**
 * Token获取服务模块 - Node.js 版本
 * 提供getToken方法用于获取业务Token
 *
 * 需要 Node.js ≥ 18（使用原生 fetch / AbortSignal.timeout）。
 * 不依赖任何第三方包，仅使用 Node 内置 crypto / fs / path / os。
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { collect_device_info } = require('./device_info.js');

// Token服务基础URL，需要根据实际部署环境配置
const TOKEN_SERVICE_BASE_URL = "https://idaas.cmpassport.com";
// 接口版本号
const INTERFACE_VERSION = "2.1";
// SDK版本号
const SDK_VERSION = "IDaaS_AUT_KMS_v2.1.1_js";
// 配置下发接口路径
const CONFIG_DELIVERY_PATH = "/keyManage/custody/configDelivery";
// preAuth接口路径
const PRE_AUTH_PATH = "/keyManage/custody/preAuth";

// ★ 内嵌的业务公钥（preAuth 数字信封加密使用）
//   - 发布前由 configDelivery 接口抓取并固化
//   - fetchConfig 不再读取远端下发的 publicKey,杜绝"远端替换公钥 → 伪造加密"攻击链
//   - 服务端轮换 RSA 密钥对时,需要发新版本 SDK 并更新此常量
const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCJp+9qWjK4Z9luY/0musMaRV4x
Jyfsn3EQ1OQqgI+2ZaNsqbl5PZWlrp57WfirfZ4Y/9+xVmC2H4rE08Jo4hXjubCI
h3iJdZuVNtrlgYVZ7tyA8yELsbcaFg31fNRfWlp7tZRE5YKnO7Oe3ag2Tt3lHI9z
BC98i9bSXBD1u0TQrwIDAQAB
-----END PUBLIC KEY-----`;

// 启动期自检:内嵌公钥必须可解析,否则 SDK 带病运行没有意义
try {
  crypto.createPublicKey(EMBEDDED_PUBLIC_KEY_PEM);
} catch (e) {
  throw new Error(`[token_service] 内嵌公钥解析失败，请检查 EMBEDDED_PUBLIC_KEY_PEM: ${e.message}`);
}

// HTTP状态码描述映射
const HTTP_STATUS_DESC = {
  400: "请求错误",
  401: "未授权",
  403: "禁止访问",
  404: "资源未找到",
  500: "服务器内部错误",
  502: "网关错误",
  503: "服务不可用",
  504: "网关超时"
};

/**
 * 配置类，用于管理token服务的可配置项
 */
class Config {
  constructor() {
    this.clawUid_path = null;            // 由 configDelivery 注入
    this.fallback_clawUid_path = null;   // 由 configDelivery 注入
    // ★ 公钥不再从 configDelivery 拉取，直接使用内嵌常量
    this.public_key = EMBEDDED_PUBLIC_KEY_PEM;
    this.auth_info_path = null;          // 调用方可覆盖,改变整个凭据目录
    this.log_enabled = false;
  }

  set(options = {}) {
    // ★ public_key 完全不允许任何途径覆盖
    const allowed = ['clawUid_path', 'auth_info_path', 'log_enabled', 'fallback_clawUid_path'];
    for (const key of Object.keys(options)) {
      if (!allowed.includes(key)) {
        throw new Error(`Config.set 不支持参数 '${key}'（允许：${allowed.join(', ')}）`);
      }
    }
    const { clawUid_path, auth_info_path, log_enabled, fallback_clawUid_path } = options;
    if (clawUid_path !== undefined) this.clawUid_path = clawUid_path;
    if (auth_info_path !== undefined) this.auth_info_path = auth_info_path;
    if (log_enabled !== undefined) this.log_enabled = log_enabled;
    if (fallback_clawUid_path !== undefined) this.fallback_clawUid_path = fallback_clawUid_path;
  }

  get() {
    return {
      clawUid_path: this.clawUid_path,
      fallback_clawUid_path: this.fallback_clawUid_path,
      public_key: this.public_key,
      auth_info_path: this.auth_info_path,
      log_enabled: this.log_enabled
    };
  }
}

// 全局配置实例
const config = new Config();

/**
 * 内部日志函数
 */
function _log(message) {
  if (config.log_enabled) {
    console.log(`[token_service] ${message}`);
  }
}

/**
 * 设置配置项。调用方优先级高于服务端下发；public_key 不允许由调用方设置。
 *
 * @param {Object} options
 * @param {string} [options.clawUid_path]          若已设置，优先于 configDelivery 下发值
 * @param {string} [options.auth_info_path]        若已设置,clawUid.json 也会放到同一目录
 * @param {boolean} [options.log_enabled]          日志开关
 * @param {string} [options.fallback_clawUid_path] 若已设置，优先于 configDelivery 下发值
 */
function setConfig(options = {}) {
  config.set(options);
}

// ======================== 时间戳 / traceId ========================

function _makeTimestamp() {
  /** 17 位时间戳：YYYYMMDDHHMMSS + 毫秒后 3 位（与 Python 端 _make_timestamp 对齐） */
  const now = new Date();
  const dateStr =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  return dateStr + String(now.getMilliseconds()).padStart(3, '0');
}

function _makeTraceId() {
  /** 生成 traceId（UUID4） */
  return crypto.randomUUID();
}

// ======================== 配置下发接口 ========================

async function fetchConfig(traceId = null) {
  /**
   * 拉取路径配置（openClawPath / fallbackClawUidPath）。
   * ★ 与旧版不同：不再从 data.publicKey 读取公钥,统一使用内嵌的 EMBEDDED_PUBLIC_KEY_PEM。
   *   这样彻底关闭"远端下发-替换公钥-伪造加密"的攻击链路。
   *
   * @param {string|null} [traceId] 可选；传入则复用已有 traceId，与 preAuth 串联整个流程。
   * @returns {Promise<{ok:true,openClawPath,fallbackClawUidPath}|{ok:false,resultCode,resultDesc}>}
   */
  const timestamp = _makeTimestamp();
  if (traceId === null || traceId === undefined) {
    traceId = _makeTraceId();
  }
  const interfaceVersion = "2.0";

  // 签名 sha256(traceId + timestamp + interfaceVersion)，输出 base64
  const sign = crypto
    .createHash('sha256')
    .update(traceId + timestamp + interfaceVersion, 'utf-8')
    .digest('base64');

  const headers = {
    interfaceVersion,
    timestamp,
    traceId,
    "Content-Type": "application/json"
  };
  const body = { sign };
  const url = TOKEN_SERVICE_BASE_URL + CONFIG_DELIVERY_PATH;

  _log(`配置下发请求: POST ${url}`);

  let response, responseText;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    responseText = await response.text();
  } catch (e) {
    if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT') {
      return { ok: false, resultCode: "200006", resultDesc: "配置下发接口网络超时" };
    }
    return { ok: false, resultCode: "200005", resultDesc: `配置下发接口网络异常: ${e.message}` };
  }

  _log(`配置下发响应状态码: ${response.status}`);

  if (response.status !== 200) {
    return {
      ok: false,
      resultCode: String(response.status),
      resultDesc: HTTP_STATUS_DESC[response.status] || "配置下发请求失败"
    };
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    return { ok: false, resultCode: "200007", resultDesc: "配置下发响应数据解析异常" };
  }

  const resultCode = String(result.resultCode);
  const data = result.data;

  if (resultCode !== "103000" || !data || typeof data !== 'object') {
    return {
      ok: false,
      resultCode,
      resultDesc: result.desc || "配置下发失败"
    };
  }

  // ★ 修改：不再读取 data.publicKey,只取路径配置
  const openClawPath = data.openClawPath;
  const fallbackPath = data.fallbackClawUidPath;

  if (!openClawPath || !fallbackPath) {
    return {
      ok: false,
      resultCode: "200012",
      resultDesc: "配置下发数据无效，缺少 openClawPath / fallbackClawUidPath"
    };
  }

  // ★ 修改：不再写 config.public_key,公钥永远是内嵌的
  // clawUid_path / fallback_clawUid_path: 调用方 set 过就优先，没 set 才用服务端下发
  if (!config.clawUid_path) {
    config.clawUid_path = _normalizeStoragePath(openClawPath);
  }
  if (!config.fallback_clawUid_path) {
    config.fallback_clawUid_path = _normalizeStoragePath(fallbackPath);
  }

  _log(`配置下发成功: clawUid_path=${openClawPath}, fallback_path=${fallbackPath}`);

  return {
    ok: true,
    openClawPath,
    fallbackClawUidPath: fallbackPath
  };
}

// ======================== 路径 / 公钥 归一化 ========================

function _normalizePublicKeyToPem(publicKeyRaw) {
  /**
   * 把服务端返回的 publicKey 统一为 PEM：
   *   1) 已是 PEM（含 -----BEGIN PUBLIC KEY----- 头）→ 原样返回
   *   2) 裸 base64-DER（SPKI 格式）→ 解码后转 PEM 返回
   *   无法识别则返回 null。
   */
  if (!publicKeyRaw) return null;

  const text = String(publicKeyRaw).trim();
  if (text.includes('BEGIN PUBLIC KEY') || text.includes('BEGIN RSA PUBLIC KEY')) {
    return text;
  }

  try {
    const der = Buffer.from(text, 'base64');
    const keyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return keyObj.export({ type: 'spki', format: 'pem' });
  } catch {
    return null;
  }
}

function _normalizeStoragePath(p) {
  /**
   * 跨平台路径归一化：所有路径都强制挂在用户主目录下。
   *   - Unix 风格 /foo/bar        → ~/foo/bar
   *   - Windows 风格 C:\\foo\\bar → ~/foo/bar
   *   - 相对路径 foo/bar          → ~/foo/bar
   *   - 已以 ~ 开头                → expanduser 后原样
   */
  if (!p) return p;

  const raw = String(p);

  if (raw.startsWith('~')) {
    return path.normalize(os.homedir() + raw.slice(1));
  }

  let stripped = raw;
  if (stripped.startsWith('/')) {
    // Unix 绝对路径
    stripped = stripped.replace(/^\/+/, '');
  } else if (stripped.length >= 2 && stripped[1] === ':') {
    // Windows 盘符路径，如 C:\foo\bar 或 D:/foo/bar
    stripped = stripped.slice(2).replace(/^[\/\\]+/, '');
  }

  // 统一分隔符，并去掉两端多余的分隔符
  stripped = stripped.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  if (!stripped) {
    return os.homedir();
  }

  const normalized = path.normalize(
    path.join(os.homedir(), stripped.split('/').join(path.sep))
  );
  _log(`路径归一化: ${p} → ${normalized}`);
  return normalized;
}

// ======================== 安全写入 ========================

async function _writeSecure(filePath, jsonObj) {
  /** 原子写入 + 强制 0600 权限，避免敏感文件被同用户其他进程读取 */
  const dir = path.dirname(filePath);
  if (dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  await fs.writeFile(tmp, JSON.stringify(jsonObj, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600);
  return true;
}

// ======================== 设备 ID 读取（含兜底） ========================

async function get_openclaw_device_id() {
  /** 从系统文件读取 OpenCLAW 设备 ID（不带兜底） */
  const deviceJsonPath = config.clawUid_path;
  _log(`clawUid路径: ${deviceJsonPath}`);

  if (!deviceJsonPath) {
    return [null, "200009", "设备文件不存在"];
  }

  try {
    await fs.access(deviceJsonPath);
  } catch {
    return [null, "200009", "设备文件不存在"];
  }

  try {
    const data = await fs.readFile(deviceJsonPath, 'utf-8');
    const json = JSON.parse(data);
    const deviceId = json.deviceId ?? null;
    return [deviceId, null, null];
  } catch (e) {
    return [null, "200010", `读取设备文件失败: ${e.message}`];
  }
}

async function _writeDeviceIdToFallback(deviceId) {
  /** 把 deviceId 写入兜底文件，成功返回 true */
  const fallbackPath = config.fallback_clawUid_path;
  if (!fallbackPath) return false;

  try {
    await _writeSecure(fallbackPath, { deviceId });
    _log(`已写入兜底设备文件: ${fallbackPath}`);
    return true;
  } catch (e) {
    _log(`写入兜底设备文件失败: ${e.message}`);
    return false;
  }
}

async function get_openclaw_device_id_with_fallback() {
  /**
   * 读取 OpenCLAW 设备 ID，**优先读兜底文件**（**只首次生成 UUID**）：
   *   1) 兜底文件存在且含 deviceId → 直接返回（优先，不再访问主路径）
   *   2) 兜底文件不存在 或 读取失败 → 尝试主路径
   *   3) 主路径读取成功 → 直接返回
   *   4) 主路径失败 且 兜底路径已配置 → 生成新 UUID 写入兜底文件并返回
   *   5) 主路径失败 且 兜底路径未配置 → 生成新 UUID 仅在内存中使用并返回
   *   6) 兜底写入失败 → 仍返回内存中的新 UUID
   */
  // 1. 兜底文件已存在则优先读取
  if (config.fallback_clawUid_path) {
    try {
      await fs.access(config.fallback_clawUid_path);
      const data = await fs.readFile(config.fallback_clawUid_path, 'utf-8');
      const json = JSON.parse(data);
      const existingId = json.deviceId;
      if (existingId) {
        _log(`兜底文件已存在，优先读取兜底中的 deviceId: ${existingId}`);
        return [existingId, null, null];
      }
    } catch (e) {
      _log(`兜底文件存在但读取失败: ${e.message}，回退到主路径`);
    }
  }

  // 2. 兜底文件不存在/不可读，尝试主路径
  const [deviceId, errorCode, errorDesc] = await get_openclaw_device_id();
  if (deviceId) {
    return [deviceId, null, null];
  }

  _log(`主路径读取设备ID失败(${errorCode}: ${errorDesc})`);

  // 3. 主路径也失败，生成新 ID
  const newId = crypto.randomUUID();
  _log(`生成新 deviceId: ${newId}`);

  if (!config.fallback_clawUid_path) {
    _log("兜底路径未配置，新生成的设备 ID 仅在内存中");
    return [newId, null, null];
  }

  if (await _writeDeviceIdToFallback(newId)) {
    return [newId, null, null];
  }

  // 写入失败，仍返回内存中的新 ID
  _log("兜底文件写入失败，新生成的设备 ID 仅在内存中");
  return [newId, null, null];
}

// ======================== auth_info / clawUid 读写 ========================
//
// 重要：auth_info 和 clawUid 落在同一个 Skill 目录下（__dirname）,
// 但分两个独立文件,避免"会话/设备绑定凭据载体"模式:
//   - auth_info_ydrz.json:仅含 accessToken + uuid(OAuth 刷新材料)
//   - clawUid.json:仅含 clawUid(设备绑定材料,本质是 UUID,不是凭据)
// 每个 Skill 自带 __dirname,天然隔离,无需再用用户主目录二次隔离。

function _credential_dir() {
  /**
   * 凭据文件共享目录。
   *   - 默认 = __dirname(Skill 自带目录)
   *   - 如调用方通过 setConfig({auth_info_path}) 覆盖了 auth_info 路径,
   *     clawUid.json 也跟着放同一目录,两个文件始终在一起
   */
  if (config.auth_info_path) return path.dirname(config.auth_info_path);
  return __dirname;
}

function get_auth_info_path() {
  /** 获取 auth_info 文件路径。与 token_service.js 同目录(每个 Skill 独立)。 */
  const p = path.join(_credential_dir(), 'auth_info_ydrz.json');
  _log(`auth_info路径: ${p}`);
  return p;
}

function get_clawUid_path() {
  /** 获取 clawUid 文件路径。与 auth_info_ydrz.json 共享同一目录。 */
  return path.join(_credential_dir(), 'clawUid.json');
}

async function get_auth_info() {
  /** 从 auth_info_ydrz.json 读取 uuid 和 accessToken(只读 OAuth 字段,不含 clawUid) */
  const auth_info_path = get_auth_info_path();

  try {
    await fs.access(auth_info_path);
  } catch {
    return [null, null];
  }

  try {
    const data = await fs.readFile(auth_info_path, 'utf-8');
    const json = JSON.parse(data);
    return [json.uuid ?? null, json.accessToken ?? null];
  } catch (e) {
    console.error(`读取auth_info失败：${e.message}`);
    return [null, null];
  }
}

async function save_auth_info(access_token = null, auth_uuid = null, clear_uuid = false) {
  /** 保存 OAuth 凭据到 auth_info_ydrz.json(只存 accessToken + uuid,不再混入 clawUid) */
  const auth_info_path = get_auth_info_path();

  try {
    let existing_data = {};
    try {
      const content = await fs.readFile(auth_info_path, 'utf-8');
      existing_data = JSON.parse(content);
    } catch {
      // 文件不存在，使用空对象
    }

    if (access_token !== null) existing_data.accessToken = access_token;
    if (auth_uuid !== null) existing_data.uuid = auth_uuid;
    if (clear_uuid || auth_uuid === "") delete existing_data.uuid;

    await _writeSecure(auth_info_path, existing_data);
    return true;
  } catch (e) {
    console.error(`保存auth信息失败：${e.message}`);
    return false;
  }
}

async function get_clawUid() {
  /** 从 clawUid.json 读取 clawUid(独立文件,不含任何 OAuth 凭据) */
  const clawUidFile = get_clawUid_path();
  try {
    await fs.access(clawUidFile);
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(await fs.readFile(clawUidFile, 'utf-8'));
    return data.clawUid ?? null;
  } catch (e) {
    _log(`读取clawUid失败：${e.message}`);
    return null;
  }
}

async function _clearAuthInfo() {
  /** 删除 auth_info_ydrz.json(用于 clawUid 变更后清掉旧设备的凭据) */
  const authPath = get_auth_info_path();
  try {
    await fs.unlink(authPath);
    _log('已清理过期的 auth_info_ydrz.json');
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      _log(`清理 auth_info 失败: ${e.message}`);
    }
    return false;
  }
}

async function save_clawUid(clawUid, skipIfSameAs = null) {
  /**
   * 保存 clawUid 到 clawUid.json。
   * @param {string|null} clawUid
   * @param {string|null} skipIfSameAs  如果此值与 clawUid 相同则跳过写入(避免重复磁盘 IO)
   */
  if (!clawUid) return false;
  if (skipIfSameAs !== null && skipIfSameAs === clawUid) {
    return true;  // 值未变,跳过
  }
  const clawUidFile = get_clawUid_path();
  try {
    await _writeSecure(clawUidFile, { clawUid });
    _log(`已保存 clawUid 到独立文件: ${clawUidFile}`);
    return true;
  } catch (e) {
    console.error(`保存clawUid失败：${e.message}`);
    return false;
  }
}

// ======================== 凭证清理入口 ========================

/**
 * 主动撤销当前 accessToken：从 auth_info 中删除 accessToken 字段,但保留 uuid 供后续流程使用。
 * 调用方在确认 creditToken 用完、或者检测到异常时调用。
 *
 * 注意:不通过 save_auth_info(null) 调用,因为 save_auth_info 的 null 语义是"不动该字段"。
 * 这里需要显式 delete accessToken 字段。
 *
 * @returns {Promise<boolean>}
 */
async function revokeAccessToken() {
  try {
    const auth_info_path = get_auth_info_path();
    let existing = {};
    try {
      const content = await fs.readFile(auth_info_path, 'utf-8');
      existing = JSON.parse(content);
    } catch {
      // 文件不存在也视为成功(没有可撤销的)
      _log('revokeAccessToken: 本地无凭据,无需撤销');
      return true;
    }
    delete existing.accessToken;
    await _writeSecure(auth_info_path, existing);
    _log('已撤销 accessToken');
    return true;
  } catch (e) {
    console.error(`revokeAccessToken 失败: ${e.message}`);
    return false;
  }
}

/**
 * 一键清理全部本地凭据（auth_info + deviceId binding）。
 * 调用方在用户退出 / 设备解绑 / 卸载场景调用。
 *
 * @returns {Promise<boolean>}
 */
async function clearCredentials() {
  /** 只清理 SDK 自己创建的两个文件:auth_info_ydrz.json + clawUid.json */
  const targets = [
    get_auth_info_path(),
    get_clawUid_path(),
  ].filter(Boolean);

  for (const p of targets) {
    try {
      await fs.unlink(p);
      _log(`已清理本地凭据: ${p}`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        _log(`清理失败 ${p}: ${e.message}`);
      }
    }
  }

  return true;
}
// ======================== 数字信封加密 ========================

function _generateAesKey() {
  /** 16 字节（128 位）随机 AES 密钥（与 Python 端 _generate_aes_key 对齐） */
  return crypto.randomBytes(16);
}

function _aesGcmEncrypt(plaintext, key) {
  /**
   * AES-128-GCM 加密（与 Python 端 _aes_gcm_encrypt 对齐）。
   *   IV = key 前 12 字节（由双方从 key 派生，不放在密文里）
   *   Tag 长度 = 128 位 (16 字节)
   *   返回 ciphertext || tag（不含 IV）
   */
  const iv = key.slice(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]);
}

function _rsaOaepEncrypt(key, publicKeyPem) {
  /** RSA-OAEP-SHA256 加密 AES 密钥（对齐 Java RSA/ECB/OAEPWithSHA-256AndMGF1Padding） */
  return crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      mgfHash: 'sha256'
    },
    key
  );
}

function _envelopeEncrypt(payload, publicKeyPem) {
  /**
   * 数字信封加密：
   *   1) 生成 16 字节随机 AES 密钥
   *   2) 用 AES-128-GCM 加密 payload 的 JSON 序列化结果
   *   3) 用 RSA-OAEP-SHA256 加密 AES 密钥
   *   4) 返回 { reqdata: base64(密文+tag), encrypted: base64(加密后的密钥) }
   */
  const aesKey = _generateAesKey();
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encryptedData = _aesGcmEncrypt(plaintext, aesKey);
  const encryptedKey = _rsaOaepEncrypt(aesKey, publicKeyPem);
  return {
    reqdata: encryptedData.toString('base64'),
    encrypted: encryptedKey.toString('base64')
  };
}

// ======================== 主入口 ========================

/**
 * 获取业务Token
 *
 * @param {Object} params
 * @param {string} params.devId       开发者Id
 * @param {string} params.clientId    业务方平台ID
 * @param {string} params.skillId     技能ID
 * @param {string} params.skillName   技能名称
 * @param {string} [params.clawUid]   claw的唯一标识，不能为空（不传则自动读取）
 * @param {string} [params.templateId] 授权模板ID
 * @param {string} [params.uuid_param] 授权流程标识（传入则优先使用）
 * @returns {Promise<{resultCode:string,resultDesc:string,data:object|null}>}
 */
async function getToken({ devId, clientId, skillId, skillName, clawUid = null, templateId = null, uuid_param = null }) {
  // 1. 加密库可用性检查：Node.js 内置 crypto 总是可用，跳过

  // 2. 参数校验
  if (!devId || typeof devId !== 'string') {
    return { resultCode: "200001", resultDesc: "devId不能为空", data: null };
  }
  if (!clientId || typeof clientId !== 'string') {
    return { resultCode: "200002", resultDesc: "clientId不能为空", data: null };
  }
  if (!skillId || typeof skillId !== 'string') {
    return { resultCode: "200003", resultDesc: "skillId不能为空", data: null };
  }
  if (!skillName || typeof skillName !== 'string') {
    return { resultCode: "200004", resultDesc: "skillName不能为空", data: null };
  }

  // 顶层生成 traceId，贯穿 configDelivery / preAuth 整个流程，便于服务端串联日志
  const traceId = _makeTraceId();

  try {
    // 3. 配置下发（每次都重新拉取，不缓存）
    const cfg = await fetchConfig(traceId);
    if (!cfg.ok) {
      return {
        resultCode: cfg.resultCode || "200011",
        resultDesc: cfg.resultDesc || "配置下发失败",
        data: null
      };
    }

    // 4. 解析 clawUid:优先调用方传入 > clawUid.json 持久化值 > 系统 deviceId
    let actualClawUid = clawUid;
    const persistedClawUid = await get_clawUid();
    if (!actualClawUid) {
      if (persistedClawUid) {
        actualClawUid = persistedClawUid;
      } else {
        const [id, code, desc] = await get_openclaw_device_id_with_fallback();
        if (!id) {
          return { resultCode: code, resultDesc: desc, data: null };
        }
        actualClawUid = id;
      }
    }

    // ★ clawUid 变更检测:若实际值与 clawUid.json 持久化值不一致,
    //   说明设备换了 / 重置了,跳过 auth_info 缓存(不删除文件)。
    //   如果 clawUid 之后又变回原值,缓存仍然能用。
    const clawUidChanged = persistedClawUid && persistedClawUid !== actualClawUid;
    if (clawUidChanged) {
      _log(`检测到 clawUid 变更 (${persistedClawUid} → ${actualClawUid}),跳过 auth_info 缓存(不删除文件)`);
    }
    // ★ 不在这里写 clawUid.json:等 preAuth 成功(103000/103001)再写,
    //   保证 clawUid.json 里的值一定是服务端验证过的

    // 5. 解析 uuid / accessToken:clawUid 变了就跳过缓存(不读 auth_info)
    let auth_uuid, access_token;
    if (uuid_param) {
      auth_uuid = uuid_param;
      access_token = null;
    } else if (clawUidChanged) {
      auth_uuid = null;
      access_token = null;
    } else {
      [auth_uuid, access_token] = await get_auth_info();
    }

    // 6. 生成请求头参数（traceId 已在函数顶部生成，与 configDelivery 共用）
    const timestamp = _makeTimestamp();

    // 7. MD5 签名 sign = MD5(clientId + interfaceVersion + timestamp + traceId + clawUid + skillId + skillName + devId)
    const signStr = clientId + INTERFACE_VERSION + timestamp + traceId + actualClawUid + skillId + skillName + devId;
    const sign = crypto.createHash('md5').update(signStr, 'utf-8').digest('hex');

    // 8. 明文 payload
    const payload = {
      clawUid: actualClawUid,
      skillId: skillId,
      skillName: skillName,
      devId: devId,
      sign: sign
    };
    if (templateId) payload.templateId = templateId;
    if (auth_uuid) payload.uuid = auth_uuid;
    if (access_token) payload.accessToken = access_token;
    // 设备风控参数（macAddress 已移除）
    Object.assign(payload, collect_device_info());

    // 9. 数字信封加密
    let envelope;
    try {
      envelope = _envelopeEncrypt(payload, config.public_key);
    } catch (e) {
      return {
        resultCode: "200013",
        resultDesc: `数字信封加密失败: ${e.message}`,
        data: null
      };
    }

    // 10. 请求头
    const headers = {
      clientId: clientId,
      timestamp: timestamp,
      interfaceVersion: INTERFACE_VERSION,
      sdkVersion: SDK_VERSION,
      traceId: traceId,
      "Content-Type": "application/json"
    };

    // 11. 调用 preAuth
    const url = TOKEN_SERVICE_BASE_URL + PRE_AUTH_PATH;

    _log(`HTTP请求: POST ${url}`);
    _log(`HTTP请求头: ${JSON.stringify(headers)}`);
    _log(`HTTP请求体(reqdata): ${envelope.reqdata}`);
    _log(`HTTP请求体(encrypted): ${envelope.encrypted}`);

    let response, responseText;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10000)
      });
      responseText = await response.text();
    } catch (e) {
      if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT') {
        return { resultCode: "200006", resultDesc: "网络超时", data: null };
      }
      return { resultCode: "200005", resultDesc: `网络异常: ${e.message}`, data: null };
    }

    _log(`HTTP响应状态码: ${response.status}`);
    _log(`HTTP响应体: ${responseText.slice(0, 500)}`);

    if (response.status === 200) {
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        return { resultCode: "200007", resultDesc: "数据解析异常", data: null };
      }

      const resultCode = String(result.resultCode);
      const resultDesc = result.desc || "";
      const dataJson = result.data;

      // 103000: 成功获取token
      if (resultCode === "103000") {
        const serverAccessToken = dataJson?.accessToken ?? null;
        if (serverAccessToken && serverAccessToken !== access_token) {
          await save_auth_info(serverAccessToken, null, true);
        }
        // ★ 服务端验证通过后才写;值未变就跳过
        await save_clawUid(actualClawUid, persistedClawUid);
        return {
          resultCode: "103000",
          resultDesc: resultDesc || "成功",
          data: {
            creditToken: dataJson?.creditToken ?? null,
            expireTime: dataJson?.expireTime ?? null
          }
        };
      }
      // 103001: 需要用户授权
      else if (resultCode === "103001") {
        const authUuidResp = dataJson?.uuid ?? null;
        if (authUuidResp) {
          await save_auth_info("", authUuidResp, false);
        }
        // ★ 服务端认可后才写;值未变就跳过
        await save_clawUid(actualClawUid, persistedClawUid);
        return {
          resultCode: "103001",
          resultDesc: resultDesc || "需要用户授权",
          data: {
            authPageUrl: dataJson?.authPageUrl ?? null,
            uuid: authUuidResp
          }
        };
      }
      // 其他错误码：直接透传服务端返回
      else {
        return {
          resultCode: resultCode,
          resultDesc: resultDesc,
          data: null
        };
      }
    } else {
      const httpCode = String(response.status);
      const httpDesc = HTTP_STATUS_DESC[response.status] || "请求失败";
      return {
        resultCode: httpCode,
        resultDesc: httpDesc,
        data: null
      };
    }

  } catch (e) {
    if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT') {
      return { resultCode: "200006", resultDesc: "网络超时", data: null };
    }
    if (e instanceof SyntaxError) {
      return { resultCode: "200007", resultDesc: "数据解析异常", data: null };
    }
    return { resultCode: "200008", resultDesc: `系统异常: ${e.message}`, data: null };
  }
}

// 导出模块
module.exports = {
  setConfig,
  getToken,
  config,
  // ★ 凭证清理入口
  clearCredentials,
  revokeAccessToken,
  // 内部函数也导出，方便测试
  fetchConfig,
  get_openclaw_device_id,
  get_openclaw_device_id_with_fallback,
  get_auth_info_path,
  get_clawUid_path,
  get_auth_info,
  save_auth_info,
  get_clawUid,                // ★ 新增：读独立 clawUid.json
  save_clawUid,               // ★ 新增：写独立 clawUid.json
  _makeTimestamp,
  _makeTraceId,
  _normalizeStoragePath,
  _normalizePublicKeyToPem,
  _generateAesKey,
  _aesGcmEncrypt,
  _rsaOaepEncrypt,
  _envelopeEncrypt,
};
