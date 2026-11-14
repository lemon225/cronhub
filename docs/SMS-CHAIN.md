# CronHub 短信链路技术档案

> 定位：记录**结论性事实**与**可复跑的判据** —— 为什么必须这么设计、出问题怎么一眼判断。
> 操作步骤看 [`RELAY.md`](RELAY.md)（端点、部署、轮换 runbook）；逐批改动看 [`CHANGELOG.md`](CHANGELOG.md)。
> 本文随代码同仓维护，版本与线上 `build` 对齐。**不要再把这类结论写回会话记录或 `D:\Temp`。**
>
> 对应版本：`relay-v4` · 站点 `audit-batch-21` · 2026-11-14

---

## 1. 一句话

短信只有一条出口：**网站 → `cronhub-sms-relay.pages.dev`（Cloudflare Pages 中继）→ `5gvas01.cmicmaap.com`**。
通道健康**只由「CF → 网关」这一腿决定**；站点回探腿只作参考，不参与判定、不触发告警。

---

## 2. 根因：拦截发生在 TLS 层，按出口 IP 命中

这不是 DNS 污染、不是端口封锁、也不是代码写错。证据链如下，全部为实测：

| # | 发起方 | 目标 | 结果 | 说明 |
|---|---|---|---|---|
| 1 | 本机住宅宽带（Node 同一 TLS 栈） | `5gvas01.cmicmaap.com:443` | **TLS 成功**，HTTP `403` | 网关在线、证书正常；403 是「没带业务凭据」的正常拒绝 |
| 2 | 云端托管实例 | 同上 | TCP 12ms 通 → **TLS 12ms 被 RST** | `disconnected before secure TLS connection was established` |
| 3 | 云端托管实例 | 同上，6 组 SNI 轮换（原名/空/baidu/idaas/notifyme/cloudflare） | 全部 `ECONNRESET` 25–36ms | 换 SNI 无效 |
| 4 | 云端托管实例 | `www.baidu.com`（对照组） | `200` | 排除「该机器 TLS 能力损坏」 |
| 5 | 云端托管实例 | `*.workers.dev` | TCP 连接 **10s 超时** | 请求根本没到达 Cloudflare |
| 6 | 云端托管实例 | `*.pages.dev` | `200`，900ms–2.5s | ✅ 唯一云端可达的 Cloudflare 入口 |

**关键推论**：1 与 2 用的是同一份代码、同一个目标、同一套 Node TLS 栈，唯一差别是**源 IP**。
拦截点在「TCP 建立之后、HTTP 之前」，因此**改 UA / 改请求头 / 调 TLS 参数 / 伪装 SNI 全部无效**——
唯一变量是出口地址，这就是中继存在的唯一理由。

> 同类拦截也解释了为什么「本机代理直发」历史上能成功、云端直发必然失败。

---

## 3. 已否证路线（勿重复排查）

| 路线 | 实测 | 结论 |
|---|---|---|
| 云端直连网关 | TLS 12ms 被 RST | ❌ 出口 IP 被拦，代码绕不过 |
| 云端直连 `*.workers.dev` | TCP 10s 超时 | ❌ 该后缀被定向阻断 |
| SNI 伪装 / `smsGatewaySni` | 6 组全 `ECONNRESET` | ❌ 已否证，开关保留但默认关 |
| 换 UA / 加请求头 | 同上，仍在 TLS 阶段就断 | ❌ 到不了 HTTP 层 |
| Cloudflare Worker 绑自定义域名绕 `workers.dev` | 域名层可绕，但 CF IP 段在网关黑名单里 | ⚠️ 投入产出比最低，未采用 |
| 只用 NotifyMe 推送 | 云端 21ms 可达 | ✅ 可用，但手机离线时收不到——短信的唯一价值就在这 |
| Pages 中继（现方案） | `200` / 成功发送 | ✅ **唯一验证可行** |

---

## 4. 超时预算：父必须大于子

链路每层都有自己的超时，**层层递减**才不会互相截断：

