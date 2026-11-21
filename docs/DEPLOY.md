# 部署手册 · GitHub 情报中心

从零部署一套自己的实例。全部走 Cloudflare 免费额度。

## 1. 前置条件

- 一个 Cloudflare 账号（免费版即可）
- 一个 Telegram Bot（找 @BotFather 用 `/newbot` 创建，记下 token；token 只在部署时用，不要写进任何文件）
- （可选）一个只读 GitHub Token，用于消除未认证 Search API 的共享 IP 限流

## 2. 创建 KV 命名空间

```bash
wrangler kv namespace create github-intel-hub-data
```

或在 Cloudflare 控制台 Workers & Pages → KV 里新建。记下命名空间 ID，部署时绑定名固定为 `INTEL_KV`。

## 3. 部署 Worker

把 `worker.js` 部署为一个 Worker（脚本名任意，如 `github-intel-hub`），并设置：

- **KV 绑定**：变量名 `INTEL_KV` → 上一步的命名空间
- **Cron 触发器**：`17 */6 * * *`（UTC；对应北京时间 02:17 / 08:17 / 14:17 / 20:17，省流节奏）
- **workers.dev 子域名**：开启

## 4. 密钥清单（Worker Secrets）

| 密钥 | 必需 | 说明 |
|---|---|---|
| `TG_BOT_TOKEN` | 推 TG 才需要 | BotFather 给的 token |
| `TG_CHAT_ID` | 同上 | 简报私聊目标的数字 ID（可先私聊 Bot 后从更新里看，或用任意 ID 查询 Bot 获取自己的 ID） |
| `TG_WEBHOOK_SECRET` | 用 Bot 命令才需要 | 自定义随机串；`setWebhook` 时用同一个值，Worker 校验请求头 |
| `PUSH_KEY` | 建议 | 手动推送接口 `POST /api/brief/push` 的钥匙（请求头 `x-push-key`）；不配则该接口禁用 |
| `TG_CHANNEL_ID` | 否 | 手动频道目标（兜底）；v5.3 起频道可自动识别，一般不用配 |
| `GITHUB_TOKEN` | 否 | 只读 token，把 Search API 限额从共享未认证池切到独立额度，基本根除 403 限流 |

密钥只通过部署通道设置，**永远不要写进 worker.js、README 或提交记录**。

## 5. 挂载 Bot Webhook（启用命令与频道自动识别）

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d '{"url":"https://<你的-worker-域名>/tg/webhook","secret_token":"<TG_WEBHOOK_SECRET>","allowed_updates":["message","my_chat_member","channel_post"]}'
curl "https://api.telegram.org/bot<TOKEN>/setMyCommands" \
  -d '{"commands":[{"command":"brief","description":"今日总统简报"},{"command":"surge","description":"飙升 TOP5"},{"command":"hot","description":"热度 TOP5"},{"command":"sec","description":"网安焦点"},{"command":"watchlist","description":"重点监控状态"},{"command":"stats","description":"巡检状态"},{"command":"panel","description":"面板链接"},{"command":"help","description":"帮助"}]}'
```

三个事件类型缺一不可：`message`（命令）、`my_chat_member`（被拉进频道/升降管理员时登记或摘除）、`channel_post`（老频道补登记）。

频道接入：把 Bot 拉进频道并设为管理员即可；若它在 webhook 上线前就已是管理员，在频道里随便发一条帖子触发补登记。

## 6. 上线验证清单

- [ ] 打开面板 `/`，点「立即巡检」，等约 1 分钟（KV 同步），刷新看到 100+ 仓库、11/11 通道
- [ ] `GET /api/stats` 的 `meta.errors` 为 `{}`
- [ ] `GET /api/brief` 能组装出简报，`push.configured.dm` 为 true
- [ ] 私聊 Bot 发 `/brief`、`/stats` 有回复；发错命令有兜底提示
- [ ] `POST /api/brief/push` 不带 `x-push-key` 返回 401（配了 PUSH_KEY 时）
- [ ] `getWebhookInfo`：pending = 0、无 last_error_message

## 7. 升级与回滚

- 升级：用新版 `worker.js` 重新部署即可，KV 数据结构带自动迁移（快照 byId 格式、节流 map 格式、briefpush 目标格式均在读取时迁移），不需要手工处理数据。
- 每次发版在 GitHub 打 Release 且**不覆盖旧版**；回滚 = 拿旧 Release 对应提交的 `worker.js` 重新部署，Secrets 与 KV 不动。

## 8. 故障排查

| 现象 | 原因与解法 |
|---|---|
| 某个通道 0 条或 403 | GitHub 未认证 Search API 被共享出口 IP 限流；已内置失败重试一次；根除办法是配 `GITHUB_TOKEN` |
| skills 通道恒为 0 | 查询语法坑：OR 括号组里只能放**无引号 token**，带引号短语会让 total_count 变 0（详见 DESIGN.md） |
| 面板数字短暂对不上 | KV 全球最终一致约 1 分钟，属正常现象 |
| 频道收不到简报 | 先确认频道已登记（私聊 Bot 发 `/stats` 看自动频道数）；新登记频道可用带钥匙的手动推送单独补推（按目标节流，不受其他目标影响） |
| Bot 命令无反应 | 查 `getWebhookInfo` 的 pending 与报错；确认 `TG_WEBHOOK_SECRET` 与 setWebhook 时一致 |
| 手动推送返回 throttled | 该目标 6 小时内已手动推过；等节流过期，或等每日定时简报（定时推送不受手动节流影响） |
| Worker 内监控 workers.dev 地址恒 404 | 平台行为（Worker fetch 自家子域名不可达），外部访问正常；监控自家 Worker 需绑自定义域名 |
