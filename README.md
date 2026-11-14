# CronHub · 定时任务控制中心

在线运行的定时任务控制台。调度器跑在服务端，**关掉浏览器页面任务照常执行**。

> **配套文档**
> - 短信通路 / Cloudflare 中继 / 双向陪护 / 部署与排障 → [`docs/RELAY.md`](docs/RELAY.md)
> - 短信链路技术档案：根因证据链 / 超时预算 / 判据语义 / 实测基线 / 已知限制 → [`docs/SMS-CHAIN.md`](docs/SMS-CHAIN.md)
> - 逐批改动与构建号对照 → [`docs/CHANGELOG.md`](docs/CHANGELOG.md)
> - 中继源码（Pages `_worker.js` + Workers 定时陪护）→ `relay/`；可复跑用例 → `tests/`（`npm test`）
>
> 短信经 `https://cronhub-sms-relay.pages.dev` 中转，该中继是**唯一短信出口**；网站与 Cloudflare 每 30 分钟互相唤醒/体检。改动中继代码请务必先读 `docs/RELAY.md` 的「已否证路线」与「部署流程」，结论性判据以 `docs/SMS-CHAIN.md` 为准。

## 启动

```bash
node server.js
```

然后打开 http://127.0.0.1:8787

**默认「进入即可见」**：不设任何环境变量时，打开链接直接进控制台，不需要密码。这是当前的产品形态。

需要重新上锁时加一个开关重启：

```bash
REQUIRE_PASSWORD=1 node server.js          # 恢复密码登录
REQUIRE_PASSWORD=1 FORCE_PASSWORD=<新密码> node server.js   # 顺便换密码
```

改端口：`PORT=9000 node server.js`
改数据目录：`DATA_DIR=/var/lib/cronhub node server.js`
改监听地址：`HOST=127.0.0.1 node server.js`（默认 `0.0.0.0`，容器/反向代理下需要）

要求 Node 18+（用到内置 `fetch`）。**零第三方依赖**，不需要 `npm install`。

## 访问控制与管理员入口

| 模式 | 怎么进 | 谁能看到管理面板 |
|---|---|---|
| 默认（开放访问） | 打开链接直接进 | 只有输入过管理密码的会话 |
| `REQUIRE_PASSWORD=1` | 先输密码 | 只有用管理密码登录的会话 |

开放模式下，管理密码输入框藏在 `?admin` 后面：

- 访问 `你的地址/?admin` 会弹出「管理员验证」框，也可以进控制台后在「设置 → 访问控制」点「管理员入口」
- 输入 `chneaki` 或 `chen`（`ADMIN_PASSWORDS`），页面出现管理面板，地址栏自动抹掉 `?admin`
- 不输也能正常用全部业务功能，只是看不到管理面板

```bash
ADMIN_PASSWORDS=chneaki,chen node server.js   # 逗号分隔，可配任意个
```

几个刻意的设计：

- **管理入口不可见**。普通身份的 DOM 里根本没有管理面板节点，不是靠 CSS 隐藏；`/api/admin/*` 接口对非管理会话一律返回 `404 接口不存在`，连「你没权限」都不告诉它，避免被探测出接口存在。
- **管理密码不受失败锁定影响**。别人在外面故意输错 10 次把你锁了，你用管理密码照样能进（并有「解除锁定」按钮一键清空）。
- **登录响应里不透露角色**。只返回 `{"ok":true,"role":...}` 给调用者本人。

管理面板能看到：运行环境（内存/PID/端口/存储可写状态）、最近的登录尝试记录（时间、IP、成功失败、身份）、一键解除锁定。

## 部署到线上

项目满足单端口公网服务的条件，可以直接发布：

- 只监听 `PORT`，绑定 `0.0.0.0`
- 无第三方依赖，无需构建
- 数据用 JSON 文件，不依赖 MySQL / Redis
- 反向代理下通过 `X-Forwarded-Proto` 自动判断是否为 HTTPS，进而决定 Cookie 是否加 `Secure`

如果沙箱工作目录只读，服务会自动退到系统临时目录并在设置页显示存储状态；这种情况下重启会丢数据，建议用 `DATA_DIR` 指到一个持久化目录。

## 功能

