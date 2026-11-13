# CronHub 更新记录

> 倒序排列。`build` 与 `/api/health` 的 `build` 字段一致，可直接核对线上跑的是哪一版。
> 线上地址：<https://cronhub.app.workbuddy.host/?sharecode=ZDRK2MO6CP>
> 中继技术文档见 `docs/RELAY.md`。

---

## 2026-11-13 · 第十八批 · `audit-batch-18` · 看得见（运行指标 + 死信水位）

**主题**：不改任何调度行为，只解决「出事之后能不能判断」。
原有界面只有累计数（跑过 200 次、失败 7 次）和一条条日志，回答不了真正会被问到的三个问题：
「今天下午是不是整体变慢了」「失败是零星抖动还是从 14:00 起全挂」「重试救回来几次，还是每次都靠人补」。

### ① 运行指标：24 小时 × 5 分钟桶

- `state.metrics.buckets` 只存计数（ok / fail / retry / dl + 耗时分母分子），288 个桶约 20KB，随 state.json 落盘 —— **重启不清零**，否则「昨天夜里稳不稳」永远查不到
- 主页统计卡下面新增一条指标带：每小时一根柱，**有失败的小时标红**，空小时留一截灰底桩（区分「0 次」和「没数据」）
- 柱子悬停给出该小时的成功/失败/救回/平均耗时；下方一行 24h 成功率、平均耗时、最近 1 小时
- `/api/state.metrics` 给小时柱（前端不做聚合，口径只在服务端一处）；`/api/health.metrics` 只给汇总
- 时间回拨（对时、DST）时新桶按「落后于当前桶就记到当前桶」处理，避免环形缓冲被旧时间戳占满

### ② 重试救回单独计数

以前重试成功只在日志里写一行「第 2 次尝试成功」，混在几百条日志里没人看得到。
现在每次 `ok && attempts > 1` 额外记一笔 `retry`，指标带直接显示「重试救回 N」——
**失败数说明有抖动，救回数说明抖动被自愈了**，两个数混在一个里就读不出结论。

### ③ 死信水位告警

死信队列以前只进不出、无人看：每失败一条推一条站内通知，混在几十条正常通知里，
真到「短信通道整体挂了、一晚上 20 条」时反而没人能判断这是故障还是偶然。

- 分档 `5 / 10 / 20 / 35 / 50`，**跨档才推一次**，档位写进 `state.deadLetterAlert` 跨重启记忆（否则每次重启重发一遍）
- 启动时也检查一次：进程被回收时队列里已经堆着 30 条，不会等到下一次投递失败才被看见
- 清空或重放降到低水位时档位归零，下次堆积能重新提醒
- `/api/state.deadLetter { count, alertLevel }`、`/api/health.deadLetter { count, alertLevel, max }`，前端死信 chip 在跨档后标红

### ④ 验证

- 新增 `tests/metrics.test.cjs`（26 项）：成功/500/前 500 后 200 三种执行分别落到 ok、fail、retry；小时柱合计等于执行数；重启后指标不归零、桶不膨胀、死信告警不重发；清空死信后档位归零
- `npm test` 4 个用例文件全通（state-durability / catchup / metrics / watchdog）
- 真实渲染核对：桌面 1440 与手机 390 两档，柱子均不溢出、chip 自动换行

**踩坑记录**
- 死信告警如果只在 `pushDeadLetter` 里检查，历史死信要等到「下一次投递失败」才被看见 —— 启动时必须补一次。
- 指标桶不能按「每次写盘都新建桶」，否则同一毫秒内多次执行会各建一桶，24 小时被几百个碎桶塞满。

---

## 2026-11-13 · 第十七批 · 凭据默认打码 + 调度健康可见

**主题**：站点是开放模式（带 sharecode 就能进），链接一传出去，`/api/state` 里的凭据就跟着传出去。
截图、录屏、共享屏幕时的泄露成本，远高于「点一下眼睛」的操作成本。

### ① 出站设置一律打码
- `maskSettings()` 收口：`webhook.token/uuid/fcm`、`gatewaySms.token`、`smsRelay.token`、`smsGatewayRelay.secret`、`tokenVault.refreshToken/accessToken`、`smtp.pass`、`ai.apiKey`、`channelInstances`、`envVars[].value`、`smsActionToken`、`wake.token`
- 看明文走 `POST /api/settings/reveal`（管理口令 + 失败计数，开放模式直接放行但记审计）
- **回存保护**：`isMaskedValue()` 统一识别 `…` / `••••••` / 空串，原样回存 = 不修改。
  少了任何一项，用户只要在设置页点一次保存，凭据就被掩码串覆盖成永久失效 —— 新增打码字段必须同步加进 `keepIfMasked`
- 要回到明文体验：`CRONHUB_CRED_MASK=0` 重启，代码路径保留

### ② 调度健康进 `/api/health.scheduler`
`ticking` / `heldMs` / `stuckCount` / `stuckLimitSec` / `taskDeadlineSec`。
「任务不跑了」以前只能靠人发现，现在一个对象就能看出来。

---



**主题**：把「系统随时可能归零」和「跑着跑着数据没了」这两件事堵掉，并让「错过的任务」既补得上、又不重复跑。

