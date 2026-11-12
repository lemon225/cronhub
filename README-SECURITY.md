# 凭据安全说明与泄露应急 Runbook

本文只讲**凭据**。任务调度、短信正文、推送渠道见各自文档。

---

## 一、三类凭据：分开存储、分开加密、分开授权

| 类型 | 本项目的具体内容 | 敏感级 | 失效后果 | 存放位置 |
|---|---|---|---|---|
| **长期凭据** | `uuid`、`clawUid`（扫码绑定的设备/会话载体） | 最高，等同账号密码 | 必须人工重新扫码 | 保险库 `longterm` 分区 |
| **短期凭据** | `creditToken`（真正用于发短信的令牌） | 中 | 可重新换取，5 分钟过期 | 保险库 `shortterm` 分区 |
| **应用凭据** | `code`、`kid`、`strategyId`（Skill 身份） | 中高 | 换 Key 即可 | 保险库 `app` 分区 |

三者**不共用密钥**：每个分区用 HKDF-SHA256 从主密钥派生独立子密钥（`lib/credential-vault.js` 的 `deriveScopeKey`）。
因此同一个明文在三个分区会得到三段互不相同的密文；某一分区的密钥泄露不会牵连另外两个。

> 已验证：写入同一字符串到三个分区，得到三段不同密文，且都能正确解回（自测第 7 项）。

---

## 二、加密方式、密钥来源、恢复方式

### 加密方式

- 算法：**AES-256-GCM**
- 每条记录：`v1:<base64 nonce>:<base64 authTag>:<base64 ciphertext>`
- nonce 每次随机 12 字节 → 同一明文两次加密结果不同
- 版本号 `v1` 前缀让后续换算法时可以平滑迁移（`decrypt` 遇到未知版本直接判失败，不会误读）

### 密钥来源（按优先级）

1. **环境变量 `CRONHUB_SMS_KEY`**（生产推荐；接 KMS 就把它注入这里）
   - 接受 64 位 hex、32 字节 base64，或任意口令（内部 SHA-256 归一化为 32 字节）
2. **独立 secrets 文件** `data/.secrets/sms-master.key`（权限 600，属主为服务用户）
   - 首次启动自动生成 32 字节随机密钥
   - 该文件与 `state.json` **不在同一层目录**，物理分离

明确不做的事：**不从 `state.auth`、数据库字段、代码常量派生密钥。**
（旧实现用 `auth.salt + auth.secret` 派生，等于密钥和密文躺在同一个文件里，拿到 `state.json` 就能解出令牌。已废弃。）

### 恢复方式

| 场景 | 做法 |
|---|---|
| 换机器 / 迁实例 | 把 `.secrets/sms-master.key`（或 `CRONHUB_SMS_KEY` 的值）一起搬过去，凭据自动可解 |
| 密钥丢了但有备份 | 恢复同名密钥文件即可，无需重新授权 |
| 密钥丢了且没有备份 | 无法恢复。系统进入 fail-safe（能启动、拒绝发送、明确报错），需重新扫码授权 |
| 主动轮换密钥 | 先把状态置为需要重新授权，换密钥，再重新扫码；不要直接覆盖密钥——那会让所有旧密文变成不可解的垃圾 |

**备份策略**：`state.json` 与 `.secrets/sms-master.key` 必须**分开介质**备份。两者同时拿到等于拿到明文，同时丢失则不可恢复。

---

## 三、所有能读取凭据的代码位置（共 2 处）

审计要求「能读凭据的位置 ≤ 2 处」。当前实现：

| # | 位置 | 能读到什么 | 说明 |
|---|---|---|---|
| 1 | `lib/credential-vault.js` 的 `scope(name).get()` | 该分区的明文 | 唯一解密点。所有上层都经由它，没有第二条解密路径 |
| 2 | `server.js` 的 `withCredentialSandbox()` | 长期 + 应用分区的明文 | 调子进程前物化到一次性目录，**调用结束立即删除**（`fs.rmSync` in `finally`） |

补充说明：

- **发短信的代码路径拿不到长期凭据。** 状态机只申请 `shortterm` 分区（`tokenStore`），`doRefresh` 之外的代码根本看不到 `uuid` / `clawUid`。
- **短期令牌不再进 `state.smsCredential`。** 那里只有状态与计数，连密文都没有。
- **令牌不进命令行。** 传给子进程走 stdin（`--token-stdin`），`ps aux` 看不到 argv 里的令牌。
- **前端任何接口都不返回凭据**，只返回状态（`ACTIVE` / `EXPIRING` / `NEED_REAUTH` / `REVOKED` / `LOCKED`）。

---

## 四、状态机

