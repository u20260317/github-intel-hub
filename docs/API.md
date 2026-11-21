# 接口手册 · GitHub 情报中心

基础地址：`https://github-intel-hub.u20261103.workers.dev`（自部署实例换成自己的域名）。除标注外均为只读、无鉴权。

## 页面

### `GET /`
面板 HTML（服务端渲染）。吸顶工具栏可折叠（状态存浏览器 localStorage）；分区可折叠；「全部情报」每页 24 条分页；标签 chip 可点筛选。

## 数据接口

### `GET /api/repos`
最新一轮全部仓库记录（分析后）：含 `id`、`full_name`、`stars`、`starDelta`、`heat`、`grade`、`tags`、`channels`、`renamedFrom`（如有）等字段。

### `GET /api/stats`
最新巡检元信息：每通道条数、`errors`、`total`、`newCount`、`renames`、`seedRefreshed`、`channelsOk/channelsTotal`。

### `GET /api/brief`
总统简报的结构化数据：`date`、`oneliner`、`topSurging`、`topHeat`、`securityFocus`、`watchlistFocus`、`renames`、`topTopics`（话题趋势，含 24h 增量与连续升温轮数）、`push`（推送配置与今日各目标状态；公开版只含计数，不含频道名/ID）。

### `POST /api/refresh`
触发一轮巡检。30 分钟节流（KV `intel:refresh`），节流中返回 `{status:"throttled", retryAfterMs}`。面板「立即巡检」按钮即调此接口。

## 推送接口

### `POST /api/brief/push`（需鉴权，v5.3.1）
手动推送今日简报到全部目标。

- 未配置 `PUSH_KEY` → `403 {ok:false, status:"push_disabled"}`
- 请求头 `x-push-key` 缺失或错误 → `401 {ok:false, status:"unauthorized"}`（不产生任何发送与节流记录）
- 鉴权通过后按目标算节流：某目标 6 小时内已手动推过则跳过（列入 `skipped`）；全部目标都被节流 → `{status:"throttled", retryAfterMs}`（到最早解禁的时间）
- 成功 → `{ok:true, pushed:true, results:{<目标>:true}, targets:[...], skipped:[...]}`

## Telegram 接口

### `POST /tg/webhook`
Telegram 更新入口。校验请求头 `x-telegram-bot-api-secret-token` 与 `TG_WEBHOOK_SECRET` 一致；未配置密钥时返回 404，密钥不符 403。处理三类更新：

- `message`：Bot 命令（见 BOT.md），仅私聊与群组文本消息
- `my_chat_member`：频道管理员变动 → 登记/摘除推送目标
- `channel_post`：频道帖子 → 兜底登记推送目标

### `GET /api/tg/commands`
Bot 命令清单（与已注册菜单一致），供面板或第三方展示。

## 通用说明

- 时间戳均为毫秒 Unix 时间；日期口径为北京时间（UTC+8）。
- KV 最终一致：刚写入的数据全球读到可能延迟约 1 分钟。
- 错误响应统一 `{ok:false, status|error}` 形态。