### ① 数据不丢（最关键）
原实现是「写 tmp → rename」，且解析失败只 `console.error` 然后起空状态，第一次写盘就把坏文件覆盖掉 —— JSON 只要坏一次，8 个任务、200 条通知、凭据保险库全部消失，事后连取证机会都没有。

- 写盘改成 `open → write → fsync → close → rename` 四步，tmp+rename 只保证目录项原子，不保证数据页落盘
- 三级备份轮转 `state.bak.1/.2/.3`（默认 12 分钟一份，`STATE_BAK_INTERVAL_MS` 可调）
- 解析失败：先把坏文件改名隔离成 `state.corrupt.<时间戳>`，再从最近一份可解析的备份恢复，并推手机告警；**绝不静默清零**
- `/api/health` 新增 `storage` 快照：fsync 是否生效、备份时间、本次加载来源、是否发生过损坏回退
- 验证：`tests/state-durability.test.cjs` 20/20（截断、清空、全坏三种故障注入）

### ② 进程不倒
- `tickWatchdog`：调度锁被占超过 5 分钟强制释放并告警（此前一个任务卡死 = 调度永久停摆，界面只表现为「任务不跑了」）
- `runTaskGuarded`：单任务总时长上限 150 秒，超时放行调度而不是拖死整轮
- `uncaughtException` 记日志后走受控退出，交给守护重启（原实现捕获后继续跑，状态已不可信）
- `SIGTERM` 给 5 秒 grace 等在途任务收尾，不再硬切
- 新增 `watchdog.cjs`：子进程守护 + 崩溃自愈 + 重启计数（`npm run start:guard`）
- 验证：`tests/watchdog.test.cjs` 全部通过（强杀后自动拉起、新 PID 不同、state.json 仍可解析）

### ③ 错过补跑（可控）—— 本次重点
原来只有 `missedPolicy=run|skip` 两态，且 `run` 是「唤醒后立刻跑」：8 个任务同一秒打向同一个上游，既可能重复执行（那次其实已经跑过，只是没落下 nextRun），又正好是服务方风控最敏感的特征。

现在改成「补，但克制」：

| 判据 | 行为 |
|---|---|
| 错过 ≤ 窗口（默认 120 分钟） | 补 |
| 超过窗口 | 不补，只推进排期 + 通知说明 |
| `lastRun` ≥ 错过时刻 | 不补（那次之后已经跑过，绝不重复） |
| 距上次执行 < 最小间隔（周期 55%，上限 45s） | 不补（防「补跑 + 准点」连打上游） |
| 任务级 `config.noCatchup` | 不补（下单、抽奖类） |
| 单次启动超过上限（默认 5 个） | 丢弃并说明，不做启动风暴 |

- **错过 5 次也只补 1 次**，不补齐历史（补跑不是追债）
- **认领先落盘**：启动时就把 nextRun 推进到未来并写盘，补跑中途被回收也不会再来一次
- **串行 + 随机抖动**（默认 20 秒上限）：同一时刻只有一条请求出去；补跑期间 tick 主动让路
- **补跑后冷静期**：若下一次计划紧贴（< 最小间隔），顺延一次，只错开不改长期节奏
- 设置页可调：开关 / 窗口 / 单次上限 / 最小间隔 / 抖动上限（改完即存，服务端逐项夹紧）
- 任务编辑新增「服务中断后不自动补跑」开关（默认关 = 允许补跑）
- `/api/health` 与 `/api/state` 的 `catchup` 快照：计划几个、补成几个、跳过几个及原因
- 验证：`tests/catchup.test.cjs` 23/23（五类判定的正向与反向都验，含重启幂等与单次上限）

### ④ 工程基建
- `git init` + 基线提交：此前 8600 行核心代码零版本控制，改坏无法回滚
- 测试从 `D:\Temp` 搬进项目 `tests/`，`npm test` 一键跑（3 个用例文件、54 项断言）
- `package.json` 补 `start:guard` / `test` 脚本，`watchdog.cjs` 落在项目根

**踩坑记录**
- 补跑开关最初放在 `#fNotifyOpts` 里，会跟着「任务完成通知」开关一起隐藏 —— 新建任务时根本看不到。它属于「跑不跑」而不是「跑完通知谁」，已挪到通知块之外。
- 判断连接复用不能用 `socket.connecting`（TLS socket 上新建连接也读成 false），要判「这次请求期间有没有真的发生 connect 事件」。

---

## 2026-11-12 · 第十五批 · `audit-batch-15` · 网站 ↔ Cloudflare 联通加固

**主题**：把「网站」和「Cloudflare 中继」之间这条路修好 —— 降延迟、加冗余、让慢的地方看得见。
优化前先测了一遍基线（本地直连中继）：首次请求 1927ms，其中 TCP 519ms + TLS 233ms，
即**每次握手约占 40%**；复用连接后 468ms。

### ① 降延迟：连接复用 + 启动预热