```
ACTIVE ──┬─→ EXPIRING ──┬─→ NEED_REAUTH ──→ REVOKED
         │               │
         ├───────────────┴─→ REVOKED
         └─→ LOCKED ──→ (到期探测成功) → ACTIVE
```

- **单向流转，只允许代码判定。** `transition()` 是唯一入口，遇到流转表里没有的迁移会拒绝并记审计。
- `EXPIRING → ACTIVE` 是唯一允许的「回退」，因为它还没失效。
- `NEED_REAUTH` / `REVOKED` **不能靠点按钮回到 ACTIVE**。只有 `completeRebind()`（人工扫码真的成功之后）才重置生命周期。
- `EXPIRING` 只告警不阻断。发放成功**不会**把它拉回 ACTIVE——到期临近是事实，不该被一次成功掩盖。

### 硬过期日

本通道**没有 `refresh_token`**（详见 `lib/sms-credential.js` 头部注释）。按「无 refresh 方案」处理：

- 首次成功取到令牌时记录 `boundAt`，硬过期 = `boundAt + 180 天`（`settings.sms.hardExpiryDays` 可调）
- 提前 **7 / 3 / 1 天**各告警一次（走站内 + 手机推送，不走短信本身）
- 到期自动转 `NEED_REAUTH` 并停止一切自动请求

---

## 五、环境隔离

| 环境 | 判定依据 | 短信行为 |
|---|---|---|
| **dev** | Windows 本机，或显式 `CRONHUB_ENV=dev` | **dry-run**：不发出任何真实请求，生产配额消耗 0 |
| **prod** | Linux 容器（`/.dockerenv` 或 mountinfo 含 overlay），或 `CRONHUB_ENV=prod` / `NODE_ENV=production` | 真实发送 |

判定结果会在 `/api/sms/credential` 的 `runtime` 字段和凭据仪表盘上明示，不用猜。

想让 dev 也真发（调试用）：`CRONHUB_SMS_REAL=1`。
**注意**：dev 与 prod 共用同一套凭据时，dev 一旦真发就会消耗生产配额——这是本通道只有一套凭据的客观限制。

---

## 六、管理接口

> ### 当前默认：**免认证，只统计不拦截**
>
> 短信管理面默认**不要求任何认证**：`canManageSms()` 直接返回 true，17 个 `needSmsAdmin()`
> 调用点全部放行，短信页的开关 / 保存 / 测试 / 授权 / 吊销都能直接点。
> 唯一的痕迹是计数：每次穿过管理面的操作累加 `state.smsAuthStats`，按动作分组、
> 随状态文件持久化，页面身份条显示「🔓 免认证 · 已授权 N 次 · 最近一次」。
>
> 设计取舍：这是自用站，短信页本来只有自己会开，一道口令挡不住攻击者，只挡住每天点十几次的自己；
> 「事后能查」比「事前拦人」更适合这个场景。
>
> 想恢复下面这套硬闸门：设 **`CRONHUB_SMS_GUARD=1`**，代码路径原样保留（`needSmsAdmin`
> 会重新返回 403 + `needAdmin`），`t_perm` 47 项、`t_sched` 25 项就是在这档下跑的。
>
> 计数口径细节：状态探针（`/api/sms/recv-state`、`/api/sms/vault/health`）**不计数**，
> 否则每次刷新页面都会把数字刷高；同一动作同一来源 60 秒内只记一次。

