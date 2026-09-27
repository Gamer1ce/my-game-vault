import { isIP } from 'node:net';

export function inspectNetwork({ interfaceName, interfaceText, route4 = '', route6 = '', expectedGateway, preferredSuffix, previousAddress }) {
  const gateway = route4.match(/\bgateway:\s+(\S+)/)?.[1] ?? null;
  const ipv6Router = route6.match(/\bgateway:\s+(\S+)/)?.[1] ?? null;
  const ipv6Interface = route6.match(/\binterface:\s+(\S+)/)?.[1];
  const ipv4 = interfaceText.match(/\binet\s+(\S+)/)?.[1] ?? null;
  const candidates = interfaceText.split('\n').filter(line => /\binet6\b/.test(line)).map(line => {
    const address = line.match(/\binet6\s+([^\s%]+)/)?.[1];
    const lifetime = name => {
      const value = line.match(new RegExp(`\\b${name}\\s+(\\S+)`))?.[1];
      return value && /^\d+$/.test(value) ? Number(value) : null;
    };
    return { address, temporary: /\btemporary\b/.test(line), preferredLifetime: lifetime('pltime'), validLifetime: lifetime('vltime'),
      unusable: /\b(deprecated|detached|tentative|duplicated)\b/.test(line) };
  }).filter(item => isIP(item.address ?? '') === 6 && /^[23]/i.test(item.address));
  const usable = candidates.filter(item => !item.unusable && item.preferredLifetime !== 0 && item.validLifetime !== 0);
  // Keep an already published, stable address while it remains usable; never prefer a privacy address.
  const stable = usable.filter(item => !item.temporary);
  const selected = stable.find(item => item.address === previousAddress)
    ?? stable.find(item => preferredSuffix && item.address.toLowerCase().endsWith(preferredSuffix.toLowerCase()))
    ?? stable[0];
  const snapshot = { interfaceName, ipv4, gateway, ipv6Router, candidates, address: selected?.address ?? null };
  const fail = (code, message) => ({ ...snapshot, ok: false, code, message });
  if (expectedGateway && gateway !== expectedGateway) return fail('wrong_network', '未连接预期家庭网关；保留原 DNS，不向当前网络发布网站');
  if (!selected) return fail(candidates.length ? 'ipv6_unusable' : 'ipv6_missing', '没有可发布的稳定公网 IPv6；检查路由器前缀分配及地址续租');
  if (!ipv6Router || ipv6Interface !== interfaceName) return fail('ipv6_route_missing', '公网 IPv6 地址存在，但对应接口没有默认 IPv6 路由');
  return { ...snapshot, ok: true, code: 'ready', message: '家庭网络 IPv6 地址与默认路由可用' };
}

export function nextDdnsStatus(previous, result, now = new Date().toISOString()) {
  return { ...result, checkedAt: now,
    consecutiveFailures: result.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    failedSince: result.ok ? null : previous?.failedSince ?? now,
    lastSuccessAt: result.ok ? now : previous?.lastSuccessAt ?? null,
    lastGoodNetwork: result.ok ? result.network ?? null : previous?.lastGoodNetwork ?? null,
    lastPublishedAddress: result.publishedAddress ?? previous?.lastPublishedAddress ?? null };
}

export async function retryRequest(operation, { attempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!error.retryable || attempt >= attempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}
