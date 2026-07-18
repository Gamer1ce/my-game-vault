#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, "aliyun-esa/baidu-media-proxy/src/index.js");
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const privateEnvironmentPath = path.join(dataDirectory, "baidu-media.env");
const runtimeEnvironmentPath = process.env.BAIDU_RUNTIME_ENV
  || path.join(process.env.HOME || "/Users/gamer1ce", "Library/Application Support/GameTimeVault/baidu-media.env");
const cloudflareConfigPath = process.env.CLOUDFLARE_DDNS_CONFIG
  || path.join(process.env.HOME || "/Users/gamer1ce", "Library/Application Support/GameTimeVault/cloudflare-ddns.json");
const profile = process.env.ALIYUN_ESA_PROFILE || "codex-esa";
const region = process.env.ALIYUN_ESA_REGION || "cn-hangzhou";
const routineName = process.env.ALIYUN_ESA_ROUTINE || "game-vault-baidu-media-cn";
const siteId = process.env.ALIYUN_ESA_SITE_ID || "167799079760080";
const hostname = process.env.BAIDU_PROXY_HOSTNAME_CN || "media-cn.gamer1ce.top";
const allowedOrigin = process.env.BAIDU_PLAYBACK_ORIGIN || "https://gamer1ce.top";
const proxyKey = String(process.env.BAIDU_PROXY_KEY || "").trim();
const description = `百度 Range 私密代理 ${new Date().toISOString().slice(0, 10)}`;

function validProxyKey(value) {
  try { return value && Buffer.from(value, "base64url").length === 32; } catch { return false; }
}

if (!validProxyKey(proxyKey)) {
  throw new Error("BAIDU_PROXY_KEY 必须是 32 字节的 Base64URL 密钥");
}
if (!/^https:\/\//.test(allowedOrigin)) throw new Error("BAIDU_PLAYBACK_ORIGIN 必须是 HTTPS Origin");

async function esa(operation, ...parameters) {
  const { stdout } = await execFileAsync("aliyun", [
    "--profile", profile,
    "--region", region,
    "esa",
    operation,
    ...parameters
  ], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

async function cloudflare(token, endpoint, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.map((item) => item.message).join("; ") || response.statusText);
  }
  return payload.result;
}

async function pointPublicDnsToEsa(recordCname) {
  const config = JSON.parse(await readFile(cloudflareConfigPath, "utf8"));
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password", "-w", "-a", config.keychainAccount, "-s", config.keychainService
  ]);
  const token = stdout.trim();
  if (!token) throw new Error("Cloudflare DNS Token 为空");
  const query = new URLSearchParams({ name: hostname });
  const records = await cloudflare(token, `/zones/${config.zoneId}/dns_records?${query}`);
  const body = JSON.stringify({ type: "CNAME", name: hostname, content: recordCname, proxied: false, ttl: 1 });
  if (records[0]) {
    await cloudflare(token, `/zones/${config.zoneId}/dns_records/${records[0].id}`, { method: "PUT", body });
  } else {
    await cloudflare(token, `/zones/${config.zoneId}/dns_records`, { method: "POST", body });
  }
}

async function ensureFreeCertificate() {
  const current = await esa(
    "list-certificates-by-record",
    "--site-id", siteId,
    "--record-name", hostname,
    "--detail", "true",
    "--valid-only", "false"
  );
  const status = String(current.Result?.[0]?.Status || "none").toLowerCase();
  if (status === "none") {
    const applied = await esa(
      "apply-certificate",
      "--site-id", siteId,
      "--domains", hostname,
      "--type", "lets_encrypt"
    );
    return String(applied.Result?.[0]?.Status || "applying").toLowerCase();
  }
  return status;
}

