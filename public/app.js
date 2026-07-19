import { estimatedBufferWait, recommendedBufferTarget, shouldFullyCacheVideo } from "./playback-buffer.js?v=20260717-2";
import {
  playbackCandidates,
  readPreferredPlaybackRoute,
  savePreferredPlaybackRoute,
  selectPlaybackCandidate
} from "./playback-route.js?v=20260717-1";
import { filteredHighlightEntries, highlightCounts, normalizeHighlightType, shuffleHighlights } from "./highlight-gallery.js?v=20260719-1";
import { createHeroSequence } from "./hero-sequence.js?v=20260718-1";

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const HIGHLIGHT_INITIAL_COUNT = 4;
const HIGHLIGHT_PAGE_SIZE = 8;
const state = { games: [], highlights: [], highlightFilter: "video", visibleHighlights: { video: HIGHLIGHT_INITIAL_COUNT, image: HIGHLIGHT_INITIAL_COUNT }, highlightStorage: { available: true, customDirectory: false }, recentActivity: { days: [], totalMinutes: 0 }, guestbook: { messages: [], likes: 0 }, stats: null, platform: "all", query: "", providers: [], connections: [], security: { publicMode: false, canManage: false, adminAvailable: true }, calendarHidden: localStorage.getItem("playlog-calendar-hidden") === "true", activity: { month: currentMonth, days: [] } };
const $ = (selector) => document.querySelector(selector);
const platformNames = { xbox: "Xbox", playstation: "PlayStation", nintendo: "Nintendo", steam: "Steam" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const formatTime = (minutes) => minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60).toLocaleString()}<span>小时 ${minutes % 60 ? `${minutes % 60} 分` : ""}</span>`;
const formatPlainTime = (minutes) => minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
const api = async (url, options = {}) => { const response = await fetch(url, { credentials:"same-origin", ...options }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "请求失败"); } return response.status === 204 ? null : response.json(); };

const heroSequenceTitle = $("#heroSequenceTitle");
const heroSequenceTrigger = $("#heroSequenceTrigger");
const heroSequenceText = $("#heroSequenceText");

function pulseHeroSequence() {
  heroSequenceTitle.classList.remove("is-glitching");
  void heroSequenceTitle.offsetWidth;
  heroSequenceTitle.classList.add("is-glitching");
  window.setTimeout(() => heroSequenceTitle.classList.remove("is-glitching"), 680);
}

const heroSequence = createHeroSequence({
  glitch: pulseHeroSequence,
  transition({ text, state: sequenceState }) {
    heroSequenceText.textContent = text;
    heroSequenceText.dataset.text = text;
    heroSequenceTitle.dataset.state = sequenceState;
    heroSequenceTrigger.setAttribute("aria-label", text);
  }
});

heroSequenceTrigger.addEventListener("click", () => {
  if (!heroSequence.start()) return;
  heroSequenceTrigger.disabled = true;
});

function renderSecurity() {
  $("#importButton").classList.toggle("hidden", !state.security.canManage);
  $("#syncAllFooter").classList.toggle("hidden", !state.security.canManage);
  $("#adminButton").classList.toggle("hidden", !state.security.publicMode || (!state.security.canManage && !state.security.adminAvailable));
  $("#adminButton").textContent = state.security.canManage ? "退出管理" : "管理员登录";
  renderProviders();
}

async function loadSecurity() {
  state.security = await api("/api/security");
  renderSecurity();
}

function platformIcon(platform) {
  const paths = {
    xbox: `M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z`,
    playstation: `M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z`,
    nintendo: `M14.176 24h3.674c3.376 0 6.15-2.774 6.15-6.15V6.15C24 2.775 21.226 0 17.85 0H14.1c-.074 0-.15.074-.15.15v23.7c-.001.076.075.15.226.15zm4.574-13.199c1.351 0 2.399 1.125 2.399 2.398 0 1.352-1.125 2.4-2.399 2.4-1.35 0-2.4-1.049-2.4-2.4-.075-1.349 1.05-2.398 2.4-2.398zM11.4 0H6.15C2.775 0 0 2.775 0 6.15v11.7C0 21.226 2.775 24 6.15 24h5.25c.074 0 .15-.074.15-.149V.15c.001-.076-.075-.15-.15-.15zM9.676 22.051H6.15c-2.326 0-4.201-1.875-4.201-4.201V6.15c0-2.326 1.875-4.201 4.201-4.201H9.6l.076 20.102zM3.75 7.199c0 1.275.975 2.25 2.25 2.25s2.25-.975 2.25-2.25c0-1.273-.975-2.25-2.25-2.25s-2.25.977-2.25 2.25z`,
    steam: `M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z`
  };
  return `<svg class="platform-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="${paths[platform] || "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"}"/></svg>`;
}

document.querySelectorAll("#tabs button[data-platform]").forEach((button) => {
  if (button.dataset.platform !== "all") button.insertAdjacentHTML("afterbegin", platformIcon(button.dataset.platform));
});
document.querySelectorAll("[data-platform-icon]").forEach((holder) => {
  holder.innerHTML = platformIcon(holder.dataset.platformIcon);
});

async function copyPublicId(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      if (!document.execCommand("copy")) throw new Error("copy failed");
      field.remove();
    }
    toast(`已复制：${value}`);
  } catch {
    toast(`请手动添加：${value}`);
  }
}

$("#friendLinks").addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-id]");
  if (button) copyPublicId(button.dataset.copyId);
});

