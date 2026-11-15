/*
 * 第二十二批 · 天气播报同一份数据每次结果不同
 *
 * 11-15 线上实测：10:20:01 / 10:20:53 / 10:21:21 三次响应去 tag 后逐字节一致，
 * AI 却给出三条不同播报（时段 15-05时 / 02-08时 都是编的，-3.6 取自明天夜间最低
 * 却和全天最高 5.7 拼成一个区间）。根因是：
 *   ① summarizeQWeatherStep 只给 AI 8 个 hourly 采样点，提示词却要求扫 24 条；
 *   ② 多个温度口径并列没有标注，模型随便挑；
 *   ③ temperature 0.35 + 只查格式的 aiReview，幻觉全部放行。
 *
 * 本用例守住修法：24 条全给 + 服务端预算「事实结论」+ 数值事实校验 + temperature 0。
 * 前半段用纯函数断言（不启服务），后半段起真服务 + mock AI 走完整链路。
 * 跑法：node tests/weather-ai.test.cjs
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let failures = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cronhub-weather-'));

/** 从 server.js 里原样取出纯函数，不在测试里另写一份「近似实现」。 */
function pure(blockStart, blockEnd, prefix, names) {
  const a = SRC.indexOf(blockStart);
  const b = SRC.indexOf(blockEnd, a);
  if (a < 0 || b < 0) throw new Error('取函数失败：' + blockStart);
  return new Function(prefix + SRC.slice(a, b) + `\nreturn {${names.join(',')}};`)();
}
const W = pure('function qwSpan(', '/**\n * 生成推送内容',
  'const RESULT_BODY_MAX=200000;', ['qwSpan', 'summarizeQWeatherStep', 'qWeatherFacts', 'summarizeStepData']);
const A = pure('function aiRules(', '/**\n * 拼装提示词', '', ['aiRules', 'aiReview']);

function hour(day, h, text, precip) {
  return {
    forecastTime: `2026-11-${day}T${String(h).padStart(2, '0')}:00+08:00`,
    condition: { text }, temperature: { value: 3 - h * 0.2 }, humidity: 0.7,
    wind: { scale: 1, direction: { compass: 'n' } },
    precipitation: { amount: { value: precip || 0 }, type: precip ? 'snow' : 'none', probability: precip ? 0.7 : 0 },
    uvIndex: 1,
  };
}
function day(n, dayText, nightText, tmin, tmax, nightMin, daytimePrecip) {
  const d = `2026-11-${n}`;
  return {
    forecastStartTime: `${d}T00:00+08:00`, forecastEndTime: `${d}T00:00+08:00`,
    temperatureMin: { value: tmin }, temperatureMax: { value: tmax }, uvIndexMax: 3,
    daytime: {
      forecastStartTime: `${d}T07:00+08:00`, forecastEndTime: `${d}T19:00+08:00`,
      condition: { text: dayText }, wind: { scale: 1, direction: { compass: 'e' } },
      precipitation: daytimePrecip || { amount: { value: 0 }, type: 'none', probability: 0 },
    },
    nighttime: {
      forecastStartTime: `${d}T19:00+08:00`, forecastEndTime: `2026-11-${n + 1}T07:00+08:00`,
      condition: { text: nightText }, temperatureMin: { value: nightMin },
    },
  };
}
/** 和风 v1 五个步骤的完整形状；hours 可覆盖以构造降水场景。 */
function qwFixture(opts = {}) {
  const hours = opts.hours || Array.from({ length: 24 }, (_, i) => {
    const h = (11 + i) % 24;
    return hour(11 + i >= 24 ? 16 : 15, h, '多云');
  });
  return {
    current: { condition: { text: '晴间多云' }, temperature: { value: 2.3 }, humidity: 0.8,
      wind: { scale: 2, direction: { compass: 'ene' } },
      precipitation: { amount: { value: 0 }, type: 'none', probability: 0 }, uvIndex: 1 },
    daily: {
      days: [
        day(15, '晴间多云', '多云', -1.38, 7.24, -1.43),
        day(16, '小雪', '少云', -1.95, 5.69, -3.59,
          { amount: { value: 0.8 }, type: 'snow', probability: 0.23 }),
      ],
    },
    hourly: { hours },
    alert: { alerts: [{ eventType: { name: '道路结冰' }, color: { code: 'yellow' },
      senderName: '广河县气象台', headline: '广河县气象台发布道路结冰黄色预警信号', expireTime: '2026-11-15T16:20Z' }] },
    air: { indexes: [{ aqi: 43, category: '优' }] },
  };
}
function stepsOf(j, names) {
  return names.map((n) => ({ name: n, ok: true, json: j[n] }));
}
const NAMES = ['current', 'daily', 'hourly', 'alert', 'air'];

