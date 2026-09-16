import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('CPA 公网策略为受限 API 入口，不公开管理或配置路径', () => {
  const source = readFileSync(new URL('../deploy/cpa/Caddyfile.snippet',import.meta.url),'utf8');
  assert.match(source,/handle_path \/cpa\/\*/);
  assert.match(source,/header_regexp Authorization/);
  assert.match(source,/respond @missingBearer "Unauthorized" 401/);
  assert.match(source,/max_size 16MB/);
  assert.match(source,/max_conns_per_host 8/);
  assert.match(source,/Cache-Control "no-store"/);
  assert.match(source,/-Access-Control-Allow-Origin/);
  assert.match(source,/respond 404/);
  assert.doesNotMatch(source,/path .*\/v0\/management/);
  assert.doesNotMatch(source,/path .*\/v1\/\*/);
});