function posterCandidates(game) {
  const urls = [];
  if (game.platform === "steam" && game.externalId) {
    const base = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${game.externalId}`;
    urls.push(`${base}/capsule_616x353.jpg`, `${base}/header.jpg`, `${base}/library_hero.jpg`, game.coverUrl, `${base}/library_600x900_2x.jpg`);
  } else {
    urls.push(game.coverUrl);
  }
  return [...new Set(urls.filter(Boolean))];
}

function scoreLink(game) {
  try {
    const url = new URL(game.scoreUrl);
    const allowed = ["rawg.io", "metacritic.com"];
    return url.protocol === "https:" && allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
  } catch { return null; }
}

function metacriticMarkup(game) {
  if (game.metacriticScore === null || game.metacriticScore === undefined || game.metacriticScore === "") return `<div class="mc-score mc-empty" title="Metacritic 暂无评分"><span>MC</span><strong>—</strong></div>`;
  const score = Number(game.metacriticScore);
  if (!Number.isInteger(score) || score < 0 || score > 100) return `<div class="mc-score mc-empty" title="Metacritic 暂无评分"><span>MC</span><strong>—</strong></div>`;
  const level = score >= 75 ? "high" : score >= 50 ? "mid" : "low";
  const inner = `<span>MC</span><strong>${score}</strong>`;
  const url = scoreLink(game);
  return url
    ? `<a class="mc-score mc-${level}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="查看 Metacritic 评分来源">${inner}</a>`
    : `<div class="mc-score mc-${level}" title="Metacritic 评分">${inner}</div>`;
}

function officialStoreUrl(game) {
  const fallback = {
    steam: game.externalId ? `https://store.steampowered.com/app/${game.externalId}/` : `https://store.steampowered.com/search/?term=${encodeURIComponent(game.title)}`,
    playstation: `https://store.playstation.com/search/${encodeURIComponent(game.title)}`,
    xbox: `https://www.xbox.com/search/results?q=${encodeURIComponent(game.title)}`,
    nintendo: `https://www.nintendo.com/us/search/#q=${encodeURIComponent(game.title)}`
  }[game.platform];
  const candidate = game.storeUrl || fallback;
  try {
    const url = new URL(candidate);
    const allowed = ["steampowered.com", "playstation.com", "xbox.com", "microsoft.com", "nintendo.com"];
    return url.protocol === "https:" && allowed.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : fallback;
  } catch { return fallback; }
}

function posterMarkup(game, className = "") {
  const candidates = posterCandidates(game);
  const data = encodeURIComponent(JSON.stringify(candidates));
  const storeUrl = officialStoreUrl(game);
  return `<a class="poster-link" href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="在 ${platformNames[game.platform]} 官方商店查看 ${escapeHtml(game.title)}" title="前往官方商店"><div class="game-poster ${className}"><span>${platformNames[game.platform]}</span>${candidates.length ? `<img class="poster-image" src="${escapeHtml(candidates[0])}" data-posters="${data}" data-poster-index="0" alt="${escapeHtml(game.title)} 海报" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}<b class="store-hint">打开商店</b></div></a>`;
}

function render() {
  const totals = Object.fromEntries(Object.keys(platformNames).map((platform) => [platform, state.games.filter((game) => game.platform === platform).reduce((sum, game) => sum + game.minutes, 0)]));
  const all = state.games.reduce((sum, game) => sum + game.minutes, 0);
  const summary = state.stats || {
    totalMinutes: all,
    gameCount: state.games.length,
    achievementsEarned: state.games.reduce((sum, game) => sum + Math.max(0, Number(game.achievementsEarned || 0)), 0),
    completedGames: state.games.filter((game) => Number(game.achievementsTotal) > 0 && Number(game.achievementsEarned) >= Number(game.achievementsTotal)).length,
    primaryPlatform: Object.entries(totals).sort((a,b) => b[1] - a[1])[0]?.[0] || null,
    latest: state.games.map((game) => game.updatedAt || "").sort().at(-1)?.slice(0, 10) || null
  };
  const totalMinutes = Math.max(0, Math.round(Number(summary.totalMinutes || 0)));
  const totalPlaytime = `${Math.floor(totalMinutes / 60).toLocaleString()} 小时${totalMinutes % 60 ? ` ${totalMinutes % 60} 分` : ""}`;
  $("#stats").innerHTML = [
    ["总游戏时长", totalPlaytime],
    ["已记录游戏", `${Number(summary.gameCount || 0)} 款`],
    ["已解锁成就", `${Number(summary.achievementsEarned || 0).toLocaleString()} 个`],
    ["全成就游戏", `${Number(summary.completedGames || 0)} 款`],
    ["游玩最多平台", summary.primaryPlatform ? platformNames[summary.primaryPlatform] : "—"],
    ["最近同步日期", summary.latest || "—"]
  ].map(([label,value], index) => `<div class="stat ${index === 0 ? "stat-primary" : ""}"><small class="stat-label">${escapeHtml(label)}</small><strong class="stat-value" data-text="${escapeHtml(value)}" aria-label="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join("");

  const games = state.games.filter((game) => (state.platform === "all" || game.platform === state.platform) && game.title.toLowerCase().includes(state.query));
  $("#games").innerHTML = games.map((game) => `<article class="game platform-${game.platform}">
    ${posterMarkup(game)}
    <div class="game-content"><div class="game-top"><span class="badge">${platformIcon(game.platform)}<span>${platformNames[game.platform]}</span></span><span class="source">${game.source === "manual" ? "历史记录" : game.source === "playstation-library" ? "已拥有" : game.source.endsWith("-sync") ? "官方同步" : "官方文件"}</span></div>
    <h3>${escapeHtml(game.title)}</h3><div class="game-foot"><div><div class="hours ${game.timeStatus === "unknown" ? "hours-unknown" : ""}">${game.timeStatus === "unknown" ? "时长未知" : formatTime(game.minutes)}</div><small>${game.lastPlayed ? `最后游玩 ${game.lastPlayed}` : game.timeStatus === "unknown" ? "Sony 游戏库记录" : "未记录日期"}</small>${Number(game.achievementsEarned) > 0 || Number(game.achievementsTotal) > 0 ? `<small class="achievement-line" title="${Number(game.achievementsTotal) > 0 ? "已解锁 / 总成就" : "OpenXBL 当前未提供该游戏的总成就数"}">◆ 成就 ${Number(game.achievementsEarned || 0)} / ${Number(game.achievementsTotal) > 0 ? Number(game.achievementsTotal) : "—"}</small>` : ""}</div>${metacriticMarkup(game)}</div></div></article>`).join("");
  const publicInstanceEmpty = state.security.publicMode && state.games.length === 0;
  $("#emptyTitle").textContent = publicInstanceEmpty ? "公网实例尚未载入游戏数据" : "还没有官方游戏记录";
  $("#emptyMessage").textContent = publicInstanceEmpty
    ? (state.security.canManage ? "请在此服务器上同步平台，导入官方文件，或者迁移现有 games.db。" : "网站目前是只读的；需要管理员把游戏数据库同步或迁移到这台服务器。")
    : "连接游戏平台，或者导入平台提供的数据文件。";
  $("#empty").classList.toggle("hidden", games.length > 0);
  $("#scoreAttribution").classList.toggle("hidden", !state.games.some((game) => game.metacriticScore !== null && game.metacriticScore !== undefined && Number.isInteger(Number(game.metacriticScore))));
}

async function load() {
  const result = await api("/api/games");
  state.games = result.games.filter((game) => game.timeStatus !== "unknown" && Number(game.minutes) > 0);
  state.stats = result.stats || null;
  render();
}
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2800); }

function renderLikeCount() {
  $("#siteLikeCount").textContent = Math.max(0, Number(state.guestbook.likes || 0)).toLocaleString("zh-CN");
}

