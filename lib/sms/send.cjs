#!/usr/bin/env node
/**
 * SMS Notify - 短信通知
 * 给用户本人手机发送任意内容短信通知（场景不限：工作待办、定时提醒、生活琐事等）
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const tls = require('tls');

const fs = require('fs');
const path = require('path');

/*
 * 凭据目录：CronHub 服务端传 CRONHUB_SMS_CFG_DIR，指向一次性临时目录（调用后即销毁）。
 * 默认退到脚本自带目录，单独运行时行为不变。
 */
const SMS_CFG_DIR = String(process.env.CRONHUB_SMS_CFG_DIR || '').trim() || __dirname;

// 读取 config.json 配置
const configPath = path.join(SMS_CFG_DIR, 'config.json');
let config = { apiUrl: '', timeout: 30 };
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    // 使用默认值
}

// Token 获取服务
const { getToken, setConfig } = require('./token_service');
if (SMS_CFG_DIR !== __dirname) {
    setConfig({
        auth_info_path: path.join(SMS_CFG_DIR, 'auth_info_ydrz.json'),
        clawUid_path: path.join(SMS_CFG_DIR, 'clawUid.json'),
        fallback_clawUid_path: path.join(SMS_CFG_DIR, 'clawUid.json'),
    });
}

/*
 * 令牌通过 stdin 传入（--token-stdin）。
 * 绝不放进命令行参数：`ps aux` / 容器进程列表能看到 argv，看不到别的进程的 stdin。
 */
let STDIN_TOKEN = null;
if (process.argv.includes('--token-stdin')) {
    try { STDIN_TOKEN = fs.readFileSync(0, 'utf8').trim() || null; } catch (e) { STDIN_TOKEN = null; }
}

// API 地址列表（优先级从高到低；支持逗号/分号分隔多地址，平台多活时无需改代码）
const API_URLS = [
    process.env.FIVEG_API_URL || process.env.CRONHUB_SMS_API_URLS || config.apiUrl || null
]
    .flatMap((u) => String(u).split(/[,;，；]/))
    .map((u) => u.trim())
    .filter((u) => u !== '');

const RSA_PUBLIC_KEY = process.env.FIVEG_RSA_PUBLIC_KEY || config.key;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/*
 * 发送中继地址（可多条，逗号/分号/空白分隔，按顺序故障转移）。
 * 中继是短信的唯一出口：主地址挂了短信就全静默失败，所以支持「主 + 备」两条，
 * 第一条不可用（连接失败 / 5xx / 超时）立刻换下一条，不等整轮重试。
 */
const RELAY_BASES = String(process.env.CRONHUB_SMS_RELAY_URL || '')
    .split(/[,;\s]+/)
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter((u) => {
        if (!u) return false;
        try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
    });
const RELAY_SECRET = String(process.env.CRONHUB_SMS_RELAY_SECRET || '').trim();

/*
 * 中继连接池：本进程内复用。
 * 一次发送正常只打一次网关，看起来没必要；但「取令牌重试 / 多 API 域名 / 多中继
 * 故障转移」都发生在同一个进程里，第二条请求复用连接能省掉完整的 TCP+TLS 握手
 * （实测跨境首次 1.9s、复用 0.47s）。直连网关（SNI 伪装分支）不用这个池子。
 */
const RELAY_AGENT = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
    maxFreeSockets: 2,
});

/** 传输层失败：值得换一条中继重试（业务失败不换，换也一样被拒） */
function isRelayTransportFailure(result) {
    if (!result) return true;
    const code = result.httpCode || 0;
    if (code === 0) return true;                     // 连接失败 / 超时 / 空响应
    if (code >= 500) return true;                    // 中继自身 502/504
    if (result.code && /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|EPIPE/.test(result.code)) return true;
    return false;
}

/*
 * 记住「上一条真正把请求送到对端的中继」，下一轮重试先走它。
 * 否则每一轮重试都从主地址开始：主地址 DNS 挂了，3 轮就是 3 次 ENOTFOUND，
 * 白白多花几秒，而备用明明一直是好的。
 */
let PREFERRED_RELAY = '';