| 改动 | 为什么 |
|---|---|
| `probeSmsRelay` / `guardSmsRelay` 从全局 `fetch`（undici，keepAlive 只有 4s）切到 `lib/http-client.cjs`（keepAlive 60s + DNS 缓存 + TLS 会话复用） | 探针与体检之间只要间隔超过 4s，undici 就扔掉连接，下次又从 DNS + 三次握手 + TLS 重来 |
| 新增 `warmRelay()`：启动 3 秒后预热一次，结果记进 `companion.warm` | 设置页点「自检」、唤醒即陪护这类**交互触发的第一次请求**不用再等握手（线上实测预热 3145ms 一次付清，之后每次 490~1059ms 且 `reused=true`） |
| `lib/sms/send.cjs` 中继模式改用进程内 keepAlive Agent | 同一子进程内的重试 / 换域名 / 换中继都复用握手：实测第一次 1821ms（新建，握手 458ms），第二次 **547ms（复用，握手 0ms）** |

> 说明：真正发短信是短命子进程，本站进程的连接池帮不到它，两条链路各自优化、不混谈。

### ② 加可靠性：主 + 备地址、故障转移、连续失败告警

- `settings.smsGatewayRelay` 新增 `urls`（备用地址数组），`url` 仍是主地址；保存时统一去重、
  **只留 https origin**（明文地址会让短信令牌在公网裸奔），一条坏配置不会废掉整条链路。
- `relayEndpoints()` 是唯一的地址解析入口：发送、探活、体检、`companion` 全走它。
- **发送端故障转移**：`send.cjs` 按顺序试各条中继，传输层失败（连不上 / 5xx / 超时 / DNS 失败）
  立刻换下一条，不等整轮重试。实测「主地址 ENOTFOUND → 立刻切备用成功」。
- **重试粘性**：记住上次真正把请求送到对端的那条中继，下一轮重试优先走它。
  以前每轮都从主地址开始，主地址挂了 3 轮就是 3 次 ENOTFOUND，白等几秒。
- **探活并行**：所有中继同时探，`relay.upCount` 给出「几条通」，最快的标为「当前使用」。
- **连续失败告警**：`guardSmsRelay` 连续失败第 2 次起推 NotifyMe（1 小时内不重复），
  **绝不回落到短信** —— 短信正是那个挂掉的通道。

### ③ 让慢的地方看得见：分段耗时

- `lib/http-client.cjs` 支持可选 `timing` 采集：`reused / connectMs / tlsMs / ttfbMs / totalMs`。
- `send.cjs` 每次发送打一行 `[relay-timing] {...}`，服务端解析后并入 `relayHealth.timing`，
  **再从用户可见的发送结果里剔掉**（诊断信息不进日志正文）。
- 判定「是否复用」只看「这次请求期间有没有真的发生 connect 事件」。**不能用 `socket.connecting`**：
  TLS socket 上这个属性不可靠，新建的 https 连接也会读成 `false`，会把每次新建都标成「复用」——
  诊断结论直接反过来（这个坑是实测踩到的）。
- 设置页中继卡新增「备用地址」输入框与一行状态：`2 条中继（通 1 条） · 当前经 … · 连接复用 · 首字节 909ms`。

### ④ Cloudflare 侧（**2026-11-12 22:54 已上线**）

- `_worker.js` → relay-v3：转发响应带回 `x-relay-upstream-ms`（中继→网关真实耗时）；
  `/__status` 不再回显完整体检 URL（含 sharecode 属凭据），只回 `siteHealthHost`。
- `worker-companion.js` → companion-v3：**转发分支补真超时**（默认 60s，`FORWARD_TIMEOUT_MS` 可调）
  与 504/502 分类。v2 的转发完全没超时，上游半开连接会一直挂到平台超时，把 cron 槽占住。