(async () => {
  console.log('\n[1] 和风材料：24 条 hourly 全给，字段不再缺降水');
  const j = qwFixture();
  const text = W.summarizeStepData(stepsOf(j, NAMES));
  const lines = text.split('\n');
  const hourlyLines = lines.filter((l) => l.includes('hourly '));
  ok('24 条 hourly 全在（旧实现只有 8 条）', hourlyLines.length === 24, hourlyLines.length);
  ok('每条 hourly 都带降水量 / 类型 / 概率',
    hourlyLines.every((l) => /降水量=/.test(l) && /降水类型=/.test(l) && /降水概率=/.test(l)));
  ok('逐日行带白天 / 夜间时段',
    lines.some((l) => l.includes('白天时段=07-19时') && l.includes('夜间时段=19-07时')));
  ok('明天的夜间最低明确标注禁止用于温度区间',
    lines.some((l) => l.includes('daily[1]') && l.includes('禁用于明天温度区间')));

  console.log('\n[2] 事实结论：今晚 / 明天 / 降水区间 / 预警由服务端算好');
  const facts = lines.filter((l) => /^(今晚 |明天 |降水区间=|预警名=|空气质量 )/.test(l));
  ok('结论行齐全（5 行）', facts.length === 5, facts);
  ok('今晚取夜间现象与夜间最低',
    facts.some((l) => l.startsWith('今晚 ') && l.includes('现象=多云') && l.includes('最低=-1.4°C')));
  ok('明天取白天现象与全天最低/最高，不含夜间最低 -3.6',
    facts.some((l) => l.startsWith('明天 ') && l.includes('现象=小雪')
      && l.includes('最低=-1.9°C') && l.includes('最高=5.7°C') && !l.includes('-3.6')));
  ok('hourly 无降水时，降水区间退回逐日白天时段并注明来源',
    facts.some((l) => l.startsWith('降水区间=07-19时') && l.includes('明天白天/逐日') && l.includes('类型=小雪')));
  ok('预警名直接给中文全名，不用模型自己翻译 yellow',
    facts.some((l) => l.includes('预警名=道路结冰黄色预警'))
    && facts.some((l) => l.includes('AQI=43')));
  ok('降水时段按今晚 / 明天分开，今晚不再被套上明天的时段',
    facts.some((l) => l.startsWith('今晚 ') && l.includes('降水时段=无'))
    && facts.some((l) => l.startsWith('明天 ') && l.includes('降水时段=07-19时')));

  console.log('\n[3] 降水区间：逐小时优先、跨午夜连写、无降水写「无」');
  const wetHours = Array.from({ length: 24 }, (_, i) => {
    const h = (11 + i) % 24;
    const d = 11 + i >= 24 ? 16 : 15;
    const wet = (d === 15 && h >= 22) || (d === 16 && h <= 3);
    return hour(d, h, wet ? '小雪' : '多云', wet ? 0.4 : 0);
  });
  const wetFacts = W.qWeatherFacts(stepsOf(qwFixture({ hours: wetHours }), NAMES));
  ok('逐小时扫出 22-03时，不拆段不写两个「时」',
    wetFacts.some((l) => l.includes('降水区间=22-03时') && l.includes('来源=逐小时')), wetFacts);
  ok('跨午夜降水归今晚，不误挂到明天',
    wetFacts.some((l) => l.startsWith('今晚 ') && l.includes('降水时段=22-03时'))
    && wetFacts.some((l) => l.startsWith('明天 ') && l.includes('降水时段=无')), wetFacts);
  // 和风 v1 把逐日白天的雪量挂到一条「中度霾」小时上：只看 amount>0 会算出 11-11时。
  const misleading = qwFixture();
  misleading.hourly.hours[23] = {
    ...misleading.hourly.hours[23], condition: { text: '中度霾' },
    precipitation: { amount: { value: 0.4 }, type: 'snow', probability: 0.03 },
  };
  const mf = W.qWeatherFacts(stepsOf(misleading, NAMES));
  ok('现象为霾、仅 amount>0 的小时不算降水，退回逐日 07-19时',
    mf.some((l) => l.includes('降水区间=07-19时') && l.includes('明天白天/逐日'))
    && !mf.some((l) => l.includes('11-11时')), mf);
  const oneWet = qwFixture();
  oneWet.hourly.hours[5] = hour(15, 16, '小雪', 0.3);
  ok('只有一个降水小时写「16时」，不写「16-16时」',
    W.qWeatherFacts(stepsOf(oneWet, NAMES)).some((l) => l.includes('降水区间=16时')),
    W.qWeatherFacts(stepsOf(oneWet, NAMES)));
  const dry = qwFixture();
  dry.daily.days[1].daytime.precipitation = { amount: { value: 0 }, type: 'none', probability: 0 };
  const dryFacts = W.qWeatherFacts(stepsOf(dry, NAMES));
  ok('全无降水时写「无」', dryFacts.some((l) => l.includes('降水区间=无')), dryFacts);
  ok('非和风数据不追加结论',
    W.qWeatherFacts([{ name: 'x', ok: true, json: { hello: 'world' } }]).length === 0);
  ok('通知栏兜底摘要（cap=600）不追加结论',
    !W.summarizeStepData(stepsOf(j, NAMES), 600).includes('【事实结论'));

  console.log('\n[4] 数值事实校验：编造数字硬拦，时段与合规数字不误伤');
  const rules = A.aiRules('正文 ≤58 字');
  ok('规则含 fact-number，共 5 项', rules.length === 5 && rules.some((r) => r.kind === 'fact-number'), rules);
  const good = '❄️ 今晚多云，最低-1.4°C\n⛅ 明天07-19时小雪-1.9~5.7°C\n⚠️ 道路结冰黄色预警；明早慢行';
  ok('合规三行零违规', A.aiReview(good, rules, text).length === 0, A.aiReview(good, rules, text));
  ok('跨午夜时段 22-03时 不被读成负数',
    A.aiReview('❄️ 今晚22-03时小雪，最低-1.4°C', rules, text).length === 0);
  const bad = A.aiReview('❄️ 今晚小雪，最低-9.9°C\n⛅ 明天晴间多云，-3.6~5.7°C', rules, text);
  ok('凭空造的 -9.9 / -3.6 被标为 hard',
    bad.length === 1 && bad[0].hard && bad[0].msg.includes('-9.9'), bad);
  ok('不传原始材料时跳过该规则（兼容只查格式的调用）',
    A.aiReview('❄️ 今晚小雪，最低-9.9°C', rules).length === 0);
  ok('默认 temperature 为 0', /ai: \{[^}]*temperature: 0 \}/.test(SRC));

  console.log('\n[5] 端到端：真服务 + mock AI 抓请求体，验证 temperature 与纠正链路');
  const seen = [];
  const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d.toString(); });
    req.on('end', () => {
      seen.push(raw);
      // 第一次故意编数字触发纠正；第二次给「合规但 °C 前带空格」的版本，
      // 用来验证服务端会按任务要求做确定性归一。
      const goodSpaced = '❄️ 今晚多云，最低-1.4 °C\n⛅ 明天07-19时小雪-1.9~5.7 °C\n⚠️ 道路结冰黄色预警；明早慢行';
      const body = seen.length === 1
        ? '❄️ 今晚小雪，最低-9.9°C\n⛅ 明天晴间多云，-3.6~5.7°C'
        : goodSpaced;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 't', body }) } }] }));
    });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  const up = http.createServer((req, res) => {
    const key = req.url.replace(/^\//, '').split('?')[0];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(j[key] || {}));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const dir = freshDir();
  const u = (p) => `http://127.0.0.1:${up.address().port}/${p}`;
  const task = {
    id: 't_weather', name: '天气播报', type: 'http', enabled: true,
    schedules: [{ mode: 'cron', cron: '0 19 * * *' }], schedule: { mode: 'cron', cron: '0 19 * * *' },
    config: {
      url: u('current'), method: 'GET', expectStatus: 200, timeoutSec: 8,
      notifyPrompt: '只输出 3 行；正文 ≤58 字；数字必须出自原始数据；°C 紧贴数字。',
      notify: { enabled: true, channels: [] },
      steps: NAMES.map((n) => ({ name: n, url: u(n), method: 'GET' })),
    },
    notify: { channels: [] }, nextRun: null, lastRun: null, runCount: 0, failCount: 0,
    lastResult: null, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    tasks: [task], notifications: [], logs: [],
    settings: {
      catchup: { enabled: false }, blockPrivateUrls: false, sms: { enabled: false },
      missedPolicy: 'skip',
      ai: { enabled: true, provider: 'openai', model: 'mock-model', apiKey: 'mock-key',
        baseUrl: `http://127.0.0.1:${ai.address().port}/v1`,
        defaultPrompt: '', timeoutMs: 20000, maxAttempts: 2, temperature: 0 },
    },
    smsRelay: [], keepAliveLog: [], auth: null, authLog: [], systemLogs: [],
    deadLetters: [], smsRecords: [],
  }));

  const port = 19500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, CRONHUB_ENV: 'dev',
      CRONHUB_SMS_REAL: '', CRONHUB_PREWARM: '0', CRONHUB_SMS_RELAY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch { /* 启动中 */ }
      await sleep(120);
    }
    ok('服务启动', ready, out.slice(-600));
    if (ready) {
      const r = await fetch(base + '/api/tasks/t_weather/run', { method: 'POST' });
      ok('手动执行返回 202', r.status === 202, r.status);
      let st = null;
      for (let i = 0; i < 100; i++) {
        await sleep(200);
        st = await (await fetch(base + '/api/state')).json();
        if ((st.notifications || []).length) break;
      }
      const notes = (st && st.notifications) || [];
      ok('产出通知', notes.length === 1, notes.length);
      const req1 = seen.length ? JSON.parse(seen[0]) : null;
      ok('请求体 temperature === 0', req1 && req1.temperature === 0, req1 && req1.temperature);
      const user1 = req1 && (req1.messages || []).find((m) => m.role === 'user');
      ok('AI 收到 24 行 hourly', user1 && (user1.content.match(/hourly /g) || []).length === 24,
        user1 && (user1.content.match(/hourly /g) || []).length);
      ok('AI 收到事实结论行', user1 && user1.content.includes('【事实结论'));
      ok('编造数字触发第二次纠正调用', seen.length === 2, seen.length);
      if (seen.length === 2) {
        const req2 = JSON.parse(seen[1]);
        ok('纠正消息点名违规数字',
          JSON.stringify(req2.messages).includes('没通过检查') && JSON.stringify(req2.messages).includes('-9.9'));
      }
      ok('最终正文为纠正后的合规版本，且 °C 前的空格被确定性归一',
        notes[0] && notes[0].body === good, notes[0] && notes[0].body);
      ok('aiNote 显示 5 项校验', notes[0] && /已校验 5 项/.test(notes[0].aiNote || ''), notes[0] && notes[0].aiNote);
    }
  } finally {
    child.kill();
    ai.close(); up.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }

  console.log('\n' + (failures ? `失败 ${failures} 项` : '全部通过'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