**任务**
- 两种类型：`HTTP 签到`（定时请求一个地址，适合自动打卡/接口保活）、`定时提醒`（到点推消息给自己）
- 两种节奏：标准 5 段 cron（`分 时 日 月 周`）、固定间隔（每 N 分钟）
- 输入 cron 时实时显示人话翻译；内置 5 个常用预设
- **多步骤**：一个任务可按顺序串行发多个请求，前一步失败则后续跳过；某步标「允许失败」则失败后继续
- **多状态码**：除主期望码外可再声明「也算成功」的码（如 `400`），避免「今天已签到」这类正常状态被记成故障
- 支持立即执行、暂停/启用、编辑、删除
- 失败的任务会自动写入告警通知

**签到**
- 手动打卡，当天去重（重复请求返回 409，不会多记）
- 连续天数、最长连续、本月完成率
- 月度日历 + 14 天热力图 + 按天分布图

**提醒通道**
- 站内通知（收件箱，支持筛选和已读）
- **手机推送（NotifyMe）**：直推安卓通知栏，国内网络可达；支持 uuid / FCM token 两种凭据，可只推失败、也可成功也推
- Webhook：通用 JSON / Server酱 / 飞书 / 钉钉 / Bark
- 邮件：内置极简 SMTP 客户端，465 隐式 TLS 或 587 STARTTLS，无需第三方服务

## 给 Agent 用的接口

机器人/脚本可以直接调这几个接口，不必模拟点击界面。参数都是 JSON。

| 接口 | 用途 |
|---|---|
| `POST /api/tasks/upsert` | 按 `name` 批量新建或更新任务；`pruneTag` 可清理同名前缀的历史任务；`keep:false` 表示确保它不存在 |
| `PUT /api/settings/notifyme` | 一次性写入手机推送凭据，响应只回脱敏值 |
| `POST /api/tasks/{id}/run` | 立即执行并拿到逐步骤结果 |
| `GET /api/state` | 读全量状态（任务、日志、通知、设置） |

`POST /api/tasks/upsert` 示例：

```json
{
  "pruneTag": "WorkBuddy",
  "items": [{
    "name": "WorkBuddy 每日签到 + 猫猫旅行",
    "type": "http",
    "schedule": { "mode": "cron", "cron": "0 9 * * *" },
    "config": {
      "url": "https://example.com/status",
      "method": "POST",
      "headers": "{\"Authorization\":\"Bearer ...\"}",
      "body": "{}",
      "steps": [
        { "name": "签到", "url": "https://example.com/checkin", "method": "POST",
          "expectStatus": 200, "alsoOkStatus": [400], "optional": true }
      ],
      "notify": { "enabled": true, "onSuccess": true, "onFailure": true }
    }
  }]
}
```

> **凭据提醒**：`config.headers` 里的 token 会以明文存进服务端的 `data/state.json`。开放访问模式下任何拿到链接的人都能读到，建议 `REQUIRE_PASSWORD=1`，并定期更换 token。

### 任务完成通知（`config.notify`）

任务编辑弹窗最下面的「任务完成通知」开关，控制**这个任务跑完要不要把结果推出去**。三态语义：

| 取值 | 行为 |
| --- | --- |
| 不写 `notify` | 按缺省渠道（站内 + 手机推送）跟随全局开关（老任务保持原样） |
| `{"enabled": false}` | 这个任务不发完成通知，其他任务照旧 |
| `{"enabled": true, "onSuccess": bool, "onFailure": bool, "channels": [...]}` | 按任务自己勾的时机与渠道推 |

**通知渠道可多选**：`channels` 取 `inapp` / `notifyme` / `webhook` / `email` 的任意组合，默认 `["inapp","notifyme"]`（与渠道功能上线前行为一致）。Webhook 和邮件直接复用设置页里对应通道的配置。

全局的「启用手机推送」始终是手机渠道的总闸：它关掉时任何任务都不推手机（凭据也一并失效）。任务级开关只能收窄，不能越过总闸。

**凭据输入框「留空 = 不修改」**：设置页回显的凭据是脱敏串（如 `dz1h…cul0`），输入框不会回填它；留空保存时服务端保留原凭据，掩码串即使被提交也会被服务端丢弃。

## 数据

全部状态存在 `data/state.json`，采用「写临时文件 → 重命名」的原子写入，断电不会写坏文件。

