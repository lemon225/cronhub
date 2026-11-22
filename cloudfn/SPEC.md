# 脚本云函数编写规范 · cloudfn-v1

给 AI 与维护者共用的唯一契约。读本文件即可写出新脚本与对应任务配置，不需要读 `server.js`。

## 1 分工

| 层 | 负责 | 改动代价 |
|---|---|---|
| 站内 `settings.envVars` | 静态 KV：`SCRIPT_BASE`、`SCRIPT_SECRET`、第三方 API Key | 改设置页变量，0 部署 |
| 本云函数 | 变量加工、派生变量、脚本逻辑、转发上游 | 改 `_worker.js` → 部署 CF，站点 0 改动 |
| CronHub 任务 | 一个 HTTP 步骤，POST 到云函数 | 加/改任务配置，0 部署 |

站内 `applyEnvVars()` 只替换 `{{纯单词}}` 且仅当同名变量存在；含管道、空格、引号的表达式会**原样透传**给云函数。这是零改站接入点。

## 2 占位符语法

统一用**双花括号**。单花括号 `{tomorrowtime}` 会和 JSON 对象的 `{}` 撞车，不要用。

```
{{名字}}                               取变量
{{ now | addDays(1) | format('YYYY-MM-DD 08:00:00') }}
{{ today | urlencode() }}
```

- 管道用 `|`，函数参数写圆括号，字符串用单引号或双引号，参数间用逗号。
- 引号内的 `|` `,` 不当分隔符。
- 变量名不分大小写（`{{TOMORROWTIME}}` 等价于 `{{tomorrowtime}}`）。
- 变量或函数不存在时**占位符原样保留**，不报错；`proxy` 会因此返回 `unresolved_var`，便于排错。
- 派生变量名不要和站内 `envVars` 同名，否则会被站内先替换掉。

### 内置源

| 源 | 值 |
|---|---|
| `now` / `today` | 当前毫秒时间戳 |
| `tomorrow` / `yesterday` | 当前 ±1 天的毫秒时间戳 |
| `timestamp` | 当前秒 × 1000（毫秒） |
| 数字 | 直接当时间戳 |

### 内置函数

| 函数 | 作用 |
|---|---|
| `addDays(n)` `addHours(n)` `addMinutes(n)` | 时间平移，n 可为负 |
| `parseDate()` | 日期字符串 → 毫秒时间戳 |
| `format('pattern')` | 按固定时区格式化 |
| `date()` `time()` | `YYYY-MM-DD` / `HH:mm:ss` |
| `weekday()` | `星期X` |
| `timestamp()` | 毫秒 → 秒 |
| `urlencode()` `upper()` `lower()` `trim()` | 字符串处理 |
| `default(v)` `prefix(v)` `suffix(v)` | 兜底与拼接 |
| `json()` | 转成 JSON 字符串 |

`format` 支持 `YYYY MM DD HH mm ss d ddd dddd X x`。例如 `format('YYYYMMDD')`、`format('dddd')`。

### 时区

默认 `Asia/Shanghai`（固定 UTC+8，无夏令时），由 `TZ_OFFSET_MINUTES` 覆盖（分钟，−720~840）。**不要用 `toISOString()` 或依赖运行时本地时区**：CF Worker 跑在 UTC，直接取 UTC 日期会差 8 小时，`tomorrow` 在 08:00 前后会算错。所有日期一律走 `shiftParts()` / `formatAt()`。

## 3 请求契约

```
POST {{SCRIPT_BASE}}/v1/<script>
x-script-secret: {{SCRIPT_SECRET}}
Content-Type: application/json
```

```json
{
  "vars": {
    "city": "北京",
    "tomorrowtime": { "expr": "now | addDays(1) | format('YYYY-MM-DD 08:00:00')" },
    "today":        { "expr": "now | date()" },
    "dayParam":     "{{tomorrowtime | urlencode()}}"
  },
  "input": {
    "template": {
      "url": "https://api.example.com/w?date={{dayParam}}&city={{city}}",
      "method": "GET",
      "headers": "{\"X-Date\": \"{{today}}\"}",
      "body": ""
    }
  }
}
```

- `vars` 字符串＝静态值；`{ "expr": "..." }`＝派生变量；静态值里也能写 `{{...}}` 再引用已算出的变量。
- `input` 是脚本入参；`template` 也可直接放顶层（兼容）。
- 静态值先算，派生变量其次，静态值里的模板最后展开；派生变量之间不要互相引用。
- 响应统一 `{ ok, script, ver, data, summary, code, error, logs, durationMs }`；成功 200，鉴权 403、未知脚本 404、脚本 `ctx.fail()` 或上游非 2xx 返 500（让 CronHub 的 `expectStatus:200` 触发失败统计与告警）。

## 4 脚本契约

新脚本＝在 `_worker.js` 的 `SCRIPTS` 里加一项。复制这个模板：

```js
  'my-script': {
    describe: '一句话说明，AI 与 /__health 都会读',
    async run(ctx) {
      const tpl = ctx.input.urlTemplate;
      if (!tpl) return ctx.fail('missing_urlTemplate', '缺少 input.urlTemplate（可含 {{...}}）');
      const url = ctx.render(String(tpl));
      if (url.indexOf('{{') >= 0) return ctx.fail('unresolved_var', '模板仍有未解析占位符');
      ctx.log('fetch', url);
      const r = await ctx.fetch(url);
      const data = await r.json();
      return ctx.ok({ result: data }, 'my-script 完成');
    },
  },
```

