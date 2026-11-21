# 文档地图 · GitHub 情报中心

| 文档 | 内容 | 适合谁 |
|---|---|---|
| [DEPLOY.md](DEPLOY.md) | 部署手册：从零部署、密钥清单、Webhook 配置、验证清单、升级回滚、故障排查 | 第一次部署 / 换账号重部署 |
| [DESIGN.md](DESIGN.md) | 设计文档：架构、数据流、KV 键目录、研判公式、快照与改名检测、推送状态机 | 改代码前先读 |
| [API.md](API.md) | 接口手册：全部 HTTP 接口的参数、响应、节流与鉴权 | 对接 / 调试 |
| [BOT.md](BOT.md) | Bot 手册：命令清单、频道自动识别原理、多频道管理、隐私说明 | 配置 Telegram 推送 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志：v1 → v5.3.1 每一版改了什么、实测结论 | 追溯历史 |

根目录 [README.md](../README.md) 是功能总览；本目录是「怎么部署、怎么运作、怎么改」的全套手册。

## 30 秒速览

- 单文件 Cloudflare Worker（`worker.js`，约 1470 行，零依赖）+ 一个 KV 命名空间，就是全部家当。
- 定时（Cron 每 6 小时）用 GitHub Search API 巡检 11 个通道，把仓库、星数快照、研判结果存 KV。
- 面板（`/`）服务端渲染；总统简报（`/api/brief`）由规则引擎从最新数据现场组装。
- Telegram：每日简报推私聊 + 已登记频道；Bot 命令只读查询；频道靠 `my_chat_member` / `channel_post` 事件自动登记。
- 所有密钥只以 Worker Secret 形式存在，代码与仓库里没有任何凭证明文。
