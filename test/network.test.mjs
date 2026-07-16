import test from "node:test";
import assert from "node:assert/strict";
import { detectOutboundProxy, parseMacosProxySettings } from "../src/network.mjs";

test("读取 macOS 系统 HTTPS 代理", () => {
  const output = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}`;
  assert.equal(parseMacosProxySettings(output), "http://127.0.0.1:7897");
});

test("环境变量代理优先于系统代理", () => {
  assert.deepEqual(detectOutboundProxy({
    env: { HTTPS_PROXY: "http://proxy.example:8080" },
    platform: "darwin",
    readMacosProxy: () => { throw new Error("不应读取"); }
  }), { url: "http://proxy.example:8080", source: "environment" });
});
