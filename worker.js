// ============================================================
// GitHub 情报中心 · GitHub Intel Center（原名情报局，Worker 名/网址不变；v4：分区折叠/展开全部 + 双分页 + 可拖动总统简报悬浮窗；v5：种子保鲜轮换 + 话题趋势历史 + 总统简报 Telegram 每日推送 + 通道失败重试；v5.2：Telegram Bot 命令系统；v5.3：频道自动注册——Bot 被设为频道管理员后经 my_chat_member/channel_post 自动登记为推送目标；v5.3.1：手动推送接口加 PUSH_KEY 鉴权 + 节流改为按目标分别计算；v5.4：只读 GET 路由加边缘缓存——Cache API 读穿缓存 30 分钟、巡检写新数据后主动失效，重复访问不再重跑渲染/重读 KV；v5.5：面板与 /api/brief 八语种 i18n（zh/en/ru/uk/ja/ko/es/ar）——仅 UI 层本地化（语言解析?lang= > Cookie > Accept-Language > zh），标签/研判渲染时翻译，存储数据与 Telegram 推送保持中文，边缘缓存键按语言分开、巡检失效全部语言变体）
// 单文件 Cloudflare Worker：定时巡检 GitHub 热门仓库，做规则研判（热度/学习点/评级），
// 以「黑客情报中心」风格暗色面板呈现。零依赖，数据存 KV（绑定名 INTEL_KV）。
// 研判为规则引擎产出，非 AI 生成，面板与代码均如实标注「规则研判」。
// ============================================================

// ============================================================
// 【核心模块】配置与情报通道 — 通道定义、巡检节流、KV 键与 GitHub API 基本参数
// ============================================================
const CONFIG = {
ua: "GitHub-Intel-Hub/1.0 (+https://github.com)",
apiBase: "https://api.github.com",
refreshThrottleMs: 30 * 60 * 1000, // 手动刷新节流 30 分钟（省流，学 DEAL HUB）
kvLatest: "intel:latest",
kvPrev: "intel:prev",
kvMeta: "intel:meta",
kvSeedIds: "intel:seedids",
kvSeedCursor: "intel:seedcursor",
kvSeedLive: "intel:seedlive",
kvTopicHist: "intel:topichist",
kvBriefPush: "intel:briefpush",
kvPushManual: "intel:pushmanual",
kvTgChannels: "intel:tgchannels",
panelUrl: "https://github-intel-hub.u20261103.workers.dev", // 总统简报推送里的面板链接（换部署地址时改这里）
pushThrottleMs: 6 * 3600 * 1000, // 手动推送 /api/brief/push 的节流：每个推送目标 6 小时最多手动推 1 次（v5.3.1 起按目标分别计算）
cacheTtlSec: 1800, // 【v5.4】只读 GET 路由的边缘缓存 TTL（秒）：数据只在巡检时变化，巡检后会主动失效，TTL 只是兜底
};

// 日期工具：GitHub search 需要 YYYY-MM-DD
function daysAgo(n) {
const d = new Date(Date.now() - n * 86400000);
return d.toISOString().slice(0, 10);
}

// 十一个情报通道：每通道 1 次 Search API 调用，一轮巡检共 11 次请求，远低于免费版 50 子请求上限（省流）
// 查询语法教训：OR 括号组里只能放无引号 token；带引号短语（如 "claude skills"）放进 OR 括号会让 GitHub 返回 total_count=0（实测验证）。
function buildChannels() {
const d7 = daysAgo(7), d30 = daysAgo(30), d90 = daysAgo(90);
return [
{ key: "surge", name: "飙升新星", q: `created:>${d30} stars:>50`, sort: "stars", perPage: 15},
{ key: "trending-week", name: "本周热门", q: `pushed:>${d7} stars:>5000`, sort: "stars", perPage: 15},
{ key: "ai-agent", name: "AI / AGENT", q: `(ai-agent OR llm OR mcp) stars:>200 pushed:>${d30}`, sort: "stars", perPage: 15},
{ key: "workers", name: "边缘 / Bot", q: `(cloudflare-workers OR serverless OR telegram-bot) stars:>100 pushed:>${d30}`, sort: "stars", perPage: 10},
{ key: "media", name: "多媒体生成", q: `(comfyui OR image-generation OR text-to-speech) stars:>100 pushed:>${d30}`, sort: "stars", perPage: 10},
{ key: "devtools", name: "开发工具", q: `(developer-tools OR browser-automation OR playwright) stars:>500 pushed:>${d30}`, sort: "stars", perPage: 10},
{ key: "security", name: "网安 · 红队 · SRC", q: `(cybersecurity OR "red team" OR "bug bounty" OR penetration-testing OR vulnerability) stars:>200 pushed:>${d90}`, sort: "stars", perPage: 10},
{ key: "skills", name: "Skill 生态", q: `(claude-skills OR agent-skills OR claude-skill) stars:>50 pushed:>${d90}`, sort: "stars", perPage: 10},
{ key: "creator", name: "自媒体全套", q: `(short-video OR video-editing OR ffmpeg OR "content creation" OR subtitles OR livestream) stars:>200 pushed:>${d30}`, sort: "stars", perPage: 10},
{ key: "src-hunt", name: "SRC · 挖洞", q: `(bug-bounty OR 漏洞挖掘 OR vulnerability-scanner OR vulnerability-hunting) stars:>30 pushed:>${d90}`, sort: "stars", perPage: 10},
{ key: "sec-learning", name: "网安学习资料", q: `(pentest OR ctf OR web-security OR cybersecurity-learning OR security-roadmap) stars:>200 pushed:>${d90}`, sort: "stars", perPage: 10},
];
}

// ============================================================
// 【核心模块】重点监控种子 — 人工精选清单（用户指定、已预筛），面板单独成区展示；巡检命中同名仓库时合并其实时星标/热度/增量
// ============================================================
const SEED_CATS = {
skills: "Skill 生态",
writing: "写作 Skill",
science: "科研 Skill",
creator: "自媒体全套",
security: "网安 · 红队 · SRC",
};
const SEEDS = [
// — Skill 生态 —
{ repo: "Jeffallan/claude-skills", cat: "skills", note: "生产级 Claude Skill 合集：看它的分类方式与 SKILL.md 写法规范"},
{ repo: "obra/superpowers", cat: "skills", note: "用 Skill 组合出完整开发工作流（计划/调试/TDD）的框架设计"},
{ repo: "foryourhealth111-pixel/Vibe-Skills", cat: "skills", note: "Vibe Coding 向 Skill 包的组织与分发方式"},
{ repo: "browser-act/skills", cat: "skills", note: "浏览器自动化能力如何封装成可复用的 Skill 指令集"},
{ repo: "JuneYaooo/teacher-to-skills", cat: "skills", note: "把名师教学法转成 Skill 的知识蒸馏路径"},
{ repo: "microsoft/SkillOpt", cat: "skills", note: "微软 SkillOpt：把 Skill 当作可自动优化的参数来迭代"},
{ repo: "88lin/computer-repair-skill", cat: "skills", note: "垂直故障排查 Skill 的决策树式写法"},
{ repo: "Donchitos/Claude-Code-Game-Studios", cat: "skills", note: "多 Agent 扮演游戏工作室的角色分工与协作协议"},
{ repo: "K-Dense-AI/scientific-agent-skills", cat: "science", note: "科研场景 Skill 库：数据分析与实验流程的封装粒度"},
{ repo: "larashero3-dotcom/writing-dna-skill", cat: "writing", note: "提取写作风格 DNA 并固化为 Skill 的方法"},
{ repo: "virgiliojr94/book-to-skill", cat: "writing", note: "整本书转 Skill 的长文本切分与索引方法"},
{ repo: "modoojunko/awesome-novel-agent", cat: "writing", note: "小说创作 Agent 的章节规划与长篇一致性管理"},
{ url: "https://hub.cocoloop.cn/", name: "Cocoloop Skill 枢纽", cat: "skills", note: "国内 Skill 枢纽站：看 Skill 的分发、检索与排行怎么做"},
// — 自媒体全套 —
{ repo: "browser-use/video-use", cat: "creator", note: "用 Agent 操作浏览器完成视频剪辑的工具链编排"},
{ repo: "kajisho5/ffmpeg-skill", cat: "creator", note: "把 ffmpeg 复杂参数封装成自然语言 Skill 的范式"},
{ repo: "LunarXuan/image-prompt-reverse", cat: "creator", note: "从图片反推提示词的逆向工程流程"},
{ repo: "yihui-dev/awesome-opus5-5-videos", cat: "creator", note: "Opus 视频生成案例库：看提示词与镜头语言"},
{ repo: "lemomo-ai/lemo-opuscar", cat: "creator", note: "AI 视频成品工作流拆解（汽车题材垂类打法）"},
{ repo: "Vincentwei1021/mg-styles-15", cat: "creator", note: "15 种 MG 动画风格的视觉规范沉淀"},
{ repo: "athemeroy/awesome-claude-5-5-videos", cat: "creator", note: "Claude 做视频的精选案例与工作流索引"},
{ repo: "joeseesun/opus-video-prompts", cat: "creator", note: "视频生成提示词的结构化模板"},
// — 网安 · 红队 · SRC —
{ repo: "elementalsouls/Claude-BugHunter", cat: "security", note: "用 Claude 做漏洞挖掘的 Bug Bounty 工作流"},
{ repo: "CallMeGuLab/dsh-purge-safe", cat: "security", note: "数据安全清理的安全处置流程与边界"},
];

// 把种子与巡检数据合并，数据新鲜度三级兜底：
// 1) 本轮巡检实时命中（优先按仓库 id 匹配，种子 id 映射来自 KV intel:seedids；兜底按 full_name 匹配；命中改名仓库时展示当前名与当前链接）
// 2) 种子保鲜数据（KV intel:seedlive，巡检轮换单独抓取的结果，带 refreshed 与保鲜时间；保鲜发现改名时展示当前名并记 renamedFrom；404 记 gone 疑似删库）
// 3) 种子静态信息（只有名字与人工学习点）
function buildWatchlist(repos, seedIds, seedLive) {
const byName = new Map((repos || []).map((r) => [r.full_name.toLowerCase(), r]));
const byId = new Map((repos || []).filter((r) => r.id != null).map((r) => [String(r.id), r]));
return SEEDS.map((s) => {
let live;
if (s.repo && seedIds && seedIds[s.repo] != null) live = byId.get(String(seedIds[s.repo]));
if (!live && s.repo) live = byName.get(s.repo.toLowerCase());
const base = { cat: s.cat, catName: SEED_CATS[s.cat] || s.cat, note: s.note};
if (live) {
return {...base,
name: live.full_name,
url: live.html_url,
live: { stars: live.stars, forks: live.forks, heat: live.heat, grade: live.grade, starDelta: live.starDelta, channels: live.channels},
refreshed: null, renamedFrom: null, gone: false, goneTs: null,
};
}
const sl = s.repo && seedLive? seedLive[s.repo]: null;
if (sl && !sl.gone) {
const curName = sl.name || s.repo;
return {...base,
name: curName,
url: `https://github.com/${curName}`,
live: null,
refreshed: { stars: sl.stars || 0, forks: sl.forks || 0, pushedAt: sl.pushedAt || "", ts: sl.ts || 0},
renamedFrom: sl.name && sl.name !== s.repo? s.repo: null,
gone: false, goneTs: null,
};
}
if (sl && sl.gone) {
return {...base,
name: s.repo || s.name,
url: s.repo? `https://github.com/${s.repo}`: s.url,
live: null, refreshed: null, renamedFrom: null, gone: true, goneTs: sl.ts || 0,
};
}
return {...base,
name: s.repo || s.name,
url: s.repo? `https://github.com/${s.repo}`: s.url,
live: null, refreshed: null, renamedFrom: null, gone: false, goneTs: null,
};
});
}

// ============================================================
// 【核心模块】GitHub 抓取 — 带 UA/Accept 的 Search API 调用，可选 GITHUB_TOKEN 提高限额
// ============================================================
async function fetchChannel(env, ch) {
const url = `${CONFIG.apiBase}/search/repositories?q=${encodeURIComponent(ch.q)}&sort=${ch.sort}&order=desc&per_page=${ch.perPage}`;
const headers = {
"user-agent": CONFIG.ua,
"accept": "application/vnd.github+json",
"x-github-api-version": "2022-11-28",
};
if (env.GITHUB_TOKEN) headers["authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
const r = await fetch(url, { headers});
if (!r.ok) {
const body = await r.text().catch(() => "");
throw new Error(`GitHub ${r.status}: ${body.slice(0, 160)}`);
}
const j = await r.json();
return Array.isArray(j.items)? j.items: [];
}

// 种子保鲜抓取：走核心 Repos API 单独查一个仓库（改名仓库会重定向到新地址，响应 JSON 里是当前 full_name/id）；404 = 疑似删库
async function fetchSeedRepo(env, fullName) {
const url = `${CONFIG.apiBase}/repos/${fullName}`;
const headers = {
"user-agent": CONFIG.ua,
"accept": "application/vnd.github+json",
"x-github-api-version": "2022-11-28",
};
if (env.GITHUB_TOKEN) headers["authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
const r = await fetch(url, { headers});
if (r.status === 404) return { gone: true};
if (!r.ok) {
const body = await r.text().catch(() => "");
throw new Error(`GitHub ${r.status}: ${body.slice(0, 160)}`);
}
const j = await r.json();
return {
gone: false,
id: typeof j.id === "number"? j.id: null,
name: j.full_name || fullName,
stars: j.stargazers_count || 0,
forks: j.forks_count || 0,
pushedAt: j.pushed_at || "",
};
}

// GitHub 原始 item -> 情报库统一记录（id 为 GitHub 数字仓库 ID：仓库改名/转移时不变，是监控锚点）
function normalizeRepo(it, channelKey) {
return {
id: typeof it.id === "number"? it.id: null,
full_name: it.full_name,
html_url: it.html_url,
description: it.description || "",
stars: it.stargazers_count || 0,
forks: it.forks_count || 0,
language: it.language || "",
topics: Array.isArray(it.topics)? it.topics: [],
created_at: it.created_at || "",
updated_at: it.updated_at || "",
pushed_at: it.pushed_at || "",
license: (it.license && it.license.spdx_id) || "",
channels: [channelKey],
starDelta: null,
};
}

// ============================================================
// 【核心模块】合并去重与快照 — 多通道合并、失败通道沿用旧数据、与上轮快照比出 starDelta
// ============================================================
async function loadJSON(env, key, fallback) {
try {
const v = await env.INTEL_KV.get(key, "json");
return v == null? fallback: v;
} catch { return fallback;}
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSweep(env) {
const channels = buildChannels();
const oldLatest = await loadJSON(env, CONFIG.kvLatest, null);
const prev = await loadJSON(env, CONFIG.kvPrev, {}); // 新格式 {ts, byId:{id:{s,n}}}；旧格式 {full_name: stars, ts}
const prevTs = typeof prev.ts === "number"? prev.ts: 0;
// 快照查找表：以仓库 id 为锚（改名不丢增量）；旧格式则先建 name->stars 迁移查找，迁移轮照常算 delta
const prevById = {};
const prevByName = {};
if (prev && typeof prev === "object") {
if (prev.byId && typeof prev.byId === "object") {
for (const [id, v] of Object.entries(prev.byId)) {
if (v && typeof v.s === "number") { prevById[id] = v; if (v.n) prevByName[v.n] = v.s; }
}
} else {
for (const [k, v] of Object.entries(prev)) if (k !== "ts" && typeof v === "number") prevByName[k] = v;
}
}

const merged = new Map(); // full_name -> record
const errors = {};
const counts = {};
const retriedChannels = [];
let okChannels = 0;

for (const ch of channels) {
// 通道抓取失败（如未认证限额 403）时，间隔 2 秒重试一次；重试成功照常入库，重试过的通道记入 meta.retriedChannels
let items = null;
let lastErr = null;
try {
items = await fetchChannel(env, ch);
} catch (e1) {
retriedChannels.push(ch.key);
await sleepMs(2000);
try { items = await fetchChannel(env, ch); } catch (e2) { lastErr = e2; }
}
if (items) {
okChannels++;
counts[ch.key] = items.length;
for (const it of items) {
const rec = normalizeRepo(it, ch.key);
const ex = merged.get(rec.full_name);
if (ex) {
if (!ex.channels.includes(ch.key)) ex.channels.push(ch.key);
ex.stars = Math.max(ex.stars, rec.stars);
} else merged.set(rec.full_name, rec);
}
} else {
errors[ch.key] = String((lastErr && lastErr.message) || lastErr || "unknown error").slice(0, 200);
counts[ch.key] = 0;
// 该通道失败：沿用上一轮带此通道标记的旧记录，避免整片数据被抹掉
if (oldLatest && Array.isArray(oldLatest.repos)) {
for (const old of oldLatest.repos) {
if (old.channels && old.channels.includes(ch.key) &&!merged.has(old.full_name)) {
merged.set(old.full_name, {...old});
}
}
}
}
}

// 全通道失败且没有任何数据：不覆盖 latest，只记 meta 后退出
if (okChannels === 0 && merged.size === 0) {
const meta = { ts: Date.now(), ok: false, counts, errors, total: 0, newCount: 0, note: "all channels failed, latest kept"};
await env.INTEL_KV.put(CONFIG.kvMeta, JSON.stringify(meta));
return meta;
}

// 计算 starDelta 并做研判：优先按仓库 id 对齐上轮快照；id 命中但名字不同 = 改名（保留增量并记录改名事件）
let newCount = 0;
const renames = [];
const repos = [];
for (const rec of merged.values()) {
let prevStars = null, renamedFrom = null;
if (rec.id != null && prevById[String(rec.id)]) {
prevStars = prevById[String(rec.id)].s;
const oldName = prevById[String(rec.id)].n;
if (oldName && oldName !== rec.full_name) renamedFrom = oldName;
} else if (typeof prevByName[rec.full_name] === "number") {
prevStars = prevByName[rec.full_name]; // 旧格式迁移轮 / 无 id 记录按名兜底
}
rec.starDelta = prevStars == null? null: rec.stars - prevStars;
if (renamedFrom) {
rec.renamedFrom = renamedFrom;
renames.push({ from: renamedFrom, to: rec.full_name, stars: rec.stars});
}
if (prevStars == null) newCount++; // 不在上轮快照里 = 本轮新入情报库（首轮即全部）
Object.assign(rec, analyze(rec));
repos.push(rec);
}
repos.sort((a, b) => b.heat - a.heat);

const ts = Date.now();
const latest = { ts, repos};
// 新快照：按仓库 id 键 {ts, byId:{ "<id>": {s: stars, n: full_name} }}，改名/转移后仍可对齐
const newPrev = { ts, byId: {}};
for (const r of repos) if (r.id != null) newPrev.byId[String(r.id)] = { s: r.stars, n: r.full_name};

// 种子 id 映射：本轮按名或既有 id 命中种子时，把其仓库 id 记入 intel:seedids，供后续改名后仍按 id 命中
const seedIds = (await loadJSON(env, CONFIG.kvSeedIds, {})) || {};
const byNameNow = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
const byIdNow = new Map(repos.filter((r) => r.id != null).map((r) => [String(r.id), r]));
for (const s of SEEDS) {
if (!s.repo) continue;
const hit = byNameNow.get(s.repo.toLowerCase()) || (seedIds[s.repo] != null? byIdNow.get(String(seedIds[s.repo])): undefined);
if (hit && hit.id != null) seedIds[s.repo] = hit.id;
}
await env.INTEL_KV.put(CONFIG.kvSeedIds, JSON.stringify(seedIds));

// 【v5】种子保鲜轮换：未被本轮巡检命中的种子，用游标（intel:seedcursor）轮换、每轮最多单独抓 3 个（核心 Repos API），
// 结果存 intel:seedlive 供面板/buildWatchlist 兜底展示；抓到改名仓库时顺带把当前 id 回写 intel:seedids
const seedLive = (await loadJSON(env, CONFIG.kvSeedLive, {})) || {};
const repoSeeds = SEEDS.filter((s) => s.repo);
let seedCursor = await loadJSON(env, CONFIG.kvSeedCursor, 0);
if (!Number.isInteger(seedCursor) || seedCursor < 0 || seedCursor >= Math.max(1, repoSeeds.length)) seedCursor = 0;
let seedRefreshed = 0;
if (repoSeeds.length) {
const isMatched = (s) => (seedIds[s.repo] != null && byIdNow.has(String(seedIds[s.repo]))) || byNameNow.has(s.repo.toLowerCase());
let idx = seedCursor;
let lastAttempted = -1;
for (let scanned = 0; scanned < repoSeeds.length && seedRefreshed < 3; scanned++) {
const s = repoSeeds[idx];
if (!isMatched(s)) {
try {
const res = await fetchSeedRepo(env, s.repo);
if (res.gone) {
seedLive[s.repo] = { gone: true, ts: Date.now()};
} else {
seedLive[s.repo] = { id: res.id, name: res.name, stars: res.stars, forks: res.forks, pushedAt: res.pushedAt, ts: Date.now()};
if (res.id != null) seedIds[s.repo] = res.id;
}
} catch (e) {
// 非 404 错误（限流/网络）：不标记删库，保留旧保鲜数据，下一轮轮到时再试
}
seedRefreshed++;
lastAttempted = idx;
}
idx = (idx + 1) % repoSeeds.length;
}
if (lastAttempted >= 0) seedCursor = (lastAttempted + 1) % repoSeeds.length;
}
await env.INTEL_KV.put(CONFIG.kvSeedCursor, JSON.stringify(seedCursor));
await env.INTEL_KV.put(CONFIG.kvSeedLive, JSON.stringify(seedLive));
await env.INTEL_KV.put(CONFIG.kvSeedIds, JSON.stringify(seedIds));

// 【v5】话题趋势历史：本轮 topics 聚合（只留累计星标前 40）追加进 intel:topichist，只保留最近 56 个快照（6 小时一轮 ≈ 14 天）
const topicHist = (await loadJSON(env, CONFIG.kvTopicHist, [])) || [];
topicHist.push({ ts, topics: aggregateTopics(repos)});
while (topicHist.length > 56) topicHist.shift();
await env.INTEL_KV.put(CONFIG.kvTopicHist, JSON.stringify(topicHist));

const meta = { ts, ok: true, counts, errors, total: repos.length, newCount, channelsOk: okChannels, channelsTotal: channels.length, renames, retriedChannels, seedRefreshed};
await env.INTEL_KV.put(CONFIG.kvLatest, JSON.stringify(latest));
await env.INTEL_KV.put(CONFIG.kvPrev, JSON.stringify(newPrev));
await env.INTEL_KV.put(CONFIG.kvMeta, JSON.stringify(meta));
return meta;
}

// ============================================================
// 【核心模块】规则研判引擎 — 热度分、学习点标签、评级与一句话研判（规则产出，非 AI）
// ============================================================
const LEARNING_MAP = [
["mcp", "MCP 协议接入"],
["agent", "Agent 架构"],
["pentest", "红队评估方法"],
["penetration", "红队评估方法"],
["red-team", "红队评估方法"],
["red team", "红队评估方法"],
["vulnerability", "漏洞管理"],
["bug-bounty", "SRC 众测思路"],
["bug bounty", "SRC 众测思路"],
["osint", "开源情报"],
["skill", "Skill 封装范式"],
["subtitle", "字幕工程"],
["short-video", "短视频工作流"],
["rag", "RAG 检索"],
["cloudflare", "边缘部署"],
["workers", "边缘部署"],
["serverless", "边缘部署"],
["comfyui", "工作流节点"],
["ffmpeg", "音视频管线"],
["playwright", "浏览器自动化"],
["browser", "浏览器自动化"],
["sqlite", "本地存储"],
["llm", "大模型接入"],
["telegram", "Bot 交互"],
["embedding", "向量检索"],
["vector", "向量检索"],
["text-to-speech", "语音合成"],
["tts", "语音合成"],
["stable-diffusion", "图像生成"],
["diffusion", "图像生成"],
["image-generation", "图像生成"],
["prompt", "提示工程"],
["workflow", "工作流编排"],
["docker", "容器化部署"],
["rust", "高性能系统"],
["cli", "命令行工具"],
["wasm", "端侧推理"],
["webgpu", "端侧推理"],
];

// 安全细粒度标签：对仓库名+描述+topics 做关键词匹配（学习/研究向标签，非利用指南）
// word=true 的短词（rce/poc）用单词边界匹配，避免 "source" 误命中 RCE、"epoch" 误命中 PoC
const SECURITY_TAG_MAP = [
["sql-injection", "SQL 注入", false],
["sqli", "SQL 注入", false],
["xss", "XSS", false],
["ssrf", "SSRF", false],
["rce", "RCE", true],
["ctf", "CTF 竞赛", false],
["osint", "开源情报 OSINT", false],
["malware", "恶意代码分析", false],
["forensics", "数字取证", false],
["blue-team", "蓝队防御", false],
["code-audit", "代码审计", false],
["audit", "代码审计", false],
["intranet", "内网渗透", false],
["privilege-escalation", "权限提升", false],
["scanner", "漏洞扫描", false],
["poc", "PoC 研究", true],
["writeup", "漏洞复盘", false],
["roadmap", "学习路线", false],
["learning", "学习路线", false],
["phishing", "钓鱼防御演练", false],
["reverse", "逆向工程", false],
["fuzz", "模糊测试", false],
["devsecops", "DevSecOps", false],
];

function analyze(rec) {
const hay = [rec.full_name, rec.description, rec.language,...(rec.topics || [])].join(" ").toLowerCase();
const tags = [];
for (const [kw, point] of LEARNING_MAP) {
if (hay.includes(kw) &&!tags.includes(point)) tags.push(point);
if (tags.length >= 4) break;
}
// 安全标签合并进 learnTags：去重，总数上限 6
const secHay = [rec.full_name, rec.description,...(rec.topics || [])].join(" ").toLowerCase();
const secChannel = (rec.channels || []).some((c) => ["security", "src-hunt", "sec-learning"].includes(c));
for (const [kw, point, word] of SECURITY_TAG_MAP) {
if (tags.length >= 6) break;
if (tags.includes(point)) continue;
// "learning" 单独出现多半是 machine learning：仅当仓库在安全通道或文本带安全语境时才标「学习路线」
if (kw === "learning" &&!secChannel &&!secHay.includes("security") &&!secHay.includes("pentest") &&!secHay.includes("hacking")) continue;
const hit = word? new RegExp(`\\b${kw}\\b`).test(secHay): secHay.includes(kw);
if (hit) tags.push(point);
}
if (!tags.length && rec.language) tags.push(rec.language + " 工程实践");

// 热度分 0-100：星标规模(40) + 本轮增量(30) + 推送新鲜度(20) + fork 活跃度(10)
let heat = Math.min(40, (Math.log10(rec.stars + 1) / 5) * 40);
if (typeof rec.starDelta === "number") {
heat += rec.starDelta >= 0? Math.min(30, rec.starDelta * 0.1): Math.max(-10, rec.starDelta * 0.02);
}
const pushAgeDays = rec.pushed_at? (Date.now() - Date.parse(rec.pushed_at)) / 86400000: 999;
heat += pushAgeDays <= 1? 20: pushAgeDays <= 7? 16: pushAgeDays <= 30? 10: pushAgeDays <= 90? 5: 0;
heat += Math.min(10, (rec.forks / Math.max(1, rec.stars)) * 50);
heat = Math.max(0, Math.min(100, Math.round(heat)));

const grade = heat >= 70? "S": heat >= 45? "A": "B";
const point = tags[0] || "工程实现";
let head;
if (typeof rec.starDelta === "number" && rec.starDelta > 0) head = `近一轮 +${rec.starDelta}★，`;
else if (typeof rec.starDelta === "number" && rec.starDelta < 0) head = `本轮回落 ${rec.starDelta}★，`;
else if (typeof rec.starDelta === "number") head = "本轮星标持平，";
else head = "新入情报库，";
const verdict = `${head}${rec.language? rec.language + " ": ""}${point}项目，值得看它的${point}。`;
// 【v5.5】同时存结构化研判部件：非中文界面在渲染时按语言用 verdictParts 重新拼句（point 存中文标签原文，渲染时走 tagLabel 翻译）；
// verdict 中文成品句保持不变，供 zh 界面与 Telegram 推送原样使用。旧记录没有 verdictParts，非 zh 渲染时走 renderVerdict 的通用兜底。
const verdictParts = { delta: typeof rec.starDelta === "number"? rec.starDelta: null, language: rec.language || "", point};
return { heat, grade, learnTags: tags, verdict, verdictParts};
}

// ============================================================
// 【核心模块】工具函数 — HTML 转义、CST 时间格式化
// ============================================================
function esc(s) {
return String(s?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}
function fmtCST(ts) {
if (!ts) return "-";
try { return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false});}
catch { return new Date(ts).toISOString();}
}
function fmtDateCST(iso) {
if (!iso) return "-";
try { return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false});}
catch { return iso;}
}