| 层 | 参数 | 值 | 说明 |
|---|---|---|---|
| 中继 `/__probe` | `PROBE_TIMEOUT_MS` | 12s | 只测 TLS |
| 中继 `/__guard` 站点腿 | `SITE_TIMEOUT_MS` | **20s** | v4 由 12s 放宽，冷启动常超 12s |
| 中继 `/__wake` | `WAKE_TIMEOUT_MS` | 15s | |
| 中继业务转发 | `FORWARD_TIMEOUT_MS` | 20s | 超时回 504 + `errorKind:timeout` |
| 站点 `guardSmsRelay` | 固定 | 32s | 高于中继 `SITE_TIMEOUT_MS` |
| 前端「立即体检」 | `api()` | 40s | 高于站点侧 |
| 父进程 `smsExec` | `execTimeout` | **45s 自动 / 40s 手动** | |
| 子进程总预算 | `CRONHUB_SMS_BUDGET_MS` | 父 − 5s | 给收尾留余量 |
| 子进程单次尝试 | `ATTEMPT_TIMEOUT_MS` | 上限 30s，实际取 `min(30s, 剩余预算−1.5s)` | 剩余不足 3s 直接停止重试，不死等 |
| 重试 | `MAX_RETRIES` / 退避 | 3 次 / 1s | |

**这条规则是用事故换来的**：v4 之前父进程也是 30s、子进程单次也是 30s，
结果第一轮还没超时，父进程就先把子进程 kill 了 —— **重试逻辑等于不存在**，
而且如果网关其实已受理只是回包慢，任务会报失败 → 下次重跑 → **同一条短信发两遍**。

---

## 5.「发出去了才超时」：不重试，也不换路

`timedOutAfterSend()` 的判据：`code === 'ETIMEDOUT'` **且** `timing.connectMs > 0`。

意思是：连接**已经建立**才超时，请求很可能已经被网关接收，只是没等到回包。
这种失败**既不能换下一条中继、也不能重试**——两者都会让同一条短信重复投递。
只有「连接阶段就失败」（`connectMs === 0`）才算真的没送出去，可以安全换路。

| 失败形态 | 换下一条中继 | 进入下一轮重试 | 理由 |
|---|---|---|---|
| 连接被拒 / DNS 失败 / `connectMs=0` 的超时 | ✅ | ✅ | 请求确实没出去 |
| 连上后超时（`connectMs>0`） | ❌ | ❌ **立即停止** | 可能已受理，重发 = 双短信 |
| 中继 5xx / 504 | ✅ | ✅ | 中继自身故障，业务未送达 |
| 网关 4xx / 业务码失败 | ❌ | ⚠️ **仍会重试**（`break` 只跳出中继列表） | 业务拒绝通常重试无用，属可优化点，见 §11 |
| 逐号码被平台拒绝（`terminal`） | ❌ | ❌ 直接返回 | 换域名或重试结果一样，只多烧配额 |

> 前四项的判定落在 `isRelayTransportFailure()` 与 `timedOutAfterSend()`；
> 最后一行的终态标记在 `parseResponse()` 的 `terminal` 字段。

> 代价是「确实没送达但被判失败」的情况会漏一次投递。选择**宁可漏发也不重发**：
> 短信重复比延迟可见得多，且漏发会在任务日志里显式留痕。

---

## 6. 陪护判据：只认上游腿

`/__guard` 同时并行两件事：测上游网关（CF → 5gvas01）、回探站点（CF → 国内实例 `/api/health`）。
**`ok` 与 HTTP 状态码只由上游腿决定**，站点腿降级为参考项：

| `verdict` | 含义 | HTTP | 是否告警 |
|---|---|---|---|
| `ok` | 两侧均通 | 200 | 否 |
| `channel-ok-site-slow` | 上游通、站点回探偏慢 | 200 | 否（仅 info 日志） |
| `upstream-down` | 上游不通，短信发不出去 | 502 | 是 |

