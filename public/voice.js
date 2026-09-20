import { PROFILE_THEMES, DEFAULT_PROFILE_DESIGN, normalizeProfileDesign } from "./voice-design.js?v=20260920-2";

const $ = selector => document.querySelector(selector);
const rooms = [
  { id: "lobby", name: "公共大厅", description: "随时进来坐坐", members: [], capacity: 6 },
  { id: "squad", name: "组队频道", description: "集合，准备出发", members: [], capacity: 6 },
  { id: "lounge", name: "深夜电台", description: "游戏之外，聊点别的", members: [], capacity: 6 }
];
const state = { user: null, csrf: "", rooms, selected: "lobby", call: null, joining: false, muted: false, deafened: false };
let generation = 0;
let avatarDraft;
let avatarPreview;
let heartbeat;
let speakingTimer;
let audioContext;
let designDraft;
let aiDraft = null;
let aiController = null;
let aiInfo = null;
let profileSaving = false;
const peers = new Map();
const themes = new Set(PROFILE_THEMES);

function status(message = "", error = false) { $("#status").textContent = message; $("#status").classList.toggle("error", error); }
async function api(path, body, method = "POST", options = {}) {
  const response = await fetch(`/api/voice/${path}`, {
    method: body === undefined ? "GET" : method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options
  });
  const result = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null; state.csrf = ""; leave({ notify: false });
    }
    if (response.status === 403 && state.user) {
      const refreshed = await fetch("/api/voice/session", { credentials: "same-origin", cache: "no-store" }).then(res => res.ok ? res.json() : null).catch(() => null);
      if (refreshed) { const changed = refreshed.csrf !== state.csrf; state.user = refreshed.user; state.csrf = refreshed.csrf || ""; if (!state.user || changed) leave({ notify: false }); }
    }
    throw Object.assign(new Error(result?.error || "请求失败，请稍后再试"), { status: response.status });
  }
  return result;
}
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function avatar(user, target) {
  target.replaceChildren();
  if (user?.avatarUrl?.startsWith("/api/voice/avatar/") || user?.avatarUrl?.startsWith("data:image/")) {
    const image = document.createElement("img"); image.alt = ""; image.src = user.avatarUrl; target.append(image);
  } else target.textContent = [...(user?.displayName || "?")].slice(0, 1).join("").toUpperCase();
}
function renderProfile(user = state.user) {
  if (!user) return;
  applyProfileDesign($("#profilePreview"), user, "profile-card");
  avatar(user, $("#previewAvatar"));
  $("#previewName").textContent = user.displayName;
  $("#previewHandle").textContent = `@${user.username}`;
  $("#previewBio").textContent = user.bio || "这个人还没有留下简介。";
  const tagline = normalizeProfileDesign(user.design).tagline;
  $("#previewTagline").textContent = tagline;
  $("#previewTagline").hidden = !tagline;
}
function applyProfileDesign(node, user, className) {
  node.className = `${className} theme-${themes.has(user.theme) ? user.theme : "yellow"}`;
  const design = normalizeProfileDesign(user.design);
  for (const key of ["layout", "banner", "font", "surface", "edges", "avatarShape", "motion"]) node.dataset[key] = design[key];
}
function updateProfileForm() {
  if (!state.user) return;
  $("#displayName").value = state.user.displayName; $("#bio").value = state.user.bio; $("#theme").value = state.user.theme;
  avatarDraft = undefined; avatarPreview = undefined; $("#avatarFile").value = "";
  designDraft = normalizeProfileDesign(state.user.design);
  renderProfile();
}
function previewDraft() {
  if (!state.user) return;
  renderProfile({ ...state.user, displayName: $("#displayName").value || state.user.displayName, bio: $("#bio").value, theme: $("#theme").value,
    design: designDraft, ...(aiDraft || {}), avatarUrl: avatarPreview === undefined ? state.user.avatarUrl : avatarPreview });
}
function render() {
  const current = state.rooms.find(room => room.id === state.selected);
  $("#roomName").textContent = current.name; $("#roomDescription").textContent = current.description;
  $("#roomCount").textContent = `${current.members.length} / ${current.capacity}`;
  $("#roomList").replaceChildren(...state.rooms.map(room => {
    const button = element("button", `channel-button${room.id === state.selected ? " active" : ""}`);
    button.type = "button"; button.setAttribute("aria-pressed", String(room.id === state.selected));
    button.append(element("strong", "", room.name), element("span", "", `${room.members.length} 人在线${state.call?.roomId === room.id ? " · 已加入" : ""}`));
    button.addEventListener("click", () => { state.selected = room.id; render(); }); return button;
  }));
  $("#authPanel").hidden = Boolean(state.user);
  $("#profileForm").hidden = !state.user;
  if (!state.user) {
    aiController?.abort(); aiController = null; aiDraft = null; aiInfo = null;
    applyProfileDesign($("#profilePreview"), { theme: "yellow" }, "profile-card");
    avatar(null, $("#previewAvatar")); $("#previewName").textContent = "你的个人面板";
    $("#previewHandle").textContent = "登录后定制"; $("#previewBio").textContent = "给朋友留下一点关于你的线索。";
    $("#previewTagline").textContent = ""; $("#previewTagline").hidden = true;
  }
  updateDesignControls();
  $("#joinPanel").hidden = !state.user || state.call?.roomId === state.selected;
  $("#joinButton").disabled = state.joining;
  $("#joinButton").textContent = state.joining ? "等待麦克风授权…" : state.call ? "切换到这个频道" : "加入语音";
  $("#callBar").hidden = !state.call && !state.joining;
  $("#accountSlot").replaceChildren();
  if (state.user) {
    $("#accountSlot").append(element("strong", "", state.user.displayName), element("span", "", `@${state.user.username}`));
    const logout = element("button", "secondary", "退出账号"); logout.type = "button"; logout.addEventListener("click", logoutUser); $("#accountSlot").append(logout);
  } else $("#accountSlot").append(element("span", "", "注册或登录后加入频道"));
  $("#participants").replaceChildren();
  if (state.user && !current.members.length) {
    const empty = element("div", "empty-channel"); empty.append(element("strong", "", "频道空着，等你开麦。"), element("span", "", "每个频道最多 6 人")); $("#participants").append(empty);
  }
  for (const member of current.members) {
    const card = element("article"); applyProfileDesign(card, member.user, "member-card");
    card.dataset.peerId = member.peerId;
    const face = element("div", "avatar"); avatar(member.user, face);
    const connection = member.peerId === state.call?.peerId ? "你" : state.call?.roomId === current.id ? (peers.get(member.peerId)?.pc.connectionState === "connected" ? "已连接" : "连接中") : "在线";
    card.append(face, element("strong", "", member.user.displayName), element("p", "", member.deafened ? "声音与麦克风已关闭" : member.muted ? "麦克风已静音" : connection));
    if (member.user.bio) card.append(element("p", "member-bio", member.user.bio));
    if (member.user.design?.tagline) card.append(element("p", "profile-tagline", member.user.design.tagline));
    $("#participants").append(card);
  }
  updateCallControls();
}
function updateCallControls() {
  $("#muteButton").disabled = $("#deafenButton").disabled = state.joining || !state.call;
  $("#muteButton").setAttribute("aria-pressed", String(state.muted || state.deafened));
  $("#muteButton").textContent = state.muted || state.deafened ? "麦克风关" : "麦克风开";
  $("#deafenButton").setAttribute("aria-pressed", String(state.deafened));
  $("#deafenButton").textContent = state.deafened ? "声音关" : "声音开";
  if (!state.call) return;
  const connected = [...peers.values()].filter(peer => peer.pc.connectionState === "connected").length;
  const name = state.rooms.find(room => room.id === state.call.roomId)?.name || "语音频道";
  $("#callStatus").textContent = `${name} · ${connected ? `已连接 ${connected} 位朋友` : peers.size ? "正在建立语音连接…" : "等待朋友加入"}`;
}
async function loadRooms() { if (state.user) { state.rooms = (await api("rooms")).rooms; render(); } }
async function logoutUser() {
  try { await leave(); await api("logout", {}); state.user = null; state.csrf = ""; location.reload(); }
  catch (error) { status(error.message, true); }
}
$("#authForm").addEventListener("submit", async event => {
  event.preventDefault(); const action = event.submitter?.value || "login";
  const buttons = $("#authForm").querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
  status(action === "register" ? "正在创建账号…" : "正在登录…");
  try {
    const result = await api(action, { username: $("#username").value, password: $("#password").value });
    state.user = result.user; state.csrf = result.csrf; $("#password").value = ""; updateProfileForm(); render();
    await Promise.all([loadRooms(), loadDesignInfo()]); status(action === "register" ? "账号已创建。你可以先定制面板，或直接加入语音。" : "欢迎回来。");
  } catch (error) { status(error.message, true); } finally { buttons.forEach(button => button.disabled = false); }
});
$("#profileForm").addEventListener("input", previewDraft);
$("#avatarFile").addEventListener("change", async () => {
  const file = $("#avatarFile").files[0]; if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) { status("请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片", true); return; }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const size = Math.min(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256); bitmap.close();
    avatarDraft = canvas.toDataURL("image/jpeg", 0.88); avatarPreview = avatarDraft; previewDraft(); status("头像已预览，点击保存面板生效。");
  } catch { status("这张图片无法读取，请换一张", true); }
});
$("#removeAvatar").addEventListener("click", () => { avatarDraft = null; avatarPreview = null; $("#avatarFile").value = ""; previewDraft(); });
$("#profileForm").addEventListener("submit", async event => {
  event.preventDefault(); if (!aiDraft && !aiController) await saveProfileDraft();
});
async function saveProfileDraft() {
  if (profileSaving || !state.user) return;
  profileSaving = true; updateDesignControls();
  try {
    const result = await api("profile", { displayName: $("#displayName").value, bio: $("#bio").value, theme: $("#theme").value, design: designDraft,
      ...(aiDraft || {}), ...(avatarDraft === undefined ? {} : { avatar: avatarDraft }) }, "PATCH");
    aiDraft = null;
    state.user = result.user; updateProfileForm(); render(); status("个人面板已保存。");
    designMessage("已应用，频道里的朋友现在可以看到你的新面板。");
  } catch (error) { status(error.message, true); } finally { profileSaving = false; updateDesignControls(); }
}
function designMessage(message) { $("#designStatus").textContent = message; }
function updateDesignControls() {
  $("#aiDesignForm").hidden = !state.user || !aiInfo?.enabled;
  $("#generateDesign").disabled = Boolean(aiController || aiDraft || profileSaving) || aiInfo?.remaining === 0;
  $("#generateDesign").textContent = aiController ? "正在设计…" : "生成预览";
  $("#designPrompt").disabled = Boolean(aiController || aiDraft || profileSaving);
  $("#cancelDesign").hidden = !aiController;
  $("#designDecision").hidden = !aiDraft;
  $("#previewState").hidden = !aiDraft;
  $("#profileFields").disabled = Boolean(aiController || aiDraft || profileSaving);
  $("#applyDesign").disabled = $("#discardDesign").disabled = profileSaving;
}
async function loadDesignInfo() {
  const userId = state.user?.id;
  try {
    const info = await api("profile-ai");
    if (state.user?.id !== userId) return;
    aiInfo = info; updateDesignControls();
    if (!aiController && !aiDraft) designMessage(`${info.model || "AI"} · 今日剩余 ${info.remaining} / ${info.dailyLimit} 次`);
  } catch { /* Manual editing and voice remain usable if AI is unavailable. */ }
}
$("#aiDesignForm").addEventListener("submit", async event => {
  event.preventDefault(); if (aiController || aiDraft || profileSaving || !state.user) return;
  const controller = new AbortController(); aiController = controller;
  const userId = state.user.id, csrf = state.csrf;
  updateDesignControls(); designMessage("正在设计面板，通常需要十几秒，最长等待一分钟。语音通话不受影响。");
  try {
    const result = await api("profile-ai", { prompt: $("#designPrompt").value }, "POST", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]) });
    if (aiController !== controller || state.user?.id !== userId || state.csrf !== csrf) return;
    aiDraft = { theme: themes.has(result.draft.theme) ? result.draft.theme : "yellow", bio: result.draft.bio, design: normalizeProfileDesign(result.draft.design) };
    aiInfo = result; previewDraft(); designMessage(`新设计已预览，确认后才会保存。今日还可生成 ${result.remaining} 次。`);
    $("#previewState").hidden = false;
    $("#profilePreview").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
  } catch (error) {
    if (aiController === controller) designMessage(error.name === "AbortError" || error.name === "TimeoutError" ? "生成已取消或超时，原来的面板没有改变。" : error.message);
  } finally {
    if (aiController === controller) {
      aiController = null; updateDesignControls();
      if (state.user?.id === userId) api("profile-ai").then(info => { if (state.user?.id === userId) { aiInfo = info; updateDesignControls(); } }).catch(() => {});
    }
  }
});
$("#cancelDesign").addEventListener("click", () => { aiController?.abort(); });
$("#discardDesign").addEventListener("click", () => { aiDraft = null; previewDraft(); updateDesignControls(); designMessage("已放弃预览，原来的面板没有改变。"); loadDesignInfo(); });
$("#applyDesign").addEventListener("click", () => { if (aiDraft) saveProfileDraft(); });
$("#resetDesign").addEventListener("click", () => {
  designDraft = { ...DEFAULT_PROFILE_DESIGN }; previewDraft(); status("已预览默认布局，点击保存面板生效。");
});