// ============================================================
// 【核心模块】多语言 i18n（v5.5）— 面板与 /api/brief 的 UI 层八语种：zh（默认）/ en / ru / uk / ja / ko / es / ar。
// 只翻译 UI 外壳：存储数据（仓库记录、标签原文、种子笔记）与 Telegram 推送/命令保持中文，标签与一句话研判在渲染时按语言翻译/拼装。
// 语言解析顺序：?lang=（合法值才算）> Cookie intel-lang > Accept-Language 首项（匹配基础语言，含 en-US/zh-CN 等地区变体）> zh。
// ============================================================
const LANGS = ["zh", "en", "ru", "uk", "ja", "ko", "es", "ar"];
const LANG_LOCALES = { zh: "zh-CN", en: "en-US", ru: "ru-RU", uk: "uk-UA", ja: "ja-JP", ko: "ko-KR", es: "es-ES", ar: "ar-EG"};
const LANG_HTML = { zh: "zh-CN", en: "en", ru: "ru", uk: "uk", ja: "ja", ko: "ko", es: "es", ar: "ar"};
const LANG_SHORT = { zh: "中文", en: "EN", ru: "RU", uk: "UK", ja: "JA", ko: "KO", es: "ES", ar: "ع"};

const STRINGS = {
zh: {
doc_title: "GitHub 情报中心 · INTEL CENTER",
h1: "◢ GitHub 情报中心",
tagline: "GITHUB INTEL CENTER // 开源情报巡检 · 规则研判 · 非 AI 生成",
clock_label: "北京时间 CST",
status_label: "巡检状态：",
status_ok: "✅ 正常",
status_warn: "⚠️ 异常",
status_none: "尚无数据",
channels_part: " · 通道 {ok}/{total}",
toggle_collapse: "收起工具栏 ▴",
toggle_expand: "展开工具栏 ▾",
tagcloud_label: "🏷 热门标签（点标签筛选全部情报）",
tagcloud_empty: "暂无标签数据",
trend_label: "📈 话题趋势",
trend_fmt: "+{d}★/24h · 连续 {n} 轮升温",
filter_all: "全部",
grade_all: "评级 全部",
grade_btn_fmt: "{g} 级",
grade_card_fmt: "{g}级",
search_ph: "🔍 搜仓库名 / 描述 / 语言",
pill_label: "标签：",
pill_clear: "✕ 清除标签",
expand_all: "全部展开",
collapse_all: "全部收起",
ticker_full: "上次巡检 {ts} · 监控仓库 {n} 个 · 本轮新增 {new} · 通道正常 {ok}/{total}",
ticker_err: " · 异常通道：{list}",
ticker_src: " · 数据源 GitHub Search API（未认证限额较低） · 研判为规则引擎产出",
ticker_none: "尚无巡检数据 · 点击「立即巡检」或 POST /api/refresh 拉取第一批情报",
kpi_repos: "监控仓库数",
kpi_new: "本轮新增",
kpi_heat: "最高热度",
kpi_channels: "情报通道数",
kpi_seeds: "重点监控种子",
kpi_last: "上次巡检 (CST)",
refresh_btn: "↻ 立即巡检（30 分钟节流）",
empty_text: "▣ 情报库为空。先执行一次巡检：点下方按钮，或 <code>POST /api/refresh</code>。未认证 GitHub API 每小时搜索限额有限，请勿频繁刷新（面板刷新有 30 分钟节流）。",
empty_btn: "立即巡检",
overview_title: "◢ 情报总览 INTEL OVERVIEW",
overview_para: "本面板追踪 GitHub 热门仓库：飙升榜按本轮星标增量排序（需至少两轮巡检才有增量），其余按热度分排序。热度分 = 星标规模 + 本轮增量 + 推送新鲜度 + fork 活跃度的规则加权；学习点为关键词规则映射；评级 S ≥70、A ≥45、B 其余。",
sec_surge: "◢ 飙升榜 STAR SURGE",
sec_newstars: "◢ 热门新星 NEW STARS",
sec_ai: "◢ AI / AGENT 专区",
sec_security: "◢ 网安 · 红队 · SRC 情报 SECURITY INTEL",
sec_src: "◢ SRC · 挖洞 SRC HUNTING",
sec_seclearn: "◢ 网安学习资料 SECURITY LEARNING",
sec_skills: "◢ Skill 生态 SKILL ECOSYSTEM",
sec_creator: "◢ 自媒体全套 CREATOR TOOLKIT",
sec_watchlist: "◢ 重点监控 WATCHLIST",
sec_all: "◢ 全部情报 ALL INTEL",
nodata: "暂无数据",
show_more: "展开全部 {n} 条 ▾",
show_less: "收起 ▴",
watchlist_para: "人工精选种子清单（已预筛）：Skill 生态 / 写作 / 科研 / 自媒体 / 网安五类。种子若被本轮巡检命中，卡片会带其实时 ★、热度与本轮增量；未命中的种子由巡检按游标轮换「单独保鲜」（每轮最多 3 个，卡片标注保鲜时间），保鲜时发现改名会显示当前名、404 会标注疑似删库；都还没轮到的标注「点名监控中」。种子学习点为人工研判，与规则研判区分。",
all_foot: "数据源：GitHub Search API（公开接口，未认证时限额约 10 次/分钟、每小时搜索配额有限；配置 GITHUB_TOKEN 可提高）。星标增量需至少两轮巡检对比快照得出，第一轮均为「新入情报库」。本站研判均为规则引擎产出，重点监控种子的学习点为人工撰写，均不构成推荐结论。",
pager_prev: "← 上一页",
pager_next: "下一页 →",
brief_fab: "📋 总统简报",
brief_head: "📋 总统简报 · DAILY BRIEF",
brief_min: "最小化",
brief_close: "关闭",
brief_foot: "生成于 {time} CST · 规则引擎（非 AI 生成）",
js_refreshing: "巡检中…（约需数秒）",
js_throttled: "已节流：距上次巡检不足 30 分钟，稍后再试。",
js_fail: "巡检失败：",
js_pager: "第 {cur} / {pages} 页 · 共 {total} 条（筛选后）",
js_shown: " 当前显示 {n} 个",
no_desc: "（无描述）",
delta_fmt: "{sd}★ 本轮",
heat_line: "热度 {heat} / 100 · 推送 {date}",
verdict_prefix: "研判（规则）：",
tag_title: "按此标签筛选全部情报",
seed_note: "学习点：",
seed_live: "★ {stars} · 热度 {heat} · {grade}",
seed_refreshed: "单独保鲜",
seed_renamed: "原 {name} 已改名",
seed_gone: "⚠️ 疑似删库/改名未追踪（保鲜检查 {ts}）",
seed_static: "未在本轮巡检命中 · 点名监控中",
seed_group_fmt: "▸ {cat}（{n}）",
brief_situation: "【今日态势】",
brief_surge_t: "【飙升 TOP3】",
brief_heat_t: "【热度 TOP3】",
brief_sec_t: "【网安焦点】",
brief_skill_t: "【Skill 焦点】",
brief_wl_t: "【重点监控动态】",
brief_trend_t: "【话题趋势】",
brief_rename_t: "【改名动态】",
brief_nodata_delta: "暂无增量数据（需两轮巡检）",
brief_no_sec: "暂无网安焦点",
brief_no_skill: "暂无 Skill 焦点",
brief_meta: "★ {stars} · 热度 {heat}",
brief_delta: " · {sd}★ 本轮",
brief_hot_tags: "热门标签：",
brief_wl_line: "已命中实时数据 <b>{live}</b> / {total} 个种子",
brief_wl_top: "领跑种子：",
brief_topics_label: "关键词热度：",
brief_topic_item: "{topic}（{count} 仓 · ★{stars}）",
brief_rename_line: "改名动态：{from} → ",
oneliner_empty: "情报库尚无数据，执行一次巡检后生成今日态势。",
oneliner_p1: "今日共监控 {n} 个仓库，本轮新增 {new} 个，巡检通道 {ok}/{total} 正常。",
oneliner_surge: "飙升最快的是 {name}（本轮 +{d}★）。",
oneliner_heat: "热度榜首为 {name}（热度 {heat}）。",
oneliner_sec: "网安焦点为 {name}",
oneliner_sec_tags: "，热门安全标签：{tags}",
oneliner_end: "。",
verdict_up: "近一轮 +{d}★，",
verdict_down: "本轮回落 {d}★，",
verdict_flat: "本轮星标持平，",
verdict_new: "新入情报库，",
verdict_body: "{point}项目，值得看它的{point}。",
verdict_generic: "热度 {heat}，主要看点：{tag}。",
tag_practice_suffix: "工程实践",
kv_err_title: "配置错误",
kv_err_h1: "◢ 配置错误",
kv_err_body: "KV 未绑定：请给本 Worker 绑定 KV namespace，变量名必须为 <b>INTEL_KV</b>，然后重新部署。",
},
en: {
doc_title: "GitHub Intel Center",
h1: "◢ GitHub Intel Center",
tagline: "GITHUB INTEL CENTER // Open-Source Intel Sweeps · Rule-Based Analysis · Not AI-Generated",
clock_label: "Beijing Time CST",
status_label: "Sweep status: ",
status_ok: "✅ OK",
status_warn: "⚠️ Error",
status_none: "No data yet",
channels_part: " · Channels {ok}/{total}",
toggle_collapse: "Collapse toolbar ▴",
toggle_expand: "Expand toolbar ▾",
tagcloud_label: "🏷 Hot tags (click a tag to filter all intel)",
tagcloud_empty: "No tag data yet",
trend_label: "📈 Topic trends",
trend_fmt: "+{d}★/24h · rising {n} rounds in a row",
filter_all: "All",
grade_all: "Grade: All",
grade_btn_fmt: "Tier {g}",
grade_card_fmt: "Tier {g}",
search_ph: "🔍 Search repos / descriptions / languages",
pill_label: "Tag: ",
pill_clear: "✕ Clear tag",
expand_all: "Expand all",
collapse_all: "Collapse all",
ticker_full: "Last sweep {ts} · {n} repos tracked · {new} new this round · Channels OK {ok}/{total}",
ticker_err: " · Failed channels: {list}",
ticker_src: " · Source: GitHub Search API (low unauthenticated limits) · Analysis by rule engine",
ticker_none: "No sweep data yet · Click 'Sweep now' or POST /api/refresh to pull the first intel",
kpi_repos: "Repos Tracked",
kpi_new: "New This Round",
kpi_heat: "Top Heat",
kpi_channels: "Intel Channels",
kpi_seeds: "Watchlist Seeds",
kpi_last: "Last Sweep (CST)",
refresh_btn: "↻ Sweep now (30-min throttle)",
empty_text: "▣ The intel store is empty. Run a sweep first: the button below, or <code>POST /api/refresh</code>. The unauthenticated GitHub API has a limited hourly search quota — do not refresh often (manual panel refresh is throttled to 30 minutes).",
empty_btn: "Sweep now",
overview_title: "◢ INTEL OVERVIEW",
overview_para: "This panel tracks trending GitHub repositories: the surge board is sorted by this round's star growth (needs at least two sweeps), everything else by heat score. Heat = a rule-weighted mix of star scale + this round's growth + push recency + fork activity; learning points are keyword rule mappings; grades: S ≥70, A ≥45, B otherwise.",
sec_surge: "◢ STAR SURGE",
sec_newstars: "◢ NEW STARS",
sec_ai: "◢ AI / AGENT ZONE",
sec_security: "◢ SECURITY INTEL",
sec_src: "◢ SRC HUNTING",
sec_seclearn: "◢ SECURITY LEARNING",
sec_skills: "◢ SKILL ECOSYSTEM",
sec_creator: "◢ CREATOR TOOLKIT",
sec_watchlist: "◢ WATCHLIST",
sec_all: "◢ ALL INTEL",
nodata: "No data",
show_more: "Show all {n} ▾",
show_less: "Collapse ▴",
watchlist_para: "Hand-picked seed list (pre-screened) in five groups: Skills / Writing / Research / Creator / Security. If a seed is hit by this round's sweep, its card shows live ★, heat and this round's growth; unhit seeds are refreshed in rotation by cursor ('individually refreshed', max 3 per round, the card shows the refresh time); a rename found during refresh shows the current name, a 404 is marked as possibly deleted; seeds not yet reached are marked 'named monitoring'. Seed learning points are human-written analysis, distinct from rule-based verdicts.",
all_foot: "Source: GitHub Search API (public; unauthenticated limits are about 10 searches/min with an hourly quota — set GITHUB_TOKEN to raise them). Star growth needs at least two sweeps compared against snapshots; in the first round everything is 'new to the intel store'. All verdicts on this site are produced by a rule engine; watchlist seed learning points are human-written; neither constitutes a recommendation.",
pager_prev: "← Prev",
pager_next: "Next →",
brief_fab: "📋 Daily Brief",
brief_head: "📋 PRESIDENTIAL BRIEFING",
brief_min: "Minimize",
brief_close: "Close",
brief_foot: "Generated at {time} CST · Rule engine (not AI-generated)",
js_refreshing: "Sweeping… (takes a few seconds)",
js_throttled: "Throttled: less than 30 minutes since the last sweep — try again later.",
js_fail: "Sweep failed: ",
js_pager: "Page {cur} / {pages} · {total} items (filtered)",
js_shown: " · showing {n}",
no_desc: "(no description)",
delta_fmt: "{sd}★ this round",
heat_line: "Heat {heat} / 100 · Pushed {date}",
verdict_prefix: "Verdict (rules): ",
tag_title: "Filter all intel by this tag",
seed_note: "Learning point: ",
seed_live: "★ {stars} · Heat {heat} · {grade}",
seed_refreshed: "Individually refreshed",
seed_renamed: "formerly {name}, renamed",
seed_gone: "⚠️ Possibly deleted / untracked rename (refresh check {ts})",
seed_static: "Not hit by this round's sweep · Named monitoring",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "[Today's Situation]",
brief_surge_t: "[Surge TOP 3]",
brief_heat_t: "[Heat TOP 3]",
brief_sec_t: "[Security Focus]",
brief_skill_t: "[Skill Focus]",
brief_wl_t: "[Watchlist Activity]",
brief_trend_t: "[Trending Topics]",
brief_rename_t: "[Renames]",
brief_nodata_delta: "No growth data yet (needs two sweeps)",
brief_no_sec: "No security focus yet",
brief_no_skill: "No Skill focus yet",
brief_meta: "★ {stars} · Heat {heat}",
brief_delta: " · {sd}★ this round",
brief_hot_tags: "Hot tags: ",
brief_wl_line: "Live data for <b>{live}</b> / {total} seeds",
brief_wl_top: "Top seed: ",
brief_topics_label: "Keyword heat: ",
brief_topic_item: "{topic} ({count} repos · ★{stars})",
brief_rename_line: "Renamed: {from} → ",
oneliner_empty: "The intel store is empty; run a sweep to generate today's situation.",
oneliner_p1: "Tracking {n} repos today, {new} new this round, sweep channels {ok}/{total} OK. ",
oneliner_surge: "Fastest riser: {name} (+{d}★ this round). ",
oneliner_heat: "Heat leader: {name} (heat {heat}). ",
oneliner_sec: "Security focus: {name}",
oneliner_sec_tags: "; hot security tags: {tags}",
oneliner_end: ".",
verdict_up: "Up +{d}★ last round, ",
verdict_down: "Down {d}★ this round, ",
verdict_flat: "Stars flat this round, ",
verdict_new: "New to the intel store, ",
verdict_body: "{point} project — worth studying its {point}.",
verdict_generic: "heat {heat}; key angle: {tag}.",
tag_practice_suffix: "engineering practices",
kv_err_title: "Configuration Error",
kv_err_h1: "◢ Configuration Error",
kv_err_body: "KV is not bound: bind a KV namespace to this Worker with the variable name <b>INTEL_KV</b>, then redeploy.",
},
ru: {
doc_title: "GitHub Intel Center",
h1: "◢ Центр разведки GitHub",
tagline: "GITHUB INTEL CENTER // Мониторинг открытого кода · Анализ по правилам · Не сгенерировано ИИ",
clock_label: "Пекинское время CST",
status_label: "Статус обхода: ",
status_ok: "✅ Норма",
status_warn: "⚠️ Сбой",
status_none: "Нет данных",
channels_part: " · Каналы {ok}/{total}",
toggle_collapse: "Свернуть панель ▴",
toggle_expand: "Развернуть панель ▾",
tagcloud_label: "🏷 Популярные теги (клик — фильтр всей разведки)",
tagcloud_empty: "Нет данных тегов",
trend_label: "📈 Тренды тем",
trend_fmt: "+{d}★/24ч · рост {n} раунда подряд",
filter_all: "Все",
grade_all: "Оценка: все",
grade_btn_fmt: "Ранг {g}",
grade_card_fmt: "Ранг {g}",
search_ph: "🔍 Поиск по репозиториям / описаниям / языкам",
pill_label: "Тег: ",
pill_clear: "✕ Сбросить тег",
expand_all: "Развернуть всё",
collapse_all: "Свернуть всё",
ticker_full: "Последний обход {ts} · Отслеживается репозиториев: {n} · Новых в этом раунде: {new} · Каналы в норме {ok}/{total}",
ticker_err: " · Сбойные каналы: {list}",
ticker_src: " · Источник: GitHub Search API (низкие лимиты без аутентификации) · Анализ — движок правил",
ticker_none: "Данных обхода пока нет · Нажмите «Обход сейчас» или POST /api/refresh для первой разведки",
kpi_repos: "Репозиториев под наблюдением",
kpi_new: "Новых в раунде",
kpi_heat: "Макс. нагрев",
kpi_channels: "Каналов разведки",
kpi_seeds: "Семян в watchlist",
kpi_last: "Последний обход (CST)",
refresh_btn: "↻ Обход сейчас (троттлинг 30 мин)",
empty_text: "▣ База разведки пуста. Сначала выполните обход: кнопка ниже или <code>POST /api/refresh</code>. У неаутентифицированного GitHub API ограниченная часовая квота поиска — не обновляйте часто (ручное обновление панели троттлится на 30 минут).",
empty_btn: "Обход сейчас",
overview_title: "◢ ОБЗОР РАЗВЕДКИ",
overview_para: "Панель отслеживает популярные репозитории GitHub: доска роста сортируется по приросту звёзд за раунд (нужно минимум два обхода), остальное — по баллу нагрева. Нагрев = взвешенная правилами смесь масштаба звёзд + прироста за раунд + свежести пушей + активности форков; учебные точки — сопоставление по ключевым словам; оценки: S ≥70, A ≥45, B — остальные.",
sec_surge: "◢ ДОСКА РОСТА",
sec_newstars: "◢ НОВЫЕ ЗВЁЗДЫ",
sec_ai: "◢ ЗОНА AI / AGENT",
sec_security: "◢ РАЗВЕДКА БЕЗОПАСНОСТИ",
sec_src: "◢ ОХОТА SRC",
sec_seclearn: "◢ ОБУЧЕНИЕ БЕЗОПАСНОСТИ",
sec_skills: "◢ ЭКОСИСТЕМА SKILL",
sec_creator: "◢ ИНСТРУМЕНТЫ АВТОРА",
sec_watchlist: "◢ WATCHLIST",
sec_all: "◢ ВСЯ РАЗВЕДКА",
nodata: "Нет данных",
show_more: "Показать все {n} ▾",
show_less: "Свернуть ▴",
watchlist_para: "Ручной список семян (предварительно отобран) из пяти групп: Skill / Письмо / Наука / Авторство / Безопасность. Если семя попало в текущий обход, на карточке живые ★, нагрев и прирост за раунд; непопавшие семена освежаются по курсору по очереди («отдельное освежение», не более 3 за раунд, на карточке время освежения); переименование при освежении показывает текущее имя, 404 помечается как возможное удаление; до кого очередь не дошла — «именной мониторинг». Учебные точки семян написаны человеком и отличаются от вердиктов по правилам.",
all_foot: "Источник: GitHub Search API (публичный; лимиты без аутентификации ≈10 поисков/мин и часовая квота — задайте GITHUB_TOKEN, чтобы поднять). Прирост звёзд требует минимум двух обходов со сравнением снимков; в первом раунде всё — «новое в базе». Все вердикты здесь выдаёт движок правил; учебные точки семян написаны человеком; ни то ни другое не является рекомендацией.",
pager_prev: "← Назад",
pager_next: "Вперёд →",
brief_fab: "📋 Президентский брифинг",
brief_head: "📋 ПРЕЗИДЕНТСКИЙ БРИФИНГ",
brief_min: "Свернуть",
brief_close: "Закрыть",
brief_foot: "Сформировано в {time} CST · Движок правил (не ИИ)",
js_refreshing: "Обход… (несколько секунд)",
js_throttled: "Троттлинг: с прошлого обхода прошло менее 30 минут, попробуйте позже.",
js_fail: "Обход не удался: ",
js_pager: "Страница {cur} / {pages} · всего {total} (после фильтра)",
js_shown: " · показано {n}",
no_desc: "(без описания)",
delta_fmt: "{sd}★ за раунд",
heat_line: "Нагрев {heat} / 100 · Пуш {date}",
verdict_prefix: "Вердикт (правила): ",
tag_title: "Фильтровать всю разведку по этому тегу",
seed_note: "Учебная точка: ",
seed_live: "★ {stars} · Нагрев {heat} · {grade}",
seed_refreshed: "Отдельное освежение",
seed_renamed: "ранее {name}, переименовано",
seed_gone: "⚠️ Возможно удалён / переименование не отслежено (проверка освежения {ts})",
seed_static: "Не попало в этот обход · Именной мониторинг",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "【Обстановка за день】",
brief_surge_t: "【ТОП-3 роста】",
brief_heat_t: "【ТОП-3 по теплу】",
brief_sec_t: "【Фокус: безопасность】",
brief_skill_t: "【Фокус: Skills】",
brief_wl_t: "【Динамика наблюдения】",
brief_trend_t: "【Тренды тем】",
brief_rename_t: "【Переименования】",
brief_nodata_delta: "Нет данных о приросте (нужны два обхода)",
brief_no_sec: "Нет фокуса безопасности",
brief_no_skill: "Нет фокуса Skill",
brief_meta: "★ {stars} · Нагрев {heat}",
brief_delta: " · {sd}★ за раунд",
brief_hot_tags: "Популярные теги: ",
brief_wl_line: "Живые данные по <b>{live}</b> / {total} семенам",
brief_wl_top: "Ведущее семя: ",
brief_topics_label: "Нагрев ключевых слов: ",
brief_topic_item: "{topic} ({count} реп. · ★{stars})",
brief_rename_line: "Переименовано: {from} → ",
oneliner_empty: "База разведки пуста; выполните обход, чтобы сформировать обстановку дня.",
oneliner_p1: "Сегодня под наблюдением {n} репозиториев, новых в раунде: {new}, каналы обхода в норме {ok}/{total}. ",
oneliner_surge: "Быстрее всех растёт {name} (+{d}★ за раунд). ",
oneliner_heat: "Лидер нагрева — {name} (нагрев {heat}). ",
oneliner_sec: "Фокус безопасности — {name}",
oneliner_sec_tags: "; популярные теги безопасности: {tags}",
oneliner_end: ".",
verdict_up: "За раунд +{d}★, ",
verdict_down: "За раунд {d}★, ",
verdict_flat: "Звёзды за раунд без изменений, ",
verdict_new: "Новое в базе, ",
verdict_body: "проект по теме «{point}»; стоит посмотреть его реализацию.",
verdict_generic: "нагрев {heat}; ключевая тема: {tag}.",
tag_practice_suffix: "инженерная практика",
kv_err_title: "Ошибка конфигурации",
kv_err_h1: "◢ Ошибка конфигурации",
kv_err_body: "KV не привязан: привяжите к этому Worker пространство KV с именем переменной <b>INTEL_KV</b> и передеплойте.",
},
uk: {
doc_title: "GitHub Intel Center",
h1: "◢ Центр розвідки GitHub",
tagline: "GITHUB INTEL CENTER // Моніторинг відкритого коду · Аналіз за правилами · Не згенеровано ШІ",
clock_label: "Пекінський час CST",
status_label: "Статус обходу: ",
status_ok: "✅ Норма",
status_warn: "⚠️ Збій",
status_none: "Немає даних",
channels_part: " · Канали {ok}/{total}",
toggle_collapse: "Згорнути панель ▴",
toggle_expand: "Розгорнути панель ▾",
tagcloud_label: "🏷 Популярні теги (клік — фільтр усієї розвідки)",
tagcloud_empty: "Немає даних тегів",
trend_label: "📈 Тренди тем",
trend_fmt: "+{d}★/24год · зростання {n} раунди поспіль",
filter_all: "Усі",
grade_all: "Оцінка: усі",
grade_btn_fmt: "Ранг {g}",
grade_card_fmt: "Ранг {g}",
search_ph: "🔍 Пошук за репозиторіями / описами / мовами",
pill_label: "Тег: ",
pill_clear: "✕ Скинути тег",
expand_all: "Розгорнути все",
collapse_all: "Згорнути все",
ticker_full: "Останній обхід {ts} · Відстежується репозиторіїв: {n} · Нових у цьому раунді: {new} · Канали в нормі {ok}/{total}",
ticker_err: " · Збійні канали: {list}",
ticker_src: " · Джерело: GitHub Search API (низькі ліміти без автентифікації) · Аналіз — рушій правил",
ticker_none: "Даних обходу ще немає · Натисніть «Обхід зараз» або POST /api/refresh для першої розвідки",
kpi_repos: "Репозиторіїв під наглядом",
kpi_new: "Нових у раунді",
kpi_heat: "Макс. нагрів",
kpi_channels: "Каналів розвідки",
kpi_seeds: "Насінин у watchlist",
kpi_last: "Останній обхід (CST)",
refresh_btn: "↻ Обхід зараз (тротлінг 30 хв)",
empty_text: "▣ База розвідки порожня. Спершу виконайте обхід: кнопка нижче або <code>POST /api/refresh</code>. У неавтентифікованого GitHub API обмежена годинна квота пошуку — не оновлюйте часто (ручне оновлення панелі тротлиться на 30 хвилин).",
empty_btn: "Обхід зараз",
overview_title: "◢ ОГЛЯД РОЗВІДКИ",
overview_para: "Панель відстежує популярні репозиторії GitHub: дошка зростання сортується за приростом зірок за раунд (потрібно щонайменше два обходи), решта — за балом нагріву. Нагрів = зважена правилами суміш масштабу зірок + приросту за раунд + свіжості пушів + активності форків; навчальні точки — зіставлення за ключовими словами; оцінки: S ≥70, A ≥45, B — решта.",
sec_surge: "◢ ДОШКА ЗРОСТАННЯ",
sec_newstars: "◢ НОВІ ЗІРКИ",
sec_ai: "◢ ЗОНА AI / AGENT",
sec_security: "◢ РОЗВІДКА БЕЗПЕКИ",
sec_src: "◢ ПОЛЮВАННЯ SRC",
sec_seclearn: "◢ НАВЧАННЯ БЕЗПЕКИ",
sec_skills: "◢ ЕКОСИСТЕМА SKILL",
sec_creator: "◢ ІНСТРУМЕНТИ АВТОРА",
sec_watchlist: "◢ WATCHLIST",
sec_all: "◢ УСЯ РОЗВІДКА",
nodata: "Немає даних",
show_more: "Показати всі {n} ▾",
show_less: "Згорнути ▴",
watchlist_para: "Ручний список насінин (попередньо відібраний) із п'яти груп: Skill / Письмо / Наука / Авторство / Безпека. Якщо насінина потрапила в поточний обхід, на картці живі ★, нагрів і приріст за раунд; ті, що не потрапили, освіжаються за курсором по черзі («окреме освіження», не більше 3 за раунд, на картці час освіження); перейменування під час освіження показує поточне ім'я, 404 позначається як можливе видалення; до кого черга не дійшла — «іменний моніторинг». Навчальні точки насінин написані людиною й відрізняються від вердиктів за правилами.",
all_foot: "Джерело: GitHub Search API (публічний; ліміти без автентифікації ≈10 пошуків/хв і годинна квота — задайте GITHUB_TOKEN, щоб підняти). Приріст зірок потребує щонайменше двох обходів із порівнянням знімків; у першому раунді все — «нове в базі». Усі вердикти тут видає рушій правил; навчальні точки насінин написані людиною; ані те, ані інше не є рекомендацією.",
pager_prev: "← Назад",
pager_next: "Вперед →",
brief_fab: "📋 Президентський брифінг",
brief_head: "📋 ПРЕЗИДЕНТСЬКИЙ БРИФІНГ",
brief_min: "Згорнути",
brief_close: "Закрити",
brief_foot: "Сформовано о {time} CST · Рушій правил (не ШІ)",
js_refreshing: "Обхід… (кілька секунд)",
js_throttled: "Троттлінг: від минулого обходу минуло менше 30 хвилин, спробуйте пізніше.",
js_fail: "Обхід не вдався: ",
js_pager: "Сторінка {cur} / {pages} · усього {total} (після фільтра)",
js_shown: " · показано {n}",
no_desc: "(без опису)",
delta_fmt: "{sd}★ за раунд",
heat_line: "Нагрів {heat} / 100 · Пуш {date}",
verdict_prefix: "Вердикт (правила): ",
tag_title: "Фільтрувати всю розвідку за цим тегом",
seed_note: "Навчальна точка: ",
seed_live: "★ {stars} · Нагрів {heat} · {grade}",
seed_refreshed: "Окреме освіження",
seed_renamed: "раніше {name}, перейменовано",
seed_gone: "⚠️ Можливо видалено / перейменування не відстежено (перевірка освіження {ts})",
seed_static: "Не потрапило в цей обхід · Іменний моніторинг",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "【Становище за день】",
brief_surge_t: "【ТОП-3 зростання】",
brief_heat_t: "【ТОП-3 за теплом】",
brief_sec_t: "【Фокус: безпека】",
brief_skill_t: "【Фокус: Skills】",
brief_wl_t: "【Динаміка спостереження】",
brief_trend_t: "【Тренди тем】",
brief_rename_t: "【Перейменування】",
brief_nodata_delta: "Немає даних про приріст (потрібні два обходи)",
brief_no_sec: "Немає фокуса безпеки",
brief_no_skill: "Немає фокуса Skill",
brief_meta: "★ {stars} · Нагрів {heat}",
brief_delta: " · {sd}★ за раунд",
brief_hot_tags: "Популярні теги: ",
brief_wl_line: "Живі дані щодо <b>{live}</b> / {total} насінин",
brief_wl_top: "Провідна насінина: ",
brief_topics_label: "Нагрів ключових слів: ",
brief_topic_item: "{topic} ({count} реп. · ★{stars})",
brief_rename_line: "Перейменовано: {from} → ",
oneliner_empty: "База розвідки порожня; виконайте обхід, щоб сформувати обстановку дня.",
oneliner_p1: "Сьогодні під наглядом {n} репозиторіїв, нових у раунді: {new}, канали обходу в нормі {ok}/{total}. ",
oneliner_surge: "Найшвидше зростає {name} (+{d}★ за раунд). ",
oneliner_heat: "Лідер нагріву — {name} (нагрів {heat}). ",
oneliner_sec: "Фокус безпеки — {name}",
oneliner_sec_tags: "; популярні теги безпеки: {tags}",
oneliner_end: ".",
verdict_up: "За раунд +{d}★, ",
verdict_down: "За раунд {d}★, ",
verdict_flat: "Зірки за раунд без змін, ",
verdict_new: "Нове в базі, ",
verdict_body: "проєкт за темою «{point}»; варто подивитися його реалізацію.",
verdict_generic: "нагрів {heat}; ключова тема: {tag}.",
tag_practice_suffix: "інженерна практика",
kv_err_title: "Помилка конфігурації",
kv_err_h1: "◢ Помилка конфігурації",
kv_err_body: "KV не прив'язано: прив'яжіть до цього Worker простір KV з іменем змінної <b>INTEL_KV</b> і передеплойте.",
},
ja: {
doc_title: "GitHub インテルセンター",
h1: "◢ GitHub 情報センター",
tagline: "GITHUB INTEL CENTER // オープンソース情報巡回 · ルール研判 · AI生成ではない",
clock_label: "北京時間 CST",
status_label: "巡回ステータス：",
status_ok: "✅ 正常",
status_warn: "⚠️ 異常",
status_none: "データなし",
channels_part: " · チャンネル {ok}/{total}",
toggle_collapse: "ツールバーを閉じる ▴",
toggle_expand: "ツールバーを開く ▾",
tagcloud_label: "🏷 人気タグ（クリックで全情報を絞り込み）",
tagcloud_empty: "タグデータなし",
trend_label: "📈 トピック動向",
trend_fmt: "+{d}★/24h · {n} ラウンド連続上昇",
filter_all: "すべて",
grade_all: "評価 すべて",
grade_btn_fmt: "{g} ランク",
grade_card_fmt: "{g}ランク",
search_ph: "🔍 リポジトリ名 / 説明 / 言語で検索",
pill_label: "タグ：",
pill_clear: "✕ タグを解除",
expand_all: "すべて展開",
collapse_all: "すべて折りたたむ",
ticker_full: "前回巡回 {ts} · 監視リポジトリ {n} 件 · 今回新規 {new} 件 · チャンネル正常 {ok}/{total}",
ticker_err: " · 異常チャンネル：{list}",
ticker_src: " · データ元 GitHub Search API（未認証は上限低め） · 研判はルールエンジン産出",
ticker_none: "巡回データなし · 「今すぐ巡回」または POST /api/refresh で最初の情報を取得",
kpi_repos: "監視リポジトリ数",
kpi_new: "今回の新規",
kpi_heat: "最高熱度",
kpi_channels: "情報チャンネル数",
kpi_seeds: "重点監視シード",
kpi_last: "前回巡回 (CST)",
refresh_btn: "↻ 今すぐ巡回（30分スロットル）",
empty_text: "▣ 情報庫は空です。まず巡回を実行してください：下のボタン、または <code>POST /api/refresh</code>。未認証 GitHub API は1時間あたりの検索上限が限られるため、頻繁に更新しないでください（パネルの手動更新は30分スロットル）。",
empty_btn: "今すぐ巡回",
overview_title: "◢ 情報総覧 INTEL OVERVIEW",
overview_para: "本パネルは GitHub の人気リポジトリを追跡します：急上昇榜は今回のスター増分順（増分には最低2回の巡回が必要）、その他は熱度スコア順。熱度 = スター規模 + 今回増分 + プッシュ新鮮度 + fork 活発度のルール加重；学習ポイントはキーワードルールのマッピング；評価は S ≥70、A ≥45、B その他。",
sec_surge: "◢ 急上昇榜 STAR SURGE",
sec_newstars: "◢ 人気新星 NEW STARS",
sec_ai: "◢ AI / AGENT ゾーン",
sec_security: "◢ セキュリティ情報 SECURITY INTEL",
sec_src: "◢ SRC ハンティング SRC HUNTING",
sec_seclearn: "◢ セキュリティ学習 SECURITY LEARNING",
sec_skills: "◢ Skill エコシステム SKILL ECOSYSTEM",
sec_creator: "◢ クリエイターツール CREATOR TOOLKIT",
sec_watchlist: "◢ 重点監視 WATCHLIST",
sec_all: "◢ 全情報 ALL INTEL",
nodata: "データなし",
show_more: "全 {n} 件を表示 ▾",
show_less: "折りたたむ ▴",
watchlist_para: "人手で選んだシード一覧（事前選別済み）：Skill / 執筆 / 研究 / クリエイター / セキュリティの5分類。シードが今回の巡回にヒットすると、カードにリアルタイムの ★・熱度・今回増分が表示されます；ヒットしなかったシードはカーソルで順番に「個別リフレッシュ」（1回最大3件、カードにリフレッシュ時刻を表示）；リフレッシュで改名が見つかれば現在の名前を表示し、404 は削除の可能性として注記；まだ順番が来ていないものは「指名監視中」。シードの学習ポイントは人手による研判で、ルール研判とは区別されます。",
all_foot: "データ元：GitHub Search API（公開インターフェース、未認証時は約10回/分＋1時間あたりの検索クォータ制限；GITHUB_TOKEN を設定すると引き上げ可能）。スター増分は最低2回の巡回でスナップショットを比較して算出され、初回はすべて「情報庫に新規」。本サイトの研判はすべてルールエンジンの産出であり、重点監視シードの学習ポイントは人手による記述で、いずれも推奨を意味しません。",
pager_prev: "← 前へ",
pager_next: "次へ →",
brief_fab: "📋 大統領ブリーフィング",
brief_head: "📋 大統領ブリーフィング · DAILY BRIEF",
brief_min: "最小化",
brief_close: "閉じる",
brief_foot: "{time} CST 生成 · ルールエンジン（AI生成ではない）",
js_refreshing: "巡回中…（数秒かかります）",
js_throttled: "スロットル中：前回巡回から30分未満です。しばらくしてからお試しください。",
js_fail: "巡回失敗：",
js_pager: "{cur} / {pages} ページ · 全 {total} 件（絞り込み後）",
js_shown: " 現在 {n} 件表示中",
no_desc: "（説明なし）",
delta_fmt: "{sd}★ 今回",
heat_line: "熱度 {heat} / 100 · プッシュ {date}",
verdict_prefix: "研判（ルール）：",
tag_title: "このタグで全情報を絞り込む",
seed_note: "学習ポイント：",
seed_live: "★ {stars} · 熱度 {heat} · {grade}",
seed_refreshed: "個別リフレッシュ",
seed_renamed: "旧 {name} から改名",
seed_gone: "⚠️ 削除/改名未追跡の可能性（リフレッシュ確認 {ts}）",
seed_static: "今回の巡回に未ヒット · 指名監視中",
seed_group_fmt: "▸ {cat}（{n}）",
brief_situation: "【本日の情勢】",
brief_surge_t: "【急上昇 TOP3】",
brief_heat_t: "【熱度 TOP3】",
brief_sec_t: "【セキュリティ焦点】",
brief_skill_t: "【Skill 焦点】",
brief_wl_t: "【重点監視の動向】",
brief_trend_t: "【トピック動向】",
brief_rename_t: "【改名動向】",
brief_nodata_delta: "増分データなし（2回の巡回が必要）",
brief_no_sec: "セキュリティ焦点なし",
brief_no_skill: "Skill 焦点なし",
brief_meta: "★ {stars} · 熱度 {heat}",
brief_delta: " · {sd}★ 今回",
brief_hot_tags: "人気タグ：",
brief_wl_line: "リアルタイムデータ取得済み <b>{live}</b> / {total} シード",
brief_wl_top: "トップシード：",
brief_topics_label: "キーワード熱度：",
brief_topic_item: "{topic}（{count} 件 · ★{stars}）",
brief_rename_line: "改名：{from} → ",
oneliner_empty: "情報庫にデータがありません。巡回を実行すると本日の情勢が生成されます。",
oneliner_p1: "本日は {n} 件のリポジトリを監視し、今回の新規は {new} 件、巡回チャンネルは {ok}/{total} が正常です。",
oneliner_surge: "最も急上昇しているのは {name}（今回 +{d}★）。",
oneliner_heat: "熱度の首位は {name}（熱度 {heat}）。",
oneliner_sec: "セキュリティの焦点は {name}",
oneliner_sec_tags: "、人気のセキュリティタグ：{tags}",
oneliner_end: "。",
verdict_up: "前回 +{d}★、",
verdict_down: "今回 {d}★ 低下、",
verdict_flat: "今回スター変動なし、",
verdict_new: "情報庫に新規、",
verdict_body: "{point}のプロジェクト。その{point}の実装を見る価値あり。",
verdict_generic: "熱度 {heat}、主な見どころ：{tag}。",
tag_practice_suffix: "エンジニアリング実践",
kv_err_title: "設定エラー",
kv_err_h1: "◢ 設定エラー",
kv_err_body: "KV がバインドされていません：この Worker に変数名 <b>INTEL_KV</b> で KV namespace をバインドし、再デプロイしてください。",
},
ko: {
doc_title: "GitHub 인텔 센터",
h1: "◢ GitHub 정보 센터",
tagline: "GITHUB INTEL CENTER // 오픈소스 정보 순찰 · 규칙 분석 · AI 생성이 아님",
clock_label: "베이징 시간 CST",
status_label: "순찰 상태: ",
status_ok: "✅ 정상",
status_warn: "⚠️ 이상",
status_none: "데이터 없음",
channels_part: " · 채널 {ok}/{total}",
toggle_collapse: "툴바 접기 ▴",
toggle_expand: "툴바 펼치기 ▾",
tagcloud_label: "🏷 인기 태그 (클릭하면 전체 정보 필터링)",
tagcloud_empty: "태그 데이터 없음",
trend_label: "📈 토픽 동향",
trend_fmt: "+{d}★/24h · {n} 라운드 연속 상승",
filter_all: "전체",
grade_all: "등급 전체",
grade_btn_fmt: "{g} 등급",
grade_card_fmt: "{g}등급",
search_ph: "🔍 저장소 이름 / 설명 / 언어 검색",
pill_label: "태그: ",
pill_clear: "✕ 태그 지우기",
expand_all: "모두 펼치기",
collapse_all: "모두 접기",
ticker_full: "지난 순찰 {ts} · 모니터링 저장소 {n}개 · 이번 신규 {new}개 · 채널 정상 {ok}/{total}",
ticker_err: " · 이상 채널: {list}",
ticker_src: " · 데이터 출처 GitHub Search API (미인증 한도 낮음) · 분석은 규칙 엔진 산출",
ticker_none: "순찰 데이터 없음 · '지금 순찰' 또는 POST /api/refresh 로 첫 정보를 가져오세요",
kpi_repos: "모니터링 저장소 수",
kpi_new: "이번 신규",
kpi_heat: "최고 열도",
kpi_channels: "정보 채널 수",
kpi_seeds: "중점 모니터링 시드",
kpi_last: "지난 순찰 (CST)",
refresh_btn: "↻ 지금 순찰 (30분 스로틀)",
empty_text: "▣ 정보 저장소가 비어 있습니다. 먼저 순찰을 실행하세요: 아래 버튼 또는 <code>POST /api/refresh</code>. 미인증 GitHub API는 시간당 검색 한도가 제한적이므로 자주 새로고침하지 마세요 (패널 수동 새로고침은 30분 스로틀).",
empty_btn: "지금 순찰",
overview_title: "◢ 정보 총람 INTEL OVERVIEW",
overview_para: "이 패널은 GitHub 인기 저장소를 추적합니다: 급상승 보드는 이번 라운드의 스타 증분 순(증분은 최소 두 번의 순찰 필요), 나머지는 열도 점수 순입니다. 열도 = 스타 규모 + 이번 증분 + 푸시 신선도 + fork 활발도의 규칙 가중; 학습 포인트는 키워드 규칙 매핑; 등급은 S ≥70, A ≥45, B 그 외.",
sec_surge: "◢ 급상승 보드 STAR SURGE",
sec_newstars: "◢ 인기 신성 NEW STARS",
sec_ai: "◢ AI / AGENT 존",
sec_security: "◢ 보안 정보 SECURITY INTEL",
sec_src: "◢ SRC 헌팅 SRC HUNTING",
sec_seclearn: "◢ 보안 학습 SECURITY LEARNING",
sec_skills: "◢ Skill 생태계 SKILL ECOSYSTEM",
sec_creator: "◢ 크리에이터 툴킷 CREATOR TOOLKIT",
sec_watchlist: "◢ 중점 모니터링 WATCHLIST",
sec_all: "◢ 전체 정보 ALL INTEL",
nodata: "데이터 없음",
show_more: "전체 {n}개 보기 ▾",
show_less: "접기 ▴",
watchlist_para: "수작업으로 고른 시드 목록(사전 선별): Skill / 글쓰기 / 연구 / 크리에이터 / 보안 5개 분류. 시드가 이번 순찰에 적중하면 카드에 실시간 ★, 열도와 이번 증분이 표시됩니다; 적중하지 못한 시드는 커서로 차례로 '개별 리프레시'(라운드당 최대 3개, 카드에 리프레시 시각 표시); 리프레시에서 개명이 발견되면 현재 이름을 표시하고, 404는 삭제 가능성으로 표기; 아직 차례가 오지 않은 것은 '지명 모니터링 중'. 시드의 학습 포인트는 사람이 쓴 분석으로, 규칙 분석과 구분됩니다.",
all_foot: "데이터 출처: GitHub Search API (공개 인터페이스, 미인증 시 약 10회/분 + 시간당 검색 쿼터 제한; GITHUB_TOKEN을 설정하면 상향 가능). 스타 증분은 최소 두 번의 순찰로 스냅샷을 비교해 산출되며, 첫 라운드에서는 모두 '정보 저장소 신규'입니다. 이 사이트의 분석은 모두 규칙 엔진 산출이며, 중점 모니터링 시드의 학습 포인트는 사람이 작성한 것으로, 어느 것도 추천을 의미하지 않습니다.",
pager_prev: "← 이전",
pager_next: "다음 →",
brief_fab: "📋 대통령 브리핑",
brief_head: "📋 대통령 브리핑 · DAILY BRIEF",
brief_min: "최소화",
brief_close: "닫기",
brief_foot: "{time} CST 생성 · 규칙 엔진 (AI 생성이 아님)",
js_refreshing: "순찰 중… (몇 초 걸립니다)",
js_throttled: "스로틀 중: 지난 순찰로부터 30분이 지나지 않았습니다. 잠시 후 다시 시도하세요.",
js_fail: "순찰 실패: ",
js_pager: "{cur} / {pages} 페이지 · 총 {total}개 (필터 후)",
js_shown: " 현재 {n}개 표시 중",
no_desc: "(설명 없음)",
delta_fmt: "{sd}★ 이번 라운드",
heat_line: "열도 {heat} / 100 · 푸시 {date}",
verdict_prefix: "분석 (규칙): ",
tag_title: "이 태그로 전체 정보 필터링",
seed_note: "학습 포인트: ",
seed_live: "★ {stars} · 열도 {heat} · {grade}",
seed_refreshed: "개별 리프레시",
seed_renamed: "구 {name}에서 개명",
seed_gone: "⚠️ 삭제/개명 미추적 가능성 (리프레시 확인 {ts})",
seed_static: "이번 순찰에 미적중 · 지명 모니터링 중",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "【오늘의 정세】",
brief_surge_t: "【급상승 TOP3】",
brief_heat_t: "【열도 TOP3】",
brief_sec_t: "【보안 초점】",
brief_skill_t: "【Skill 초점】",
brief_wl_t: "【중점 모니터링 동향】",
brief_trend_t: "【토픽 동향】",
brief_rename_t: "【이름 변경 동향】",
brief_nodata_delta: "증분 데이터 없음 (두 번의 순찰 필요)",
brief_no_sec: "보안 초점 없음",
brief_no_skill: "Skill 초점 없음",
brief_meta: "★ {stars} · 열도 {heat}",
brief_delta: " · {sd}★ 이번 라운드",
brief_hot_tags: "인기 태그: ",
brief_wl_line: "실시간 데이터 확보 <b>{live}</b> / {total} 시드",
brief_wl_top: "선두 시드: ",
brief_topics_label: "키워드 열도: ",
brief_topic_item: "{topic} ({count}개 · ★{stars})",
brief_rename_line: "개명: {from} → ",
oneliner_empty: "정보 저장소에 데이터가 없습니다. 순찰을 실행하면 오늘의 정세가 생성됩니다.",
oneliner_p1: "오늘 {n}개 저장소를 모니터링 중이며, 이번 신규는 {new}개, 순찰 채널은 {ok}/{total} 정상입니다.",
oneliner_surge: " 가장 빠르게 상승한 것은 {name} (이번 +{d}★).",
oneliner_heat: " 열도 1위는 {name} (열도 {heat}).",
oneliner_sec: " 보안 초점은 {name}",
oneliner_sec_tags: ", 인기 보안 태그: {tags}",
oneliner_end: ".",
verdict_up: "지난 라운드 +{d}★, ",
verdict_down: "이번 라운드 {d}★ 하락, ",
verdict_flat: "이번 라운드 스타 변동 없음, ",
verdict_new: "정보 저장소 신규, ",
verdict_body: "{point} 프로젝트. 그 {point} 구현을 볼 가치가 있다.",
verdict_generic: "열도 {heat}, 주요 포인트: {tag}.",
tag_practice_suffix: "엔지니어링 실무",
kv_err_title: "구성 오류",
kv_err_h1: "◢ 구성 오류",
kv_err_body: "KV가 바인딩되지 않았습니다: 이 Worker에 변수 이름 <b>INTEL_KV</b> 로 KV namespace를 바인딩한 뒤 재배포하세요.",
},
es: {
doc_title: "GitHub Intel Center",
h1: "◢ Centro de Inteligencia de GitHub",
tagline: "GITHUB INTEL CENTER // Barridos de inteligencia de código abierto · Análisis por reglas · No generado por IA",
clock_label: "Hora de Pekín CST",
status_label: "Estado del barrido: ",
status_ok: "✅ OK",
status_warn: "⚠️ Error",
status_none: "Sin datos",
channels_part: " · Canales {ok}/{total}",
toggle_collapse: "Contraer barra ▴",
toggle_expand: "Expandir barra ▾",
tagcloud_label: "🏷 Etiquetas populares (clic para filtrar toda la inteligencia)",
tagcloud_empty: "Sin datos de etiquetas",
trend_label: "📈 Tendencias de temas",
trend_fmt: "+{d}★/24h · subiendo {n} rondas seguidas",
filter_all: "Todo",
grade_all: "Grado: todos",
grade_btn_fmt: "Nivel {g}",
grade_card_fmt: "Nivel {g}",
search_ph: "🔍 Buscar repos / descripciones / lenguajes",
pill_label: "Etiqueta: ",
pill_clear: "✕ Quitar etiqueta",
expand_all: "Expandir todo",
collapse_all: "Contraer todo",
ticker_full: "Último barrido {ts} · {n} repos vigilados · {new} nuevos en esta ronda · Canales OK {ok}/{total}",
ticker_err: " · Canales con error: {list}",
ticker_src: " · Fuente: GitHub Search API (límites bajos sin autenticación) · Análisis por motor de reglas",
ticker_none: "Aún no hay datos · Pulsa 'Barrer ahora' o POST /api/refresh para la primera inteligencia",
kpi_repos: "Repos vigilados",
kpi_new: "Nuevos en la ronda",
kpi_heat: "Calor máximo",
kpi_channels: "Canales de inteligencia",
kpi_seeds: "Semillas vigiladas",
kpi_last: "Último barrido (CST)",
refresh_btn: "↻ Barrer ahora (límite 30 min)",
empty_text: "▣ El almacén de inteligencia está vacío. Ejecuta primero un barrido: el botón de abajo o <code>POST /api/refresh</code>. La API de GitHub sin autenticación tiene una cuota de búsqueda por hora limitada: no actualices a menudo (la actualización manual del panel está limitada a 30 minutos).",
empty_btn: "Barrer ahora",
overview_title: "◢ PANORAMA DE INTELIGENCIA",
overview_para: "Este panel sigue los repositorios populares de GitHub: la tabla de auge se ordena por el crecimiento de estrellas de esta ronda (hacen falta al menos dos barridos), el resto por puntuación de calor. Calor = mezcla ponderada por reglas de escala de estrellas + crecimiento de la ronda + frescura de pushes + actividad de forks; los puntos de aprendizaje son mapeos de palabras clave; grados: S ≥70, A ≥45, B el resto.",
sec_surge: "◢ AUGE DE ESTRELLAS",
sec_newstars: "◢ ESTRELLAS NUEVAS",
sec_ai: "◢ ZONA AI / AGENT",
sec_security: "◢ INTELIGENCIA DE SEGURIDAD",
sec_src: "◢ CAZA SRC",
sec_seclearn: "◢ APRENDIZAJE DE SEGURIDAD",
sec_skills: "◢ ECOSISTEMA SKILL",
sec_creator: "◢ KIT DEL CREADOR",
sec_watchlist: "◢ WATCHLIST",
sec_all: "◢ TODA LA INTELIGENCIA",
nodata: "Sin datos",
show_more: "Mostrar los {n} ▾",
show_less: "Contraer ▴",
watchlist_para: "Lista de semillas elegida a mano (preseleccionada) en cinco grupos: Skill / Escritura / Investigación / Creadores / Seguridad. Si una semilla aparece en el barrido actual, su tarjeta muestra ★ en vivo, calor y crecimiento de la ronda; las que no aparecen se refrescan por turnos con un cursor ('refresco individual', máx. 3 por ronda, la tarjeta muestra la hora de refresco); un renombre detectado al refrescar muestra el nombre actual y un 404 se marca como posible eliminación; las que aún no han tenido turno se marcan 'monitorización nominal'. Los puntos de aprendizaje de las semillas son análisis humano, distinto de los veredictos por reglas.",
all_foot: "Fuente: GitHub Search API (pública; límites sin autenticación ≈10 búsquedas/min con cuota por hora: define GITHUB_TOKEN para subirlos). El crecimiento de estrellas requiere al menos dos barridos comparando instantáneas; en la primera ronda todo es 'nuevo en el almacén'. Todos los veredictos de este sitio los produce un motor de reglas; los puntos de aprendizaje de las semillas están escritos por humanos; ninguno constituye una recomendación.",
pager_prev: "← Anterior",
pager_next: "Siguiente →",
brief_fab: "📋 Informe presidencial",
brief_head: "📋 INFORME PRESIDENCIAL",
brief_min: "Minimizar",
brief_close: "Cerrar",
brief_foot: "Generado a las {time} CST · Motor de reglas (no generado por IA)",
js_refreshing: "Barriendo… (tarda unos segundos)",
js_throttled: "Limitado: han pasado menos de 30 minutos desde el último barrido, inténtalo más tarde.",
js_fail: "El barrido falló: ",
js_pager: "Página {cur} / {pages} · {total} elementos (tras el filtro)",
js_shown: " · mostrando {n}",
no_desc: "(sin descripción)",
delta_fmt: "{sd}★ esta ronda",
heat_line: "Calor {heat} / 100 · Push {date}",
verdict_prefix: "Veredicto (reglas): ",
tag_title: "Filtrar toda la inteligencia por esta etiqueta",
seed_note: "Punto de aprendizaje: ",
seed_live: "★ {stars} · Calor {heat} · {grade}",
seed_refreshed: "Refresco individual",
seed_renamed: "antes {name}, renombrado",
seed_gone: "⚠️ Posible eliminación / renombre sin seguir (comprobación {ts})",
seed_static: "No apareció en este barrido · Monitorización nominal",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "[Panorama de hoy]",
brief_surge_t: "[TOP 3 en ascenso]",
brief_heat_t: "[TOP 3 por calor]",
brief_sec_t: "[Foco de seguridad]",
brief_skill_t: "[Foco Skill]",
brief_wl_t: "[Actividad de vigilancia]",
brief_trend_t: "[Tendencias]",
brief_rename_t: "[Renombrados]",
brief_nodata_delta: "Sin datos de crecimiento (hacen falta dos barridos)",
brief_no_sec: "Sin foco de seguridad",
brief_no_skill: "Sin foco Skill",
brief_meta: "★ {stars} · Calor {heat}",
brief_delta: " · {sd}★ esta ronda",
brief_hot_tags: "Etiquetas populares: ",
brief_wl_line: "Datos en vivo de <b>{live}</b> / {total} semillas",
brief_wl_top: "Semilla líder: ",
brief_topics_label: "Calor de palabras clave: ",
brief_topic_item: "{topic} ({count} repos · ★{stars})",
brief_rename_line: "Renombrado: {from} → ",
oneliner_empty: "El almacén está vacío; ejecuta un barrido para generar la situación de hoy.",
oneliner_p1: "Hoy se vigilan {n} repos, {new} nuevos en esta ronda, canales de barrido {ok}/{total} OK. ",
oneliner_surge: "El que más sube: {name} (+{d}★ esta ronda). ",
oneliner_heat: "Líder de calor: {name} (calor {heat}). ",
oneliner_sec: "Foco de seguridad: {name}",
oneliner_sec_tags: "; etiquetas de seguridad populares: {tags}",
oneliner_end: ".",
verdict_up: "+{d}★ en la última ronda, ",
verdict_down: "{d}★ en esta ronda, ",
verdict_flat: "Estrellas sin cambio en esta ronda, ",
verdict_new: "Nuevo en el almacén, ",
verdict_body: "proyecto de {point}: merece la pena estudiar su {point}.",
verdict_generic: "calor {heat}; ángulo clave: {tag}.",
tag_practice_suffix: "prácticas de ingeniería",
kv_err_title: "Error de configuración",
kv_err_h1: "◢ Error de configuración",
kv_err_body: "KV no está vinculado: vincula un namespace KV a este Worker con el nombre de variable <b>INTEL_KV</b> y vuelve a desplegar.",
},
ar: {
doc_title: "مركز استخبارات GitHub",
h1: "◢ مركز استخبارات GitHub",
tagline: "GITHUB INTEL CENTER // مسح استخباراتي مفتوح المصدر · تحليل بالقواعد · ليس مولّداً بالذكاء الاصطناعي",
clock_label: "بتوقيت بكين CST",
status_label: "حالة المسح: ",
status_ok: "✅ طبيعي",
status_warn: "⚠️ خطأ",
status_none: "لا بيانات",
channels_part: " · القنوات {ok}/{total}",
toggle_collapse: "طي شريط الأدوات ▴",
toggle_expand: "توسيع شريط الأدوات ▾",
tagcloud_label: "🏷 الوسوم الشائعة (انقر وسمًا لتصفية كل المعلومات)",
tagcloud_empty: "لا بيانات وسوم",
trend_label: "📈 اتجاهات المواضيع",
trend_fmt: "+{d}★/24 ساعة · صاعد منذ {n} جولات",
filter_all: "الكل",
grade_all: "الدرجة: الكل",
grade_btn_fmt: "المستوى {g}",
grade_card_fmt: "المستوى {g}",
search_ph: "🔍 ابحث في المستودعات / الأوصاف / اللغات",
pill_label: "الوسم: ",
pill_clear: "✕ مسح الوسم",
expand_all: "توسيع الكل",
collapse_all: "طي الكل",
ticker_full: "آخر مسح {ts} · {n} مستودعًا قيد المراقبة · {new} جديد في هذه الجولة · القنوات سليمة {ok}/{total}",
ticker_err: " · قنوات معطلة: {list}",
ticker_src: " · المصدر: GitHub Search API (حدود منخفضة دون مصادقة) · التحليل من محرك القواعد",
ticker_none: "لا بيانات مسح بعد · انقر «مسح الآن» أو POST /api/refresh لجلب أول المعلومات",
kpi_repos: "المستودعات المراقبة",
kpi_new: "جديد هذه الجولة",
kpi_heat: "أعلى حرارة",
kpi_channels: "قنوات الاستخبارات",
kpi_seeds: "بذور المراقبة المركزة",
kpi_last: "آخر مسح (CST)",
refresh_btn: "↻ مسح الآن (خنق 30 دقيقة)",
empty_text: "▣ مخزن المعلومات فارغ. نفّذ مسحًا أولًا: الزر أدناه أو <code>POST /api/refresh</code>. لواجهة GitHub غير المصادقة حصة بحث ساعية محدودة، فلا تحدّث كثيرًا (التحديث اليدوي للوحة مخنوق إلى 30 دقيقة).",
empty_btn: "مسح الآن",
overview_title: "◢ نظرة عامة على المعلومات",
overview_para: "تتتبع هذه اللوحة مستودعات GitHub الشائعة: تُرتَّب لوحة الصعود حسب نمو النجوم في هذه الجولة (يلزم مسحان على الأقل للنمو)، والباقي حسب درجة الحرارة. الحرارة = مزيج مرجح بالقواعد من حجم النجوم + نمو الجولة + حداثة الدفعات + نشاط التفرعات؛ ونقاط التعلم خرائط كلمات مفتاحية بالقواعد؛ والدرجات: S لا تقل عن 70 وA لا تقل عن 45 وB لما عداها.",
sec_surge: "◢ لوحة الصعود",
sec_newstars: "◢ نجوم جديدة",
sec_ai: "◢ منطقة AI / AGENT",
sec_security: "◢ معلومات الأمن",
sec_src: "◢ صيد SRC",
sec_seclearn: "◢ تعلّم الأمن",
sec_skills: "◢ منظومة Skill",
sec_creator: "◢ أدوات صانع المحتوى",
sec_watchlist: "◢ المراقبة المركزة",
sec_all: "◢ كل المعلومات",
nodata: "لا بيانات",
show_more: "عرض كل {n} ▾",
show_less: "طي ▴",
watchlist_para: "قائمة بذور مختارة يدويًا (مصفاة مسبقًا) في خمس فئات: Skill / الكتابة / البحث / صناع المحتوى / الأمن. إذا أصاب المسح الحالي بذرةً، تعرض بطاقتها النجوم والحرارة ونمو هذه الجولة مباشرة؛ والبذور غير المصابة تُنعش بالتناوب عبر مؤشر («إنعاش فردي»، بحد أقصى 3 في الجولة، وتظهر البطاقة وقت الإنعاش)؛ وإعادة التسمية المكتشفة عند الإنعاش تُظهر الاسم الحالي، و404 يُعلَّم كاحتمال حذف؛ وما لم يصل دوره بعد يُعلَّم «مراقبة بالاسم». نقاط تعلم البذور تحليل بشري، متميز عن أحكام القواعد.",
all_foot: "المصدر: GitHub Search API (واجهة عامة؛ الحدود دون مصادقة نحو 10 عمليات بحث/دقيقة مع حصة ساعية — عيّن GITHUB_TOKEN لرفعها). نمو النجوم يتطلب مسحين على الأقل بمقارنة اللقطات؛ في الجولة الأولى كل شيء «جديد في المخزن». جميع الأحكام هنا من محرك قواعد؛ ونقاط تعلم بذور المراقبة المركزة مكتوبة بشريًا؛ ولا يشكل أي منها توصية.",
pager_prev: "← السابق",
pager_next: "التالي →",
brief_fab: "📋 الموجز الرئاسي",
brief_head: "📋 الموجز الرئاسي · DAILY BRIEF",
brief_min: "تصغير",
brief_close: "إغلاق",
brief_foot: "وُلّد في {time} CST · محرك قواعد (ليس ذكاءً اصطناعيًا)",
js_refreshing: "جارٍ المسح… (يستغرق بضع ثوانٍ)",
js_throttled: "مخنوق: لم تمضِ 30 دقيقة على آخر مسح، حاول لاحقًا.",
js_fail: "فشل المسح: ",
js_pager: "صفحة {cur} / {pages} · المجموع {total} (بعد التصفية)",
js_shown: " · يُعرض {n}",
no_desc: "(بلا وصف)",
delta_fmt: "{sd}★ هذه الجولة",
heat_line: "الحرارة {heat} / 100 · الدفع {date}",
verdict_prefix: "الحكم (قواعد): ",
tag_title: "تصفية كل المعلومات بهذا الوسم",
seed_note: "نقطة التعلم: ",
seed_live: "★ {stars} · الحرارة {heat} · {grade}",
seed_refreshed: "إنعاش فردي",
seed_renamed: "سابقًا {name}، أُعيدت تسميته",
seed_gone: "⚠️ احتمال حذف / إعادة تسمية غير متعقبة (فحص الإنعاش {ts})",
seed_static: "لم يُصَب في مسح هذه الجولة · مراقبة بالاسم",
seed_group_fmt: "▸ {cat} ({n})",
brief_situation: "[موجز اليوم]",
brief_surge_t: "[أسرع ٣ صاعدة]",
brief_heat_t: "[الأعلى حرارة ٣]",
brief_sec_t: "[تركيز الأمان]",
brief_skill_t: "[تركيز Skill]",
brief_wl_t: "[نشاط المراقبة]",
brief_trend_t: "[اتجاهات المواضيع]",
brief_rename_t: "[تغييرات الأسماء]",
brief_nodata_delta: "لا بيانات نمو (يلزم مسحان)",
brief_no_sec: "لا تركيز أمني",
brief_no_skill: "لا تركيز Skill",
brief_meta: "★ {stars} · الحرارة {heat}",
brief_delta: " · {sd}★ هذه الجولة",
brief_hot_tags: "الوسوم الشائعة: ",
brief_wl_line: "بيانات حية لـ <b>{live}</b> / {total} بذرة",
brief_wl_top: "البذرة المتصدرة: ",
brief_topics_label: "حرارة الكلمات المفتاحية: ",
brief_topic_item: "{topic} ({count} مستودع · ★{stars})",
brief_rename_line: "أُعيدت التسمية: {from} → ",
oneliner_empty: "مخزن المعلومات فارغ؛ نفّذ مسحًا لتوليد موقف اليوم.",
oneliner_p1: "تُراقب اليوم {n} مستودعًا، و{new} جديد في هذه الجولة، وقنوات المسح سليمة {ok}/{total}.",
oneliner_surge: " الأسرع صعودًا هو {name} (+{d}★ هذه الجولة).",
oneliner_heat: " متصدر الحرارة هو {name} (الحرارة {heat}).",
oneliner_sec: " تركيز الأمن هو {name}",
oneliner_sec_tags: "، والوسوم الأمنية الشائعة: {tags}",
oneliner_end: ".",
verdict_up: "صعد +{d}★ في الجولة الماضية، ",
verdict_down: "تراجع {d}★ هذه الجولة، ",
verdict_flat: "النجوم ثابتة هذه الجولة، ",
verdict_new: "جديد في المخزن، ",
verdict_body: "مشروع {point} — يستحق دراسة {point} فيه.",
verdict_generic: "الحرارة {heat}؛ الزاوية الأساسية: {tag}.",
tag_practice_suffix: "ممارسات هندسية",
kv_err_title: "خطأ في الإعداد",
kv_err_h1: "◢ خطأ في الإعداد",
kv_err_body: "KV غير مربوط: اربط مساحة أسماء KV بهذا الـ Worker باسم المتغير <b>INTEL_KV</b> ثم أعد النشر.",
},
};