**开启 `CRONHUB_SMS_GUARD=1` 时**：短信通道的每一个操作都要 SMS 管理令牌，没有例外档
（旧版曾给 dev 自动放行，已删除：权限判定不该随运行环境变化）。
下表「SMS 管理令牌」= 必须持 `cronhub_sms_admin` cookie。

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/sms/recv-state` | 分层 | 访客只回「通道在不在收」；凭据状态/配额/`actionUrl`/runtime 仅管理员 |
| `GET /api/sms/credential` | SMS 管理令牌 | 只读仪表盘，无凭据值（但含配额与过期日，属决策情报） |
| `GET /api/sms/vault/health` | 分层 | 监控探针只回 `ok/state/message`；分区计数与密钥来源仅管理员 |
| `GET /api/sms/audit` | SMS 管理令牌 | 审计日志尾部 + 链校验结果 |
| `GET /api/sms/bindings` | SMS 管理令牌 | 接收号码列表（状态摘要，不含凭据值，不触发网络请求） |
| `POST /api/sms/bindings` | SMS 管理令牌 | 新增接收号码（即生成并固定该号 clawUid，状态待授权，不预烧验证码） |
| `DELETE /api/sms/bindings` | SMS 管理令牌 | 解绑接收号码（删该号凭据键，至少保留一条） |
| `POST /api/sms/preview` | SMS 管理令牌 | 内容预览：风控等级/命中词/字数/条数/美化建议（与发送共用一份规则，只读） |
| `GET/DELETE /api/sms/records` | SMS 管理令牌 | 发送记录（40 字摘要，不含全文；DELETE 清空记录不影响凭据） |
| `POST /api/sms/revoke` | SMS 管理令牌 | 吊销（唯一能把状态推到 REVOKED 的接口）。**只清 longterm / shortterm**，保留 app 分区；body 传 `{"includeApp":true}` 才连应用凭据一起清；带 `binding` 只吊销该号 |
| `GET /api/sms/auth-link` | SMS 管理令牌 | 生成授权链接（**全局唯一可能消耗验证码的调用点**）；配额只是提示线，超出仍给链接 |
| `GET /api/sms/auth-check` | SMS 管理令牌 | **只读检测**：只问「现在通没通」，不生成链接、不清 uuid、不计授权次数。前端每 6 秒轮询，就是为了让用户不用手点「我已扫码」 |
| `POST /api/sms/reset-auth` | SMS 管理令牌 | 清除本地凭据副本 |
| `GET /api/sms/diag` | SMS 管理令牌 | 链路诊断（会发 DNS/TCP/一次带无效令牌的 HTTPS） |
| `POST /api/sms/bootstrap` | SMS 管理令牌 | 凭据引导，分区非空即 409。只写 app 时返回 `longTermWritten:false`，状态保持待授权（不谎报 ACTIVE） |
| `DELETE /api/sms/credential/dead-letters` | SMS 管理令牌 | 清空死信队列 |
| `GET /api/gateway-sms/log` | SMS 管理令牌 | 网关调用记录（含正文片段，可能是验证码） |
| `GET/DELETE /api/sms-relay/log` | — | **已下线（第 42 轮）**：对所有人一律 404，与「接口不存在」不可区分 |
| `POST /api/gateway-sms/test` | SMS 管理令牌 | 网关自测（会真发一条） |
| `POST /api/settings/test-notify` | 按渠道 | `channel=sms` 时同样要 SMS 管理令牌 |
| `PUT /api/settings` | 按内容 | body 含 `sms` / `gatewaySms` / `smsRelay` / `channelInstances.sms` 时要求令牌；其他设置不受影响 |
| `GET /api/sms/dead-letters` | SMS 管理令牌 | 推送死信队列（含通知正文，可能是任务结果/业务数据） |
| `POST /api/sms/dead-letters/replay` | SMS 管理令牌 | 重放一条死信（成功即出队） |
| `DELETE /api/sms/dead-letters` | SMS 管理令牌 | 清空死信队列 |
| `POST /api/sms/admin-unlock` | 管理口令 | 换 30 分钟 SMS 管理令牌（登录入口，唯一无需令牌的 SMS 端点） |
| `POST /api/sms/admin-lock` | 无需登录 | 主动退出：令牌签名进黑名单 + 清 cookie |

### 配额是提示线，不是闸门（第 40 轮改动）

早期把「每天 3 次授权 / 每小时 1 次」写成硬拒绝，结果是用户想重扫一次就被自己的程序拦住。
现在分三类处理：

| 场景 | 行为 | 理由 |
|---|---|---|
| **手动**（人点按钮：扫码授权、发送测试、诊断） | **放行**，超出额度只回一句 `warning` | 人的明确意图不该被本地判死；额度只是「在烧验证码」的提醒 |
| **自动**（定时任务推送、`/gateway/sms` 外部调用） | 仍按配额拦 | 程序自己发，需要有天花板，避免任务异常时刷爆号码 |
| **熔断**（上游 140005 频率限制） | **硬拦**，零出站请求 | 平台风控，不拦会被封号 |

保留真正的闸门能力：`CRONHUB_SMS_STRICT=1` 时恢复「配额即拒绝」。

自动检测单独做了 `checkAuth()`：它只调一次 preAuth 判断通没通，
**不清本地 uuid**——否则轮询会把用户手里正在扫的那张二维码作废（第 39 轮踩过的坑）。

探活与「发送取令牌」必须分开计数（第 41 轮改动）：

| 计数 | 何时 +1 | 上限作用 |
|---|---|---|
| `refreshCountToday` | 发送前真正取令牌、任务推送 | 会拦自动任务，是天花板 |
| `probeCountToday` | `checkAuth()` 只读探活 | **从不拦任何东西**，只是记账 |

曾经两者共用一个计数器：一次扫码轮询 9 次 preAuth 就把「今日刷新」顶到 24 的提示线，
随后自动任务取令牌被本地拦下，现象是**授权明明正常，推送却发不出去**。
探活是只读的，没有资格吃掉发送额度。

「我明明授权了，怎么还显示没有」的三层兜底（第 41 轮）：

1. **后端只在被问到时才知道真相**——没人调 preAuth，它就一直停在 `NEED_REAUTH`，
   所以页面打开时若状态是需授权，自动静默探活一次（`localStorage` 记忆 60 秒节流）。
2. **从手机切回页面就问**（`visibilitychange` / `focus`）——那正是「可能刚扫完」的时刻。
3. **二维码窗口不早停**：6→24 秒退避 9 次（约 2 分钟）后转入 30 秒慢心跳再撑 6 分钟，
   总计约 8 分钟；超时后给「再检测一次」（不换二维码、不烧验证码），而不是直接判死。

为什么连"只读"的 `/api/sms/credential` 也收口：它虽然不含任何凭据值，但含今日剩余配额、
硬过期日、保险库分区条目数、最近一次决策原因——这些正是攻击者规划下一步要的输入。
只读 ≠ 无害。

### 任务里勾了渠道，就一定发（第 43 轮）

通知要过三道闸门，任一为 false 就静默不发。历史问题是**第三道是默认值，会把用户明确的选择冲掉**：

| 层 | 字段 | 谁决定的 | 说明 |
|---|---|---|---|
| 1 | `task.config.notify.onSuccess/onFailure` | 用户在任务编辑页勾 | 任务级时机 |
| 2 | `settings.notifyTiming[type].onSuccess` | 通道类型级，**页面无入口** | 历史遗留，只对「没点名的渠道」生效 |
| 3 | `settings.sms.minLevel`（默认 `important`） | 设置页「只发重要通知」 | **默认降噪**，`level='success'` 直接丢 |

第 43 轮的真实故障：任务里勾了短信、任务级 `onSuccess=true`，偏偏第 3 层是默认值，
通知详情只写「站内已记录」——用户看到的就是「我勾了短信却没收到」，而且**页面上找不到原因**。

现在的规则：

- **任务级显式选择优先**。`task.config.notify.channels` 里点过名的渠道（`explicitChannels`），
  跳过第 2、3 层默认降噪，直接按任务级时机发。用户在一个具体任务里勾了渠道，意图比全局默认值具体。
- **退订与静音不穿透**。`optOut` / `mutedUntil` 是用户主动表达的意愿，仍然尊重；
  只有「默认降噪」可以被显式选择覆盖。
- **被挡的渠道必须留痕**。`channelAllows` 过滤掉的渠道不再静默消失，通知记录的 `channels`
  里会多一行 `ok:false` + 具体原因（「该通道未启用」「该通道设为仅失败时发送」）。

三条都有自动化回归：`D:/Temp/cronhub-sms/t_notify/t_explicit.js`（8 项）。

### 短信「中转」已下线（第 42 轮）

先分清两条方向相反的链路，别混为一谈：

| 链路 | 方向 | 状态 |
|---|---|---|
| **短信通知**（`settings.sms` + 凭据保险库） | 网站 → 手机 | 正常使用，是任务提醒的出口 |
| **中转**（`settings.smsRelay` + `/gateway/sms/receive`） | 手机 → 网站 | **已下线** |

中转是「手机装了 SmsForwarder，把收到的短信 POST 上来」，跟「把站内通知发成短信」完全无关，
下线它不影响任何一条提醒的发送。

关闭方式与行为：

- 环境变量 `CRONHUB_SMS_RELAY=1` 才会启用；默认关闭（`SMS_RELAY_ENABLED=false`）。
- `/gateway/sms/receive`、`/api/sms-relay/log`（GET/DELETE）在关闭时一律返回 `404 接口不存在`，
  与「这个路由根本没有」不可区分 —— 不回应 `403` 或「未启用」，那等于告诉探测者这里有个开关可以打开。
- 前端：左侧导航「中转」与整页 `view-relay` 已移除；`app.js` 里网关/中转的事件绑定
  用存在性守卫（`if ($('#saveGateway'))`）包住，否则 `addEventListener` 会在 `null` 上抛错，
  把一个可选页面的下线变成整页初始化失败。
- 出站网关 `/gateway/sms/send` 的接口与 `settings.gatewaySms` 配置**没有改动**，只是界面入口随页移除；
  需要重新配置时，恢复 `view-relay` 或直接 `PUT /api/settings {gatewaySms}`。

恢复中转需要两步：后端设 `CRONHUB_SMS_RELAY=1` 并重启，前端把导航项与 `view-relay` 段加回。



保险库有三个分区，吊销时必须区别对待：

| 分区 | 内容 | 吊销时 | 理由 |
|---|---|---|---|
| `longterm` | `uuid` / `accessToken` | **清空** | 就是「这台设备被哪个手机号授权了」，吊销的核心目标 |
| `longterm` | `clawUid` | **保留** | 设备标识不是授权凭据；换掉等于换机器，平台侧原绑定全废 |
| `shortterm` | `creditToken` | **清空** | 5 分钟短效令牌，清掉最省事 |
| `app` | `code` / `kid` / `strategyId` | **保留** | 平台分配给"我们是哪个应用"的凭据，与谁授权无关；且**没有任何自助恢复入口** |

这条边界是踩出来的：早期 `revokeAll()` 一把清三个分区，吊销一次就把 `code`（clientId）
也抹了，此后每一次 `preAuth` 都返回 `200002 clientId不能为空`。现象看起来像网关故障，
实际是自己库里没值 —— 而且 `bootstrap` 的逻辑是「分区非空才 409」，空了才能写，
但值只在平台侧，等于通道永久失联。

现在：

- `revokeAll()` 默认只清 `longterm` / `shortterm`，返回 `{ keptApp: true }`
- 确认 `code`/`kid` 本身泄露时，显式 `revokeAll(reason, { includeApp: true })`（接口上 `{"includeApp":true}`）
- 缺应用凭据时**在起子进程之前**就拦下来（`APP_CRED_MISSING`），不再让它变成含混的 `200002`
- `200002` 也不计入「授权次数」：一次真实请求都没发出去，不该烧验证码额度

### 设备身份 clawUid：必须稳定，且必须回写

> 第 44 轮改版后，clawUid / uuid / accessToken 从「全局单份」升级为「一号一份」，
> 键名带绑定前缀（`b1:clawUid` / `b2:uuid`…）。本节描述的稳定性原则对每个号码分别成立。

平台的授权是绑在 `(clawUid, uuid)` 上的：手机扫码那一次，平台记住「某个 clawUid 被某个手机号授权了」，
之后 preAuth 只要带同一个 clawUid 才返回 103000。

沙箱架构（一次性目录）曾让这件事彻底失效：

- 目录里没有 `clawUid.json` → `token_service` 每次生成新 UUID → **等于每次换一台新设备去申请**
- `token_service` 把 uuid / accessToken 写进沙箱，目录用完即删 → **没人读回来**，longterm 永远 0 条

所以现在：

1. `ensureClawUid()`：第一次调用生成一个 UUID 并写进 longterm，此后不再变化
2. 沙箱同时写 `{clawUid, deviceId}` 两个字段 —— `token_service` 有两条读路径，字段名不同
3. `harvestCredentialDir()`：**在删除目录之前**把 `auth_info_ydrz.json` / `clawUid.json` 收回保险库
4. `smsResetCreds()` 只清 `uuid` / `accessToken`，clawUid 保留
5. `130088 uuid未授权` 单独识别为「半途状态」：丢掉那个 uuid 重取链接，而不是当成致命错误不再重试

### 多号码绑定（第 44 轮改版）

官方迁移文档 4.4 的核心诉求落地为「**一个接收号码 = 一份独立授权**」，
而不是文档原稿的「多用户账号体系」（与本站单用户零依赖架构冲突，已按实际需求折算成号码维度）：

- **数据模型**：`state.smsBindings[]`，每项 `{id: b1/b2…, label, cred, createdAt}`；
  凭据仍走保险库，键名加前缀 `b2:uuid` / `b2:creditToken`，应用凭据（code/kid/strategyId）是平台级身份，全局共用不加前缀
- **无损迁移**：首次启动把旧的单份 `state.smsCredential` 原样搬成 `b1:*`——值一个字节都不重新生成
  （重新生成 clawUid 等于换设备，已扫的授权立刻作废）；旧键确认写入后才删除
- **按号隔离**：每个号一个 `createSmsCredential` 实例——熔断、配额、令牌缓存、单飞锁全部独立，
  A 号被平台限流不会拖死 B 号；发送间隔 60 秒也按号计算
- **按号授权**：`auth-link` / `auth-check` / `bootstrap` / `revoke` / `reset-auth` 全部支持 `?binding=`
  或 body.binding，不带时回落主号码；新增号码即生成并固定它的 clawUid（等扫码，不预烧验证码）
- **发送**：默认发到全部已绑定号码，逐号顺序发；`opt.binding(s)` 可指定
- **解绑**：删除该号的凭据键，至少保留一条绑定；解绑后保险库无残留键

### 逐号码发送结果解析（官方风险 7，P0）

平台 `send2User` 返回外层 `code=10200` 时**不代表全部号码发送成功**——
`data` 里还有逐号码结果，安全控制拒绝（`Security control authentication failed`）就藏在里面。
只判外层码会把失败报成「发送成功」。现在：

- `lib/sms/send.cjs` 防御式提取逐号码结果（字段名各环境不统一，按「号码类+结果类字段」特征识别）
- 任一号码失败 → 整体判定失败、不再跨域名重试（换域名重试同样被拒，只会多烧一次配额）
- 其中 `Security control` 是重新授权后几分钟内平台侧同步未完成的**已知瞬态**（官方文档 2026-10-31 实测），
  单独分类按网络节奏退避重试；其余逐号码失败不重试
- 回执逐号打码（`138****5678`），带 traceId 便于排查

### 授权二维码：本地生成，不再外发

原实现把授权链接整串发给第三方 `api.qrserver.com` 换图片——等于把「谁的授权链接、什么时候生成」
交给陌生域名（官方 6.2 明确禁止）。现在 vendor 了 MIT 单文件编码器（`lib/vendor/qrcode.js`），
服务端本地出 SVG data URI，链接不出服务器。

### 设备指纹脱敏（官方 4.6）

`device_info.js` 不再把服务器 hostname / CPU 型号当成用户设备上报（那是「LAPTOP-CHEN」级别的真实机器名）。
默认上报固定占位值 `CRONHUB-SRV` / `VIRTUAL-CPU`（风控看重前后一致，不是真实性）；
`CRONHUB_SMS_ANON_DEVICE=0` 可关。

### 内容预览与发送记录（官方 4.3）

- `POST /api/sms/preview {text}`：风控等级、命中词、字数、预计条数、美化建议。
  与真实发送**共用同一份规则**（`lib/sms/content.js`）——预览说没风险、发送时却加了诈骗提示 = 规则漂移
- `GET /api/sms/records`：摘要 + 每号结果 + 条数 + 风险等级 + dryRun 标记，上限 200 条
- **隐私**：记录只存 `scrubText` 后的 40 字摘要，不落短信全文（正文常有验证码/账单尾号）；
  免责声明按官方规则在预览时就计入条数

### 二次认证：SMS 专用令牌

```
POST /api/sms/admin-unlock  {password: "<管理口令>"}
  → Set-Cookie: cronhub_sms_admin=<ts>.<HMAC>; Path=/api/sms; HttpOnly; SameSite=Strict; Max-Age=1800
