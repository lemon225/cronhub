# CronHub × Cloudflare 中继技术文档

> 版本：`relay-v5` / `companion-v3` · **2026-11-15 已上线**（`/__status` 回 `ver: relay-v5`）
> 源码：`relay/_worker.js`（Pages 中继）、`relay/worker-companion.js`（定时陪护 Worker）、`relay/index.html`
> 线上：`https://cronhub-sms-relay.pages.dev` · 站点 `https://cronhub.app.workbuddy.host/?sharecode=ZDRK2MO6CP`
> 根因证据、超时预算、判据语义、实测基线、已知限制 → [`SMS-CHAIN.md`](SMS-CHAIN.md)（本文只讲「怎么操作」）

---

## 0. 第十五批：联通加固要点（2026-11-12）

这一批改的是「网站 ↔ 中继」这条链路的**延迟、冗余、可观测**，业务协议一字未改。

| 方向 | 做了什么 | 实测 |
|---|---|---|
| 降延迟 | 网站侧的探针/体检从全局 `fetch`（undici keepAlive 4s）切到 `lib/http-client.cjs`（60s + DNS 缓存 + TLS 会话复用） | 首次 1927ms（握手 752ms）→ 复用 468ms |
| 降延迟 | 启动 3 秒预热一次中继连接（`warmRelay`），结果下发 `companion.warm` | 线上 `warm.ok=true`，之后每次探针 490~1059ms、`reused=true` |
| 降延迟 | 发送子进程内改用 keepAlive Agent，重试/换域名/换中继都复用握手 | 首次 1821ms → 第二轮 547ms（握手 0ms） |
| 加冗余 | 支持**主 + 备**中继地址（`settings.smsGatewayRelay.url` + `urls`） | 主地址 ENOTFOUND 时自动切备用并发送成功 |
| 加冗余 | 重试**粘住**上次可用的中继，不再每轮从主地址重来 | 3 轮重试少两次无谓失败 |
| 加冗余 | 连续 2 次体检失败推 NotifyMe（1 小时去重），**不走短信** | 短信挂掉时仍有独立告警通道 |
| 可观测 | `relayHealth.timing` = `reused / connectMs / tlsMs / ttfbMs / totalMs`，设置页一行展示 | `2 条中继（通 1 条） · 当前经 … · 连接复用 · 首字节 909ms` |
| 可观测 | 中继转发响应带 `x-relay-upstream-ms`（v3 起已上线；**站点侧仍未消费**，见 `SMS-CHAIN.md` §11） | 把「本站→CF」与「CF→网关」分开看 |

> **判定「是否复用」不要看 `socket.connecting`**：TLS socket 上它不可靠，新建的 https 连接也会读成
> `false`，会把每次新建都标成「复用」。现在的判据是「这次请求期间有没有真的发生 connect 事件」。

---

## 0.5 第十六批：relay-v5 收口（2026-11-15）

只动边界，不动协议 —— 业务转发路径一行没改，改的是「出事时能不能看清」。

| 改动 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| 拒绝响应 | 403 回裸文本 `forbidden`，503 才带 JSON | 403 / 503 都是 JSON，且带 `x-relay-ver` | 线上第一句永远是「跑的是哪一版」，裸文本答不了 |
| `/__wake` | 无限制，什么人都能点 | isolate 内 30 秒节流，`?force=1` 可绕 | 它会触发站点调度，pages.dev 公开可扫，等于免费重启按钮 |
| `/__status` | 只报规模（`keys: 1`） | 增 `keysSource` / `debt[]` | 把「密钥还内联在源码」从文档条目变成可查询状态，不会再被忘掉 |
| 转发响应头 | `x-relay-upstream-ms`（语义含糊） | 增 `x-relay-ttfb-ms`；3xx 增 `x-relay-redirect: 1` | 前者说明「超时只看 TTFB」，后者让 3xx 在站点侧显式判失败 |

发送侧配套（`lib/sms/send.cjs`）：