// 通道显示名（按通道 key，与 buildChannels 的 key 对应；name 字段本身保持中文供数据层使用）
const CHANNEL_I18N = {
"surge": { zh: "飙升新星", en: "Star Surge", ru: "Рост звёзд", uk: "Зростання зірок", ja: "急上昇", ko: "급상승", es: "Auge de estrellas", ar: "الصاعدون"},
"trending-week": { zh: "本周热门", en: "Trending This Week", ru: "Популярное недели", uk: "Популярне тижня", ja: "今週の人気", ko: "이번 주 인기", es: "Tendencia semanal", ar: "رائج هذا الأسبوع"},
"ai-agent": { zh: "AI / AGENT", en: "AI / AGENT", ru: "AI / AGENT", uk: "AI / AGENT", ja: "AI / AGENT", ko: "AI / AGENT", es: "AI / AGENT", ar: "AI / AGENT"},
"workers": { zh: "边缘 / Bot", en: "Edge / Bots", ru: "Edge / Боты", uk: "Edge / Боти", ja: "エッジ / Bot", ko: "엣지 / 봇", es: "Edge / Bots", ar: "الحافة / البوتات"},
"media": { zh: "多媒体生成", en: "Media Generation", ru: "Генерация медиа", uk: "Генерація медіа", ja: "メディア生成", ko: "미디어 생성", es: "Generación multimedia", ar: "توليد الوسائط"},
"devtools": { zh: "开发工具", en: "Dev Tools", ru: "Инструменты разработки", uk: "Інструменти розробки", ja: "開発ツール", ko: "개발 도구", es: "Herramientas de desarrollo", ar: "أدوات التطوير"},
"security": { zh: "网安 · 红队 · SRC", en: "Security · Red Team · SRC", ru: "Безопасность · Red Team · SRC", uk: "Безпека · Red Team · SRC", ja: "セキュリティ · レッドチーム · SRC", ko: "보안 · 레드팀 · SRC", es: "Seguridad · Red Team · SRC", ar: "الأمن · الفريق الأحمر · SRC"},
"skills": { zh: "Skill 生态", en: "Skill Ecosystem", ru: "Экосистема Skill", uk: "Екосистема Skill", ja: "Skill エコシステム", ko: "Skill 생태계", es: "Ecosistema Skill", ar: "منظومة Skill"},
"creator": { zh: "自媒体全套", en: "Creator Toolkit", ru: "Инструменты автора", uk: "Інструменти автора", ja: "クリエイターツール", ko: "크리에이터 툴킷", es: "Kit del creador", ar: "أدوات صانع المحتوى"},
"src-hunt": { zh: "SRC · 挖洞", en: "SRC · Bug Hunting", ru: "SRC · Поиск уязвимостей", uk: "SRC · Пошук вразливостей", ja: "SRC · 脆弱性ハンティング", ko: "SRC · 취약점 헌팅", es: "SRC · Caza de fallos", ar: "SRC · صيد الثغرات"},
"sec-learning": { zh: "网安学习资料", en: "Security Learning", ru: "Обучение безопасности", uk: "Навчання безпеки", ja: "セキュリティ学習", ko: "보안 학습", es: "Aprendizaje de seguridad", ar: "تعلّم الأمن"},
};
// 种子分类显示名（按分类 key；buildWatchlist 产出的 catName 保持中文供 API 使用，面板渲染时走这里）
const SEED_CAT_I18N = {
skills: { zh: "Skill 生态", en: "Skill Ecosystem", ru: "Экосистема Skill", uk: "Екосистема Skill", ja: "Skill エコシステム", ko: "Skill 생태계", es: "Ecosistema Skill", ar: "منظومة Skill"},
writing: { zh: "写作 Skill", en: "Writing Skills", ru: "Skill для письма", uk: "Письмові Skill", ja: "執筆 Skill", ko: "글쓰기 Skill", es: "Skills de escritura", ar: "Skill الكتابة"},
science: { zh: "科研 Skill", en: "Research Skills", ru: "Научные Skill", uk: "Наукові Skill", ja: "研究 Skill", ko: "연구 Skill", es: "Skills de investigación", ar: "Skill البحث"},
creator: { zh: "自媒体全套", en: "Creator Toolkit", ru: "Инструменты автора", uk: "Інструменти автора", ja: "クリエイターツール", ko: "크리에이터 툴킷", es: "Kit del creador", ar: "أدوات صانع المحتوى"},
security: { zh: "网安 · 红队 · SRC", en: "Security · Red Team · SRC", ru: "Безопасность · Red Team · SRC", uk: "Безпека · Red Team · SRC", ja: "セキュリティ · レッドチーム · SRC", ko: "보안 · 레드팀 · SRC", es: "Seguridad · Red Team · SRC", ar: "الأمن · الفريق الأحمر · SRC"},
};
// 标签显示名：键为记录里存的中文标签（LEARNING_MAP 与 SECURITY_TAG_MAP 的全部产出 + 兜底「工程实现」），渲染时翻译；
// 「<语言> 工程实践」型兜底标签按后缀规则翻译（见 tagLabel）；表中缺失的标签回退中文原文，绝不留空。
const TAG_I18N = {
en: { "MCP 协议接入": "MCP Integration", "Agent 架构": "Agent Architecture", "红队评估方法": "Red Team Assessment", "漏洞管理": "Vulnerability Management", "SRC 众测思路": "Bug Bounty Approach", "开源情报": "OSINT", "Skill 封装范式": "Skill Packaging Patterns", "字幕工程": "Subtitle Engineering", "短视频工作流": "Short-Video Workflow", "RAG 检索": "RAG Retrieval", "边缘部署": "Edge Deployment", "工作流节点": "Workflow Nodes", "音视频管线": "Audio/Video Pipeline", "浏览器自动化": "Browser Automation", "本地存储": "Local Storage", "大模型接入": "LLM Integration", "Bot 交互": "Bot Interaction", "向量检索": "Vector Search", "语音合成": "Speech Synthesis", "图像生成": "Image Generation", "提示工程": "Prompt Engineering", "工作流编排": "Workflow Orchestration", "容器化部署": "Container Deployment", "高性能系统": "High-Performance Systems", "命令行工具": "CLI Tools", "端侧推理": "On-Device Inference", "SQL 注入": "SQL Injection", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "CTF Competitions", "开源情报 OSINT": "OSINT", "恶意代码分析": "Malware Analysis", "数字取证": "Digital Forensics", "蓝队防御": "Blue Team Defense", "代码审计": "Code Audit", "内网渗透": "Intranet Penetration", "权限提升": "Privilege Escalation", "漏洞扫描": "Vulnerability Scanning", "PoC 研究": "PoC Research", "漏洞复盘": "Vulnerability Write-ups", "学习路线": "Learning Roadmap", "钓鱼防御演练": "Phishing Defense Drills", "逆向工程": "Reverse Engineering", "模糊测试": "Fuzz Testing", "DevSecOps": "DevSecOps", "工程实现": "Engineering Implementation"},
ru: { "MCP 协议接入": "Интеграция MCP", "Agent 架构": "Архитектура агентов", "红队评估方法": "Методика Red Team", "漏洞管理": "Управление уязвимостями", "SRC 众测思路": "Подход к Bug Bounty", "开源情报": "OSINT", "Skill 封装范式": "Паттерны упаковки Skill", "字幕工程": "Инженерия субтитров", "短视频工作流": "Воркфлоу коротких видео", "RAG 检索": "RAG-поиск", "边缘部署": "Развёртывание на Edge", "工作流节点": "Узлы воркфлоу", "音视频管线": "Аудио/видео пайплайн", "浏览器自动化": "Автоматизация браузера", "本地存储": "Локальное хранилище", "大模型接入": "Интеграция LLM", "Bot 交互": "Взаимодействие с ботами", "向量检索": "Векторный поиск", "语音合成": "Синтез речи", "图像生成": "Генерация изображений", "提示工程": "Промпт-инженерия", "工作流编排": "Оркестрация воркфлоу", "容器化部署": "Контейнерное развёртывание", "高性能系统": "Высокопроизводительные системы", "命令行工具": "CLI-инструменты", "端侧推理": "Инференс на устройстве", "SQL 注入": "SQL-инъекция", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "CTF-соревнования", "开源情报 OSINT": "OSINT", "恶意代码分析": "Анализ вредоносного ПО", "数字取证": "Цифровая криминалистика", "蓝队防御": "Защита Blue Team", "代码审计": "Аудит кода", "内网渗透": "Внутреннее проникновение", "权限提升": "Повышение привилегий", "漏洞扫描": "Сканирование уязвимостей", "PoC 研究": "PoC-исследования", "漏洞复盘": "Разборы уязвимостей", "学习路线": "Маршрут обучения", "钓鱼防御演练": "Учения по защите от фишинга", "逆向工程": "Обратная инженерия", "模糊测试": "Фаззинг", "DevSecOps": "DevSecOps", "工程实现": "Инженерная реализация"},
uk: { "MCP 协议接入": "Інтеграція MCP", "Agent 架构": "Архітектура агентів", "红队评估方法": "Методика Red Team", "漏洞管理": "Керування вразливостями", "SRC 众测思路": "Підхід до Bug Bounty", "开源情报": "OSINT", "Skill 封装范式": "Патерни пакування Skill", "字幕工程": "Інженерія субтитрів", "短视频工作流": "Воркфлоу коротких відео", "RAG 检索": "RAG-пошук", "边缘部署": "Розгортання на Edge", "工作流节点": "Вузли воркфлоу", "音视频管线": "Аудіо/відео пайплайн", "浏览器自动化": "Автоматизація браузера", "本地存储": "Локальне сховище", "大模型接入": "Інтеграція LLM", "Bot 交互": "Взаємодія з ботами", "向量检索": "Векторний пошук", "语音合成": "Синтез мовлення", "图像生成": "Генерація зображень", "提示工程": "Промпт-інженерія", "工作流编排": "Оркестрація воркфлоу", "容器化部署": "Контейнерне розгортання", "高性能系统": "Високопродуктивні системи", "命令行工具": "CLI-інструменти", "端侧推理": "Інференс на пристрої", "SQL 注入": "SQL-ін'єкція", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "CTF-змагання", "开源情报 OSINT": "OSINT", "恶意代码分析": "Аналіз шкідливого ПЗ", "数字取证": "Цифрова криміналістика", "蓝队防御": "Захист Blue Team", "代码审计": "Аудит коду", "内网渗透": "Внутрішнє проникнення", "权限提升": "Підвищення привілеїв", "漏洞扫描": "Сканування вразливостей", "PoC 研究": "PoC-дослідження", "漏洞复盘": "Розбори вразливостей", "学习路线": "Маршрут навчання", "钓鱼防御演练": "Навчання із захисту від фішингу", "逆向工程": "Зворотна інженерія", "模糊测试": "Фазинг", "DevSecOps": "DevSecOps", "工程实现": "Інженерна реалізація"},
ja: { "MCP 协议接入": "MCP 連携", "Agent 架构": "Agent アーキテクチャ", "红队评估方法": "レッドチーム評価", "漏洞管理": "脆弱性管理", "SRC 众测思路": "バグバウンティの考え方", "开源情报": "OSINT", "Skill 封装范式": "Skill パッケージング", "字幕工程": "字幕エンジニアリング", "短视频工作流": "ショート動画ワークフロー", "RAG 检索": "RAG 検索", "边缘部署": "エッジ配置", "工作流节点": "ワークフローノード", "音视频管线": "音声・動画パイプライン", "浏览器自动化": "ブラウザ自動化", "本地存储": "ローカルストレージ", "大模型接入": "LLM 連携", "Bot 交互": "Bot インタラクション", "向量检索": "ベクトル検索", "语音合成": "音声合成", "图像生成": "画像生成", "提示工程": "プロンプト設計", "工作流编排": "ワークフロー編成", "容器化部署": "コンテナ配置", "高性能系统": "高性能システム", "命令行工具": "CLI ツール", "端侧推理": "オンデバイス推論", "SQL 注入": "SQL インジェクション", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "CTF 大会", "开源情报 OSINT": "OSINT", "恶意代码分析": "マルウェア解析", "数字取证": "デジタルフォレンジック", "蓝队防御": "ブルーチーム防御", "代码审计": "コード監査", "内网渗透": "内部ネットワーク侵入", "权限提升": "権限昇格", "漏洞扫描": "脆弱性スキャン", "PoC 研究": "PoC 研究", "漏洞复盘": "脆弱性ライトアップ", "学习路线": "学習ロードマップ", "钓鱼防御演练": "フィッシング防御演習", "逆向工程": "リバースエンジニアリング", "模糊测试": "ファジング", "DevSecOps": "DevSecOps", "工程实现": "エンジニアリング実装"},
ko: { "MCP 协议接入": "MCP 연동", "Agent 架构": "Agent 아키텍처", "红队评估方法": "레드팀 평가", "漏洞管理": "취약점 관리", "SRC 众测思路": "버그 바운티 접근법", "开源情报": "OSINT", "Skill 封装范式": "Skill 패키징 패턴", "字幕工程": "자막 엔지니어링", "短视频工作流": "숏폼 워크플로", "RAG 检索": "RAG 검색", "边缘部署": "엣지 배포", "工作流节点": "워크플로 노드", "音视频管线": "오디오/비디오 파이프라인", "浏览器自动化": "브라우저 자동화", "本地存储": "로컬 스토리지", "大模型接入": "LLM 연동", "Bot 交互": "봇 상호작용", "向量检索": "벡터 검색", "语音合成": "음성 합성", "图像生成": "이미지 생성", "提示工程": "프롬프트 엔지니어링", "工作流编排": "워크플로 오케스트레이션", "容器化部署": "컨테이너 배포", "高性能系统": "고성능 시스템", "命令行工具": "CLI 도구", "端侧推理": "온디바이스 추론", "SQL 注入": "SQL 인젝션", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "CTF 대회", "开源情报 OSINT": "OSINT", "恶意代码分析": "악성코드 분석", "数字取证": "디지털 포렌식", "蓝队防御": "블루팀 방어", "代码审计": "코드 감사", "内网渗透": "내부망 침투", "权限提升": "권한 상승", "漏洞扫描": "취약점 스캔", "PoC 研究": "PoC 연구", "漏洞复盘": "취약점 라이트업", "学习路线": "학습 로드맵", "钓鱼防御演练": "피싱 방어 훈련", "逆向工程": "리버스 엔지니어링", "模糊测试": "퍼징", "DevSecOps": "DevSecOps", "工程实现": "엔지니어링 구현"},
es: { "MCP 协议接入": "Integración MCP", "Agent 架构": "Arquitectura de agentes", "红队评估方法": "Evaluación Red Team", "漏洞管理": "Gestión de vulnerabilidades", "SRC 众测思路": "Enfoque Bug Bounty", "开源情报": "OSINT", "Skill 封装范式": "Patrones de empaquetado Skill", "字幕工程": "Ingeniería de subtítulos", "短视频工作流": "Flujo de video corto", "RAG 检索": "Recuperación RAG", "边缘部署": "Despliegue Edge", "工作流节点": "Nodos de flujo", "音视频管线": "Pipeline de audio/video", "浏览器自动化": "Automatización del navegador", "本地存储": "Almacenamiento local", "大模型接入": "Integración LLM", "Bot 交互": "Interacción con bots", "向量检索": "Búsqueda vectorial", "语音合成": "Síntesis de voz", "图像生成": "Generación de imágenes", "提示工程": "Ingeniería de prompts", "工作流编排": "Orquestación de flujos", "容器化部署": "Despliegue en contenedores", "高性能系统": "Sistemas de alto rendimiento", "命令行工具": "Herramientas CLI", "端侧推理": "Inferencia en el dispositivo", "SQL 注入": "Inyección SQL", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "Competiciones CTF", "开源情报 OSINT": "OSINT", "恶意代码分析": "Análisis de malware", "数字取证": "Forense digital", "蓝队防御": "Defensa Blue Team", "代码审计": "Auditoría de código", "内网渗透": "Penetración de intranet", "权限提升": "Escalada de privilegios", "漏洞扫描": "Escaneo de vulnerabilidades", "PoC 研究": "Investigación PoC", "漏洞复盘": "Análisis de vulnerabilidades", "学习路线": "Ruta de aprendizaje", "钓鱼防御演练": "Simulacros antiphishing", "逆向工程": "Ingeniería inversa", "模糊测试": "Fuzzing", "DevSecOps": "DevSecOps", "工程实现": "Implementación de ingeniería"},
ar: { "MCP 协议接入": "تكامل MCP", "Agent 架构": "بنية الوكلاء", "红队评估方法": "تقييم الفريق الأحمر", "漏洞管理": "إدارة الثغرات", "SRC 众测思路": "منهج صيد الثغرات", "开源情报": "OSINT", "Skill 封装范式": "أنماط تغليف Skill", "字幕工程": "هندسة الترجمة المرئية", "短视频工作流": "سير عمل الفيديو القصير", "RAG 检索": "استرجاع RAG", "边缘部署": "النشر على الحافة", "工作流节点": "عقد سير العمل", "音视频管线": "خط أنابيب الصوت والفيديو", "浏览器自动化": "أتمتة المتصفح", "本地存储": "التخزين المحلي", "大模型接入": "تكامل النماذج اللغوية", "Bot 交互": "تفاعل البوتات", "向量检索": "البحث المتجهي", "语音合成": "توليف الكلام", "图像生成": "توليد الصور", "提示工程": "هندسة الأوامر", "工作流编排": "تنسيق سير العمل", "容器化部署": "النشر بالحاويات", "高性能系统": "أنظمة عالية الأداء", "命令行工具": "أدوات سطر الأوامر", "端侧推理": "الاستدلال على الجهاز", "SQL 注入": "حقن SQL", "XSS": "XSS", "SSRF": "SSRF", "RCE": "RCE", "CTF 竞赛": "مسابقات CTF", "开源情报 OSINT": "OSINT", "恶意代码分析": "تحليل البرمجيات الخبيثة", "数字取证": "الأدلة الجنائية الرقمية", "蓝队防御": "دفاع الفريق الأزرق", "代码审计": "تدقيق الكود", "内网渗透": "اختراق الشبكة الداخلية", "权限提升": "تصعيد الامتيازات", "漏洞扫描": "فحص الثغرات", "PoC 研究": "أبحاث PoC", "漏洞复盘": "مراجعات الثغرات", "学习路线": "خارطة التعلم", "钓鱼防御演练": "تدريبات الدفاع ضد التصيد", "逆向工程": "الهندسة العكسية", "模糊测试": "الاختبار العشوائي", "DevSecOps": "DevSecOps", "工程实现": "التحقيق الهندسي"},
};

