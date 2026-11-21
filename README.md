# GitHub 情报中心 · GitHub Intel Center

一个跑在 Cloudflare Workers 上的「黑客情报中心」风格面板：定时巡检 GitHub 热门仓库，用**规则引擎**（不是 AI）做热度研判和学习点标注，告诉你最近哪些开源项目在飙升、各自值得学什么。

单文件 `worker.js`，零依赖，数据存 KV。深色面板：近黑底 + 霓虹绿/青 + 等宽字体 + 扫描线纹理 + 跑马灯。

## 功能

- **九个情报通道**（v2 新增 3 条；每轮巡检共 9 次 GitHub Search API 调用，远低于免费版 50 子请求上限）
  1. `surge` 飙升新星：近 30 天新建、stars>50
  2. `trending-week` 本周热门：近 7 天有推送、stars>5000 的老牌热门
  3. `ai-agent` AI/AGENT：ai-agent / llm / mcp 关键词
  4. `workers` 边缘/Bot：cloudflare-workers / serverless / telegram-bot
  5. `media` 多媒体生成：comfyui / image-generation / text-to-speech
  6. `devtools` 开发工具：developer-tools / browser-automation / playwright
  7. `security` 网安·红队·SRC：cybersecurity / red team / bug bounty / penetration-testing / vulnerability，stars>200、近 90 天有推送
  8. `skills` Skill 生态：claude skills / agent skills 关键词，stars>100
  9. `creator` 自媒体全套：short-video / video-editing / ffmpeg / content creation / subtitles / livestream，stars>200
- **重点监控种子 WATCHLIST**：代码内 `SEEDS` 人工精选清单共 23 条（Skill 生态 12 仓 + 1 个外部站点 Cocoloop、写作 3、科研 1、自媒体 8、网安 2），每条带人工撰写的一句学习点。面板有独立「重点监控 WATCHLIST」分区按类别分组展示；种子若被巡检命中同名仓库，卡片会合并显示其实时 ★/热度/评级/本轮增量，未命中标注「点名监控中」。种子只做点名展示，不额外发请求抓取（省流）。
- **快照对比**：每轮把星标数存快照（KV `intel:prev`），下一轮算出每个仓库的本轮增量 `starDelta`，面板上有 `+N★ 本轮` 徽章，飙升榜按增量排序。
- **规则研判**（代码里是 `LEARNING_MAP` 关键词表 + 加权公式，面板如实标注「规则研判」）
  - 热度分 0-100：星标规模 40 + 本轮增量 30 + 推送新鲜度 20 + fork 活跃度 10
  - 学习点标签：40 条关键词映射（v2 新增 pentest/red-team→红队评估方法、vulnerability→漏洞管理、bug-bounty→SRC 众测思路、osint→开源情报、skill→Skill 封装范式、subtitle→字幕工程、short-video→短视频工作流等）
  - 评级：S ≥70、A ≥45、B 其余；每条带一句模板研判，如「近一轮 +320★，Python MCP 协议接入项目，值得看它的 MCP 协议接入。」
- **面板交互**（v2 升级）：粘性顶栏带北京时间实时时钟与巡检状态；KPI 增加通道数与种子数；粘性筛选条支持通道 + 评级（S/A/B）双维筛选与搜索；各榜单卡片带排名、热度条动画、悬停辉光；每张卡直达 GitHub 仓库页；立即巡检按钮带 30 分钟节流。

## 部署步骤

1. 在 Cloudflare 控制台建 KV namespace（如 `github-intel-hub-data`）。
2. 新建 Worker，把 `worker.js` 全文粘贴进去（或用 wrangler 部署本目录）。
3. 给 Worker 绑 KV：变量名必须为 **`INTEL_KV`**，指向第 1 步的 namespace。
4. （可选）加 Cron 触发器，推荐 `17 */6 * * *`（每 6 小时巡检一次；未认证 GitHub 限额低，别太勤）。
5. （可选）加 Secret `GITHUB_TOKEN`：填一个 GitHub Personal Access Token（只读公开数据即可）可大幅提高 API 限额；不填也能跑。
6. 打开 Worker 地址，点「立即巡检」拉第一批数据；或 `curl -X POST https://<你的地址>/api/refresh`。

## 接口

| 路由 | 说明 |
|---|---|
| `GET /` | 情报面板（HTML） |
| `GET /api/repos` | 最新一批仓库 JSON（含 heat/grade/learnTags/verdict/starDelta），并附 `watchlist` 种子合并数据 |
| `GET /api/watchlist` | 重点监控种子清单 JSON（含每条的分类、人工学习点与实时命中数据 `live`，未命中为 `null`） |
| `GET /api/stats` | 最近一轮巡检元信息（时间、各通道条数、错误） |
| `POST /api/refresh` | 手动触发巡检，30 分钟内重复调用会被节流（返回 `throttled: true`） |
| Cron `scheduled()` | 定时巡检，不走手动节流 |

KV 键：`intel:latest`（最新数据）、`intel:prev`（上轮星标快照）、`intel:meta`（巡检元信息）。

## 数据诚实说明

- 数据源只有 GitHub Search API 的公开搜索结果，排序与收录口径由 GitHub 决定；通道查询是关键词规则，不是 GitHub 官方 Trending。
- **星标增量需要至少两轮巡检**：第一轮所有仓库的增量为空，研判会写「新入情报库」；第二轮起才有 `+N★`。
- 未认证调用限额很低（Search API 约 10 次/分钟，且有每小时配额），一轮 9 次调用没问题，但不要高频手动刷新——代码里已做 30 分钟节流。
- 某通道抓取失败时，该通道在面板跑马灯里会被标为异常，并沿用上一轮该通道的旧数据，不会把整片数据抹掉；全部通道都失败时不覆盖已有数据。
- 研判、评级、学习点全部是规则产出，可能误判（比如描述里蹭关键词的仓库），仅供筛选参考，不构成「值得学」的结论保证。
- KV 是最终一致存储，巡检刚写完的几十秒内面板可能短暂读到旧数据，属正常现象。

## 本地测试

```bash
node --check worker.js
```

本地 harness（Mock KV + Mock GitHub API）不在本目录，v2 实测 27/27 通过：9 通道恰好 9 次请求、新通道标签与学习点、种子合并（含第二轮增量 +150 的精确断言）、/api/watchlist 形状、面板新分区与交互元素。