function renderDanmaku() {
  const messages = state.guestbook.messages || [];
  const stage = $("#danmakuStage");
  stage.replaceChildren();
  if (!messages.length) return;
  const laneCount = window.matchMedia("(max-width: 560px)").matches ? 1 : 2;
  const fragment = document.createDocumentFragment();
  for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
    const laneMessages = messages.filter((_item, index) => index % laneCount === laneIndex);
    if (!laneMessages.length) continue;
    const lane = document.createElement("div");
    lane.className = "danmaku-lane";
    lane.style.setProperty("--lane", String(laneIndex));
    const track = document.createElement("div");
    track.className = "danmaku-track";
    track.style.setProperty("--duration", `${Math.max(20, laneMessages.length * 5)}s`);
    track.style.setProperty("--delay", `${-laneIndex * 4.5}s`);
    laneMessages.forEach((item) => {
      const bullet = document.createElement("span");
      bullet.className = "danmaku-item";
      bullet.dataset.messageId = String(item.id);
      bullet.title = item.createdAt ? new Date(`${item.createdAt}Z`).toLocaleString() : "玩家留言";
      bullet.textContent = item.message;
      track.append(bullet);
    });
    lane.append(track);
    fragment.append(lane);
  }
  stage.append(fragment);
}

async function loadGuestbook() {
  const result = await api("/api/guestbook");
  const currentIds = state.guestbook.messages.map((item) => item.id).join(",");
  const nextMessages = Array.isArray(result.messages) ? result.messages : [];
  const nextIds = nextMessages.map((item) => item.id).join(",");
  state.guestbook.likes = Number(result.likes || 0);
  renderLikeCount();
  if (currentIds !== nextIds) {
    state.guestbook.messages = nextMessages;
    renderDanmaku();
  }
}

$("#guestbookForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api("/api/guestbook", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    if (result?.message) {
      state.guestbook.messages = [...state.guestbook.messages, result.message].slice(-36);
      form.elements.message.value = "";
      renderDanmaku();
      toast("留言已接入通讯频道");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#guestbookForm").elements.message.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  event.currentTarget.form.requestSubmit();
});

$("#siteLikeButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  state.guestbook.likes += 1;
  renderLikeCount();
  button.classList.remove("is-liked");
  void button.offsetWidth;
  button.classList.add("is-liked");
  try {
    const result = await api("/api/likes", { method:"POST" });
    state.guestbook.likes = Math.max(state.guestbook.likes, Number(result.likes || 0));
    renderLikeCount();
  } catch (error) {
    state.guestbook.likes = Math.max(0, state.guestbook.likes - 1);
    renderLikeCount();
    toast(error.message);
  }
});

const compactGuestbook = window.matchMedia("(max-width: 560px)");
compactGuestbook.addEventListener?.("change", renderDanmaku);
setInterval(() => { if (document.visibilityState === "visible") loadGuestbook().catch(() => {}); }, 30_000);

function compactTime(minutes) {
  const value = Math.max(0, Number(minutes || 0));
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  return `${hours}h${value % 60 ? `${value % 60}m` : ""}`;
}

function renderRecentActivity() {
  const days = state.recentActivity.days || [];
  const maximum = Math.max(1, ...days.map((day) => Number(day.totalMinutes || 0)));
  const platformOrder = ["xbox", "playstation", "nintendo", "steam"];
  $("#recentTotal").textContent = formatPlainTime(Number(state.recentActivity.totalMinutes || 0));
  $("#recentChart").innerHTML = days.map((day, index) => {
    const total = Math.max(0, Number(day.totalMinutes || 0));
    const approximate = Number(day.detectedMinutes || 0) > 0;
    const [year, month, date] = day.date.split("-").map(Number);
    const weekday = "日一二三四五六"[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
    let segmentTop = 100;
    const segments = platformOrder.map((platform) => {
      const minutes = Math.max(0, Number(day.platforms?.[platform] || 0));
      if (!minutes) return "";
      const height = (minutes / maximum) * 100;
      segmentTop -= height;
      return `<rect class="recent-${platform}" x="0" y="${Math.max(0, segmentTop).toFixed(3)}" width="100" height="${height.toFixed(3)}"><title>${platformNames[platform]} ${formatPlainTime(minutes)}</title></rect>`;
    }).join("");
    const detail = total ? `${approximate ? "约 " : ""}${formatPlainTime(total)}` : "没有时长记录";
    return `<div class="recent-day${index === days.length - 1 ? " is-today" : ""}" aria-label="${day.date}，${detail}"><span class="recent-day-total">${total ? `${approximate ? "≈" : ""}${compactTime(total)}` : "—"}</span><div class="recent-bar-track"><svg class="recent-bar-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${segments}</svg></div><span class="recent-date"><b>${String(month).padStart(2, "0")}.${String(date).padStart(2, "0")}</b><small>周${weekday}</small></span></div>`;
  }).join("");
  $("#recentLegend").innerHTML = platformOrder.map((platform) => `<span class="recent-legend-item recent-${platform}">${platformIcon(platform)}${platformNames[platform]}</span>`).join("");
  requestAnimationFrame(() => { const shell = $(".recent-chart-shell"); shell.scrollLeft = shell.scrollWidth; });
}

async function loadRecentActivity() {
  state.recentActivity = await api("/api/activity/recent");
  renderRecentActivity();
}

function safeHighlightUrl(value) {
  return typeof value === "string" && value.startsWith("/media/highlights/") ? value : null;
}

function safePlaybackUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/media/highlights/")) return url.href;
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatFileSize(bytes) {
  const size = Math.max(0, Number(bytes || 0));
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function renderHighlights() {
  const activeType = normalizeHighlightType(state.highlightFilter);
  const counts = highlightCounts(state.highlights);
  const entries = filteredHighlightEntries(state.highlights, activeType);
  const visibleCount = Math.min(state.visibleHighlights[activeType], entries.length);
  $("#highlightCount").textContent = `${activeType === "video" ? "VIDEO" : "CAPTURE"} // ${String(entries.length).padStart(2, "0")}`;
  $("#highlightVideoCount").textContent = String(counts.video);
  $("#highlightImageCount").textContent = String(counts.image);
  document.querySelectorAll("[data-highlight-filter]").forEach((button) => {
    const active = button.dataset.highlightFilter === activeType;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#highlightGrid").innerHTML = entries.slice(0, visibleCount).map(({ item, sourceIndex }) => {
    const url = safeHighlightUrl(item.url);
    if (!url && item.type !== "video") return "";
    const title = escapeHtml(item.title || item.filename || "精彩时刻");
    const date = item.modifiedAt ? new Date(item.modifiedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "日期未知";
    const media = item.type === "video"
      ? `${url ? `<video src="${escapeHtml(`${url}#t=0.001`)}" preload="metadata" muted playsinline aria-label="${title}"></video>` : `<span class="highlight-remote-preview" aria-hidden="true">REMOTE // ORIGINAL</span>`}<span class="highlight-play" aria-hidden="true">▶</span>`
      : `<img src="${escapeHtml(url)}" alt="${title}" loading="lazy" decoding="async">`;
    const remoteLabel = item.type === "video" && item.remoteAvailable ? `<em class="highlight-cloud">${item.storageSource === "baidu" ? "百度云原画" : "云端原画"}</em>` : "";
    return `<article class="highlight-card"><button class="highlight-open" type="button" data-highlight-index="${sourceIndex}" aria-label="查看 ${title}"><span class="highlight-media">${media}</span><span class="highlight-meta"><strong>${title}</strong><small>${item.type === "video" ? "视频" : "截图"} · ${escapeHtml(date)} · ${formatFileSize(item.size)} ${remoteLabel}</small></span></button></article>`;
  }).join("");
  const remaining = Math.max(0, entries.length - visibleCount);
  const loadMore = $("#highlightLoadMore");
  const collapse = $("#highlightCollapse");
  loadMore.classList.toggle("hidden", remaining === 0);
  loadMore.textContent = "显示更多";
  loadMore.setAttribute("aria-label", remaining > 0 ? `显示更多精彩时刻，接下来展示 ${Math.min(HIGHLIGHT_PAGE_SIZE, remaining)} 个` : "所有精彩时刻已显示");
  collapse.classList.toggle("hidden", visibleCount <= HIGHLIGHT_INITIAL_COUNT);
  const emptyTitle = $("#highlightEmpty strong");
  const emptyMessage = $("#highlightEmpty p");
  if (state.highlightStorage.customDirectory && !state.highlightStorage.available) {
    emptyTitle.textContent = "外置媒体库未连接";
    emptyMessage.textContent = "连接保存精彩时刻的外置硬盘，然后刷新页面。";
  } else if (entries.length === 0 && state.highlights.length > 0) {
    const label = activeType === "video" ? "视频" : "截图";
    const alternate = activeType === "video" ? "截图" : "视频";
    emptyTitle.textContent = `暂无${label}`;
    emptyMessage.textContent = `媒体库中还没有${label}，可以切换到“${alternate}”继续查看。`;
  } else if (state.highlightStorage.customDirectory) {
    emptyTitle.textContent = "外置媒体库已接入";
    emptyMessage.textContent = "当前文件夹还没有受支持的游戏截图或视频。";
  } else {
    emptyTitle.textContent = "信号尚未接入";
    emptyMessage.innerHTML = "把游戏截图或视频放进 <code>data/highlights</code>，刷新页面后便会出现在这里。";
  }
  $("#highlightEmpty").classList.toggle("hidden", entries.length > 0);
}

async function loadHighlights() {
  const result = await api("/api/highlights");
  state.highlights = shuffleHighlights(Array.isArray(result.highlights) ? result.highlights : []);
  const counts = highlightCounts(state.highlights);
  state.highlightFilter = counts.video > 0 || counts.image === 0 ? "video" : "image";
  state.visibleHighlights = { video: HIGHLIGHT_INITIAL_COUNT, image: HIGHLIGHT_INITIAL_COUNT };
  state.highlightStorage = { available: result.available !== false, customDirectory: result.customDirectory === true, remoteEnabled: result.remoteEnabled === true, remoteCount: Number(result.remoteCount || 0) };
  renderHighlights();
}

let highlightPlaybackRequest = 0;
let highlightBufferTimer = null;
let highlightBufferAbort = null;
let highlightPlaybackObjectUrl = null;

function stopHighlightBufferTimer() {
  if (highlightBufferTimer) clearInterval(highlightBufferTimer);
  highlightBufferTimer = null;
  if (highlightBufferAbort) highlightBufferAbort.abort();
  highlightBufferAbort = null;
  if (highlightPlaybackObjectUrl) URL.revokeObjectURL(highlightPlaybackObjectUrl);
  highlightPlaybackObjectUrl = null;
}

function bufferedEndAtCurrentTime(video) {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= video.currentTime + 0.25 && video.buffered.end(index) >= video.currentTime) return video.buffered.end(index);
  }
  return 0;
}

function formatBufferClock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return minutes ? `${minutes}分${String(remainder).padStart(2, "0")}秒` : `${remainder}秒`;
}