- 本地用 Node 跑 Worker 的只读分支 5/5 通过（鉴权 403、`/__status` 脱敏、白名单拦截、不泄漏密钥）。
- **上线记录**：旧的 `cfat_` 令牌全部 `401`，换了一把同时含 `Cloudflare Pages:Edit` + `Workers Scripts:Edit`
  的 `cfut_` 令牌后按 §6.2/§6.3 部署。线上校验：`/__status` → `ver: relay-v3`、`siteHealth` 字段已消失
  （只剩 `siteHealthHost`）；转发响应带 `x-relay-upstream-ms: 2372`；Worker `modified_on` 更新、
  `schedules` 仍是 `*/30 * * * *`、`fetch` + `scheduled` 双 handler 都在。
  凭据存放在 `D:\Backuuup\workbuddy\cronhub\cloudflare\`（勿放 `D:\Temp`，会被清理）。

### 验证

- 中继加固用例 **11/11**：规范化、逐条探活、首探新建 / 复探复用、主备切换、全挂累计失败、明文地址剔除。
- 发送端故障转移手动验证：`backup.invalid.example` ENOTFOUND → 自动切主地址 → 第 2 轮复用连接 547ms。
- 真实页面渲染：设置页三个输入框与状态行正常，`js errors: (none)`。
- 线上回归：`build=audit-batch-15`、`assets.warnings=[]`、`/app.js` 与本地产物逐字节一致、
  8 个任务完好、`companion.warm.ok=true`。

---

## 2026-11-11 · 第十四批 · `audit-batch-14` · 全量代码审阅后的可靠性加固

**主题**：不做新功能，先把「看着能跑、出事很难查」的地方补上。审计出的问题按
「会静默丢执行 / 会静默丢配置 / 出事看不出原因」三类归并，分三批修完，最后做故障注入验证。

### 批次 A · 调度并发（会静默丢执行）

| 问题 | 原因 | 修法 |
|---|---|---|
| 手动执行与定时触发撞车 | `/api/tasks/:id/run` 是「先入队、后置 `runningAt`」，中间有窗口；两个 `runTask` 并发写同一 `task` 的结果与通知 | 路由入队**之前**同步占位 `runningAt`；tick 的 due 筛选加上 `!t.runningAt` |
| 一个任务抛错拖死整批 | 整批共用一个 try/catch，任一 `runTask` 在通知段抛错就跳出 for；而 `nextRun` 已在认领阶段推进并落盘，剩余任务**被静默丢掉**，只剩一行 `console.error` | 每个任务单独 try/catch，异常写系统日志（同批其他任务继续） |
| 通知发送失败带崩执行 | 通知 map 无兜底 | 整体 try/catch，失败只记日志 |

### 批次 B · 前端状态（会静默丢配置）

| 问题 | 修法 |
|---|---|
| 渠道 chips 用「当前可选值」过滤任务里存的老值，老任务一保存就把该渠道静默抹掉 | `renderTaskChannelChips` 传入 `legacyValues`（提醒渠道 ∪ 通知渠道的并集兜底），老值渲染成「（旧配置）」标签 |
| 草稿 5 分钟自动过期，用户填一半去接个电话回来草稿没了 | 移除自动过期，改成 `draftBanner()` 顶部条：显示草稿保存时间 + 手动「恢复 / 丢弃」 |
| 编辑弹层反复打开会叠一堆 `focusTimer` | 打开前先 `clearTimeout` 去重 |
| 45s 轮询与手动刷新同时返回，旧响应覆盖新数据 | `refreshKeep(my)` 序号保护，只认最后一次请求 |
| 三处把用户输入/环境 id 直接拼进 HTML | 统一 `esc()` |
| 切换任务类型（提醒 ↔ HTTP）会清掉 AI 要求与消息模板 | 切类型时保留这些跨类型字段 |

### 批次 C · 可观测性（出事看不出原因）

- **静态资源自检**：启动时把 `app.min.js` / `style.css` / `index.html` 的实际状态记进
  `ASSET_STATUS`，`/api/health` 的 `assets` 字段直接可查。三种异常都有兜底与告警：
  产物为空 → 回源 `app.js` 并告警；`style.css` 读不到 → 保留外链；`index.html` 缺 `</html>`
  → 请求时回源磁盘。另加一条**产物过期检测**：`app.js` 比 `app.min.js` 新就告警
  「疑似忘记 node build.js，当前下发旧产物」——这是本项目历史上最容易踩的坑。
- **数据目录降级可见**：`DATA_DIR` 不可写时会在临时目录继续跑，以前这件事只写在日志里；
  现在 `/api/health` 的 `dataDir.fallback` 直接给原因。
- **写盘计数**：`stateWrites` 暴露进 health，用来验证「只读接口不写盘」这类语义。
- **唤醒令牌启动期就绪**：`ensureWakeToken()` 在启动阶段一次性备好，不再等到第一次请求才生成
  （避免并发首个请求各生成一份）。
- **构建产物时间对齐**：`build.js` 写完把 `app.min.js` 的 mtime 对齐源文件，否则「产物比源文件旧」
  的告警会长期误报。

### 批次 D · HTTP 引擎 + 验证

- `lib/http-client.cjs` 的 `readBody()` 改成**无条件**监听底层 `res` 的 `aborted / error / close`。
  原实现只在特定分支挂监听：gzip 响应半途断连时 Promise 永不 settle → `ticking` 锁死 →
  整个调度假死。这是「网站用几天就不跑了」的根因之一。
- **故障注入验证 3/3**：正常基线（`staleBuild=false`、无告警）、`app.js` 比产物新（`staleBuild=true`
  + 启动横幅告警）、`app.min.js` 清空（`js=source` + 回源告警）。
- **单测 54/54**，六个 JS 文件语法全通过；本地 `GET /api/state` 连续两次写盘计数 3→3，只读语义成立。
- 线上回归：`build=audit-batch-14`、`assets.warnings=[]`、`/app.js` 与本地 `app.min.js` 逐字节一致
  （162670B）、HTML 166049B 完整、8 个任务完好。

---

## 2026-11-11 · 第十三批 · `audit-batch-13` · 渠道按方案名显示 + NotifyMe 高级选项

**主题**：把「Webhook」这个技术名词从用户视野里拿掉，并让手机推送能配出大文本、
点击动作、复制、打开应用这些原本只能靠命令行才能设的能力。四条需求逐条落地：

| 需求 | 落地 | 落在哪 |
|---|---|---|
| ① NotifyMe 是主渠道，其次短信，其余备用 | 任务渠道与通知页渠道栏都按「站内 → NotifyMe → 短信 → 其余方案/邮件」排序 | `renderTaskChannelChips()` / `renderInbox()` |
| ② 设置页保留 Webhook，其他地方显示方案名 | 新增 `WH_SCHEME`（服务端）/`WH_SCHEMES`（前端）映射：notifyme → NotifyMe（手机推送）、bark → Bark (iOS)、feishu → 飞书机器人、dingtalk → 钉钉机器人、serverchan → Server酱、generic → 通用 JSON | 渠道 chips、通知记录的渠道名、系统日志、死信标签、`sendWebhook` 的返回文案 |
| ③ 给 FCM 加高级配置框 + 任务级单独设置 | 设置页 NotifyMe 高级区：大文本、点击动作（不动作 / 打开链接 / 打开应用 / 复制到剪贴板 / 提取验证码）、目标值、分组、紧急响铃、**请求体预览**；任务弹层新增「NotifyMe 推送选项」，五项均可「跟随设置页」 | `#whAdvFields` / `#fNmBlock` / `POST /api/notifyme/preview` |
| ④ 站内通知去锁、直接选中、不可取消 | 去掉 `disabled` + 🔒 + 灰底，改成普通选中态；点它会被 `change` 拦回并提示「站内通知是必选项，不能取消」 | `renderTaskChannelChips()` + `.chip--req` |