- 走中继时补 `X-Relay-Host`。不补的话中继一律用它的默认上游，将来 `apiUrl` 换第二台网关，
  请求会被**悄悄投到老网关**；补上之后白名单外直接 403，错得明明白白
- `parseHttpError` 增 3xx 分支。以前 3xx 落到 `isSuccess:null`，被当成「业务码解析失败」，
  提示语指向短信内容，方向全错

> 节流只在同一 isolate 内有效（换 isolate 清零）。它是「降低误触成本」，不是鉴权 ——
> 真限速要上 Cloudflare WAF / Rate Limiting，见 `SMS-CHAIN.md` §11 第 5 条。

---

## 1. 一句话结论
CronHub 的短信**只能**经 Cloudflare Pages 中继发出；网站与 Cloudflare 通过两条方向相反的定时探活互相盯着，任一侧失联都会在另一侧留下可查的状态与告警。

```
                    ┌──────────────────── 双向陪护 ────────────────────┐
                    │                                                  │
  ┌────────────┐ ① 每 30min 唤醒   ┌──────────────────┐  ③ 回探 /api/health  ┌──────────────┐
  │ CF Worker  │ ────────────────▶ │  CronHub 网站    │ ◀─────────────────── │ CF Pages 中继 │
  │ sms-relay  │    /api/wake      │  (托管实例)       │    （只读，不触发tick）│  _worker.js  │
  │ scheduled  │                   └────────┬─────────┘                      └──────┬───────┘
  └────────────┘                            │ ② 每小时 / 每日自检 / 手动              │
                                           └────────── /__guard ─────────────────▶│
                                                         ④ 测上游 TLS            │
                                                                               ▼
                                                              5gvas01.cmicmaap.com（短信网关）
                                          ⑤ 业务请求：网站 ──▶ Pages 中继 ──▶ 网关
```

- **① CF → 网站**：Workers `sms-relay` 的 Cron Trigger `*/30 * * * *` 打 `/api/wake`，把休眠实例拉起并当场跑一次调度。
- **② 网站 → CF**：网站每小时、每次被唤醒时（best effort）、每日自检任务第二步，以及手动 `GET /api/relay/guard`，都会打中继的 `/__guard`。
- **③ CF → 网站（回探）**：`/__guard` 内并行回打站点 `/api/health`，把 `build`、运行时长、陪护快照带回 Cloudflare。
- **④⑤ 业务**：短信请求由网站发到 Pages 中继，白名单校验后原样转发给移动网关。

---

## 2. 两个 Cloudflare 部署，别搞混

| | **Pages 中继**（主角） | **Workers 定时陪护**（配角） |
|---|---|---|
| 项目名 | `cronhub-sms-relay` | `sms-relay` |
| 域名 | `cronhub-sms-relay.pages.dev` | `sms-relay.*.workers.dev` |
| 源码 | `relay/_worker.js` | `relay/worker-companion.js` |
| 版本标记 | `relay-v5`（响应头 `x-relay-ver`） | `companion-v3`（日志 `ver` 字段） |
| 职责 | 短信业务转发 + 探针 + 双向体检 | 每 30 分钟从外部唤醒网站 |
| 云端可达性 | ✅ 可达 | ❌ 被定向阻断（见 §3） |
| 触发方式 | 被网站请求 | Cloudflare Cron Trigger `*/30 * * * *` |

> 两者**不是主备关系**，是方向相反的两条陪护链路。Pages 挂了短信立刻全失败；Worker 挂了网站会睡过头、任务靠「错过补跑」兜底。

---

## 3. 为什么必须有中继（已否证，勿重复排查）

