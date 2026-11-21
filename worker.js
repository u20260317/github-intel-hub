// ============================================================
// GitHub 情报中心 · GitHub Intel Center（原名情报局，Worker 名/网址不变；v2：9 通道 + 重点监控种子 WATCHLIST）
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
};

// 日期工具：GitHub search 需要 YYYY-MM-DD
function daysAgo(n) {
const d = new Date(Date.now() - n * 86400000);
return d.toISOString().slice(0, 10);
}

// 九个情报通道：每通道 1 次 Search API 调用，一轮巡检共 9 次请求，远低于免费版 50 子请求上限（省流）
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
{ key: "skills", name: "Skill 生态", q: `("claude skills" OR "agent skills" OR claude-skill OR agent-skills) stars:>100`, sort: "stars", perPage: 10},
{ key: "creator", name: "自媒体全套", q: `(short-video OR video-editing OR ffmpeg OR "content creation" OR subtitles OR livestream) stars:>200 pushed:>${d30}`, sort: "stars", perPage: 10},
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

// 把种子与巡检数据按 full_name 合并：命中则带其实时 ★/热度/增量，未命中 live=null
function buildWatchlist(repos) {
const byName = new Map((repos || []).map((r) => [r.full_name.toLowerCase(), r]));
return SEEDS.map((s) => {
const live = s.repo? byName.get(s.repo.toLowerCase()): undefined;
return {
name: s.repo || s.name,
url: s.repo? `https://github.com/${s.repo}`: s.url,
cat: s.cat,
catName: SEED_CATS[s.cat] || s.cat,
note: s.note,
live: live? { stars: live.stars, forks: live.forks, heat: live.heat, grade: live.grade, starDelta: live.starDelta, channels: live.channels}: null,
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

// GitHub 原始 item -> 情报库统一记录
function normalizeRepo(it, channelKey) {
return {
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

async function runSweep(env) {
const channels = buildChannels();
const oldLatest = await loadJSON(env, CONFIG.kvLatest, null);
const prev = await loadJSON(env, CONFIG.kvPrev, {}); // {full_name: stars,..., ts}
const prevTs = typeof prev.ts === "number"? prev.ts: 0;

const merged = new Map(); // full_name -> record
const errors = {};
const counts = {};
let okChannels = 0;

for (const ch of channels) {
try {
const items = await fetchChannel(env, ch);
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
} catch (e) {
errors[ch.key] = String(e.message || e).slice(0, 200);
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

// 计算 starDelta 并做研判
let newCount = 0;
const repos = [];
for (const rec of merged.values()) {
const prevStars = typeof prev[rec.full_name] === "number"? prev[rec.full_name]: null;
rec.starDelta = prevStars == null? null: rec.stars - prevStars;
if (prevStars == null) newCount++; // 不在上轮快照里 = 本轮新入情报库（首轮即全部）
Object.assign(rec, analyze(rec));
repos.push(rec);
}
repos.sort((a, b) => b.heat - a.heat);

const ts = Date.now();
const latest = { ts, repos};
// 新快照：扁平 {full_name: stars, ts}（full_name 必含 "/"，与 ts 键不会撞）
const newPrev = { ts};
for (const r of repos) newPrev[r.full_name] = r.stars;

const meta = { ts, ok: true, counts, errors, total: repos.length, newCount, channelsOk: okChannels, channelsTotal: channels.length};
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

function analyze(rec) {
const hay = [rec.full_name, rec.description, rec.language,...(rec.topics || [])].join(" ").toLowerCase();
const tags = [];
for (const [kw, point] of LEARNING_MAP) {
if (hay.includes(kw) &&!tags.includes(point)) tags.push(point);
if (tags.length >= 4) break;
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
return { heat, grade, learnTags: tags, verdict};
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
// 【核心模块】情报面板 — 暗色情报中心风格：跑马灯/KPI/飙升榜/专区/全部情报（可筛选可搜索）
// ============================================================
function repoCard(r, rank) {
const delta = typeof r.starDelta === "number"
? `<span class="delta ${r.starDelta >= 0? "up": "down"}">${r.starDelta >= 0? "+": ""}${r.starDelta}★ 本轮</span>`: "";
const tags = (r.learnTags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
const chans = (r.channels || []).join(" ");
const rankHtml = rank? `<span class="rank">#${rank}</span>`: "";
return `<article class="card" data-channels="${esc(chans)}" data-grade="${esc(r.grade || "B")}" data-name="${esc((r.full_name + " " + (r.description || "")).toLowerCase())}">
<div class="chead"><span>${rankHtml}<a class="rname" href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.full_name)}</a></span><span class="grade g${esc(r.grade || "B")}">${esc(r.grade || "B")}级</span></div>
<p class="desc">${esc(r.description || "（无描述）")}</p>
<div class="meta">★ ${r.stars} · ⑂ ${r.forks}${r.language? " · " + esc(r.language): ""}${r.license? " · " + esc(r.license): ""} ${delta}</div>
<div class="heatbar"><div class="heatfill" style="width:${r.heat || 0}%"></div></div>
<div class="meta">热度 ${r.heat || 0} / 100 · 推送 ${fmtDateCST(r.pushed_at)}</div>
<div class="tags">${tags}</div>
<p class="verdict">研判（规则）：${esc(r.verdict || "")}</p>
</article>`;
}

async function renderPanel(env) {
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
const watchlist = buildWatchlist(repos);
const topHeat = repos.length? Math.max(...repos.map((r) => r.heat || 0)): 0;
const newCount = meta? meta.newCount || 0: 0;

// 重点监控种子卡：按分类分组渲染，命中巡检数据的带实时 ★/热度/增量徽章
const seedGroups = [...new Set(SEEDS.map((s) => s.cat))].map((cat) => {
const items = watchlist.filter((w) => w.cat === cat);
const cards = items.map((w) => {
const live = w.live? `<div class="meta">★ ${w.live.stars} · 热度 ${w.live.heat} · ${esc(w.live.grade || "B")}级${typeof w.live.starDelta === "number"? ` · <span class="delta ${w.live.starDelta >= 0? "up": "down"}">${w.live.starDelta >= 0? "+": ""}${w.live.starDelta}★ 本轮</span>`: ""}</div>`: `<div class="meta">未在本轮巡检命中 · 点名监控中</div>`;
return `<article class="card seed"><div class="chead"><a class="rname" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)}</a><span class="tag">${esc(w.catName)}</span></div>
<p class="desc">学习点：${esc(w.note)}</p>${live}</article>`;
}).join("");
return `<h3 class="seedcat">▸ ${esc(SEED_CATS[cat] || cat)}（${items.length}）</h3><div class="grid">${cards}</div>`;
}).join("");

const tickerText = meta
? `上次巡检 ${fmtCST(meta.ts)} · 监控仓库 ${repos.length} 个 · 本轮新增 ${newCount} · 通道正常 ${meta.channelsOk?? "-"}/${meta.channelsTotal?? channels.length}${Object.keys(meta.errors || {}).length? " · 异常通道：" + Object.keys(meta.errors).join(","): ""} · 数据源 GitHub Search API（未认证限额较低） · 研判为规则引擎产出`
: "尚无巡检数据 · 点击「立即巡检」或 POST /api/refresh 拉取第一批情报";

const empty = repos.length === 0
? `<div class="empty">▣ 情报库为空。先执行一次巡检：点下方按钮，或 <code>POST /api/refresh</code>。未认证 GitHub API 每小时搜索限额有限，请勿频繁刷新（面板刷新有 30 分钟节流）。<br><br><button class="btn" onclick="doRefresh(this)">立即巡检</button> <span class="rmsg"></span></div>`: "";

const filterBtns = [`<button class="fbtn on" data-filter="all">全部</button>`]
.concat(channels.map((c) => `<button class="fbtn" data-filter="${c.key}">${esc(c.name)}</button>`)).join("");

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub 情报中心 · INTEL CENTER</title><style>
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
.topbar{position:sticky;top:0;z-index:30;background:rgba(10,14,18,.93);backdrop-filter:blur(7px);border-bottom:1px solid #14532d;padding:10px 0 12px;margin-bottom:6px}
.toprow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.clockbox{text-align:right;color:#67e8f9;font-size:13px;line-height:1.6}
.clockbox b{color:#4ade80;font-size:17px;text-shadow:0 0 9px rgba(74,222,128,.55)}
.filterbar{position:sticky;top:86px;z-index:20;background:rgba(10,14,18,.95);padding:9px 0;border-bottom:1px dashed #14532d}
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
.verdict{color:#fef08a;font-size:13px;line-height:1.55;border-left:3px solid #facc15;padding-left:9px}
.btn,.fbtn{background:#052e16;color:#4ade80;border:1px solid #22c55e;border-radius:6px;padding:8px 14px;cursor:pointer;font-family:inherit;font-size:13px;margin:0 6px 8px 0}
.btn:hover,.fbtn:hover{background:#14532d}.fbtn.on{background:#22c55e;color:#04120a;font-weight:700}
input[type=search]{background:#04120a;border:1px solid #14532d;color:#c9f7d4;border-radius:6px;padding:8px 10px;font-family:inherit;min-width:230px}
.empty{border:1px dashed #14532d;padding:22px;color:#a7f3d0;line-height:1.7;border-radius:6px}
.muted{color:#5f7a68;font-size:12px;line-height:1.7}
a{color:#67e8f9}
</style></head><body><div class="wrap">
<div class="topbar"><div class="toprow">
<div><h1>◢ GitHub 情报中心</h1><div class="sub">GITHUB INTEL CENTER // 开源情报巡检 · 规则研判 · 非 AI 生成</div></div>
<div class="clockbox"><div>北京时间 CST <b id="clock">--:--:--</b></div><div>巡检状态：${meta? (meta.ok? "✅ 正常": "⚠️ 异常") + " · " + esc(fmtCST(meta.ts)): "尚无数据"} · 通道 ${meta? (meta.channelsOk?? "-"): "-"}/${channels.length}</div></div>
</div></div>
<div class="ticker"><span>${esc(tickerText)} &nbsp;///&nbsp; ${esc(tickerText)}</span></div>
<div class="kpis">
<div class="kpi"><span>监控仓库数</span><b>${repos.length}</b></div>
<div class="kpi"><span>本轮新增</span><b>${newCount}</b></div>
<div class="kpi"><span>最高热度</span><b>${topHeat}</b></div>
<div class="kpi"><span>情报通道数</span><b>${channels.length}</b></div>
<div class="kpi"><span>重点监控种子</span><b>${SEEDS.length}</b></div>
<div class="kpi"><span>上次巡检 (CST)</span><b style="font-size:15px;padding-top:8px">${meta? esc(fmtCST(meta.ts)): "-"}</b></div>
</div>
<div>
<button class="btn" onclick="doRefresh(this)">↻ 立即巡检（30 分钟节流）</button> <span class="rmsg muted"></span>
<a class="btn" href="/api/repos" style="text-decoration:none">/api/repos</a>
<a class="btn" href="/api/stats" style="text-decoration:none">/api/stats</a>
</div>
${empty}
<h2>◢ 情报总览 INTEL OVERVIEW</h2>
<p class="muted">本面板追踪 GitHub 热门仓库：飙升榜按本轮星标增量排序（需至少两轮巡检才有增量），其余按热度分排序。热度分 = 星标规模 + 本轮增量 + 推送新鲜度 + fork 活跃度的规则加权；学习点为关键词规则映射；评级 S ≥70、A ≥45、B 其余。</p>
<h2>◢ 飙升榜 STAR SURGE</h2><div class="grid">${surgeList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 热门新星 NEW STARS</h2><div class="grid">${newStars.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ AI / AGENT 专区</h2><div class="grid">${aiList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 网安 · 红队 · SRC 情报 SECURITY INTEL</h2><div class="grid">${secList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ Skill 生态 SKILL ECOSYSTEM</h2><div class="grid">${skillList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 自媒体全套 CREATOR TOOLKIT</h2><div class="grid">${creatorList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 重点监控 WATCHLIST</h2>
<p class="muted">人工精选种子清单（已预筛）：Skill 生态 / 写作 / 科研 / 自媒体 / 网安五类。种子若被本轮巡检命中，卡片会带其实时 ★、热度与本轮增量；未命中则标注「点名监控中」。种子学习点为人工研判，与规则研判区分。</p>
${seedGroups}
<h2>◢ 全部情报 ALL INTEL</h2>
<div class="filterbar"><div>${filterBtns}</div>
<div><button class="fbtn on" data-gf="all">评级 全部</button><button class="fbtn" data-gf="S">S 级</button><button class="fbtn" data-gf="A">A 级</button><button class="fbtn" data-gf="B">B 级</button><input type="search" id="q" placeholder="🔍 搜仓库名 / 描述 / 语言"><span class="muted" id="shown"></span></div></div>
<div class="grid" id="all-grid">${repos.map((r, i) => repoCard(r, i + 1)).join("")}</div>
<p class="muted">数据源：GitHub Search API（公开接口，未认证时限额约 10 次/分钟、每小时搜索配额有限；配置 GITHUB_TOKEN 可提高）。星标增量需至少两轮巡检对比快照得出，第一轮均为「新入情报库」。本站研判均为规则引擎产出，重点监控种子的学习点为人工撰写，均不构成推荐结论。</p>
</div>
<script>
function doRefresh(btn){
var msg=document.querySelector(".rmsg"); if(msg) msg.textContent="巡检中…（约需数秒）";
if(btn) btn.disabled=true;
fetch("/api/refresh",{method:"POST"}).then(function(r){return r.json()}).then(function(j){
if(j.throttled){ if(msg) msg.textContent="已节流：距上次巡检不足 30 分钟，稍后再试。"; if(btn) btn.disabled=false; return;}
location.reload();
}).catch(function(e){ if(msg) msg.textContent="巡检失败："+e; if(btn) btn.disabled=false;});
}
function tickClock(){ var el=document.getElementById("clock"); if(el) el.textContent=new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}); }
tickClock(); setInterval(tickClock, 1000);
var curFilter="all", curGrade="all";
function applyFilter(){
var q=(document.getElementById("q").value||"").toLowerCase().trim();
var shown=0;
document.querySelectorAll("#all-grid .card").forEach(function(c){
var ok=(curFilter==="all"||(" "+c.dataset.channels+" ").indexOf(" "+curFilter+" ")>=0) && (curGrade==="all"||c.dataset.grade===curGrade) && (!q||c.dataset.name.indexOf(q)>=0);
c.style.display=ok?"":"none"; if(ok) shown++;
});
document.getElementById("shown").textContent=" 当前显示 "+shown+" 个";
}
document.querySelectorAll("[data-filter]").forEach(function(b){ b.addEventListener("click", function(){
curFilter=b.dataset.filter;
document.querySelectorAll("[data-filter]").forEach(function(x){ x.classList.remove("on");});
b.classList.add("on"); applyFilter();
});});
document.querySelectorAll("[data-gf]").forEach(function(b){ b.addEventListener("click", function(){
curGrade=b.dataset.gf;
document.querySelectorAll("[data-gf]").forEach(function(x){ x.classList.remove("on");});
b.classList.add("on"); applyFilter();
});});
document.getElementById("q").addEventListener("input", applyFilter);
applyFilter();
</script>
</body></html>`;
return new Response(html, { headers: { "content-type": "text/html;charset=utf-8"}});
}

function kvErrorPage() {
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>配置错误</title>
<style>body{background:#0a0e12;color:#f87171;font-family:ui-monospace,Menlo,Consolas,monospace;padding:40px}</style></head>
<body><h1>◢ 配置错误</h1><p>KV 未绑定：请给本 Worker 绑定 KV namespace，变量名必须为 <b>INTEL_KV</b>，然后重新部署。</p></body></html>`;
return new Response(html, { status: 500, headers: { "content-type": "text/html;charset=utf-8"}});
}

// ============================================================
// 【核心模块】路由入口 — 面板、JSON 接口、手动刷新（节流）、Cron 巡检
// ============================================================
export default {
async fetch(request, env) {
const url = new URL(request.url);
if (!env.INTEL_KV) {
if (url.pathname.startsWith("/api/")) return Response.json({ ok: false, error: "KV 未绑定：请绑定变量名 INTEL_KV"}, { status: 500});
return kvErrorPage();
}
if (url.pathname === "/" && request.method === "GET") return renderPanel(env);
if (url.pathname === "/api/repos" && request.method === "GET") {
const latest = await loadJSON(env, CONFIG.kvLatest, { ts: 0, repos: []});
const repos = latest.repos || [];
return Response.json({ ok: true, ts: latest.ts || 0, count: repos.length, repos, watchlist: buildWatchlist(repos)});
}
if (url.pathname === "/api/watchlist" && request.method === "GET") {
const latest = await loadJSON(env, CONFIG.kvLatest, { ts: 0, repos: []});
const watchlist = buildWatchlist(latest.repos || []);
return Response.json({ ok: true, count: watchlist.length, watchlist});
}
if (url.pathname === "/api/stats" && request.method === "GET") {
const meta = await loadJSON(env, CONFIG.kvMeta, null);
return Response.json({ ok: true, meta});
}
if (url.pathname === "/api/refresh" && request.method === "POST") {
const meta = await loadJSON(env, CONFIG.kvMeta, null);
if (meta && meta.ts && Date.now() - meta.ts < CONFIG.refreshThrottleMs) {
return Response.json({ ok: true, throttled: true, lastSweep: meta.ts, retryAfterMs: CONFIG.refreshThrottleMs - (Date.now() - meta.ts)});
}
const result = await runSweep(env);
return Response.json({ ok: result.ok!== false, throttled: false, sweep: result});
}
return new Response("not found", { status: 404});
},
async scheduled(event, env, ctx) {
// Cron 巡检不走手动节流（Cron 间隔本身远大于 30 分钟）
ctx.waitUntil(runSweep(env));
},
};