**顺带修掉的三个真问题**（都不是这次需求引入的，但正好在改动路径上）：

1. **保存 NotifyMe 设置会把老 FCM token 清空** —— `collectChannelConfig` 对 notifyme 格式
   提交 `token: ''`，而线上 `settings.webhook.token` 里存的正是 FCM token。以前只要点一次
   保存，之后所有推送都会报「NotifyMe 格式要填凭据」。现在 notifyme 格式根本不提交这个 key。
2. **独立 `notifyme` 通道永远不会发** —— `channelAllows()` 走 `resolveChannel()`，
   而后者只认 sms/webhook/email/ai，`notifyme` 直接返回 null → 恒 false。
   结果是「任务里勾了 NotifyMe 却一条都不发」，只能靠 webhook 的 notifyme 格式绕。
   现在 notifyme 单独判定（开关 + 凭据 + 时机）。
3. **webhook 的 notifyme 路径拿不到高级选项** —— 那里手写了第二套简化请求体
   （只带 title/body/bigText/group），所以设置里配了点击动作也不会生效。
   现在两条路径共用 `buildNotifyMePayload()`。

**请求体拼装**（`buildNotifyMePayload`，单一来源）：
`bigText` 显式下发；`group` 空则**不带该字段**（Android 才不会把同组折成一条摘要）；
`actionType` 只在非 0 时下发，4/5 这类「收到即执行」的动作不需要 `action`；
`urgent` 自动补 `channel: quicker_channel`（持续响铃依赖它）。

**任务级覆盖**（`config.nmPush`）：只存用户真正填过的字段（`sanitizeNmPush` 空对象返回 null），
发送时 `nmForTask()` 用「任务值 → 全局值」逐项回退。空串/0/undefined 一律视为「没设」，
所以清空下拉就能回到全局值，不用猜哪个才是默认。

**预览接口**：`POST /api/notifyme/preview` 返回真正会发出去的 JSON（凭据打码），
和真实发送共用同一个拼装函数 —— 前端不自己拼，避免「预览说没事、实际发出去字段没了」。

**验证**：渠道标签 16/16（切真实源码跑）、请求体 20/20、静态断验 32/32、
桌面 + 手机 UI 各 36/36、0 JS 错误。

---

## 2026-11-11 · 第十二批 · `audit-batch-12` · 提示词分层 + 机器校验 + 前后对比

**主题**：第十一批上线后任务要求确实进了 system（线上 `aiNote` 已显示「按任务要求」），
但用户仍觉得「要求不生效、优化效果不明显」。用线上同一套模型做了 A/B 对照实验，
发现真正的问题不是「没照做」，而是「照做了也对不上」：

| 实验现象 | 根因 | 修法 |
|---|---|---|
| 同一输入两次输出，油价 5 行 / 4 行，云音乐 1 行 / 6 行 | 温度 0.6 + 没有结构契约，每次排版重新摇骰子 | 温度降到 0.35；提示词加「第一行给结论」等体例约束 |
| 把「92 号 8.89 元/升」写成「92号：8.89升」 | 只写了「不得编造」，没要求保留单位 | 事实纪律单列「数字必须带原单位」，并把丢单位写成反例 |
| 热评通知被加一句「建议理性看待竞技结果」 | 默认要求里「如有必要…提出生活建议」被当成必答项 | 禁止空话清单 + 「建议必须是数据推得出来的具体动作」 |
| 任务要求写到 1413 字就吃满上限 | 保存时硬截 1500 字，尾部（往往正是排版细则）被静默丢弃 | 上限 1500→4000，全局默认 500→2000，前端显示字数并在超限时标红 |
| 写了「每行 ≤24 字」但没人检查 | 规则只写在提示词里，生成后没有任何验证 | 从要求里抽可机检条款，生成后逐条检查，不达标自动纠正一次 |

**提示词结构**（`aiPrompts()`，与预览接口共用同一份，不另写副本）：
先判材料类型（结构化数据 / 长文本）→ 事实纪律 → 禁止的写法 → 体例 → 本任务要求。
任务要求只压「体例」，**压不动事实纪律与禁写底线**；默认要求退到 user 当补充。
长文本明确要求「提炼 2~4 个要点，禁止逐句照抄」—— 之前两类材料共用一套指令，热评类会退化成照抄原文。