| 路线 | 实测结果 | 结论 |
|---|---|---|
| 网站直连网关 `5gvas01.cmicmaap.com` | ECONNRESET 25–36ms，6 组 SNI（原名/无/百度/idaas/notifyme/cloudflare）全一样 | **按目的 IP / 出口来源拦截**，换 SNI 纯代码绕不过 |
| 网站 → `*.workers.dev` | 10s+ fetch failed，本机 DNS 还污染到 Facebook 段 | 该后缀被定向阻断 |
| 网站 → `*.pages.dev` | HTTP 200 / ~900ms | ✅ 唯一可用 |
| 网关 → 用 SNI 伪装 | 见上，全部 ECONNRESET | 已否证，`settings.smsGatewaySni` 保留但默认关 |

所以：**Pages 中继是唯一短信出口（单点）**。这不是设计偏好，是被网络环境逼出来的。

---

## 4. Pages 中继端点

所有端点都要求鉴权：`X-Relay-Secret`（或 `X-Relay-Key`）头，或 `?key=`（仅浏览器手测用）。
上游 host 由 `X-Relay-Host` 指定，必须命中白名单，默认 `5gvas01.cmicmaap.com`。

| 端点 | 作用 | 成功 | 失败 |
|---|---|---|---|
| `GET /__status` | 版本 / 配置态 / 超时参数 / 端点清单，不含密钥 | 200 | 403 鉴权失败 |
| `GET /__probe` | 只测「CF → 网关」TLS，不发业务请求 | 200 `{ok:true,status:403}` | 502 `{ok:false,errorKind}` |
| `GET /__guard` | **双向陪护**：并行测上游 + 回探站点健康（**200/502 只看上游腿**） | 200 `ok:true` | 502 `ok:false` |
| `GET /__echo` | 回显 CF 眼中的调用方（IP / ASN / 组织 / TLS） | 200 | — |
| `GET /__wake` | 从 CF 边缘打一次 `/api/wake`（会触发一次 tick） | 200 `ok:true` | 502 |
| 其它路径 | 原样转发给白名单上游 | 透传上游状态码 | 502 网络错 / 504 超时 |

**关键判据**：`/__probe` 里 `status:403` 是**正常**的 —— 说明 TLS 建到了网关，只是没带业务凭据。判断通不通看 `ok`，不看 `status`。

**`/__guard` 返回示例**

```json
{
  "ok": true, "channelOk": true, "siteOk": false, "ver": "relay-v5", "edge": "SJC", "user": "cronhub",
  "verdict": "channel-ok-site-slow",
  "upstream": { "ok": true, "host": "5gvas01.cmicmaap.com", "status": 403, "ms": 169 },
  "site": { "ok": false, "status": 0, "ms": 20001, "error": "The operation was aborted", "kind": "timeout" },
  "hint": "短信通道正常（上游通）；站点回探偏慢，仅作参考，不影响通道健康"
}
```

**第二十批判据变更（重要）**：`ok` 与 HTTP 状态码**只由上游腿决定**。
站点腿（CF 边缘 → 国内实例）测的是「中继能否回探本站」，冷启动常越过 `SITE_TIMEOUT_MS`；
把它一起算进 `ok`，会出现「上游明明通、短信明明能发，整条体检却回 502」的**假警报**
（2026-11-14 线上实测：`upstream.ok=true`、`site` 被 abort、`failStreak` 已累积到 1）。
现在站点腿降级为参考项，单列 `siteOk` 与 `verdict`：

| `verdict` | 含义 | HTTP | 是否告警 |
|---|---|---|---|
| `ok` | 两侧均通 | 200 | 否 |
| `channel-ok-site-slow` | 上游通、站点回探偏慢 | 200 | 否（只写一条 info 日志） |
| `upstream-down` | 上游不通，短信发不出去 | 502 | 是 |

`SITE_TIMEOUT_MS` 默认同步放宽到 20s（可用变量覆盖）。

---

## 5. 双向陪护的具体落点

### 网站侧（`server.js`）