function mountBufferedVideo(viewer, video, item, playback, playbackUrl, request) {
  const source = document.createElement("span");
  source.className = `highlight-playback-source ${playback.source === "remote" ? "is-remote" : "is-local"}`;
  source.textContent = playback.source === "baidu"
    ? `百度云原画${playback.routeLabel ? ` · ${playback.routeLabel}` : ""}`
    : playback.source === "remote" ? "云端原画" : "本机线路";

  const panel = document.createElement("div");
  panel.className = "highlight-buffer-panel";
  panel.innerHTML = `<div class="highlight-buffer-copy"><strong>预缓存原画</strong><span>正在读取视频索引…</span></div><div class="highlight-buffer-track"><i></i></div><div class="highlight-buffer-actions"><button class="highlight-buffer-play" type="button" disabled>正在预缓存</button><button class="highlight-play-now" type="button">立即播放</button></div>`;
  const status = panel.querySelector(".highlight-buffer-copy span");
  const bar = panel.querySelector(".highlight-buffer-track i");
  const bufferedPlay = panel.querySelector(".highlight-buffer-play");
  const playNow = panel.querySelector(".highlight-play-now");
  const sample = { startedAt: performance.now(), initialEnd: 0, rate: null, playing: false };
  const fullCache = shouldFullyCacheVideo(item.size, playback.source);
  let activePlaybackUrl = playbackUrl;
  const fallbackCandidates = Array.isArray(playback.fallbackCandidates) ? [...playback.fallbackCandidates] : [];

  const updateRouteLabel = (candidate) => {
    if (candidate?.label) source.textContent = `百度云原画 · ${candidate.label}`;
  };

  const nextFallback = () => {
    while (fallbackCandidates.length) {
      const candidate = fallbackCandidates.shift();
      if (candidate?.url && candidate.url !== activePlaybackUrl) {
        activePlaybackUrl = candidate.url;
        updateRouteLabel(candidate);
        return candidate;
      }
    }
    return null;
  };

  const startPlayback = async () => {
    try { await video.play(); } catch { status.textContent = "浏览器阻止了自动播放，请点击视频控制栏中的播放键。"; }
  };

  const update = () => {
    if (request !== highlightPlaybackRequest || !video.isConnected) return;
    const duration = Number(video.duration);
    if (fullCache && highlightPlaybackObjectUrl) {
      bar.style.width = "100%";
      panel.style.setProperty("--buffer-target", "100%");
      status.textContent = sample.playing
        ? "原画已完整缓存，正在从浏览器本地播放。"
        : `原画已完整缓存（${formatFileSize(item.size)}），播放不再受本机上行速度影响。`;
      bufferedPlay.disabled = sample.playing;
      bufferedPlay.textContent = sample.playing ? "正在播放" : "开始播放";
      playNow.hidden = true;
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      status.textContent = "正在读取视频索引…";
      return;
    }
    const bufferedEnd = Math.min(duration, bufferedEndAtCurrentTime(video));
    const elapsed = Math.max(0.001, (performance.now() - sample.startedAt) / 1000);
    if (elapsed >= 2 && bufferedEnd > sample.initialEnd) sample.rate = (bufferedEnd - sample.initialEnd) / elapsed;
    const target = recommendedBufferTarget(duration, sample.rate);
    const ready = bufferedEnd + 0.5 >= target;
    const wait = estimatedBufferWait(target, bufferedEnd, sample.rate);
    bar.style.width = `${Math.min(100, (bufferedEnd / duration) * 100).toFixed(2)}%`;
    panel.style.setProperty("--buffer-target", `${Math.min(100, (target / duration) * 100).toFixed(2)}%`);

    if (sample.playing) {
      status.textContent = `已缓存到 ${formatBufferClock(bufferedEnd)} / ${formatBufferClock(duration)}`;
      bufferedPlay.disabled = true;
      bufferedPlay.textContent = "正在播放";
      playNow.hidden = true;
    } else if (ready) {
      status.textContent = `已缓存 ${formatBufferClock(bufferedEnd)}，达到当前线路的建议值。`;
      bufferedPlay.disabled = false;
      bufferedPlay.textContent = "开始流畅播放";
    } else {
      const estimate = wait === null ? "正在测量线路速度" : `预计还需约 ${formatBufferClock(wait)}`;
      status.textContent = `已缓存 ${formatBufferClock(bufferedEnd)} / 建议 ${formatBufferClock(target)} · ${estimate}`;
      bufferedPlay.disabled = true;
      bufferedPlay.textContent = "正在预缓存";
    }
  };

  bufferedPlay.addEventListener("click", startPlayback);
  video.addEventListener("loadedmetadata", () => { sample.startedAt = performance.now(); sample.initialEnd = bufferedEndAtCurrentTime(video); update(); });
  video.addEventListener("progress", update);
  video.addEventListener("canplay", update);
  video.addEventListener("waiting", () => { status.textContent = "当前缓存不足，正在继续读取原画…"; });
  video.addEventListener("play", () => { sample.playing = true; update(); });
  video.addEventListener("pause", () => { if (!video.ended) { sample.playing = false; update(); } });
  video.addEventListener("error", () => {
    const fallback = nextFallback();
    if (fallback) {
      panel.classList.remove("is-error");
      status.textContent = `当前节点连接中断，正在切换到 ${fallback.label || "备用线路"}…`;
      video.src = fallback.url;
      video.load();
      return;
    }
    panel.classList.add("is-error");
    status.textContent = "浏览器无法解码此文件，或所有媒体线路均已中断。";
  });
  viewer.replaceChildren(video, source, panel);
  stopHighlightBufferTimer();
  if (!fullCache) {
    playNow.addEventListener("click", startPlayback);
    video.src = activePlaybackUrl;
    highlightBufferTimer = setInterval(update, 750);
    video.load();
    update();
    return;
  }

  panel.querySelector(".highlight-buffer-copy strong").textContent = "完整缓存原画";
  status.textContent = `正在缓存 ${formatFileSize(item.size)}，完成后播放不会再消耗本机上行。`;
  panel.style.setProperty("--buffer-target", "100%");
  const controller = new AbortController();
  highlightBufferAbort = controller;
  const cacheOriginal = async (targetUrl = activePlaybackUrl) => {
    try {
      const response = await fetch(targetUrl, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`媒体缓存失败（${response.status}）`);
      const total = Math.max(1, Number(response.headers.get("content-length")) || Number(item.size) || 1);
      let loaded = 0;
      let blob;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          const percent = Math.min(100, (loaded / total) * 100);
          bar.style.width = `${percent.toFixed(2)}%`;
          status.textContent = `已缓存 ${formatFileSize(loaded)} / ${formatFileSize(total)} · ${percent.toFixed(0)}%`;
        }
        blob = new Blob(chunks, { type: response.headers.get("content-type") || "video/mp4" });
      } else {
        blob = await response.blob();
        loaded = blob.size;
      }
      if (request !== highlightPlaybackRequest || !video.isConnected) return;
      highlightBufferAbort = null;
      highlightPlaybackObjectUrl = URL.createObjectURL(blob);
      video.src = highlightPlaybackObjectUrl;
      video.load();
      bar.style.width = "100%";
      status.textContent = `原画已完整缓存（${formatFileSize(loaded)}），现在播放不会因本机上行不足而中断。`;
      bufferedPlay.disabled = false;
      bufferedPlay.textContent = "开始播放";
      playNow.hidden = true;
    } catch (error) {
      if (error.name === "AbortError") return;
      const fallback = nextFallback();
      if (fallback) {
        status.textContent = `当前节点读取失败，正在切换到 ${fallback.label || "备用线路"}…`;
        return cacheOriginal(fallback.url);
      }
      panel.classList.add("is-error");
      status.textContent = `${error.message}，已切换为分段播放。`;
      video.src = activePlaybackUrl;
      video.load();
      highlightBufferTimer = setInterval(update, 750);
      update();
    }
  };
  playNow.addEventListener("click", () => {
    if (highlightBufferAbort) highlightBufferAbort.abort();
    highlightBufferAbort = null;
    video.src = activePlaybackUrl;
    video.load();
    highlightBufferTimer = setInterval(update, 750);
    startPlayback();
  }, { once: true });
  cacheOriginal();
}

