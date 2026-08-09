import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeckoTerminalError } from "../src/geckoterminal.js";
import { nextRiskIdentityAttemptAt, RiskIdentityIngestor } from "../src/risk-ingest.js";
import { RISK_IDENTITY_METHOD_VERSION } from "../src/risk-identity.js";
import { attachRiskIdentityEvidence } from "../src/risk-public.js";
import { Store } from "../src/store.js";

const mint = "11111111111111111111111111111111";
const secondMint = "22222222222222222222222222222222";
const creator = "So11111111111111111111111111111111111111112";
const pool = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const token = { mint, source: "pumpportal", name: "Bounded Coin", symbol: "BOUND", createdAt: "2026-08-09T12:00:00.000Z" };

function temporaryStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-risk-ingest-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertToken(token);
  return store;
}

function payload(extra = {}) {
  return {
    data: {
      id: `solana_${mint}`,
      type: "token",
      attributes: {
        address: mint,
        name: "Bounded Coin",
        symbol: "BOUND",
        holders: { count: 55, distribution_percentage: { top_10: "22.5" }, last_updated: "2026-08-09T12:14:00Z" },
        developer_address: creator,
        developer_holding_percentage: 2.5,
        twitter_handle: "@bounded_coin",
        telegram_handle: null,
        websites: ["https://bounded.example/raw/path"],
        description: "RAW_DESCRIPTION_MUST_NOT_PERSIST",
        ...extra
      }
    }
  };
}

test("admits at 15 minutes and persists one strict successful token-info record", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:10:00Z");
  const ingestor = new RiskIdentityIngestor({ store, client: { tokenInfo: async () => payload() }, now: () => clock });

  assert.equal(ingestor.enqueue(token), false);
  const admitted = store.riskIdentityState(mint);
  assert.equal(admitted.status, "queued");
  assert.equal(admitted.attemptCount, 0);
  assert.equal(admitted.nextAttemptAt, "2026-08-09T12:15:00.000Z");

  clock = Date.parse("2026-08-09T12:15:00Z");
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "available");
  assert.equal(state.attemptCount, 1);
  assert.equal(state.nextAttemptAt, null);
  assert.equal(state.evidence.methodVersion, RISK_IDENTITY_METHOD_VERSION);
  assert.equal(state.evidence.factors.holderCount.value, 55);
  assert.match(state.evidence.fingerprints.xHandle.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(state.evidence), /RAW_DESCRIPTION|bounded_coin|bounded\.example|raw\/path/i);
  assert.equal(ingestor.getStatus().persistence.successfulStateCount, 1);
  assert.equal(ingestor.getStatus().lastSuccessIsStale, null);
  assert.equal(ingestor.getStatus().ongoingFreshnessRequired, false);
});

test("keeps failed evidence unknown, retries once near one hour, then stops", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  const client = { tokenInfo: async () => { throw new GeckoTerminalError("not-found", "not indexed", { status: 404 }); } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);

  const first = await ingestor.refreshToken(token);
  assert.equal(first.status, "unavailable");
  assert.equal(first.attemptCount, 1);
  assert.equal(first.nextAttemptAt, "2026-08-09T13:15:00.000Z");
  assert.equal(first.evidence.evidenceClass, "unavailable");

  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(second.status, "unavailable");
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, null);
  assert.equal(ingestor.enqueue(token), false);
});

test("a short provider Retry-After cannot burn the one-hour bounded retry early", async (t) => {
  const store = temporaryStore(t);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  const client = { tokenInfo: async () => {
    throw new GeckoTerminalError("rate-limited", "slow down", { status: 429, retryAfterMs: 3_000 });
  } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "rate-limited");
  assert.equal(state.nextAttemptAt, "2026-08-09T13:15:00.000Z");
});

test("maps parser-only error codes into the bounded durable invalid-response contract", async (t) => {
  const store = temporaryStore(t);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => payload({ holders: { last_updated: "not-a-time" } }) },
    now: () => clock
  });
  ingestor.enqueue(token);
  const state = await ingestor.refreshToken(token);
  assert.equal(state.status, "invalid-response");
  assert.equal(state.errorCode, "invalid-response");
  assert.match(state.missingReason, /invalid/);
});

