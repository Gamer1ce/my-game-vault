import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNetwork, nextDdnsStatus, retryRequest } from '../src/ddns-health.mjs';

const base = {
  interfaceName: 'en1', expectedGateway: '192.168.110.1',
  route4: 'gateway: 192.168.110.1\ninterface: en1',
  route6: 'gateway: fe80::1%en1\ninterface: en1',
  interfaceText: 'inet 192.168.110.133\ninet6 240e::1234 prefixlen 64 autoconf secured pltime 1800 vltime 3600',
};

test('有效公网地址、家庭网关及 IPv6 路由通过检查', () => {
  const result = inspectNetwork(base);
  assert.equal(result.ok, true);
  assert.equal(result.address, '240e::1234');
  assert.equal(result.candidates[0].preferredLifetime, 1800);
});
test('不发布已废弃、过期、重复或仍在检测中的 IPv6', () => {
  for (const flags of ['deprecated', 'detached', 'tentative', 'duplicated', 'pltime 0 vltime 100', 'pltime 100 vltime 0']) {
    const result = inspectNetwork({ ...base, interfaceText: `inet6 240e::1234 prefixlen 64 ${flags}` });
    assert.equal(result.ok, false, flags);
    assert.equal(result.code, 'ipv6_unusable');
  }
});
test('误连 UU 网络时即使存在公网地址也不更新 DNS', () => {
  assert.equal(inspectNetwork({ ...base, route4: 'gateway: 192.168.163.1' }).code, 'wrong_network');
});
test('区分缺失地址、缺失路由和 VPN 路由', () => {
  assert.equal(inspectNetwork({ ...base, interfaceText: 'inet6 fe80::1%en1' }).code, 'ipv6_missing');
  assert.equal(inspectNetwork({ ...base, route6: '' }).code, 'ipv6_route_missing');
  assert.equal(inspectNetwork({ ...base, route6: 'gateway: fe80::1%utun0\ninterface: utun0' }).ok, false);
});
test('隐私临时地址不能成为网站发布地址', () => {
  assert.equal(inspectNetwork({ ...base, interfaceText: 'inet6 240e::1 temporary' }).ok, false);
  assert.equal(inspectNetwork({ ...base, interfaceText: 'inet6 fc00::1\ninet6 ::1' }).ok, false);
});
test('保持已发布且有效的地址，失效后改选其他稳定地址', () => {
  const interfaceText = 'inet6 240e::1000 dynamic\ninet6 240e::1234 autoconf secured';
  assert.equal(inspectNetwork({ ...base, interfaceText, previousAddress: '240e::1234', preferredSuffix: '::1000' }).address, '240e::1234');
  assert.equal(inspectNetwork({ ...base, interfaceText: `${interfaceText} deprecated`, previousAddress: '240e::1234' }).address, '240e::1000');
});
test('保存故障起始时间及上次成功地址，恢复后清零失败次数', () => {
  const healthy = nextDdnsStatus(null, { ok: true, publishedAddress: '240e::1234' }, 't0');
  const failed = nextDdnsStatus(healthy, { ok: false, code: 'ipv6_missing' }, 't1');
  const again = nextDdnsStatus(failed, { ok: false, code: 'wrong_network' }, 't2');
  assert.equal(again.failedSince, 't1');
  assert.equal(again.consecutiveFailures, 2);
  assert.equal(again.lastPublishedAddress, '240e::1234');
  assert.equal(again.lastSuccessAt, 't0');
  const recovered = nextDdnsStatus(again, { ok: true, publishedAddress: '240e::2' }, 't3');
  assert.equal(recovered.failedSince, null);
  assert.equal(recovered.consecutiveFailures, 0);
});
test('临时网络错误有限重试，认证等永久错误不重试', async () => {
  let count = 0;
  const waits = [];
  const result = await retryRequest(async () => {
    if (++count < 3) throw Object.assign(new Error('timeout'), { retryable: true });
    return 'ok';
  }, { sleep: async ms => waits.push(ms) });
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [500, 1000]);
  count = 0;
  await assert.rejects(retryRequest(async () => { count++; throw new Error('unauthorized'); }));
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(retryRequest(async () => { count++; throw Object.assign(new Error('failed'), { retryable: true }); }, { sleep: async () => {} }));
  assert.equal(count, 3);
});