```json
{
  "tasks": [],          // 任务定义 + 运行统计
  "checkins": [],       // 签到记录
  "notifications": [],  // 站内通知
  "logs": [],           // 执行日志（最多 300 条）
  "settings": {}        // 通道配置
}
```

删除该文件即恢复初始状态（会重新生成两个示例任务）。

## 调度机制

- 每 15 秒扫描一次，检查 `nextRun <= now` 的任务
- 触发前**先推进 nextRun**，避免执行耗时导致同一任务重复触发
- 延迟超过 3 分钟的执行标记为「补跑」，日志里可区分
- 服务启动时，若某任务的下次时间已过期超过 24 小时，直接跳到下一个周期，不做堆积补跑
- **错过补跑策略**（设置页可切，立即生效）：
  - `补跑一次`（默认）：唤醒后发现错过就执行一次，适合每日签到
  - `跳过并通知`：cron 任务迟到超 15 分钟就不执行，发一条站内说明（interval 任务不适用）

## 云端休眠与保活（省资源策略）

托管平台空闲时会休眠实例，**进程自己无法唤醒自己**，只能靠外部请求。平台只有「运行中 / 休眠」两态，没有「关掉部分组件的半休眠」，所以按资源开销提供三档模式，按需选择：

| 模式 | 做法 | 资源开销 | 任务准时度 |
|------|------|----------|-----------|
| ① 按需唤醒（推荐） | 外部探活在准点任务前 1~5 分钟打一次 | 几乎为零 | 准点（依赖外部服务） |
| ② 纯兜底 | 什么都不配，靠「错过补跑」策略 | 零 | 可能迟到 |
| ③ 持续保活 | 设置页打开「持续保活」开关 | 实例常驻运行 | 永远准点 |

操作要点：

1. 设置页「保活探针」卡片里复制探活地址（`GET /api/health`，公开、极快）
2. 模式①：在免费外部定时服务（如 cron-job.org）建 GET 任务；模式③：直接打开卡片里的「持续保活」开关，服务端每 10 分钟自请求一次探活地址，保存即生效、重启自动恢复
3. 模式①②下其余时间不用管 —— 实例睡它的，错过的任务由「错过补跑」策略兜底

## 性能（移动/电信高延迟网络优化）

减少「往返次数 × 传输字节」，这是高 RTT 网络下唯一有效的优化方向：

1. **关键 CSS 内联**：style.css 直接进 HTML，浏览器拿到 HTML 即可首绘，省一整个渲染阻塞往返
2. **JS 压缩**：`node build.js`（esbuild）生成 `public/app.min.js`，服务端对 `/app.js` 请求直接回压缩内容（预 gzip 常驻内存，零等待）；源码 `app.js` 保留可读
3. **JS preload**：`<head>` 里 preload 提示让脚本随 HTML 解析并行下载，不必等解析到页尾
4. **gzip**：所有文本资源 >1KB 自动压缩
5. **版本号长缓存**：资源 URL 带 `?v=<内容哈希>`，缓存一年 immutable；改版自动失效
6. **并行启动**：身份校验与数据拉取同时发出，省一次串行往返；`defer` 脚本不阻塞首屏

效果：首屏只需 HTML 一个请求（内联 CSS 已含样式），JS/数据并行加载。改前端后记得重跑 `node build.js`。

## 7×24 运行的注意事项

调度器活在这个 Node 进程里。**本地关掉终端，任务就停了。** 要长期运行：

1. 部署到服务器，用 `pm2` / `systemd` 守护进程
2. 部分免费托管平台无流量时会休眠，导致任务延迟 —— 建议配一个外部定时探活 `GET /api/health`
3. 签到类任务建议在目标站点侧也做一次「当日是否已执行」判断，双重保险

## 安全

- **默认不设访客门槛**：任何人拿到链接都能读写任务和数据。这是「进入即可见」的代价，请自己判断是否接受
- 想限制访问就 `REQUIRE_PASSWORD=1` 重启。开启后密码由服务端强制锁定，**每次启动都用 `FORCE_PASSWORD` 重算哈希**，改 `state.json` 或走改密接口都会被重启复原（改密接口本身封为 403）
- 管理密码始终有效，与开放/锁定模式无关；管理接口永远只认 admin 会话
- 密码用 scrypt 加盐哈希存储，比较用定长常量时间比较
- 登录态是 HMAC 签名的 token，放在 `HttpOnly` + `SameSite=Lax` 的 Cookie 里，有效期 30 天；签名密钥持久化，服务重启不会掉登录
- 同一 IP 连续输错 10 次锁定 15 分钟（管理密码不受此限制）