/** 按「上次可用优先」排出本次尝试的中继顺序 */
function orderedRelays() {
    if (!RELAY_BASES.length) return [''];
    if (!PREFERRED_RELAY || !RELAY_BASES.includes(PREFERRED_RELAY)) return RELAY_BASES.slice();
    return [PREFERRED_RELAY, ...RELAY_BASES.filter((b) => b !== PREFERRED_RELAY)];
}

// ===== 诈骗风险提示 + 长度分析：迁到 lib/sms/content.js（预览与发送共用一份规则）=====
const { evaluateRiskLevel, analyzeSmsLength, DISCLAIMER_LOW, DISCLAIMER_HIGH, RISK_LEVEL_NONE, RISK_LEVEL_LOW, RISK_LEVEL_HIGH } = require('./content.js');


/**
 * 生成随机 AES 密钥（16 字节 = 128 位）
 * 生成 16 个可打印 ASCII 字符，兼容 Java 的 new String(key.getBytes())
 * @returns {string} 16 字符的 AES 密钥
 */
function generateAESKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    const randomBytes = crypto.randomBytes(16);
    for (let i = 0; i < 16; i++) {
        key += chars[randomBytes[i] % chars.length];
    }
    return key;
}

/**
 * 使用 AES-128-ECB 加密数据（与服务端 AES/ECB/PKCS5Padding 对应）
 * @param {string} data - 要加密的字符串
 * @param {string} key - 16 字符的 AES 密钥
 * @returns {string} Base64 编码的加密结果
 */
function encryptWithAES(data, key) {
    const keyBuffer = Buffer.from(key, 'utf8'); // 密钥直接用 UTF-8 字节

    // ECB 模式不需要 IV
    const cipher = crypto.createCipheriv('aes-128-ecb', keyBuffer, null);
    // PKCS5Padding（PKCS7）自动应用
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return encrypted;
}

/**
 * 使用 RSA 加密 AES 密钥
 * @param {string} aesKey - 16 字符的 AES 密钥
 * @param {string} publicKey - RSA 公钥（PEM 格式）
 * @returns {string} Base64 加密后的 AES 密钥
 */
function encryptAESKeyWithRSA(aesKey, publicKey) {
    if (!publicKey) {
        throw new Error('RSA 公钥未配置');
    }

    let pemKey = publicKey;
    if (!publicKey.includes('-----BEGIN')) {
        pemKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    }

    const buffer = Buffer.from(aesKey, 'utf8');
    const publicKeyObj = crypto.createPublicKey(pemKey);
    const encrypted = crypto.publicEncrypt({
        key: publicKeyObj,
        padding: crypto.constants.RSA_PKCS1_PADDING
    }, buffer);
    return encrypted.toString('base64');
}

/**
 * 从 data 中递归找「逐号码结果数组」。
 * 平台不同环境字段名不统一（send2UserList / resultList / 直接就是数组…），
 * 不能写死键名 —— 识别特征：数组元素同时含「号码类」和「结果类」字段。
 * @returns {Array} 命中的数组；找不到返回 []
 */