function t(lang, key) {
const s = STRINGS[lang];
if (s && s[key] != null) return s[key];
return STRINGS.zh[key] != null? STRINGS.zh[key]: key;
}
function tpl(str, params) {
return String(str).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null)? String(params[k]): m);
}
// 语言解析：?lang=（合法值）> Cookie intel-lang > Accept-Language 首项基础语言 > zh；setCookie 表示本次是 ?lang= 指定的、需要回写 Cookie
function resolveLang(request) {
let lang = null, fromQuery = false;
try {
const q = new URL(request.url).searchParams.get("lang");
if (q && LANGS.includes(q)) { lang = q; fromQuery = true; }
} catch {}
if (!lang) {
const m = /(?:^|;\s*)intel-lang=([a-z]{2})(?:;|$)/.exec(request.headers.get("cookie") || "");
if (m && LANGS.includes(m[1])) lang = m[1];
}
if (!lang) {
const base = (request.headers.get("accept-language") || "").split(",")[0].trim().toLowerCase().split("-")[0];
if (LANGS.includes(base)) lang = base;
}
return { lang: lang || "zh", setCookie: fromQuery };
}
function langCookieValue(lang) {
return `intel-lang=${lang}; Path=/; Max-Age=2592000; SameSite=Lax`;
}
function channelName(key, lang) {
const c = CHANNEL_I18N[key];
return c? (c[lang] || c.zh): key;
}
function seedCatName(cat, lang) {
const c = SEED_CAT_I18N[cat];
return c? (c[lang] || c.zh): (SEED_CATS[cat] || cat);
}
// 标签渲染时翻译：数据层存的仍是中文标签；缺失条目回退中文原文；「<语言> 工程实践」兜底标签按后缀规则拼
function tagLabel(label, lang) {
if (!label) return "";
if (!lang || lang === "zh") return label;
const tbl = TAG_I18N[lang];
if (tbl && tbl[label]) return tbl[label];
const m = /^(.*) 工程实践$/.exec(label);
if (m) return m[1] + " " + t(lang, "tag_practice_suffix");
return label;
}
function fmtLoc(ts, lang) {
if (!ts) return "-";
if (!lang || lang === "zh") return fmtCST(ts);
try { return new Date(ts).toLocaleString(LANG_LOCALES[lang] || "zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }
catch { return fmtCST(ts); }
}
function fmtDateLoc(iso, lang) {
if (!iso) return "-";
if (!lang || lang === "zh") return fmtDateCST(iso);
try { return new Date(iso).toLocaleString(LANG_LOCALES[lang] || "zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }
catch { return fmtDateCST(iso); }
}
function verdictHead(lang, delta) {
if (typeof delta === "number" && delta > 0) return tpl(t(lang, "verdict_up"), { d: delta });
if (typeof delta === "number" && delta < 0) return tpl(t(lang, "verdict_down"), { d: delta });
if (typeof delta === "number") return t(lang, "verdict_flat");
return t(lang, "verdict_new");
}
function composeVerdict(p, lang) {
const point = tagLabel(p.point || "", lang);
return verdictHead(lang, typeof p.delta === "number"? p.delta: null) + (p.language? p.language + " ": "") + tpl(t(lang, "verdict_body"), { point });
}
// 一句话研判的渲染时拼装：zh 用记录里存的原文（与历史完全一致）；非 zh 有 verdictParts 时按模板拼，
// 旧记录没有 verdictParts 时用热度/增量/首标签拼一句本地化通用研判——绝不把中文模板句漏到非 zh 界面。
function renderVerdict(r, lang) {
if (!r) return "";
lang = lang && LANGS.includes(lang)? lang: "zh";
if (lang === "zh") {
if (r.verdict) return r.verdict;
if (r.verdictParts) return composeVerdict(r.verdictParts, "zh");
return "";
}
if (r.verdictParts) return composeVerdict(r.verdictParts, lang);
const topTag = (r.learnTags && r.learnTags[0])? tagLabel(r.learnTags[0], lang): "";
return verdictHead(lang, typeof r.starDelta === "number"? r.starDelta: null) + tpl(t(lang, "verdict_generic"), { heat: r.heat || 0, tag: topTag });
}

// ============================================================
// 【核心模块】总统简报生成 — 从当前情报数据提炼「总统简报」：态势一句话、飙升/热度 TOP3、网安与 Skill 焦点、重点监控动态（规则模板产出，非 AI）
// ============================================================
function briefRepo(r, lang) {
if (!r) return null;
return {
name: r.full_name,
url: r.html_url,
stars: r.stars || 0,
heat: r.heat || 0,
grade: r.grade || "B",
delta: typeof r.starDelta === "number"? r.starDelta: null,
verdict: renderVerdict(r, lang),
};
}
function secTagFreq(repos) {
const freq = {};
for (const r of repos) {
if (!(r.channels || []).some((c) => ["security", "src-hunt", "sec-learning"].includes(c))) continue;
for (const t of r.learnTags || []) freq[t] = (freq[t] || 0) + 1;
}
return freq;
}
// 【v5】话题聚合与趋势：aggregateTopics 把一轮仓库的 topics 聚合成 {topic:{n: 仓库数, s: 累计星标}}，只留累计星标前 40
function aggregateTopics(repos) {
const agg = {};
for (const r of repos || []) for (const t of r.topics || []) {
const e = agg[t] || (agg[t] = { n: 0, s: 0});
e.n++;
e.s += r.stars || 0;
}
const top = Object.entries(agg).sort((a, b) => b[1].s - a[1].s || b[1].n - a[1].n).slice(0, 40);
const out = {};
for (const [t, v] of top) out[t] = v;
return out;
}
// 趋势计算：与约 24 小时前（取时间上最接近的那个历史快照）比星标/仓库数增量；
// streak = 从最新快照往回数、累计星标连续严格递增的轮数（含本轮）。只返回 24h 星标增量为正的前 5 个话题
function computeTrendingTopics(topicHist) {
if (!Array.isArray(topicHist) || topicHist.length < 2) return [];
const cur = topicHist[topicHist.length - 1];
const target = cur.ts - 86400000;
let base = null, bestDiff = Infinity;
for (let i = 0; i < topicHist.length - 1; i++) {
const d = Math.abs(topicHist[i].ts - target);
if (d < bestDiff) { bestDiff = d; base = topicHist[i]; }
}
if (!base) return [];
const starsAt = (snap, t) => (snap.topics && snap.topics[t])? snap.topics[t].s: 0;
const out = [];
for (const [topic, v] of Object.entries(cur.topics || {})) {
const old = (base.topics && base.topics[topic]) || { n: 0, s: 0};
const dStars = v.s - old.s;
if (dStars <= 0) continue;
let streak = 0;
for (let i = topicHist.length - 1; i >= 1; i--) {
if (starsAt(topicHist[i], topic) > starsAt(topicHist[i - 1], topic)) streak++;
else break;
}
out.push({ topic, dStars24h: dStars, dCount24h: v.n - old.n, streak});
}
return out.sort((a, b) => b.dStars24h - a.dStars24h).slice(0, 5);
}
function buildBrief(repos, meta, seedIds, seedLive, topicHist, lang) {
lang = lang && LANGS.includes(lang)? lang: "zh";
repos = Array.isArray(repos)? repos: [];
const byDelta = repos.filter((r) => typeof r.starDelta === "number").sort((a, b) => b.starDelta - a.starDelta).slice(0, 3);
const byHeat = [...repos].sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 3);
const secRepos = repos.filter((r) => (r.channels || []).some((c) => ["security", "src-hunt"].includes(c)))
.sort((a, b) => (b.heat || 0) - (a.heat || 0));
const topSecTags = Object.entries(secTagFreq(repos)).sort((a, b) => b[1] - a[1]).slice(0, 3)
.map(([tag, count]) => ({ tag: tagLabel(tag, lang), count}));
const skillTop = repos.filter((r) => (r.channels || []).includes("skills"))
.sort((a, b) => (b.heat || 0) - (a.heat || 0))[0] || null;
const wl = buildWatchlist(repos, seedIds, seedLive);
const liveSeeds = wl.filter((w) => w.live);
// 改名动态：优先从仓库记录的 renamedFrom 还原，其次用巡检 meta 里记录的改名事件
let renames = repos.filter((r) => r.renamedFrom).map((r) => ({ from: r.renamedFrom, to: r.full_name, stars: r.stars}));
if (!renames.length && meta && Array.isArray(meta.renames)) renames = meta.renames;
// 关键词热度：聚合本轮全部仓库的 topics（出现仓库数 + 累计星标），取前 5
const topicAgg = {};
for (const r of repos) for (const t of r.topics || []) {
const e = topicAgg[t] || (topicAgg[t] = { topic: t, count: 0, stars: 0});
e.count++; e.stars += r.stars || 0;
}
const topTopics = Object.values(topicAgg).sort((a, b) => b.count - a.count || b.stars - a.stars).slice(0, 5);
const topSeed = [...liveSeeds].sort((a, b) => (b.live.stars || 0) - (a.live.stars || 0))[0] || null;
const newCount = meta? meta.newCount || 0: 0;
const chOk = meta && meta.channelsOk != null? meta.channelsOk: null;
const chTotal = meta && meta.channelsTotal != null? meta.channelsTotal: buildChannels().length;
let oneliner;
if (!repos.length) {
oneliner = t(lang, "oneliner_empty");
} else {
const joiner = lang === "zh"? "、": ", ";
const p1 = tpl(t(lang, "oneliner_p1"), { n: repos.length, new: newCount, ok: chOk == null? "-": chOk, total: chTotal});
const p2 = byDelta.length && byDelta[0].starDelta > 0
? tpl(t(lang, "oneliner_surge"), { name: byDelta[0].full_name, d: byDelta[0].starDelta})
: byHeat.length? tpl(t(lang, "oneliner_heat"), { name: byHeat[0].full_name, heat: byHeat[0].heat || 0}): "";
const p3 = secRepos.length
? tpl(t(lang, "oneliner_sec"), { name: secRepos[0].full_name}) + (topSecTags.length? tpl(t(lang, "oneliner_sec_tags"), { tags: topSecTags.map((x) => x.tag).join(joiner)}): "") + t(lang, "oneliner_end"): "";
oneliner = p1 + p2 + p3;
}
return {
lang,
date: fmtLoc(Date.now(), lang),
timeCST: new Date().toLocaleTimeString(LANG_LOCALES[lang], { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit"}),
totals: { repos: repos.length, newCount, channelsOk: chOk, channelsTotal: chTotal},
topSurging: byDelta.map((r) => briefRepo(r, lang)),
topHeat: byHeat.map((r) => briefRepo(r, lang)),
securityFocus: { top: briefRepo(secRepos[0] || null, lang), topTags: topSecTags},
skillsFocus: briefRepo(skillTop, lang),
watchlistLive: {
liveCount: liveSeeds.length,
total: wl.length,
top: topSeed? { name: topSeed.name, url: topSeed.url, stars: topSeed.live.stars}: null,
},
renames,
topTopics,
trendingTopics: computeTrendingTopics(topicHist),
oneliner,
};
}
async function loadBrief(env, lang) {
const latest = await loadJSON(env, CONFIG.kvLatest, null);
const meta = await loadJSON(env, CONFIG.kvMeta, null);
const seedIds = (await loadJSON(env, CONFIG.kvSeedIds, {})) || {};
const seedLive = (await loadJSON(env, CONFIG.kvSeedLive, {})) || {};
const topicHist = (await loadJSON(env, CONFIG.kvTopicHist, [])) || [];
const repos = latest && Array.isArray(latest.repos)? latest.repos: [];
return buildBrief(repos, meta, seedIds, seedLive, topicHist, lang);
}
function briefLine(r, suffix, lang) {
lang = lang && LANGS.includes(lang)? lang: "zh";
if (!r) return `<div class="bline muted">${esc(t(lang, "nodata"))}</div>`;
return `<div class="bline"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="bmeta">${esc(tpl(t(lang, "brief_meta"), { stars: r.stars, heat: r.heat}))}${suffix || ""}</span><div class="bverdict">${esc(r.verdict)}</div></div>`;
}
function renderBriefHtml(b) {
const lang = b && b.lang && LANGS.includes(b.lang)? b.lang: "zh";
const deltaSuffix = (r) => typeof r.delta === "number"? esc(tpl(t(lang, "brief_delta"), { sd: (r.delta >= 0? "+": "") + r.delta})): "";
const surge = b.topSurging.length? b.topSurging.map((r) => briefLine(r, deltaSuffix(r), lang)).join(""): `<div class="bline muted">${esc(t(lang, "brief_nodata_delta"))}</div>`;
const heat = b.topHeat.length? b.topHeat.map((r) => briefLine(r, "", lang)).join(""): `<div class="bline muted">${esc(t(lang, "nodata"))}</div>`;
const secTop = b.securityFocus.top? briefLine(b.securityFocus.top, "", lang): `<div class="bline muted">${esc(t(lang, "brief_no_sec"))}</div>`;
const secTags = b.securityFocus.topTags.length? `<div class="bline">${esc(t(lang, "brief_hot_tags"))}${b.securityFocus.topTags.map((x) => esc(x.tag) + " ×" + x.count).join(" · ")}</div>`: "";
const skill = b.skillsFocus? briefLine(b.skillsFocus, "", lang): `<div class="bline muted">${esc(t(lang, "brief_no_skill"))}</div>`;
const wl = `<div class="bline">${tpl(t(lang, "brief_wl_line"), { live: b.watchlistLive.liveCount, total: b.watchlistLive.total})}</div>` +
(b.watchlistLive.top? `<div class="bline">${esc(t(lang, "brief_wl_top"))}<a href="${esc(b.watchlistLive.top.url)}" target="_blank" rel="noopener">${esc(b.watchlistLive.top.name)}</a> <span class="bmeta">★ ${b.watchlistLive.top.stars}</span></div>`: "");
const topicsLine = (b.topTopics && b.topTopics.length)? `<div class="bline">${esc(t(lang, "brief_topics_label"))}${b.topTopics.map((x) => esc(tpl(t(lang, "brief_topic_item"), { topic: x.topic, count: x.count, stars: x.stars}))).join(" · ")}</div>`: "";
const trendHtml = (b.trendingTopics && b.trendingTopics.length)? `<h4>${esc(t(lang, "brief_trend_t"))}</h4>` + b.trendingTopics.map((x) => `<div class="bline">${esc(x.topic)} <span class="bmeta">${esc(tpl(t(lang, "trend_fmt"), { d: x.dStars24h, n: x.streak}))}</span></div>`).join(""): "";
const renameHtml = (b.renames && b.renames.length)? `<h4>${esc(t(lang, "brief_rename_t"))}</h4>` + b.renames.map((r) => `<div class="bline">${esc(tpl(t(lang, "brief_rename_line"), { from: r.from}))}<a href="https://github.com/${esc(r.to)}" target="_blank" rel="noopener">${esc(r.to)}</a> <span class="bmeta">★ ${r.stars}</span></div>`).join(""): "";
return `<h4>${esc(t(lang, "brief_situation"))}</h4><p class="boneliner">${esc(b.oneliner)}</p>${topicsLine}
${trendHtml}<h4>${esc(t(lang, "brief_surge_t"))}</h4>${surge}
<h4>${esc(t(lang, "brief_heat_t"))}</h4>${heat}
<h4>${esc(t(lang, "brief_sec_t"))}</h4>${secTop}${secTags}
<h4>${esc(t(lang, "brief_skill_t"))}</h4>${skill}
${renameHtml}<h4>${esc(t(lang, "brief_wl_t"))}</h4>${wl}`;
}

// ============================================================
// 【核心模块】情报面板 — 暗色情报中心风格：跑马灯/KPI/飙升榜/专区/全部情报（可筛选可搜索）
// ============================================================
function repoCard(r, rank, lang) {
lang = lang && LANGS.includes(lang)? lang: "zh";
const delta = typeof r.starDelta === "number"
? `<span class="delta ${r.starDelta >= 0? "up": "down"}">${esc(tpl(t(lang, "delta_fmt"), { sd: (r.starDelta >= 0? "+": "") + r.starDelta}))}</span>`: "";
const tags = (r.learnTags || []).map((tg) => `<button type="button" class="tag tagchip" data-tag="${esc(tg)}" data-taglabel="${esc(tagLabel(tg, lang))}" title="${esc(t(lang, "tag_title"))}">${esc(tagLabel(tg, lang))}</button>`).join("");
const chans = (r.channels || []).join(" ");
const rankHtml = rank? `<span class="rank">#${rank}</span>`: "";
return `<article class="card" data-channels="${esc(chans)}" data-grade="${esc(r.grade || "B")}" data-tags="${esc((r.learnTags || []).join("|"))}" data-name="${esc((r.full_name + " " + (r.description || "")).toLowerCase())}">
<div class="chead"><span>${rankHtml}<a class="rname" href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a></span><span class="grade g${esc(r.grade || "B")}">${esc(tpl(t(lang, "grade_card_fmt"), { g: r.grade || "B"}))}</span></div>
<p class="desc">${esc(r.description || t(lang, "no_desc"))}</p>
<div class="meta">★ ${r.stars} · ⑂ ${r.forks}${r.language? " · " + esc(r.language): ""}${r.license? " · " + esc(r.license): ""} ${delta}</div>
<div class="heatbar"><div class="heatfill" style="width:${r.heat || 0}%"></div></div>
<div class="meta">${esc(tpl(t(lang, "heat_line"), { heat: r.heat || 0, date: fmtDateLoc(r.pushed_at, lang)}))}</div>
<div class="tags">${tags}</div>
<p class="verdict">${esc(t(lang, "verdict_prefix"))}${esc(renderVerdict(r, lang))}</p>
</article>`;
}

async function renderPanel(env, lang) {
lang = lang && LANGS.includes(lang)? lang: "zh";
const latest = await loadJSON(env, CONFIG.kvLatest, null);
const meta = await loadJSON(env, CONFIG.kvMeta, null);
const repos = latest && Array.isArray(latest.repos)? latest.repos: [];
const channels = buildChannels();

const surgeList = [...repos].sort((a, b) => {
const da = typeof a.starDelta === "number"? a.starDelta: -1;
const db = typeof b.starDelta === "number"? b.starDelta: -1;
return db!== da? db - da: b.heat - a.heat;
}).slice(0, 10);
const newStars = repos.filter((r) => r.channels.includes("surge")).slice(0, 10);
const aiList = repos.filter((r) => r.channels.includes("ai-agent")).slice(0, 10);
const secList = repos.filter((r) => r.channels.includes("security")).slice(0, 10);
const skillList = repos.filter((r) => r.channels.includes("skills")).slice(0, 10);
const creatorList = repos.filter((r) => r.channels.includes("creator")).slice(0, 10);
const srcList = repos.filter((r) => r.channels.includes("src-hunt")).slice(0, 10);
const secLearnList = repos.filter((r) => r.channels.includes("sec-learning")).slice(0, 10);
// 热门标签云：统计安全三通道（security/src-hunt/sec-learning）仓库的标签频次，取前 15
const tagFreq = secTagFreq(repos);
const tagCloud = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 15)
.map(([tag, n]) => `<button type="button" class="tag tagchip cloudchip" data-tag="${esc(tag)}" data-taglabel="${esc(tagLabel(tag, lang))}" title="${esc(t(lang, "tag_title"))}">${esc(tagLabel(tag, lang))} · ${n}</button>`).join("");
// 全部情报分页：每页 24 条（与 DEAL HUB 约定一致），服务端先渲染初始页码按钮，筛选后由前端重算
const PAGE_SIZE_SSR = 24;
const totalPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE_SSR));
const pagerBtns = (() => {
const pages = [];
if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) pages.push(i); }
else pages.push(1, 2, "…", totalPages - 1, totalPages);
return pages.map((p) => p === "…"? `<span class="pgdots">…</span>`: `<button class="fbtn pgnum${p === 1? " on": ""}" data-page="${p}">${p}</button>`).join("");
})();
const seedIds = (await loadJSON(env, CONFIG.kvSeedIds, {})) || {};
const seedLive = (await loadJSON(env, CONFIG.kvSeedLive, {})) || {};
const topicHist = (await loadJSON(env, CONFIG.kvTopicHist, [])) || {};
const watchlist = buildWatchlist(repos, seedIds, seedLive);
const brief = buildBrief(repos, meta, seedIds, seedLive, topicHist, lang);
// 【v5】话题趋势行：紧贴热门标签云下方，一行纯文本 chip（非链接），历史不足两轮时不渲染
const trending = brief.trendingTopics || [];
const trendLine = trending.length? `<div class="tagrow"><span class="taglabel">${esc(t(lang, "trend_label"))}</span>${trending.map((x) => `<span class="tag">${esc(x.topic)} ${esc(tpl(t(lang, "trend_fmt"), { d: x.dStars24h, n: x.streak}))}</span>`).join("")}</div>`: "";
const showMoreBtn = (gid, n) => n > 6? `<button class="btn showmore" type="button" data-showmore="${gid}" data-label="${esc(tpl(t(lang, "show_more"), { n}))}">${esc(tpl(t(lang, "show_more"), { n}))}</button>`: "";
const topHeat = repos.length? Math.max(...repos.map((r) => r.heat || 0)): 0;
const newCount = meta? meta.newCount || 0: 0;

// 重点监控种子卡：按分类分组渲染，命中巡检数据的带实时 ★/热度/增量徽章
const seedGroups = [...new Set(SEEDS.map((s) => s.cat))].map((cat) => {
const items = watchlist.filter((w) => w.cat === cat);
const cards = items.map((w) => {
let live;
if (w.live) {
live = `<div class="meta">${esc(tpl(t(lang, "seed_live"), { stars: w.live.stars, heat: w.live.heat, grade: tpl(t(lang, "grade_card_fmt"), { g: w.live.grade || "B"})}))}${typeof w.live.starDelta === "number"? ` · <span class="delta ${w.live.starDelta >= 0? "up": "down"}">${esc(tpl(t(lang, "delta_fmt"), { sd: (w.live.starDelta >= 0? "+": "") + w.live.starDelta}))}</span>`: ""}</div>`;
} else if (w.refreshed) {
live = `<div class="meta">★ ${w.refreshed.stars} · ⑂ ${w.refreshed.forks} · <span class="delta up">${esc(t(lang, "seed_refreshed"))}</span> ${esc(fmtLoc(w.refreshed.ts, lang))}${w.renamedFrom? ` · <span class="delta down">${esc(tpl(t(lang, "seed_renamed"), { name: w.renamedFrom}))}</span>`: ""}</div>`;
} else if (w.gone) {
live = `<div class="meta">${esc(tpl(t(lang, "seed_gone"), { ts: fmtLoc(w.goneTs, lang)}))}</div>`;
} else {
live = `<div class="meta">${esc(t(lang, "seed_static"))}</div>`;
}
return `<article class="card seed"><div class="chead"><a class="rname" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)}</a><span class="tag">${esc(seedCatName(w.cat, lang))}</span></div>
<p class="desc">${esc(t(lang, "seed_note"))}${esc(w.note)}</p>${live}</article>`;
}).join("");
return `<h3 class="seedcat">${esc(tpl(t(lang, "seed_group_fmt"), { cat: seedCatName(cat, lang), n: items.length}))}</h3><div class="grid">${cards}</div>`;
}).join("");

const tickerText = meta
? tpl(t(lang, "ticker_full"), { ts: fmtLoc(meta.ts, lang), n: repos.length, new: newCount, ok: meta.channelsOk?? "-", total: meta.channelsTotal?? channels.length}) + (Object.keys(meta.errors || {}).length? tpl(t(lang, "ticker_err"), { list: Object.keys(meta.errors).join(",")}): "") + t(lang, "ticker_src")
: t(lang, "ticker_none");

const empty = repos.length === 0
? `<div class="empty">${t(lang, "empty_text")}<br><br><button class="btn" onclick="doRefresh(this)">${esc(t(lang, "empty_btn"))}</button> <span class="rmsg"></span></div>`: "";

const filterBtns = [`<button class="fbtn on" data-filter="all">${esc(t(lang, "filter_all"))}</button>`]
.concat(channels.map((c) => `<button class="fbtn" data-filter="${c.key}">${esc(channelName(c.key, lang))}</button>`)).join("");

const html = `<!doctype html><html lang="${LANG_HTML[lang]}"${lang === "ar"? ' dir="rtl"': ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t(lang, "doc_title"))}</title><style>
*{box-sizing:border-box}body{margin:0;background:#0a0e12;color:#c9f7d4;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
background-image:linear-gradient(rgba(0,255,170,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,170,.04) 1px,transparent 1px);background-size:36px 36px}
body:after{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.015) 0 1px,transparent 1px 3px)}
.wrap{max-width:1180px;margin:0 auto;padding:22px 16px 70px}
h1{font-size:26px;letter-spacing:2px;color:#4ade80;text-shadow:0 0 14px rgba(74,222,128,.55);margin:0}
.sub{color:#67e8f9;letter-spacing:3px;font-size:12px;margin-top:4px}
.ticker{margin:16px 0;border:1px solid #134e4a;background:#0d1512;overflow:hidden;white-space:nowrap;padding:8px 0;color:#a7f3d0;font-size:13px}
.ticker span{display:inline-block;padding-left:100%;animation:tick 38s linear infinite}
@keyframes tick{to{transform:translateX(-100%)}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:14px 0}
.kpi{border:1px solid #14532d;background:rgba(10,20,14,.85);padding:14px;border-radius:6px}
.kpi b{display:block;font-size:28px;color:#4ade80;text-shadow:0 0 10px rgba(74,222,128,.5)}
.kpi span{color:#86efac;font-size:12px;letter-spacing:2px}
h2{color:#67e8f9;letter-spacing:2px;font-size:18px;text-shadow:0 0 10px rgba(103,232,249,.45);border-bottom:1px solid #164e63;padding-bottom:6px;margin:28px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{border:1px solid #14532d;background:rgba(8,16,12,.92);border-radius:6px;padding:14px;transition:box-shadow .25s,border-color .25s,transform .25s}
.card:hover{border-color:#22c55e;box-shadow:0 0 18px rgba(74,222,128,.28),0 0 42px rgba(103,232,249,.10);transform:translateY(-2px)}
.rank{color:#0a0e12;background:#4ade80;border-radius:4px;font-weight:700;padding:0 6px;margin-right:7px;font-size:12px}
.stickyhead{position:sticky;top:0;z-index:50;background:rgba(10,14,18,.97);backdrop-filter:blur(7px);border-bottom:1px solid #14532d;padding:10px 0 12px;margin-bottom:6px}
.stickyhead.collapsed{padding-bottom:6px}
.stickyhead.collapsed .tagrow,.stickyhead.collapsed .filterbar{display:none}
#head-toggle{margin-top:6px}
.topbar{padding-bottom:2px}
.toprow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.clockbox{text-align:right;color:#67e8f9;font-size:13px;line-height:1.6}
.clockbox b{color:#4ade80;font-size:17px;text-shadow:0 0 9px rgba(74,222,128,.55)}
.filterbar{padding:8px 0 2px;border-top:1px dashed #14532d;margin-top:8px}
.seedcat{color:#facc15;letter-spacing:1px;font-size:15px;margin:18px 0 10px;text-shadow:0 0 8px rgba(250,204,21,.35)}
.card.seed{border-color:#3f6212}
.chead{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.rname{color:#4ade80;font-weight:700;text-decoration:none;word-break:break-all}.rname:hover{text-decoration:underline}
.grade{border:1px solid #4ade80;color:#4ade80;border-radius:4px;padding:0 7px;font-weight:700}
.gS{border-color:#facc15;color:#facc15;text-shadow:0 0 8px rgba(250,204,21,.6)}
.desc{color:#d1fae5;font-size:13px;line-height:1.55;min-height:38px}
.meta{color:#6ee7b7;font-size:12px;margin:6px 0}
.delta.up{color:#4ade80;border:1px solid #14532d;padding:0 6px;border-radius:4px}
.delta.down{color:#f87171;border:1px solid #7f1d1d;padding:0 6px;border-radius:4px}
.heatbar{height:6px;background:#12241a;border-radius:3px;overflow:hidden}
.heatfill{height:100%;background:linear-gradient(90deg,#22c55e,#67e8f9);box-shadow:0 0 8px rgba(103,232,249,.7);animation:fillin 1.1s ease-out}
@keyframes fillin{from{width:0}}
.tags{margin:8px 0}.tag{display:inline-block;border:1px solid #0e7490;color:#67e8f9;border-radius:999px;padding:1px 9px;font-size:12px;margin:0 5px 5px 0}
button.tag{font-family:inherit;background:transparent}
.tagchip{cursor:pointer;transition:background .2s,box-shadow .2s}.tagchip:hover{background:#164e63;box-shadow:0 0 9px rgba(103,232,249,.45)}
.cloudchip{font-size:13px;padding:3px 12px}
.tagcloud{margin:0 0 14px;line-height:2}
.tagrow{margin:2px 0 8px;line-height:2.1;padding:6px 8px;border:1px dashed #14532d;background:rgba(20,83,45,.12)}
.tagrow .taglabel{color:#4ade80;font-weight:700;margin-right:8px;letter-spacing:1px;white-space:nowrap}
.tagpill{display:inline-block;border:1px dashed #facc15;color:#fef08a;border-radius:6px;padding:4px 10px;font-size:13px;margin-left:8px}
.pager{margin:18px 0 6px;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.pgdots{color:#5f7a68;padding:0 4px}
.fbtn:disabled{opacity:.35;cursor:default}
.verdict{color:#fef08a;font-size:13px;line-height:1.55;border-left:3px solid #facc15;padding-left:9px}
.btn,.fbtn{background:#052e16;color:#4ade80;border:1px solid #22c55e;border-radius:6px;padding:8px 14px;cursor:pointer;font-family:inherit;font-size:13px;margin:0 6px 8px 0}
.btn:hover,.fbtn:hover{background:#14532d}.fbtn.on{background:#22c55e;color:#04120a;font-weight:700}
input[type=search]{background:#04120a;border:1px solid #14532d;color:#c9f7d4;border-radius:6px;padding:8px 10px;font-family:inherit;min-width:230px}
.empty{border:1px dashed #14532d;padding:22px;color:#a7f3d0;line-height:1.7;border-radius:6px}
.muted{color:#5f7a68;font-size:12px;line-height:1.7}
a{color:#67e8f9}
h2.sechead{cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none}
h2.sechead:hover{color:#a5f3fc}
.ctog{color:#4ade80;font-size:14px;text-shadow:0 0 8px rgba(74,222,128,.6)}
.secbody{animation:secin .25s ease}
.secbody.hide{display:none}
@keyframes secin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.grid.clipped .card:nth-child(n+7){display:none}
.showmore{margin:0 0 12px}
.pager.prominent{border:1px solid #22c55e;background:rgba(20,83,45,.30);border-radius:6px;padding:10px 12px;box-shadow:0 0 14px rgba(74,222,128,.18)}
#brief-fab{position:fixed;right:18px;bottom:18px;z-index:60;background:#052e16;color:#4ade80;border:1px solid #22c55e;border-radius:999px;padding:11px 18px;font-family:inherit;font-size:14px;cursor:pointer;box-shadow:0 0 16px rgba(74,222,128,.35)}
#brief-fab:hover{background:#14532d}
#brief-panel{position:fixed;right:18px;bottom:74px;width:380px;max-width:92vw;max-height:70vh;overflow-y:auto;z-index:61;background:rgba(6,14,10,.97);border:1px solid #22c55e;border-radius:8px;box-shadow:0 0 24px rgba(74,222,128,.35),0 0 60px rgba(103,232,249,.12);font-size:13px}
#brief-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #14532d;cursor:grab;touch-action:none;color:#4ade80;font-weight:700;letter-spacing:1px;position:sticky;top:0;background:rgba(6,14,10,.97);z-index:2}
#brief-head:active{cursor:grabbing}
#brief-head button{background:#052e16;color:#4ade80;border:1px solid #22c55e;border-radius:4px;cursor:pointer;font-family:inherit;padding:1px 9px;margin-left:5px}
#brief-body{padding:10px 14px}
#brief-body h4{color:#67e8f9;margin:12px 0 6px;letter-spacing:1px;font-size:13px}
#brief-body h4:first-child{margin-top:2px}
.boneliner{color:#d1fae5;line-height:1.65;margin:4px 0}
.bline{margin:6px 0;line-height:1.55;color:#d1fae5}
.bline a{color:#4ade80;font-weight:700;text-decoration:none;word-break:break-all}
.bline a:hover{text-decoration:underline}
.bmeta{color:#6ee7b7;font-size:12px}
.bverdict{color:#fef08a;font-size:12px;line-height:1.5}
.brief-foot{padding:8px 14px;border-top:1px dashed #14532d;color:#5f7a68;font-size:12px}
.langbar{margin-top:7px;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.langbar a{color:#4ade80;border:1px solid #14532d;border-radius:4px;padding:1px 7px;text-decoration:none;font-size:12px}
.langbar a:hover{border-color:#22c55e}
.langbar a.on{background:#22c55e;color:#04120a;font-weight:700}
html[dir="rtl"].verdict{border-left:none;border-right:3px solid #facc15;padding-left:0;padding-right:9px}
@media (max-width:520px){#brief-panel{width:92vw}}
</style></head><body><div class="wrap">
<div class="stickyhead">
<div class="topbar"><div class="toprow">
<div><h1>${esc(t(lang, "h1"))}</h1><div class="sub">${esc(t(lang, "tagline"))}</div></div>
<div class="clockbox"><div>${esc(t(lang, "clock_label"))} <b id="clock">--:--:--</b></div><div>${esc(t(lang, "status_label"))}${meta? (meta.ok? esc(t(lang, "status_ok")): esc(t(lang, "status_warn"))) + " · " + esc(fmtLoc(meta.ts, lang)): esc(t(lang, "status_none"))}${esc(tpl(t(lang, "channels_part"), { ok: meta? (meta.channelsOk?? "-"): "-", total: channels.length}))}</div><button class="fbtn" id="head-toggle" type="button">${esc(t(lang, "toggle_collapse"))}</button><div class="langbar">${LANGS.map((l) => `<a href="/?lang=${l}"${l === lang? ' class="on"': ""}>${LANG_SHORT[l]}</a>`).join("")}</div></div>
</div></div>
<div class="tagrow" id="tag-cloud"><span class="taglabel">${esc(t(lang, "tagcloud_label"))}</span>${tagCloud || `<span class="muted">${esc(t(lang, "tagcloud_empty"))}</span>`}</div>
<div class="filterbar"><div>${filterBtns}</div>
<div><button class="fbtn on" data-gf="all">${esc(t(lang, "grade_all"))}</button><button class="fbtn" data-gf="S">${esc(tpl(t(lang, "grade_btn_fmt"), { g: "S"}))}</button><button class="fbtn" data-gf="A">${esc(tpl(t(lang, "grade_btn_fmt"), { g: "A"}))}</button><button class="fbtn" data-gf="B">${esc(tpl(t(lang, "grade_btn_fmt"), { g: "B"}))}</button><input type="search" id="q" placeholder="${esc(t(lang, "search_ph"))}"><span class="muted" id="shown"></span><span id="tag-pill" class="tagpill" style="display:none">${esc(t(lang, "pill_label"))}<b id="tag-name"></b> <button class="fbtn" id="tag-clear" type="button">${esc(t(lang, "pill_clear"))}</button></span></div><div style="margin-top:6px"><button class="fbtn" id="btn-expand-all" type="button">${esc(t(lang, "expand_all"))}</button><button class="fbtn" id="btn-collapse-all" type="button">${esc(t(lang, "collapse_all"))}</button></div></div>
</div>
<div class="ticker"><span>${esc(tickerText)} &nbsp;///&nbsp; ${esc(tickerText)}</span></div>
<div class="kpis">
<div class="kpi"><span>${esc(t(lang, "kpi_repos"))}</span><b>${repos.length}</b></div>
<div class="kpi"><span>${esc(t(lang, "kpi_new"))}</span><b>${newCount}</b></div>
<div class="kpi"><span>${esc(t(lang, "kpi_heat"))}</span><b>${topHeat}</b></div>
<div class="kpi"><span>${esc(t(lang, "kpi_channels"))}</span><b>${channels.length}</b></div>
<div class="kpi"><span>${esc(t(lang, "kpi_seeds"))}</span><b>${SEEDS.length}</b></div>
<div class="kpi"><span>${esc(t(lang, "kpi_last"))}</span><b style="font-size:15px;padding-top:8px">${meta? esc(fmtLoc(meta.ts, lang)): "-"}</b></div>
</div>
<div>
<button class="btn" onclick="doRefresh(this)">${esc(t(lang, "refresh_btn"))}</button> <span class="rmsg muted"></span>
<a class="btn" href="/api/repos" style="text-decoration:none">/api/repos</a>
<a class="btn" href="/api/stats" style="text-decoration:none">/api/stats</a>
</div>
${empty}
<h2>${esc(t(lang, "overview_title"))}</h2>
<p class="muted">${esc(t(lang, "overview_para"))}</p>
${trendLine}
<h2 class="sechead" data-collapse="sec-surge"><span>${esc(t(lang, "sec_surge"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-surge"><div class="grid showcase${surgeList.length > 6? " clipped": ""}" id="g-surge">${surgeList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-surge", surgeList.length)}</div>
<h2 class="sechead" data-collapse="sec-newstars"><span>${esc(t(lang, "sec_newstars"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-newstars"><div class="grid showcase${newStars.length > 6? " clipped": ""}" id="g-newstars">${newStars.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-newstars", newStars.length)}</div>
<h2 class="sechead" data-collapse="sec-ai"><span>${esc(t(lang, "sec_ai"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-ai"><div class="grid showcase${aiList.length > 6? " clipped": ""}" id="g-ai">${aiList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-ai", aiList.length)}</div>
<h2 class="sechead" data-collapse="sec-security"><span>${esc(t(lang, "sec_security"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-security">
<div class="grid showcase${secList.length > 6? " clipped": ""}" id="g-sec">${secList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-sec", secList.length)}</div>
<h2 class="sechead" data-collapse="sec-src"><span>${esc(t(lang, "sec_src"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-src"><div class="grid showcase${srcList.length > 6? " clipped": ""}" id="g-src">${srcList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-src", srcList.length)}</div>
<h2 class="sechead" data-collapse="sec-seclearn"><span>${esc(t(lang, "sec_seclearn"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-seclearn"><div class="grid showcase${secLearnList.length > 6? " clipped": ""}" id="g-seclearn">${secLearnList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-seclearn", secLearnList.length)}</div>
<h2 class="sechead" data-collapse="sec-skills"><span>${esc(t(lang, "sec_skills"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-skills"><div class="grid showcase${skillList.length > 6? " clipped": ""}" id="g-skills">${skillList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-skills", skillList.length)}</div>
<h2 class="sechead" data-collapse="sec-creator"><span>${esc(t(lang, "sec_creator"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-creator"><div class="grid showcase${creatorList.length > 6? " clipped": ""}" id="g-creator">${creatorList.map((r, i) => repoCard(r, i + 1, lang)).join("") || ('<p class="muted">' + esc(t(lang, "nodata")) + '</p>')}</div>${showMoreBtn("g-creator", creatorList.length)}</div>
<h2 class="sechead" data-collapse="sec-watchlist"><span>${esc(t(lang, "sec_watchlist"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-watchlist">
<p class="muted">${esc(t(lang, "watchlist_para"))}</p>
${seedGroups}
</div>
<h2 id="all-intel" class="sechead" data-collapse="sec-all"><span>${esc(t(lang, "sec_all"))}</span><span class="ctog">▼</span></h2>
<div class="secbody" id="sec-all">
<div class="pager prominent" id="pager-top"><button class="fbtn pg-prev" type="button">${esc(t(lang, "pager_prev"))}</button><span class="pg-nums">${pagerBtns}</span><button class="fbtn pg-next" type="button">${esc(t(lang, "pager_next"))}</button><span class="muted pg-status"></span></div>
<div class="grid" id="all-grid">${repos.map((r, i) => repoCard(r, i + 1, lang)).join("")}</div>
<div class="pager prominent" id="pager-bottom"><button class="fbtn pg-prev" type="button">${esc(t(lang, "pager_prev"))}</button><span class="pg-nums">${pagerBtns}</span><button class="fbtn pg-next" type="button">${esc(t(lang, "pager_next"))}</button><span class="muted pg-status"></span></div>
<p class="muted">${esc(t(lang, "all_foot"))}</p>
</div>
</div>
<button id="brief-fab" type="button">${esc(t(lang, "brief_fab"))}</button>
<div id="brief-panel" style="display:none">
<div id="brief-head"><span>${esc(t(lang, "brief_head"))}</span><span><button id="brief-min" type="button" title="${esc(t(lang, "brief_min"))}">—</button><button id="brief-close" type="button" title="${esc(t(lang, "brief_close"))}">✕</button></span></div>
<div id="brief-body">${renderBriefHtml(brief)}</div>
<div class="brief-foot">${esc(tpl(t(lang, "brief_foot"), { time: brief.timeCST}))}</div>
</div>
<script type="application/json" id="brief-data">${JSON.stringify(brief).replace(/</g, "\\u003c")}</script>
<script>var I18N=${JSON.stringify({ refreshing: t(lang, "js_refreshing"), throttled: t(lang, "js_throttled"), fail: t(lang, "js_fail"), expand: t(lang, "toggle_expand"), collapse: t(lang, "toggle_collapse"), pager: t(lang, "js_pager"), shown: t(lang, "js_shown"), showLess: t(lang, "show_less"), locale: LANG_LOCALES[lang]}).replace(/</g, "\\u003c")};</script>
<script>
function doRefresh(btn){
var msg=document.querySelector(".rmsg"); if(msg) msg.textContent=I18N.refreshing;
if(btn) btn.disabled=true;
fetch("/api/refresh",{method:"POST"}).then(function(r){return r.json()}).then(function(j){
if(j.throttled){ if(msg) msg.textContent=I18N.throttled; if(btn) btn.disabled=false; return;}
location.reload();
}).catch(function(e){ if(msg) msg.textContent=I18N.fail+e; if(btn) btn.disabled=false;});
}
function tickClock(){ var el=document.getElementById("clock"); if(el) el.textContent=new Date().toLocaleString(I18N.locale,{timeZone:"Asia/Shanghai",hour12:false}); }
tickClock(); setInterval(tickClock, 1000);
var curFilter="all", curGrade="all", curTag="", curTagLabel="", curPage=1;
var PAGE_SIZE = 24;
function cardMatches(c){
var q=(document.getElementById("q").value||"").toLowerCase().trim();
var okChan=curFilter==="all"||(" "+c.dataset.channels+" ").indexOf(" "+curFilter+" ")>=0;
var okGrade=curGrade==="all"||c.dataset.grade===curGrade;
var okQ=!q||c.dataset.name.indexOf(q)>=0;
var okTag=!curTag||("|"+(c.dataset.tags||"")+"|").indexOf("|"+curTag+"|")>=0;
return okChan&&okGrade&&okQ&&okTag;
}
function pageList(cur,total){
if(total<=7){ var a=[]; for(var i=1;i<=total;i++) a.push(i); return a;}
var s={}; [1,2,total-1,total,cur-1,cur,cur+1].forEach(function(p){ if(p>=1&&p<=total) s[p]=1;});
var arr=Object.keys(s).map(Number).sort(function(a,b){return a-b;});
var out=[],prev=0;
arr.forEach(function(p){ if(prev&&p-prev>1) out.push("…"); out.push(p); prev=p;});
return out;
}
function scrollAll(){ var el=document.getElementById("all-intel"); if(el) el.scrollIntoView({behavior:"smooth"});}
function renderPager(total,pages){
var numsHtml=pageList(curPage,pages).map(function(p){
return p==="…"? '<span class="pgdots">…</span>': '<button class="fbtn pgnum'+(p===curPage?" on":"")+'" data-page="'+p+'">'+p+'</button>';
}).join("");
document.querySelectorAll(".pager").forEach(function(pg){
var nums=pg.querySelector(".pg-nums");
if(nums){ nums.innerHTML=numsHtml;
nums.querySelectorAll("[data-page]").forEach(function(b){ b.addEventListener("click", function(){
curPage=parseInt(b.dataset.page,10); applyFilter(false); scrollAll();
});});}
var st=pg.querySelector(".pg-status");
if(st) st.textContent=I18N.pager.replace("{cur}",curPage).replace("{pages}",pages).replace("{total}",total);
var pv=pg.querySelector(".pg-prev"), nx=pg.querySelector(".pg-next");
if(pv) pv.disabled=curPage<=1;
if(nx) nx.disabled=curPage>=pages;
});
}
function applyFilter(reset){
if(reset) curPage=1;
var all=Array.prototype.slice.call(document.querySelectorAll("#all-grid .card"));
var list=all.filter(cardMatches);
var pages=Math.max(1, Math.ceil(list.length/PAGE_SIZE));
if(curPage>pages) curPage=pages;
all.forEach(function(c){ c.style.display="none";});
list.slice((curPage-1)*PAGE_SIZE, curPage*PAGE_SIZE).forEach(function(c){ c.style.display="";});
document.getElementById("shown").textContent=I18N.shown.replace("{n}",list.length);
var pill=document.getElementById("tag-pill");
if(curTag){ pill.style.display=""; document.getElementById("tag-name").textContent=curTagLabel || curTag;} else { pill.style.display="none";}
renderPager(list.length, pages);
}
document.querySelectorAll("[data-filter]").forEach(function(b){ b.addEventListener("click", function(){
curFilter=b.dataset.filter;
document.querySelectorAll("[data-filter]").forEach(function(x){ x.classList.remove("on");});
b.classList.add("on"); applyFilter(true);
});});
document.querySelectorAll("[data-gf]").forEach(function(b){ b.addEventListener("click", function(){
curGrade=b.dataset.gf;
document.querySelectorAll("[data-gf]").forEach(function(x){ x.classList.remove("on");});
b.classList.add("on"); applyFilter(true);
});});
document.getElementById("q").addEventListener("input", function(){ applyFilter(true);});
document.querySelectorAll("[data-tag]").forEach(function(ch){ ch.addEventListener("click", function(){
curTag=ch.dataset.tag; curTagLabel=ch.dataset.taglabel || ch.dataset.tag; applyFilter(true); scrollAll();
});});
document.getElementById("tag-clear").addEventListener("click", function(){ curTag=""; curTagLabel=""; applyFilter(true);});
document.querySelectorAll(".pg-prev").forEach(function(b){ b.addEventListener("click", function(){ if(curPage>1){ curPage--; applyFilter(false); scrollAll(); }});});
document.querySelectorAll(".pg-next").forEach(function(b){ b.addEventListener("click", function(){ curPage++; applyFilter(false); scrollAll(); });});
var collapsed={};
function setSection(id, hide){
var body=document.getElementById(id); if(!body) return;
body.classList.toggle("hide", hide); collapsed[id]=hide;
var tog=document.querySelector('[data-collapse="'+id+'"] .ctog');
if(tog) tog.textContent=hide?"▶":"▼";
}
document.querySelectorAll("[data-collapse]").forEach(function(h){ h.addEventListener("click", function(){
var id=h.dataset.collapse; setSection(id, !collapsed[id]);
});});
var headTgl=document.getElementById("head-toggle"), stickyHead=document.querySelector(".stickyhead");
function setHeadCollapsed(c){ if(!stickyHead) return; stickyHead.classList.toggle("collapsed", !!c); if(headTgl) headTgl.textContent=c? I18N.expand: I18N.collapse; try{ localStorage.setItem("ih-head", c? "1": "0"); }catch(e){} }
if(headTgl) headTgl.addEventListener("click", function(){ setHeadCollapsed(!stickyHead.classList.contains("collapsed")); });
try{ if(localStorage.getItem("ih-head")==="1") setHeadCollapsed(true); }catch(e){}
var btnExp=document.getElementById("btn-expand-all"), btnCol=document.getElementById("btn-collapse-all");
if(btnExp) btnExp.addEventListener("click", function(){ document.querySelectorAll(".secbody").forEach(function(b){ setSection(b.id, false); });});
if(btnCol) btnCol.addEventListener("click", function(){ document.querySelectorAll(".secbody").forEach(function(b){ setSection(b.id, true); });});
document.querySelectorAll("[data-showmore]").forEach(function(b){ b.addEventListener("click", function(){
var g=document.getElementById(b.dataset.showmore); if(!g) return;
var clipped=g.classList.toggle("clipped");
b.textContent=clipped? b.dataset.label: I18N.showLess;
});});
var briefPanel=document.getElementById("brief-panel");
function closeBrief(){ if(briefPanel) briefPanel.style.display="none"; }
document.getElementById("brief-fab").addEventListener("click", function(){
briefPanel.style.display=briefPanel.style.display==="block"? "none": "block";
});
document.getElementById("brief-close").addEventListener("click", closeBrief);
document.getElementById("brief-min").addEventListener("click", closeBrief);
document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeBrief(); });
document.getElementById("brief-head").addEventListener("pointerdown", function(e){
if(e.target.closest("button")) return;
var r=briefPanel.getBoundingClientRect();
var dx=e.clientX-r.left, dy=e.clientY-r.top;
briefPanel.style.left=r.left+"px"; briefPanel.style.top=r.top+"px";
briefPanel.style.right="auto"; briefPanel.style.bottom="auto";
function mv(ev){
var x=Math.min(Math.max(0, ev.clientX-dx), window.innerWidth-r.width);
var y=Math.min(Math.max(0, ev.clientY-dy), window.innerHeight-r.height);
briefPanel.style.left=x+"px"; briefPanel.style.top=y+"px";
}
function up(){ document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); }
document.addEventListener("pointermove", mv);
document.addEventListener("pointerup", up);
});
applyFilter(false);
</script>
</body></html>`;
return new Response(html, { headers: { "content-type": "text/html;charset=utf-8"}});
}

