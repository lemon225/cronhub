# relay/ · Cloudflare 中继源码

这里的三份文件是**源码正本**，部署时才复制到 `D:/Temp/2026-11-08-cloudflare-relay/`。完整技术文档在 [`../docs/RELAY.md`](../docs/RELAY.md)。

| 文件 | 部署到 | 版本 |
|---|---|---|
| `_worker.js` | Pages `cronhub-sms-relay`（复制成 `pages-adv/_worker.js`） | `relay-v2` |
| `index.html` | Pages `cronhub-sms-relay`（复制成 `pages-adv/index.html`） | — |
| `worker-companion.js` | Workers `sms-relay`（API `PUT /workers/scripts/sms-relay`） | `companion-v2` |

## 最小部署流程

```bash
# 1) Pages 中继 —— 必须 Wrangler 3.28 + 根目录单文件 _worker.js
cd D:/Temp/2026-11-08-cloudflare-relay
cp <项目>/relay/_worker.js pages-adv/_worker.js
cp <项目>/relay/index.html pages-adv/index.html
CLOUDFLARE_API_TOKEN=<Pages:Edit 令牌> \
CLOUDFLARE_ACCOUNT_ID=<CF_ACCOUNT_ID> \
node node_modules/wrangler/bin/wrangler.js pages deploy pages-adv \
  --project-name cronhub-sms-relay --commit-dirty=true

# 2) Workers 定时陪护（上传脚本，不动 Cron Trigger）
TOK=<Workers:Edit 令牌> node D:/Temp/2026-11-10-cronhub-b8/upload-companion.cjs

# 3) 网站侧：改完直接部署（用户已长期授权），部署前停本地预览、确认无 data/state.json
```

## 部署后必做的三项核对

```bash
# ① 线上跑的是哪一版
curl -s -H "X-Relay-Secret: $SECRET" https://cronhub-sms-relay.pages.dev/__status
#    → ver=relay-v2，响应头 x-relay-ver: relay-v2

# ② 双向陪护是否成立（200 = 两侧都通）
curl -s -H "X-Relay-Secret: $SECRET" https://cronhub-sms-relay.pages.dev/__guard

# ③ 网站侧是否看到陪护状态
curl -s "https://cronhub.app.workbuddy.host/api/health?sharecode=<sharecode>"
#    → build / companion.relay / companion.guard / companion.wake
```

Workers 侧还要确认上传响应里 `handlers=["fetch","scheduled"]`，且
`GET /accounts/{acct}/workers/scripts/sms-relay/schedules` 仍有 `*/30 * * * *`。

## 本地回归

```bash
cp relay/_worker.js        D:/Temp/2026-11-10-cronhub-b8/relay-test/_worker.mjs
cp relay/worker-companion.js D:/Temp/2026-11-10-cronhub-b8/relay-test/companion.mjs
node D:/Temp/2026-11-10-cronhub-b8/relay-test/local.mjs
# 30 项，模拟 CF 边缘的 fetch / Request / Response，不需要真实网络
```

## 别踩的坑

- `functions/` 目录方案在 API / Wrangler 3.114 / 4.158 下一律 `uses_functions:false`，只有根目录 `_worker.js` 有效。
- 部署 Pages 的令牌和改 Workers 的令牌**权限不同**，是两把，别拿错。
- 所有管理端点都要 `X-Relay-Secret`；`/__probe` 的 `status:403` 是正常，判据看 `ok`。
- `/__guard` 只回打 `/api/health`，**绝不打 `/api/wake`**（会触发调度形成回环）。
- 唤醒令牌轮换请改 `WAKE_TOKEN` 变量，不要改代码重部署；API 令牌无权 `PUT .../settings`（405），要去控制台改。