function extractPerNumber(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 4) return [];
    if (Array.isArray(node)) {
        const first = node.find((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (first) {
            const keys = Object.keys(first).map((k) => k.toLowerCase());
            const hasPhone = keys.some((k) => /phone|mobile|msisdn|number/.test(k));
            const hasResult = keys.some((k) => /resultcode|status/.test(k));
            if (hasPhone && hasResult) return node;
        }
        return [];
    }
    for (const v of Object.values(node)) {
        const hit = extractPerNumber(v, depth + 1);
        if (hit.length) return hit;
    }
    return [];
}

/** 手机号打码：138****1234，避免明文号码出现在日志/回执里 */
function maskPhone(p) {
    const s = String(p || '');
    return /^\d{7,15}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(-4) : (s ? '号码?' : '');
}

/** 单个号码是否算发送成功：103000 / 0 / 描述含 success 都算（平台各环境不统一，防御式） */
function isNumOk(p) {
    const rc = String(p.resultCode || '').toLowerCase();
    const rd = String(p.resultDesc || '').toLowerCase();
    return rc === '103000' || rc === '0' || rc === '00000' || /success|成功/.test(rd);
}

/**
 * 解析服务端响应
 * @param {object} result - 原始响应对象
 * @returns {object} { success: boolean, error: string }
 */
function parseResponse(result) {
    // 情况 1: HTTP 请求本身失败（如网络错误、超时）
    if (result.error) {
        return { success: false, error: result.error };
    }

    // 情况 2: HTTP 状态码非 2xx
    if (result.httpCode !== undefined && result.httpCode !== 200) {
        return { success: false, error: `HTTP ${result.httpCode}: ${result.httpMessage || '请求失败'}` };
    }

    const raw = result.raw || '';

    // 尝试解析 JSON
    let json = null;
    try {
        json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        if (raw) {
            return { success: false, error: `服务器返回：${raw.substring(0, 100)}` };
        }
        return { success: false, error: '空响应或无法解析的响应' };
    }

    // 外层成功：code = 10200。但**不能就此算完** —— data 里还有逐号码结果，
    // 安全控制拒绝（Security control authentication failed）时外层照样 10200，
    // 只判外层会把失败报成成功（官方文档风险 7，2026-10-31 实测踩过）。
    if (json && (json.code === 10200 || json.code === '10200')) {
        const list = extractPerNumber(json.data);
        const perNumber = (list || []).map((x) => {
            const p = {
                phone: maskPhone(x.phone || x.mobile || x.phoneNumber || x.msisdn || x.number),
                resultCode: String(x.resultCode || x.result_code || x.status || ''),
                resultDesc: String(x.resultDesc || x.result_desc || x.message || ''),
                traceId: String(x.traceId || x.trace_id || ''),
            };
            p.ok = isNumOk(p);
            return p;
        }).filter((p) => p.phone);
        if (perNumber.length) {
            const failed = perNumber.filter((p) => !p.ok);
            if (failed.length) {
                return {
                    success: false,
                    terminal: true, // 换 API 域名重试同样被拒，只会多烧一次配额 —— 终态
                    perNumber,
                    error: `部分号码发送失败：${failed.map((p) => `${p.phone} ${p.resultDesc || 'resultCode=' + p.resultCode}`).join('；')}`,
                };
            }
            return { success: true, data: json.data, perNumber };
        }
        // 平台没给逐号码结果（老接口形态）：维持原判定
        return { success: true, data: json.data };
    }

    // 失败：返回 message
    const errorMsg = json?.message || `业务错误码：${json?.code}`;
    return { success: false, error: errorMsg };
}

/**
 * 解析 HTTP 错误并返回友好提示
 */
function parseHttpError(result) {
    const errMsg = (result.error || '').toLowerCase();
    const httpCode = result.httpCode;

    if (errMsg.includes('econnrefused')) {
        return { isSuccess: false, hint: '❌ 连接被拒绝：服务器拒绝连接，可能服务器未运行或端口错误' };
    }
    if (errMsg.includes('etimedout') || errMsg.includes('timeout')) {
        return { isSuccess: false, hint: '❌ 连接超时：服务器响应超时，请稍后重试' };
    }
    if (errMsg.includes('enotfound') || errMsg.includes('getaddrinfo')) {
        return { isSuccess: false, hint: '❌ DNS 错误：无法解析服务器地址，请检查 API 地址是否正确' };
    }
    if (errMsg.includes('ehostunreach') || errMsg.includes('network')) {
        return { isSuccess: false, hint: '❌ 网络错误：网络不可达，请检查网络连接' };
    }
    if (errMsg.includes('certificate') || errMsg.includes('cert')) {
        return { isSuccess: false, hint: '❌ 证书错误：SSL 证书验证失败，请检查系统时间或证书配置' };
    }
    if (errMsg.includes('socket')) {
        return { isSuccess: false, hint: '❌ Socket 错误：网络连接异常，请检查网络后重试' };
    }

    if (httpCode === 400) {
        return { isSuccess: false, hint: '❌ HTTP 400：请求参数错误，请检查手机号格式和内容' };
    }
    if (httpCode === 401) {
        return { isSuccess: false, hint: '❌ HTTP 401：认证失败，请检查 API Key 是否正确' };
    }
    if (httpCode === 403) {
        return { isSuccess: false, hint: '❌ HTTP 403：禁止访问，API Key 可能已失效或无权限' };
    }
    if (httpCode === 404) {
        return { isSuccess: false, hint: '❌ HTTP 404：API 地址不存在，请检查 API 地址是否正确' };
    }
    if (httpCode === 408) {
        return { isSuccess: false, hint: '❌ HTTP 408：请求超时，请稍后重试' };
    }
    if (httpCode === 500) {
        return { isSuccess: false, hint: '❌ HTTP 500：服务器内部错误，请稍后重试' };
    }
    if (httpCode === 502) {
        return { isSuccess: false, hint: '❌ HTTP 502：网关错误，请稍后重试' };
    }
    if (httpCode === 503) {
        return { isSuccess: false, hint: '❌ HTTP 503：服务不可用，请稍后重试' };
    }
    if (httpCode && httpCode >= 400) {
        return { isSuccess: false, hint: `❌ HTTP ${httpCode}：请求失败，请检查 API 配置` };
    }

    if (result.error === 'Empty response' || !result.raw) {
        const c = httpCode || result.httpCode || 0;
        const h = result.respHeaders || {};
        const extra = [h.server && ('server=' + h.server), h.ctype && ('ctype=' + h.ctype)].filter(Boolean).join(' ');
        return { isSuccess: false, hint: `⚠️ 空响应（HTTP ${c}，body 0 字节${extra ? '，' + extra : ''}）：服务器未返回数据，请稍后重试` };
    }

    if (result.raw && result.raw.trim().startsWith('<')) {
        return { isSuccess: false, hint: `⚠️ 返回 HTML 而非 JSON：API 地址可能错误 (HTTP ${httpCode})` };
    }

    if (!result.error && httpCode >= 200 && httpCode < 300) {
        return { isSuccess: true, hint: '✅ 请求成功' };
    }

    return { isSuccess: null, hint: null };
}


/**
 * 发送新消息（纯文本）
 * @param {string} apiUrl - API 地址
 * @param {string} text - 消息文本内容
 * @param {boolean} useHybridEncryption - 是否使用混合加密
 * @returns {Promise<object>}
 */
function sendMessage(apiUrl, text, useHybridEncryption, channel, token, relayBase) {
    return new Promise((resolve) => {
        const url = new URL(apiUrl);
        // 强制要求 HTTPS，明文 HTTP 存在中间人攻击风险
        if (url.protocol !== 'https:') {
            resolve({ httpCode: 0, error: 'API 地址必须使用 HTTPS 协议' });
            return;
        }
        /*
         * 发送中继（可选）：服务端通过环境变量注入，只换主机、不换路径。
         * 云端出口到网关的 TLS 可能被按来源拦截，此时把 POST 转给能直连网关的
         * HTTPS 中继（如 Cloudflare Worker）；未配置时 target 就是原网关，行为不变。
         */
        const relayUse = String(relayBase || '').trim().replace(/\/+$/, '');
        const relaySecret = RELAY_SECRET;
        let target = url;
        if (relayUse) {
            try {
                const t = new URL(url.pathname + url.search, relayUse + '/');
                if (t.protocol === 'https:') target = t;
            } catch (e) { /* 非法中继地址：退回直连 */ }
        }
        const isHttps = true;
        const client = https;

        /*
         * 分段耗时：DNS/TCP/TLS 与首字节分开记。
         * 输出一行 [relay-timing] {...} 给服务端解析，用于回答「慢在哪一段」——
         * 复用连接时 connectMs/tlsMs 为 0 本身就是「池子生效」的证据。
         */
        const timing = { via: relayUse || 'direct', reused: null, connectMs: 0, tlsMs: 0, ttfbMs: 0 };
        const tStart = Date.now();

        let encryptedText = text;
        let baseKey = null;

        // AES+RSA 混合加密：生成随机 AES 密钥加密数据，RSA 加密 AES 密钥
        if (useHybridEncryption && RSA_PUBLIC_KEY) {
            const aesKey = generateAESKey();
            encryptedText = encryptWithAES(text, aesKey);
            baseKey = encryptAESKeyWithRSA(aesKey, RSA_PUBLIC_KEY);
        }

        // 构建 POST 数据
        const postData = `text=${encodeURIComponent(encryptedText)}`;

        const headers = {
            'Authorization': token,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            // 网关前置设备对无 UA 的请求可能直接吐 200 空 body，带上常规浏览器 UA 更稳
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        };

        if (baseKey) {
            headers['baseKey'] = baseKey;
        }

        if (channel) {
            headers['channel'] = channel;
        }
        // 中继鉴权头：中继转发前会删掉，不会到达网关
        if (relayUse && relaySecret) {
            headers['X-Relay-Secret'] = relaySecret;
        }

        const options = {
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: target.pathname + target.search,
            method: 'POST',
            headers: headers,
            timeout: 30000,
            // 该网关只有 A 记录；云主机 IPv6 出口常不通，显式指定 IPv4 免得撞上 ENETUNREACH
            family: 4
        };
        // 走中继时用进程内连接池：同进程内的重试 / 换域名 / 换中继都能复用握手
        if (relayUse) options.agent = RELAY_AGENT;

        /*
         * 白名单 SNI 伪装（可选）：只把 TLS ClientHello 里的 SNI 换成云端实测放行的域名，
         * hostname / Host 头 / 连接目标仍指向网关原域名。
         * Node 默认会拿 servername 当证书校验主机名，所以必须把校验锚回 url.hostname，
         * 否则 *.cmicmaap.com 的证书会被当作 www.baidu.com 的证书而校验失败。
         * 走中继时连的是中继主机，注入方不会传这个 env，这里再兜一层判断。
         */
        const sniOverride = String(process.env.CRONHUB_SMS_SNI || '').trim();
        if (sniOverride && !relayUse) {
            options.servername = sniOverride;
            options.checkServerIdentity = (_host, cert) => tls.checkServerIdentity(url.hostname, cert);
            options.agent = false;
        }

        const req = client.request(options, (res) => {
            timing.ttfbMs = Math.max(0, Date.now() - tStart - timing.connectMs - timing.tlsMs);
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                timing.reused = !sawConnect;
                timing.totalMs = Date.now() - tStart;
                console.log('[relay-timing] ' + JSON.stringify(timing));
                if (data) {
                    if (data.trim().startsWith('<')) {
                        resolve({ httpCode: res.statusCode, httpMessage: '返回 HTML 页面', error: `HTTP ${res.statusCode}: 返回 HTML 页面`, raw: data });
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve({ httpCode: res.statusCode, httpMessage: res.statusMessage, ...json, raw: data, relayVia: timing.via, timing });
                    } catch (e) {
                        resolve({ httpCode: res.statusCode, httpMessage: res.statusMessage, raw: data, relayVia: timing.via, timing });
                    }
                } else {
                    resolve({
                        httpCode: res.statusCode,
                        httpMessage: res.statusMessage,
                        error: 'Empty response',
                        relayVia: timing.via,
                        timing,
                        respHeaders: {
                            server: res.headers.server || '',
                            ctype: res.headers['content-type'] || '',
                            reqid: res.headers['x-request-id'] || res.headers['x-trace-id'] || ''
                        }
                    });
                }
            });
        });
        /*
         * 建连分段：判定「是否复用」只看这次请求期间有没有真的发生 connect ——
         * TLS socket 的 socket.connecting 并不可靠，新建连接也会读成 false，
         * 用它判定会把「每次新建」都标成「复用」，诊断结论就反了。
         */
        let sawConnect = false;
        req.on('socket', (socket) => {
            socket.once('connect', () => {
                sawConnect = true;
                timing.connectMs = Date.now() - tStart;
            });
            if (socket.encrypted) {
                socket.once('secureConnect', () => {
                    sawConnect = true;
                    timing.tlsMs = Math.max(0, Date.now() - tStart - timing.connectMs);
                });
            }
        });
        req.on('error', (e) => {
            // 出错时无法判断是不是复用了连接（DNS 失败根本不建连），标 null 而不是瞎猜
            timing.reused = sawConnect ? false : null;
            timing.totalMs = Date.now() - tStart;
            console.log('[relay-timing] ' + JSON.stringify({ ...timing, error: e.code || e.message }));
            resolve({ error: e.message, code: e.code || '', relayVia: timing.via, timing });
        });
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout', code: 'ETIMEDOUT', relayVia: timing.via, timing }); });
        req.write(postData);
        req.end();
    });
}