function kvErrorPage(lang) {
lang = lang && LANGS.includes(lang)? lang: "zh";
const html = `<!doctype html><html lang="${LANG_HTML[lang]}"${lang === "ar"? ' dir="rtl"': ""}><head><meta charset="utf-8"><title>${esc(t(lang, "kv_err_title"))}</title>
<style>body{background:#0a0e12;color:#f87171;font-family:ui-monospace,Menlo,Consolas,monospace;padding:40px}</style></head>
<body><h1>${esc(t(lang, "kv_err_h1"))}</h1><p>${t(lang, "kv_err_body")}</p></body></html>`;
return new Response(html, { status: 500, headers: { "content-type": "text/html;charset=utf-8"}});
}

// ============================================================
// 【核心模块】总统简报 Telegram 推送 — 可选 Secret：TG_BOT_TOKEN + TG_CHAT_ID（Bot 私聊）和/或 TG_CHANNEL_ID（手动频道，可填 @频道名 或 -100… 数字 id）；
// v5.3 起频道可自动注册：Bot 被设为频道管理员后，Webhook 的 my_chat_member / channel_post 更新会把频道登记进 intel:tgchannels，自动成为推送目标，TG_CHANNEL_ID 退为可选手动覆盖。
// 都未配置/未注册时功能静默不启用。每日一次门禁按目标分别判定：失败的目标可在当天后续巡检重试，已成功的目标当天不重发。
// 推送状态存 intel:briefpush：{date, targets: {"dm"|"ch:<chatId>": {ok,ts}}}（v5.2 及更早的 {date, dm, channel} 旧格式在读取时自动迁移）。
// 手动推送 POST /api/brief/push 在 v5.3.1 起需要鉴权：未配 Secret PUSH_KEY 时接口 403 关闭；请求须带请求头 x-push-key 且与 PUSH_KEY 一致，否则 401 且不推送、不写节流。
// 手动节流 intel:pushmanual 同为按目标记录 {"dm"|"ch:<chatId>": ts}：只拦单个目标，新注册的频道无节流记录、可立即补推（旧全局格式在读取时迁移，见 loadPushManualStamps）。
// 注意：推频道时 Bot 必须是该频道管理员，否则 Telegram 会拒绝。
// ============================================================
function cstParts(ts) {
const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date(ts));
const o = {};
for (const p of parts) o[p.type] = p.value;
return { y: o.year, mo: o.month, d: o.day, hh: parseInt(o.hour, 10) || 0, mm: parseInt(o.minute, 10) || 0};
}
function cstDateStr(ts) {
const p = cstParts(ts);
return `${p.y}-${p.mo}-${p.d}`;
}
// 从 Bot Token 的数字前缀解析 Bot 自身 id（my_chat_member 更新里靠它认出「被升/降级的是本 Bot」）
function botIdFromToken(env) {
const m = String(env.TG_BOT_TOKEN || "").match(/^(\d+):/);
return m? Number(m[1]): null;
}
// 自动注册的频道表 intel:tgchannels：{ "<chatId>": {title, username, type:"channel", status:"active"|"removed", addedTs, updatedTs} }
async function loadTgChannels(env) {
return (await loadJSON(env, CONFIG.kvTgChannels, {})) || {};
}
// 登记/更新一个频道：status 为 "active"（成为/刷新推送目标）或 "removed"（被降级/移出，不再推送）；非频道 chat 一律忽略
async function upsertTgChannel(env, chat, status) {
if (!chat || chat.type !== "channel" || chat.id == null) return;
const all = await loadTgChannels(env);
const key = String(chat.id);
const now = Date.now();
const prev = all[key] || {};
all[key] = {
title: chat.title != null? String(chat.title): (prev.title || ""),
username: chat.username? String(chat.username): null,
type: "channel",
status,
addedTs: prev.addedTs || now,
updatedTs: now,
};
await env.INTEL_KV.put(CONFIG.kvTgChannels, JSON.stringify(all));
}
// intel:briefpush 旧格式迁移：v5.2 及更早存 {date, dm:{ok,ts}, channel:{ok,ts}}，v5.3 起统一为 {date, targets:{"dm"|"ch:<chatId>": {ok,ts}}}。
// 读取时转换：dm → targets.dm；channel → targets["ch:"+TG_CHANNEL_ID]（未配 TG_CHANNEL_ID 时挂到 legacy 键，不再门禁任何现行目标）。下一次推送写回时即落盘为新格式。
function migrateBriefPushState(env, raw) {
if (!raw || typeof raw !== "object") return { date: null, targets: {}};
if (raw.targets && typeof raw.targets === "object") return { date: raw.date || null, targets: raw.targets};
const targets = {};
if (raw.dm && typeof raw.dm === "object") targets.dm = raw.dm;
if (raw.channel && typeof raw.channel === "object") {
targets[env.TG_CHANNEL_ID? "ch:" + String(env.TG_CHANNEL_ID): "legacy:channel"] = raw.channel;
}
return { date: raw.date || null, targets};
}
// intel:pushmanual 旧格式迁移：v5.3 及更早存的是单个全局时间戳（裸数字或 {ts} 对象），v5.3.1 起改为按目标映射 {"dm"|"ch:<chatId>": ts}。
// 旧时间戳一律视为只给 "dm" 目标打的戳——历史手动推送至少都包含私聊目标，频道从未被单独打戳，因此迁移后频道（尤其新注册的）仍可立即手动补推。
async function loadPushManualStamps(env) {
const raw = await loadJSON(env, CONFIG.kvPushManual, null);
if (raw == null) return {};
if (typeof raw === "number" && Number.isFinite(raw)) return { dm: raw};
if (typeof raw === "object") {
const keys = Object.keys(raw);
if (typeof raw.ts === "number" && !keys.some((k) => k === "dm" || k.startsWith("ch:"))) return { dm: raw.ts};
const out = {};
for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
return out;
}
return {};
}
// 解析全部推送目标：私聊（TG_CHAT_ID）+ 手动频道（TG_CHANNEL_ID，可选覆盖）+ 全部 status=active 的自动注册频道；按 chatId 去重
async function resolvePushTargets(env) {
const targets = [];
if (!env.TG_BOT_TOKEN) return targets;
const seen = new Set();
const add = (t) => { if (!seen.has(t.chatId)) { seen.add(t.chatId); targets.push(t); } };
if (env.TG_CHAT_ID) add({ key: "dm", kind: "dm", chatId: String(env.TG_CHAT_ID)});
if (env.TG_CHANNEL_ID) add({ key: "ch:" + String(env.TG_CHANNEL_ID), kind: "channel", manual: true, chatId: String(env.TG_CHANNEL_ID)});
const chans = await loadTgChannels(env);
for (const [id, rec] of Object.entries(chans)) {
if (rec && rec.status === "active") add({ key: "ch:" + id, kind: "channel", chatId: id, title: rec.title || ""});
}
return targets;
}
function tgEsc(s) {
return String(s?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// 简报的 Telegram 文本版（HTML 解析模式）：与 Web 简报同结构，控制在约 1800 字内（不带逐条研判，靠链接回面板看详情）
function buildBriefText(b) {
const p = cstParts(Date.now());
const repoLine = (r, withDelta) => r
? `<a href="${tgEsc(r.url)}">${tgEsc(r.name)}</a> ★${r.stars}${withDelta && typeof r.delta === "number"? `（${r.delta >= 0? "+": ""}${r.delta}★ 本轮）`: ""}`
: "暂无";
const lines = [];
lines.push(`📋 <b>GitHub 情报中心 · 总统简报（${p.mo}-${p.d}）</b>`);
lines.push("");
lines.push(`【今日态势】${tgEsc(b.oneliner)}`);
lines.push("");
lines.push("【飙升 TOP3】");
if (b.topSurging && b.topSurging.length) b.topSurging.forEach((r, i) => lines.push(`${i + 1}. ${repoLine(r, true)}`));
else lines.push("暂无增量数据（需两轮巡检）");
lines.push("");
lines.push("【热度 TOP3】");
if (b.topHeat && b.topHeat.length) b.topHeat.forEach((r, i) => lines.push(`${i + 1}. ${repoLine(r, false)}`));
else lines.push("暂无数据");
lines.push("");
const secTop = b.securityFocus? b.securityFocus.top: null;
lines.push(`【网安焦点】${repoLine(secTop, false)}`);
if (b.securityFocus && b.securityFocus.topTags && b.securityFocus.topTags.length) {
lines.push(`热门标签：${b.securityFocus.topTags.map((t) => tgEsc(t.tag) + " ×" + t.count).join(" · ")}`);
}
if (b.trendingTopics && b.trendingTopics.length) {
lines.push("");
lines.push("【话题趋势】");
for (const t of b.trendingTopics) lines.push(`${tgEsc(t.topic)} +${t.dStars24h}★/24h · 连续 ${t.streak} 轮升温`);
}
if (b.renames && b.renames.length) {
lines.push("");
lines.push("【改名动态】");
for (const r of b.renames) lines.push(`${tgEsc(r.from)} → <a href="https://github.com/${tgEsc(r.to)}">${tgEsc(r.to)}</a>`);
}
lines.push("");
lines.push(`<a href="${CONFIG.panelUrl}">打开情报面板 →</a>`);
let text = lines.join("\n");
if (text.length > 1800) {
const cut = text.lastIndexOf("\n", 1790);
text = text.slice(0, cut > 0? cut: 1790) + "\n…";
}
return text;
}
async function sendTelegramTo(env, chatId, text) {
try {
const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
method: "POST",
headers: { "content-type": "application/json"},
body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true}),
});
const j = await r.json().catch(() => null);
return !!(j && j.ok === true);
} catch { return false; }
}
// 把简报发给给定目标列表，并把每个目标的结果（ok/时间）合并写回 intel:briefpush 的 targets 映射（跨天自动重置，旧格式先迁移）
async function pushBriefToTargets(env, brief, targets) {
const text = buildBriefText(brief);
const now = Date.now();
const today = cstDateStr(now);
let state = migrateBriefPushState(env, (await loadJSON(env, CONFIG.kvBriefPush, {})) || {});
if (state.date !== today) state = { date: today, targets: {}};
const results = {};
for (const t of targets) {
const ok = await sendTelegramTo(env, t.chatId, text);
results[t.key] = ok;
state.targets[t.key] = { ok, ts: now};
}
await env.INTEL_KV.put(CONFIG.kvBriefPush, JSON.stringify(state));
return results;
}
// 每日自动推送门禁：CST 08:00 之后、且当天该目标还没推送成功过，才补发（失败目标当天后续巡检会重试）
async function maybePushDailyBrief(env) {
const targets = await resolvePushTargets(env);
if (!targets.length) return { pushed: false, reason: "not_configured"};
const now = Date.now();
const p = cstParts(now);
if (p.hh * 60 + p.mm < 8 * 60) return { pushed: false, reason: "before_0800"};
const today = cstDateStr(now);
const state = migrateBriefPushState(env, (await loadJSON(env, CONFIG.kvBriefPush, {})) || {});
const dayTargets = state.date === today? state.targets: {};
const due = targets.filter((t) => !(dayTargets[t.key] && dayTargets[t.key].ok));
if (!due.length) return { pushed: false, reason: "already_today"};
const brief = await loadBrief(env);
const results = await pushBriefToTargets(env, brief, due);
return { pushed: Object.values(results).some(Boolean), results};
}