**为什么解耦（2026-11-14 实例）**：旧判据要求两侧都通。站点腿是 CF 边缘（美西 SJC/LAX）→ 国内托管实例，
冷启动必然越过 12s 的站点超时被自己 abort。于是出现「`upstream.ok=true`、短信明明能发、
体检却回 502」，`failStreak` 已累积到 1 —— 再失败一次就会把一个**不存在的故障**推送到手机。

告警规则：

- 状态**跃迁**时写一条 `source:relay` 的 warn 系统日志（`true → false` 才写，不每小时刷屏）
- 连续 2 次失败推 NotifyMe（1 小时去重），**不走短信**——短信本身可能就是挂掉的那条路
- `GET /api/relay/guard`：60 秒结果缓存（`?force=1` 强制重测）；开访问控制时未登录回 401
  （此前任何人可调，等于免费的十几秒出站放大器）

---

## 7. 实测基线（用于回归对照）

| 时间 | 中继版本 | 上游腿 | 整轮 | edge | 站点腿 |
|---|---|---|---|---|---|
| 2026-11-12 | relay-v3 | 169–909ms | 490–1059ms | 近距离 | 通 |
| 2026-11-14 17:2x | relay-v4 | 696ms | 2878ms | SJC | 通 |
| 2026-11-14 19:40 | relay-v4 | 1842ms | 2525ms | **LAX** | 通 |

**判健康只看 `ok`，不看绝对耗时。** edge 落到美西时 `ttfb` 会到 1.8–12s，
那是「国内网关 ↔ CF 美西出口」的跨洋往返，属于环境特性，不是故障信号。
只要 `ok:true` 且能真实发出短信，就不必追这条耗时。

分段字段：`timing = { reused, connectMs, tlsMs, ttfbMs, totalMs, upstreamMs }`。
`upstreamMs` 是中继回报的「CF → 网关」耗时，用来把「本站 → CF」和「CF → 网关」分开看。

---

## 8. 故障模式对照

| 症状 | 先看 | 判据 | 处置 / 别做什么 |
|---|---|---|---|
| 短信全失败 | `/__status` | `ver` 不是 `relay-v4` | 部署没生效，重新部署 |
| 短信全失败，`/__status` 正常 | `/__probe` | `ok:true,status:403` | 中继没问题 → 查站点侧令牌/额度，**别改中继** |
| 同上 | `/__probe` | `ok:false` + `errorKind:timeout` | 网关侧抖动，稍后重试 |
| 体检 502 | `/__guard` | `verdict:upstream-down` | 上游真不通；若是 `channel-ok-site-slow` 则**不是故障** |
| 体检结果一直为空 | `companion.guard.at` | 为 `null` | 短命实例没等到每小时钩子 → 手动 `GET /api/relay/guard?force=1` |
| 告警说中继异常但短信正常 | 上一行判据 | 站点腿失败、上游通 | 旧版本误报；v4 起不应再出现 |
| 同一条短信收到两遍 | 发送日志的 `connectMs` | `>0` 且 `ETIMEDOUT` | 旧版本重试所致；v4 起已阻止 |
| 云端连 `workers.dev` 超时 | — | TCP 10s | 已否证，别试；只用 `pages.dev` |
| 页面提示「链接不完整」 | URL | 缺 `?sharecode=` | 不是服务挂了，补全参数 |

---

## 9. 密钥与变量

