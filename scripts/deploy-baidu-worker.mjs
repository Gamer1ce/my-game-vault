#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const baiduEnvironmentPath = path.join(dataDirectory, "baidu-media.env");
const runtimeBaiduEnvironmentPath = process.env.BAIDU_RUNTIME_ENV
  || path.join(process.env.HOME || "/Users/gamer1ce", "Library/Application Support/GameTimeVault/baidu-media.env");
const ddnsConfigPath = process.env.CLOUDFLARE_DDNS_CONFIG
  || "/Users/gamer1ce/Library/Application Support/GameTimeVault/cloudflare-ddns.json";
const workerTokenService = process.env.CLOUDFLARE_WORKERS_KEYCHAIN_SERVICE
  || "com.gamer1ce.game-time-vault.cloudflare-workers";
const workerTokenAccount = process.env.CLOUDFLARE_WORKERS_KEYCHAIN_ACCOUNT || "gamer1ce.top";
const scriptName = "game-vault-baidu-media";
const allowedOrigin = process.env.BAIDU_PLAYBACK_ORIGIN || "https://gamer1ce.top";
const customHostname = process.env.BAIDU_PROXY_HOSTNAME || "media.gamer1ce.top";

async function keychainPassword(service, account) {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password", "-w", "-a", account, "-s", service
  ]);
  const value = stdout.trim();
  if (!value) throw new Error(`钥匙串 ${service} 中的Token为空`);
  return value;
}

async function cloudflare(token, endpoint, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers }
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`Cloudflare API失败（${response.status}）：${message}`);
  }
  return payload.result;
}

function setEnvironmentValue(source, name, value) {
  const line = `${name}='${String(value).replace(/'/g, "'\\''")}'`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

async function saveLocalConfiguration(proxyUrl, proxyKey) {
  let source = await readFile(baiduEnvironmentPath, "utf8");
  source = setEnvironmentValue(source, "BAIDU_PROXY_URL", proxyUrl);
  source = setEnvironmentValue(source, "BAIDU_PROXY_KEY", proxyKey);
  source = setEnvironmentValue(source, "BAIDU_PLAYBACK_ORIGIN", allowedOrigin);
  const temporary = `${baiduEnvironmentPath}.tmp`;
  await writeFile(temporary, source, { mode: 0o600 });
  await rename(temporary, baiduEnvironmentPath);
  await chmod(baiduEnvironmentPath, 0o600);
  await mkdir(path.dirname(runtimeBaiduEnvironmentPath), { recursive: true, mode: 0o700 });
  await writeFile(runtimeBaiduEnvironmentPath, source, { mode: 0o600 });
  await chmod(runtimeBaiduEnvironmentPath, 0o600);
}

const ddnsConfig = JSON.parse(await readFile(ddnsConfigPath, "utf8"));
const dnsToken = await keychainPassword(ddnsConfig.keychainService, ddnsConfig.keychainAccount);
const zone = await cloudflare(dnsToken, `/zones/${ddnsConfig.zoneId}`);
const accountId = zone.account?.id;
if (!accountId) throw new Error("无法从现有Cloudflare区域读取Account ID");

let workerToken;
try {
  workerToken = process.env.CLOUDFLARE_WORKERS_TOKEN
    || await keychainPassword(workerTokenService, workerTokenAccount);
} catch {
  throw new Error(`缺少独立的Workers Token；请把具有 Workers Scripts: Edit 权限的Token保存到钥匙串服务 ${workerTokenService}`);
}

await cloudflare(workerToken, `/accounts/${accountId}/workers/scripts`);
const subdomain = await cloudflare(workerToken, `/accounts/${accountId}/workers/subdomain`);
if (!subdomain?.subdomain) throw new Error("Cloudflare账号尚未设置workers.dev子域名，请先在Workers控制台完成首次设置");

const existingKey = String(process.env.BAIDU_PROXY_KEY || "").trim();
const proxyKey = existingKey && Buffer.from(existingKey, "base64url").length === 32
  ? existingKey
  : randomBytes(32).toString("base64url");
const moduleSource = await readFile(path.join(root, "cloudflare/baidu-media-proxy/src/index.js"), "utf8");
const metadata = {
  main_module: "main.js",
  compatibility_date: "2026-07-17",
  bindings: [
    { type: "secret_text", name: "PROXY_KEY", text: proxyKey },
    { type: "plain_text", name: "ALLOWED_ORIGIN", text: allowedOrigin }
  ]
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append("main.js", new Blob([moduleSource], { type: "application/javascript+module" }), "main.js");
await cloudflare(workerToken, `/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "PUT", body: form });
await cloudflare(workerToken, `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ enabled: true, previews_enabled: false })
});
await cloudflare(workerToken, `/accounts/${accountId}/workers/domains`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    hostname: customHostname,
    service: scriptName,
    zone_id: ddnsConfig.zoneId,
    zone_name: zone.name
  })
});

const proxyUrl = `https://${customHostname}`;
await saveLocalConfiguration(proxyUrl, proxyKey);
try {
  const health = await fetch(proxyUrl, { redirect: "manual" });
  if (health.status !== 404) console.warn(`Worker已部署，但健康检查返回HTTP ${health.status}`);
} catch {
  console.warn("Worker已部署；自定义域名证书或DNS可能仍在生效，请稍后再次检查。");
}
console.log(`百度流媒体Worker部署完成：${proxyUrl}`);
console.log("代理密钥已作为Cloudflare Secret保存，并写入本机受保护配置；不会上传GitHub。");
