import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, STORE_SCHEMA_VERSION } from "../src/store.js";
import {
  parseGeckoTerminalTokenInfo,
  RISK_IDENTITY_METHOD_VERSION,
  RISK_IDENTITY_PARSER_REVISION
} from "../src/risk-identity.js";

const createdAt = "2026-08-08T12:00:00.000Z";
const geckoMint = "11111111111111111111111111111111";
const secondGeckoMint = "22222222222222222222222222222222";

function temporaryStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-store-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function seedMixedSources(store) {
  store.upsertToken({ mint: "demo-mint", symbol: "DEMO", source: "demo", createdAt });
  store.upsertToken({ mint: "live-mint", symbol: "LIVE", source: "pumpportal", createdAt });
  store.upsertToken({ mint: "unknown-mint", symbol: "UNKNOWN", createdAt });

  store.addEvent("mint", { mint: "demo-mint", source: "demo" });
  store.addEvent("update", { mint: "demo-mint", source: "demo" });
  store.addEvent("mint", { mint: "live-mint", source: "pumpportal" });
  store.addEvent("update", { mint: "unknown-mint" });

  store.addAlert({ level: "signal", title: "Demo alert", message: "synthetic", mint: "demo-mint", createdAt });
  store.addAlert({ level: "signal", title: "Live alert", message: "verified", mint: "live-mint", createdAt });
  store.addAlert({ level: "signal", title: "Orphan alert", message: "unknown", mint: "orphan-mint", createdAt });

  store.upsertCallout({ externalId: "demo-named-callout", mint: "demo-mint", source: "demo", createdAt });
  store.upsertCallout({ externalId: "live-callout", mint: "live-mint", source: "bark", createdAt });
}

test("counts token, event, and associated alert rows by JSON payload source", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.countBySource("demo"), { tokens: 1, events: 2, alerts: 1 });
  assert.deepEqual(store.countBySource("pumpportal"), { tokens: 1, events: 1, alerts: 1 });
  assert.deepEqual(store.countBySource("missing"), { tokens: 0, events: 0, alerts: 0 });
  assert.throws(() => store.countBySource(""), /non-empty string/);
});

test("source operations tolerate malformed legacy JSON without treating it as demo data", (t) => {
  const store = temporaryStore(t);
  const insertToken = store.db.prepare("INSERT INTO tokens (mint,payload,created_at,updated_at) VALUES (?,?,?,?)");
  const insertEvent = store.db.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)");
  insertToken.run("malformed-mint", "{not-json", createdAt, createdAt);
  insertEvent.run("mint", "malformed-mint", "{not-json", createdAt);

  assert.deepEqual(store.countBySource("demo"), { tokens: 0, events: 0, alerts: 0 });
  assert.deepEqual(store.purgeDemoData(), { alerts: 0, events: 0, tokens: 0 });
  assert.deepEqual(store.tokens(), []);
  assert.equal(store.token("malformed-mint"), null);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM tokens WHERE mint='malformed-mint'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM events WHERE mint='malformed-mint'").get().count, 1);
});

test("counts only source-verified token rows since an inclusive timestamp", (t) => {
  const store = temporaryStore(t);
  const before = "2026-08-08T11:59:59.999Z";
  const after = "2026-08-08T12:00:00.001Z";
  store.upsertToken({ mint: "live-before", source: "pumpportal", createdAt: before });
  store.upsertToken({ mint: "live-boundary", source: "pumpportal", createdAt });
  store.upsertToken({ mint: "live-after", source: "pumpportal", createdAt: after });
  store.upsertToken({ mint: "demo-after", source: "demo", createdAt: after });
  store.upsertToken({ mint: "unknown-after", createdAt: after });
  store.db.prepare("INSERT INTO tokens (mint,payload,created_at,updated_at) VALUES (?,?,?,?)")
    .run("malformed-after", "{not-json", after, after);

  assert.equal(store.countSinceBySource(createdAt, "pumpportal"), 2);
  assert.equal(store.countSinceBySource(createdAt, "demo"), 1);
  assert.equal(store.countSinceBySource(createdAt, "unknown"), 0);
  assert.equal(store.countSinceBySource(after, "pumpportal"), 1);
  assert.equal(store.countSince(createdAt), 5);
  assert.throws(() => store.countSinceBySource(createdAt, ""), /non-empty string/);
});

test("purges only demo tokens, demo events, and alerts tied to demo tokens", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.purgeDemoData(), { alerts: 1, events: 2, tokens: 1 });
  assert.deepEqual(store.countBySource("demo"), { tokens: 0, events: 0, alerts: 0 });

  assert.deepEqual(store.tokens().map((token) => token.mint).sort(), ["live-mint", "unknown-mint"]);
  assert.deepEqual(store.alerts().map((alert) => alert.title).sort(), ["Live alert", "Orphan alert"]);
  assert.deepEqual(store.callouts().map((callout) => callout.externalId).sort(), ["demo-named-callout", "live-callout"]);

  const remainingEvents = store.db.prepare("SELECT payload FROM events ORDER BY id").all().map((row) => JSON.parse(row.payload));
  assert.deepEqual(remainingEvents.map((event) => event.mint), ["live-mint", "unknown-mint"]);
});

