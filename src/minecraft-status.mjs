import { readFile } from "node:fs/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_CACHE_MS = 3_000;
const MAX_PACKET_BYTES = 1024 * 1024;

function encodeVarInt(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function encodeString(value) {
  const body = Buffer.from(String(value), "utf8");
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function packet(packetId, body = Buffer.alloc(0)) {
  const payload = Buffer.concat([encodeVarInt(packetId), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function readVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= (byte & 0x7f) << position;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, bytes: cursor - offset };
    position += 7;
    if (position >= 35) throw new Error("Minecraft VarInt 无效");
  }
  return null;
}

function descriptionText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return [value.text, ...(Array.isArray(value.extra) ? value.extra.map(descriptionText) : [])]
    .filter(Boolean)
    .join("");
}

function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
}

function cleanAddress(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
}

function normalizeMetrics(value, now) {
  if (!value || typeof value !== "object") return null;
  const sampledAt = Date.parse(value.sampledAt);
  if (!Number.isFinite(sampledAt) || now - sampledAt > 15_000 || sampledAt - now > 5_000) return null;
  const players = Array.isArray(value.players)
    ? value.players.map((player) => ({
      name: cleanName(player?.name),
      latencyMs: Number.isFinite(Number(player?.latencyMs)) ? Math.max(0, Math.round(Number(player.latencyMs))) : null
    })).filter((player) => player.name)
    : [];
  return {
    sampledAt: new Date(sampledAt).toISOString(),
    tps: Number.isFinite(Number(value.tps)) ? Math.max(0, Math.min(20, Number(value.tps))) : null,
    mspt: Number.isFinite(Number(value.mspt)) ? Math.max(0, Number(value.mspt)) : null,
    uptimeSeconds: Number.isFinite(Number(value.uptimeSeconds)) ? Math.max(0, Math.round(Number(value.uptimeSeconds))) : null,
    memoryUsedMb: Number.isFinite(Number(value.memoryUsedMb)) ? Math.max(0, Math.round(Number(value.memoryUsedMb))) : null,
    memoryMaxMb: Number.isFinite(Number(value.memoryMaxMb)) ? Math.max(0, Math.round(Number(value.memoryMaxMb))) : null,
    onlinePlayers: Number.isFinite(Number(value.onlinePlayers)) ? Math.max(0, Math.round(Number(value.onlinePlayers))) : players.length,
    maxPlayers: Number.isFinite(Number(value.maxPlayers)) ? Math.max(0, Math.round(Number(value.maxPlayers))) : null,
    players
  };
}

export async function readMinecraftMetrics(file, now = Date.now()) {
  if (!file) return null;
  try {
    return normalizeMetrics(JSON.parse(await readFile(file, "utf8")), now);
  } catch {
    return null;
  }
}

export function pingMinecraftServer({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS, protocolVersion = 763 }) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let expectedLength = null;
    let lengthBytes = 0;
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setTimeout(timeoutMs, () => finish(new Error("Minecraft 状态请求超时")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      const handshake = Buffer.concat([
        encodeVarInt(protocolVersion),
        encodeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        encodeVarInt(1)
      ]);
      socket.write(packet(0, handshake));
      socket.write(packet(0));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_PACKET_BYTES) return finish(new Error("Minecraft 状态响应过大"));
      if (expectedLength == null) {
        const parsedLength = readVarInt(buffer);
        if (!parsedLength) return;
        expectedLength = parsedLength.value;
        lengthBytes = parsedLength.bytes;
      }
      if (buffer.length < lengthBytes + expectedLength) return;
      const payload = buffer.subarray(lengthBytes, lengthBytes + expectedLength);
      const packetId = readVarInt(payload);
      if (!packetId || packetId.value !== 0) return finish(new Error("Minecraft 状态响应类型无效"));
      const stringLength = readVarInt(payload, packetId.bytes);
      if (!stringLength) return finish(new Error("Minecraft 状态响应不完整"));
      const start = packetId.bytes + stringLength.bytes;
      const end = start + stringLength.value;
      if (end > payload.length) return finish(new Error("Minecraft 状态 JSON 不完整"));
      try {
        const status = JSON.parse(payload.subarray(start, end).toString("utf8"));
        finish(null, { status, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) });
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function createMinecraftStatusService({
  host = "host.docker.internal",
  port = 25565,
  metricsFile = "",
  packName = "Minecraft Server",
  packVersion = "",
  publicAddress = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheMs = DEFAULT_CACHE_MS,
  now = () => Date.now(),
  ping = pingMinecraftServer,
  readMetrics = readMinecraftMetrics
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  async function load() {
    const checkedAt = now();
    const [pingResult, metrics] = await Promise.all([
      ping({ host, port, timeoutMs }).catch(() => null),
      readMetrics(metricsFile, checkedAt)
    ]);
    const serverStatus = pingResult?.status || {};
    const sampledPlayers = Array.isArray(serverStatus.players?.sample)
      ? serverStatus.players.sample.map((player) => ({ name: cleanName(player?.name), latencyMs: null })).filter((player) => player.name)
      : [];
    const players = metrics?.players?.length ? metrics.players : sampledPlayers;
    return {
      online: Boolean(pingResult),
      checkedAt: new Date(checkedAt).toISOString(),
      latencyMs: pingResult?.latencyMs ?? null,
      pack: { name: cleanName(packName) || "Minecraft Server", version: cleanName(packVersion) },
      address: cleanAddress(publicAddress),
      motd: descriptionText(serverStatus.description).trim().slice(0, 180),
      version: cleanName(serverStatus.version?.name),
      protocol: Number.isFinite(Number(serverStatus.version?.protocol)) ? Number(serverStatus.version.protocol) : null,
      modLoader: serverStatus.forgeData || serverStatus.modinfo ? "Forge" : "Minecraft",
      onlinePlayers: metrics?.onlinePlayers ?? Number(serverStatus.players?.online || 0),
      maxPlayers: metrics?.maxPlayers > 0 ? metrics.maxPlayers : Number(serverStatus.players?.max || 0),
      players,
      performance: {
        available: Boolean(metrics),
        sampledAt: metrics?.sampledAt || null,
        tps: metrics?.tps ?? null,
        mspt: metrics?.mspt ?? null,
        uptimeSeconds: metrics?.uptimeSeconds ?? null,
        memoryUsedMb: metrics?.memoryUsedMb ?? null,
        memoryMaxMb: metrics?.memoryMaxMb ?? null
      }
    };
  }

  return {
    async status() {
      const time = now();
      if (cached && time - cachedAt < cacheMs) return cached;
      if (pending) return pending;
      pending = load().then((value) => {
        cached = value;
        cachedAt = now();
        return value;
      }).finally(() => { pending = null; });
      return pending;
    }
  };
}