| 触发点 | 频率 | 做什么 |
|---|---|---|
| `setInterval` 每小时钩子 | 1 小时 | `guardSmsRelay()` 打 `/__guard` |
| `/api/wake` 被外部唤醒后 | CF 每 30 分钟 | fire-and-forget 打一次 `/__guard`（容器若立刻回收就丢这轮，不阻塞唤醒响应） |
| 「服务健康自检每天」任务第二步 | 每天 | HTTP 请求 `/__guard`，失败按任务通知策略推手机 |
| `GET /api/relay/guard` | 手动 | 立即体检并返回原始结果 |

状态放在两处，都是**纯元数据、不落盘、不含密钥**：

- `relayHealth`：最近一次探针/体检结果，随 `/api/state` 下发（设置页短信卡可见）
- `relayGuard`：最近一次双向体检的结构化结果，随 `companion` 下发

**第十批修正**：`companion` 原本只在 `/api/health` 手写了一份，而前端 `load()` 读的是 `/api/state`，导致第九批做的陪护在控制中心完全不可见。现在抽成 `companionSnapshot()`，`/api/health` 与 `/api/state` **共用同一份**，两处不会再漂移。

`/api/health` 与 `/api/state` 均下发：

```json
"companion": {
  "configured": true,
  "relay": { "at": "...", "ok": true, "ms": 719, "src": "guard", "edge": "SJC" },
  "guard":  { "at": "...", "ok": true, "upstreamOk": true, "siteOk": true, "build": "..." },
  "wake":   { "lastWokeAt": "...", "count": 123 }
}
```

`ok` 由「通」转「不通」时写一条 `source:relay` 的 warn 系统日志（只在状态跃迁时写，不每小时刷屏）；每日自检任务负责推手机告警。

### 前端可见性（第十批）

设置页「服务器」卡下方新增一张**默认折叠**的「网站 ↔ Cloudflare 双向陪护」卡：卡头一行给总体结论与状态点，展开显示四项指标（上游网关 / 本站回探 / 最近体检 / CF 唤醒）和「立即体检」按钮。

- 按钮调 `GET /api/relay/guard?force=1`，只读、不发短信、不触发调度；内部两侧并行，中继侧站点腿 20s、本站 32s 超时，客户端留 40s。
- **60 秒结果缓存**：同一轮体检十几秒的出站占用，手动连点或外部轮询不必每次真跑；`?force=1` 才强制重测（按钮走这条）。
- **鉴权**：开着访问控制（`REQUIRE_PASSWORD=1`）时要求登录，未登录回 401 —— 以前这个端点任何人都能调，等于给了一个免费的十几秒出站放大器。
- 四态：未配置 / 等待首次体检 / 双向正常 / 体检异常。上游失败原因单独显示，不与「本站回探」结果混用。
- **403 是网关对探针的正常响应**，界面标注「探针预期」；判断是否连通看 `ok`，不要看状态码。
- 用原生 `<details>` 保持开合态，`renderCompanion()` 只写 `textContent` 不重建 DOM，因此 45 秒轮询和任务编辑门控都不会把用户展开的卡收回去。
- 卡是「看状态」的入口，不是第二条短信出口。Pages 中继仍是唯一出口，见 §9 排障手册末尾的「单点风险」。

### 防回环（重要）

- `/__guard` 回打的是 **`/api/health`（只读）**，**绝不打 `/api/wake`** —— 后者会触发 `tick()`，而 `tick` 又可能再打 `/__guard`，形成回环。
- `/api/health` 自己不会发起任何出站请求。
- `guardSmsRelay()` 有 `relayGuardRunning` 互斥，并发调用直接返回上次快照。

### CF 侧

- Workers `scheduled()` 每 30 分钟唤醒网站，带 15s 真超时 + 耗时/次数/错误分类日志。
- 若给该 Worker 配了 `GUARD_URL`（指向 `https://cronhub-sms-relay.pages.dev/__guard`）和 `RELAY_SECRET`，唤醒后**再**打一次双向体检，日志记 `cron-guard`（含 `upstreamOk` / `siteOk` / `build`）。不配就只唤醒，行为与 v1 一致。
- Cron Trigger 是独立资源，重新上传 Worker 脚本不会删掉它；每次部署后都应核对一次（见 §6）。

