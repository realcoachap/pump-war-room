import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeckoTerminalError } from "../src/geckoterminal.js";
import { nextOutcomeAttemptAt, VerifiedOutcomeIngestor } from "../src/outcome-ingest.js";
import { Store } from "../src/store.js";

const NOW = Date.parse("2026-08-08T12:30:00Z");
const mint = "11111111111111111111111111111111";
const pool = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const token = { mint, createdAt: "2026-08-08T12:00:00Z" };

function memoryStore() {
  const states = new Map();
  return {
    states,
    upsertEnrichmentState(state) { states.set(state.mint, structuredClone(state)); },
    enrichmentState(targetMint) { return states.get(targetMint) || null; },
    enrichmentStates() { return [...states.values()].map((state) => structuredClone(state)); }
  };
}

function seedFixedSelection(store, targetToken = token) {
  store.upsertEnrichmentState({
    mint: targetToken.mint,
    provider: "geckoterminal",
    pool,
    tokenSide: "base",
    dex: "pump-fun",
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`,
    status: "pool-selected",
    nextAttemptAt: null,
    lastSuccessAt: targetToken.createdAt,
    evidence: {
      source: "geckoterminal",
      sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`,
      poolCreatedAt: targetToken.createdAt,
      poolSelectedAt: targetToken.createdAt,
      providerPage: 1,
      providerRank: 1,
      selectionScope: "provider-contemporaneously-ranked-page-1"
    }
  });
}

function candle(candleStartAt, close = 2) {
  const observedAt = new Date(Date.parse(candleStartAt) + 60_000).toISOString();
  return { mint, provider: "geckoterminal", source: "geckoterminal", pool, tokenSide: "base", intervalSeconds: 60, minuteAt: candleStartAt, candleStartAt, observedAt, fetchedAt: new Date(NOW).toISOString(), open: close, high: close, low: close, close, volume: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}` };
}

test("persists provider-ranked derived outcome evidence without raw candles", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  let calls = 0;
  const client = {
    minIntervalMs: 6500,
    poolForToken: async () => ({ provider: "geckoterminal", pool, tokenSide: "base", dex: "pumpswap", poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z", providerPage: 1, providerRank: 1, reserveUsd: 10000, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}` }),
    ohlcv: async () => {
      calls++;
      const rows = [candle("2026-08-08T12:00:00.000Z", 1), candle("2026-08-08T12:04:00.000Z", 2)];
      return { observations: rows, received: rows.length, rejected: 0 };
    }
  };
  const statuses = [];
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => NOW, onStatus: (status) => statuses.push(status) });
  const state = await ingestor.refreshToken(token);
  assert.equal(calls, 1);
  assert.equal(state.status, "observing");
  assert.equal(state.evidence.baselineAt, "2026-08-08T12:01:00.000Z");
  assert.equal(state.evidence.providerRank, 1);
  assert.equal(state.evidence.outcome.windows["5m"].status, "observed");
  assert.equal(state.nextAttemptAt, "2026-08-08T13:01:30.000Z");
  assert.equal(JSON.stringify(state.evidence).includes("ohlcv_list"), false);
  assert.equal(statuses.at(-1), "observing");
  assert.equal(ingestor.getStatus().counters.successes, 1);
});

