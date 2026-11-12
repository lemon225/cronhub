#!/usr/bin/env node
/**
 * token_probe.cjs — 仅供 CronHub 服务端使用
 * 单独跑一次 getToken，把结果以单行 JSON 输出到 stdout：
 *   { resultCode, resultDesc, creditToken, expireTime, authPageUrl }
 * creditToken 属敏感值，调用方（server.js）只入内存缓存，绝不写日志。
 */
const fs = require('fs');
const path = require('path');
const { getToken, setConfig } = require('./token_service');

/*
 * 凭据目录：CronHub 服务端会传 CRONHUB_SMS_CFG_DIR，指向一个一次性临时目录，
 * 调用结束立刻销毁。默认退到脚本自带目录，保证单独运行时行为不变。
 */
const SMS_CFG_DIR = String(process.env.CRONHUB_SMS_CFG_DIR || '').trim() || __dirname;
if (SMS_CFG_DIR !== __dirname) {
    setConfig({
        auth_info_path: path.join(SMS_CFG_DIR, 'auth_info_ydrz.json'),
        clawUid_path: path.join(SMS_CFG_DIR, 'clawUid.json'),
        fallback_clawUid_path: path.join(SMS_CFG_DIR, 'clawUid.json'),
    });
}

let config = {};
try {
    config = JSON.parse(fs.readFileSync(path.join(SMS_CFG_DIR, 'config.json'), 'utf8'));
} catch (e) {
    console.log(JSON.stringify({ resultCode: 'ERR_CONFIG', resultDesc: 'config.json 读取失败' }));
    process.exit(0);
}

(async () => {
    const r = await getToken({
        devId: config.pid,
        clientId: config.code,
        skillId: config.kid,
        skillName: config.name,
        templateId: config.tpl,
        strategyId: config.strategyId
    });
    console.log(JSON.stringify({
        resultCode: r.resultCode,
        resultDesc: r.resultDesc || '',
        creditToken: r.data?.creditToken ?? null,
        expireTime: r.data?.expireTime ?? null,
        authPageUrl: r.data?.authPageUrl ?? null
    }));
    process.exit(0);
})();