```

- **独立密钥派生**：`sha256("cronhub-sms-admin|v1|" + auth.secret)`，与会话令牌互不影响，一边泄露不波及另一边
- **独立 cookie + Path 限定 `/api/sms`**：其他接口拿不到这个 cookie，XSS 也读不到（HttpOnly）
- **30 分钟过期**，主动点「退出管理员」= 令牌签名进进程内黑名单 + 清 cookie。
  只清 cookie 不算退出——被抄走的那个 cookie 服务端照样认，所以黑名单是必须的。
- 失败计数与登录共用 `loginFailures`（10 次 / IP / 15 分钟），防爆破规则一致
- **默认不绑定来源 IP**：托管环境经多副本网关转发，`x-forwarded-for` 每次可能不同，
  绑了会导致「刚换的令牌下一次请求就失效」（线上实测踩过）。只有运维显式配置
  `CRONHUB_ADMIN_IPS`（说明确知出口地址稳定）时才把 IP 纳入签名。
  不绑定后的补偿：短时效 + HttpOnly + Secure + 每次高危操作二次确认 + 全量审计。

> **前端只是外观，不是闸门**（`CRONHUB_SMS_GUARD=1` 时才生效）：未认证时短信卡片显示「🔒 访客」，
> 保存 / 测试 / 诊断 / 开关全部 disabled，重新授权与吊销两个按钮**不渲染**；唯一可见的入口是
> 「管理员登录」，它本身不消耗配额、不改配置。真正拦人的是每个端点上的 `needSmsAdmin()`——
> 直接 `curl` 打接口一样 403。
>
> 免认证模式下这条身份条改成计数牌（「🔓 免认证 · 已授权 N 次」），「管理员登录」按钮隐藏。
>
> 拒绝也会留痕：`sms_admin_denied` 写进审计（同一来源同一动作 60 秒内只记一次，防刷爆）。

> ⚠️ **为什么不是 `isAdmin`**：`REQUIRE_PASSWORD` 默认关闭，此时页面根本没有登录入口，
> `isAdmin` 恒为 false —— 曾经把这里收紧成「必须 isAdmin」，结果按钮永久隐藏、
> 凭据失效后再无任何路径可重新授权，把门焊死还没带钥匙。
> 现在的做法：管理面自带口令登录（`ADMIN_PASSWORDS`），与站点会话解耦，不依赖 `REQUIRE_PASSWORD`。

> ⚠️ 也**不认**「已登录的站点管理员」：一次站点登录不该顺带获得消耗验证码配额的能力，
> 那是权限放大。管理面独立，令牌也独立。

可选 IP 白名单 `CRONHUB_ADMIN_IPS`：托管环境的 `remoteAddress` 是网关内网地址，
白名单在这种场景没意义，所以默认不启用；一旦配了就按最严格校验。

**忘记管理口令**：管理口令来自 `ADMIN_PASSWORDS` 环境变量（默认值见 `server.js`），
重设后重启即可。这不是凭据，不入保险库，也不落盘。

---

## 六之二、非短信凭据的下发策略（`maskSettings`）

> **当前默认：明文下发。** 这些凭据都是「泄露了也能接受损失」的低成本账号，
> 而掩码的真实代价是每天都要付的——输入框全空、改一个字段要先点眼睛输口令、
> 复制令牌再输一次口令。所以默认摊开，把控制权交给使用者。
>
> 要收紧就在环境变量里设 **`CRONHUB_CRED_MASK=1`**，整套「掩码 + 口令换明文」逻辑
> 原样生效（代码路径一直保留，不删）。前端读 `meta.credMasked` 决定是否显示「👁」按钮、
> 密码框是否摊开，切回去不需要改代码。

短信通道的凭据在保险库里，但**通知渠道的凭据（Webhook token、网关令牌、中转令牌、
refreshToken、环境变量值）同样是一条完整的攻击面**：拿到 `gatewaySms.token` 就能代本机发短信，
拿到 `tokenVault.refreshToken`（完整 JWT）等于整份账号凭据。

### 统一出口

`server.js: maskSettings()` 是**唯一**的设置出站口，`/api/state` 与 `PUT /api/settings`
的响应都过它。以前 `publicState()` 是 `{...state.settings}` 整体展开，只单独打了 4 个字段的码，
剩下这些原样下发（F12 打开 `/api/state` 就能看到完整值）：

| 字段 | 明文下发的后果 |
|---|---|
| `webhook.token` | 可向你的通知端点伪造推送 |
| `gatewaySms.token` | 可代本机发短信（按条计费，且以你的名义） |
| `smsRelay.token` | 可伪造上行短信写进中转记录 |
| `tokenVault.refreshToken` | 完整 JWT，账号级凭据 |
| `envVars[].value` | `{{ACCESS_TOKEN}}` 的真值，任务 headers 里的实际凭据 |
| `smsActionToken` | 可直接改退订/静音状态（免登录操作链接的令牌） |

`CRONHUB_CRED_MASK=1` 时一律 `maskSecret()`（保留前 4 后 4，`••••••` 用于密码类），
`wake.token` 额外分层：管理员会话才发明文（要复制给 cron-job.org），访客拿 `••••••`。

### 掩码不能回存（无论哪种模式都生效）

掩码下发带来一个反向风险：**页面上看到的脱敏串被原样保存，真凭据就被覆盖成 `gw_18a2…9f3c`**。
两道防线：

1. 前端 `fillSecretField()` —— 掩码不回填，输入框留空 + placeholder 写「留空则不修改」；
2. 后端 `PUT /api/settings` —— `isMaskedValue()` 命中（含**空串**）即保留原值。
   空串必须一起算：前端留空提交的就是 `""`，只判 `'••••••'` 会把 SMTP 密码清成空。

### 要看明文怎么办（仅 `CRONHUB_CRED_MASK=1` 时需要）

```
POST /api/settings/reveal  {password: "<管理口令>", keys: ["gatewaySms.token", "envVars.ACCESS_TOKEN"]}
  → {ok: true, values: {"gatewaySms.token": "gw_...", ...}}
