import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/index.html"), "utf8");
const script = readFileSync(path.join(root, "public/app.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

test("顶部和底部导航按钮始终可见且可聚焦", () => {
  assert.match(html, /id="quickTopButton"[^>]*aria-label="快速回到顶部"/);
  assert.match(html, /id="quickBottomButton"[^>]*aria-label="快速前往页面底部/);
  assert.doesNotMatch(html, /id="quick(?:Top|Bottom)Button"[^>]*(?:aria-hidden="true"|tabindex="-1")/);
  assert.match(styles, /\.quick-top\s*\{[\s\S]*?bottom:\s*calc\(132px[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/);
  assert.match(styles, /\.quick-bottom\s*\{\s*bottom:\s*calc\(82px/);
});

test("页面导航不再依赖快速滚动检测或自动隐藏", () => {
  assert.doesNotMatch(script, /detectFastDownScroll|quickTopTimer|quickBottomTimer|hideQuickTop|hideQuickBottom/);
  assert.match(script, /quickTopButton\.addEventListener\("click", returnToTop\)/);
  assert.match(script, /quickBottomButton\.addEventListener\("click", returnToBottom\)/);
});

test("移动端使用更紧凑的导航按钮并保持顶部按钮在上方", () => {
  assert.match(styles, /@media \(max-width:\s*800px\)[\s\S]*?\.quick-top\s*\{[\s\S]*?bottom:\s*calc\(106px[\s\S]*?padding:\s*8px 10px;[\s\S]*?font-size:\s*10px;/);
  assert.match(styles, /@media \(max-width:\s*800px\)[\s\S]*?\.quick-bottom\s*\{\s*bottom:\s*calc\(62px/);
});