**机器校验**（`aiRules()` / `aiReview()`）：抽取 `每行 ≤N 字`、`正文 ≤N 字`、
`每行 1 个 emoji`，加三条通用底线（禁 markdown / 禁空行 / 禁空话）。硬规则不达标
时把「具体违反了哪一条」回灌模型纠正一次；两次调用是上限（默认 attempts=2），
纠正后仍不达标就照发，但 `aiNote` 如实写「M 项未达标：第 2 行 27 字…」。
字数按**去空白**计 —— 按含空白算会把合规输出（每行 17/23/18 字）误判成超长。

**新增可见性**：
- 任务编辑 AI 区加「看实际提示词」：直接展示真实发出去的 system / user + 抽出的校验条款。
- 通知卡片加「看 AI 前的原文」：`rawBody` 落地，一键对比 AI 改了什么。
- `aiNote` 从「按任务要求」升级为「按任务要求，已校验 5 项」/「2 项未达标：…」，可核对而非自我声明。
- 设置页那句「总提示语 = 开头 + 任务要求」已过时，改成「补充要求，优先级低于任务要求」。

**实测**（线上模型 agnes-3.0-flash，真实接口数据）：
油价播报单位保留、区分「现价/预计」、无空话；热评从照抄改为摘要；写死三行排版的任务一次成型。

---

## 2026-11-11 · 第十一批 · `audit-batch-11` · AI 要求真正生效 + 任务级开关

**主题**：用户反馈「任务详情里写的 AI 要求好像不生效，优化结果效果不明显」，并要在任务编辑里加一个是否使用 AI 优化的开关。诊断后确认是三个叠加原因，不是模型问题。

| 根因 | 修复 |
|---|---|
| 全局默认提示语与任务级要求被拼成一行塞在几千字接口事实之后，模型当泛泛的风格建议；而 system 里「正文 ≤160 字 / 禁止分行排版」写死，与任务要求的详细播报冲突，System 权重更高，用户永远输 | 任务级要求**单独进 system**，标记「本任务的硬性要求｜最高优先级」，并显式声明与默认要求或任何其他约束冲突时一律以本节为准；默认要求退到 user 标「补充」 |
| 篇幅/格式写死 + 返回 body 硬截 200 字 + temperature 0.4 偏保守 | system 改为「**未指定**篇幅/排版时才用 160 字与禁 markdown」的默认值，任务要求可覆盖；正文上限放宽，温度提到 0.6；长事实文本之后加一句「再次确认」靠因近效应把要求拉回注意力中心（不复制全文，省 token、不挤占 20s 超时） |
| 没有任务级开关，只能靠全局总开关一刀切 | 任务编辑弹层新增「使用 AI 优化通知文案」开关（`config.aiEnabled`），关闭后该任务完全不调用 AI、要求文本仍保留；任务列表显示 `AI 关` 标记 |

**兼容性**：老任务没存过 `aiEnabled` 一律视为**开启**，与前端回填、后端 `taskAiOn` 判定一致；线上 8 个任务 `aiEnabled` 均为 `null`，行为不变。全局 AI 总开关仍优先，未配置 AI 时走原有 `aiNote` 回退。提醒类任务不显示 AI 区块。

**验证**：本地假 AI 接口抓真实请求体，`smoke11` 38/38 —— 任务要求确实进 system、默认要求在 user、关闭开关时零调用、打开时请求体含完整事实与要求；桌面 1440 与手机 390 真实渲染开关区无溢出、0 JS 错误。线上回归 `build=audit-batch-11`、8 个任务完好、`app.js`/`style.css` 与本地逐字节一致。

---

## 2026-11-10 · 第十批 · `audit-batch-10` · 陪护状态前端可见

**主题**：补上第九批「双向陪护」的最后一公里 —— 状态原本只在 `/api/health` 里，控制中心页面一个字都看不到。

| 改动 | 说明 |
|---|---|
| 共用快照 `companionSnapshot()` | `/api/health` 与 `/api/state` 改调同一函数，两处口径不会再各自漂移；全是元数据，不含任何密钥 |
| `/api/state` 下发 `companion` | 前端 `load()` 读的是这个接口，补上后页面才能拿到 `relay / guard / wake` 三段 |
| 设置页新增「网站 ↔ Cloudflare 双向陪护」卡 | 默认折叠只占一行（桌面 55px），卡头直接给总体结论 + 状态点；展开是四项指标网格 |
| 四项指标 | 上游短信网关 / 中继回探本站 / 最近一次体检 / Cloudflare 唤醒，各带说明行 |
| 「立即体检」按钮 | 调只读 `GET /api/relay/guard`（不发短信、不触发调度），客户端超时 40s，结果就地显示并刷新状态 |
| 状态分级 | 未配置 / 等待首次体检 / 双向正常 / 体检异常 四态，异常时上游原因单独显示，本站说明不借用整条 guard 错误 |
| 403 口径修正 | 网关对探针返回 403 属预期，界面明确标注「探针预期」，判据是连通性而非状态码 |
| 细节 | 原生 `<details>` 保开合态，渲染只写 `textContent` 不重建 DOM，45 秒轮询与编辑门控都不会把展开的卡收回去；手机端卡头两行网格 75px、按钮 40px 热区 |

**验证**：`smoke10` 36/36（静态 + 本地 API + 线上基线）；本地 `/api/state` 与 `/api/health` 的 `companion` 逐字段一致、体检后 `guard.ok` 回填；桌面 1440 与手机 390 真实渲染均无溢出、0 JS 错误，三态降级与按钮往返通过。