---

## 6. 部署流程（可复现）

### 6.1 前置：两个令牌权限不同

> **2026-11-12 令牌已更换**：旧的一批 `cfat_` 令牌全部返回 `401 Invalid API Token`（历史记录，勿再用）；
> 现用一把 `cfut_` 用户级令牌，同时含下面两条 Account 权限，已验证可部署。
> 令牌与账户信息存放在 **`D:\Backuuup\workbuddy\cronhub\cloudflare\`**（`cf-api-token.txt` 纯令牌、
> `cloudflare.json` 结构化记录、`upload-worker.cjs` / `verify-worker.cjs` 上传与复核脚本、
> `worker-backup/` 每次上传前的旧脚本备份）。**到期 2027-11-12**，到期前 30 天需重建。
> 注意 `D:\Temp` 会被清理，凭据不要放那儿。

| 令牌用途 | 需要的权限 | 能做什么 |
|---|---|---|
| Pages 部署 | `Account:Cloudflare Pages:Edit` | `wrangler pages deploy` |
| Worker 脚本 / Cron | `Account:Workers Scripts:Edit` | PUT 脚本、查 schedules |

历史上有 4 个 `cfat_` 令牌，**只有一个能部署 Pages、另一个能改 Workers**，别拿错。验证命令：

```bash
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/cronhub-sms-relay"
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/sms-relay/schedules"
```

账户 ID：`7c502eedc21c540887e31422d55009ea`

### 6.2 Pages 中继（唯一验证可行的组合）

```bash
cd <任意非项目内的空目录>          # 不要用 D:\Temp（每日清理），也不要把产物留在项目里
mkdir -p pages-adv
cp <项目>/relay/_worker.js pages-adv/_worker.js
cp <项目>/relay/index.html pages-adv/index.html
# 必须 Wrangler 3.28 + 根目录单文件 _worker.js（advanced mode）
CLOUDFLARE_API_TOKEN=<Pages:Edit 令牌> \
CLOUDFLARE_ACCOUNT_ID=7c502eedc21c540887e31422d55009ea \
node <wrangler>/bin/wrangler.js pages deploy pages-adv \
  --project-name cronhub-sms-relay --commit-dirty=true
