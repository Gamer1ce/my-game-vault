#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const configPath = process.env.CLOUDFLARE_DDNS_CONFIG
  || "/Users/gamer1ce/Library/Application Support/GameTimeVault/cloudflare-ddns.json";
const hostname = String(process.env.AZURE_BACKUP_HOST || "azure.gamer1ce.top").trim().toLowerCase();
const address = String(process.env.AZURE_BACKUP_IP || "").trim();

if (!hostname || !isIP(address) || isIP(address) !== 4) {
  throw new Error("请设置有效的 AZURE_BACKUP_HOST 与 IPv4 AZURE_BACKUP_IP");
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const { stdout } = await execFileAsync("/usr/bin/security", [
  "find-generic-password",
  "-w",
  "-a",
  config.keychainAccount,
  "-s",
  config.keychainService
]);
const token = stdout.trim();

async function request(endpoint, options = {}) {
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

const query = new URLSearchParams({ type: "A", name: hostname });
const records = await request(`/zones/${config.zoneId}/dns_records?${query}`);
const existing = records[0];
const body = JSON.stringify({ type: "A", name: hostname, content: address, proxied: false, ttl: 1 });

if (existing) {
  await request(`/zones/${config.zoneId}/dns_records/${existing.id}`, { method: "PUT", body });
  console.log(`${hostname} 已更新为 ${address}`);
} else {
  await request(`/zones/${config.zoneId}/dns_records`, { method: "POST", body });
  console.log(`${hostname} 已创建为 ${address}`);
}
