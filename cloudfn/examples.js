/* 可复制片段，不参与运行。Pages 部署只上传 _worker.js 与 index.html。
 * 复制时按 SPEC.md 第 8 节给齐「脚本片段 + 任务配置 + 自检结果」三件套。
 */

/* ① 变量加工：把「今天算明天并调整格式」写成一行派生变量 */
const DATE_VARS = {
  city: '北京',
  tomorrowtime: { expr: "now | addDays(1) | format('YYYY-MM-DD 08:00:00')" },
  tomorrowDate: { expr: 'now | addDays(1) | date()' },
  todayStamp:   { expr: 'now | timestamp()' },
  weekdayCn:    { expr: 'now | weekday()' },
  dayParam:     '{{tomorrowtime | urlencode()}}',
  display:      '{{city}} · {{tomorrowDate}} · {{weekdayCn}}',
};

/* ② CronHub 任务配置（站内零改动，环境变量只存 SCRIPT_BASE / SCRIPT_SECRET）
 * URL     {{SCRIPT_BASE}}/v1/proxy
 * 方法    POST    期望 200    超时 30s
 * headers {"Content-Type":"application/json","x-script-secret":"{{SCRIPT_SECRET}}"}
 */
const PROXY_TASK = {
  vars: DATE_VARS,
  input: {
    template: {
      url: 'https://api.example.com/weather?date={{dayParam}}&city={{city}}',
      method: 'GET',
      headers: '{"X-Date": "{{tomorrowDate}}", "X-Trace": "{{display}}"}',
      body: '',
    },
  },
};

/* ③ 多接口聚合：一个任务串起 ≤5 个上游，站点只收一个结构化结果 */
const AGGREGATE_TASK = {
  vars: { today: { expr: 'now | date()' } },
  script: 'aggregate-json',
  input: {
    calls: [
      { name: 'weather', url: 'https://api.example.com/w?d={{today}}' },
      { name: 'oil', url: 'https://api.example.com/oil?d={{today}}' },
    ],
  },
};

/* ④ 自定义脚本片段：粘贴进 _worker.js 的 SCRIPTS 表 */
const SCRIPT_SNIPPET = {
  describe: '把上游数组压成 {count, first} 摘要',
  async run(ctx) {
    const tpl = ctx.input.urlTemplate;
    if (!tpl) return ctx.fail('missing_urlTemplate', '缺少 input.urlTemplate');
    const url = ctx.render(String(tpl));
    if (url.indexOf('{{') >= 0) return ctx.fail('unresolved_var', '模板仍有未解析占位符');
    ctx.log('fetch', url);
    const r = await ctx.fetch(url);
    if (!r.ok) return ctx.fail('upstream_status', '上游返回 ' + r.status);
    const rows = await r.json();
    const list = Array.isArray(rows) ? rows : (rows.data || []);
    return ctx.ok({ count: list.length, first: list[0] || null }, '摘要完成');
  },
};

/* ⑤ 自定义函数：整行粘贴到 _worker.js 引擎区间之后
 * 文件里 ENGINE 与 registerFunc 都是顶层常量，直接可用；函数必须同步、无 IO。
 *
 *   registerFunc('quarter', (value, args, ctx) => {
 *     const p = ENGINE.shiftParts(value, ctx.offsetMin);
 *     return 'Q' + (Math.floor(p.mo / 3) + 1) + ' ' + p.y;
 *   });
 */