```

- 口令校验与登录共用 `loginFailures` 防爆破（10 次/IP 锁定 15 分钟）；
- **只认白名单**：`webhook.token` / `gatewaySms.token` / `smsRelay.token` /
  `tokenVault.refreshToken` / `smtp.pass` / `ai.apiKey` / `notifyme.token|uuid` /
  `wake.token` / `envVars.<KEY>`，其余一律过滤掉（防止变成「任意设置项读取器」）；
- 不落 cookie、不进 localStorage，只填进当前输入框；
- 审计只记「看了哪几项」，不记值、不记口令。

---

## 七、审计日志

- 位置：`data/audit/sms-audit-YYYY-MM.jsonl`（按月分文件，与业务日志 `state.systemLogs` **完全分开**）
- 只追加：`fs.appendFileSync` + `O_APPEND`，不做读-改-写
- 保留：**90 天**，启动时按月粒度清理
- 每行带 `seq` / `prev` / `h`（SHA-256 前 16 位）形成**哈希链**：改动任何一条历史记录，`/api/sms/audit` 的 `chain.ok` 会变 false
- 内容只有「决策与动作」，不含值。写入前还会二次脱敏（`[REDACTED]`）

> 已验证：篡改第一行后链校验立即返回 `hash_mismatch`（自测第 10 项）。

---

## 八、泄露应急 Runbook

### 判定信号

- 凭据出现在公开仓库 / 截图 / 日志导出文件
- 移动侧告警、异地或异常来源登录
- 本地记录到从未见过的调用来源

### 处置顺序（**禁止「先观察一下」**）

```bash
# 1. 先看会做什么（默认只读，不动任何数据）
node tools/credential-emergency.cjs