async function openHighlight(index) {
  const item = state.highlights[index];
  const url = safeHighlightUrl(item?.url);
  if (!item || (item.type !== "video" && !url)) return;
  const request = ++highlightPlaybackRequest;
  stopHighlightBufferTimer();
  $("#highlightDialogTitle").textContent = item.title || item.filename || "精彩时刻";
  const viewer = $("#highlightViewer");
  if (item.type !== "video") {
    viewer.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || item.filename || "精彩时刻")}">`;
    $("#highlightDialog").showModal();
    return;
  }
  viewer.innerHTML = `<div class="highlight-loading"><strong>正在连接媒体节点</strong><span>校验原画播放地址…</span></div>`;
  $("#highlightDialog").showModal();
  try {
    const parameters = new URLSearchParams({ filename: item.filename, source: item.storageSource || "default" });
    if (item.playbackId) parameters.set("id", item.playbackId);
    const playback = await api(`/api/highlights/playback?${parameters}`);
    if (request !== highlightPlaybackRequest || !$("#highlightDialog").open) return;
    const candidates = playbackCandidates(playback).map((candidate) => ({
      ...candidate,
      url: safePlaybackUrl(candidate.url)
    })).filter((candidate) => candidate.url);
    if (candidates.length > 1) {
      viewer.innerHTML = `<div class="highlight-loading"><strong>正在选择更快的媒体节点</strong><span>同时检测国内与备用线路，只读取 256 KB 测速样本…</span></div>`;
    }
    const selected = await selectPlaybackCandidate(candidates, {
      preferredId: readPreferredPlaybackRoute(sessionStorage)
    });
    if (selected) savePreferredPlaybackRoute(sessionStorage, selected);
    const playbackUrl = selected?.url || safePlaybackUrl(playback.url);
    if (!playbackUrl) throw new Error("播放地址不安全或不可用");
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = false;
    video.preload = "auto";
    video.playsInline = true;
    const fallbackCandidates = candidates.filter((candidate) => candidate.id !== selected?.id);
    mountBufferedVideo(viewer, video, item, {
      ...playback,
      routeLabel: selected?.label,
      fallbackCandidates
    }, playbackUrl, request);
  } catch (error) {
    if (request === highlightPlaybackRequest) viewer.innerHTML = `<div class="highlight-loading is-error"><strong>视频暂时无法播放</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function calendarLevel(total, max) {
  if (!total) return 0;
  return Math.max(1, Math.min(4, Math.ceil((total / Math.max(max, 1)) * 4)));
}

function renderActivity() {
  const [year, month] = state.activity.month.split("-").map(Number);
  $("#activityMonth").textContent = `${year}.${String(month).padStart(2, "0")}`;
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const activityByDate = new Map(state.activity.days.map((day) => [day.date, day]));
  const max = Math.max(0, ...state.activity.days.map((day) => day.totalMinutes));
  const cells = Array.from({ length: offset }, () => `<span class="calendar-spacer"></span>`);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${state.activity.month}-${String(day).padStart(2, "0")}`;
    const activity = activityByDate.get(date);
    const total = activity?.totalMinutes || 0;
    const historical = activity?.historicalCount || 0;
    const approximate = total > 0 && Number(activity?.detectedMinutes || 0) > 0;
    const label = total ? `${approximate ? "约 " : ""}${formatPlainTime(total)}` : historical ? `${historical} 款记录` : "—";
    cells.push(`<button class="calendar-day heat-${calendarLevel(total, max)}${historical && !total ? " has-history" : ""}" data-date="${date}" title="${date} · ${total ? label : historical ? `${historical} 款最后游玩记录` : "无记录"}"><span>${String(day).padStart(2, "0")}</span><strong>${label}</strong></button>`);
  }
  $("#activityCalendar").innerHTML = cells.join("");
  $("#calendarBody").hidden = state.calendarHidden;
  const exactDays = state.activity.days.filter((day) => Number(day.exactMinutes) > 0).length;
  const detectedDays = state.activity.days.filter((day) => Number(day.detectedMinutes) > 0).length;
  const historyRows = state.activity.days.reduce((sum, day) => sum + Number(day.historicalCount || 0), 0);
  const detectedCoverage = detectedDays > 0 ? `累计差值 ${detectedDays} 天` : "累计差值 0 天（尚未检测到新增累计时长）";
  $("#activityCoverage").textContent = `本月覆盖：平台逐日 ${exactDays} 天 · ${detectedCoverage} · 最近游玩 ${historyRows} 条`;
  $("#toggleCalendar").textContent = state.calendarHidden ? "显示日历" : "隐藏日历";
  $("#toggleCalendar").setAttribute("aria-expanded", String(!state.calendarHidden));
}

