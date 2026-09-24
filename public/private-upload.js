export function createPrivateUploader({ root, onComplete, playing }) {
  const input = root.querySelector('input[type="file"]'), status = root.querySelector('[role="status"]'), progress = root.querySelector('progress');
  const toggle = root.querySelector('[data-upload-toggle]'), cancel = root.querySelector('[data-upload-cancel]');
  let file, task, xhr, busy = false, paused = false, autoPaused = false, generation = 0;
  async function api(url, method = "GET", body) {
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result?.error || "上传请求失败，请稍后继续"), {status:response.status});
    return result;
  }
  function display(text) {
    status.textContent = text; input.disabled = Boolean(file); toggle.hidden = !task; cancel.hidden = !task;
    toggle.textContent = paused ? "继续上传" : "暂停上传"; toggle.disabled = busy && paused;
    progress.hidden = !file;
  }
  function putChunk(chunk, offset) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest(); xhr = request;
      request.open("PUT", `/api/my-media/uploads/${task.id}`); request.timeout = 120000;
      request.setRequestHeader("Content-Type", "application/octet-stream"); request.setRequestHeader("X-Upload-Offset", String(offset));
      request.upload.onprogress = event => { progress.value = Math.min(1, (offset + event.loaded) / file.size); };
      request.onload = () => { let result; try { result = JSON.parse(request.responseText); } catch { result = {}; }
        if (request.status >= 200 && request.status < 300) resolve(result); else reject(new Error(result.error || "上传失败，请继续重试")); };
      request.onerror = request.ontimeout = () => reject(new Error("网络中断，点击继续可从已保存的分块恢复"));
      request.onabort = () => reject(new Error("上传已暂停")); request.send(chunk);
    });
  }
  async function run() {
    if (busy || !file || playing()) return;
    const current = generation; busy = true; paused = false; autoPaused = false;
    display("正在准备上传…");
    try {
      if (!task) task = await api("/api/my-media/uploads", "POST", { filename: file.name, size: file.size });
      else task = await api(`/api/my-media/uploads/${task.id}`);
      while (task.offset < file.size && !paused && !playing() && current === generation) {
        display(`正在上传 ${file.name} · ${Math.floor(task.offset / file.size * 100)}%`);
        task = await putChunk(file.slice(task.offset, task.offset + task.chunkBytes), task.offset);
        progress.value = task.offset / file.size;
      }
      if (paused || playing() || current !== generation) return;
      display("正在校验并保存视频…");
      await api(`/api/my-media/uploads/${task.id}/complete`, "POST");
      file = null; task = null; input.value = ""; display("上传完成，视频已保存到私人硬盘。"); await onComplete();
    } catch (e) {
      paused = true;
      if (!task || e.status === 400 || e.status === 404) {
        if (task) await api(`/api/my-media/uploads/${task.id}`, "DELETE").catch(() => {});
        task = null; file = null; input.value = "";
      }
      display(autoPaused ? "播放期间已暂停上传，关闭视频后自动继续。" : e.message);
    } finally { busy = false; xhr = null; toggle.disabled = false; if (autoPaused && !playing() && task) void run(); }
  }
  function pause(automatic = false) { if (!file || paused) return; paused = true; autoPaused = automatic; xhr?.abort(); display(automatic ? "播放期间已暂停上传，关闭视频后自动继续。" : "已暂停，点击继续可恢复上传。"); }
  input.addEventListener("change", () => {
    if (!input.files[0]) return; file = input.files[0]; progress.value = 0;
    if (!/\.(mp4|mov|m4v|webm)$/i.test(file.name) || file.size < 12 || file.size > 8 * 1024 ** 3) { file = null; input.value = ""; display("请选择不超过 8 GiB 的 MP4、MOV、M4V 或 WebM 视频。"); return; }
    void run();
  });
  toggle.addEventListener("click", () => { if (paused) void run(); else pause(); });
  cancel.addEventListener("click", async () => {
    if (busy) { pause(); display("正在停止当前分块，请稍后再点取消。"); return; }
    try { if (task) await api(`/api/my-media/uploads/${task.id}`, "DELETE"); generation++; task = null; file = null; input.value = ""; paused = false; autoPaused = false; display("上传已取消，不影响原有视频。"); }
    catch(e) { display(e.message); }
  });
  window.addEventListener("beforeunload", event => { if (file) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("pagehide", () => pause());
  return { setPlaying(value) { if (value) pause(true); else if (autoPaused && task && !busy) void run(); }, destroy() { generation++; autoPaused = false; pause(); file = null; task = null; input.value = ""; } };
}
