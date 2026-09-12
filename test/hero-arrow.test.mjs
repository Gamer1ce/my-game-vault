import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('启动箭头使用随按钮配色的 CSS 图形，不依赖手机 emoji 字形', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.hero-sequence-trigger::after\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /content:\s*""/);
  assert.match(rule, /background:\s*currentColor/);
  assert.match(rule, /clip-path:\s*polygon\(/);
  assert.match(css, /\.hero-sequence-trigger:disabled::after\s*\{\s*display:\s*none/);
});
