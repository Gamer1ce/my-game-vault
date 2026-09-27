#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { inspectNetwork, nextDdnsStatus, retryRequest } from '../src/ddns-health.mjs';

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
  const readRoute = args => execFileAsync('/sbin/route', args, { timeout: 5000 })
    .then(result => result.stdout).catch(() => '');
  const [iface, route4, route6] = await Promise.all([
    execFileAsync('/sbin/ifconfig', ['-L', config.interface], { timeout: 5000 }),
    readRoute(['-n', 'get', 'default']), readRoute(['-n', 'get', '-inet6', 'default']),
  ]);
  return inspectNetwork({ interfaceName: config.interface, interfaceText: iface.stdout, route4, route6,
    expectedGateway: config.expectedGateway, preferredSuffix: config.preferredSuffix,
    previousAddress: config.previousAddress });
}

async function getToken(config) {
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password',
    '-w',
    '-a',
    config.keychainAccount,
    '-s',
    config.keychainService,
  ], { timeout: 10000 });
  const token = stdout.trim();
  if (!token) throw new Error('钥匙串中的 Cloudflare API Token 为空');
  return token;
}

async function cloudflareRequest(config, token, path, options = {}) {
  // Retry only idempotent reads/updates, never a potentially completed POST.
  return retryRequest(async () => {
    let response, payload;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...options,
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      payload = await response.json();
    } catch (cause) {
      throw Object.assign(new Error('Cloudflare API 网络连接失败、超时或响应格式异常'), {
        retryable: !response || response.status === 429 || response.status >= 500 || response.ok, cause,
      });
    }
    if (!response.ok || !payload.success) {
      const details = payload.errors?.map((error) => error.message).join('; ') || response.statusText;
      throw Object.assign(new Error(`Cloudflare API 请求失败 (${response.status}): ${details}`), { retryable: response.status === 429 || response.status >= 500 });
    }
    return payload.result;
  }, { attempts: !options.method || options.method === 'PUT' ? 3 : 1 });
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

const statusPath = `${configPath}.status.json`;
let previous;
let snapshot;
let stage = 'config_error';
try { previous = JSON.parse(await readFile(statusPath, 'utf8')); } catch {}
async function persist(result) {
  const status = nextDdnsStatus(previous, result);
  await writeFile(`${statusPath}.tmp`, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(`${statusPath}.tmp`, statusPath);
  if (!status.ok) log(`诊断 ${status.code}；连续失败 ${status.consecutiveFailures} 次；开始于 ${status.failedSince}`);
}
try {
  const config = await loadConfig();
  stage = 'network_check_failed';
  snapshot = await getPublicIpv6({ ...config, previousAddress: previous?.lastPublishedAddress });
  if (!process.argv.includes('--check')) log(`网络诊断 ${JSON.stringify(snapshot)}`);
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify(snapshot, null, 2));
    process.exitCode = snapshot.ok ? 0 : 1;
  } else if (!snapshot.ok) {
    await persist({ ok: false, code: snapshot.code, message: snapshot.message, network: snapshot });
    throw Object.assign(new Error(snapshot.message), { diagnosed: true });
  } else {
    stage = 'credential_error';
    const token = await getToken(config);
    stage = 'dns_update_failed';
    const results = await Promise.allSettled(config.records.map(record => updateRecord(config, token, snapshot.address, record)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    await persist({ ok: true, code: 'dns_updated', message: '域名已与可用家庭 IPv6 一致（不代表外部端口已验证）', network: snapshot, publishedAddress: snapshot.address });
  }
} catch (error) {
  if (!error.diagnosed && !process.argv.includes('--check')) {
    try { await persist({ ok: false, code: stage, message: error.message, network: snapshot }); }
    catch { console.error('无法写入本机 DDNS 诊断状态'); }
  }
  console.error(`${new Date().toISOString()} DDNS 失败：${error.message}`);
  process.exitCode = 1;
}