**注意**：本地冒烟时中继 `/__guard` 回探的是**线上站点**，所以本地页面显示 `build=audit-batch-9` 属预期，不是数据串了。

---

## 2026-11-10 · 第九批 · `audit-batch-9` · 中继 v2 + 双向陪护

**主题**：优化 Cloudflare 中继流程与代码，补齐技术文档，落地网站与 Cloudflare 相互陪护。

### 中继代码（`relay-v2` / `companion-v2`）

| 改动 | 说明 |
|---|---|
| 新增 `/__guard` | 一次并行体检「CF → 网关」与「CF → 网站」，两侧都通才回 200，任一侧失败回 502 |
| 新增 `/__status` | 版本、配置态、超时参数、端点清单；响应头 `x-relay-ver` 全程可查 |
| 修密钥泄露 | v1 会把浏览器探针用的 `?key=` 原样转发给短信网关；v2 转发前删除 `key/relay_key/relay_secret` |
| 统一超时 | 新增 `timedFetch()`，探针/站点/唤醒/转发四类超时可配、真取消；v1 的转发完全没有超时 |
| 错误分类 | `errorKind` = `timeout` / `network` / `config`；超时回 504，网络错回 502 |
| 唤醒令牌解耦 | 拆成 `WAKE_BASE` + `WAKE_TOKEN`，支持环境变量覆盖；换令牌不再需要改代码重部署 |
| 唤醒结果结构化 | 新增 `site{status,ms,wokeAt,count,ranNow}`，保留 `body` 兼容旧调用方 |
| 定时陪护 Worker | `scheduled()` 加 15s 真超时、耗时/次数/错误分类日志；可选 `GUARD_URL` 顺带双向体检；日志标 `companion-v2` |
| 说明页 | `relay/index.html` 从 `diag static ok` 换成中文状态页（不含密钥） |

### 网站侧（`server.js`）

- `guardSmsRelay()`：打中继 `/__guard`，把结果记进 `relayHealth` / `relayGuard`；只在状态由通转不通时写一条 warn 系统日志。
- `/api/health` 新增 `companion`：`configured` / `relay` / `guard` / `wake`，运维与 CF 回探都能一眼看到双向状态。
- 新增手动端点 `GET /api/relay/guard`（只读探针，不触发调度、不发短信）。
- **唤醒即陪护**：`/api/wake` 被 CF 叫醒后 fire-and-forget 打一次 `/__guard`（容器若立刻回收就丢这轮，有其它触发点兜底）。
- 每小时钩子增加一次 `guardSmsRelay()`。
- 线上「服务健康自检每天」第二步由 `/__probe` 改为 `/__guard`（超时 15 → 25s，鉴权头与通知策略保持不变，原任务已备份到 `D:/Temp/2026-11-10-cronhub-b8/selfcheck-before.json`），此后每日自检直接按 HTTP 状态码判定双向健康并在失败时推手机。
- **防回环设计**：`/__guard` 只回打 `/api/health`，绝不打 `/api/wake`；`guardSmsRelay()` 有互斥锁。

### 文档与部署

- 新增 `docs/RELAY.md`：架构图、两个部署分工、已否证路线、端点表、双向陪护时序、可复现部署命令、令牌轮换 Runbook、排障手册、单点风险。
- 新增本文件 `docs/CHANGELOG.md`；`README.md` 增加中继章节索引。
- 源码收进项目 `relay/`（此前只在 `D:/Temp/`），旧版备份留在 `D:/Temp/2026-11-08-cloudflare-relay/`。
- Pages 中继用 Wrangler 3.28 重新部署；Workers `sms-relay` 用 API 重新上传，核对 `handlers=["fetch","scheduled"]` 与 Cron `*/30 * * * *` 均完好。

### 验证

- 中继本地回归 `relay-test/local.mjs`：**30 / 30 PASS**（含超时取消、密钥不外泄、站点失败回 502、令牌变量覆盖、scheduled 日志）。
- 第九批冒烟 `smoke9.js`：**41 / 41 PASS**（静态 + 本地 API + 线上闭环）；`smoke4/5/6/7/8` 各只剩一条「写死旧 build 号」的预期 FAIL。
- 线上五个端点实测：`/__status` 200 `relay-v2`、`/__probe` ok、`/__guard` 200 且带回站点 build、`/__echo` 200、`/__wake` 200 且站点 count 递增。
- **线上闭环实测**：网站 `/api/relay/guard` → `ok:true`；中继 `/__guard` 回探看到站点 `build=audit-batch-9`、`companion.relay.src=guard`、`wake.count=125`。`app.js` / `style.css` 与本地逐字节一致。
- Workers 上传响应 `handlers=["fetch","scheduled"]`，Cron `*/30 * * * *` 完好；`/relay/_worker.js` 等源码路径线上返回 404（静态白名单）。

---

## 2026-11-10 · 第八批 · `audit-batch-8` · 主页紧凑 / 间隔单位 / 任务组