function analyzer(stream) {
  if (!audioContext) return null;
  const source = audioContext.createMediaStreamSource(stream); const node = audioContext.createAnalyser(); node.fftSize = 256; source.connect(node);
  return { source, node, data: new Uint8Array(node.fftSize) };
}
function sendSignal(peer, payload) {
  peer.outgoing = peer.outgoing.catch(() => {}).then(() => {
    if (state.call?.peerId !== peer.self || peer.closed) return;
    return api("signal", { peerId: peer.self, target: peer.id, ...payload });
  });
  peer.outgoing.catch(error => { if (!peer.closed) status(`${error.message}；必要时离开并重新加入频道。`, true); });
  return peer.outgoing;
}
async function offer(peer, restart = false) {
  if (peer.closed || state.call?.peerId !== peer.self || peer.pc.signalingState !== "stable") return;
  await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: restart }));
  if (!peer.closed) await sendSignal(peer, { description: peer.pc.localDescription });
}
function createPeer(member) {
  if (peers.has(member.peerId)) return peers.get(member.peerId);
  const call = state.call;
  if (!call || member.peerId === call.peerId) return null;
  const pc = new RTCPeerConnection({ iceServers: call.iceServers, iceTransportPolicy: call.iceTransportPolicy, bundlePolicy: "max-bundle" });
  const peer = { id: member.peerId, self: call.peerId, order: member.order, pc, outgoing: Promise.resolve(), incoming: Promise.resolve(), candidates: [], closed: false, restarted: false };
  peers.set(peer.id, peer);
  call.stream.getAudioTracks().forEach(track => pc.addTrack(track, call.stream));
  pc.onicecandidate = event => { if (event.candidate) sendSignal(peer, { candidate: event.candidate.toJSON() }); };
  pc.ontrack = event => {
    if (peer.closed) return;
    if (!peer.audio) { peer.audio = document.createElement("audio"); peer.audio.autoplay = true; $("#remoteAudio").append(peer.audio); }
    const stream = event.streams[0] || new MediaStream([event.track]); peer.audio.srcObject = stream; peer.audio.muted = state.deafened;
    peer.meter?.source.disconnect(); peer.meter = analyzer(stream);
    peer.audio.play().catch(() => { $("#audioUnlock").hidden = false; });
  };
  pc.onconnectionstatechange = () => {
    if (peer.closed) return;
    if (pc.connectionState === "failed") {
      if (!peer.restarted && call.order > peer.order) { peer.restarted = true; offer(peer, true).catch(error => status(error.message, true)); }
      else status("部分语音连接失败。点对点模式可能受网络限制，请重新加入或换个网络。", true);
    }
    render();
  };
  return peer;
}
function removePeer(id) {
  const peer = peers.get(id); if (!peer) return;
  peer.closed = true; peer.pc.close(); peer.meter?.source.disconnect();
  if (peer.audio) { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); }
  peers.delete(id);
}
function handleSignal(message) {
  if (!state.call) return;
  const peer = peers.get(message.from) || createPeer({ peerId: message.from, order: message.order });
  if (!peer) return;
  peer.incoming = peer.incoming.then(async () => {
    if (peer.closed) return;
    if (message.description) {
      await peer.pc.setRemoteDescription(message.description);
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (message.description.type === "offer") {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await sendSignal(peer, { description: peer.pc.localDescription });
      }
    } else if (message.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate);
      else peer.candidates.push(message.candidate);
    }
  }).catch(error => { if (!peer.closed) status(`语音协商未完成：${error.message}`, true); });
}
async function updatePresence() {
  const call = state.call; if (!call) return;
  try {
    const result = await api("heartbeat", { peerId: call.peerId, muted: state.muted || state.deafened, deafened: state.deafened });
    if (state.call === call) { state.rooms = result.rooms; render(); }
  } catch (error) {
    if (state.call !== call) return;
    if ([401, 409].includes(error.status)) { await leave(); status("语音会话已结束，请重新加入频道。", true); }
    else status("连接暂时中断，正在等待网络恢复。", true);
  }
}
async function join() {
  if (!state.user || state.joining) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) { status("此浏览器无法开启语音，请使用 HTTPS 地址及最新版 Safari、Chrome 或 Edge。", true); return; }
  const cleanup = leave();
  const run = ++generation; state.joining = true; state.muted = false; state.deafened = false; render(); status(""); $("#callStatus").textContent = "等待麦克风授权…";
  await cleanup;
  if (run !== generation) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (run !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
    const result = await api("join", { roomId: state.selected });
    if (run !== generation) { stream.getTracks().forEach(track => track.stop()); api("leave", { peerId: result.peerId }).catch(() => {}); return; }
    stream.getAudioTracks().forEach(track => track.enabled = !state.muted && !state.deafened);
    state.call = { ...result, stream };
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) {
      try { audioContext = new Context(); audioContext.resume().catch(() => {}); state.call.meter = analyzer(stream); }
      catch { audioContext = null; }
    }
    stream.getAudioTracks()[0].addEventListener("ended", () => { if (state.call?.stream === stream) { leave(); status("麦克风已被关闭，请重新加入。", true); } });
    const events = new EventSource(`/api/voice/events?peer=${encodeURIComponent(result.peerId)}`); state.call.events = events;
    events.addEventListener("members", event => {
      if (run !== generation) return;
      const room = JSON.parse(event.data);
      if (!room.members.some(member => member.peerId === result.peerId)) { leave(); status("你已在其他窗口切换频道，请在当前窗口重新加入。", true); return; }
      state.rooms = state.rooms.map(item => item.id === room.id ? room : item);
      const present = new Set(room.members.map(member => member.peerId));
      for (const id of peers.keys()) if (!present.has(id)) removePeer(id);
      render();
    });
    events.addEventListener("signal", event => { if (run === generation) handleSignal(JSON.parse(event.data)); });
    events.onerror = () => { if (run === generation) status("频道连接正在恢复；若长时间没有声音，请重新加入。", true); };
    for (const member of result.peers) {
      if (run !== generation) return;
      const peer = createPeer(member);
      try { await offer(peer); }
      catch (error) { if (peers.get(member.peerId) === peer) removePeer(member.peerId); if (error.status !== 409 && run === generation) status("一位成员暂时连接不上，其他连接不受影响。", true); }
    }
    if (run !== generation) return;
    heartbeat = setInterval(updatePresence, 15_000);
    speakingTimer = setInterval(() => {
      if (document.hidden || !state.call) return;
      for (const card of $("#participants").querySelectorAll("[data-peer-id]")) {
        const self = card.dataset.peerId === state.call.peerId;
        const meter = self ? state.call.meter : peers.get(card.dataset.peerId)?.meter;
        let speaking = false;
        if (meter && !(self && (state.muted || state.deafened))) { meter.node.getByteTimeDomainData(meter.data); speaking = meter.data.some(value => Math.abs(value - 128) > 9); }
        card.classList.toggle("is-speaking", speaking);
      }
    }, 150);
    status("已进入频道。离开页面或频道时，麦克风会关闭。"); await updatePresence();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (run === generation) { await leave(); status(error.name === "NotAllowedError" ? "没有获得麦克风权限。请在浏览器的网站设置中允许麦克风后再试。" : error.name === "NotFoundError" ? "未找到麦克风，请先连接麦克风。" : error.message, true); }
  } finally { if (run === generation) { state.joining = false; render(); } }
}
async function leave({ notify = true } = {}) {
  generation++; state.joining = false;
  const call = state.call; state.call = null;
  clearInterval(heartbeat); clearInterval(speakingTimer);
  call?.events?.close(); call?.stream?.getTracks().forEach(track => track.stop()); call?.meter?.source.disconnect();
  for (const id of [...peers.keys()]) removePeer(id);
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  $("#audioUnlock").hidden = true;
  if (call) {
    state.rooms = state.rooms.map(room => ({ ...room, members: room.members.filter(member => member.peerId !== call.peerId) }));
    if (notify) await api("leave", { peerId: call.peerId }, "POST", { keepalive: true }).catch(() => {});
  }
  render();
}
$("#joinButton").addEventListener("click", join);
$("#leaveButton").addEventListener("click", async () => { await leave(); status("已离开频道，麦克风已关闭。"); });
$("#muteButton").addEventListener("click", () => { state.muted = !state.muted; applyAudioState(); });
$("#deafenButton").addEventListener("click", () => { state.deafened = !state.deafened; applyAudioState(); });
function applyAudioState() {
  state.call?.stream.getAudioTracks().forEach(track => track.enabled = !state.muted && !state.deafened);
  for (const peer of peers.values()) if (peer.audio) peer.audio.muted = state.deafened;
  updateCallControls(); updatePresence();
}
$("#audioUnlock").addEventListener("click", async () => {
  try { await audioContext?.resume(); await Promise.all([...peers.values()].filter(peer => peer.audio).map(peer => peer.audio.play())); $("#audioUnlock").hidden = true; }
  catch { status("声音仍被浏览器阻止，请检查网站的声音权限。", true); }
});
window.addEventListener("pagehide", () => { aiController?.abort(); leave(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { audioContext?.resume().catch(() => {}); if (state.call) updatePresence(); } });
setInterval(() => { if (!document.hidden && state.user && !state.call && !state.joining) loadRooms().catch(() => {}); }, 15_000);
render();
api("session").then(async result => { state.user = result.user; state.csrf = result.csrf || ""; updateProfileForm(); render(); if (state.user) await Promise.all([loadRooms(), loadDesignInfo()]); }).catch(error => { status(error.message, true); render(); });
