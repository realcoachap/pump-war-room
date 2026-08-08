import test from "node:test";
import assert from "node:assert/strict";
import { classifyPumpPortalEvent, PumpPortalIngestor } from "../src/ingest.js";

const FIXED_TIME = Date.parse("2026-08-08T21:00:00.000Z");

function fakeWebSocketClass() {
  return class FakeWebSocket {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      this.closed = false;
      this.constructor.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(payload) { this.sent.push(JSON.parse(payload)); }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    close() {
      this.closed = true;
      this.emit("close", { code: 1000 });
    }
  };
}

function fakeTimers() {
  const tasks = [];
  return {
    tasks,
    setTimeoutFn(callback, delay) {
      const task = { callback, delay, cleared: false, unref() {} };
      tasks.push(task);
      return task;
    },
    clearTimeoutFn(task) { task.cleared = true; },
    run(task) {
      if (task.cleared) return;
      task.cleared = true;
      task.callback();
    }
  };
}

const pendingTimers = (timers) => timers.tasks.filter((task) => !task.cleared);

test("new live tokens remain risk-unverified until enrichment arrives", () => {
  let observed;
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    now: () => FIXED_TIME,
    onToken: (token) => { observed = token; }
  });

  ingestor.handle({ mint: "LiveMintPump", name: "Same Name", symbol: "SAME", marketCapSol: 10 });

  assert.equal(observed.mint, "LiveMintPump");
  assert.equal(observed.source, "pumpportal");
  assert.equal(observed.risk, null);
  assert.equal(observed.riskConfidence, "unverified");
  assert.equal(observed.devHoldingPct, null);
  assert.equal(observed.top10Pct, null);
});

test("classifies create frames with a pool as new tokens, not migrations", () => {
  const raw = {
    txType: "create",
    mint: "NewMintPump",
    pool: "pump",
    name: "Actually New",
    symbol: "NEW"
  };
  const tokens = [];
  const migrations = [];
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    now: () => FIXED_TIME,
    onToken: (token) => tokens.push(token),
    onMigration: (migration) => migrations.push(migration)
  });

  assert.equal(classifyPumpPortalEvent(raw), "new-token");
  ingestor.handle(raw);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].mint, "NewMintPump");
  assert.equal(migrations.length, 0);
});

test("classifies explicit migrations and ignores pool-bearing trade events", () => {
  const tokens = [];
  const migrations = [];
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    now: () => FIXED_TIME,
    onToken: (token) => tokens.push(token),
    onMigration: (migration) => migrations.push(migration)
  });

  ingestor.handle({ txType: "migrate", mint: "DoneMint", pool: "pump-amm" });
  ingestor.handle({ txType: "buy", mint: "DoneMint", pool: "pump", solAmount: 1 });
  ingestor.handle({ mint: "PoolOnlyMint", pool: "raydium" });

  assert.deepEqual(migrations.map(({ mint }) => mint), ["DoneMint"]);
  assert.equal(tokens.length, 0);
  assert.equal(ingestor.getStatus().counters.migrations, 1);
  assert.equal(ingestor.getStatus().counters.ignoredMessages, 2);
});

test("malformed websocket JSON is counted and the next valid event is processed", () => {
  const WebSocketImpl = fakeWebSocketClass();
  const statuses = [];
  const tokens = [];
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    WebSocketImpl,
    now: () => FIXED_TIME,
    onStatus: (status, metadata) => statuses.push({ status, metadata }),
    onToken: (token) => tokens.push(token)
  });

  ingestor.connect();
  const socket = WebSocketImpl.instances[0];
  socket.emit("open");

  assert.deepEqual(socket.sent.map(({ method }) => method), ["subscribeNewToken", "subscribeMigration"]);
  assert.equal(statuses.at(-1).status, "connected");
  assert.equal(statuses.at(-1).metadata.connectionStatus, "connected");
  assert.equal(statuses.at(-1).metadata.activityStatus, "waiting");
  assert.equal(statuses.at(-1).metadata.verifiedActivity, false);

  assert.doesNotThrow(() => socket.emit("message", { data: "{ definitely-not-json" }));
  assert.equal(ingestor.getStatus().status, "degraded");
  assert.equal(ingestor.getStatus().connectionStatus, "connected");
  assert.equal(ingestor.getStatus().counters.malformedMessages, 1);
  assert.equal(ingestor.getStatus().lastErrorAt, "2026-08-08T21:00:00.000Z");

  socket.emit("message", {
    data: JSON.stringify({ txType: "create", mint: "RecoveredMint", pool: "pump", name: "Recovered", symbol: "OK" })
  });

  const status = ingestor.getStatus();
  assert.equal(tokens.length, 1);
  assert.equal(status.status, "live");
  assert.equal(status.connectionStatus, "connected");
  assert.equal(status.activityStatus, "verified");
  assert.equal(status.verifiedActivity, true);
  assert.equal(status.lastActivityAt, "2026-08-08T21:00:00.000Z");
  assert.deepEqual(status.counters, {
    connectionAttempts: 1,
    connectionsOpened: 1,
    connectionTimeouts: 0,
    reconnectsScheduled: 0,
    socketErrors: 0,
    sendErrors: 0,
    messagesReceived: 2,
    malformedMessages: 1,
    ignoredMessages: 0,
    newTokens: 1,
    migrations: 0
  });
});