test("demo purge is idempotent", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.purgeDemoData(), { alerts: 1, events: 2, tokens: 1 });
  assert.deepEqual(store.purgeDemoData(), { alerts: 0, events: 0, tokens: 0 });
  assert.equal(store.count(), 2);
  assert.equal(store.callouts().length, 2);
});

test("demo purge rolls back every deletion when any step fails", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);
  store.db.exec(`CREATE TRIGGER reject_demo_event_delete
    BEFORE DELETE ON events
    WHEN json_valid(OLD.payload) AND json_extract(OLD.payload, '$.source') = 'demo'
    BEGIN SELECT RAISE(ABORT, 'blocked demo event deletion'); END;`);

  assert.throws(() => store.purgeDemoData(), /blocked demo event deletion/);
  assert.deepEqual(store.countBySource("demo"), { tokens: 1, events: 2, alerts: 1 });
  assert.equal(store.alerts().length, 3);
  assert.equal(store.callouts().length, 2);
});

test("writes one bounded, secret-free enrichment state per mint without stale regression", (t) => {
  const store = temporaryStore(t);
  store.upsertToken({ mint: "OutcomeMintPump", source: "pumpportal", createdAt: "2026-08-08T12:00:00.000Z" });
  store.upsertToken({ mint: secondGeckoMint, source: "pumpportal", createdAt: "2026-08-08T12:00:01.000Z" });
  const state = {
    mint: "OutcomeMintPump", provider: "dexscreener", pool: "Pool111", tokenSide: "base",
    dex: "raydium", sourceUrl: "https://dex.example/pools/Pool111", status: "partial",
    missingReason: "missing-24h", errorCode: null, attemptCount: 2,
    lastAttemptAt: "2026-08-08T12:02:00.000Z", nextAttemptAt: "2026-08-08T12:10:00.000Z",
    lastSuccessAt: "2026-08-08T12:01:00.000Z", updatedAt: "2026-08-08T12:02:01.000Z",
    evidence: {
      outcome: {
        schemaVersion: 1,
        baseline: { observedAt: "2026-08-08T12:00:00.000Z", source: "dexscreener", pool: "Pool111", nonempty: true },
        windows: {
          "5m": { status: "observed", observedAt: "2026-08-08T12:05:00.000Z", returnPct: 12.5, maximumDrawdownPct: 4.25 },
          "24h": { status: "unavailable", observedAt: null, returnPct: null, reason: "window-not-mature" }
        }
      }
    }
  };

  const inserted = store.upsertEnrichmentState(state);
  assert.equal(inserted.written, true);
  assert.deepEqual(inserted.state, {
    mint: "OutcomeMintPump", provider: "dexscreener", pool: "Pool111", tokenSide: "base",
    dex: "raydium", sourceUrl: "https://dex.example/pools/Pool111", status: "partial",
    evidence: state.evidence, missingReason: "missing-24h",
    errorCode: null, attemptCount: 2, lastAttemptAt: "2026-08-08T12:02:00.000Z",
    nextAttemptAt: "2026-08-08T12:10:00.000Z", lastSuccessAt: "2026-08-08T12:01:00.000Z",
    updatedAt: "2026-08-08T12:02:01.000Z"
  });
  assert.deepEqual(store.upsertEnrichmentState(state), { written: false, stale: false, state: inserted.state });
  assert.equal(store.upsertEnrichmentState({ ...state, attemptCount: 1, updatedAt: "2026-08-08T12:02:00.000Z" }).stale, true);
  assert.deepEqual(store.enrichmentState("OutcomeMintPump"), inserted.state);

  assert.throws(() => store.upsertEnrichmentState({ ...state, updatedAt: "2026-08-08T12:03:00.000Z", attemptCount: 1 }), /must not decrease/);
  assert.throws(() => store.upsertEnrichmentState({ ...state, sourceUrl: "https://dex.example/pool?api_key=secret" }), /query parameters/);
  assert.throws(() => store.upsertEnrichmentState({ ...state, evidence: { apiKey: "do-not-store" } }), /key is not allowed/);
  assert.throws(() => store.upsertEnrichmentState({ ...state, evidence: { candles: [{ close: 1 }] } }), /raw provider data/);
  assert.throws(() => store.upsertEnrichmentState({ ...state, evidence: { baseline: { close: 1 } } }), /raw provider data/);
  const geckoValidationState = {
    mint: geckoMint, provider: "geckoterminal", pool: null, tokenSide: null, dex: null, sourceUrl: null,
    status: "queued", missingReason: "Prospective launch admitted; provider evidence pending", errorCode: null,
    attemptCount: 0, lastAttemptAt: null, nextAttemptAt: "2026-08-08T12:03:00.000Z", lastSuccessAt: null,
    updatedAt: "2026-08-08T12:03:00.000Z"
  };
  assert.throws(() => store.upsertEnrichmentState({ ...geckoValidationState, evidence: { source: "geckoterminal", providerSeries: [1, 2, 3] } }), /key is not permitted/);
  assert.throws(() => store.upsertEnrichmentState({ ...geckoValidationState, evidence: { source: "geckoterminal", series: [[1720000000, 1, 2, 0.5, 1.5, 999]] } }), /key is not permitted|must not be an array/);
  assert.throws(() => store.upsertEnrichmentState({ ...geckoValidationState, evidence: { source: "geckoterminal", providerStatus: [[1720000000, 1, 2, 0.5, 1.5, 999]] } }), /non-negative integer/);
  assert.throws(() => store.upsertEnrichmentState({ ...geckoValidationState, evidence: { source: "geckoterminal", retention: "[[1720000000,1,2,0.5,1.5,999]]" } }), /must not encode structured provider data/);
  assert.throws(() => store.upsertEnrichmentState({ ...geckoValidationState, missingReason: "1720000000,1,2,0.5,1.5,999", evidence: { source: "geckoterminal" } }), /missingReason is invalid/);
  const liquidityBase = {
    schemaVersion: 1,
    source: "geckoterminal",
    attemptedAt: "2026-08-08T12:03:00.000Z",
    basis: "provider-observed-pool-reserve",
    limitation: "GeckoTerminal-observed pool reserve is not evidence of locked liquidity"
  };
  assert.throws(() => store.upsertEnrichmentState({
    ...geckoValidationState,
    evidence: { liquidity: {
      ...liquidityBase, evidenceClass: "provider-observed", observedAt: null,
      liquidityUsd: null, missingReasonCode: "pool-reserve-missing"
    } }
  }), /provider-observed liquidity evidence requires/);
  assert.throws(() => store.upsertEnrichmentState({
    ...geckoValidationState,
    evidence: { liquidity: {
      ...liquidityBase, evidenceClass: "unavailable", observedAt: "2026-08-08T12:03:00.000Z",
      liquidityUsd: 123, missingReasonCode: null
    } }
  }), /unavailable liquidity evidence requires/);
  const awaiting = store.upsertEnrichmentState({
    mint: secondGeckoMint, provider: "geckoterminal", pool: null, tokenSide: null, dex: null,
    sourceUrl: null, evidence: { providerStatus: 404 }, status: "awaiting-pool",
    missingReason: "No eligible provider pool is available yet", errorCode: "pool-unavailable",
    lastAttemptAt: "2026-08-08T12:03:00.000Z", nextAttemptAt: "2026-08-08T12:18:00.000Z",
    lastSuccessAt: null
  }).state;
  assert.equal(awaiting.attemptCount, 1);
  assert.equal(awaiting.updatedAt, "2026-08-08T12:03:00.000Z");
  assert.deepEqual(store.enrichmentStates({ limit: 2 }).map(({ mint }) => mint), [secondGeckoMint, "OutcomeMintPump"]);
  assert.deepEqual(store.enrichmentStates({ provider: "dexscreener", status: "partial" }).map(({ mint }) => mint), ["OutcomeMintPump"]);
  assert.throws(() => store.enrichmentStates({ limit: 201 }), /limit/);
  assert.deepEqual(store.outcomeCoverage(), {
    provider: null, status: null, stateCount: 2, providerSelectedCount: 1, successCount: 1,
    firstUpdatedAt: "2026-08-08T12:02:01.000Z", lastUpdatedAt: "2026-08-08T12:03:00.000Z",
    statusCounts: { "awaiting-pool": 1, partial: 1 }
  });
  assert.deepEqual(store.outcomeCoverage({ provider: "dexscreener", status: "partial" }), {
    provider: "dexscreener", status: "partial", stateCount: 1, providerSelectedCount: 1, successCount: 1,
    firstUpdatedAt: "2026-08-08T12:02:01.000Z", lastUpdatedAt: "2026-08-08T12:02:01.000Z",
    statusCounts: { partial: 1 }
  });
  assert.deepEqual(store.dueEnrichmentTokens({ provider: "dexscreener", now: "2026-08-08T12:11:00.000Z" }).map(({ mint }) => mint), ["OutcomeMintPump"]);
  assert.deepEqual(store.dueEnrichmentTokens({ provider: "geckoterminal", now: "2026-08-08T12:17:59.000Z" }), []);
  assert.deepEqual(store.dueEnrichmentTokens({ provider: "geckoterminal", now: "2026-08-08T12:18:00.000Z" }).map(({ mint }) => mint), [secondGeckoMint]);
  assert.throws(() => store.dueEnrichmentTokens({ provider: "geckoterminal", now: "bad" }), /RFC 3339/);
  assert.deepEqual(store.deleteEnrichmentByProvider("dexscreener"), {
    provider: "dexscreener", removed: 1, removedOutcomes: 1, removedRiskIdentity: 0,
    removedEvents: 0, removedAlerts: 0, removedBriefs: 0, exclusiveAccessVerified: true, secureDelete: true,
    vacuumed: true, freelistCount: 0, walTruncated: true, journalModeRestored: "wal"
  });
  assert.equal(store.enrichmentState("OutcomeMintPump"), null);
  assert.equal(store.enrichmentState(secondGeckoMint).provider, "geckoterminal");
});

