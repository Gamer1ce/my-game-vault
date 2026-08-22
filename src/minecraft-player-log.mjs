import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const PLAYER_EVENTS = new Set(["present", "join", "leave"]);
const SYSTEM_EVENTS = new Set(["run-start", "server-stop"]);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const COLLECTOR_FRESH_MS = 15_000;

function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
}

function cleanId(value, maximum = 96) {
  const result = String(value || "").trim();
  return /^[a-zA-Z0-9:_-]+$/.test(result) ? result.slice(0, maximum) : "";
}

function eventTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeMinecraftPlayerEvent(value) {
  if (!value || typeof value !== "object" || Number(value.v) !== 1) return null;
  const type = String(value.type || "");
  if (!PLAYER_EVENTS.has(type) && !SYSTEM_EVENTS.has(type)) return null;
  const eventId = cleanId(value.eventId);
  const runId = cleanId(value.runId, 64);
  const sequence = Number(value.seq);
  const occurredAt = eventTimestamp(value.at);
  const jvmUptimeMs = Number(value.jvmUptimeMs);
  const normalizedUptime = Number.isSafeInteger(jvmUptimeMs) && jvmUptimeMs >= 0 ? jvmUptimeMs : null;
  if (!eventId || !runId || !Number.isSafeInteger(sequence) || sequence < 1 || !occurredAt) return null;
  if (SYSTEM_EVENTS.has(type)) return { eventId, runId, sequence, type, occurredAt, jvmUptimeMs: normalizedUptime, playerId: null, playerName: null };
  const playerId = cleanId(value.player?.uuid, 64);
  const playerName = cleanName(value.player?.name);
  if (!playerId || !playerName) return null;
  return { eventId, runId, sequence, type, occurredAt, jvmUptimeMs: normalizedUptime, playerId, playerName };
}

function projectSessions(events) {
  const sessions = [];
  const open = new Map();
  const exactDuration = (session, event) => {
    if (session.runId !== event.runId || session.startedUptimeMs == null || event.jvmUptimeMs == null) return null;
    const milliseconds = event.jvmUptimeMs - session.startedUptimeMs;
    return milliseconds >= 0 ? Math.floor(milliseconds / 1000) : null;
  };
  const closeAllExactly = (event, endReason) => {
    for (const session of open.values()) {
      session.leftAt = event.occurredAt;
      session.durationSeconds = exactDuration(session, event);
      session.endReason = endReason;
      session.online = false;
    }
    open.clear();
  };
  const closeAllBefore = (event, endReason) => {
    for (const session of open.values()) {
      if (session.runId === event.runId) continue;
      session.endBefore = event.occurredAt;
      session.endReason = endReason;
      session.online = false;
      open.delete(session.playerId);
    }
  };
  for (const event of events) {
    if (event.type === "run-start") {
      closeAllBefore(event, "unknown-after-crash");
      continue;
    }
    if (event.type === "server-stop") {
      closeAllExactly(event, "server-stop");
      continue;
    }
    const key = event.playerId;
    if (event.type === "leave") {
      const active = open.get(key);
      if (active) {
        active.leftAt = event.occurredAt;
        active.durationSeconds = exactDuration(active, event);
        active.endReason = "leave";
        active.online = false;
        open.delete(key);
      } else {
        sessions.push({
          id: event.eventId,
          playerName: event.playerName,
          joinedAt: null,
          observedAt: null,
          leftAt: event.occurredAt,
          endBefore: null,
          startReason: "unknown",
          endReason: "leave",
          online: false,
          durationSeconds: null,
          runId: event.runId,
          playerId: event.playerId,
          startedUptimeMs: null
        });
      }
      continue;
    }
    const previous = open.get(key);
    if (previous) {
      if (previous.runId === event.runId && event.type === "present") continue;
      previous.endBefore = event.occurredAt;
      previous.endReason = "unknown-before-reconnect";
      previous.online = false;
      open.delete(key);
    }
    const session = {
      id: event.eventId,
      playerName: event.playerName,
      joinedAt: event.type === "join" ? event.occurredAt : null,
      observedAt: event.type === "present" ? event.occurredAt : null,
      leftAt: null,
      endBefore: null,
      startReason: event.type,
      endReason: null,
      online: true,
      durationSeconds: null,
      runId: event.runId,
      playerId: event.playerId,
      startedUptimeMs: event.type === "join" ? event.jvmUptimeMs : null
    };
    sessions.push(session);
    open.set(key, session);
  }
  return sessions;
}

