#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDirectory = path.resolve(process.env.GAME_VAULT_PROJECT_DIR || path.join(import.meta.dirname, ".."));
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(projectDirectory, "data"));
const ddnsConfigPath = process.env.CLOUDFLARE_DDNS_CONFIG
  || path.join(homedir(), "Library/Application Support/GameTimeVault/cloudflare-ddns.json");
const docker = process.env.DOCKER_BIN || "/usr/local/bin/docker";
const caddyContainer = process.env.DIRECT_MEDIA_CADDY_CONTAINER || "game-time-vault-caddy-1";
const caddyVolume = process.env.DIRECT_MEDIA_CADDY_VOLUME || "game-time-vault_caddy_data";
const legoImage = "goacme/lego@sha256:f4fd80df0ef94d2f536cc2e7fb5bdbd090fb0aa81b3595226b9fe814bb9a2bfe";

async function directMediaHostname() {
  const configured = String(process.env.DIRECT_MEDIA_ORIGIN || "").trim()
    || (await readFile(path.join(dataDirectory, "direct-media-origin.txt"), "utf8")).trim();
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.pathname !== "/") throw new Error("直连媒体地址必须是没有路径的 HTTPS Origin");
  return url.hostname;
}

async function certificateHash(hostname) {
  try {
    const { stdout } = await execFileAsync(docker, [
      "exec",
      caddyContainer,
      "sha256sum",
      `/data/lego/certificates/${hostname}.crt`
    ]);
    return stdout.trim().split(/\s+/, 1)[0] || null;
  } catch {
    return null;
  }
}

async function cloudflareToken() {
  const config = JSON.parse(await readFile(ddnsConfigPath, "utf8"));
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-w",
    "-a",
    config.keychainAccount,
    "-s",
    config.keychainService
  ]);
  const token = stdout.trim();
  if (!token) throw new Error("Cloudflare DNS Token 不可用");
  return token;
}

function runLego(hostname, token) {
  const args = [
    "run",
    "--rm",
    "-e", "CF_DNS_API_TOKEN",
    "-e", "CF_ZONE_API_TOKEN",
    "-v", `${caddyVolume}:/data`,
    legoImage,
    "run",
    "--accept-tos",
    "--dns", "cloudflare",
    "--dns.resolvers", "1.1.1.1:53",
    "--domains", hostname,
    "--path", "/data/lego",
    "--email", "",
    "--renew-days", "30"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, {
      env: { ...process.env, CF_DNS_API_TOKEN: token, CF_ZONE_API_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`lego 证书任务失败（${signal || `exit ${code}`}）`));
    });
  });
}

try {
  const hostname = await directMediaHostname();
  const before = await certificateHash(hostname);
  const token = await cloudflareToken();
  await runLego(hostname, token);
  const after = await certificateHash(hostname);
  if (!after) throw new Error("签发完成后仍未找到直连媒体证书");
  if (after !== before) {
    await execFileAsync(docker, ["restart", caddyContainer]);
    console.log(`${new Date().toISOString()} ${hostname} 证书已更新，Caddy 已重新载入`);
  } else {
    console.log(`${new Date().toISOString()} ${hostname} 证书尚未到续期时间`);
  }
} catch (error) {
  console.error(`${new Date().toISOString()} 直连媒体证书任务失败：${error.message}`);
  process.exitCode = 1;
}