test("valid all-missing provider responses remain unavailable and receive one bounded retry", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  const emptyPayload = () => payload({
    name: null,
    symbol: null,
    holders: null,
    developer_address: null,
    developer_holding_percentage: null,
    twitter_handle: null,
    telegram_handle: null,
    websites: []
  });
  const ingestor = new RiskIdentityIngestor({ store, client: { tokenInfo: async () => emptyPayload() }, now: () => clock });
  ingestor.enqueue(token);
  const first = await ingestor.refreshToken(token);
  assert.equal(first.status, "unavailable");
  assert.equal(first.lastSuccessAt, "2026-08-09T12:15:00.001Z");
  assert.equal(first.nextAttemptAt, "2026-08-09T13:15:00.000Z");
  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(second.status, "unavailable");
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, null);
});

test("a failed bounded retry retains and publishes the first partial provider observation", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  let calls = 0;
  const client = { tokenInfo: async () => {
    calls++;
    if (calls === 1) return payload({
      holders: { count: 55, distribution_percentage: null, last_updated: null },
      developer_holding_percentage: null
    });
    throw new GeckoTerminalError("provider-unavailable", "temporary provider outage", { status: 503 });
  } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);
  const first = await ingestor.refreshToken(token);
  const retainedFetchedAt = first.evidence.fetchedAt;
  assert.equal(first.status, "available");
  assert.equal(first.nextAttemptAt, "2026-08-09T13:15:00.000Z");

  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(second.status, "degraded");
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, null);
  assert.equal(second.evidence.fetchedAt, retainedFetchedAt);
  assert.equal(second.evidence.factors.holderCount.value, 55);
  const [enriched] = attachRiskIdentityEvidence([token], { riskStates: [second] }).tokens;
  assert.equal(enriched.riskIdentity.factors.concentration.holderCount, 55);
  assert.equal(enriched.riskIdentity.providerObservation.sourceStatus, "degraded");
});

test("a successful but empty bounded retry retains the stronger first provider observation", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  let calls = 0;
  const client = { tokenInfo: async () => {
    calls++;
    return calls === 1 ? payload({
      holders: { count: 55, distribution_percentage: null, last_updated: null },
      developer_holding_percentage: null
    }) : payload({
      name: null, symbol: null, holders: null, developer_address: null,
      developer_holding_percentage: null, twitter_handle: null, telegram_handle: null, websites: []
    });
  } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);
  const first = await ingestor.refreshToken(token);
  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(second.status, "available");
  assert.equal(second.nextAttemptAt, null);
  assert.equal(second.evidence.fetchedAt, first.evidence.fetchedAt);
  assert.equal(second.evidence.factors.holderCount.value, 55);
  assert.match(second.missingReason, /prior factors were retained/i);
});

test("an equal-count disjoint retry cannot erase an earlier observed factor", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  let calls = 0;
  const client = { tokenInfo: async () => {
    calls++;
    return calls === 1 ? payload({
      name: null, symbol: null,
      holders: { count: 55, distribution_percentage: null, last_updated: null },
      developer_address: null, developer_holding_percentage: null,
      twitter_handle: null, telegram_handle: null, websites: []
    }) : payload({
      name: null, symbol: null, holders: null, developer_address: null,
      developer_holding_percentage: 2.5, twitter_handle: null, telegram_handle: null, websites: []
    });
  } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);
  const first = await ingestor.refreshToken(token);
  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(first.evidence.factors.holderCount.value, 55);
  assert.equal(second.evidence.fetchedAt, first.evidence.fetchedAt);
  assert.equal(second.evidence.factors.holderCount.value, 55);
  assert.equal(second.evidence.factors.developerHoldingPercentage.value, null);
  assert.match(second.missingReason, /prior factors were retained/i);
});

test("a retry with fewer website-domain digests retains the broader first observation", async (t) => {
  const store = temporaryStore(t);
  let clock = Date.parse("2026-08-09T12:15:00Z");
  let calls = 0;
  const emptyAttributes = {
    name: null, symbol: null, holders: null, developer_address: null,
    developer_holding_percentage: null, twitter_handle: null, telegram_handle: null
  };
  const client = { tokenInfo: async () => {
    calls++;
    return calls === 1
      ? payload({ ...emptyAttributes, websites: ["https://alpha.com", "https://beta.org"] })
      : payload({ ...emptyAttributes, websites: ["https://alpha.com"] });
  } };
  const ingestor = new RiskIdentityIngestor({ store, client, now: () => clock });
  ingestor.enqueue(token);
  const first = await ingestor.refreshToken(token);
  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(first.evidence.fingerprints.websiteDomains.values.length, 2);
  assert.equal(second.evidence.fetchedAt, first.evidence.fetchedAt);
  assert.equal(second.evidence.fingerprints.websiteDomains.values.length, 2);
  assert.match(second.missingReason, /prior factors were retained/i);
});

