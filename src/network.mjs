import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";

export function parseMacosProxySettings(output) {
  const settings = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) settings.set(match[1], match[2]);
  }
  const enabled = settings.get("HTTPSEnable") === "1" || settings.get("HTTPEnable") === "1";
  const host = settings.get("HTTPSProxy") || settings.get("HTTPProxy");
  const port = Number(settings.get("HTTPSPort") || settings.get("HTTPPort"));
  if (!enabled || !host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `http://${host}:${port}`;
}

export function detectOutboundProxy({ env = process.env, platform = process.platform, readMacosProxy = null } = {}) {
  const configured = String(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "").trim();
  if (configured) return { url: configured, source: "environment" };
  if (platform !== "darwin") return null;
  try {
    const output = readMacosProxy
      ? readMacosProxy()
      : execFileSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2_000 });
    const url = parseMacosProxySettings(output);
    return url ? { url, source: "macos" } : null;
  } catch {
    return null;
  }
}

export function configureOutboundProxy(options = {}) {
  const proxy = detectOutboundProxy(options);
  if (!proxy) return { enabled: false, source: null };
  setGlobalDispatcher(new ProxyAgent(proxy.url));
  return { enabled: true, source: proxy.source };
}