// ============================================================
// 【核心模块】Telegram 命令系统 — 简报 Bot 的只读命令：POST /tg/webhook 接收 Telegram 更新，
// 先校验请求头 x-telegram-bot-api-secret-token 与 Secret TG_WEBHOOK_SECRET 一致（未配置该 Secret 时接口直接 404，错密钥 403）；
// message 里的 /命令走只读回复，其余更新一律 200 忽略。回复数据与面板同源（同一批 KV），全部只读，不做任何管理动作。
// v5.3 起同一 Webhook 还处理 my_chat_member / channel_post：Bot 被设为频道管理员（或在已注册频道发帖）时自动登记频道为简报推送目标。
// 命令清单见 TG_COMMANDS，同时通过 GET /api/tg/commands 暴露，供部署时 setMyCommands 直接取用。
// ============================================================
const TG_COMMANDS = [
{ command: "brief", description: "今日总统简报"},
{ command: "surge", description: "飙升榜 TOP5"},
{ command: "hot", description: "热度榜 TOP5"},
{ command: "sec", description: "网安焦点"},
{ command: "watchlist", description: "重点监控状态"},
{ command: "stats", description: "巡检状态"},
{ command: "panel", description: "打开情报面板"},
{ command: "help", description: "命令列表"},
];
const TG_NO_DATA = "暂无数据，等待首轮巡检。";

