const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const sessionFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
let sessionState = new Map();
let sessionLogReady = false;
let sessionRenderSignature = "";
let sessionRefreshInFlight = false;
let statusRefreshInFlight = false;

function number(value, digits = 0) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function uptime(seconds) {
  if (!Number.isFinite(Number(seconds))) return "—";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return [days ? `${days}天` : "", `${hours}时`, `${minutes}分`].filter(Boolean).join(" ");
}

function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatter.format(date);
}

function sessionTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : sessionFormatter.format(date);
}

function formatSessionDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "—";
  const total = Math.floor(Number(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}天 ${hours}时`;
  if (hours) return `${hours}时 ${minutes}分`;
  if (minutes) return `${minutes}分`;
  return `${total}秒`;
}

function sessionDuration(session) {
  if (session?.unresolved || session?.endBefore) return "无法确定";
  if (session?.durationSeconds != null && Number.isFinite(Number(session.durationSeconds))) return formatSessionDuration(session.durationSeconds);
  const start = Date.parse(session?.joinedAt);
  const end = session?.leftAt ? Date.parse(session.leftAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  return formatSessionDuration(Math.floor((end - start) / 1000));
}

function health(tps) {
  if (!Number.isFinite(Number(tps))) return { label: "NO DATA", className: "unknown" };
  if (tps >= 19) return { label: "STABLE", className: "stable" };
  if (tps >= 16) return { label: "CAUTION", className: "caution" };
  return { label: "OVERLOAD", className: "overload" };
}

function renderPlayers(players) {
  const list = $("#playerList");
  if (!players.length) {
    list.innerHTML = '<p class="mc-empty">世界暂时安静，尚无玩家在线。</p>';
    return;
  }
  list.replaceChildren(...players.map((player, index) => {
    const article = document.createElement("article");
    article.className = "mc-player";
    const signal = player.latencyMs == null ? "—" : `${player.latencyMs} ms`;
    article.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><div><strong></strong><small>PLAYER // ACTIVE</small></div><em>${signal}</em>`;
    article.querySelector("strong").textContent = player.name;
    return article;
  }));
}

function renderPlayerSessions(result) {
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  const nextState = new Map(sessions.map((session) => [String(session.id), session.online ? "online" : `closed:${session.leftAt || session.endBefore || session.endReason || "unknown"}`]));
  if (sessionLogReady) {
    const changes = sessions.flatMap((session) => {
      const id = String(session.id);
      if (!sessionState.has(id)) {
        if (session.online) return [`${session.playerName} 已加入服务器`];
        if (session.leftAt) return [`${session.playerName} 已加入并退出服务器`];
        return [`${session.playerName} 的会话已中断`];
      }
      if (!session.online && sessionState.get(id) === "online") {
        return [`${session.playerName} ${session.unresolved ? "的在线状态暂时无法确认" : session.leftAt ? "已退出服务器" : "的会话已中断"}`];
      }
      return [];
    });
    if (changes.length) {
      const remaining = changes.length > 3 ? `；另有 ${changes.length - 3} 条变化` : "";
      $("#sessionAnnouncement").textContent = `${changes.slice(0, 3).join("；")}${remaining}`;
    }
  }
  sessionLogReady = true;
  sessionState = nextState;
  $("#sessionCountBadge").textContent = String(Number(result?.total || sessions.length)).padStart(2, "0");
  $("#sessionLogState").textContent = result?.collectorLive
    ? "FORGE EVENTS // LIVE"
    : result?.collectorState === "degraded"
      ? "FORGE EVENTS // DEGRADED"
      : result?.archiveAvailable
        ? "FORGE EVENTS // ARCHIVE"
        : "FORGE EVENTS // NOT CONNECTED";
  const list = $("#playerSessionLog");
  const signature = JSON.stringify([
    Boolean(result?.available),
    Boolean(result?.collectorLive),
    result?.collectorState,
    ...sessions.map((session) => [
      session.id,
      session.playerName,
      session.joinedAt,
      session.observedAt,
      session.leftAt,
      session.endBefore,
      session.online,
      session.unresolved,
      session.endReason,
      session.durationSeconds,
    ]),
  ]);
  if (signature === sessionRenderSignature) {
    const sessionsById = new Map(sessions.map((session) => [String(session.id), session]));
    list.querySelectorAll(".mc-session-row").forEach((row) => {
      const session = sessionsById.get(row.dataset.sessionId);
      if (session) row.querySelector(".mc-session-duration").textContent = sessionDuration(session);
    });
    return;
  }
  sessionRenderSignature = signature;
  if (!sessions.length) {
    list.innerHTML = `<p class="mc-empty">${result?.available ? "尚未捕获玩家出入记录。" : "玩家事件采集器尚未连接。"}</p>`;
    return;
  }
  list.replaceChildren(...sessions.map((session, index) => {
    const row = document.createElement("article");
    row.className = `mc-session-row ${session.online ? "is-online" : session.unresolved || session.endBefore ? "is-unresolved" : "is-closed"}`;
    row.dataset.sessionId = String(session.id);
    row.innerHTML = `<span class="mc-session-index">${String(index + 1).padStart(2, "0")}</span><div class="mc-session-player"><strong></strong><small>${session.online ? "PLAYER // ONLINE" : session.unresolved || session.endBefore ? "SESSION // UNRESOLVED" : "SESSION // CLOSED"}</small></div><div class="mc-session-times"><span><small>加入</small><time></time></span><i></i><span><small>退出</small><time></time></span></div><em class="mc-session-duration"></em>`;
    row.querySelector(".mc-session-player strong").textContent = String(session.playerName || "未知玩家");
    const times = row.querySelectorAll("time");
    times[0].dateTime = session.joinedAt || session.observedAt || "";
    times[0].textContent = session.joinedAt ? sessionTime(session.joinedAt) : "接入前已在线";
    times[1].dateTime = session.leftAt || session.endBefore || "";
    const estimatedExit = session.endReason === "server-stop";
    times[1].textContent = session.online
      ? "在线中"
      : session.unresolved
        ? "等待采集器恢复"
        : session.endBefore
          ? `早于 ${sessionTime(session.endBefore)}`
          : `${estimatedExit ? "≈ " : ""}${sessionTime(session.leftAt)}`;
    if (estimatedExit) times[1].title = "未捕获到玩家退出事件，以服务器停止时间结算";
    if (session.endBefore) times[1].title = "服务器异常中断，无法确定精确退出时间";
    row.querySelector(".mc-session-duration").textContent = sessionDuration(session);
    return row;
  }));
}