async function loadActivity() {
  state.activity = await api(`/api/activity?month=${state.activity.month}`);
  renderActivity();
}

function shiftMonth(delta) {
  const [year, month] = state.activity.month.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  state.activity.month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  loadActivity().catch((error) => toast(error.message));
}

function openActivity(date) {
  const day = state.activity.days.find((item) => item.date === date);
  $("#activityDialogTitle").textContent = `${date} // ${day?.totalMinutes ? formatPlainTime(day.totalMinutes) : day?.historicalCount ? `${day.historicalCount} 款记录` : "无记录"}`;
  if (!day?.games?.length) {
    $("#activityDetails").innerHTML = `<div class="no-activity"><span>00:00</span><p>这一天没有检测到新的累计时长。日历从本版本启用后开始记录。</p></div>`;
  } else {
    const groups = Object.entries(day.games.reduce((result, game) => {
      (result[game.platform] ||= []).push(game); return result;
    }, {}));
    const hasHistoricalOnly = day.games.some((game) => game.eventType === "lastPlayed" && !game.minutes);
    const hasDetected = day.games.some((game) => game.precision === "detected" && game.minutes);
    const explanation = [
      hasDetected ? "“同步检测”是累计时长相对上次同步的增量，并优先归到平台返回的最近游玩日期。" : "",
      hasHistoricalOnly ? "“最近玩过”只能确认日期，无法还原当日分钟数。" : ""
    ].filter(Boolean).join("");
    $("#activityDetails").innerHTML = `${explanation ? `<p class="activity-explainer">${explanation}</p>` : ""}${groups.map(([platform, games]) => `<section class="activity-platform"><div class="activity-platform-head"><strong>${platformIcon(platform)}${platformNames[platform]}</strong><span>${games.some((game) => game.minutes > 0) ? formatPlainTime(games.reduce((sum, game) => sum + game.minutes, 0)) : `${games.length} 款记录`}</span></div>${games.map((game) => `<div class="activity-game">${posterMarkup(game, "activity-poster")}<div><strong>${escapeHtml(game.title)}</strong><small>${platformNames[game.platform]}</small></div><div class="activity-time ${game.minutes ? "" : "history-label"}"><b>${game.minutes ? `${game.precision === "exact" ? "当日确切" : "同步检测"} ${formatPlainTime(game.minutes)}` : "当日时长未知"}</b><small>${Number(game.lifetimeMinutes) > 0 ? `累计 ${formatPlainTime(Number(game.lifetimeMinutes))}` : "累计时长暂无官方数据"}</small></div></div>`).join("")}</section>`).join("")}`;
  }
  $("#activityDialog").showModal();
}

