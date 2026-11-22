/*
 * 第四十一批 · 归档周报 / 任务依赖 / 关键步骤 / 云端状态
 *
 * 守住：
 *   ① sanitizeHttpConfig 收到 dependsOn / critical / archive 时不抛错且原样保留
 *      （曾因在函数里引用未定义的 existing 导致线上 PUT 500）；
 *   ② 归档数值抽取不展开大数组，周报按任务聚合；
 *   ③ archiveEnabled 默认开、显式 false 才关。
 *
 * 跑法：node tests/archive-dep.test.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
function pure(start, end, prefix, names) {
  const a = SRC.indexOf(start), b = SRC.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('取函数失败：' + start);
  return new Function(prefix + SRC.slice(a, b) + `\nreturn {${names.join(',')}};`)();
}

// 第四十七批把字段提取声明抽成独立函数（任务级/步骤级共用），抽函数时要一起带上
const EX = pure('function sanitizeExtract(', '/** 校验并规范化单条 HTTP 请求配置',
  '', ['sanitizeExtract']);
const S = pure('function sanitizeHttpStep(', '/**\n * 任务级 NotifyMe 高级选项清洗。',
  `const sanitizeExtract=${EX.sanitizeExtract.toString()};
   const parseStatusList=(x)=>Array.isArray(x)?x.filter((n)=>Number.isInteger(Number(n))).map(Number):[];`,
  ['sanitizeHttpStep']);
const H = pure('function sanitizeHttpConfig(', 'function sanitizeTask(',
  `const CI_ID_RE=/^ci_[0-9a-f]{6,20}$/;
   const AI_NOTIFY_PROMPT_MAX=4000;
   const RETRY_MAX_TIMES=5;
   const sanitizeExtract=${EX.sanitizeExtract.toString()};
   const parseStatusList=(x)=>Array.isArray(x)?x.filter((n)=>Number.isInteger(Number(n))).map(Number):[];
   const sanitizeHttpStep=${S.sanitizeHttpStep.toString()};
   const sanitizeNmPush=()=>null;`,
  ['sanitizeHttpConfig']);

console.log('\n[1] 任务配置清洗（线上 PUT 500 回归）');
let cfg;
try {
  cfg = H.sanitizeHttpConfig({
    url: 'https://example.com', method: 'GET',
    dependsOn: { taskId: 'task_abc123', withinHours: 24 },
    steps: [
      { name: '签到', url: 'https://example.com', optional: true, critical: true },
      { name: '领奖', url: 'https://example.com', optional: true },
    ],
  });
  ok('带 dependsOn 的配置不再抛 existing is not defined', true);
} catch (e) {
  ok('带 dependsOn 的配置不再抛 existing is not defined', false, e.message);
}
ok('dependsOn 原样保留', cfg && cfg.dependsOn && cfg.dependsOn.taskId === 'task_abc123' && cfg.dependsOn.withinHours === 24, cfg && cfg.dependsOn);
ok('窗口 clamp 到 1-72', (() => {
  const c = H.sanitizeHttpConfig({ url: 'https://e.com', dependsOn: { taskId: 'task_abc123', withinHours: 999 } });
  return c.dependsOn.withinHours === 72;
})());
ok('非法 taskId 不落库', (() => {
  const c = H.sanitizeHttpConfig({ url: 'https://e.com', dependsOn: { taskId: 'javascript:alert(1)' } });
  return !c.dependsOn;
})());
ok('关键步骤标记保留', cfg && cfg.steps[0].critical === true && cfg.steps[1].critical === undefined, cfg && cfg.steps);
ok('普通 optional 不受影响', cfg && cfg.steps[0].optional === true && cfg.steps[1].optional === true, cfg && cfg.steps);

console.log('\n[2] 归档数值抽取');
const V = pure('function archiveValuesOf(', '/** 归档是否开启', '', ['archiveValuesOf']);
const vals = V.archiveValuesOf([{ json: { result: { p92: '8.37', p95: 8.94 }, list: Array.from({ length: 100 }, (_, i) => ({ v: i })) } }]);
ok('数字字符串转数值', vals.p92 === 8.37 && vals.p95 === 8.94, vals);
ok('大数组不展开', Object.keys(vals).every((k) => !/^v$/.test(k)), Object.keys(vals).slice(0, 8));

console.log('\n[2b] 单任务周报统计');
const nowISO = new Date().toISOString();
const oldISO = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
const WEEK_SRC = SRC.slice(SRC.indexOf('const CN_TZ_OFFSET_MS'), SRC.indexOf('/** 取 URL 的 host'));
const AS = new Function('const state={archives:[' + [
  `{taskId:'task_a',taskName:'A',at:'${nowISO}',ok:true,body:'a1'}`,
  `{taskId:'task_b',taskName:'B',at:'${nowISO}',ok:false,body:'b1'}`,
  `{taskId:'task_a',taskName:'A',at:'${oldISO}',ok:true,body:'a0'}`,
].join(',') + ']};' + WEEK_SRC + '\nreturn {archiveSummary, weekRangeCN, buildWeeklyReport};')();
const sumAll = AS.archiveSummary(7);
const sumOne = AS.archiveSummary(7, 'task_a');
ok('全部任务：3 条里只算 7 天内的 2 条', sumAll.total === 2 && sumAll.ok === 1 && sumAll.fail === 1, sumAll);
ok('单任务：统计与明细一起过滤', sumOne.total === 1 && sumOne.ok === 1 && sumOne.fail === 0 && sumOne.tasks.length === 1, sumOne);

console.log('\n[2d] 自然周口径（东八区，不依赖进程时区）');
const W = AS.weekRangeCN;
const sat = Date.parse('2026-11-21T11:00:00Z');       // 东八区 周六 19:00
const iso = (ms) => new Date(ms).toISOString();
const lastRange = W(-1, sat);
ok('上周一 00:00 起算', iso(lastRange.fromMs) === '2026-11-08T16:00:00.000Z', iso(lastRange.fromMs));
ok('上周末＝本周一 00:00（不含）', iso(lastRange.toMs) === '2026-11-15T16:00:00.000Z', iso(lastRange.toMs));
const thisRange = W(0, sat);
ok('本周从周一起算', iso(thisRange.fromMs) === '2026-11-15T16:00:00.000Z', iso(thisRange.fromMs));
ok('本周标记未走完', thisRange.partial === true && lastRange.partial === false);
const sundayLate = Date.parse('2026-11-15T15:59:00Z'); // 东八区周日 23:59
ok('周日 23:59 仍属该周', iso(W(0, sundayLate).fromMs) === '2026-11-08T16:00:00.000Z', iso(W(0, sundayLate).fromMs));
const mondayEarly = Date.parse('2026-11-15T16:00:00Z'); // 东八区周一 00:00
ok('周一 00:00 已换周', iso(W(0, mondayEarly).fromMs) === '2026-11-15T16:00:00.000Z', iso(W(0, mondayEarly).fromMs));
ok('区间过滤生效', AS.archiveSummary(7, '', { fromMs: Date.parse(oldISO) - 5000, toMs: Date.parse(oldISO) + 5000 }).total === 1
  && AS.archiveSummary(7, '', { fromMs: Date.now() - 5000, toMs: Date.now() + 5000 }).total === 2);

console.log('\n[2c] 周报正文（纯服务端，零编造）');
const inLast = new Date(lastRange.fromMs + 3600 * 1000).toISOString();
const WR = new Function('const state={archives:[' + [
  `{taskId:'task_a',taskName:'签到',at:'${inLast}',ok:true,body:'a1'}`,
  `{taskId:'task_a',taskName:'签到',at:'${inLast}',ok:true,body:'a2'}`,
  `{taskId:'task_b',taskName:'领奖',at:'${inLast}',ok:false,body:'b1'}`,
  `{taskId:'task_c',taskName:'本周任务',at:'${nowISO}',ok:true,body:'c1'}`,
].join(',') + ']};' + WEEK_SRC + '\nreturn buildWeeklyReport;')();
const repLast = WR();
ok('默认按上一自然周统计', repLast.mode === 'last' && repLast.summary.total === 3, repLast.mode + ' / ' + repLast.summary.total);
ok('标题标明自然周与区间', /CronHub 周报 \d\d\.\d\d-\d\d\.\d\d（自然周）/.test(repLast.text), repLast.text);
ok('周报含标题与汇总', /执行 3 次 · 成功 2 · 失败 1 · 成功率 67%/.test(repLast.text), repLast.text);
ok('周报逐任务列出成/败', /签到 2次 成2\/败0/.test(repLast.text) && /领奖 1次 成0\/败1/.test(repLast.text), repLast.text);
ok('失败时提示查明细', /上周 1 项任务出现失败/.test(repLast.text) && /数据归档/.test(repLast.text), repLast.text);
ok('本周记录不混进上周', !/本周任务/.test(repLast.text), repLast.text);
const repThis = WR({ week: 'this' });
ok('week:this 只算本周', repThis.mode === 'this' && repThis.summary.total === 1 && /本周任务/.test(repThis.text), repThis.text);
const repRoll = WR({ week: 'rolling', days: 7 });
ok('week:rolling 兼容旧滚动口径', repRoll.mode === 'rolling' && repRoll.summary.total === 1 && !/自然周/.test(repRoll.text), repRoll.text);
ok('周报是纯文本无 markdown 表格', !/\|.*\|/.test(repLast.text), repLast.text);

console.log('\n[3] 归档开关');
const EN = new Function(SRC.slice(SRC.indexOf('const archiveEnabled ='), SRC.indexOf('/** 写一条归档')) + '\nreturn {archiveEnabled};')();
ok('老任务默认归档', EN.archiveEnabled({ config: {} }) === true);
ok('显式 false 关闭', EN.archiveEnabled({ config: { archive: { enabled: false } } }) === false);

console.log('\n[3b] 任务级随机延迟');
const RD = new Function(
  'const taskSchedules=(t)=>t.schedules||[{mode:"cron",cron:"0 9 * * *"}];'
  + SRC.slice(SRC.indexOf('function randomDelayMs('), SRC.indexOf('/** 多节奏任务取'))
  + '\nreturn {randomDelayMs};')();
ok('未配置不延迟', RD.randomDelayMs({ config: {} }) === 0);
ok('区间内随机：min=max 定点', RD.randomDelayMs({ config: { randomDelaySec: { min: 7, max: 7 } } }, () => 0.5) === 7000);
ok('区间内随机：取上界', RD.randomDelayMs({ config: { randomDelaySec: { min: 10, max: 20 } } }, () => 0.999) === 19990);
ok('超过 3600 被 clamp', RD.randomDelayMs({ config: { randomDelaySec: { min: 0, max: 99999 } } }, () => 1) === 3600000);
ok('interval 任务不延迟（防周期漂移）', RD.randomDelayMs({ schedules: [{ mode: 'interval', everyMinutes: 5 }], config: { randomDelaySec: { min: 5, max: 5 } } }) === 0);
ok('computeNextRun 叠加偏移', (() => {
  const CN = new Function(
    'const taskSchedules=(t)=>t.schedules||[{mode:"cron",cron:"0 9 * * *"}];'
    + 'const nextRunOf=()=>new Date("2026-11-22T09:00:00Z");'
    + 'const randomDelayMs=(t)=>30000;'
    + SRC.slice(SRC.indexOf('function computeNextRun('), SRC.indexOf('/* ---------------------------------------------------------------- 通知通道'))
    + '\nreturn {computeNextRun};')();
  const t = { config: { randomDelaySec: { min: 30, max: 30 } } };
  return CN.computeNextRun(t, new Date('2026-11-22T08:00:00Z')).toISOString() === '2026-11-22T09:00:30.000Z';
})());
ok('清洗代码 clamp min/max', /config\.randomDelaySec = \{ min: rmin, max: rmax \}/.test(SRC) && /Math\.min\(3600/.test(SRC));

console.log('\n[4] 正文透传字段 noticeRaw');
const rawCfg = H.sanitizeHttpConfig({ url: 'https://e.com', noticeRaw: 'text', aiEnabled: false });
ok('noticeRaw 原样保留', rawCfg.noticeRaw === 'text', rawCfg);
ok('长度截断', H.sanitizeHttpConfig({ url: 'https://e.com', noticeRaw: 'x'.repeat(200) }).noticeRaw.length === 60);
ok('不配则不落库', H.sanitizeHttpConfig({ url: 'https://e.com' }).noticeRaw === undefined);

console.log('\n[5] 只读 Open API');
const OA = new Function('crypto',
  'const state={settings:{openApi:{enabled:true,tokenHash:""}}};'
  + SRC.slice(SRC.indexOf('const openApiHits = new Map()'), SRC.indexOf('function publicState('))
  + '\nreturn {openApiTokenHash,openApiAuthed,openApiTasks,state};')(require('crypto'));
const tkn = 'crh_testtoken123';
OA.state.settings.openApi.tokenHash = OA.openApiTokenHash(tkn);
ok('哈希稳定且非明文', OA.openApiTokenHash(tkn) === OA.openApiTokenHash(tkn) && OA.openApiTokenHash(tkn) !== tkn);
ok('正确 Bearer 通过', OA.openApiAuthed({ headers: { authorization: 'Bearer ' + tkn } }) === true);
ok('错误 Token 拒绝', OA.openApiAuthed({ headers: { authorization: 'Bearer wrong' } }) === false);
ok('无 Authorization 拒绝', OA.openApiAuthed({ headers: {} }) === false);
ok('关闭后拒绝', (() => { OA.state.settings.openApi.enabled = false; const r = OA.openApiAuthed({ headers: { authorization: 'Bearer ' + tkn } }); OA.state.settings.openApi.enabled = true; return r === false; })());
ok('限流：61 次起拒绝', (() => {
  OA.state.settings.openApi.tokenHash = OA.openApiTokenHash('crh_ratelimit');
  let last = false;
  for (let i = 0; i < 61; i++) last = OA.openApiAuthed({ headers: { authorization: 'Bearer crh_ratelimit' } });
  return last === false;
})());
ok('只读端点只用 GET（路由含 405 拦截）', /method !== 'GET'[\s\S]{0,80}405/.test(SRC));
ok('settings PUT 忽略 openApi 回写', /if \(has\('openApi'\)\) next\.openApi = state\.settings\.openApi/.test(SRC));
ok('tokenHash 不出现在脱敏出口', /out\.openApi = \{ enabled: !!oa\.enabled, createdAt: oa\.createdAt \|\| '', configured: !!oa\.tokenHash \}/.test(SRC));

if (failures) { console.log(`\n失败 ${failures} 项`); process.exit(1); }
console.log('\n全部通过');