// 命令回复共用的数据装载：最新仓库、巡检元信息与种子两份 KV（与面板同源）
async function loadIntelData(env) {
const latest = await loadJSON(env, CONFIG.kvLatest, null);
const meta = await loadJSON(env, CONFIG.kvMeta, null);
const seedIds = (await loadJSON(env, CONFIG.kvSeedIds, {})) || {};
const seedLive = (await loadJSON(env, CONFIG.kvSeedLive, {})) || {};
return { repos: latest && Array.isArray(latest.repos)? latest.repos: [], meta, seedIds, seedLive};
}
function tgRepoLink(r) {
return `<a href="${tgEsc(r.html_url)}">${tgEsc(r.full_name)}</a>`;
}
function tgHelpText() {
const lines = [
"👋 <b>GitHub 情报中心 · 情报机器人</b>",
"开源情报巡检 · 规则研判 · 非 AI 生成",
"",
"<b>可用命令</b>",
...TG_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
"",
`<a href="${CONFIG.panelUrl}">打开情报面板 →</a>`,
];
return lines.join("\n");
}
// 按命令生成回复文本（HTML 解析模式）；chatId 为发令者所在 chat，/stats 用它判定是否为机主（只有机主能看到自动注册频道的标题）。无数据时统一回 TG_NO_DATA 或说明性文字，不抛错
async function tgCommandReply(env, cmd, chatId) {
switch (cmd) {
case "start":
case "help":
return tgHelpText();
case "panel":
return [
"🖥 <b>GitHub 情报中心</b>",
`情报面板：<a href="${CONFIG.panelUrl}">${tgEsc(CONFIG.panelUrl)}</a>`,
`简报 JSON：<a href="${CONFIG.panelUrl}/api/brief">${tgEsc(CONFIG.panelUrl)}/api/brief</a>`,
].join("\n");
case "brief": {
const { repos } = await loadIntelData(env);
if (!repos.length) return TG_NO_DATA;
return buildBriefText(await loadBrief(env)); // 与每日推送共用同一份简报文案
}
case "surge": {
const { repos } = await loadIntelData(env);
if (!repos.length) return TG_NO_DATA;
const top = repos.filter((r) => typeof r.starDelta === "number").sort((a, b) => b.starDelta - a.starDelta).slice(0, 5);
if (!top.length) return "📈 <b>飙升榜 TOP5</b>\n暂无增量数据（需至少两轮巡检对比）。";
return ["📈 <b>飙升榜 TOP5</b>", ...top.map((r, i) => `${i + 1}. ${tgRepoLink(r)} ★${r.stars}（${r.starDelta >= 0? "+": ""}${r.starDelta}★ 本轮）`)].join("\n");
}
case "hot": {
const { repos } = await loadIntelData(env);
if (!repos.length) return TG_NO_DATA;
const top = [...repos].sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 5);
return ["🔥 <b>热度榜 TOP5</b>", ...top.map((r, i) => `${i + 1}. ${tgRepoLink(r)} ★${r.stars} · 热度 ${r.heat || 0}`)].join("\n");
}
case "sec": {
const { repos } = await loadIntelData(env);
if (!repos.length) return TG_NO_DATA;
const fam = ["security", "src-hunt", "sec-learning"];
const top = repos.filter((r) => (r.channels || []).some((c) => fam.includes(c))).sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, 5);
const tags = Object.entries(secTagFreq(repos)).sort((a, b) => b[1] - a[1]).slice(0, 5);
const lines = ["🛡 <b>网安焦点</b>"];
if (top.length) top.forEach((r, i) => lines.push(`${i + 1}. ${tgRepoLink(r)} ★${r.stars} · 热度 ${r.heat || 0}`));
else lines.push("暂无网安通道数据");
if (tags.length) lines.push(`热门标签：${tags.map(([t, n]) => tgEsc(t) + " ×" + n).join(" · ")}`);
return lines.join("\n");
}
case "watchlist": {
const { repos, seedIds, seedLive } = await loadIntelData(env);
const wl = buildWatchlist(repos, seedIds, seedLive);
const liveN = wl.filter((w) => w.live).length;
const freshN = wl.filter((w) => w.refreshed).length;
const gone = wl.filter((w) => w.gone);
const renamed = wl.filter((w) => w.renamedFrom);
const scored = wl
.map((w) => ({ w, stars: w.live? w.live.stars: w.refreshed? w.refreshed.stars: null, src: w.live? "巡检": w.refreshed? "保鲜": "静态"}))
.filter((x) => x.stars != null).sort((a, b) => b.stars - a.stars).slice(0, 5);
const lines = [
`🎯 <b>重点监控</b>（共 ${wl.length} 个种子）`,
`数据覆盖：巡检命中 ${liveN} · 单独保鲜 ${freshN} · 静态 ${wl.length - liveN - freshN - gone.length}${gone.length? ` · 疑似删库 ${gone.length}`: ""}`,
];
if (scored.length) {
lines.push("星标 TOP5：");
scored.forEach((x, i) => lines.push(`${i + 1}. <a href="${tgEsc(x.w.url)}">${tgEsc(x.w.name)}</a> ★${x.stars}（${x.src}）`));
}
for (const g of gone.slice(0, 5)) lines.push(`⚠️ 疑似删库/改名未追踪：${tgEsc(g.name)}`);
for (const r of renamed.slice(0, 5)) lines.push(`🔀 改名：${tgEsc(r.renamedFrom)} → <a href="${tgEsc(r.url)}">${tgEsc(r.name)}</a>`);
return lines.join("\n");
}
case "stats": {
const { repos, meta } = await loadIntelData(env);
if (!meta) return "📊 <b>巡检状态</b>\n尚无巡检记录，等待首轮巡检。";
const bp = migrateBriefPushState(env, (await loadJSON(env, CONFIG.kvBriefPush, {})) || {});
const errCh = Object.keys(meta.errors || {});
const allTargets = await resolvePushTargets(env);
const autoChans = allTargets.filter((t) => t.kind === "channel" && !t.manual);
const isOwner = !!(env.TG_CHAT_ID && chatId != null && String(chatId) === String(env.TG_CHAT_ID));
let pushLine = `简报推送：私聊 ${env.TG_BOT_TOKEN && env.TG_CHAT_ID? "已配置": "未配置"} · 手动频道 ${env.TG_BOT_TOKEN && env.TG_CHANNEL_ID? "已配置": "未配置"} · 自动注册频道 ${autoChans.length} 个`;
// 频道标题只给机主看（发令 chat 即 TG_CHAT_ID 私聊时），其他人只看数量，避免频道信息外泄
if (isOwner && autoChans.length) pushLine += `（${autoChans.map((t) => tgEsc(t.title || t.chatId)).join("、")}）`;
pushLine += ` · 最近推送日期 ${bp.date || "无"}`;
return [
"📊 <b>巡检状态</b>",
`上次巡检：${fmtCST(meta.ts)}`,
`通道：${meta.channelsOk?? "-"}/${meta.channelsTotal?? "-"} 正常${errCh.length? "（异常：" + errCh.join("、") + "）": ""}`,
`监控仓库：${meta.total?? repos.length} 个 · 本轮新增 ${meta.newCount || 0} 个`,
`种子保鲜：本轮单独保鲜 ${meta.seedRefreshed || 0} 个`,
pushLine,
].join("\n");
}
default:
return tgHelpText();
}
}
// 频道自动注册：my_chat_member 里被升/降级的若是本 Bot 且 chat 是频道——升为 administrator/creator 登记为 active 推送目标；
// 其余状态（left/kicked/member 等，频道里被降为普通成员等于出局）对已登记频道标记 removed。涉及其他成员或其他类型 chat 的更新一律忽略。
async function handleMyChatMember(env, mcm) {
if (!mcm || !mcm.chat || mcm.chat.type !== "channel") return;
const botId = botIdFromToken(env);
const nm = mcm.new_chat_member;
if (!nm || !nm.user || botId == null || Number(nm.user.id) !== botId) return;
if (nm.status === "administrator" || nm.status === "creator") {
await upsertTgChannel(env, mcm.chat, "active");
} else {
const all = await loadTgChannels(env);
if (all[String(mcm.chat.id)]) await upsertTgChannel(env, mcm.chat, "removed");
}
}
// Webhook 入口：校验密钥 → my_chat_member/channel_post 走频道自动注册（只登记、不回复）→ message 里的命令走只读回复（发回消息所在的 chat）；回复发送失败不影响给 Telegram 回 200
async function handleTgWebhook(request, env) {
if (!env.TG_WEBHOOK_SECRET) return new Response("not found", { status: 404});
if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TG_WEBHOOK_SECRET) return new Response("forbidden", { status: 403});
let update = null;
try { update = await request.json(); } catch { return new Response("ok"); }
if (!update) return new Response("ok");
if (update.my_chat_member) { await handleMyChatMember(env, update.my_chat_member); return new Response("ok"); }
if (update.channel_post) {
// v5.3 之前就已是管理员的频道不会再有 my_chat_member 事件，靠它在频道里的第一帖补登记（同时刷新标题/用户名）
if (update.channel_post.chat) await upsertTgChannel(env, update.channel_post.chat, "active");
return new Response("ok");
}
const msg = update.message;
const text = msg && typeof msg.text === "string"? msg.text.trim(): "";
if (!msg || !text.startsWith("/") || !msg.chat || msg.chat.id == null) return new Response("ok");
const cmd = text.split(/\s+/)[0].slice(1).split("@")[0].toLowerCase();
const reply = await tgCommandReply(env, cmd, msg.chat.id);
if (reply && env.TG_BOT_TOKEN) await sendTelegramTo(env, msg.chat.id, reply);
return new Response("ok");
}

