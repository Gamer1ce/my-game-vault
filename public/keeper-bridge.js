window.__APP_BASE_PATH__ = "/ai-usage";
document.addEventListener("DOMContentLoaded", () => {
  let authenticated = null;
  let dialog;
  let epoch = 0;
  const button = document.getElementById("keeperAdminButton");
  const label = document.getElementById("keeperAccessLabel");
  const close = () => { epoch++; if (dialog) { dialog.close(); dialog.remove(); dialog = null; } };
  async function json(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options, signal: AbortSignal.timeout(10_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }
  async function updateSession() {
    try {
      const data = await json("/api/security");
      const previous = authenticated;
      authenticated = Boolean(data.publicMode && data.canManage && data.adminAvailable);
      if (previous !== null && previous !== authenticated) { close(); location.replace("/ai-usage/"); return; }
      button.textContent = authenticated ? "连接信息" : "管理员登录";
      label.textContent = authenticated ? "管理员 · 公网只读" : "访客 · 汇总用量";
      document.body.dataset.keeperWebsiteRole = authenticated ? "admin" : "guest";
      if (!authenticated) close();
    } catch { authenticated = false; close(); }
  }
  button.addEventListener("click", () => {
    close();
    dialog = document.createElement("dialog"); dialog.className = "keeper-website-dialog";
    const heading = document.createElement("h2"); heading.textContent = authenticated ? "连接信息" : "网站管理员登录";
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const dismiss = document.createElement("button"); dismiss.textContent = "关闭"; dismiss.type = "button"; dismiss.addEventListener("click", close);
    dialog.append(heading, status);
    if (!authenticated) {
      const form = document.createElement("form");
      const passwordLabel = document.createElement("label"); passwordLabel.textContent = "使用游戏网站的管理员密码";
      const password = document.createElement("input"); password.type = "password"; password.autocomplete = "current-password"; password.required = true; password.maxLength = 512; passwordLabel.append(password);
      const submit = document.createElement("button"); submit.textContent = "登录";
      form.append(passwordLabel, submit); dialog.append(form);
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); submit.disabled = true;
        try {
          await json("/ai-usage/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password.value }) });
          password.value = ""; location.assign("/ai-usage/");
        } catch (error) { status.textContent = error.message; submit.disabled = false; }
      });
    } else {
      const current = epoch;
      status.textContent = "正在读取…";
      json("/api/ai-usage/connection").then((data) => {
        if (current !== epoch || !dialog || document.hidden) return;
        status.textContent = "仅管理员可见；一分钟后自动隐藏。";
        for (const [name, value] of [["Base URL", data.baseUrl], ...data.apiKeys.map((key, i) => [`客户端密钥 ${i + 1}`, key])]) {
          const title = document.createElement("p"); title.textContent = name;
          const code = document.createElement("code"); code.textContent = value;
          dialog.insertBefore(title, dismiss); dialog.insertBefore(code, dismiss);
        }
        setTimeout(() => { if (current === epoch) close(); }, 60_000);
      }).catch((error) => { if (current === epoch) status.textContent = error.message; });
      const logout = document.createElement("button"); logout.textContent = "退出管理员";
      logout.addEventListener("click", async () => {
        try {
          const response = await fetch("/api/admin/session", { method: "DELETE", credentials: "same-origin", cache: "no-store" });
          if (!response.ok) throw new Error("退出失败，请重试");
          close(); location.assign("/ai-usage/");
        } catch (error) { status.textContent = error.message; }
      });
      dialog.append(logout);
    }
    dialog.append(dismiss); document.body.append(dialog); dialog.showModal();
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  });
  document.addEventListener("visibilitychange", () => { close(); if (!document.hidden) updateSession(); });
  window.addEventListener("pagehide", close);
  updateSession();
  setInterval(() => { if (!document.hidden) updateSession(); }, 60_000);
});