`ctx.render()` 只吃字符串模板，变量来自 `vars`；`input` 是脚本入参，不是变量源。

### ctx API

| 成员 | 说明 |
|---|---|
| `ctx.input` | 请求体 `input` 对象 |
| `ctx.vars(name?)` | 不传＝全部已解析变量；传名字＝取单个（不分大小写） |
| `ctx.render(text)` | 用已解析变量渲染模板 |
| `ctx.fetch(url, init)` | 带超时的 fetch，上限 `UPSTREAM_TIMEOUT_MS`（默认 25s） |
| `ctx.time` | `{ now, offsetMin, timezone, format(pattern, ts?) }` |
| `ctx.log(...)` | 写入响应 `logs`（最多 30 条） |
| `ctx.ok(data, summary)` | 成功返回 |
| `ctx.fail(code, message, data?)` | 失败返回，HTTP 500 |
| `ctx.env` | 只暴露非敏感的运行参数 |

内置脚本：`vars-echo`（核对变量）、`proxy`（渲染模板后转发上游）、`aggregate-json`（≤5 个上游串行聚合成一个对象）。

## 5 自定义函数

在 `_worker.js` 的 `FUNCS` 表加一行，或在引擎区间之后调用 `registerFunc()`：

```js
registerFunc('quarter', (value, args, ctx) => {
  const p = ENGINE.shiftParts(value, ctx.offsetMin);
  return 'Q' + (Math.floor(p.mo / 3) + 1) + ' ' + p.y;
});
```

约束：同步、纯函数、不发起网络请求、不读 `env` 里的密钥、不修改入参。签名固定 `(value, args, ctx)`。加完在 `tests/cloudfn.test.cjs` 补一条断言。

## 6 安全边界

- 独立 Pages 项目 `cronhub-scripts`，**不与 `cronhub-sms-relay` 共用脚本或密钥**：中继是唯一短信出口。
- 只走 `*.pages.dev`；`*.workers.dev` 已被定向阻断。部署用根目录 `_worker.js` advanced mode + Wrangler 3.28。
- `SCRIPT_SECRET` / `SCRIPT_KEYS` 只能在 Cloudflare 控制台设（现有令牌 `PUT .../settings` 返 405），不写进源码、不写进 `D:\Temp`。
- 禁止 `eval` / `new Function` 执行外部传入的代码；脚本必须是源码里的白名单项。把脚本正文放 KV 动态加载属于远程代码执行通道，需单独授权。
- 不回打 `/api/wake`（tick 回环）；回打站点必须带 `?sharecode=<sharecode>`。
- 响应里不回显完整密钥；`vars-echo` 对含 SECRET/TOKEN/KEY/PASS/CRED 的键自动打码。
- 调度源只有 CronHub：不在 CF 给同一脚本再挂 Cron，否则双跑。脚本要幂等。

## 7 部署与接入

```bash
mkdir -p pages-adv
cp cloudfn/_worker.js cloudfn/index.html pages-adv/
CLOUDFLARE_API_TOKEN=<Pages:Edit> CLOUDFLARE_ACCOUNT_ID=<CF_ACCOUNT_ID> \
  node <wrangler3.28>/bin/wrangler.js pages deploy pages-adv --project-name cronhub-scripts
curl -s https://cronhub-scripts.pages.dev/__health
```

CF 控制台设 `SCRIPT_SECRET`（逗号分隔可多密钥）、`TZ_OFFSET_MINUTES=480`、`UPSTREAM_TIMEOUT_MS=25000`。

站内设置页加两个环境变量：`SCRIPT_BASE=https://cronhub-scripts.pages.dev`、`SCRIPT_SECRET=<同一个>`。任务配置：

```
URL     {{SCRIPT_BASE}}/v1/proxy
方法    POST
headers {"Content-Type":"application/json","x-script-secret":"{{SCRIPT_SECRET}}"}
body    第 3 节的 JSON
期望    200    超时 30s
```

站内 `applyEnvVars()` 会替换 `SCRIPT_BASE` / `SCRIPT_SECRET`，把 `{{tomorrowtime}}` 等原样留给云函数。**`server.js` 不需要任何改动**。

## 8 AI 交付三件套

生成新脚本时一次给齐：

1. 粘贴进 `SCRIPTS` 的代码片段（含 `describe` 与 `ctx.ok/ctx.fail`）。
2. 任务配置 JSON（`vars` + `input.template`），占位符全用双花括号。
3. 自检结果：表达式是否只用内置源/函数、是否有未定义变量、日期是否走 `format()`、是否触碰安全边界、对应测试用例是否补上。

### 自检清单

- [ ] 用 `{{...}}` 双花括号；无单花括号占位符
- [ ] 时间计算走 `now`/`addDays`/`format`，没有 `toISOString()`、`Date` 本地方法
- [ ] `vars` 里派生变量用 `{ "expr": ... }`，静态值用字符串
- [ ] 失败路径都有 `ctx.fail(code, message)`
- [ ] 没有把密钥写进 `data` / `logs` / `summary`
- [ ] `npm test` 全通，`GET /__health` 能看到新脚本名

## 9 相关文件

`cloudfn/_worker.js`（唯一运行文件）、`cloudfn/index.html`（Pages 静态占位）、`cloudfn/examples.js`（三个可复制片段）、`tests/cloudfn.test.cjs`（引擎与 Worker 回归）、`docs/RELAY.md`（CF 部署踩坑）。