// ============================================================
// 【核心模块】路由入口 — 面板、JSON 接口、TG 命令 Webhook、手动刷新（节流）、Cron 巡检
// ============================================================
async function handleFetch(request, env, langInfo) {
const lang = langInfo && LANGS.includes(langInfo.lang)? langInfo.lang: "zh";
const url = new URL(request.url);
if (!env.INTEL_KV) {
if (url.pathname.startsWith("/api/")) return Response.json({ ok: false, error: "KV 未绑定：请绑定变量名 INTEL_KV"}, { status: 500});
return kvErrorPage(lang);
}
if (url.pathname === "/" && request.method === "GET") return renderPanel(env, lang);
if (url.pathname === "/api/repos" && request.method === "GET") {
const latest = await loadJSON(env, CONFIG.kvLatest, { ts: 0, repos: []});
const repos = latest.repos || [];
return Response.json({ ok: true, ts: latest.ts || 0, count: repos.length, repos, watchlist: buildWatchlist(repos, (await loadJSON(env, CONFIG.kvSeedIds, {})) || {}, (await loadJSON(env, CONFIG.kvSeedLive, {})) || {})});
}
if (url.pathname === "/api/brief" && request.method === "GET") {
const brief = await loadBrief(env, lang);
const bpRaw = (await loadJSON(env, CONFIG.kvBriefPush, {})) || {};
const bp = migrateBriefPushState(env, bpRaw);
const allTargets = await resolvePushTargets(env);
brief.push = {
configured: {
dm: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID),
manualChannel: !!(env.TG_BOT_TOKEN && env.TG_CHANNEL_ID),
autoChannels: allTargets.filter((t) => t.kind === "channel" && !t.manual).length,
},
anyConfigured: allTargets.length > 0,
lastPushDate: bp.date || null,
targets: bp.date === cstDateStr(Date.now())? bp.targets: {},
};
return Response.json({ ok: true, brief});
}
if (url.pathname === "/api/brief/push" && request.method === "POST") {
// 手动推送总统简报（v5.3.1 起）：先鉴权——未配 Secret PUSH_KEY 时接口关闭（403 push_disabled）；请求头 x-push-key 与 PUSH_KEY 不一致时 401 unauthorized，
// 且不推送、不写任何节流记录。鉴权通过后才解析目标：发给全部推送目标（私聊 + 手动频道 + 自动注册频道），与每日自动推送共用 intel:briefpush 状态；
// 节流按目标分别判定（intel:pushmanual 为 {目标键: ts} 映射）：只推 6 小时内没被手动推过的目标，新注册频道无记录可立即补推。
if (!env.PUSH_KEY) return Response.json({ ok: false, pushed: false, status: "push_disabled"}, { status: 403});
if (request.headers.get("x-push-key") !== env.PUSH_KEY) return Response.json({ ok: false, pushed: false, status: "unauthorized"}, { status: 401});
const targets = await resolvePushTargets(env);
if (!targets.length) return Response.json({ ok: false, pushed: false, status: "not_configured"});
const stamps = await loadPushManualStamps(env);
const now = Date.now();
const eligible = targets.filter((t) => !(stamps[t.key] != null && now - stamps[t.key] < CONFIG.pushThrottleMs));
const skipped = targets.filter((t) => !eligible.includes(t)).map((t) => t.key);
if (!eligible.length) {
const earliest = Math.min(...targets.map((t) => stamps[t.key] + CONFIG.pushThrottleMs));
return Response.json({ ok: true, pushed: false, status: "throttled", retryAfterMs: earliest - now, targets: [], skipped});
}
const brief = await loadBrief(env);
const results = await pushBriefToTargets(env, brief, eligible);
const anyOk = Object.values(results).some(Boolean);
if (anyOk) {
const next = { ...stamps};
for (const t of eligible) next[t.key] = now;
await env.INTEL_KV.put(CONFIG.kvPushManual, JSON.stringify(next));
}
return Response.json({ ok: anyOk, pushed: anyOk, status: anyOk? "pushed": "tg_failed", results, targets: eligible.map((t) => t.key), skipped});
}
if (url.pathname === "/api/watchlist" && request.method === "GET") {
const latest = await loadJSON(env, CONFIG.kvLatest, { ts: 0, repos: []});
const watchlist = buildWatchlist(latest.repos || [], (await loadJSON(env, CONFIG.kvSeedIds, {})) || {}, (await loadJSON(env, CONFIG.kvSeedLive, {})) || {});
return Response.json({ ok: true, count: watchlist.length, watchlist});
}
if (url.pathname === "/api/stats" && request.method === "GET") {
const meta = await loadJSON(env, CONFIG.kvMeta, null);
return Response.json({ ok: true, meta});
}
if (url.pathname === "/api/tg/commands" && request.method === "GET") {
return Response.json({ ok: true, commands: TG_COMMANDS});
}
if (url.pathname === "/tg/webhook" && request.method === "POST") return handleTgWebhook(request, env);
if (url.pathname === "/api/refresh" && request.method === "POST") {
const meta = await loadJSON(env, CONFIG.kvMeta, null);
if (meta && meta.ts && Date.now() - meta.ts < CONFIG.refreshThrottleMs) {
return Response.json({ ok: true, throttled: true, lastSweep: meta.ts, retryAfterMs: CONFIG.refreshThrottleMs - (Date.now() - meta.ts)});
}
const result = await runSweep(env);
try { await purgeIntelCache(url.origin); } catch {} // 【v5.4】新数据已写入 KV：失效只读路由的边缘缓存（失效失败不影响巡检结果）
return Response.json({ ok: result.ok!== false, throttled: false, sweep: result});
}
return new Response("not found", { status: 404});
}

// ============================================================
// 【核心模块】边缘缓存 — 只读 GET 路由（面板 / /api/repos / /api/stats / /api/brief / /api/tg/commands）走 Cache API 读穿缓存：
// 情报数据只在巡检时变化，故缓存 30 分钟且巡检后主动失效，重复访问不再重跑渲染、不再重读 KV（抗刷、省额度）。
// 存入的副本不带 x-intel-cache 标记：命中时在返回副本上标 HIT，未命中标 MISS。空数据状态（首轮巡检前）与错误响应永不缓存；
// caches 不可用（如本地测试环境）时自动降级为直读 KV，行为与无缓存时完全一致。
// 【v5.5】面板与 /api/brief 的缓存键带解析后的语言（?lang=），八种语言各存一份，巡检失效时全部语言变体一并删除；Set-Cookie 只写返回响应、永不进入缓存副本。
// ============================================================
const CACHE_PATHS = ["/", "/api/repos", "/api/stats", "/api/brief", "/api/tg/commands"];
const LANG_CACHE_PATHS = ["/", "/api/brief"];

function intelCache() {
try { return (typeof caches !== "undefined" && caches.default)? caches.default: null; } catch { return null; }
}

// 缓存键只取 origin + pathname：这些路由不看 query，忽略 query 差异，避免用 query 刷出大量缓存碎片
function intelCacheKey(url, lang) {
return url.origin + url.pathname + (LANG_CACHE_PATHS.includes(url.pathname)? "?lang=" + (lang || "zh"): "");
}

// 是否值得缓存：仅 200 且确有情报数据。判断只读响应副本、不额外读 KV。
// 首轮巡检前的空数据状态不缓存（否则空面板会被缓存住）：stats 的 meta 为空、repos 的 count 为 0、brief 的 totals.repos 为 0、面板渲染了空库提示块。
// /api/tg/commands 是静态清单、与 KV 数据无关，恒可缓存。
async function intelCacheWorthStoring(pathname, res) {
if (res.status!== 200) return false;
try {
if (pathname === "/api/tg/commands") return true;
const ct = res.headers.get("content-type") || "";
if (ct.includes("application/json")) {
const body = await res.clone().json();
if (pathname === "/api/repos") return (body.count || 0) > 0;
if (pathname === "/api/stats") return body.meta != null;
if (pathname === "/api/brief") return !!(body.brief && body.brief.totals && body.brief.totals.repos > 0);
return false;
}
const html = await res.clone().text();
return !html.includes('class="empty"');
} catch { return false; }
}

// 巡检写入新数据后失效全部只读路由缓存：单个键删除失败互不影响，整体失败也绝不拖累巡检
async function purgeIntelCache(base) {
const cache = intelCache();
if (!cache || !base) return;
const keys = [];
for (const p of CACHE_PATHS) {
if (LANG_CACHE_PATHS.includes(p)) { for (const l of LANGS) keys.push(p + "?lang=" + l);}
else keys.push(p);
}
await Promise.all(keys.map(async (p) => {
try { await cache.delete(new URL(p, base).toString());} catch {}
}));
}

export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);
const langInfo = resolveLang(request);
const cache = (request.method === "GET" && env.INTEL_KV && CACHE_PATHS.includes(url.pathname))? intelCache(): null;
if (!cache) {
const res = await handleFetch(request, env, langInfo);
if (langInfo.setCookie && url.pathname === "/") res.headers.set("Set-Cookie", langCookieValue(langInfo.lang));
return res;
}
const key = intelCacheKey(url, langInfo.lang);
try {
const hit = await cache.match(key);
if (hit) {
const out = new Response(hit.body, hit);
out.headers.set("x-intel-cache", "HIT");
if (langInfo.setCookie && url.pathname === "/") out.headers.set("Set-Cookie", langCookieValue(langInfo.lang));
return out;
}
} catch {}
const res = await handleFetch(request, env, langInfo);
if (await intelCacheWorthStoring(url.pathname, res)) {
res.headers.set("Cache-Control", "public, max-age=" + CONFIG.cacheTtlSec);
const stored = res.clone(); // 先克隆再给返回响应标 MISS/Set-Cookie，保证存入的副本既不带 x-intel-cache 标记、也不带 Set-Cookie
const putP = Promise.resolve().then(() => cache.put(key, stored)).catch(() => {});
if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putP);
}
res.headers.set("x-intel-cache", "MISS");
if (langInfo.setCookie && url.pathname === "/") res.headers.set("Set-Cookie", langCookieValue(langInfo.lang));
return res;
},
async scheduled(event, env, ctx) {
// Cron 巡检不走手动节流（Cron 间隔本身远大于 30 分钟）；巡检成功后按每日门禁推送总统简报（未配置 TG 时静默跳过）
ctx.waitUntil((async () => {
const meta = await runSweep(env);
try { await purgeIntelCache(CONFIG.panelUrl); } catch {} // 【v5.4】Cron 巡检同样失效边缘缓存（无请求上下文，用配置的面板地址拼缓存键）
if (meta && meta.ok) await maybePushDailyBrief(env);
})());
},
};