test("paginates at the documented 1000-candle boundary and de-duplicates overlap", async () => {
  const store = memoryStore();
  const olderToken = { mint, createdAt: "2026-08-07T12:00:00Z" };
  seedFixedSelection(store, olderToken);
  let page = 0;
  const first = Array.from({ length: 1000 }, (_, index) => candle(new Date(NOW - index * 60_000).toISOString(), 2));
  const second = [first.at(-1), candle("2026-08-07T12:00:00.000Z", 1)];
  const client = {
    poolForToken: async () => ({ provider: "geckoterminal", pool, tokenSide: "base", dex: "pumpswap", poolCreatedAt: olderToken.createdAt, poolSelectedAt: "2026-08-07T12:01:00.000Z", providerPage: 1, providerRank: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}` }),
    ohlcv: async () => {
      const rows = page++ === 0 ? first : second;
      return { observations: rows, received: page === 1 ? 1000 : rows.length, rejected: 0 };
    }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => NOW });
  await ingestor.refreshToken(olderToken);
  assert.equal(page, 2);
  assert.equal(store.states.get(mint).evidence.outcome.observationCounts.normalized, 972);
});

test("records missing-pool evidence and a bounded retry without inventing prices", async () => {
  const store = memoryStore();
  const clock = Date.parse("2026-08-08T12:01:00Z");
  const client = {
    poolForToken: async () => { throw new GeckoTerminalError("pool-unavailable", "not indexed"); },
    ohlcv: async () => { throw new Error("should not run"); }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "awaiting-pool");
  assert.equal(state.errorCode, "pool-unavailable");
  assert.equal(state.nextAttemptAt, "2026-08-08T12:02:00.000Z");
  assert.equal(store.states.get(mint).evidence.outcome, undefined);
  assert.equal(ingestor.getStatus().counters.noPool, 1);
});

test("marks a selected pool with no reserve value as unavailable liquidity evidence", async () => {
  const launchAt = "2026-08-08T12:29:30.000Z";
  const freshToken = { mint, createdAt: launchAt };
  const store = memoryStore();
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pumpswap",
      poolCreatedAt: launchAt, poolSelectedAt: "2026-08-08T12:30:00.000Z",
      providerPage: 1, providerRank: 1, reserveUsd: null,
      sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => { throw new Error("selection stage must not fetch candles"); }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => NOW });
  ingestor.enqueue(freshToken);
  const selected = await ingestor.refreshToken(freshToken);
  assert.equal(selected.status, "pool-selected");
  assert.deepEqual(selected.evidence.liquidity, {
    schemaVersion: 1,
    source: "geckoterminal",
    evidenceClass: "unavailable",
    attemptedAt: "2026-08-08T12:30:00.000Z",
    observedAt: null,
    liquidityUsd: null,
    missingReasonCode: "pool-reserve-missing",
    basis: "provider-observed-pool-reserve",
    limitation: "GeckoTerminal-observed pool reserve is not evidence of locked liquidity"
  });
  ingestor.close();
});

test("records a valid provider refresh as operational success even when completed candles are still missing", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  const clock = Date.parse("2026-08-08T12:03:00Z");
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
      poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z",
      providerPage: 1, providerRank: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => ({ observations: [], received: 0, rejected: 0, incomplete: 0 })
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "awaiting-price");
  assert.equal(state.evidence.baselineAt, null);
  assert.equal(state.lastSuccessAt, "2026-08-08T12:03:00.000Z");
  assert.equal(ingestor.getStatus().lastSuccessAt, "2026-08-08T12:03:00.000Z");
  assert.equal(ingestor.getStatus().counters.successes, 1);
});

test("terminalizes a permanently missing baseline after a bounded acquisition window", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  const clock = Date.parse("2026-08-08T12:06:00Z");
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
      poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z",
      providerPage: 1, providerRank: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => ({ observations: [], received: 0, rejected: 0, incomplete: 0 })
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "baseline-unavailable");
  assert.equal(state.nextAttemptAt, null);
  assert.match(state.missingReason, /bounded acquisition window/);
  assert.equal(state.evidence.outcome.baseline.reason, "baseline-missing");
});

test("terminalizes pool discovery after the prospective selection deadline without another provider call", async () => {
  const store = memoryStore();
  let calls = 0;
  const client = {
    poolForToken: async () => { calls++; throw new Error("must not run"); },
    ohlcv: async () => { calls++; throw new Error("must not run"); }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => Date.parse("2026-08-08T12:03:00Z") });
  const state = await ingestor.refreshToken(token);
  assert.equal(calls, 0);
  assert.equal(state.status, "invalid-response");
  assert.equal(state.errorCode, "selection-window-missed");
  assert.equal(state.nextAttemptAt, null);
});

test("honors provider retry-after evidence and suppresses raw error text", async () => {
  const store = memoryStore();
  const clock = Date.parse("2026-08-08T12:01:00Z");
  const client = {
    poolForToken: async () => { throw new GeckoTerminalError("rate-limited", "secret-like upstream body", { status: 429, retryAfterMs: 7000 }); },
    ohlcv: async () => { throw new Error("should not run"); }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "rate-limited");
  assert.equal(state.nextAttemptAt, "2026-08-08T12:01:07.000Z");
  assert.equal(JSON.stringify(state).includes("secret-like"), false);
  assert.equal(ingestor.getStatus().status, "rate-limited");
  assert.equal(ingestor.getStatus().counters.consecutiveFailures, 1);
});

test("a later provider failure preserves the last valid derived outcome", async () => {
  const store = memoryStore();
  const priorOutcome = { schemaVersion: 1, algorithm: "provider-observed-completed-candle-outcomes-v1", marker: "keep-derived-result" };
  store.upsertEnrichmentState({
    mint, provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`,
    status: "observing", nextAttemptAt: null, lastSuccessAt: "2026-08-08T12:20:00.000Z",
    evidence: { outcome: priorOutcome, poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z", providerPage: 1, providerRank: 1 }
  });
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    now: () => NOW,
    client: {
      ohlcv: async () => { throw new GeckoTerminalError("provider-unavailable", "temporary outage", { status: 503 }); },
      poolForToken: async () => { throw new Error("fixed pool must be reused"); }
    }
  });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "degraded");
  assert.deepEqual(state.evidence.outcome, priorOutcome);
  assert.equal(state.lastSuccessAt, "2026-08-08T12:20:00.000Z");
  assert.equal(ingestor.getStatus().status, "degraded");
});

