#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const configPath =
  process.env.CLOUDFLARE_DDNS_CONFIG ||
  '/Users/gamer1ce/Library/Application Support/GameTimeVault/cloudflare-ddns.json';

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function loadConfig() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const key of ['zoneId', 'interface', 'keychainService', 'keychainAccount']) {
    if (!config[key]) throw new Error(`配置缺少 ${key}`);
  }
  config.records ??= [
    {
      name: config.recordName,
      proxied: config.proxied ?? false,
    },
  ];
  if (!config.records.length || config.records.some((record) => !record.name)) {
    throw new Error('配置缺少有效的 DNS 记录');
  }
  return config;
}

async function getPublicIpv6(config) {
  const { stdout } = await execFileAsync('/sbin/ifconfig', [config.interface]);
  const candidates = stdout
    .split('\n')
    .filter((line) => /\binet6\b/.test(line))
    .map((line) => ({
      line,
      address: line.match(/\binet6\s+([^\s%]+)/)?.[1],
    }))
    .filter(({ address }) => address && /^[23][0-9a-f:]+$/i.test(address));

  if (!candidates.length) {
    throw new Error(`${config.interface} 没有可用的公网 IPv6 地址`);
  }

  const preferred = candidates.find(({ line, address }) =>
    /\bdynamic\b/.test(line) &&
    (!config.preferredSuffix || address.toLowerCase().endsWith(config.preferredSuffix.toLowerCase())),
  );
  const stable = candidates.find(({ line }) => !/\btemporary\b/.test(line));
  return (preferred || stable || candidates[0]).address;
}

async function getToken(config) {
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password',
    '-w',
    '-a',
    config.keychainAccount,
    '-s',
    config.keychainService,
  ]);
  const token = stdout.trim();
  if (!token) throw new Error('钥匙串中的 Cloudflare API Token 为空');
  return token;
}

async function cloudflareRequest(config, token, path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const details = payload.errors?.map((error) => error.message).join('; ') || response.statusText;
    throw new Error(`Cloudflare API 请求失败 (${response.status}): ${details}`);
  }
  return payload.result;
}

async function updateRecord(config, token, address, record) {
  const query = new URLSearchParams({ type: 'AAAA', name: record.name });
  const records = await cloudflareRequest(
    config,
    token,
    `/zones/${config.zoneId}/dns_records?${query}`,
  );
  const current = records[0];

  const proxied = record.proxied ?? false;
  if (current?.content === address && current.proxied === proxied) {
    log(`${record.name} 无变化：${address}`);
    return;
  }

  const body = JSON.stringify({
    type: 'AAAA',
    name: record.name,
    content: address,
    ttl: config.ttl ?? 1,
    proxied,
  });

  if (current) {
    await cloudflareRequest(config, token, `/zones/${config.zoneId}/dns_records/${current.id}`, {
      method: 'PUT',
      body,
    });
    log(`${record.name} 已更新为 ${address}`);
  } else {
    await cloudflareRequest(config, token, `/zones/${config.zoneId}/dns_records`, {
      method: 'POST',
      body,
    });
    log(`${record.name} 已创建为 ${address}`);
  }
}

try {
  const config = await loadConfig();
  const [address, token] = await Promise.all([getPublicIpv6(config), getToken(config)]);
  await Promise.all(config.records.map((record) => updateRecord(config, token, address, record)));
} catch (error) {
  console.error(`${new Date().toISOString()} DDNS 失败：${error.message}`);
  process.exitCode = 1;
}