function setEnvironmentValue(source, name, value) {
  const line = `${name}='${String(value).replace(/'/g, "'\\''")}'`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

async function savePrivateConfiguration() {
  let source = await readFile(privateEnvironmentPath, "utf8");
  source = setEnvironmentValue(source, "BAIDU_PROXY_URL_CN", `https://${hostname}`);
  source = setEnvironmentValue(source, "BAIDU_PROXY_KEY_CN", "");
  source = setEnvironmentValue(source, "BAIDU_PLAYBACK_ORIGIN", allowedOrigin);
  source = setEnvironmentValue(source, "BAIDU_MEDIA_ENABLED", "1");
  const temporary = `${privateEnvironmentPath}.tmp`;
  await writeFile(temporary, source, { mode: 0o600 });
  await rename(temporary, privateEnvironmentPath);
  await chmod(privateEnvironmentPath, 0o600);
  await mkdir(path.dirname(runtimeEnvironmentPath), { recursive: true, mode: 0o700 });
  await writeFile(runtimeEnvironmentPath, source, { mode: 0o600 });
  await chmod(runtimeEnvironmentPath, 0o600);
}

const template = await readFile(sourcePath, "utf8");
if (!template.includes("__ESA_PROXY_KEY__") || !template.includes("__ESA_ALLOWED_ORIGIN__")) {
  throw new Error("ESA 源码缺少私密部署占位符");
}
const deployedSource = template
  .replace('PROXY_KEY: "__ESA_PROXY_KEY__"', `PROXY_KEY: ${JSON.stringify(proxyKey)}`)
  .replace('ALLOWED_ORIGIN: "__ESA_ALLOWED_ORIGIN__"', `ALLOWED_ORIGIN: ${JSON.stringify(allowedOrigin)}`);
if (deployedSource.includes("__ESA_PROXY_KEY__") || deployedSource.includes("__ESA_ALLOWED_ORIGIN__")) {
  throw new Error("ESA 私密部署占位符替换失败");
}

const upload = await esa("get-routine-staging-code-upload-info", "--name", routineName, "--code-description", description);
const post = upload.OssPostConfig;
if (!post?.Url) throw new Error("阿里云没有返回函数代码上传地址");
const form = new FormData();
for (const name of ["key", "OSSAccessKeyId", "policy", "Signature", "callback", "x:codeDescription"]) {
  if (post[name]) form.append(name, post[name]);
}
if (post.XOssSecurityToken) form.append("x-oss-security-token", post.XOssSecurityToken);
form.append("file", new Blob([deployedSource], { type: "application/javascript" }), "index.js");
const uploadResponse = await fetch(post.Url, { method: "POST", body: form });
if (!uploadResponse.ok) throw new Error(`函数代码上传失败（HTTP ${uploadResponse.status}）`);

const committed = await esa("commit-routine-staging-code", "--name", routineName, "--code-description", description);
if (!committed.CodeVersion) throw new Error("阿里云没有返回函数代码版本号");
await esa("publish-routine-code-version", "--name", routineName, "--env", "production", "--code-version", committed.CodeVersion);

const records = await esa("list-routine-related-records", "--name", routineName, "--page-number", "1", "--page-size", "100");
const related = records.Records || records.RelatedRecords || records.RoutineRelatedRecords || [];
const alreadyBound = related.some((record) => record.RecordName === hostname || record.RecordName === `https://${hostname}`);
if (!alreadyBound) {
  await esa("create-routine-related-record", "--name", routineName, "--site-id", siteId, "--record-name", hostname);
}
const refreshedRecords = await esa("list-routine-related-records", "--name", routineName, "--page-number", "1", "--page-size", "100");
const refreshedRelated = refreshedRecords.Records || refreshedRecords.RelatedRecords || refreshedRecords.RoutineRelatedRecords || [];
const relation = refreshedRelated.find((record) => record.RecordName === hostname);
if (!relation?.RecordId) throw new Error("阿里云函数域名绑定记录不存在");
const esaRecord = await esa("get-record", "--record-id", String(relation.RecordId));
const recordCname = esaRecord.RecordModel?.RecordCname;
if (!recordCname) throw new Error("阿里云没有返回外部 DNS 所需的 CNAME");
await pointPublicDnsToEsa(recordCname);
const certificateStatus = await ensureFreeCertificate();

await savePrivateConfiguration();
const healthUrl = `https://${hostname}`;
let healthStatus = "证书或 DNS 正在生效";
try {
  const response = await fetch(healthUrl, { redirect: "manual" });
  healthStatus = `HTTP ${response.status}`;
} catch {}

console.log(`阿里云 ESA 百度流媒体代理已发布：${healthUrl}`);
console.log(`生产版本：${committed.CodeVersion}；健康检查：${healthStatus}`);
console.log(`HTTPS 免费证书：${certificateStatus}`);
console.log("代理密钥仅注入阿里云部署产物和本机 600 权限配置，仓库源码保留占位符。");
