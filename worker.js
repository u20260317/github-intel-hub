// ============================================================
// GitHub 情报中心 · GitHub Intel Center（原名情报局，Worker 名/网址不变；v3：11 通道 + 安全细粒度标签体系 + 全部情报分页）
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
const tags = (r.learnTags || []).map((t) => `<button type="button" class="tag tagchip" data-tag="${esc(t)}" title="按此标签筛选全部情报">${esc(t)}</button>`).join("");
const chans = (r.channels || []).join(" ");
const rankHtml = rank? `<span class="rank">#${rank}</span>`: "";
return `<article class="card" data-channels="${esc(chans)}" data-grade="${esc(r.grade || "B")}" data-tags="${esc((r.learnTags || []).join("|"))}" data-name="${esc((r.full_name + " " + (r.description || "")).toLowerCase())}">
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
const srcList = repos.filter((r) => r.channels.includes("src-hunt")).slice(0, 10);
const secLearnList = repos.filter((r) => r.channels.includes("sec-learning")).slice(0, 10);
// 热门标签云：统计安全三通道（security/src-hunt/sec-learning）仓库的标签频次，取前 15
const tagFreq = {};
for (const r of repos) {
if (!(r.channels || []).some((c) => ["security", "src-hunt", "sec-learning"].includes(c))) continue;
for (const t of r.learnTags || []) tagFreq[t] = (tagFreq[t] || 0) + 1;
}
const tagCloud = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 15)
.map(([t, n]) => `<button type="button" class="tag tagchip cloudchip" data-tag="${esc(t)}" title="按此标签筛选全部情报">${esc(t)} · ${n}</button>`).join("");
// 全部情报分页：每页 24 条（与 DEAL HUB 约定一致），服务端先渲染初始页码按钮，筛选后由前端重算
const PAGE_SIZE_SSR = 24;
const totalPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE_SSR));
const pagerBtns = (() => {
const pages = [];
if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) pages.push(i); }
else pages.push(1, 2, "…", totalPages - 1, totalPages);
return pages.map((p) => p === "…"? `<span class="pgdots">…</span>`: `<button class="fbtn pgnum${p === 1? " on": ""}" data-page="${p}">${p}</button>`).join("");
})();
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
button.tag{font-family:inherit;background:transparent}
.tagchip{cursor:pointer;transition:background .2s,box-shadow .2s}.tagchip:hover{background:#164e63;box-shadow:0 0 9px rgba(103,232,249,.45)}
.cloudchip{font-size:13px;padding:3px 12px}
.tagcloud{margin:0 0 14px;line-height:2}
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
<h2>◢ 网安 · 红队 · SRC 情报 SECURITY INTEL</h2>
<h3 class="seedcat">▸ 热门标签 TAG CLOUD（点标签筛选全部情报）</h3><div class="tagcloud" id="tag-cloud">${tagCloud || '<span class="muted">暂无标签数据</span>'}</div>
<div class="grid">${secList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ SRC · 挖洞 SRC HUNTING</h2><div class="grid">${srcList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 网安学习资料 SECURITY LEARNING</h2><div class="grid">${secLearnList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ Skill 生态 SKILL ECOSYSTEM</h2><div class="grid">${skillList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 自媒体全套 CREATOR TOOLKIT</h2><div class="grid">${creatorList.map((r, i) => repoCard(r, i + 1)).join("") || '<p class="muted">暂无数据</p>'}</div>
<h2>◢ 重点监控 WATCHLIST</h2>
<p class="muted">人工精选种子清单（已预筛）：Skill 生态 / 写作 / 科研 / 自媒体 / 网安五类。种子若被本轮巡检命中，卡片会带其实时 ★、热度与本轮增量；未命中则标注「点名监控中」。种子学习点为人工研判，与规则研判区分。</p>
${seedGroups}
<h2 id="all-intel">◢ 全部情报 ALL INTEL</h2>
<div class="filterbar"><div>${filterBtns}</div>
<div><button class="fbtn on" data-gf="all">评级 全部</button><button class="fbtn" data-gf="S">S 级</button><button class="fbtn" data-gf="A">A 级</button><button class="fbtn" data-gf="B">B 级</button><input type="search" id="q" placeholder="🔍 搜仓库名 / 描述 / 语言"><span class="muted" id="shown"></span><span id="tag-pill" class="tagpill" style="display:none">标签：<b id="tag-name"></b> <button class="fbtn" id="tag-clear" type="button">✕ 清除标签</button></span></div></div>
<div class="grid" id="all-grid">${repos.map((r, i) => repoCard(r, i + 1)).join("")}</div>
<div class="pager" id="pager"><button class="fbtn" id="pg-prev" type="button">← 上一页</button><span id="pg-nums">${pagerBtns}</span><button class="fbtn" id="pg-next" type="button">下一页 →</button><span class="muted" id="pg-status"></span></div>
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
var curFilter="all", curGrade="all", curTag="", curPage=1;
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
var nums=document.getElementById("pg-nums");
nums.innerHTML=pageList(curPage,pages).map(function(p){
return p==="…"? '<span class="pgdots">…</span>': '<button class="fbtn pgnum'+(p===curPage?" on":"")+'" data-page="'+p+'">'+p+'</button>';
}).join("");
document.getElementById("pg-status").textContent="第 "+curPage+" / "+pages+" 页 · 共 "+total+" 条（筛选后）";
document.getElementById("pg-prev").disabled=curPage<=1;
document.getElementById("pg-next").disabled=curPage>=pages;
nums.querySelectorAll("[data-page]").forEach(function(b){ b.addEventListener("click", function(){
curPage=parseInt(b.dataset.page,10); applyFilter(false); scrollAll();
});});
}
function applyFilter(reset){
if(reset) curPage=1;
var all=Array.prototype.slice.call(document.querySelectorAll("#all-grid .card"));
var list=all.filter(cardMatches);
var pages=Math.max(1, Math.ceil(list.length/PAGE_SIZE));
if(curPage>pages) curPage=pages;
all.forEach(function(c){ c.style.display="none";});
list.slice((curPage-1)*PAGE_SIZE, curPage*PAGE_SIZE).forEach(function(c){ c.style.display="";});
document.getElementById("shown").textContent=" 当前显示 "+list.length+" 个";
var pill=document.getElementById("tag-pill");
if(curTag){ pill.style.display=""; document.getElementById("tag-name").textContent=curTag;} else { pill.style.display="none";}
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
curTag=ch.dataset.tag; applyFilter(true); scrollAll();
});});
document.getElementById("tag-clear").addEventListener("click", function(){ curTag=""; applyFilter(true);});
document.getElementById("pg-prev").addEventListener("click", function(){ if(curPage>1){ curPage--; applyFilter(false); scrollAll();}});
document.getElementById("pg-next").addEventListener("click", function(){ curPage++; applyFilter(false); scrollAll();});
applyFilter(false);
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
