const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

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
  try {
    const response = await fetch("/api/minecraft/status", { cache: "no-store" });
    if (!response.ok) throw new Error("状态接口不可用");
    render(await response.json());
  } catch (error) {
    document.body.classList.add("mc-offline");
    $("#statusLabel").textContent = "遥测中断";
    $("#nodeMessage").textContent = `${error.message}；将在 5 秒后重试。`;
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
window.setInterval(refresh, 5_000);