test("a selected-pool schema failure preserves prior evidence and retries on the six-hour audit cadence", async () => {
  const store = memoryStore();
  const priorOutcome = { schemaVersion: 1, algorithm: "provider-observed-completed-candle-outcomes-v1", marker: "keep-derived-result" };
  store.upsertEnrichmentState({
    mint, provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`,
    status: "observing", nextAttemptAt: null, lastSuccessAt: "2026-08-08T12:20:00.000Z",
    evidence: { outcome: priorOutcome, poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z", providerPage: 1, providerRank: 1 }
  });
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    now: () => NOW,
    client: {
      ohlcv: async () => { throw new GeckoTerminalError("token-mismatch", "provider schema mismatch"); },
      poolForToken: async () => { throw new Error("fixed pool must be reused"); }
    }
  });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "invalid-response");
  assert.equal(state.nextAttemptAt, "2026-08-08T18:30:00.000Z");
  assert.deepEqual(state.evidence.outcome, priorOutcome);
  assert.equal(state.lastSuccessAt, "2026-08-08T12:20:00.000Z");
});

test("a selected-pool 404 preserves the fixed pool and retries on the six-hour audit cadence", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    now: () => NOW,
    client: {
      ohlcv: async () => { throw new GeckoTerminalError("not-found", "fixed pool unavailable", { status: 404 }); },
      poolForToken: async () => { throw new Error("fixed pool must be reused"); }
    }
  });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "degraded");
  assert.equal(state.errorCode, "not-found");
  assert.equal(state.pool, pool);
  assert.equal(state.nextAttemptAt, "2026-08-08T18:30:00.000Z");
  assert.equal(ingestor.getStatus().counters.noPool, 0);
  assert.equal(ingestor.getStatus().counters.failures, 1);
});

test("rejects a refresh whose replayed launch timestamp conflicts with prospective admission", async () => {
  const store = memoryStore();
  store.upsertEnrichmentState({
    mint, provider: "geckoterminal", pool: null, tokenSide: null, status: "queued",
    evidence: { launchObservedAt: token.createdAt }, nextAttemptAt: null
  });
  let calls = 0;
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    now: () => NOW,
    client: { poolForToken: async () => { calls++; }, ohlcv: async () => { calls++; } }
  });
  await assert.rejects(() => ingestor.refreshToken({ ...token, createdAt: "2026-08-08T12:10:00Z" }), /conflicts/);
  assert.equal(calls, 0);
  assert.equal(store.enrichmentState(mint).evidence.launchObservedAt, token.createdAt);
});

test("an empty later refresh retains first-observed derived windows and records the revision", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  let clock = NOW;
  let refresh = 0;
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
      poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z",
      providerPage: 1, providerRank: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => {
      refresh++;
      const rows = refresh === 1
        ? [candle("2026-08-08T12:00:00.000Z", 1), candle("2026-08-08T12:04:00.000Z", 2)]
        : [];
      return { observations: rows, received: rows.length, rejected: 0, incomplete: 0 };
    }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const first = await ingestor.refreshToken(token);
  store.states.get(mint).nextAttemptAt = null;
  clock += 60_000;
  const second = await ingestor.refreshToken(token);
  assert.equal(first.evidence.outcome.windows["5m"].returnPct, 100);
  assert.equal(second.evidence.outcome.windows["5m"].returnPct, 100);
  assert.deepEqual(second.evidence.outcome.revisionHistory.at(-1).missingWindows, ["5m"]);
  assert.doesNotMatch(JSON.stringify(second.evidence.outcome), /"(?:close|volume)":/);
});

test("freezes each horizon under its own disclosed provider revision instead of implying one mixed denominator", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  let clock = Date.parse("2026-08-08T12:05:30.000Z");
  let refresh = 0;
  const observed = (start, close) => ({ ...candle(start, close), fetchedAt: new Date(clock).toISOString() });
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
      poolCreatedAt: token.createdAt, poolSelectedAt: "2026-08-08T12:01:00.000Z",
      providerPage: 1, providerRank: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => {
      refresh++;
      const rows = refresh === 1
        ? [observed("2026-08-08T12:00:00.000Z", 1), observed("2026-08-08T12:04:00.000Z", 2)]
        : [observed("2026-08-08T12:00:00.000Z", 2), observed("2026-08-08T12:04:00.000Z", 2), observed("2026-08-08T12:14:00.000Z", 6)];
      return { observations: rows, received: rows.length, rejected: 0, incomplete: 0 };
    }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const first = await ingestor.refreshToken(token);
  store.states.get(mint).nextAttemptAt = null;
  clock = Date.parse("2026-08-08T12:15:30.000Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(first.evidence.outcome.windows["5m"].returnPct, 100);
  assert.equal(second.evidence.outcome.windows["5m"].returnPct, 100);
  assert.equal(second.evidence.outcome.windows["5m"].calculatedAt, "2026-08-08T12:05:30.000Z");
  assert.equal(second.evidence.outcome.windows["15m"].returnPct, 200);
  assert.equal(second.evidence.outcome.windows["15m"].calculatedAt, "2026-08-08T12:15:30.000Z");
  assert.equal(second.evidence.outcome.revisionPolicy, "first-observed-derived-value-per-window-provider-revision");
  assert.deepEqual(second.evidence.outcome.revisionHistory.at(-1), {
    checkedAt: "2026-08-08T12:15:30.000Z",
    action: "first-observed-per-window-provider-revisions-retained",
    windowRevisionPolicy: "first-observed-derived-value-per-window-provider-revision",
    changedWindows: ["5m"],
    missingWindows: [],
    newlyObservedWindows: ["15m"]
  });
  assert.doesNotMatch(JSON.stringify(second.evidence.outcome), /"(?:close|volume)":/);
});

test("defers persisted retry windows without contacting the provider", async () => {
  const store = memoryStore();
  store.upsertEnrichmentState({ mint, nextAttemptAt: "2026-08-08T12:31:00Z" });
  let calls = 0;
  const client = { poolForToken: async () => { calls++; }, ohlcv: async () => { calls++; } };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => NOW });
  const state = await ingestor.refreshToken(token);
  assert.deepEqual(state, { status: "deferred", nextAttemptAt: "2026-08-08T12:31:00Z" });
  assert.equal(calls, 0);
});

test("restart health reports fresh persisted provider attempts while runtime counters remain process-local", () => {
  const store = memoryStore();
  store.upsertEnrichmentState({
    mint, provider: "geckoterminal", pool, tokenSide: "base", status: "observing",
    attemptCount: 4, lastAttemptAt: "2026-08-08T12:20:00.000Z",
    lastSuccessAt: "2026-08-08T12:20:00.000Z", nextAttemptAt: "2026-08-08T13:01:30.000Z"
  });
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    client: { poolForToken() {}, ohlcv() {} },
    now: () => NOW
  });
  const status = ingestor.getStatus();
  assert.equal(status.lastAttemptAt, "2026-08-08T12:20:00.000Z");
  assert.equal(status.lastSuccessAt, "2026-08-08T12:20:00.000Z");
  assert.equal(status.lastSuccessAgeSeconds, 600);
  assert.equal(status.lastSuccessIsStale, false);
  assert.deepEqual(status.persistence, {
    stateCount: 1,
    attemptCount: 4,
    successfulStateCount: 1,
    dueStateCount: 0,
    lastAttemptAt: "2026-08-08T12:20:00.000Z",
    lastSuccessAt: "2026-08-08T12:20:00.000Z"
  });
  assert.equal(status.counters.attempts, 0);
  assert.equal(status.counters.successes, 0);
});

test("schedules the next outcome maturity and validates queue inputs", () => {
  assert.equal(nextOutcomeAttemptAt("2026-08-08T12:00:00Z", NOW), "2026-08-08T13:01:30.000Z");
  const store = memoryStore();
  const ingestor = new VerifiedOutcomeIngestor({ store, client: { poolForToken() {}, ohlcv() {} }, now: () => NOW, maxAdmissionAgeMs: 60 * 60_000 });
  assert.equal(ingestor.enqueue({ mint: "bad", createdAt: token.createdAt }), false);
  assert.equal(ingestor.enqueue(token), true);
  assert.equal(ingestor.enqueue(token), false);
  ingestor.close();
});

test("persists a zero-attempt prospective admission through the real Store before provider work", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-outcome-admission-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    client: { poolForToken() {}, ohlcv() {} },
    now: () => NOW,
    maxAdmissionAgeMs: 60 * 60_000,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {}
  });
  assert.equal(ingestor.enqueue(token), true);
  const admitted = store.enrichmentState(mint);
  assert.equal(admitted.status, "queued");
  assert.equal(admitted.attemptCount, 0);
  assert.equal(admitted.lastAttemptAt, null);
  assert.equal(admitted.nextAttemptAt, "2026-08-08T12:30:00.000Z");
  assert.equal(admitted.evidence.admissionPolicy, "prospective-fixed-admission-v1");
  ingestor.close();
});

test("real Store persists selection-first scheduling and a complete allowlisted derived refresh", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-outcome-success-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let clock = NOW;
  const launchAt = new Date(NOW).toISOString();
  const freshToken = { mint, createdAt: launchAt };
  store.upsertToken({ ...freshToken, source: "pumpportal" });
  let ohlcvCalls = 0;
  const client = {
    poolForToken: async () => ({
      provider: "geckoterminal", pool, tokenSide: "base", dex: "pump-fun",
      poolCreatedAt: launchAt, poolSelectedAt: launchAt, providerPage: 1, providerRank: 1,
      sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    }),
    ohlcv: async () => {
      ohlcvCalls++;
      const row = (start, close) => {
        const end = new Date(Date.parse(start) + 60_000).toISOString();
        return { mint, provider: "geckoterminal", source: "geckoterminal", pool, tokenSide: "base", intervalSeconds: 60, minuteAt: start, candleStartAt: start, candleEndAt: end, observedAt: end, fetchedAt: new Date(clock).toISOString(), open: close, high: close, low: close, close, volume: 1, sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}` };
      };
      const observations = [row("2026-08-08T12:30:00.000Z", 1), row("2026-08-08T12:34:00.000Z", 2)];
      return { observations, received: observations.length, rejected: 0, incomplete: 0 };
    }
  };
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    client,
    now: () => clock,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {}
  });
  assert.equal(ingestor.enqueue(freshToken), true);
  const selected = await ingestor.refreshToken(freshToken);
  assert.equal(selected.status, "pool-selected");
  assert.equal(selected.nextAttemptAt, "2026-08-08T12:36:30.000Z");
  assert.equal(selected.evidence.selectionScope, "provider-contemporaneously-ranked-page-1");
  assert.equal(selected.evidence.liquidity.evidenceClass, "unavailable");
  assert.equal(selected.evidence.liquidity.missingReasonCode, "pool-reserve-missing");
  assert.equal(ohlcvCalls, 0, "selection stage consumed candle capacity");
  clock = Date.parse("2026-08-08T12:36:30.000Z");
  const measured = await ingestor.refreshToken(freshToken);
  assert.equal(ohlcvCalls, 1);
  assert.equal(measured.status, "observing");
  assert.equal(measured.evidence.outcome.windows["5m"].returnPct, 100);
  assert.equal(store.enrichmentState(mint).evidence.outcome.revisionPolicy, "first-observed-derived-value-per-window-provider-revision");
  assert.doesNotMatch(JSON.stringify(store.enrichmentState(mint).evidence), /"(?:open|high|low|close|volume)":/);
  ingestor.close();
});

