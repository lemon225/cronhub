'use strict';
/*
 * 短信内容分析：风控评估 + 长度/排版分析 + 美化建议。
 *
 * 这是「预览」与「真实发送」共用的唯一实现（官方文档 4.3 第 3/4 步）：
 *   · send.cjs 发送前用它追加免责声明 —— 免责声明的措辞来自这里
 *   · server.js 的 /api/sms/preview 用它做发送前预览
 * 两边各写一份迟早漂移（预览说没风险、发送时却加了诈骗提示，用户会懵）。
 *
 * 从官方 skill send.cjs 原样迁出，未改任何判定规则。
 */

const RISK_LEVEL_NONE = 0;
const RISK_LEVEL_LOW = 1;
const RISK_LEVEL_HIGH = 2;

const DISCLAIMER_LOW = '（内容由智能体生成发送，请谨慎识别）';
const DISCLAIMER_HIGH = '（内容由智能体生成发送，请谨慎识别，谨防诈骗）';

const RISK_PATTERNS = [
    // ===== 高危：典型诈骗特征 =====
    {
        level: RISK_LEVEL_HIGH,
        name: '可疑链接',
        re: /https?:\/\/|www\.|t\.cn|dwz\.cn|url\.cn|suo\.im|bit\.ly|cutt\.ly|tinyurl|is\.gd|m\.tb\.cn|s\.click|点击.{0,6}链接|复制链接|长按.{0,6}识别|扫码.{0,6}领/
    },
    {
        level: RISK_LEVEL_HIGH,
        name: '账号与资金安全',
        re: /验证码|银行卡|银行卡号|卡号|密码|身份证号|账户异常|账户冻结|被冻结|封号|涉嫌|通缉|公安|法院|检察院|逾期|欠费|征信/
    },
    {
        level: RISK_LEVEL_HIGH,
        name: '利益诱导',
        re: /红包|返利|返现|刷单|中奖|领奖|免费领|免费送|补贴|佣金|提现|垫付|转账|汇款|打款|收款码|付款码|保证金|押金|百万保障/
    },
    {
        level: RISK_LEVEL_HIGH,
        name: '紧迫施压',
        re: /限时|立即处理|马上处理|否则.{0,6}(冻结|停用|注销)|最后.{0,4}(机会|通牒)/
    },

    // ===== 轻度：一般敏感词，日常也常用，易误报 =====
    {
        level: RISK_LEVEL_LOW,
        name: '客服与退款',
        re: /客服|快递丢失|包裹异常|理赔|退款/
    },
    {
        level: RISK_LEVEL_LOW,
        name: '涉及中国移动',
        // 覆盖"中国移动 / 中移 / 10086"等；排除"移动硬盘""移动到""移动支付"等日常用法
        re: /中国移动|中移|10086|移动(?!硬盘|支付|互联网|办公|端|性|电话|式|到|位置|一下|文件|图标)/
    }
];

/**
 * 评估短信内容的风险等级（分层：无 / 轻度 / 高危）
 * 命中任一高危特征即判定高危；否则命中轻度词判定轻度；都未命中则无风险
 * @param {string} text - 待发送内容
 * @returns {{level:number, hits:string[], disclaimer:string|null}}
 */
function evaluateRiskLevel(text) {
    if (!text) {
        return { level: RISK_LEVEL_NONE, hits: [], disclaimer: null };
    }

    const hits = RISK_PATTERNS.filter(p => p.re.test(text));
    if (hits.length === 0) {
        return { level: RISK_LEVEL_NONE, hits: [], disclaimer: null };
    }

    const hasHigh = hits.some(p => p.level === RISK_LEVEL_HIGH);
    return {
        level: hasHigh ? RISK_LEVEL_HIGH : RISK_LEVEL_LOW,
        hits: hits.map(p => p.name),
        disclaimer: hasHigh ? DISCLAIMER_HIGH : DISCLAIMER_LOW
    };
}

