import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeTelemetry, observeFeed, observeService, observeStorage } from "../src/observability.js";

const NOW = Date.parse("2026-08-08T22:10:00.000Z");

test("derives feed freshness only from a verified mint timestamp", () => {
  const fresh = observeFeed({ mode: "live", feedStatus: "connected", lastMintAt: "2026-08-08T22:09:10.000Z", now: NOW });
  assert.equal(fresh.state, "live");
  assert.equal(fresh.lastMintAgeSeconds, 50);
  assert.equal(fresh.staleAfterSeconds, 90);
  assert.equal(fresh.isStale, false);

  const stale = observeFeed({ mode: "live", feedStatus: "live", lastMintAt: "2026-08-08T22:08:00.000Z", now: NOW });
  assert.equal(stale.state, "stale");
  assert.equal(stale.lastMintAgeSeconds, 120);
  assert.equal(stale.isStale, true);
  assert.equal(stale.freshnessBasis, "verified-feed-activity");
});

test("distinguishes no data, invalid clocks, upstream failures, and simulation", () => {
  assert.equal(observeFeed({ mode: "live", feedStatus: "connected", now: NOW }).state, "awaiting-data");
  const noActivity = observeFeed({ mode: "live", feedStatus: "connected", observedSince: "2026-08-08T22:08:00.000Z", now: NOW });
  assert.equal(noActivity.state, "stale");
  assert.equal(noActivity.isStale, true);
  assert.equal(noActivity.freshnessSource, "observationWindow");
  assert.equal(observeFeed({ mode: "live", feedStatus: "connected", lastMintAt: "bad", now: NOW }).state, "clock-skew");
  assert.equal(observeFeed({ mode: "live", feedStatus: "reconnecting", lastMintAt: "2026-08-08T22:09:50.000Z", now: NOW }).state, "reconnecting");
  assert.equal(observeFeed({ mode: "demo", feedStatus: "connected", lastMintAt: "bad", now: NOW }).state, "simulated");
});

test("uses verified feed activity while retaining mint and raw-message ages", () => {
  const feed = observeFeed({
    mode: "live",
    feedStatus: "live",
    lastMintAt: "2026-08-08T22:00:00.000Z",
    lastActivityAt: "2026-08-08T22:09:40.000Z",
    lastMessageAt: "2026-08-08T22:09:50.000Z",
    now: NOW
  });
  assert.equal(feed.state, "live");
  assert.equal(feed.freshnessSource, "lastActivityAt");
  assert.equal(feed.lastMintAgeSeconds, 600);
  assert.equal(feed.lastActivityAgeSeconds, 20);
  assert.equal(feed.lastMessageAgeSeconds, 10);
});

test("reports non-negative service uptime", () => {
  assert.deepEqual(observeService("2026-08-08T22:09:30.000Z", NOW), {
    startedAt: "2026-08-08T22:09:30.000Z",
    uptimeSeconds: 30
  });
  assert.equal(observeService("2026-08-08T22:11:00.000Z", NOW).uptimeSeconds, 0);
});

test("distinguishes a configured database path from a verified volume mount", () => {
  const mounted = observeStorage({
    databasePath: "/app/data/pump-war-room.db",
    canonicalDatabasePath: "/app/data/pump-war-room.db",
    platform: "linux",
    mountInfo: "36 25 0:32 / /app/data rw,relatime - ext4 /dev/volume rw"
  });
  assert.deepEqual(mounted, {
    schemaVersion: 1,
    database: "sqlite",
    requiredMountPath: "/app/data",
    configuredForPersistence: true,
    canonicalPathWithinRequiredMount: true,
    mountInfoAvailable: true,
    mountPointVerified: true,
    filesystemType: "ext4",
    state: "mounted"
  });

  const pathOnly = observeStorage({
    databasePath: "/app/data/pump-war-room.db",
    platform: "linux",
    mountInfo: "36 25 0:32 / / rw,relatime - overlay overlay rw"
  });
  assert.equal(pathOnly.configuredForPersistence, true);
  assert.equal(pathOnly.mountPointVerified, false);
  assert.equal(pathOnly.state, "unverified");

  const memoryBacked = observeStorage({
    databasePath: "/app/data/pump-war-room.db",
    platform: "linux",
    mountInfo: "36 25 0:32 / /app/data rw,relatime - tmpfs tmpfs rw"
  });
  assert.equal(memoryBacked.mountPointVerified, false);
  assert.equal(memoryBacked.filesystemType, "tmpfs");

  const nestedOverride = observeStorage({
    databasePath: "/app/data/runtime/pump-war-room.db",
    canonicalDatabasePath: "/app/data/runtime/pump-war-room.db",
    platform: "linux",
    mountInfo: [
      "36 25 0:32 / /app/data rw,relatime - ext4 /dev/volume rw",
      "37 36 0:33 / /app/data/runtime rw,relatime - tmpfs tmpfs rw"
    ].join("\n")
  });
  assert.equal(nestedOverride.mountPointVerified, false);
  assert.equal(nestedOverride.filesystemType, "tmpfs");

  const escapedCanonicalPath = observeStorage({
    databasePath: "/app/data/pump-war-room.db",
    canonicalDatabasePath: "/tmp/escaped.db",
    platform: "linux",
    mountInfo: "36 25 0:32 / /app/data rw,relatime - ext4 /dev/volume rw"
  });
  assert.equal(escapedCanonicalPath.configuredForPersistence, true);
  assert.equal(escapedCanonicalPath.canonicalPathWithinRequiredMount, false);
  assert.equal(escapedCanonicalPath.mountPointVerified, false);

  const local = observeStorage({ databasePath: "/tmp/pump-war-room.db", platform: "linux", mountInfo: "" });
  assert.equal(local.configuredForPersistence, false);
  assert.equal(local.state, "ephemeral-path");
});