test("bounds prospective cohort and queue admissions with explicit drop telemetry", () => {
  const store = memoryStore();
  store.upsertEnrichmentState({ mint, provider: "geckoterminal" });
  const ingestor = new VerifiedOutcomeIngestor({
    store,
    client: { poolForToken() {}, ohlcv() {} },
    now: () => NOW,
    cohortLimit: 1,
    maxQueue: 1
  });
  assert.equal(ingestor.enqueue({ mint: pool, createdAt: new Date(NOW).toISOString() }), false);
  assert.equal(ingestor.enqueue({ mint: pool, createdAt: "2026-08-08T12:00:00.000Z" }), false);
  assert.equal(ingestor.getStatus().counters.droppedCohort, 1);
  assert.equal(ingestor.getStatus().counters.droppedLate, 1);
  ingestor.close();

  const queueStore = memoryStore();
  const queueBounded = new VerifiedOutcomeIngestor({
    store: queueStore,
    client: { poolForToken() {}, ohlcv() {} },
    now: () => NOW,
    cohortLimit: 2,
    maxQueue: 1,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {}
  });
  assert.equal(queueBounded.enqueue({ mint, createdAt: new Date(NOW).toISOString() }), true);
  assert.equal(queueBounded.enqueue({ mint: pool, createdAt: new Date(NOW).toISOString() }), false);
  assert.equal(queueBounded.getStatus().counters.droppedQueue, 1);
  assert.equal(queueStore.states.get(pool).status, "queued");
  assert.equal(queueStore.states.get(pool).missingReason, "Prospective launch admitted; provider evidence pending");
  assert.equal(queueStore.states.get(pool).evidence.admissionPolicy, "prospective-fixed-admission-v1");
  assert.equal(queueBounded.getStatus().cohort.admitted, 2);
  queueBounded.close();
});

test("uses the post-fetch completion time so paced live candles are available as of calculation", async () => {
  const store = memoryStore();
  seedFixedSelection(store);
  let clock = NOW;
  const fetchedAt = new Date(NOW + 6_500).toISOString();
  const client = {
    poolForToken: async () => { throw new Error("fixed pool must be reused"); },
    ohlcv: async () => {
      clock += 6_500;
      const rows = [
        { ...candle("2026-08-08T12:00:00.000Z", 1), fetchedAt },
        { ...candle("2026-08-08T12:04:00.000Z", 2), fetchedAt }
      ];
      return { observations: rows, received: rows.length, rejected: 0, incomplete: 0 };
    }
  };
  const ingestor = new VerifiedOutcomeIngestor({ store, client, now: () => clock });
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "observing");
  assert.equal(state.evidence.outcome.asOf, fetchedAt);
  assert.equal(state.evidence.outcome.observationCounts.availableAsOf, 2);
  assert.equal(state.evidence.outcome.windows["5m"].status, "observed");
  assert.equal(state.updatedAt, fetchedAt);
});