| 名称 | 位置 | 当前状态 |
|---|---|---|
| `RELAY_KEYS` / `RELAY_SECRET` | Pages 环境变量 | **仍以内联兜底值 `cronhub:…2e74` 写在 `relay/_worker.js`**，未轮换 |
| `WAKE_TOKEN` | Workers + Pages 变量 | 内联兜底 `wk_…`，可被变量覆盖 |
| `RELAY_EXTRA_HOSTS` | Pages 变量 | 空（上游白名单只有 `5gvas01.cmicmaap.com`） |
| 四类超时变量 | Pages 变量 | 均有默认值，见 §4 |
| Cloudflare API Token | `D:\Backuuup\workbuddy\cronhub\cloudflare\` | `cfut_` 用户级，含 Pages + Workers 编辑权，**2027-11-12 到期** |

> **已知风险**：密钥内联在两份源码里（`relay/_worker.js`、`relay/worker-companion.js`），
> 改一次要改两处、部署两次。这是当前最大的单点安全债，待「迁移到环境变量 + 轮换」时一并解决。
> 凭据不放 `D:\Temp`（会被清理）。

---

## 10. 演进时间线

| 时间 | 事件 | 状态 |
|---|---|---|
| 2026-11-07 | Cloudflare 从零搭建，Worker 版探针 | `workers.dev` 域名云端+RST，**失败** |
| 2026-11-08 | 改用 Pages `_worker.js`（advanced mode） | ✅ 云端可达 |
| 2026-11-10 | 双向陪护 v1：CF 每 30min 唤醒 + 站点回探 | ✅ |
| 2026-11-12 | v3 加固：连接复用、主备地址、失败推 NotifyMe | ✅ |
| 2026-11-14 | **v4 + `audit-batch-20`（批次 A 止血）**：陪护判据解耦、父子超时对齐、`connectMs` 语义、体检端点收口 | ✅ 已上线 |
| 2026-11-14 | `audit-batch-21`：响应数据全量接受（与短信链路无关） | ✅ |

---

## 11. 已知限制与待办

**P1（安全 / 可用性）**

1. 密钥内联两份源码 → 迁到 Pages 环境变量并轮换一次（会有约 1 分钟发送中断）
2. **单点出口**：`pages.dev` 挂了短信全静默。线上 `urls:[]`，多中继是纸面能力
3. 两份中继源码（Pages / Workers）在漂移：`/__status`、`/__echo`、`/__guard` 与 `scheduled`、`guardUrl` 各自一套

**P2（可观测 / 运维）**

4. `x-relay-upstream-ms` 等响应头已写但站点侧未消费（`timing.upstreamMs` 走的是 JSON 字段，头仍属死代码）
5. 无 Cloudflare Rate Limiting / WAF：`pages.dev` 公开可扫，`/__wake` 有副作用
6. 管理端点仍接受 `?key=`（会进浏览器历史 / Referer / CF 日志；转发路径已剥离）
7. 无 CI、无回滚脚本：部署是手工 `wrangler` + 备份，版本只能靠 `x-relay-ver` 文本比对
8. 可观测性靠 `console.log`：Pages 函数日志留存短，排障依赖 `/api/state` 快照
9. 网关 4xx 仍会走满 3 轮重试（`break` 只跳出中继列表，没跳出 attempt 循环）：
   业务拒绝重试无收益，只增加延迟与配额消耗；应与 `terminal` 一样直接返回

---

## 12. 文件归属

| 路径 | 用途 |
|---|---|
| `relay/_worker.js` | Pages 中继源码（部署时复制到 `pages-adv/_worker.js`，根目录单文件） |
| `relay/worker-companion.js` | Workers 定时唤醒源码 |
| `relay/index.html` | 中继占位说明页 |
| `docs/RELAY.md` | 端点、部署流程、轮换 runbook |
| `docs/SMS-CHAIN.md` | 本文：根因、预算、判据、基线、待办 |
| `tests/relay-worker-local.test.cjs` | 中继本地回归：直接加载 `relay/_worker.js`，模拟 CF 边缘，不起服务 |
| `lib/sms/send.cjs` | 发送侧：预算、重试、换路判定 |
| `lib/http-client.cjs` | 站点侧 HTTP：DNS 缓存 5min、keepAlive 60s、Happy Eyeballs |

> 早期这些验证脚本散在 `D:\Temp\2026-11-0*` 各目录（每日 23:00 清理），
> 已在第二十二批收进 `tests/`，从此每次 `npm test` 都能复跑同一套判据。
> `relay/` 与 `docs/` 随项目部署但**不会被静态暴露**（服务端 `STATIC_REVEAL` 白名单，
> `/relay/_worker.js`、`/docs/SMS-CHAIN.md` 实测 404）。