```

> **踩坑记录**：`functions/` 目录方案在 API 与 Wrangler 3.114 / 4.158 下一律 `uses_functions:false`，白做；只有根目录 `_worker.js` 会被编译成 `Compiled Worker successfully`。别再试。

部署后立刻验：

```bash
curl -s -H "X-Relay-Secret: $SECRET" https://cronhub-sms-relay.pages.dev/__status
# 期望 ver=relay-v5，响应头 x-relay-ver: relay-v5
```

### 6.3 Workers 定时陪护

```bash
TOK=<Workers:Edit 令牌> node D:/Backuuup/workbuddy/cronhub/cloudflare/upload-worker.cjs
```

上传脚本用 multipart：`metadata.json`（`main_module=worker.js`）+ `worker.js`（module 类型）。
成功后必须核对两件事：

```
upload http 200 success true handlers ["fetch","scheduled"]
schedules http 200 {"schedules":[{"cron":"*/30 * * * *", ...}]}
```

少了 `scheduled` 或 schedules 空了，网站就没人叫醒了。

> API 令牌**不允许** `PUT /workers/scripts/{name}/settings`（返回 405 `Method not allowed for this authentication scheme`）。要设 `WAKE_TOKEN` / `GUARD_URL` 变量得去 Cloudflare 控制台手动加；代码里的内置兜底值保证不配也能跑。

### 6.4 网站侧

改完 `server.js` 直接部署（用户已长期授权），部署前停本地预览、确认项目内无 `data/state.json`。
部署后 `GET /api/health?sharecode=ZDRK2MO6CP` 看 `build` 与 `companion`。

### 6.5 主 + 备地址（可选）

设置页「短信发送中继」里：**中继地址**填主地址，**备用地址**填其余（逗号分隔）。
存储形态是 `settings.smsGatewayRelay.url`（主）+ `.urls`（备），保存时统一去重、**只留 https origin**。

- 发送：按顺序试，传输层失败（连不上 / 5xx / 超时 / DNS 失败）立刻换下一条；
  记住上次成功的那条，后续重试优先走它。
- 探活：所有地址**并行**探，`relay.upCount` 给出几条通，最快的标「当前使用」。
- 体检：按主→备顺序试，**任意一条中继回了 JSON 就算通路**（它带回的两侧结果直接采用）。
- 备用地址建议部署成**第二个 Pages 项目**（同一份 `_worker.js`，同一个 `RELAY_KEYS`），
  这时两个域名共用一套密钥，换一个不影响另一个。


---

## 7. 配置项与密钥轮换

### Pages 中继（环境变量，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_KEYS` / `RELAY_SECRET` | 内置 `cronhub:…2e74` | 多调用方密钥，JSON 或 `name:key,name2:key2` |
| `RELAY_EXTRA_HOSTS` | 空 | 追加白名单上游 |
| `WAKE_TOKEN` | 内置 `wk_fb3c…` | **换令牌只改这个变量，不必改代码重部署** |
| `WAKE_BASE` / `WAKE_URL` | 线上 `/api/wake?sharecode=…` | 完整 URL 优先 |
| `SITE_HEALTH_URL` | 线上 `/api/health?sharecode=…` | `/__guard` 回探地址 |
| `PROBE_TIMEOUT_MS` / `SITE_TIMEOUT_MS` / `WAKE_TIMEOUT_MS` / `FORWARD_TIMEOUT_MS` | 12000 / 12000 / 15000 / 20000 | 全部真超时取消 |

### 唤醒令牌轮换 Runbook（线上点过「重置令牌」后）

1. 从 `/api/state?sharecode=…` 读新的 `settings.wake.token`。
2. Cloudflare 控制台 → Workers `sms-relay` → Settings → Variables，把 `WAKE_TOKEN` 改成新值。
3. Cloudflare 控制台 → Pages `cronhub-sms-relay` → Settings → Environment variables，同样改 `WAKE_TOKEN`。
4. 若两处都不便改，才更新源码里的 `WAKE_TOKEN_INLINE` 并按 §6 重新部署**两边**。
5. 验证：`GET /__wake`（带密钥）应回 `ok:true` 且站点 `count` 递增；等下一轮 `*/30` 看 `companion.wake.lastWokeAt` 是否前进。

> 令牌写死在 URL 里是 v1 的主要流程缺陷：重置一次就要改代码 + 重新部署两个项目。v2 把「基址」和「令牌」拆开并支持变量覆盖，就是为了把这一步变成改一个变量。

---

## 8. 安全边界与 v2 修的问题

| 项 | v1 | v2 |
|---|---|---|
| `?key=` 转发给上游 | ❌ 会把浏览器探针密钥带到短信网关 | ✅ 转发前从 query 删除 `key` / `relay_key` / `relay_secret` |
| 转发超时 | ❌ 完全没有，上游半开连接会拖到平台超时 | ✅ 20s 真取消，超时回 504 并标 `errorKind:timeout` |
| 探针 / 唤醒超时 | 仅探针 12s、唤醒 15s，转发裸奔 | 统一 `timedFetch()`，四类超时可配 |
| 错误分类 | 只有一句 `error` 字符串 | `errorKind` = `timeout` / `network` / `config` |
| 唤醒结果 | 只有一段 `body` 原文 | 结构化 `site{wokeAt,count,ranNow}` + 保留 `body` 兼容旧调用方 |
| 版本可查 | ❌ 无从判断线上跑的是哪版 | `x-relay-ver` 响应头 + `/__status` |
| 定时唤醒日志 | 只记 status | 记 `ms` / `count` / `ranNow` / `errorKind` |
| 变量轮换 | 改代码重部署 | `WAKE_TOKEN` 变量覆盖 |