// ===== 消息体美化：长度分析 =====
// 短信容量参考：中文约 70 字/条，超出后按约 67 字/条拼接
const SMS_SINGLE_UNITS = 140;      // 单条容量（近似单位，中文按 2 计）
const SMS_CONCAT_UNITS = 134;      // 长短信拼接时每条可用容量
const BEAUTIFY_CHAR_LIMIT = 70;    // 超过 70 字视为偏长，建议分行分点
const BEAUTIFY_BLOB_LIMIT = 40;    // 无换行的单段超过 40 字，建议分行分点

// emoji 检测：覆盖 1F300-1FAFF（绝大多数 emoji）与 2190-2BFF（箭头/符号/装饰，含 ⏰ ⚠️ ✅）
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u;
// 分点符号检测：• · ▪ ◦ 或 ①②③
const BULLET_RE = /[•·▪◦]|[①②③④⑤⑥⑦⑧⑨⑩]/;

/**
 * 分析短信长度与排版情况，供 Agent 判断是否需要美化
 * - units：短信计费近似单位（中文/全角按 2，其余按 1），用于估算占用条数
 * - charCount：可见字数（不含换行），作为给 Agent 的字数参考
 * @param {string} text - 待发送内容
 */
function analyzeSmsLength(text) {
    if (!text) {
        return { units: 0, charCount: 0, segments: 0, lineCount: 0, hasEmoji: false, hasBullet: false };
    }

    let units = 0;
    let charCount = 0;

    for (const ch of text) {
        if (ch === '\n') {
            units += 1;
            continue;
        }
        charCount += 1;
        // 中文 / 中日韩 / 全角符号按 2 计
        if (/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(ch)) {
            units += 2;
        } else {
            units += 1;
        }
    }

    let segments = 0;
    if (units > 0) {
        segments = units <= SMS_SINGLE_UNITS ? 1 : Math.ceil(units / SMS_CONCAT_UNITS);
    }

    const lineCount = text.split('\n').filter(l => l.trim() !== '').length;
    return {
        units,
        charCount,
        segments,
        lineCount,
        hasEmoji: EMOJI_RE.test(text),
        hasBullet: BULLET_RE.test(text)
    };
}

/**
 * 美化建议：基于长度与排版给出人话建议（官方 5.3「预览即建议」）。
 * 只建议，不强改 —— 是否采纳由调用方决定。
 */
function beautifySuggestions(text) {
    const a = analyzeSmsLength(text);
    const tips = [];
    if (!a.units) return tips;
    if (a.charCount > BEAUTIFY_CHAR_LIMIT) {
        tips.push(`内容 ${a.charCount} 字偏长（建议 70 字内），可精简或分点`);
    }
    if (a.lineCount === 1 && a.charCount > BEAUTIFY_BLOB_LIMIT) {
        tips.push('整段无分行，建议按「时间 / 事项 / 结果」分行，手机上更好读');
    }
    if (a.segments > 1) {
        tips.push(`预计拆成 ${a.segments} 条长短信（每条 ${SMS_CONCAT_UNITS} 单位），超长会分条计费`);
    }
    if (a.hasEmoji && a.segments > 1) {
        tips.push('长短信里的 emoji 在部分安卓机上会显示成方框，长内容慎用');
    }
    if (!a.hasBullet && a.lineCount >= 3) {
        tips.push('多行内容可加 • 或 ①②③ 分点符号，扫一眼就能抓住重点');
    }
    return tips;
}

module.exports = {
    RISK_LEVEL_NONE,
    RISK_LEVEL_LOW,
    RISK_LEVEL_HIGH,
    DISCLAIMER_LOW,
    DISCLAIMER_HIGH,
    evaluateRiskLevel,
    analyzeSmsLength,
    beautifySuggestions,
    SMS_SINGLE_UNITS,
    SMS_CONCAT_UNITS,
};