# 2. 真正执行：清空全部凭据 + 状态置 REVOKED + 熔断 24h + 写审计 + 备份 state
node tools/credential-emergency.cjs --apply --reason "描述泄露渠道"

# 3. 想更彻底：连主密钥一起作废（历史密文永久不可解；密钥来自环境变量时会提示改环境变量）
node tools/credential-emergency.cjs --apply --reason "主密钥疑似外泄" --destroy-key

# 4. 只做泄露面扫描（仓库 / 临时目录 / 审计 / .gitignore），有高危项时退出码 1
node tools/credential-emergency.cjs --scan
```

统一入口只有这一个脚本（`scripts/sms-emergency-revoke.js` 已合并进来并移除）：默认只读是刻意的，
「应急脚本自己误触」比泄露本身更常见。脚本只做本地操作，**不发任何网络请求**、不尝试重新授权、不删审计。

### 然后逐项人工确认

1. **排查仓库历史**
   ```bash
   git log -p -- lib/sms | grep -iE "code|kid|uuid|clawUid"
   git log --all --diff-filter=A -- '*.json' | grep -i "sms"
   ```
2. **排查镜像与备份**：确认 `data/` 与 `.secrets/` 没有被打进镜像层；备份介质与密钥分开存放
3. **到移动侧作废旧授权**（脚本只能清本地副本）
4. **用干净的出口重新扫码**：不要在疑似被入侵的机器上做授权
5. **验证恢复**：
   ```bash
   curl -s <站点>/api/sms/vault/health | jq
   # ok:true + state:"ok" 才算正常
   ```
6. **检查审计链**：`GET /api/sms/audit` 的 `chain.ok` 必须为 true

---

## 九、禁止项自查清单

| # | 禁止项 | 当前状态 |
|---|---|---|
| 1 | 凭据写在代码 / 配置文件 / compose / CI 明文 | ✅ 已迁入保险库，`config.json` 只剩 `apiUrl/pid/name/tpl/timeout` + 公钥 |
| 2 | 凭据随前端下发 | ✅ `maskSettings()` 统一掩码；明文只经 `POST /api/settings/reveal` 口令换一次 |
| 3 | 凭据拼进 URL | ✅ 令牌走 stdin，不进 query |
| 4 | 凭据进日志 / 报错弹窗 / 截图 | ✅ `scrub()` + `redact()` 只留后 4 位；异常重抛前 `sanitizeError()` |
| 5 | dev 与 prod 共用凭据 | ⚠️ 本通道只有一套凭据。已用 **dev 默认 dry-run** 兜底，生产配额消耗为 0 |
| 6 | 并发刷新同一凭据 | ✅ 进程内 Promise 复用 + 跨进程 `O_EXCL` 文件锁；100 并发 → 1 次 preAuth |
| 7 | 吊销后不断言、不验证、直接当已处理 | ✅ 吊销后 `send()` 直接返回 `revoked:true`，且**验证过不会发出任何请求** |
| 8 | 「重新授权」做成谁都能点的按钮 | ✅ 入口**不渲染给访客**，必须先「管理员登录」；服务端每个端点独立校验。配额降级为提示线（手动放行），靠熔断兜住失控 |

第 5 项是唯一无法完全满足的：这个通道只发一套凭据。缓解措施是 dev 强制 dry-run（自测第 7 项验证生产配额消耗 0）。

---

## 十、验收对照

跑 `node /path/to/vault-selftest.js <项目根>`，46 项全过：

| 规范验收项 | 实现 |
|---|---|
| 1. 全仓库 grep 不到凭据明文 | 扫描 js/json/html/css/md，5 类已知凭据 0 命中 |
| 2. 日志检索不到完整 token 与手机号 | `scrub()` 只留后 4 位；手机号首 3 尾 4 |
| 3. 落盘为密文，离线无法还原 | 复制 `state.json` 到别的目录（无密钥）→ 解密失败 |
| 4. 100 并发刷新只调 1 次 | `Promise.all(100)` → `probeCalls === 1` |
| 5. 杀进程重启凭据与状态完整恢复 | 新实例只读磁盘 → 状态/计数/令牌全部一致，刷新增量 0 |
| 6. 删密钥后可启动但拒绝发送并明确报错 | `health.ok=false`，`send` 返回含「密钥」的错误，`sendCalls === 0` |
| 7. dev 任意调试，生产配额 0 | dev 判定 + dry-run，`sendRaw` 不发真实请求 |

补充验证：三类凭据独立子密钥、状态机单向流转、EXPIRING 不被掩盖、审计链防篡改、令牌不进命令行、一次性目录无残留。
