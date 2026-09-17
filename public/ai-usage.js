const $ = (id) => document.getElementById(id);
const format = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
let summary;
let loadPending = false;
let privateEpoch = 0;
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options, signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败，请重试");
  return value;
}
function clearConnection() {
  privateEpoch += 1;
  $("connectionDetails").replaceChildren();
  $("connectionDetails").hidden = true;
}
function renderChart() {
  if (!summary) return;
  const metric = $("chartMetric").value;
  const maximum = Math.max(1, ...summary.days.map((day) => day[metric]));
  $("usageChart").replaceChildren(...summary.days.map((day) => {
    const item = document.createElement("div");
    item.className = "usage-day";
    const meter = document.createElement("meter");
    meter.min = 0; meter.max = maximum; meter.value = day[metric];
    meter.title = `${day.day}：${format(day[metric])}`;
    meter.setAttribute("aria-label", meter.title);
    item.append(meter);
    return item;
  }));
  $("usageDays").replaceChildren(...[...summary.days].reverse().map((day) => {
    const row = document.createElement("tr");
    [day.day, day.requests, day.successes, day.failures, day.totalTokens].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = typeof value === "number" ? format(value) : value; row.append(cell);
    });
    return row;
  }));
}
async function loadUsage() {
  if (loadPending) return;
  loadPending = true; $("refreshUsage").disabled = true;
  try {
    summary = await request("/api/ai-usage");
    for (const key of ["requests", "totalTokens", "inputTokens", "outputTokens", "cachedTokens", "failures"]) $(key).textContent = format(summary.totals[key]);
    $("successRate").textContent = summary.totals.requests ? `${(summary.totals.successes / summary.totals.requests * 100).toFixed(1)}%` : "—";
    $("todayRequests").textContent = format(summary.today.requests);
    $("usageStatus").textContent = `更新于 ${new Date(summary.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · 每分钟自动刷新`;
    renderChart();
  } catch (error) { $("usageStatus").textContent = error.message; }
  finally { loadPending = false; $("refreshUsage").disabled = false; }
}
async function checkSession() {
  try {
    const session = await request("/api/security");
    const authenticated = session.publicMode && session.canManage && session.adminAvailable;
    $("usageLogin").hidden = authenticated;
    $("revealConnection").hidden = !authenticated;
    $("logoutUsage").hidden = !authenticated;
    $("privateStatus").textContent = authenticated ? "已登录。连接信息仅在点击后读取；切换到其他页面时自动隐藏。" : "访客仅可查看汇总用量，连接地址与密钥需管理员登录。";
    if (!authenticated) clearConnection();
  } catch { clearConnection(); $("revealConnection").hidden = true; }
}
$("usageLogin").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const data = new FormData(form);
    await request("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
    form.elements.password.value = "";
    await checkSession();
  } catch (error) { $("privateStatus").textContent = error.message; }
  finally { button.disabled = false; }
});
$("logoutUsage").addEventListener("click", async () => {
  clearConnection();
  try {
    const response = await fetch("/api/admin/session", { method: "DELETE", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("退出失败，请重试");
    await checkSession();
  } catch (error) { $("privateStatus").textContent = error.message; }
});
$("revealConnection").addEventListener("click", async () => {
  clearConnection(); const epoch = privateEpoch;
  try {
    const data = await request("/api/ai-usage/connection");
    if (epoch !== privateEpoch || document.hidden) return;
    const details = $("connectionDetails");
    for (const [label, value] of [["Base URL", data.baseUrl], ...data.apiKeys.map((key, i) => [`客户端密钥 ${i + 1}`, key])]) {
      const section = document.createElement("div"); section.className = "usage-secret";
      const heading = document.createElement("p"); heading.textContent = label;
      const code = document.createElement("code"); code.textContent = value || "未配置";
      section.append(heading, code); details.append(section);
    }
    if (!data.apiKeys.length) { const note = document.createElement("p"); note.textContent = "KEEPER 尚未同步客户端密钥。"; details.append(note); }
    const hide = document.createElement("button"); hide.textContent = "隐藏连接信息"; hide.addEventListener("click", clearConnection); details.append(hide);
    details.hidden = false;
    setTimeout(() => { if (privateEpoch === epoch) clearConnection(); }, 60_000);
  } catch (error) { $("privateStatus").textContent = error.message; await checkSession(); }
});
$("refreshUsage").addEventListener("click", loadUsage);
$("chartMetric").addEventListener("change", renderChart);
document.addEventListener("visibilitychange", () => { clearConnection(); if (!document.hidden) { checkSession(); loadUsage(); } });
window.addEventListener("pagehide", clearConnection);
window.addEventListener("pageshow", () => { clearConnection(); checkSession(); });
setInterval(() => { if (!document.hidden) { loadUsage(); checkSession(); } }, 60_000);
loadUsage(); checkSession();
