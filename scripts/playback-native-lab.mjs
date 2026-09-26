// Local diagnostic only: bounded 50 Mbps native MP4 playback, never public.
import express from "express";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { resolveHighlightFile } from "../src/highlights.mjs";
import { fileURLToPath } from "node:url";
const [directory, filename] = process.argv.slice(2);
const { file, stats } = resolveHighlightFile(directory, filename);
const app = express();
app.get("/", (_req, res) => res.type("html").send(`<!doctype html><meta charset="utf-8"><title>直连原文件播放测试</title>
<style>body{background:#15171a;color:white;font:18px sans-serif;margin:30px}video{width:720px;max-height:60vh}button{padding:12px}pre{white-space:pre-wrap}</style>
<h1>原文件播放 · 50 Mbps</h1><button>开始 60 秒测试</button><video controls muted playsinline></video><pre>等待开始</pre>
<script type="module">
import {createAdaptiveBuffering} from '/adaptive-buffer.js';import {playableBuffer} from '/playback-health.js';
const v=document.querySelector('video'),out=document.querySelector('pre');let begin=0,waits=0,playing=0,longest=0,runStart=null,done=false,recovery;
const endRun=()=>{if(runStart!==null){longest=Math.max(longest,v.currentTime-runStart);runStart=null}};
const report=()=>{const data={elapsed:Math.round((performance.now()-begin)/1000),played:+v.currentTime.toFixed(1),ahead:+playableBuffer(v).toFixed(1),paused:v.paused,networkState:v.networkState,waits,playing,longest:+Math.max(longest,runStart===null?0:v.currentTime-runStart).toFixed(1),recovering:recovery?.recovering,done};out.textContent=JSON.stringify(data,null,2);return data};
v.addEventListener('waiting',()=>{waits++;endRun()});v.addEventListener('playing',()=>{playing++;runStart=v.currentTime});v.addEventListener('pause',endRun);
document.querySelector('button').onclick=()=>{if(begin)return;begin=performance.now();recovery=createAdaptiveBuffering(v);v.src='/sample.mp4';v.play().catch(console.error);const timer=setInterval(()=>{report();if(performance.now()-begin>=60000){done=true;recovery.destroy();v.pause();clearInterval(timer);fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report())})}},250)};
</script>`));
app.post("/result", express.json({ limit: "4kb" }), (req, res) => { console.log(JSON.stringify(req.body)); res.sendStatus(204); });
app.get("/sample.mp4", async (req, res) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.get("Range") || "");
  const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
  if (start > end || start >= stats.size) return res.status(416).end();
  res.status(match ? 206 : 200).set({ "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...(match ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {}) });
  const controller = new AbortController(); res.on("close", () => controller.abort());
  const stream = createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  let sent = 0; const began = performance.now();
  try { for await (const chunk of stream) {
    sent += chunk.length;
    await delay(Math.max(0, sent / (50e6 / 8) * 1000 - (performance.now() - began)), undefined, { signal: controller.signal });
    if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
  } res.end(); } catch { res.destroy(); } finally { stream.destroy(); }
});
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
const server = app.listen(8418, "127.0.0.1", () => console.log("Native playback lab: http://127.0.0.1:8418"));
process.on("SIGINT", () => { server.closeAllConnections(); server.close(); });