function normalizeCollectorStatus(value, now) {
  if (!value || typeof value !== "object" || Number(value.v) !== 1) return null;
  const runId = cleanId(value.runId, 64);
  const sampledAt = eventTimestamp(value.sampledAt);
  const sampledTime = Date.parse(sampledAt);
  const uptime = Number(value.jvmUptimeMs);
  const jvmUptimeMs = Number.isSafeInteger(uptime) && uptime >= 0 ? uptime : null;
  const sequence = Number(value.lastSequence);
  const lastSequence = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  if (!runId || !sampledAt || now - sampledTime > COLLECTOR_FRESH_MS || sampledTime - now > 5_000) return null;
  const state = ["starting", "live", "degraded", "stopped"].includes(value.state) ? value.state : "unknown";
  return {
    runId,
    sampledAt,
    jvmUptimeMs,
    lastSequence,
    state,
    error: cleanName(value.error),
    live: value.ready === true && state === "live" && lastSequence != null && lastSequence >= 1
  };
}

export function createMinecraftPlayerLogStore({ database, eventsDirectory = "", now = () => Date.now() } = {}) {
  if (!database?.prepare || !database?.exec) throw new TypeError("Minecraft 玩家日志需要 SQLite 数据库");
  const directory = eventsDirectory ? path.resolve(eventsDirectory) : "";
  database.exec(`
    CREATE TABLE IF NOT EXISTS minecraft_player_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('run-start', 'present', 'join', 'leave', 'server-stop')),
      player_id TEXT,
      player_name TEXT,
      jvm_uptime_ms INTEGER,
      occurred_at TEXT NOT NULL,
      UNIQUE(run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS minecraft_player_events_recent
      ON minecraft_player_events(occurred_at DESC);
  `);
  const eventColumns = database.prepare("PRAGMA table_info(minecraft_player_events)").all().map((column) => column.name);
  if (!eventColumns.includes("jvm_uptime_ms")) {
    database.exec("ALTER TABLE minecraft_player_events ADD COLUMN jvm_uptime_ms INTEGER");
  }
  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO minecraft_player_events(
      event_id, run_id, sequence, event_type, player_id, player_name, jvm_uptime_ms, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const replayEvents = database.prepare(`
    SELECT events.event_id AS eventId, events.run_id AS runId, events.sequence,
           events.event_type AS type, events.player_id AS playerId,
           events.player_name AS playerName, events.jvm_uptime_ms AS jvmUptimeMs,
           events.occurred_at AS occurredAt
    FROM minecraft_player_events AS events
    JOIN (
      SELECT run_id,
             COALESCE(
               MIN(CASE WHEN event_type = 'run-start' THEN occurred_at END),
               MIN(occurred_at)
             ) AS started_at
      FROM minecraft_player_events
      GROUP BY run_id
    ) AS runs ON runs.run_id = events.run_id
    ORDER BY runs.started_at, events.run_id, events.sequence
  `);
  const countEvents = database.prepare("SELECT COUNT(*) AS count FROM minecraft_player_events");
  const brokenSequences = database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT run_id
      FROM minecraft_player_events
      GROUP BY run_id
      HAVING MIN(sequence) != 1
          OR MAX(sequence) != COUNT(*)
          OR SUM(CASE WHEN sequence = 1 AND event_type = 'run-start' THEN 1 ELSE 0 END) != 1
    )
  `);
  const maximumSequence = database.prepare("SELECT MAX(sequence) AS sequence FROM minecraft_player_events WHERE run_id = ?");
  const fileState = new Map();
  const fileIntegrity = new Map();
  let journalAvailable = false;
  let collector = { live: false, state: "not-connected", runId: null, sampledAt: null, jvmUptimeMs: null, lastSequence: null, error: "" };

  async function readCollectorStatus() {
    if (!directory) return null;
    try {
      return normalizeCollectorStatus(JSON.parse(await readFile(path.join(directory, "status.json"), "utf8")), now());
    } catch {
      return null;
    }
  }

  async function sync() {
    if (!directory) return { available: false, inserted: 0 };
    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
        .sort((left, right) => left.name.localeCompare(right.name));
      journalAvailable = true;
    } catch {
      journalAvailable = false;
      collector = { live: false, state: "not-connected", runId: null, sampledAt: null, jvmUptimeMs: null, lastSequence: null, error: "" };
      return { available: false, inserted: 0 };
    }
    const currentFiles = new Set(entries.map((entry) => path.join(directory, entry.name)));
    for (const filename of fileState.keys()) if (!currentFiles.has(filename)) fileState.delete(filename);
    for (const filename of fileIntegrity.keys()) if (!currentFiles.has(filename)) fileIntegrity.delete(filename);
    let inserted = 0;
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      let metadata;
      try { metadata = await stat(filename); } catch { continue; }
      const signature = `${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
      if (fileState.get(filename) === signature) continue;
      let content;
      try { content = await readFile(filename, "utf8"); } catch { continue; }
      const lines = content.split("\n");
      const hasIncompleteTail = Boolean(lines.at(-1)?.trim() && !content.endsWith("\n"));
      let damaged = false;
      const events = [];
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line || (hasIncompleteTail && index === lines.length - 1)) continue;
        let event = null;
        try { event = normalizeMinecraftPlayerEvent(JSON.parse(line)); } catch {}
        if (event) events.push(event);
        else damaged = true;
      }
      if (events.length) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const event of events) {
            const result = insertEvent.run(event.eventId, event.runId, event.sequence, event.type, event.playerId, event.playerName, event.jvmUptimeMs, event.occurredAt);
            inserted += Number(result.changes || 0);
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      const freshIncompleteTail = hasIncompleteTail && now() - metadata.mtimeMs <= COLLECTOR_FRESH_MS;
      fileIntegrity.set(filename, !damaged && (!hasIncompleteTail || freshIncompleteTail));
      if (hasIncompleteTail) fileState.delete(filename);
      else fileState.set(filename, signature);
    }
    collector = await readCollectorStatus()
      || { live: false, state: "stale", runId: null, sampledAt: null, jvmUptimeMs: null, lastSequence: null, error: "" };
    return { available: true, inserted };
  }

  function recent(limit = DEFAULT_LIMIT) {
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(limit) || DEFAULT_LIMIT)));
    const events = replayEvents.all();
    const collectorSequence = collector.runId ? Number(maximumSequence.get(collector.runId)?.sequence) : null;
    const collectorCovered = !collector.live
      || (Number.isSafeInteger(collectorSequence) && collectorSequence >= collector.lastSequence);
    const integrity = Number(brokenSequences.get()?.count || 0) === 0
      && [...fileIntegrity.values()].every(Boolean)
      && collectorCovered;
    const collectorLive = Boolean(collector.live && integrity);
    const sessions = projectSessions(events).map((session) => {
      const online = Boolean(session.online && collectorLive && session.runId === collector.runId);
      const unresolved = Boolean(session.online && !online);
      let durationSeconds = session.durationSeconds;
      if (online && session.startedUptimeMs != null && collector.jvmUptimeMs != null) {
        const elapsed = collector.jvmUptimeMs - session.startedUptimeMs;
        durationSeconds = elapsed >= 0 ? Math.floor(elapsed / 1000) : null;
      }
      return {
        id: session.id,
        playerName: session.playerName,
        joinedAt: session.joinedAt,
        observedAt: session.observedAt,
        leftAt: session.leftAt,
        endBefore: session.endBefore,
        startReason: session.startReason,
        endReason: unresolved ? "collector-offline" : session.endReason,
        online,
        unresolved,
        durationSeconds
      };
    }).sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      const leftTime = Date.parse(left.leftAt || left.endBefore || left.joinedAt || left.observedAt || 0);
      const rightTime = Date.parse(right.leftAt || right.endBefore || right.joinedAt || right.observedAt || 0);
      return rightTime - leftTime;
    });
    return {
      sessions: sessions.slice(0, safeLimit),
      total: sessions.length,
      eventCount: Number(countEvents.get()?.count || 0),
      available: journalAvailable || events.length > 0,
      archiveAvailable: journalAvailable || events.length > 0,
      collectorLive,
      collectorState: integrity ? collector.state : "degraded",
      collectorSampledAt: collector.sampledAt,
      integrity,
      precision: integrity ? "forge-event" : "degraded"
    };
  }

  return { sync, recent };
}