**必须知道的一点**：开放模式下数据完全裸奔。如果要放到公网，建议 `REQUIRE_PASSWORD=1` + 自己的 `FORCE_PASSWORD`，别用默认的 `7777`。

## 短信凭据治理

这一节对应《授权凭据管理规范》的十条要求，也是那份规范的**交付说明**。

### 三类凭据，分开存、分开加密

| 类型 | 本站具体是什么 | 存在哪 | 敏感级 |
|---|---|---|---|
| 长期凭据 | `uuid` / `clawUid`（绑定标识，等同账号密码） | 保险库 `longterm` 分区 | 最高，失效要人工重新扫码 |
| 短期凭据 | `creditToken`（≈5 分钟 TTL） | 保险库 `shortterm` 分区 | 中，可重取 |
| 应用凭据 | `code` / `kid` / `strategyId` | 保险库 `app` 分区 | 中高，换 Key 即可 |

三个分区**用 HKDF 从主密钥派生各自的子密钥**，一个分区泄露不牵连另外两个。`state.smsCredential` 里只剩状态与计数，**连密文都不放** —— 状态和凭据是两份物理上分开的东西。

### 加密方式

AES-256-GCM，密文格式 `v1:nonce:tag:data`（版本号 + 12 字节随机 nonce + 认证标签 + 密文）。认证标签的意义是：密文被改过一个字节就解不开，不会悄悄返回垃圾数据。

### 密钥来源（三档，按优先级）

1. `CRONHUB_SMS_KEY` 环境变量（推荐，KMS 注入同理）
2. `CRONHUB_SMS_KEY_FILE` 指定的密钥文件 —— **指到项目目录之外就是真正的「密钥与数据不同处」**，单容器部署请用这个
3. 都没配时：`data/.secrets/sms-master.key`（首次启动自动生成，权限 600）

明确**不做**的事：不从 `state.json` 派生、不从代码常量兜底。旧版 `Vault` 类里那句 `|| 'cronhub-sms-fallback'` 已经删掉 —— 常量兜底等于「所有人共用同一把钥匙」，比不加密更糟：它让人以为数据是加密的。

密钥文件丢了或删了会怎样：**服务照常启动，但拒绝发送并明确报错**，不会自动生成一把新钥匙把旧密文变成永久垃圾（见 `loadMasterKey` 里的 `hasCipher` 判断）。恢复方式只有一个 —— 找回那个密钥文件；找不回来就重新扫码授权。

### 怎么把凭据放进保险库

`lib/sms/config.json` 里现在**只剩非敏感字段**（`apiUrl / pid / name / tpl / timeout` + RSA 公钥 `key`），
`code / kid / strategyId` 已经不在仓库里；`auth_info_ydrz.json`、`clawUid.json` 也不再以明文躺在 `lib/sms/`。
三样东西全部在 `data/state.json` 的 `credentialVault` 里，加密态。

需要导入时只有一条正规路径：

```bash
# 体检：只读来源、列出键名与长度，不写任何东西（也不会顺手生成密钥）
node tools/credential-import.cjs --dir <含 config.json / auth_info_ydrz.json / clawUid.json 的目录>

# 写入：加密入库 + 逐条回读校验（sha256 比对，不打印值）
node tools/credential-import.cjs --dir <同一目录> --apply

# 清场：确认线上发送正常后，把来源明文就地替换成 [moved-to-vault]
node tools/credential-import.cjs --dir <同一目录> --apply --shred
```

`--shred` 只在**全部键回读校验通过**之后才动来源文件 —— 顺序反了就等于把自己的唯一副本毁掉。

### 谁能读到凭据（全站共 2 处）

| 位置 | 读什么 | 边界 |
|---|---|---|
| `server.js` → `withCredentialSandbox()` | `app` + `longterm` 分区明文 | 只物化到 `data/.sms-runtime/<随机>` 下的临时 JSON（0600），子进程用完 `finally` 里立刻 `rmSync` |
| `server.js` → `tokenStore.read` | `shortterm` 分区的 `creditToken` | 只在调用瞬间解出，用完不缓存 |