function render(data) {
  document.body.classList.toggle("mc-offline", !data.online);
  $("#statusDot").classList.toggle("online", data.online);
  $("#statusLabel").textContent = data.online ? "节点在线" : "节点离线";
  $("#lastUpdated").textContent = `刷新于 ${time(data.checkedAt)}`;
  $("#telemetryState").textContent = data.online ? "LINK // ACTIVE" : "LINK // LOST";
  $("#packName").textContent = [data.pack?.name, data.pack?.version].filter(Boolean).join(" // ");
  $("#motd").textContent = data.motd || (data.online ? "服务器广播信号为空。" : "无法连接到 Minecraft 游戏端口。");
  $("#serverAddress").textContent = data.address || "地址未公开";
  $("#onlinePlayers").textContent = number(data.onlinePlayers);
  $("#maxPlayers").textContent = `/ ${number(data.maxPlayers)}`;
  $("#serverLatency").textContent = number(data.latencyMs);
  $("#serverTps").textContent = number(data.performance?.tps, 1);
  $("#serverMspt").textContent = number(data.performance?.mspt, 1);
  $("#uptime").textContent = uptime(data.performance?.uptimeSeconds);
  $("#memoryUsed").textContent = Number.isFinite(Number(data.performance?.memoryUsedMb)) ? (Number(data.performance.memoryUsedMb) / 1024).toFixed(1) : "—";
  $("#memoryMax").textContent = `/ ${Number.isFinite(Number(data.performance?.memoryMaxMb)) ? (Number(data.performance.memoryMaxMb) / 1024).toFixed(1) : "—"} GB`;
  $("#gameVersion").textContent = data.version || "—";
  $("#modLoader").textContent = data.modLoader || "—";
  $("#protocolVersion").textContent = data.protocol ?? "—";
  $("#metricsUpdated").textContent = data.performance?.available ? time(data.performance.sampledAt) : "未接入";
  $("#playerCountBadge").textContent = String(data.players?.length || 0).padStart(2, "0");
  renderPlayers(data.players || []);

  const state = health(data.performance?.tps);
  $("#healthBadge").textContent = state.label;
  $("#healthBadge").className = state.className;
  $("#tpsState").textContent = state.className === "stable" ? "游戏刻保持稳定" : state.className === "unknown" ? "等待 JVM 采样" : "服务器负载正在升高";
  $("#tpsGauge").style.width = `${Math.max(0, Math.min(100, Number(data.performance?.tps || 0) * 5))}%`;
  $("#nodeMessage").textContent = data.online
    ? `${data.pack?.name || "Minecraft"} 正在运行，${data.onlinePlayers || 0} 名玩家在线，节点往返延迟 ${data.latencyMs ?? "—"} ms。`
    : "游戏节点当前不可达；页面会每 5 秒自动重新连接。";
}

async function refresh() {
  if (statusRefreshInFlight) return;
  statusRefreshInFlight = true;
  try {
    const response = await fetch("/api/minecraft/status", { cache: "no-store" });
    if (!response.ok) throw new Error("状态接口不可用");
    render(await response.json());
  } catch (error) {
    document.body.classList.add("mc-offline");
    $("#statusLabel").textContent = "遥测中断";
    $("#nodeMessage").textContent = `${error.message}；将在 5 秒后重试。`;
  } finally {
    statusRefreshInFlight = false;
  }
}

async function refreshPlayerSessions() {
  if (sessionRefreshInFlight) return;
  sessionRefreshInFlight = true;
  try {
    const response = await fetch("/api/minecraft/player-log?limit=40", { cache: "no-store" });
    if (!response.ok) throw new Error("玩家日志接口不可用");
    renderPlayerSessions(await response.json());
  } catch (error) {
    $("#sessionLogState").textContent = "SESSION LOG // INTERRUPTED";
  } finally {
    sessionRefreshInFlight = false;
  }
}

$("#copyAddress").addEventListener("click", async () => {
  const button = $("#copyAddress");
  const address = $("#serverAddress").textContent.trim();
  if (!address || address === "地址未公开") return;
  try {
    await navigator.clipboard.writeText(address);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => { button.textContent = "复制连接地址"; }, 1800);
});

refresh();
refreshPlayerSessions();
window.setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 5_000);
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshPlayerSessions();
}, 10_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refresh();
  refreshPlayerSessions();
});