$("#importButton").addEventListener("click", () => { $("#importForm").reset(); $("#importError").textContent = ""; $("#importDialog").showModal(); });
$("#prevYear").addEventListener("click", () => shiftMonth(-12));
$("#prevMonth").addEventListener("click", () => shiftMonth(-1));
$("#nextMonth").addEventListener("click", () => shiftMonth(1));
$("#nextYear").addEventListener("click", () => shiftMonth(12));
$("#toggleCalendar").addEventListener("click", () => {
  state.calendarHidden = !state.calendarHidden;
  localStorage.setItem("playlog-calendar-hidden", String(state.calendarHidden));
  renderActivity();
});
$("#activityCalendar").addEventListener("click", (event) => { const button = event.target.closest("button[data-date]"); if (button) openActivity(button.dataset.date); });
$("#highlightGrid").addEventListener("click", (event) => { const button = event.target.closest("button[data-highlight-index]"); if (button) openHighlight(Number(button.dataset.highlightIndex)); });
$("#highlightFilters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-highlight-filter]");
  if (!button || button.dataset.highlightFilter === state.highlightFilter) return;
  state.highlightFilter = normalizeHighlightType(button.dataset.highlightFilter);
  renderHighlights();
});
$("#highlightLoadMore").addEventListener("click", () => { state.visibleHighlights[state.highlightFilter] += HIGHLIGHT_PAGE_SIZE; renderHighlights(); });
$("#highlightCollapse").addEventListener("click", () => {
  state.visibleHighlights[state.highlightFilter] = HIGHLIGHT_INITIAL_COUNT;
  renderHighlights();
  requestAnimationFrame(() => $("#highlights").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
});
$("#highlightDialog").addEventListener("close", () => { highlightPlaybackRequest += 1; stopHighlightBufferTimer(); const video = $("#highlightViewer video"); if (video) video.pause(); $("#highlightViewer").replaceChildren(); });
$("#tabs").addEventListener("click", (event) => { const button = event.target.closest("button"); if (!button) return; $("#tabs .active").classList.remove("active"); button.classList.add("active"); state.platform = button.dataset.platform; render(); });
$("#search").addEventListener("input", (event) => { state.query = event.target.value.trim().toLowerCase(); render(); });

$("#games").addEventListener("error", (event) => handlePosterError(event), true);
$("#activityDetails").addEventListener("error", (event) => handlePosterError(event), true);
function handlePosterError(event) {
  const image = event.target.closest?.("img.poster-image");
  if (!image) return;
  let candidates = [];
  try { candidates = JSON.parse(decodeURIComponent(image.dataset.posters || "%5B%5D")); } catch { image.remove(); return; }
  const next = Number(image.dataset.posterIndex || 0) + 1;
  if (next < candidates.length) { image.dataset.posterIndex = String(next); image.src = candidates[next]; }
  else image.remove();
}

document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close-dialog]");
  if (close) close.closest("dialog")?.close();
  if (event.target instanceof HTMLDialogElement) event.target.close();
});

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button[type=submit]"); button.disabled = true; button.textContent = "正在导入…";
  try { const result = await api("/api/import", { method:"POST", body:new FormData(form) }); $("#importDialog").close(); await Promise.all([load(), loadActivity(), loadRecentActivity()]); toast(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条`); } catch (error) { $("#importError").textContent = error.message; } finally { button.disabled = false; button.textContent = "开始导入"; }
});

function renderProviders() {
  $("#providerList").innerHTML = state.providers.map((provider) => {
    const connection = state.connections.find((item) => item.provider === provider.id) || { connected:false };
    const canConnect = Object.keys(platformNames).includes(provider.id) || provider.id === "rawg";
    const actions = state.security.canManage
      ? (connection.connected ? `<button class="small-button sync-provider">立即同步</button><button class="small-button danger disconnect-provider">断开</button>` : `<button class="small-button connect-provider" ${canConnect ? "" : "disabled"}>${canConnect ? "连接" : "即将支持"}</button>`)
      : `<span class="visitor-note">只读展示</span>`;
    return `<div class="provider" data-provider="${provider.id}"><strong>${provider.name}</strong>
      <span class="status ${connection.connected ? "connected" : ""}">${connection.connected ? "已连接" : provider.status}</span>
      <p>${provider.detail}${connection.mode ? `<span class="connection-meta">连接方式：${connection.mode === "play-activity" ? "账号游戏记录" : "家长监护"}</span>` : ""}${connection.lastSyncAt ? `<span class="connection-meta">最后同步：${new Date(connection.lastSyncAt).toLocaleString()} · ${connection.itemCount} 款</span>` : ""}${connection.lastError ? `<span class="connection-meta error-meta">错误：${escapeHtml(connection.lastError)}</span>` : ""}</p>
      <div class="provider-actions">${actions}</div></div>`;
  }).join("");
}

async function loadConnections() {
  const [providerData, connectionData] = await Promise.all([api("/api/providers"), api("/api/connections")]);
  state.providers = providerData.providers; state.connections = connectionData.connections; renderProviders();
}

function openConnection(provider) {
  const form = $("#connectForm"); form.reset(); form.elements.provider.value = provider; $("#connectError").textContent = "";
  form.querySelector("button[type=submit]").textContent = "连接并同步";
  if (provider === "playstation") {
    $("#connectTitle").textContent = "连接 PlayStation";
    $("#connectInstructions").innerHTML = `<ol class="steps"><li>在浏览器登录 <a href="https://www.playstation.com/" target="_blank" rel="noreferrer">PlayStation 官网</a>。</li><li>保持登录状态，打开 <a href="https://ca.account.sony.com/api/v1/ssocookie" target="_blank" rel="noreferrer">Sony NPSSO 页面</a>。</li><li>复制 JSON 中 <code>npsso</code> 的值并粘贴到下方。</li></ol><p class="warning">NPSSO 等同账号密码，只会提交到本机并加密保存。</p>`;
    $("#connectFields").innerHTML = `<label>NPSSO<input name="npsso" type="password" autocomplete="off" required minlength="32" placeholder="粘贴 NPSSO 令牌"></label>`;
  } else if (provider === "xbox") {
    $("#connectTitle").textContent = "连接 Xbox";
    $("#connectInstructions").innerHTML = `<ol class="steps"><li>打开 <a href="https://xbl.io/" target="_blank" rel="noreferrer">OpenXBL</a> 并登录 Xbox。</li><li>创建或复制 Personal API Key。</li><li>将 Key 粘贴到下方，无需 Azure。</li></ol><p class="warning">OpenXBL 是第三方网关，API Key 只在本机加密保存。</p>`;
    $("#connectFields").innerHTML = `<label>OpenXBL API Key<input name="apiKey" type="password" autocomplete="off" required minlength="16" placeholder="粘贴 Personal API Key"></label>`;
  } else if (provider === "nintendo") {
    $("#connectTitle").textContent = "连接 Nintendo";
    $("#connectInstructions").innerHTML = `<ol class="steps"><li>推荐选择“账号游戏记录”，它不要求家长监护，可读取累计时长和最近每日时长。</li><li>打开 Nintendo 官方账号授权页并登录。</li><li>长按或右键“选择此人”，复制完整回跳链接。</li></ol><p class="warning">使用 Nintendo Store 3.x 的非公开接口；平台再次改版时可能需要更新。</p>`;
    $("#connectFields").innerHTML = `<input type="hidden" name="stage" value="start"><label>读取方式<select name="nintendoMode"><option value="play-activity">账号游戏记录（推荐，无需家长监护）</option><option value="parental">家长监护日报与月报</option></select></label>`;
    form.querySelector("button[type=submit]").textContent = "打开 Nintendo 登录页";
  } else if (provider === "steam") {
    $("#connectTitle").textContent = "连接 Steam";
    $("#connectInstructions").innerHTML = `<ol class="steps"><li>打开 <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">Steam Web API Key</a> 页面，域名填写 <code>localhost</code>。</li><li>复制 32 位 Key。</li><li>填写 SteamID64 或个人主页。</li><li>把“游戏详情”设为公开。</li></ol><p class="warning">Key 只在本机加密保存。</p>`;
    $("#connectFields").innerHTML = `<label>Steam Web API Key<input name="apiKey" type="password" autocomplete="off" required minlength="32" maxlength="32" placeholder="32 位 Steam Web API Key"></label><label>SteamID64 或个人主页<input name="identity" autocomplete="off" required placeholder="7656119… / 自定义名称 / 主页链接"></label>`;
  } else if (provider === "rawg") {
    $("#connectTitle").textContent = "连接 MC 评分";
    $("#connectInstructions").innerHTML = `<ol class="steps"><li>打开 <a href="https://rawg.io/apidocs" target="_blank" rel="noreferrer">RAWG API 页面</a>并注册免费账号。</li><li>在 API 页面生成并复制 Key。</li><li>粘贴到下方，程序会先匹配 RAWG，缺分时再核对 Metacritic 公开游戏页。</li></ol><p class="warning">首次匹配游戏较多时需要等待一会儿。Key 只在本机加密保存。</p>`;
    $("#connectFields").innerHTML = `<label>RAWG API Key<input name="apiKey" type="password" autocomplete="off" required minlength="16" maxlength="128" placeholder="粘贴 RAWG API Key"></label>`;
  }
  $("#connectDialog").showModal();
}

