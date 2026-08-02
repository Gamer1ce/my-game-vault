import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public/index.html"), "utf8");
const script = readFileSync(path.join(root, "public/app.js"), "utf8");

test("留言栏只保留一个可见正文输入框并提供发送按钮", () => {
  const form = html.match(/<form id="guestbookForm"[\s\S]*?<\/form>/)?.[0] || "";
  assert.equal((form.match(/<input\b/g) || []).length, 2);
  assert.equal((form.match(/<input(?![^>]*type="hidden")[^>]*>/g) || []).length, 1);
  assert.match(form, /<button class="guestbook-submit" type="submit"><span>发送<\/span>/);
});

test("留言保存成功后显示明确提示", () => {
  assert.match(script, /toast\("发送成功，留言已接入通讯频道"\)/);
});
