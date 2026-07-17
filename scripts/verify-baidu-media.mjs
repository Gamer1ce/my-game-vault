import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  baiduMediaConfiguration,
  baiduVideoFiles,
  createAuthorizationUrl,
  exchangeAuthorizationCode,
  getBaiduDownloadLink,
  listBaiduDirectory,
  probeBaiduPlayback
} from "../src/baidu-media.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const tokenPath = path.join(dataDirectory, "baidu-media-token.json");
const action = process.argv[2] || "verify";

function savedToken() {
  if (!existsSync(tokenPath)) return {};
  try { return JSON.parse(readFileSync(tokenPath, "utf8")); } catch { throw new Error("data/baidu-media-token.json 格式无效"); }
}

function saveToken(token) {
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

async function authorize(config) {
  const callback = new URL(config.redirectUri);
  if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname)) {
    throw new Error("自动接收授权仅支持本机 HTTP 回调，例如 http://127.0.0.1:4174/callback");
  }
  const state = randomBytes(24).toString("base64url");
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", config.redirectUri);
    if (requestUrl.pathname !== callback.pathname) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (requestUrl.searchParams.get("state") !== state) throw new Error("OAuth state 不匹配，请重新授权");
      const token = await exchangeAuthorizationCode(config, requestUrl.searchParams.get("code"));
      saveToken({ ...token, saved_at: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>百度网盘授权成功</h1><p>令牌已安全保存在本机，可以关闭这个页面并回到终端。</p>");
      console.log(`\n授权成功，令牌已保存到 ${tokenPath}（不会上传 GitHub）`);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`授权失败：${error.message}`);
      console.error(`\n授权失败：${error.message}`);
    } finally {
      setTimeout(() => server.close(), 100);
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(Number(callback.port || 80), callback.hostname.replace(/^\[|\]$/g, ""), resolve));
  console.log("请在百度开放平台把回调地址配置为：");
  console.log(config.redirectUri);
  console.log("\n然后在浏览器打开下面的授权地址（5分钟内完成）：\n");
  console.log(createAuthorizationUrl(config, state));
  const timer = setTimeout(() => server.close(), 5 * 60_000);
  await new Promise((resolve) => server.once("close", resolve));
  clearTimeout(timer);
}

async function verify(config) {
  const files = await listBaiduDirectory(config);
  const videos = baiduVideoFiles(files);
  console.log(`目录：${config.folder}`);
  console.log(`读取到 ${files.length} 个项目，其中视频 ${videos.length} 个`);
  if (!videos.length) throw new Error("指定目录内没有支持的视频；当前验证格式为 MP4、WebM、MOV、M4V、MKV");
  const selected = config.testFilename
    ? videos.find((item) => item.server_filename === config.testFilename || item.path === config.testFilename)
    : videos[0];
  if (!selected) throw new Error(`没有找到测试视频：${config.testFilename}`);
  console.log(`测试文件：${selected.server_filename}（${(Number(selected.size || 0) / 1024 / 1024).toFixed(1)} MB）`);
  const download = await getBaiduDownloadLink(config, selected.fs_id);
  console.log("已取得临时 dlink（地址和令牌不会输出）");
  const browserProbe = await probeBaiduPlayback(download.url, { origin: config.playbackOrigin });
  console.log(`浏览器直连：HTTP ${browserProbe.status || "失败"}${browserProbe.contentRange ? ` · ${browserProbe.contentRange}` : ""}`);
  console.log(`最终节点：${browserProbe.finalHost || "未知"} · 类型：${browserProbe.contentType || "未知"}`);
  if (browserProbe.rangeSupported) {
    console.log("结论：通过。该文件支持普通浏览器 206 分段读取，可继续验证手机公网播放。");
    return;
  }

  const apiProbe = await probeBaiduPlayback(download.url, { userAgent: "pan.baidu.com" });
  console.log(`百度API下载：HTTP ${apiProbe.status || "失败"}${apiProbe.contentRange ? ` · ${apiProbe.contentRange}` : ""}`);
  if (apiProbe.rangeSupported) {
    console.log("结论：受限。百度API支持 206 分段下载，但普通浏览器被拒绝；只能由能设置百度 User-Agent 的后端代理播放。");
  } else {
    console.log(`结论：未通过。${apiProbe.error || browserProbe.error || "下载节点在两种请求模式下都没有返回 206。"}`);
  }
  process.exitCode = 2;
}

const config = baiduMediaConfiguration(process.env, savedToken());
if (action === "authorize") await authorize(config);
else if (action === "verify") await verify(config);
else throw new Error("未知操作；请使用 authorize 或 verify");