test("routes unexpected drain failures through the structured status callback", async (t) => {
  const store = temporaryStore(t);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  let scheduled;
  const statuses = [];
  const originalUpsert = store.upsertRiskIdentityState.bind(store);
  store.upsertRiskIdentityState = (state) => {
    if (state.attemptCount > 0) throw new Error("database write failed");
    return originalUpsert(state);
  };
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => payload() },
    now: () => clock,
    setTimeoutFn: (callback) => { scheduled = callback; return { unref() {} }; },
    clearTimeoutFn: () => {},
    onStatus: (status, telemetry) => statuses.push({ status, telemetry })
  });
  assert.equal(ingestor.enqueue(token), true);
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ingestor.getStatus().status, "degraded");
  assert.equal(statuses.at(-1).status, "degraded");
  assert.equal(statuses.at(-1).telemetry.errorCode, "enrichment-failed");
  assert.equal(statuses.at(-1).telemetry.error.message, "database write failed");
});

test("validates the deterministic admission schedule", () => {
  assert.equal(nextRiskIdentityAttemptAt(token.createdAt, Date.parse("2026-08-09T12:01:00Z")), "2026-08-09T12:15:00.000Z");
  assert.equal(nextRiskIdentityAttemptAt(token.createdAt, Date.parse("2026-08-09T12:20:00Z")), "2026-08-09T12:20:00.000Z");
  assert.throws(() => nextRiskIdentityAttemptAt("invalid"), /valid timestamps/);
});

test("persists a timestamped current pool-reserve observation without calling it launch-time liquidity", async (t) => {
  const store = temporaryStore(t);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: {
      tokenInfo: async () => payload(),
      currentPoolForToken: async () => ({
        pool, reserveUsd: 12_500, poolCreatedAt: "2026-08-09T12:01:00Z",
        poolSelectedAt: "2026-08-09T12:15:05Z", providerPage: 1, providerRank: 2
      })
    },
    now: () => clock
  });
  ingestor.enqueue(token);
  const state = await ingestor.refreshToken(token);
  assert.equal(state.evidence.liquidity.evidenceClass, "provider-observed");
  assert.equal(state.evidence.liquidity.liquidityUsd, 12_500);
  assert.equal(state.evidence.liquidity.observedAt, "2026-08-09T12:15:05.000Z");
  assert.equal(state.evidence.liquidity.basis, "current-provider-ranked-page-1-pool-snapshot");
  assert.match(state.evidence.liquidity.limitation, /not launch-time liquidity/i);
  const [enriched] = attachRiskIdentityEvidence([token], { riskStates: [state] }).tokens;
  assert.equal(enriched.riskIdentity.factors.liquidity.liquidityUsd, 12_500);
  assert.equal(enriched.riskIdentity.factors.liquidity.observedAt, "2026-08-09T12:15:05.000Z");
});

test("labels a missing current provider pool as unavailable rather than an invalid response", async (t) => {
  const store = temporaryStore(t);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: {
      tokenInfo: async () => payload(),
      currentPoolForToken: async () => { throw new GeckoTerminalError("pool-unavailable", "no related pool"); }
    },
    now: () => clock
  });
  ingestor.enqueue(token);
  const state = await ingestor.refreshToken(token);
  assert.equal(state.evidence.liquidity.evidenceClass, "unavailable");
  assert.equal(state.evidence.liquidity.missingReasonCode, "pool-unavailable");
  assert.equal(state.nextAttemptAt, "2026-08-09T13:15:00.000Z");
  const [enriched] = attachRiskIdentityEvidence([token], { riskStates: [state] }).tokens;
  assert.equal(enriched.riskIdentity.factors.liquidity.missingReasonCode, "pool-unavailable");
});

test("uses an independent fixed risk cohort and rejects excess admissions explicitly", (t) => {
  const store = temporaryStore(t);
  const secondToken = { ...token, mint: secondMint, name: "Second" };
  store.upsertToken(secondToken);
  const clock = Date.parse("2026-08-09T12:15:00Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => payload() },
    now: () => clock,
    cohortLimit: 1
  });
  assert.equal(ingestor.enqueue(token), true);
  assert.equal(ingestor.enqueue(secondToken), false);
  assert.equal(store.riskIdentityState(mint).status, "queued");
  assert.equal(store.riskIdentityState(secondMint), null);
  assert.equal(ingestor.getStatus().persistence.admittedCount, 1);
  assert.equal(ingestor.getStatus().counters.droppedCohort, 1);
});
