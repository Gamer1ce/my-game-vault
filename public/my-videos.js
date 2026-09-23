import { arrangeHighlightsForPlayback } from "./highlight-gallery.js?v=20260911-1";
import { createPrivatePlayback } from "./private-playback.js?v=20260923-1";
import { createBackgroundImagePause } from "./playback-priority.js";
const $ = selector => document.querySelector(selector);
let videos = [], visible = 4, playback = null, generation = 0, loading = false;
const imagePause = createBackgroundImagePause([$("#gallery")]);
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
async function api(url, method = "GET") {
  const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) { clearPrivateView(); location.replace("/?login=1"); throw new Error("登录已过期，请重新登录"); }
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "暂时无法读取视频"); }
  return response.status === 204 ? null : response.json();
}
function render() {
  const query = $("#search").value.trim().normalize("NFKC").toLowerCase(), folder = $("#folder").value;
  const filtered = videos.filter(item => (!folder || item.folder === folder) && (!query || `${item.title} ${item.filename}`.normalize("NFKC").toLowerCase().includes(query)));
  $("#gallery").replaceChildren(...filtered.slice(0, visible).map(item => {
    const card = node("article", undefined, "clip"), button = node("button"), image = node("img");
    button.type = "button"; button.setAttribute("aria-label", `播放 ${item.title}`);
    image.alt = ""; image.loading = "lazy"; image.decoding = "async"; image.src = item.posterUrl;
    image.addEventListener("error", () => { image.removeAttribute("src"); }, { once: true });
    const info = node("div", undefined, "clip-info"); info.append(node("h2", item.title), node("p", `${item.folder || "根目录"} · ${(item.size / 1024 / 1024).toFixed(1)} MB`));
    button.append(image, info); button.addEventListener("click", () => openVideo(item)); card.append(button); return card;
  }));
  $("#more").hidden = visible >= filtered.length; $("#collapse").hidden = visible <= 4 || !filtered.length;
  if (videos.length) $("#message").textContent = filtered.length ? "" : "没有找到匹配的视频。";
}
async function load() {
  if (loading || $("#playerDialog").open) return; loading = true; $("#refresh").disabled = true;
  try {
    const result = await api("/api/my-media");
    $("#owner").textContent = `${result.owner}的游戏视频`; document.title = `${result.owner} · 个人视频`;
    videos = arrangeHighlightsForPlayback(result.videos); visible = 4;
    $("#summary").textContent = `${videos.length} 个视频 · 仅当前账号可访问`;
    const selected = $("#folder").value;
    $("#folder").replaceChildren(...["", ...new Set(videos.map(item => item.folder).filter(Boolean))].map(value => { const option = node("option", value || "全部文件夹"); option.value = value; return option; }));
    $("#folder").value = selected;
    $("#message").textContent = !result.available ? "视频硬盘未连接，请联系站长。" : !videos.length ? "片库还是空的。把视频放进你的硬盘后，点击「刷新片库」查看。" : "";
    render();
  } catch (error) { $("#message").textContent = error.message; } finally { loading = false; $("#refresh").disabled = false; }
}
function stopVideo() {
  generation++; const video = $("#video"); video.pause(); playback?.destroy(); playback = null; video.removeAttribute("src"); video.load();
  imagePause.setActive(false);
}
function clearPrivateView() { stopVideo(); videos = []; $("#gallery").replaceChildren(); $("#playerDialog").close(); }
async function openVideo(item) {
  stopVideo(); const current = generation, video = $("#video");
  $("#videoTitle").textContent = item.title; $("#playerMessage").textContent = ""; $("#playerDialog").showModal();
  imagePause.setActive(true);
  playback = createPrivatePlayback(video, item, { message: text => { if (current === generation) $("#playerMessage").textContent = text; } });
}
$("#closePlayer").addEventListener("click", () => $("#playerDialog").close());
$("#playerDialog").addEventListener("close", stopVideo);
$("#search").addEventListener("input", () => { visible = 4; render(); });
$("#folder").addEventListener("change", () => { visible = 4; render(); });
$("#more").addEventListener("click", () => { visible += 8; render(); });
$("#collapse").addEventListener("click", () => { visible = 4; render(); });
$("#refresh").addEventListener("click", load);
$("#logout").addEventListener("click", async () => { try { await api("/api/user/session", "DELETE"); clearPrivateView(); location.replace("/"); } catch (error) { $("#message").textContent = error.message; } });
window.addEventListener("pagehide", clearPrivateView);
window.addEventListener("pageshow", event => { if (event.persisted) load(); });
load();