$("#providerList").addEventListener("click", async (event) => {
  const card = event.target.closest(".provider"); const button = event.target.closest("button"); if (!card || !button) return;
  const provider = card.dataset.provider;
  if (button.classList.contains("connect-provider")) return openConnection(provider);
  if (button.classList.contains("sync-provider")) {
    button.disabled = true; button.textContent = "同步中…";
    try { const result = await api(`/api/connections/${provider}/sync`, { method:"POST" }); await Promise.all([load(), loadConnections(), loadActivity(), loadRecentActivity()]); toast(provider === "rawg" ? `已检查 ${result.checked} 款，匹配 ${result.synced} 个 MC 评分` : provider === "nintendo" && result.historyBackfilled ? `已同步 ${result.synced} 款游戏，回填 ${result.historyBackfilled} 款历史` : `已同步 ${result.synced} 款游戏`); } catch (error) { toast(error.message); await loadConnections(); }
  }
  if (button.classList.contains("disconnect-provider") && confirm(`断开 ${provider === "rawg" ? "MC 评分" : platformNames[provider]}？已同步记录会保留。`)) {
    await api(`/api/connections/${provider}`, { method:"DELETE" }); await loadConnections(); toast("平台已断开");
  }
});

$("#connectForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const provider = data.provider; delete data.provider;
  const button = form.querySelector("button[type=submit]"); button.disabled = true; button.textContent = "正在连接并同步…";
  try {
    if (provider === "nintendo" && data.stage === "start") {
      const result = await api("/api/connections/nintendo/start", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ mode:data.nintendoMode }) }); window.open(result.authorizationUrl, "_blank", "noopener");
      $("#connectInstructions").innerHTML = `<p class="hint">登录后长按或右键“选择此人”复制链接，再粘贴到下方。</p>`;
      $("#connectFields").innerHTML = `<input type="hidden" name="stage" value="complete"><label>Nintendo 回跳链接<textarea name="callbackUrl" rows="4" autocomplete="off" required placeholder="${escapeHtml(result.callbackPrefix)}#state=…"></textarea></label>`;
      button.textContent = "完成连接并同步"; toast("请登录并复制回跳链接");
    } else {
      const url = provider === "nintendo" ? "/api/connections/nintendo/complete" : `/api/connections/${provider}`;
      const body = provider === "nintendo" ? { callbackUrl:data.callbackUrl } : data;
      const result = await api(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
      $("#connectDialog").close(); await Promise.all([load(), loadConnections(), loadActivity(), loadRecentActivity()]); toast(provider === "rawg" ? `连接成功，已匹配 ${result.synced} 个 MC 评分` : provider === "nintendo" && result.historyBackfilled ? `连接成功，已同步 ${result.synced} 款并回填 ${result.historyBackfilled} 款历史` : `连接成功，已同步 ${result.synced} 款游戏`);
    }
  } catch (error) { $("#connectError").textContent = error.message; } finally {
    button.disabled = false;
    if (provider !== "nintendo") button.textContent = "连接并同步";
    else if (form.elements.stage?.value === "start") button.textContent = "打开 Nintendo 登录页";
  }
});

$("#adminButton").addEventListener("click", async () => {
  if (state.security.canManage) {
    try {
      await api("/api/admin/session", { method:"DELETE" });
      await Promise.all([loadSecurity(), loadConnections()]);
      toast("已退出管理模式");
    } catch (error) { toast(error.message); }
    return;
  }
  $("#adminForm").reset();
  $("#adminForm").elements.username.value = "admin";
  $("#adminError").textContent = "";
  $("#adminDialog").showModal();
});

$("#adminForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    state.security = await api("/api/admin/session", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
    form.reset();
    $("#adminDialog").close();
    await loadConnections();
    renderSecurity();
    toast("管理模式已解锁");
  } catch (error) { $("#adminError").textContent = error.message; }
  finally { button.disabled = false; }
});

const quickTopButton = $("#quickTopButton");
let quickTopTimer;
let scrollWindowStartY = window.scrollY;
let scrollWindowStartAt = performance.now();
let ignoreFastScrollUntil = 0;

function hideQuickTop() {
  quickTopButton.classList.remove("is-visible");
  quickTopButton.setAttribute("aria-hidden", "true");
  quickTopButton.tabIndex = -1;
}

function showQuickTop() {
  quickTopButton.classList.add("is-visible");
  quickTopButton.setAttribute("aria-hidden", "false");
  quickTopButton.tabIndex = 0;
  clearTimeout(quickTopTimer);
  quickTopTimer = setTimeout(hideQuickTop, 6000);
}

function returnToTop() {
  ignoreFastScrollUntil = performance.now() + 1200;
  hideQuickTop();
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

$("#backToTopFooter").addEventListener("click", returnToTop);
$("#syncAllFooter").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "正在同步…";
  try {
    const result = await api("/api/sync/all", { method:"POST" });
    await Promise.all([load(), loadConnections(), loadActivity(), loadRecentActivity()]);
    const succeeded = result.results.filter((item) => item.ok).length;
    const failed = result.results.length - succeeded;
    if (!result.results.length) toast("暂无已连接的游戏平台");
    else if (failed) toast(`已同步 ${succeeded} 个平台，${failed} 个平台失败`);
    else toast(`已完成 ${succeeded} 个平台的数据同步`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
quickTopButton.addEventListener("click", returnToTop);
window.addEventListener("scroll", () => {
  const time = performance.now();
  const position = window.scrollY;
  if (position < 420) hideQuickTop();
  if (time < ignoreFastScrollUntil) return;
  if (position < scrollWindowStartY || time - scrollWindowStartAt > 220) {
    scrollWindowStartY = position;
    scrollWindowStartAt = time;
    return;
  }
  if (position > 700 && position - scrollWindowStartY > 420) {
    showQuickTop();
    scrollWindowStartY = position;
    scrollWindowStartAt = time;
  }
}, { passive: true });

loadSecurity().then(() => Promise.all([load(), loadConnections(), loadActivity(), loadHighlights(), loadRecentActivity(), loadGuestbook()])).catch((error) => toast(error.message));