仍然**故意不做**的事：不做开放代理（host 白名单硬限制）、日志绝不记 body/号码/令牌、密钥比较用常量时间、上游响应不改写业务内容。

---

## 9. 排障手册

| 症状 | 先查 | 判据与处置 |
|---|---|---|
| 短信全失败 | `/__status` | `ver` 不是 `relay-v5` → 部署没生效；`wakeConfigured:false` → 令牌配置丢 |
| 短信全失败，status 正常 | `/__probe` | `ok:false` + `errorKind:timeout` → 网关侧抖动；`ok:true,status:403` → 中继没问题，查网站侧凭据/额度 |
| 网站睡过头 | `/api/health` 的 `companion.wake` | `lastWokeAt` 不前进 → Worker Cron 掉了，按 §6.3 核对 `schedules` 与 `handlers` |
| 唤醒 401 | 两面令牌比对 | `settings.wake.token` 与 Worker 的 `WAKE_TOKEN`/内置值不一致 → 走 §7 轮换 |
| 双向体检 502 | `/__guard` 的 `upstream` / `site` | 哪边 `ok:false` 就修哪边；`site.error` 常是分享网关少 `?sharecode=` |
| 体检结果一直为空 | `/api/health` 的 `companion.guard.at` | 为 null → 网站短命实例没等到每小时钩子；手动 `GET /api/relay/guard` 一次 |
| 拿到「链接不完整」HTML | URL | 所有站点请求（含静态资源）必须带 `?sharecode=ZDRK2MO6CP`，不是服务挂了 |
| 云端连 workers.dev 超时 | — | 已否证，别再试；只用 `*.pages.dev` |

**单点风险（如实记录）**：Pages 中继挂了，短信没有任何备用出口。缓解手段只有「尽早发现」——每日自检任务 + 每小时体检 + 唤醒回探 + 失败推手机。做双中继需要另一条云端可达的出口域名，目前没有，暂缓。

---

## 10. 相关文件

| 路径 | 用途 |
|---|---|
| `relay/_worker.js` | Pages 中继源码（部署时复制到 `pages-adv/_worker.js`） |
| `relay/worker-companion.js` | Workers 定时陪护源码 |
| `relay/index.html` | 中继占位说明页 |
| `docs/RELAY.md` | 本文：端点、部署流程、轮换 runbook |
| `docs/SMS-CHAIN.md` | 短信链路技术档案：根因证据链、超时预算、判据语义、实测基线、待办 |
| `docs/CHANGELOG.md` | 更新记录 |
| `README.md` | 主站说明（含中继章节索引） |
| `tests/relay-worker-local.test.cjs` | 中继本地回归 27 项：直接加载 `relay/_worker.js`，模拟 CF 边缘，不起服务 |
| `tests/relay-guard.test.cjs` / `relay-api.test.cjs` | 站点侧陪护判据、体检端点鉴权与缓存 |
| `tests/sms-budget.test.cjs` | 发送侧预算收缩与「发出去了才超时」语义 |

> 早期验证脚本散落在 `D:\Temp\2026-11-0*`（该目录每日 23:00 清理），
> 已在第二十二批收进 `tests/` 并改为直载源码，不再依赖任何临时目录。
> 部署产物目录同理：`pages-adv` 可建在任意**非项目内**的空目录，不要写在 `D:\Temp` 之外的地方留副本。
>
> `relay/` 与 `docs/` 虽然随项目一起部署，但**不会被网站静态暴露**：服务端静态资源走 `STATIC_REVEAL` 白名单，`/relay/_worker.js`、`/docs/RELAY.md`、`/docs/SMS-CHAIN.md` 实测均返回 404。源码里的内置兜底密钥因此不会多一个公开读取面。
