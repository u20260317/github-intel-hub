<div align="center">

<img src="docs/assets/banner.jpg" alt="GitHub 情报中心 · GITHUB INTEL CENTER" width="100%">

# ◢ GitHub 情报中心

**GITHUB INTEL CENTER**

定时巡检 GitHub 热门仓库 · 规则研判（非 AI）· 总统简报 Telegram 双推

[![在线面板](https://img.shields.io/badge/在线面板-点击打开-22c55e?style=for-the-badge)](https://github-intel-hub.u20261103.workers.dev)
[![最新 Release](https://img.shields.io/badge/Release-v5.3.1-0ea5e9?style=for-the-badge)](https://github.com/u20260317/github-intel-hub/releases)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?style=for-the-badge)](https://workers.cloudflare.com)
[![单文件零依赖](https://img.shields.io/badge/单文件-零依赖-a855f7?style=for-the-badge)](#功能)

[在线面板](https://github-intel-hub.u20261103.workers.dev) · [最新 Release](https://github.com/u20260317/github-intel-hub/releases) · [功能](#功能) · [Bot 命令](#bot-命令v52) · [部署](#部署) · [文档](docs/README.md)

</div>

<p align="center"><strong>中文</strong> · <a href="README.en.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.uk.md">Українська</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.ar.md">العربية</a></p>

一个跑在 Cloudflare Workers 上的「黑客情报中心」风格面板：定时巡检 GitHub 热门仓库，用**规则引擎**（不是 AI）做热度研判和学习点标注，告诉你最近哪些开源项目在飙升、各自值得学什么。每天早上的「总统简报」自动推送到 Telegram 私聊与频道（频道加 Bot 为管理员即自动识别，免配置）。

单文件 `worker.js`，零依赖，数据存 KV。深色面板：近黑底 + 霓虹绿/青 + 等宽字体 + 扫描线纹理 + 跑马灯。

## 功能

- **十一个情报通道**（v2 新增 3 条、v3 再增 2 条；每轮巡检共 11 次 GitHub Search API 调用，远低于免费版 50 子请求上限）
  1. `surge` 飙升新星：近 30 天新建、stars>50
  2. `trending-week` 本周热门：近 7 天有推送、stars>5000 的老牌热门
  3. `ai-agent` AI/AGENT：ai-agent / llm / mcp 关键词
  4. `workers` 边缘/Bot：cloudflare-workers / serverless / telegram-bot
  5. `media` 多媒体生成：comfyui / image-generation / text-to-speech
  6. `devtools` 开发工具：developer-tools / browser-automation / playwright
  7. `security` 网安·红队·SRC：cybersecurity / red team / bug bounty / penetration-testing / vulnerability，stars>200、近 90 天有推送
  8. `skills` Skill 生态：claude-skills / agent-skills / claude-skill（无引号 token），stars>50、近 90 天有推送
  9. `creator` 自媒体全套：short-video / video-editing / ffmpeg / content creation / subtitles / livestream，stars>200
  10. `src-hunt` SRC·挖洞（v3 新增）：bug-bounty / 漏洞挖掘 / vulnerability-scanner / vulnerability-hunting，stars>30、近 90 天有推送
  11. `sec-learning` 网安学习资料（v3 新增）：pentest / ctf / web-security / cybersecurity-learning / security-roadmap，stars>200、近 90 天有推送
  - **查询语法教训（实测）**：GitHub Search 的 OR 括号组里只能放无引号 token；把带引号短语（如 `"claude skills"`）放进 OR 括号会直接返回 `total_count=0`（v2 的 skills 通道因此整轮为空）。引号短语只能放在括号外单独使用，如 `"bug bounty" tools stars:>100`（54 条，正常）。中文关键词可用，如 `漏洞挖掘 stars:>50`（47 条）。
- **重点监控种子 WATCHLIST**：代码内 `SEEDS` 人工精选清单共 23 条（Skill 生态 12 仓 + 1 个外部站点 Cocoloop、写作 3、科研 1、自媒体 8、网安 2），每条带人工撰写的一句学习点。面板有独立「重点监控 WATCHLIST」分区按类别分组展示；种子若被巡检命中同名仓库，卡片会合并显示其实时 ★/热度/评级/本轮增量；未命中的种子由巡检「单独保鲜」轮换抓取（见下方 v5 说明），再未轮到的标注「点名监控中」。
- **快照对比**：每轮把星标数存快照（KV `intel:prev`），下一轮算出每个仓库的本轮增量 `starDelta`，面板上有 `+N★ 本轮` 徽章，飙升榜按增量排序。
- **规则研判**（代码里是 `LEARNING_MAP` 关键词表 + 加权公式，面板如实标注「规则研判」）
  - 热度分 0-100：星标规模 40 + 本轮增量 30 + 推送新鲜度 20 + fork 活跃度 10
  - 学习点标签：40 条关键词映射（v2 新增 pentest/red-team→红队评估方法、vulnerability→漏洞管理、bug-bounty→SRC 众测思路、osint→开源情报、skill→Skill 封装范式、subtitle→字幕工程、short-video→短视频工作流等）
  - 评级：S ≥70、A ≥45、B 其余；每条带一句模板研判，如「近一轮 +320★，Python MCP 协议接入项目，值得看它的 MCP 协议接入。」
- **安全细粒度标签体系**（v3 新增，代码里是 `SECURITY_TAG_MAP`）：对仓库名+描述+topics 再做一轮安全关键词匹配，产出 SQL 注入 / XSS / SSRF / RCE / CTF 竞赛 / 开源情报 OSINT / 恶意代码分析 / 数字取证 / 蓝队防御 / 代码审计 / 内网渗透 / 权限提升 / 漏洞扫描 / PoC 研究 / 漏洞复盘 / 学习路线 / 钓鱼防御演练 / 逆向工程 / 模糊测试 / DevSecOps 等细粒度标签，与学习点标签合并去重、每仓上限 6 个。短词 RCE/PoC 用单词边界匹配，避免「source」误标 RCE、「epoch」误标 PoC；「learning」仅在安全语境下才标学习路线，避免把 machine learning 仓库误标。标签均为学习/研究向分类，不是利用指南。
- **面板交互**（v2 升级）：粘性顶栏带北京时间实时时钟与巡检状态；KPI 增加通道数与种子数；粘性筛选条支持通道 + 评级（S/A/B）双维筛选与搜索；各榜单卡片带排名、热度条动画、悬停辉光；每张卡直达 GitHub 仓库页；立即巡检按钮带 30 分钟节流。
- **标签筛选与标签云**（v3 新增）：每张卡的标签都是可点 chip，点击即按该标签筛选「全部情报」（与通道/评级/搜索 AND 组合），筛选条旁有激活标签 pill 可一键清除；网安专区上方有「热门标签」云，按安全三通道（security/src-hunt/sec-learning）仓库的标签频次取前 15，点云里的标签同样触发筛选。
- **全部情报分页**（v3 新增）：「全部情报」网格改为客户端分页，每页 24 条（与 DEAL HUB 约定一致），带上一页/下一页与页码按钮（页数多时省略号折叠），状态行显示「第 X / Y 页 · 共 N 条（筛选后）」；任何筛选/搜索/标签变化都会回到第 1 页并按筛选后集合重算页数，翻页后自动滚回「全部情报」区顶部。各专区仍是 Top-N 展示，不分页。

## 面板交互（v4）

- **分区折叠**：所有主要分区（飙升榜、热门新星、AI/AGENT 专区、各通道专区、重点监控、全部情报）的标题栏都可点击，点一下收起、再点展开（标题右侧 ▼/▶ 指示状态，展开带淡入过渡动画）。筛选条里有「全部展开 / 全部收起」一键按钮。默认全部展开。
- **分区内展开全部**：每个专区默认只展示前 6 张卡片，超过时底部有「展开全部 N 条 ▾」按钮，点开看全部分，再点「收起 ▴」恢复。与分区折叠是两回事：折叠收起整个分区（含标题下全部内容），展开全部只控制专区内的卡片数量。
- **双分页控件**：「全部情报」的分页控件在网格**上方和下方各有一套**（醒目的绿色边框样式），页码、上一页/下一页、状态行共享同一状态，点任意一套都会同步另一套；每页 24 条，与通道/评级/搜索/标签筛选照常联动（筛选变化回到第 1 页）。
- **总统简报（悬浮窗）**：右下角常驻「📋 总统简报」悬浮按钮，点开是一个可拖动的简报窗（按住标题栏拖动，支持鼠标与触控，拖不出屏幕边界；右上角 — 最小化、✕ 关闭，Esc 也可关闭；小屏自动适配 92vw 宽）。内容由服务端按当前数据用规则模板生成：【今日态势】一句话综述 + 关键词热度一行、【飙升 TOP3】、【热度 TOP3】、【网安焦点】（含热门安全标签）、【Skill 焦点】、【改名动态】（有仓库改名时出现）、【重点监控动态】（种子命中数与领跑种子），每条都可点进 GitHub。页脚标注生成时间与「规则引擎（非 AI 生成）」。同一份简报数据也以 JSON 形式内嵌在页面里（`#brief-data`），并可通过 `GET /api/brief` 单独获取。

## v5 新增

- **种子保鲜轮换**：每轮巡检在 11 次搜索之外，最多再花 3 次核心 Repos API 调用，专门保鲜「未被本轮巡检命中」的种子。游标存 KV `intel:seedcursor`，按种子清单顺序轮换（跳过已命中的），几轮就能把全部未命中种子轮一遍。保鲜结果存 `intel:seedlive`：当前全名/★/fork/推送时间 + 保鲜时间戳；种子卡的数据新鲜度分三级——本轮巡检实时命中 → 单独保鲜（卡片带「单独保鲜」标记与时间）→ 静态点名。保鲜走 `GET /repos/{owner}/{repo}`，改名仓库会被重定向到新地址，响应即当前身份：面板显示当前名并标注「原 X 已改名」，同时把当前 id 回写 `intel:seedids`；返回 404 的种子标注「疑似删库/改名未追踪」。一轮巡检 GitHub 调用上限 = 11 搜索 + 3 保鲜 = 14 次。
- **话题趋势历史**：每轮巡检把全部仓库的 topics 聚合（每话题：仓库数 + 累计星标，只留累计星标前 40）追加进 KV `intel:topichist`，只保留最近 56 个快照（6 小时一轮 ≈ 14 天）。趋势口径：与约 24 小时前最接近的历史快照比星标/仓库数增量，并计算「连续升温轮数」（从最新快照往回、累计星标连续严格递增的轮数）。24h 星标增量为正的前 5 个话题进总统简报的【话题趋势】，面板总览区标签云下方也有一行同样口径的话题趋势。历史不足两轮时自动隐藏。
- **总统简报 Telegram 每日推送**：配置 Secret 后，Cron 巡检成功且北京时间已过 08:00 时，把总统简报（与 Web 版同结构：今日态势/飙升 TOP3/热度 TOP3/网安焦点/话题趋势/改名动态 + 面板链接，HTML 格式、约 1800 字内）推送到 Telegram。推送目标可同时存在多个：`TG_CHAT_ID`（Bot 私聊）、`TG_CHANNEL_ID`（手动指定的频道，可填 `@频道名` 或 `-100…` 数字 id，v5.3 起只是可选覆盖），外加 v5.3 自动注册的全部频道（见下一条），共用 `TG_BOT_TOKEN`；一个目标都没有则功能静默关闭。**注意：往频道推送时，Bot 必须是该频道的管理员，否则 Telegram 会拒绝发帖。** 每日一次门禁按目标分别判定，状态存 `intel:briefpush`（v5.3 起为 `{date, targets: {"dm"|"ch:<chatId>": {ok,ts}}}`；v5.2 及更早的 `{date, dm, channel}` 旧格式会在读取时自动迁移，迁移来的成功记录照常门禁当天目标）：某个目标失败可在当天后续巡检自动重试，已成功的目标当天不重发。手动触发：`POST /api/brief/push`（v5.3.1 起需鉴权，见下文）一次推全部目标（私聊 + 手动频道 + 自动注册频道），节流按目标分别计算（KV `intel:pushmanual` 在 v5.3.1 起为 `{"dm"|"ch:<chatId>": ts}` 映射，每个目标 6 小时内最多手动推 1 次；新注册的频道没有节流记录，可立即补推，不必等其他目标的节流过期；旧全局格式的时间戳在读取时自动迁移为仅 `dm` 的戳）；`GET /api/brief` 的 `brief.push` 字段回报配置状态（`configured: {dm, manualChannel, autoChannels}`，只给计数、不含频道标题与完整 id）与今日各目标推送结果。
- **频道自动注册（v5.3）**：不用再手动查频道 id 填 `TG_CHANNEL_ID`。把简报 Bot 设为任意频道的**管理员**后，Telegram 会给 Webhook 发 `my_chat_member` 更新，Worker 据此把频道登记进 KV `intel:tgchannels`（`{ "<chatId>": {title, username, type, status, addedTs, updatedTs} }`），自动成为每日简报与手动推送的目标；Bot 被降级为普通成员、被移出或踢出时，该频道被标记 `removed` 并停止推送。v5.3 之前就已是管理员的频道没有这条事件，靠它在频道里的**第一条新帖**（`channel_post` 更新）补登记。`TG_CHANNEL_ID` 仍可作为手动覆盖与自动注册并存，按 chat id 去重只发一条。`/stats` 命令里自动注册频道的**标题只对机主可见**（发令 chat 即 `TG_CHAT_ID` 本人时），其他人只看到数量。
- **通道失败重试**：任一通道搜索报错（如未认证限额 403）时，间隔 2 秒自动重试一次再判定失败，重试过的通道记入巡检元信息 `meta.retriedChannels`；种子保鲜数记入 `meta.seedRefreshed`。
- **全局吸顶栈**：标题栏、热门标签行与筛选条（通道/评级/搜索/展开收起）已合并为一个吸顶栈（实心背景），从页面任何滚动位置都能直接筛选，不再只在「全部情报」区内可用；「全部情报」区内只保留上下两套分页控件。

## Bot 命令（v5.2）

简报 Bot（与每日推送同一个 Bot）支持只读命令：在 Telegram 里给 Bot 发命令即可，数据与面板同源（同一批 KV），**全部只读，不做任何管理动作**（不能触发巡检、不能改配置）。

| 命令 | 说明 |
|---|---|
| `/brief` | 今日总统简报（与每日推送同一份文本） |
| `/surge` | 飙升榜 TOP5（本轮星标增量） |
| `/hot` | 热度榜 TOP5 |
| `/sec` | 网安焦点（安全家族 TOP5 + 热门安全标签） |
| `/watchlist` | 重点监控状态（种子总数、巡检/保鲜/静态覆盖、星标 TOP5、疑似删库与改名提示） |
| `/stats` | 巡检状态（上次巡检时间、通道、本轮新增、种子保鲜数、推送配置与最近推送日期） |
| `/panel` | 情报面板与简报 JSON 链接 |
| `/help`（或 `/start`） | 命令列表 |

开通步骤（在 v5 推送配置的基础上多三步）：

1. 给 Worker 加 Secret `TG_WEBHOOK_SECRET`：自己生成一段随机字符串。不加这个 Secret 时 `POST /tg/webhook` 直接返回 404，命令系统等于关闭；加了之后，请求头 `x-telegram-bot-api-secret-token` 与它不一致的请求一律 403。
2. 注册 Webhook（把 `<TOKEN>`、`<SECRET>` 与域名换成自己的）。**`allowed_updates` 必须包含 `message`、`my_chat_member`、`channel_post` 三类**：第一类是命令，后两类是 v5.3 频道自动注册的来源（Bot 被设为频道管理员、或在已注册频道出现新帖时登记频道）；漏掉后两类，命令照常工作，但频道不会自动注册：
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<你的地址>/tg/webhook" -d "secret_token=<SECRET>" -d "allowed_updates=[\"message\",\"my_chat_member\",\"channel_post\"]"`
3. 注册命令菜单：先取清单 `curl https://<你的地址>/api/tg/commands`，把返回的 `commands` 数组作为 `commands` 参数调 `setMyCommands`，用户在输入框打 `/` 时就能看到命令菜单。

## 监控锚点：仓库 id（v4）

仓库会被改名或转移所有者，`full_name` 不是稳定锚点。v4 起每条记录都存 GitHub 数字仓库 `id`（Search API 原样返回），并以它为准对齐：

- 快照 `intel:prev` 改为 id 键格式 `{ts, byId: { "<id>": {s: 星标数, n: 当时全名} }}`。旧的扁平 `{full_name: stars}` 格式会被自动迁移：迁移轮先用旧快照按名建查找表照常算增量，巡检结束即写回新格式。
- 按 id 对齐算增量时，若 id 相同但全名变了，判定为**改名**：增量保留，记录上带 `renamedFrom`，巡检元信息 `meta.renames` 里记一条 `{from, to, stars}`，并出现在总统简报的【改名动态】里。
- 重点监控种子另存一份 id 映射（KV `intel:seedids`，`{种子全名: id}`，每轮巡检按名或既有 id 命中时更新）：种子改名后下一轮仍按 id 命中，面板上显示的是它的**当前**全名与链接。

## 文档

全套手册在 [docs/](docs/README.md)：[部署手册](docs/DEPLOY.md)（从零部署/密钥/webhook/排障）· [设计文档](docs/DESIGN.md)（架构/KV 键目录/研判公式/推送状态机）· [接口手册](docs/API.md) · [Bot 手册](docs/BOT.md) · [更新日志](docs/CHANGELOG.md)。

## 部署步骤

1. 在 Cloudflare 控制台建 KV namespace（如 `github-intel-hub-data`）。
2. 新建 Worker，把 `worker.js` 全文粘贴进去（或用 wrangler 部署本目录）。
3. 给 Worker 绑 KV：变量名必须为 **`INTEL_KV`**，指向第 1 步的 namespace。
4. （可选）加 Cron 触发器，推荐 `17 */6 * * *`（每 6 小时巡检一次；未认证 GitHub 限额低，别太勤）。
5. （可选）加 Secret `GITHUB_TOKEN`：填一个 GitHub Personal Access Token（只读公开数据即可）可大幅提高 API 限额；不填也能跑。
6. （可选）总统简报 Telegram 推送：加 Secret `TG_BOT_TOKEN`（BotFather 给的 token），再加 `TG_CHAT_ID`（你的私聊 id）；若要用手动推送接口 `POST /api/brief/push`，再加 Secret `PUSH_KEY`（自己生成一段随机字符串，调用时放在请求头 `x-push-key` 里；不加这个 Secret 时该接口直接 403 关闭）；频道目标不用手动配 id——按「Bot 命令（v5.2）」一节开通 Webhook（含 `my_chat_member`/`channel_post`）后，把 Bot 设为频道管理员即自动注册（v5.3），`TG_CHANNEL_ID`（频道 `@用户名` 或 `-100…` 数字 id）只作可选手动覆盖。推频道时 Bot 必须是该频道管理员。都不加则不推送。若还要开通 Bot 命令，再加 Secret `TG_WEBHOOK_SECRET` 并按「Bot 命令（v5.2）」一节注册 Webhook 与命令菜单。
7. 打开 Worker 地址，点「立即巡检」拉第一批数据；或 `curl -X POST https://<你的地址>/api/refresh`。

## 接口

| 路由 | 说明 |
|---|---|
| `GET /` | 情报面板（HTML） |
| `GET /api/repos` | 最新一批仓库 JSON（含 heat/grade/learnTags/verdict/starDelta），并附 `watchlist` 种子合并数据 |
| `GET /api/watchlist` | 重点监控种子清单 JSON（含每条的分类、人工学习点与实时命中数据 `live`，未命中为 `null`） |
| `GET /api/stats` | 最近一轮巡检元信息（时间、各通道条数、错误、改名事件 `renames`） |
| `GET /api/brief` | 总统简报 JSON（与面板悬浮窗同一份数据：态势、飙升/热度 TOP3、网安/Skill 焦点、改名动态、关键词热度、话题趋势、重点监控动态），并附 `brief.push` 推送状态（`configured: {dm, manualChannel, autoChannels}` 计数与今日各目标结果，不含频道标题/完整 id） |
| `POST /api/brief/push` | 手动推送总统简报到 TG 目标（私聊 + 手动频道 + 自动注册频道）。需 Secret `PUSH_KEY`：未配置返回 403 `status: "push_disabled"`，请求头 `x-push-key` 缺失/错误返回 401 `status: "unauthorized"`（不推送、不写节流）；鉴权通过后按目标分别做 6 小时节流，只推未被节流的目标，响应含 `targets`（本次推送的目标键）与 `skipped`（被节流跳过的目标键），无目标时返回 `status: "not_configured"` |
| `GET /api/tg/commands` | Bot 命令清单 JSON（`setMyCommands` 用，8 条） |
| `POST /tg/webhook` | Telegram Webhook 入口（Bot 只读命令 + 频道自动注册；需 Secret `TG_WEBHOOK_SECRET`，未配置返回 404、错密钥 403） |
| `POST /api/refresh` | 手动触发巡检，30 分钟内重复调用会被节流（返回 `throttled: true`） |
| Cron `scheduled()` | 定时巡检，不走手动节流 |

KV 键：`intel:latest`（最新数据）、`intel:prev`（上轮星标快照，v4 起为 id 键格式）、`intel:meta`（巡检元信息）、`intel:seedids`（种子仓库 id 映射）、`intel:seedcursor`（种子保鲜轮换游标）、`intel:seedlive`（种子保鲜结果）、`intel:topichist`（话题趋势历史快照，最近 56 个）、`intel:briefpush`（简报每日推送状态，v5.3 起为 `{date, targets}` 按目标键记录）、`intel:pushmanual`（手动推送节流，v5.3.1 起为按目标映射 `{"dm"|"ch:<chatId>": ts}`，旧全局格式读取时迁移）、`intel:tgchannels`（自动注册的频道表，v5.3 新增）。

## 数据诚实说明

- 数据源只有 GitHub Search API 的公开搜索结果，排序与收录口径由 GitHub 决定；通道查询是关键词规则，不是 GitHub 官方 Trending。
- **星标增量需要至少两轮巡检**：第一轮所有仓库的增量为空，研判会写「新入情报库」；第二轮起才有 `+N★`。
- 未认证调用限额很低（Search API 约 10 次/分钟，且有每小时配额），一轮 11 次调用没问题，但不要高频手动刷新——代码里已做 30 分钟节流。
- 某通道抓取失败时，该通道在面板跑马灯里会被标为异常，并沿用上一轮该通道的旧数据，不会把整片数据抹掉；全部通道都失败时不覆盖已有数据。
- 研判、评级、学习点全部是规则产出，可能误判（比如描述里蹭关键词的仓库），仅供筛选参考，不构成「值得学」的结论保证。
- KV 是最终一致存储，巡检刚写完的几十秒内面板可能短暂读到旧数据，属正常现象。

## 本地测试

```bash
node --check worker.js
```

本地 harness（Mock KV + Mock GitHub API）不在本目录：v2 实测 27/27 通过；v3 harness 断言 11 通道恰好 11 次请求、skills 通道修复后有数据入库、src-hunt 仓库的 XSS/PoC 标签、sec-learning 的学习路线标签、安全标签合并进 `/api/repos`、面板新分区/标签云/可点标签 chip（data-tag）/分页控件（data-page、上一页/下一页）与每页 24 条常量。v4 harness（`/tmp/intel-harness4.mjs`）27/27 通过：记录存 id、快照 id 键格式、同 id 改名后增量精确（+150）且 `renamedFrom`/`meta.renames` 正确、旧扁平快照迁移轮仍算出增量（+40）、种子 id 映射落盘且改名后按 id 命中并显示新名、面板折叠开关（data-collapse ≥10）/展开全部按钮/双分页控件/简报悬浮窗标记与内嵌 JSON 可解析、`/api/brief` 含 renames 与 topTopics、拖拽处理代码（brief-head 的 pointerdown）存在。v5 harness（`/tmp/intel-harness5.mjs`）53/53 通过：种子保鲜轮换（两轮游标 0→4→7、每轮恰好 3 个未命中种子、改名种子存当前名并回写 seedids、404 标记 gone、buildWatchlist 用 seedlive 星标）、话题趋势（topichist 追加与 56 上限裁剪、mcp 的 dStars24h/dCount24h/streak 精确）、TG 双目标推送（双目标各 1 条且 chat_id 正确、只配频道只发频道、按目标每日门禁：频道失败次轮只重试频道、08:00 前不推、次日恢复、手动推送全目标 + 6h 节流 + 与每日状态共用、无配置静默与 not_configured）、通道 403 重试成功且记入 retriedChannels、全局吸顶栈结构（stickyhead 顺序包含 topbar/标签行/筛选条、筛选条不在 sec-all 内、全部控件 id 恰好出现 1 次）。v5.2 harness（`/tmp/intel-harness6.mjs`）37/37 通过：Webhook 密钥校验（未配置 404 / 错密钥 403）、8 条只读命令回复内容与目标 chat、非命令更新忽略、命令清单与空 KV 兜底。v5.3 harness（`/tmp/intel-harness7.mjs`）25/25 通过：频道自动注册（升管理员登记 active、他人/群聊事件忽略、错密钥不登记）、每日推送直达 DM + 自动频道且新格式落盘、channel_post 补登记、降级/移出标 removed 并停推、双频道齐发、手动频道与自动频道同 id 去重、旧格式 briefpush 迁移（已成功目标不重发、legacy 键不门禁自动频道）、`/api/brief` push 状态只给计数不带标题、`/stats` 频道标题仅机主可见；v5.3 落地后 v5 harness 中 5 处断言（B04/B06/C02/C04/D02）按新 `targets`/`manualChannel` 格式适配后仍 53/53，v5.2 harness 无需改动 37/37。v5.3.1 harness（`/tmp/intel-harness8.mjs`）33/33 通过：手动推送鉴权（未配 PUSH_KEY 403 push_disabled、无头/错钥 401 且零发送零打戳、对钥放行）、按目标节流（全目标节流时 throttled 且 retryAfterMs 指向最早解禁、新注册频道立即补推且只推它、响应 targets/skipped 正确、6h 后全目标恢复）、旧格式迁移（裸数字与 {ts} 对象都只算 dm 的戳、写回后为新映射）、每日自动推送不受 pushmanual 影响、`/api/refresh` 保持公开；v5.3.1 落地后 v5/v5.3 harness 仅给手动推送场景补上 `PUSH_KEY` 环境与 `x-push-key` 请求头（断言未改）后仍 53/53、25/25，v5.2 harness 无需改动 37/37。