| 需求 | 落地 |
|---|---|
| 主页「即将执行」太松散 | 行高压到 46–47px；显示内容不变，只压紧间距 |
| 时间显示简化 | 倒计时改约数：`2 分` / `11 分` / `约 1 时` / `约 3 时`，不再精确到「2 时 41 分后」 |
| 间隔调度加单位与开始时间 | `every` + `unit`（分 / 时 / 日 / 周 / 月）+ `startAt`；服务端按锚点算下次执行，越界夹紧、单位与锚点参与去重 |
| 任务列表加任务组 | `task.group` 自由文本（≤24 字），列表按组插标题、可折叠，折叠态存 localStorage，拖动限制在组内 |

- 表单预览实时显示「→ 每 3 周 ｜ 从 11-20 08:15 开始」；手机端 390px 节奏行 129px、无横向溢出。
- 冒烟 `smoke8` **26 / 26 PASS**；`smoke4/5/6` 回归唯一 FAIL 都是写死的旧 build 号。
- 部署后线上 5 个任务完好，自检里的 relay 探针步骤仍在，`app.js` / `style.css` 逐字节一致。

---

## 2026-11-10 · 第七批 · `audit-batch-7` · 任务列表手机端重排

- 左侧多选框默认隐藏，工具栏加「批量」开关；去掉「接下来：…」折行与方形缩略图。
- 窄屏从三列 grid 改单列 flex：标题顶格，下面统一缩进 28px（两个汉字）；标题起点 108 → 33px，卡片高 182 → 167px。
- 底部按钮手机 42 → 48px、桌面 38 → 42px。
- 置顶改微信式：细线图钉 SVG + 浅灰整条 + 绿色开关态，去掉 📌 emoji。
- `smoke7` 20/20；批量开关、置顶点击、长按拖动换位落库均实测通过。

## 2026-11-09 · 第六批 · `audit-batch-6` · 八项界面与配置

- 任务编辑状态码/重试两两并排，手机端行高 163 → 82px；打开编辑不再抢焦点弹输入法。
- 删除冗余的独立 `relay` 任务（自检任务第二步已含 `/__probe`），线上从 5 个变 4 个任务。
- AI 超时/重试可配：`settings.ai.timeoutMs`（默认 20s）、`maxAttempts`（默认 2），`/api/health` 新增 `aiPolicy`。
- 拖动排序改走 touch 事件，修掉 `touch-action:pan-y` 导致被页面滚动打断的真 bug。
- 通知页去掉「手机推送」（与 Webhook 同一出口）；短信卡把中继/SNI/诊断收进折叠。
- 设置页重排为 4 个分组 + 6 张默认全折的卡，展开态折叠头退成右上角「收起」。
- `smoke6` 21/21；线上静态资源逐字节一致。

## 2026-11-09 · 第五批 · `audit-batch-5` · 日志 / 告警 / 拖拽 / 弹层

- 日志保留 7 天（按时间裁 + 条数上限并存）；`failCount` 改连续失败、成功归零，第 3/10/20… 次告警。
- AI 超时 5s → 20s，修掉「第一次必失败、第二次正常」；失败回退标注原因类别。
- 实现长按拖动排序，修 `onMove` 换位方向写反的真 bug。
- 任务渠道 chips 补「老值兜底」，避免保存时静默抹掉老任务的 `notifyme` 渠道。
- 设置卡未配置默认折叠；窄屏任务卡 grid 三列、URL 单行省略、弹层保存/取消改内联。
- `smoke5` 15/15、线上 16/16。

## 2026-11-09 · 第四批 · `audit-batch-4` · 任务级失败自动重试

- `config.retry={times:0-3,delayMs}`，**默认 0 关闭**（签到/下单重试等于执行两次）；只重试无状态码 / 5xx / 408 / 429。
- 重试可见性：warn 系统日志、`lastResult.attempts`、任务卡 `↻ 重试 N×` pill。
- `smoke4` 19/19（假上游 503×2→200 重试成功、404 零重试）。

## 2026-11-09 · 第三批 · `audit-batch-3` · 落盘写放大

- 定位根因：自保活每次 ping 触发两次全量写；引入 `flushState()` / `saveState()` / `saveStateLazy()` 三级落盘 + sha1 内容指纹去重。
- 线上写盘约 170 → 48 次/小时（降 72%）；成功的 `GET /api/health` 不再入系统日志。
- 心跳 60s → 120s；`.next-when` 修窄屏折行。

## 2026-11-09 · 第一、二批 · `audit-batch-1` / `2` · 五视角审查

- HTTP 引擎换成 `lib/http-client.cjs` 常驻连接池 + DNS 缓存；OPTIONS 预热把定时任务从 1161ms 降到 275ms。
- `runningAt` 清理移入 `finally`；私网 URL 防护默认关；`renderAll()` 编辑草稿门控；配色令牌达 WCAG AA。
- `/api/sms/agent/*` 下线返回 `410 Gone`；访问日志按 `(method,path,status)` 5 分钟聚合。

## 2026-11-08 · 基础设施

- **Cloudflare Pages 短信中继打通**，成为唯一短信出口（直连网关与 workers.dev 两条路线已否证）。
- `RESULT_BODY_MAX=8000` 保留完整响应正文；执行日志恢复「头部一行 + 正文块」+ 三行折叠 + 内联「展开全部 / 复制」。
- 用户授权：以后改完直接部署上线，不用每次确认。