test("provider purge securely scrubs deleted bytes, truncates WAL, and keeps database files owner-only", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-provider-purge-"));
  const databasePath = path.join(directory, "war-room.db");
  const store = new Store(databasePath);
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const marker = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
  const riskMarker = "ab".repeat(32);
  const providerEventMarker = "gecko-risk-events-purge-marker";
  const providerAlertMarker = "gecko-risk-alerts-purge-marker";
  const providerBriefMarker = "gecko-brief-purge-marker";
  const unrelatedMarker = "unrelated-provider-preservation-marker";
  store.upsertToken({ mint: geckoMint, source: "pumpportal", createdAt });
  store.upsertToken({ mint: secondGeckoMint, source: "pumpportal", createdAt });
  store.upsertEnrichmentState({
    mint: geckoMint, provider: "geckoterminal", pool: marker, tokenSide: "base",
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${marker}`, status: "queued",
    missingReason: "Prospective launch admitted; provider evidence pending", errorCode: null,
    attemptCount: 0, lastAttemptAt: null, nextAttemptAt: createdAt, lastSuccessAt: null, updatedAt: createdAt,
    evidence: { source: "geckoterminal", retention: "derived-metrics-and-minimal-provenance-only" }
  });
  const riskEvidence = parseGeckoTerminalTokenInfo({ data: {
    id: `solana_${geckoMint}`,
    type: "token",
    attributes: {
      address: geckoMint, name: "Purge", symbol: "PURGE",
      holders: { count: 1, distribution_percentage: { top_10: "100" }, last_updated: createdAt },
      developer_address: null, developer_holding_percentage: null,
      twitter_handle: "purge_marker", telegram_handle: null, websites: []
    }
  } }, { mint: geckoMint, fetchedAt: createdAt });
  riskEvidence.fingerprints.xHandle.fingerprint = riskMarker;
  store.upsertRiskIdentityState({
    mint: geckoMint, provider: "geckoterminal", evidence: riskEvidence, status: "available",
    missingReason: null, errorCode: null, attemptCount: 1, lastAttemptAt: createdAt,
    nextAttemptAt: null, lastSuccessAt: createdAt, updatedAt: createdAt
  });
  store.upsertEnrichmentState({
    mint: secondGeckoMint, provider: "other-provider", pool: null, tokenSide: null,
    dex: null, sourceUrl: null, status: "queued", missingReason: "Unrelated provider row",
    errorCode: null, attemptCount: 0, lastAttemptAt: null, nextAttemptAt: createdAt,
    lastSuccessAt: null, updatedAt: createdAt,
    evidence: { source: "other-provider", marker: unrelatedMarker }
  });
  store.upsertRiskIdentityState({
    mint: secondGeckoMint, provider: "other-provider",
    evidence: { source: "other-provider", marker: unrelatedMarker }, status: "available",
    missingReason: null, errorCode: null, attemptCount: 1, lastAttemptAt: createdAt,
    nextAttemptAt: null, lastSuccessAt: createdAt, updatedAt: createdAt
  });

  const providerEvents = [
    ["concentration", 100, "%", "geckoterminal", "provider-observed"],
    ["developer-holding", 25, "%", "geckoterminal", "provider-observed"],
    ["pool-reserve", 1_000, " USD", "geckoterminal", "provider-observed"],
    ["identity-reuse", 2, " other mints", "locally-derived", "locally-derived"],
    ["creator-history", 3, " observed launches", "locally-derived", "locally-derived"]
  ];
  for (const [factor, value, unit, source, evidenceClass] of providerEvents) {
    store.addIntelligenceEvent({
      kind: "risk-evidence", mint: geckoMint,
      eventKey: `risk-evidence-v1:${factor}:${geckoMint}:${value}:${createdAt}`,
      evidenceClass, occurredAt: createdAt,
      payload: { mint: geckoMint, factor, value, unit, source, limitation: providerEventMarker }
    });
  }
  const unrelatedEventKey = `risk-evidence-v1:external-sentiment:${secondGeckoMint}:1:${createdAt}`;
  store.addIntelligenceEvent({
    kind: "risk-evidence", mint: secondGeckoMint, eventKey: unrelatedEventKey,
    evidenceClass: "provider-observed", occurredAt: createdAt,
    payload: {
      mint: secondGeckoMint, factor: "external-sentiment", value: 1, unit: null,
      source: "other-provider", limitation: unrelatedMarker
    }
  });

  const pendingRiskAlert = store.addAlert({
    level: "risk", title: "Provider concentration alert", message: providerAlertMarker,
    mint: geckoMint, kind: "risk-concentration", evidenceClass: "provider-observed",
    evidenceAt: createdAt, dedupeKey: `risk-concentration:${geckoMint}:${createdAt}`, createdAt
  }, { queueTelegram: true });
  const retryingRiskAlert = store.addAlert({
    level: "risk", title: "Derived identity alert", message: providerAlertMarker,
    mint: geckoMint, kind: "risk-identity-reuse", evidenceClass: "locally-derived",
    evidenceAt: createdAt, dedupeKey: `risk-identity-reuse:${geckoMint}:${createdAt}`, createdAt
  }, { queueTelegram: true });
  store.recordAlertTelegramAttempt(retryingRiskAlert.id, "retrying", {
    attemptedAt: createdAt, nextAttemptAt: "2026-08-08T12:01:00.000Z", errorCode: "ambiguous-network-failure"
  });
  const unrelatedQueuedAlert = store.addAlert({
    level: "signal", title: "Unrelated score alert", message: unrelatedMarker,
    mint: secondGeckoMint, kind: "score-rise", evidenceClass: "locally-derived",
    evidenceAt: createdAt, dedupeKey: `score-rise:${secondGeckoMint}:${createdAt}`, createdAt
  }, { queueTelegram: true });

  const providerBriefKey = "measured-closed-brief-v1:daily:2026-08-07T00:00:00.000Z:2026-08-08T00:00:00.000Z:UTC";
  const providerBriefModel = {
    briefId: providerBriefKey, methodVersion: "measured-closed-brief-v1", period: "daily",
    windowStart: "2026-08-07T00:00:00.000Z", windowEnd: "2026-08-08T00:00:00.000Z",
    generatedAt: createdAt, feedCoverage: "unmeasured", marker: providerBriefMarker
  };
  store.saveBriefRun({
    briefKey: providerBriefKey, kind: "daily", periodStart: providerBriefModel.windowStart,
    periodEnd: providerBriefModel.windowEnd, methodVersion: providerBriefModel.methodVersion,
    provider: "geckoterminal", dataCutoff: providerBriefModel.generatedAt, model: providerBriefModel
  });
  const unrelatedBriefKey = "measured-closed-brief-v1:weekly:2026-07-27T00:00:00.000Z:2026-08-03T00:00:00.000Z:UTC";
  const unrelatedBriefModel = {
    briefId: unrelatedBriefKey, methodVersion: "measured-closed-brief-v1", period: "weekly",
    windowStart: "2026-07-27T00:00:00.000Z", windowEnd: "2026-08-03T00:00:00.000Z",
    generatedAt: createdAt, feedCoverage: "unmeasured", marker: unrelatedMarker
  };
  store.saveBriefRun({
    briefKey: unrelatedBriefKey, kind: "weekly", periodStart: unrelatedBriefModel.windowStart,
    periodEnd: unrelatedBriefModel.windowEnd, methodVersion: unrelatedBriefModel.methodVersion,
    provider: "other-provider", dataCutoff: unrelatedBriefModel.generatedAt, model: unrelatedBriefModel
  });

  assert.deepEqual(
    store.dueTelegramAlerts({ now: createdAt }).map(({ id }) => id).sort((left, right) => left - right),
    [pendingRiskAlert.id, unrelatedQueuedAlert.id].sort((left, right) => left - right)
  );
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const beforePurge = readFileSync(databasePath);
  for (const [value, label] of [
    [marker, "outcome"], [riskMarker, "risk identity"], [providerEventMarker, "risk event"],
    [providerAlertMarker, "risk alert"], [providerBriefMarker, "brief"]
  ]) {
    assert.equal(beforePurge.includes(Buffer.from(value)), true, `${label} probe marker never reached the database file`);
  }
  assert.deepEqual(store.deleteEnrichmentByProvider("geckoterminal"), {
    provider: "geckoterminal", removed: 10, removedOutcomes: 1, removedRiskIdentity: 1,
    removedEvents: 5, removedAlerts: 2, removedBriefs: 1, exclusiveAccessVerified: true, secureDelete: true,
    vacuumed: true, freelistCount: 0, walTruncated: true, journalModeRestored: "wal"
  });
  assert.equal(store.enrichmentState(geckoMint), null);
  assert.equal(store.riskIdentityState(geckoMint), null);
  assert.equal(store.enrichmentState(secondGeckoMint).provider, "other-provider");
  assert.equal(store.riskIdentityState(secondGeckoMint).provider, "other-provider");
  assert.deepEqual(store.eventsForMint(geckoMint), []);
  assert.equal(store.eventsForMint(secondGeckoMint)[0].eventKey, unrelatedEventKey);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM alerts WHERE id IN (?,?)")
    .get(pendingRiskAlert.id, retryingRiskAlert.id).count, 0);
  assert.deepEqual(store.dueTelegramAlerts({ now: createdAt }).map(({ id }) => id), [unrelatedQueuedAlert.id]);
  assert.equal(store.alertsForMint(secondGeckoMint)[0].telegramStatus, "pending");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM brief_runs WHERE brief_key=?").get(providerBriefKey).count, 0);
  assert.equal(store.briefRun("weekly").briefKey, unrelatedBriefKey);
  assert.deepEqual(store.tokens().map(({ mint }) => mint).sort(), [geckoMint, secondGeckoMint].sort());
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(candidate)) continue;
    const contents = readFileSync(candidate);
    for (const [value, label] of [
      [marker, "outcome"], [riskMarker, "risk identity"], [providerEventMarker, "risk event"],
      [providerAlertMarker, "risk alert"], [providerBriefMarker, "brief"]
    ]) {
      assert.equal(contents.includes(Buffer.from(value)), false, `${path.basename(candidate)} retained deleted ${label} bytes`);
    }
    assert.equal(statSync(candidate).mode & 0o777, 0o600, `${path.basename(candidate)} was not owner-only`);
  }
  assert.equal(readFileSync(databasePath).includes(Buffer.from(unrelatedMarker)), true,
    "provider purge removed unrelated row bytes");
});

test("persists bounded risk identity evidence with due scheduling and explicit unknowns", (t) => {
  const store = temporaryStore(t);
  store.upsertToken({ mint: geckoMint, source: "pumpportal", createdAt });
  const queued = store.upsertRiskIdentityState({
    mint: geckoMint,
    provider: "geckoterminal",
    evidence: {
      schemaVersion: 1, mint: geckoMint, provider: "geckoterminal", source: "geckoterminal",
      endpoint: `/networks/solana/tokens/${geckoMint}/info`, apiVersion: "20230203",
      methodVersion: RISK_IDENTITY_METHOD_VERSION, evidenceClass: "unavailable", fetchedAt: null,
      attemptedAt: createdAt, missingReasonCode: "pending",
      retention: "normalized-scalars-and-domain-separated-fingerprints-only"
    },
    status: "queued",
    missingReason: "Provider token-info evidence pending",
    errorCode: null,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: "2026-08-08T12:15:00.000Z",
    lastSuccessAt: null,
    updatedAt: createdAt
  }).state;
  assert.equal(queued.status, "queued");
  assert.deepEqual(store.dueRiskIdentityTokens({ provider: "geckoterminal", now: "2026-08-08T12:14:59.000Z" }), []);
  assert.equal(store.dueRiskIdentityTokens({ provider: "geckoterminal", now: "2026-08-08T12:15:00.000Z" })[0].mint, geckoMint);

  const available = store.upsertRiskIdentityState({
    mint: geckoMint,
    provider: "geckoterminal",
    evidence: parseGeckoTerminalTokenInfo({ data: {
      id: `solana_${geckoMint}`,
      type: "token",
      attributes: {
        address: geckoMint, name: "Observed", symbol: "OBS",
        holders: { count: 42, distribution_percentage: { top_10: "51.2" }, last_updated: "2026-08-08T12:15:00.000Z" },
        developer_address: null, developer_holding_percentage: null,
        twitter_handle: null, telegram_handle: null, websites: []
      }
    } }, { mint: geckoMint, fetchedAt: "2026-08-08T12:16:00.000Z" }),
    status: "available",
    missingReason: null,
    errorCode: null,
    attemptCount: 1,
    lastAttemptAt: "2026-08-08T12:16:00.000Z",
    nextAttemptAt: null,
    lastSuccessAt: "2026-08-08T12:16:00.000Z",
    updatedAt: "2026-08-08T12:16:00.000Z"
  }).state;
  assert.equal(available.evidence.factors.top10HolderPercentage.value, 51.2);
  assert.throws(() => store.upsertRiskIdentityState({
    ...available,
    updatedAt: "2026-08-08T12:17:00.000Z",
    evidence: { ...available.evidence, description: "unrecognized provider field" }
  }), /outside the persistence allowlist/);
  assert.deepEqual(store.riskIdentityCoverage({ provider: "geckoterminal" }), {
    provider: "geckoterminal", status: null, stateCount: 1, successCount: 1,
    firstUpdatedAt: "2026-08-08T12:16:00.000Z", lastUpdatedAt: "2026-08-08T12:16:00.000Z",
    statusCounts: { available: 1 }, errorCodeCounts: {}, invalidAcquisitionCount: 0
  });
  assert.throws(() => store.upsertRiskIdentityState({
    ...available,
    updatedAt: "2026-08-08T12:17:00.000Z",
    evidence: { rawResponse: { secret: "bulk provider payload" } }
  }), /outside the persistence allowlist/);
  assert.throws(() => store.upsertRiskIdentityState({
    ...available,
    updatedAt: "2026-08-08T12:17:00.000Z",
    evidence: { ...available.evidence, liquidity: { volumeUsd: 99_999 } }
  }), /persistence allowlist|liquidity evidence/);
  assert.throws(() => store.upsertRiskIdentityState({
    ...available,
    attemptCount: 3,
    updatedAt: "2026-08-08T12:17:00.000Z"
  }), /between 0 and 2/);
  store.upsertRiskIdentityState({
    ...available,
    evidence: {
      ...available.evidence,
      parserAttemptRevision: RISK_IDENTITY_PARSER_REVISION,
      parserAttemptAt: "2026-08-08T12:17:00.000Z",
      parserAttemptStatus: "failed"
    },
    status: "degraded",
    missingReason: "Last valid token-info factors were retained after a refresh failure",
    errorCode: "invalid-json",
    attemptCount: 2,
    lastAttemptAt: "2026-08-08T12:17:00.000Z",
    updatedAt: "2026-08-08T12:17:00.000Z"
  });
  assert.deepEqual(store.riskIdentityCoverage({ provider: "geckoterminal" }), {
    provider: "geckoterminal", status: null, stateCount: 1, successCount: 1,
    firstUpdatedAt: "2026-08-08T12:17:00.000Z", lastUpdatedAt: "2026-08-08T12:17:00.000Z",
    statusCounts: { degraded: 1 }, errorCodeCounts: { "invalid-json": 1 }, invalidAcquisitionCount: 1
  });
});

test("provider purge fails closed before deletion when another database reader is active", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-provider-reader-"));
  const databasePath = path.join(directory, "war-room.db");
  const store = new Store(databasePath);
  const reader = new DatabaseSync(databasePath);
  t.after(() => {
    try { reader.exec("ROLLBACK"); } catch {}
    reader.close();
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertToken({ mint: geckoMint, source: "pumpportal", createdAt });
  store.upsertEnrichmentState({
    mint: geckoMint, provider: "geckoterminal", pool: null, tokenSide: null, dex: null, sourceUrl: null,
    status: "queued", missingReason: "Prospective launch admitted; provider evidence pending", errorCode: null,
    attemptCount: 0, lastAttemptAt: null, nextAttemptAt: createdAt, lastSuccessAt: null, updatedAt: createdAt,
    evidence: { source: "geckoterminal", retention: "derived-metrics-and-minimal-provenance-only" }
  });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM outcome_enrichment").all();
  assert.throws(() => store.deleteEnrichmentByProvider("geckoterminal"), /exclusive database access/);
  assert.equal(store.enrichmentState(geckoMint).provider, "geckoterminal");
});

test("outcome purge CLI rejects a missing database without creating it", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-provider-cli-"));
  const databasePath = path.join(directory, "typo.db");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.resolve("scripts/outcome-data-cli.js"),
    "--provider", "geckoterminal", "--confirm", "DELETE-geckoterminal", "--database", databasePath], {
    cwd: path.resolve("."), encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Database does not exist/);
  assert.equal(existsSync(databasePath), false);
});

test("token launch timestamps remain canonical across replay and restart scheduling", (t) => {
  const store = temporaryStore(t);
  const replayedAt = "2026-08-08T12:10:00.000Z";
  store.upsertToken({ mint: geckoMint, source: "pumpportal", createdAt });
  store.upsertEnrichmentState({
    mint: geckoMint, provider: "geckoterminal", pool: null, tokenSide: null, dex: null, sourceUrl: null,
    status: "queued", missingReason: "Prospective launch admitted; provider evidence pending", errorCode: null,
    attemptCount: 0, lastAttemptAt: null, nextAttemptAt: createdAt, lastSuccessAt: null, updatedAt: createdAt,
    evidence: {
      source: "geckoterminal", admissionPolicy: "prospective-fixed-admission-v1", launchObservedAt: createdAt,
      admittedAt: createdAt, retention: "derived-metrics-and-minimal-provenance-only"
    }
  });
  store.upsertToken({ mint: geckoMint, source: "pumpportal", createdAt: replayedAt, momentum: 99 });
  assert.equal(store.token(geckoMint).createdAt, createdAt);
  assert.equal(store.db.prepare("SELECT created_at FROM tokens WHERE mint=?").get(geckoMint).created_at, createdAt);
  assert.equal(store.dueEnrichmentTokens({ provider: "geckoterminal", now: replayedAt })[0].createdAt, createdAt);
});

test("migrates an existing v0.5.1 database in place while preserving rows and WAL mode", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-store-migration-"));
  const databasePath = path.join(directory, "war-room.db");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL);
    CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC);
    INSERT INTO tokens VALUES ('legacy-mint','{"mint":"legacy-mint","source":"pumpportal"}','${createdAt}','${createdAt}');
    PRAGMA user_version = 501;
  `);
  legacy.close();

  const store = new Store(databasePath);
  t.after(() => store.db.close());
  assert.equal(store.token("legacy-mint").mint, "legacy-mint");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='outcome_enrichment'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='risk_identity_enrichment'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='price_observations'").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='index' AND name='outcome_enrichment_provider_status_updated'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='index' AND name='outcome_enrichment_provider_due'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='index' AND name='risk_identity_provider_due'").get().count, 1);
});