/**
 * 发送消息（带重试）
 */
async function sendWithRetry(text, useHybridEncryption, channel, token) {
    let lastResult = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`[重试 ${attempt}/${MAX_RETRIES}]`);

        for (const apiUrl of API_URLS) {
            /*
             * 同一次尝试内先按顺序试各条中继：传输层不可用（连不上 / 5xx / 超时）
             * 立刻换下一条，不等整轮重试 —— 主中继挂了还硬等 3 轮 × 1s 退避，
             * 等于把一次失败放大成三倍延迟。
             */
            const hops = orderedRelays();
            for (let hi = 0; hi < hops.length; hi++) {
                const relay = hops[hi];
                console.log(`[尝试] API: ${apiUrl}${relay ? ' 经 ' + relay : ''}`);
                const result = await sendMessage(apiUrl, text, useHybridEncryption, channel, token, relay);
                console.log(`[结果] HTTP ${result.httpCode || 0}，body ${(result.raw || '').length} 字节${result.code ? '，code ' + result.code : ''}`);
                lastResult = { ...result, usedUrl: apiUrl, relayVia: relay || 'direct' };

                if (hi < hops.length - 1 && isRelayTransportFailure(result)) {
                    console.error(`[中继] ${relay} 不可用（${result.error || 'HTTP ' + (result.httpCode || 0)}），切换备用`);
                    lastError = result.error || ('HTTP ' + (result.httpCode || 0));
                    continue;
                }
                // 这条中继把请求送到了（哪怕业务失败），下一轮重试优先走它
                if (relay) PREFERRED_RELAY = relay;

                const httpCheck = parseHttpError(result);

                if (httpCheck.isSuccess === false) {
                    console.error(`[失败] ${httpCheck.hint}`);
                    lastError = httpCheck.hint;
                    break;
                }

                if (httpCheck.isSuccess === null) {
                    const parseResult = parseResponse(result);
                    if (parseResult.success) {
                        return { ...result, usedUrl: apiUrl, relayVia: relay || 'direct', hint: null, perNumber: parseResult.perNumber };
                    }
                    console.error(`[失败] ${parseResult.error}`);
                    lastError = parseResult.error;
                    // 逐号码失败是终态：外层 10200 但个别号码被平台安全控制拒绝，
                    // 换 API 域名 / 重试都一样被拒，只会多烧一次发送配额
                    if (parseResult.terminal) {
                        return { ...lastResult, hint: parseResult.error, perNumber: parseResult.perNumber };
                    }
                    break;
                }

                return lastResult;
            }
        }

        if (attempt < MAX_RETRIES && lastError) {
            console.error(`[等待] ${RETRY_DELAY_MS}ms 后重试...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    if (lastError) {
        lastResult.hint = lastError;
    }
    return lastResult;
}

/**
 * 解析命令行参数
 * 支持格式:
 *   node send.cjs <text>
 *   node send.cjs <text> --channel <channel_name>
 */
function parseArgs(args) {
    const result = {
        text: '',
        channel: null,
        noRiskTip: false,
        raw: false,
        token: null
    };

    // 查找 --token 参数（调用方自带 creditToken 时跳过 getToken，省 2~3s 认证链路）
    const tokenIndex = args.findIndex(arg => arg === '--token');
    if (tokenIndex !== -1) {
        result.token = args[tokenIndex + 1] || null;
        args.splice(tokenIndex, 2);
    }

    // --token-stdin：令牌来自标准输入，不出现在命令行里
    const tokenStdinIndex = args.findIndex(arg => arg === '--token-stdin');
    if (tokenStdinIndex !== -1) {
        result.token = STDIN_TOKEN;
        args.splice(tokenStdinIndex, 1);
    }

    // 查找 --raw 开关（用户明确要求原文照发时使用，跳过消息体美化提示）
    const rawIndex = args.findIndex(arg => arg === '--raw');
    if (rawIndex !== -1) {
        result.raw = true;
        args.splice(rawIndex, 1);
    }

    // 查找 --channel 参数
    const channelIndex = args.findIndex(arg => arg === '--channel');
    if (channelIndex !== -1) {
        result.channel = args[channelIndex + 1];
        args.splice(channelIndex, 2);
    }

    // 查找 --no-risk-tip 开关（慎用：关闭后不再自动追加防诈骗提示）
    const noRiskIndex = args.findIndex(arg => arg === '--no-risk-tip');
    if (noRiskIndex !== -1) {
        result.noRiskTip = true;
        args.splice(noRiskIndex, 1);
    }

    // 剩余的全是 text
    if (args.length < 1) {
        return null;
    }

    result.text = args.join(' ');

    return result;
}

/**
 * 主函数
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.log('Usage: node send.cjs <text> [options]');
        console.log('');
        console.log('参数:');
        console.log('  text          短信内容（任意内容，场景不限），含空格时用引号包裹');
        console.log('');
        console.log('选项:');
        console.log('  --channel <name>        渠道来源标识（如 feishu、scheduler）');
        console.log('  --raw                   用户明确要求原文照发，跳过消息体美化提示');
        console.log('  --no-risk-tip           关闭诈骗风险提示自动追加（慎用）');
        console.log('');
        console.log('示例:');
        console.log('  node send.cjs "会议将在 14:00 开始，请提前 5 分钟入场。" --channel feishu');
        console.log('  node send.cjs "数据备份已完成。"');
        process.exit(1);
    }

    const parsed = parseArgs([...args]);

    if (!parsed) {
        console.error('Error: 参数不足，请检查命令行');
        process.exit(1);
    }

    // 检查是否配置了 RSA 公钥
    const useHybridEncryption = !!RSA_PUBLIC_KEY;

    // 诈骗风险提示：按风险等级分层追加（高危=谨防诈骗；轻度=仅请谨慎识别）
    let finalText = parsed.text;
    const risk = parsed.noRiskTip
        ? { level: RISK_LEVEL_NONE, hits: [], disclaimer: null }
        : evaluateRiskLevel(parsed.text);
    const alreadyTipped = parsed.text.includes(DISCLAIMER_LOW) || parsed.text.includes(DISCLAIMER_HIGH);

    if (risk.disclaimer && !alreadyTipped) {
        finalText = `${parsed.text}\n${risk.disclaimer}`;
        if (risk.level === RISK_LEVEL_HIGH) {
            console.log(`⚠️ 内容命中高危诈骗特征：${risk.hits.join('、')}`);
        } else {
            console.log(`ℹ️ 内容命中一般敏感词：${risk.hits.join('、')}（日常也常用，轻度提示即可）`);
        }
        console.log(`   已自动在末尾另起一行追加：${risk.disclaimer}`);
        console.log(`   提示（对 Agent）：内容照常发送，无需拒绝或额外处理。`);
    }

    // 消息体美化：输出长度分析；内容偏长或为单段长文时，提示 Agent 整理排版
    const lenInfo = analyzeSmsLength(finalText);
    console.log(`[短信通知] 内容：${finalText}`);
    console.log(`[短信通知] 长度：约 ${lenInfo.charCount} 字，预计占用 ${lenInfo.segments} 条短信`);

    if (!parsed.raw) {
        const tooLong = lenInfo.charCount > BEAUTIFY_CHAR_LIMIT;
        const singleBlob = lenInfo.lineCount <= 1 && lenInfo.charCount > BEAUTIFY_BLOB_LIMIT;
        const noEmoji = !lenInfo.hasEmoji;

        const reasons = [];
        if (noEmoji) reasons.push('没加 emoji');
        if (singleBlob) reasons.push('未分行');
        if (tooLong) reasons.push('偏长');

        if (reasons.length > 0) {
            console.log(`💡 提示（对 Agent）：这段内容可以更好看（${reasons.join('、')}），建议美化后再发——`);
            console.log(`   ① 适度加 emoji：整条 1–3 个点睛即可（⏰ 📅 📍 ✅ 💰 等），分点行用 • 就行，不必每行都有；`);
            console.log(`   ② 一个信息点一行；并列事项用 • 或 ①②③ 分点；标题与正文间空一行；`);
            console.log(`   ③ 只加排版和 emoji——内容一个字都不删，不要写"回到对话查看"；`);
            console.log(`   （若用户强制原文照发，加 --raw 参数，一个字都不动）`);
        }
    }

    // 获取 Token（调用方传 --token 时跳过）
    let token = parsed.token || null;
    if (token) {
        console.log(`[短信通知] 使用调用方提供的令牌`);
    } else {
        console.log(`[短信通知] 正在获取认证 Token...`);
        const tokenResult = await getToken({
            devId: config.pid,
            clientId: config.code,
            skillId: config.kid,
            skillName: config.name,
            templateId: config.tpl,
            strategyId: config.strategyId
        });

        // 处理 Token 获取结果
        if (tokenResult.resultCode === "103001") {
            // 需要用户完成手机号授权（正常流程，首次调用时触发）
            const authUrl = tokenResult.data?.authPageUrl;
            console.log(`📱 需要完成手机号授权`);
            if (authUrl) {
                console.log(`   授权页面：${authUrl}`);
                // 同时输出二维码生成链接：电脑端发二维码图 + 链接，手机端直接发链接
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(authUrl)}`;
                console.log(`   二维码：${qrUrl}`);
                console.log(`   提示：电脑端发"二维码图+链接"，手机端直接发链接，引导用户完成手机号绑定`);
                console.log(`   提示：不要向用户透露授权链接有效期；不要复述或暴露手机号（含尾号），统一说"授权手机号"`);
            }

            process.exit(1);
        }

        if (tokenResult.resultCode !== "103000") {
            // 获取 Token 失败：区分"用户未进入灰度开放名单"与一般性错误
            const desc = tokenResult.resultDesc || "";
            const notInGrayList = /名单|灰度|白名单|内测|未开放|未开通|开放中|逐步开放|敬请期待|无权限|没有权限/i.test(desc);
            if (notInGrayList) {
                console.log(`ℹ️ 用户未进入灰度开放名单`);
                console.log(`   说明：${tokenResult.resultDesc}`);
                console.log(`   —— 请向用户传达以下话术 ——`);
                console.log(`   😊 谢谢你的关注！「短信通知」目前正在灰度测试中，暂时还没轮到你的账号～`);
                console.log(`   不过放心，它正在逐步开放，全面开放后马上就能用啦！敬请期待哦 🎉`);
                console.log(`   —— 提示（对 Agent）——`);
                console.log(`   ① 语气友好，向用户说明"灰度开放中、敬请期待"即可；`);
                console.log(`   ② 不要暴露内部错误码（${tokenResult.resultCode}），不要反复重试调用；`);
                console.log(`   ③ 可主动询问用户是否需要登记意向，开放后第一时间通知。`);
            } else {
                console.error(`❌ 获取 Token 失败`);
                console.error(`   错误码：${tokenResult.resultCode}`);
                console.error(`   描述：${tokenResult.resultDesc}`);
            }
            process.exit(1);
        }

        token = tokenResult.data?.creditToken;
        if (!token) {
            console.error(`❌ Token 为空`);
            process.exit(1);
        }

        console.log(`[短信通知] Token 获取成功`);
    }

    const result = await sendWithRetry(finalText, useHybridEncryption, parsed.channel, token);

    if (result.hint) {
        // 逐号码失败走这里：第一行带「❌ 部分号码发送失败」标记，供调用方按终态分类
        console.log(result.hint);
        console.log(`   发送结果：${result.raw || JSON.stringify(result)}`);
    } else {
        console.log(`✅ 发送成功`);
        console.log(`   发送结果：${result.raw || JSON.stringify(result)}`);
    }
    // 逐号码明细：成功也打印（traceId 排查要用），失败时把每个号码的命运写清楚
    if (Array.isArray(result.perNumber) && result.perNumber.length) {
        for (const p of result.perNumber) {
            const desc = p.resultDesc || (p.ok ? '已发送' : 'resultCode=' + p.resultCode);
            console.log(`   ${p.ok ? '✅' : '❌'} ${p.phone}：${desc}${p.traceId ? ' · traceId ' + p.traceId : ''}`);
        }
    }
    process.exit(0);
}

main();