test("emits structured redacted errors and exposes bounded counters", () => {
  const lines = [];
  const output = { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  const telemetry = createRuntimeTelemetry({ version: "0.5.1", mode: "live", startedAt: NOW, now: () => NOW, uptime: () => 30.8, output });

  telemetry.info("service.started", { apiKey: "do-not-print" });
  telemetry.error("feed.failure", new Error("token=super-secret https://user:pass@example.com"), { requestId: "safe-id" });
  telemetry.recordResponse(200);
  telemetry.recordResponse(503);
  telemetry.recordResponse(503, { readiness: true });

  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records[0].apiKey, "[REDACTED]");
  assert.equal(records[1].level, "error");
  assert.equal(records[1].error.message.includes("super-secret"), false);
  assert.equal(records[1].error.message.includes("pass@example.com"), false);
  telemetry.error("auth.failure", new Error("Authorization: Bearer TOPSECRET https://example.test/?api_key=QUERYSECRET"));
  assert.equal(lines.at(-1).includes("TOPSECRET"), false);
  assert.equal(lines.at(-1).includes("QUERYSECRET"), false);
  telemetry.error("upstream.failure", new Error('upstream body {"apiKey":"JSONSECRET","Authorization":"Bearer HEADERSECRET","password":"PASSSECRET"}'));
  assert.equal(lines.at(-1).includes("JSONSECRET"), false);
  assert.equal(lines.at(-1).includes("HEADERSECRET"), false);
  assert.equal(lines.at(-1).includes("PASSSECRET"), false);
  assert.match(lines.at(-1), /\[REDACTED\]/);
  process.env.PWR_TEST_API_KEY = "CONFIGUREDSECRET";
  try {
    telemetry.error("escaped.failure", new Error('escaped {\\"apiKey\\":\\"ESCAPEDSECRET\\"} json {"client_secret":"CLIENTSECRET","access_token":"ACCESSSECRET","BARK_API_KEY":"BARKSECRET"} configured CONFIGUREDSECRET'));
  } finally {
    delete process.env.PWR_TEST_API_KEY;
  }
  for (const canary of ["ESCAPEDSECRET", "CLIENTSECRET", "ACCESSSECRET", "BARKSECRET", "CONFIGUREDSECRET"]) {
    assert.equal(lines.at(-1).includes(canary), false, `${canary} was not redacted`);
  }
  telemetry.info("credential.field", { private_key: "PRIVATEKEYSECRET", cookie: "COOKIESECRET" });
  assert.equal(lines.at(-1).includes("PRIVATEKEYSECRET"), false);
  assert.equal(lines.at(-1).includes("COOKIESECRET"), false);
  assert.deepEqual(telemetry.service(), { startedAt: "2026-08-08T22:10:00.000Z", uptimeSeconds: 30 });
  assert.deepEqual(telemetry.snapshot(), {
    schemaVersion: 1,
    format: "json-lines",
    errorsTotal: 4,
    lastErrorAt: "2026-08-08T22:10:00.000Z",
    errorsByEvent: { "auth.failure": 1, "escaped.failure": 1, "feed.failure": 1, "upstream.failure": 1 },
    responsesTotal: 3,
    responses5xx: 1,
    last5xxAt: "2026-08-08T22:10:00.000Z",
    readinessFailures: 1,
    lastReadinessFailureAt: "2026-08-08T22:10:00.000Z"
  });
});
