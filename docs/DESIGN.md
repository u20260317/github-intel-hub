# 设计文档 · GitHub 情报中心

## 架构总览

```
                ┌──────────── Cron 17 */6 * * * ────────────┐
                │                                            ▼
GitHub Search ──┼──► 巡检 sweep ──► 研判 analyze ──► KV (INTEL_KV)
   API (11 通道) │        │                              │
                │        └─► 种子保鲜 (Repos API 轮换)     │
                │                                            │
浏览器 ─────────┼──► GET / 面板 (SSR) ◄────────────────────┤
                │    GET /api/brief 总统简报 ◄──────────────┤
Telegram ───────┼──► POST /tg/webhook ──► 命令 (只读)       │
   ▲            │        └─► 频道登记 (my_chat_member/帖子)  │
   └── 简报推送 ◄┴── 每日 08:00 后首轮巡检 / 手动 (带钥匙) ──┘
```

单文件 `worker.js`，零依赖。所有状态都在一个 KV 命名空间里，没有数据库、没有队列。

## 模块划分（代码内中文横幅标注）

配置常量（通道/种子/映射表）→ 工具 → GitHub 客户端 → 巡检 → 研判 → 种子保鲜 → 简报组装 → 话题趋势 → Telegram 推送 → Bot 命令 → 频道登记 → HTTP 路由 → 面板渲染。

## 情报通道与查询设计

11 个通道各是一条 GitHub Search 查询（关键词/topic + stars/pushed 门槛），定义在 `CHANNELS`。

**关键教训（实测）**：Search 的 OR 括号组里只能放无引号 token。把带引号短语（如 `"claude skills"`）放进 `(a OR "b c")` 会让整条查询 `total_count=0`。引号短语只能单独放在括号外。中文关键词可直接搜（如 `漏洞挖掘 stars:>50`）。

失败策略：单通道失败不拖垮整轮；失败通道在本轮内重试一次；整轮结果（含每个通道的条数与错误）记入 `intel:meta`，面板与 `/api/stats` 可见。

## 研判（规则引擎，非 AI）

热度分 0–100 = 星标规模 40 + 本轮增量 30 + 推送新鲜度 20 + fork 活跃度 10。评级 S ≥70 / A ≥45 / B 其余。

标签两层合并去重、每仓上限 6：`LEARNING_MAP`（学习点，约 40 条关键词映射）+ `SECURITY_TAG_MAP`（安全细粒度约 23 条）。短词（RCE、PoC）用单词边界匹配防误标（source≠RCE、epoch≠PoC）；「learning」仅在安全语境标注，防止 machine learning 误标。研判文案是模板句，面板与简报都如实标注「规则研判」。

## 快照与改名检测（ID 锚点）

监控锚点的设计原则：**发现靠关键词/topic，追踪靠仓库数字 ID**（仓库名可改，ID 不变）。

- `intel:prev` 存 `{ts, byId: {id: {s: 星数, n: 仓库名}}}`；每轮用 ID 对齐算 `starDelta`。
- 同一 ID 名字变了 → 记为改名事件，进 meta 与简报「改名动态」，卡片显示 `renamedFrom`。
- 种子同理：`intel:seedids` 记住每个种子解析到的 ID，改名后仍能对上。

局限（已知取舍）：仓库掉出全部通道一轮以上，快照基线会断，回来时按新仓处理。

## 种子保鲜轮换

`SEEDS` 是人工精选清单（23 条）。巡检命中同名仓的种子直接用实时数据；未命中的种子进入保鲜队列：每轮按游标 `intel:seedcursor` 取最多 3 个，用 Repos API 按现名查询，结果存 `intel:seedlive`（含现名、星数、是否改名/疑似删库）。这样 23 个种子约 8 轮（2 天）全量刷新一遍，且改名/删库能被发现而不是静默失效。

## 话题趋势

每轮把全部仓库的 topics 聚合成 `{topic: {repos, stars}}` 快照追加到 `intel:topichist`，保留最近 56 份（约 14 天）。简报与总览的「话题趋势」取 24 小时前的快照对比，给出星数增量与「连续 N 轮升温」。数据需积累约 4 轮（24 小时）才有完整口径。

## KV 键目录

| 键 | 内容 |
|---|---|
| `intel:repos` | 最新一轮全部仓库记录（分析后） |
| `intel:meta` | 最新一轮巡检元信息（通道条数/错误/新增/改名/保鲜数） |
| `intel:prev` | 星数快照（byId 格式） |
| `intel:seedids` | 种子 → 仓库 ID 对照 |
| `intel:seedlive` | 种子保鲜结果 |
| `intel:seedcursor` | 保鲜轮换游标 |
| `intel:topichist` | 话题趋势快照（≤56 份） |
| `intel:tgchannels` | 自动登记的频道 `{id: {title, status, ts}}` |
| `intel:briefpush` | 每日简报推送状态（按日期 + 按目标） |
| `intel:pushmanual` | 手动推送节流（按目标的时间戳 map） |
| `intel:refresh` | 面板手动巡检节流时间戳 |

所有结构在读取时做旧格式迁移，升级不需要数据手术。

## 推送状态机

目标集合 = 私聊（`TG_CHAT_ID`）+ 手动频道（`TG_CHANNEL_ID`，可选）+ `intel:tgchannels` 里全部 active 频道，按 chat id 去重。

- **每日简报**：巡检结束后判断——北京时间已过 08:00 且今天该目标还没成功推送过 → 推。按目标记状态，失败的目标下一轮自动补推，成功的不重复。
- **手动推送**：`POST /api/brief/push`，需 `PUSH_KEY` 鉴权（v5.3.1）；节流按目标单独计 6 小时（`intel:pushmanual`），新登记频道无记录、可立即补推。
- **频道登记**：`my_chat_member` 事件里 Bot 被设为管理员/创建者 → 登记 active；被踢出/降为普通成员 → 摘除。`channel_post` 事件做兜底登记（覆盖 webhook 上线前就已是管理员的老频道）。
- **隐私**：公开接口只暴露频道数量；频道名/ID 只在所有者私聊 Bot 发 `/stats` 时可见。

## 安全面

- Webhook 校验 Telegram 的 secret header，不匹配 403；未配置密钥时 webhook 返回 404。
- 唯一有副作用的公开面是手动推送接口，已用 PUSH_KEY 关闭（未配密钥 = 接口禁用）。
- 面板与只读 API 公开（内容本就是公开情报）；手动巡检有 30 分钟节流防刷额度。
- Bot 命令全部只读，不接受任何写操作指令。

## 省流设计

Cron 6 小时一轮；每轮 11 次 Search + ≤3 次 Repos + 少量 KV 读写，远低于 Workers 免费版 50 子请求上限与 KV 免费额度；面板服务端渲染、零前端框架、零外部资源请求。

只读 GET 路由（面板、`/api/repos`、`/api/stats`、`/api/brief`、`/api/tg/commands`）另有边缘缓存兜底（v5.4）：Cache API 读穿、TTL 30 分钟，命中时零 Worker 渲染、零 KV 读取（响应头 `x-intel-cache` 标 HIT/MISS）；数据只在巡检时变化，巡检结束即主动删键失效。空数据状态与 POST 路由永不入缓存，Cache API 不可用时自动降级直读 KV。