业务代码永远拿不到 `refreshToken` —— 本通道压根没有（`status()` 里如实返回 `hasRefreshToken: false`）。令牌传给子进程走的是 **stdin**，不是 `--token` 参数：`ps aux` 能看到别人的 argv，看不到别人的 stdin。

### 生命周期状态

`ACTIVE` → `EXPIRING`（硬过期 ≤7 天，只告警）→ `NEED_REAUTH`（已失效，停止自动请求）→ `REVOKED`（已吊销，等人工）。

迁移只走 `transition()` 一张流转表，非法迁移会被拒绝并记审计。**没有任何按钮能把状态硬拉回 `ACTIVE`** —— 只有「真正取到新令牌」这一条代码路径可以。

本通道没有 `refresh_token`，所以按规范给「绑定后 180 天必须人工重授权」的硬过期日，在 7 / 3 / 1 天各告警一次。

### 审计

`data/audit/sms-YYYY-MM.jsonl`，只追加、带 `seq + prevHash` 哈希链（改任何一条历史都会让后续校验失败），保留 90 天。它和业务日志是两个东西：业务日志是 state 里的环形缓冲，会被覆盖、会截断；审计台账不能。

### 泄露应急预案（Runbook）

**判定信号**：凭据出现在仓库 / 截图 / 日志导出里；移动侧告警或异地登录；本地出现从未见过的调用来源。

**处置（禁止"先观察一下"）**：

```bash
# 0) 先停服务，否则内存里的状态会把改动覆盖回去
# 1) 诊断 + 打印计划（默认只读，不动数据）
node tools/credential-emergency.cjs

# 2) 确认后执行：吊销 + 熔断 24 小时（最高一档，期间零出站请求）
node tools/credential-emergency.cjs --apply

# 3) 排查泄露面：仓库历史、镜像层、备份、日志
git log -p | grep -iE 'ak_|secret|token' | head      # 无 git 就搜备份与共享盘
node tools/credential-emergency.cjs | sed -n '/泄露面排查/,/另外请人工/p'

# 4) 换主密钥（旧密钥作废，旧密文随之失效 —— 这一步要在重新授权之前做）
node tools/credential-keygen.cjs --file D:\safe\sms.key
#    然后设 CRONHUB_SMS_KEY_FILE=D:\safe\sms.key 再启动

# 5) 人工重新授权：干净设备 + 干净的出口网络（见「设置 → 短信通知」）
```

处置期间**故意不允许重新授权**：熔断期本来就禁止任何出站请求，先排查完再恢复。

### 环境隔离的现实约束

- `dev` 默认 **dry-run**：不取令牌、不发请求、生产配额消耗 0（`probeToken` 也拦了，因为 preAuth 才是最贵的那一步）。要真发必须显式设环境变量，见 `SMS_DRY_RUN` 的判定。
- `prod` 走最严本地配额：发送 20 条/天、间隔 ≥60 秒、刷新 24 次/天、授权 3 次/天且 1 次/小时。
- **做不到的一条**：dev 与 prod 共用同一套凭据（只有一个号）。规范给的退路就是「dev 强制 mock + prod 最严配额」，这里按退路执行。
- **单容器部署的妥协**：密钥文件默认落在 `data/.secrets/`，和 `state.json` 同一个卷。要做到「不同处」必须用 `CRONHUB_SMS_KEY_FILE` 指到另一个挂载点 —— 平台暂时不支持注入环境变量，所以这一条要等能配 secret 时才算彻底达成。

### 自检

```bash
node verify-credential.cjs
```

44 项断言，覆盖规范第十条 7 项验收 + 第九条 8 条禁止项：明文扫描、脱敏、落盘密文、100 并发只刷 1 次、重启恢复、删密钥 fail-safe、dry-run 零消耗、吊销后断言。不起服务、不发短信、跑完自动清临时目录。

## 已知限制

- 单进程调度，不支持多实例同时运行（会重复触发）
- 邮件客户端只支持 AUTH LOGIN，不支持 OAuth2（QQ/163 用授权码即可）
- cron 不支持 `@daily` 这类宏，也不支持秒级字段
- 时区取服务端本地时区，前端只做展示，不做换算
- 登录失败锁定记录在内存里，服务重启会重置
- 管理密码写在环境变量里，不能从页面改（这是有意的：改密码需要重启，等于额外一道物理门槛）