test("unexpected close reconnects once, while explicit close cancels reconnect", () => {
  const WebSocketImpl = fakeWebSocketClass();
  const timers = fakeTimers();
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    WebSocketImpl,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => FIXED_TIME
  });

  ingestor.connect();
  const first = WebSocketImpl.instances[0];
  first.emit("open");
  first.emit("close", { code: 1006 });
  first.emit("close", { code: 1006 });

  assert.equal(pendingTimers(timers).length, 1);
  assert.equal(pendingTimers(timers)[0].delay, 1_000);
  assert.equal(ingestor.getStatus().status, "reconnecting");
  assert.equal(ingestor.getStatus().counters.reconnectsScheduled, 1);

  timers.run(pendingTimers(timers)[0]);
  assert.equal(WebSocketImpl.instances.length, 2);
  const second = WebSocketImpl.instances[1];
  second.emit("open");
  second.emit("close", { code: 1006 });
  const pending = pendingTimers(timers)[0];
  assert.equal(pending.delay, 1_000);

  ingestor.close();
  assert.equal(pending.cleared, true);
  timers.run(pending);
  assert.equal(WebSocketImpl.instances.length, 2);
  assert.equal(ingestor.getStatus().status, "closed");
  assert.equal(ingestor.getStatus().connectionStatus, "closed");
});

test("explicitly closing an open socket never schedules a reconnect", () => {
  const WebSocketImpl = fakeWebSocketClass();
  const timers = fakeTimers();
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    WebSocketImpl,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => FIXED_TIME
  });

  ingestor.connect();
  const socket = WebSocketImpl.instances[0];
  socket.emit("open");
  ingestor.close();

  assert.equal(socket.closed, true);
  assert.equal(pendingTimers(timers).length, 0);
  assert.equal(ingestor.getStatus().counters.reconnectsScheduled, 0);
});

test("times out a blackholed websocket handshake and schedules one reconnect", () => {
  const WebSocketImpl = fakeWebSocketClass();
  const timers = fakeTimers();
  const statuses = [];
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    WebSocketImpl,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    connectTimeoutMs: 5_000,
    now: () => FIXED_TIME,
    onStatus: (status, metadata) => statuses.push({ status, metadata })
  });

  ingestor.connect();
  const socket = WebSocketImpl.instances[0];
  const timeout = pendingTimers(timers)[0];
  assert.equal(timeout.delay, 5_000);
  timers.run(timeout);

  assert.equal(socket.closed, true);
  assert.equal(ingestor.getStatus().status, "reconnecting");
  assert.equal(ingestor.getStatus().connectionStatus, "reconnecting");
  assert.equal(ingestor.getStatus().counters.connectionTimeouts, 1);
  assert.equal(ingestor.getStatus().counters.reconnectsScheduled, 1);
  assert.match(ingestor.getStatus().lastError, /open timed out/);
  assert.deepEqual(statuses.slice(-2).map(({ status }) => status), ["degraded", "reconnecting"]);
  assert.equal(pendingTimers(timers).length, 1);
  assert.equal(pendingTimers(timers)[0].delay, 1_000);
});

test("getStatus exposes counters and raw-message age after repeated healthy traffic", () => {
  const WebSocketImpl = fakeWebSocketClass();
  const statuses = [];
  let tick = FIXED_TIME;
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    WebSocketImpl,
    now: () => tick,
    onStatus: (status, metadata) => statuses.push({ status, metadata })
  });

  ingestor.connect();
  const socket = WebSocketImpl.instances[0];
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ txType: "create", mint: "MintOne", name: "One", symbol: "ONE" }) });
  tick += 1_000;
  socket.emit("message", { data: JSON.stringify({ txType: "create", mint: "MintTwo", name: "Two", symbol: "TWO" }) });
  tick += 1_000;
  socket.emit("message", { data: JSON.stringify({ txType: "buy", mint: "MintTwo" }) });

  const live = ingestor.getStatus();
  assert.equal(live.status, "live");
  assert.equal(live.lastMessageAt, "2026-08-08T21:00:02.000Z");
  assert.equal(live.lastActivityAt, "2026-08-08T21:00:01.000Z");
  assert.equal(live.counters.messagesReceived, 3);
  assert.equal(live.counters.newTokens, 2);
  assert.equal(live.counters.ignoredMessages, 1);
  assert.equal(statuses.at(-1).metadata.counters.messagesReceived, 1);
});