test("persists deduplicated intelligence, restart-safe Telegram delivery, and frozen briefs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-action-store-"));
  const databasePath = path.join(directory, "war-room.db");
  let store = new Store(databasePath);
  t.after(() => {
    try { store.db.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertToken({ mint: geckoMint, symbol: "ACT", source: "pumpportal", createdAt });
  const event = {
    kind: "risk-evidence", mint: geckoMint, eventKey: `risk-evidence-v1:concentration:${geckoMint}:52:${createdAt}`,
    evidenceClass: "provider-observed", occurredAt: createdAt,
    payload: { mint: geckoMint, factor: "concentration", value: 52, unit: "%", source: "geckoterminal", limitation: "Uncalibrated provider observation." }
  };
  assert.equal(store.addIntelligenceEvent(event).written, true);
  assert.equal(store.addIntelligenceEvent(event).written, false);
  assert.equal(store.eventsForMint(geckoMint)[0].payload.value, 52);

  const alert = store.addAlert({
    level: "risk", title: "Factor changed", message: "Bounded evidence change", mint: geckoMint,
    kind: "risk-concentration", evidenceClass: "provider-observed", evidenceAt: createdAt,
    dedupeKey: `material-concentration-v1:${geckoMint}:52`, createdAt
  }, { queueTelegram: true });
  assert.equal(alert.telegramStatus, "pending");
  assert.equal(store.addAlert({ ...alert, dedupeKey: alert.dedupeKey }), null);
  assert.equal(store.dueTelegramAlerts({ now: createdAt })[0].id, alert.id);
  store.recordAlertTelegramAttempt(alert.id, "retrying", {
    attemptedAt: createdAt, nextAttemptAt: "2026-08-08T12:01:00.000Z", errorCode: "rate-limited"
  });
  store.db.close();
  store = new Store(databasePath);
  assert.equal(store.dueTelegramAlerts({ now: "2026-08-08T12:00:59.999Z" }).length, 0);
  assert.equal(store.dueTelegramAlerts({ now: "2026-08-08T12:01:00.000Z" })[0].telegramAttemptCount, 1);
  store.recordAlertTelegramAttempt(alert.id, "sent", { attemptedAt: "2026-08-08T12:01:00.000Z", messageId: 77 });
  assert.deepEqual(store.telegramDeliveryCoverage(), { total: 1, statusCounts: { sent: 1 } });

  const briefKey = "measured-closed-brief-v1:daily:2026-08-07T00:00:00.000Z:2026-08-08T00:00:00.000Z:UTC";
  const model = {
    briefId: briefKey, methodVersion: "measured-closed-brief-v1", period: "daily",
    windowStart: "2026-08-07T00:00:00.000Z", windowEnd: "2026-08-08T00:00:00.000Z",
    generatedAt: "2026-08-08T12:00:00.000Z", feedCoverage: "unmeasured", activity: { launchesObserved: 0 }
  };
  assert.equal(store.saveBriefRun({
    briefKey, kind: "daily", periodStart: model.windowStart, periodEnd: model.windowEnd,
    methodVersion: model.methodVersion, provider: "geckoterminal", dataCutoff: model.generatedAt, model
  }).written, true);
  const frozen = store.saveBriefRun({
    briefKey, kind: "daily", periodStart: model.windowStart, periodEnd: model.windowEnd,
    methodVersion: model.methodVersion, provider: "geckoterminal", dataCutoff: model.generatedAt,
    model: { ...model, feedCoverage: "not-revised" }
  });
  assert.equal(frozen.written, false);
  assert.equal(frozen.run.model.feedCoverage, "unmeasured");
  const correctedKey = briefKey.replace("measured-closed-brief-v1", "measured-closed-brief-v2");
  const correctedModel = {
    ...model,
    briefId: correctedKey,
    methodVersion: "measured-closed-brief-v2",
    activity: { launchesObserved: 0, materialAlerts: 0, materialByKind: {} }
  };
  assert.equal(store.saveBriefRun({
    briefKey: correctedKey, kind: "daily", periodStart: correctedModel.windowStart, periodEnd: correctedModel.windowEnd,
    methodVersion: correctedModel.methodVersion, provider: "geckoterminal",
    dataCutoff: correctedModel.generatedAt, model: correctedModel
  }).written, true);
  assert.equal(store.briefRun("daily").methodVersion, "measured-closed-brief-v2");
  assert.equal(store.briefRun("daily").model.activity.materialAlerts, 0);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  for (const index of ["alerts_dedupe_key", "events_event_key", "brief_runs_kind_period_end"]) {
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='index' AND name=?").get(index).count, 1);
  }
});
