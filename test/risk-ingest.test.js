import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeckoTerminalError } from "../src/geckoterminal.js";
import { nextRiskIdentityAttemptAt, RiskIdentityIngestor } from "../src/risk-ingest.js";
import {
  parseGeckoTerminalTokenInfo,
  RISK_IDENTITY_METHOD_VERSION,
  RISK_IDENTITY_PARSER_REVISION
} from "../src/risk-identity.js";
import { attachRiskIdentityEvidence } from "../src/risk-public.js";
import { Store } from "../src/store.js";

const mint = "11111111111111111111111111111111";
const secondMint = "22222222222222222222222222222222";
const creator = "So11111111111111111111111111111111111111112";
const pool = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const token = { mint, source: "pumpportal", name: "Bounded Coin", symbol: "BOUND", createdAt: "2026-08-09T12:00:00.000Z" };
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

function payload(extra = {}, requestedMint = mint) {
  return {
    data: {
      id: `solana_${requestedMint}`,
      type: "token",
      attributes: {
        address: requestedMint,
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

function cohortToken(index) {
  const suffix = `${base58Alphabet[Math.floor(index / base58Alphabet.length)]}${base58Alphabet[index % base58Alphabet.length]}`;
  return { ...token, mint: `${"1".repeat(30)}${suffix}`, name: `Audit ${index}`, symbol: `A${index}` };
}

function legacyEvidenceFor(row) {
  const parsed = parseGeckoTerminalTokenInfo(payload({}, row.mint), {
    mint: row.mint,
    network: "solana",
    fetchedAt: "2026-08-09T13:14:00.000Z"
  });
  const { parserRevision: _parserRevision, ...evidence } = parsed;
  return evidence;
}

function seedExhaustedLegacyState(store, row) {
  store.upsertToken(row);
  const evidence = legacyEvidenceFor(row);
  store.upsertRiskIdentityState({
    mint: row.mint,
    provider: "geckoterminal",
    evidence,
    status: "available",
    missingReason: null,
    errorCode: null,
    attemptCount: 2,
    lastAttemptAt: "2026-08-09T13:15:00.000Z",
    nextAttemptAt: null,
    lastSuccessAt: "2026-08-09T13:15:00.001Z",
    updatedAt: "2026-08-09T13:15:00.001Z"
  });
  return evidence;
}

function scheduledTimers() {
  const callbacks = [];
  return {
    callbacks,
    setTimeoutFn(callback) {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimeoutFn() {}
  };
}

async function drainScheduledTimers(callbacks) {
  let remaining = 1_000;
  while (callbacks.length) {
    if (--remaining < 0) throw new Error("scheduled risk-ingest test work did not settle");
    callbacks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  assert.equal(first.evidence.parserAttemptRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(first.evidence.parserAttemptAt, "2026-08-09T12:15:00.000Z");
  assert.equal(first.evidence.parserAttemptStatus, "failed");

  clock = Date.parse("2026-08-09T13:15:00Z");
  const second = await ingestor.refreshToken(token);
  assert.equal(second.status, "unavailable");
  assert.equal(second.attemptCount, 2);
  assert.equal(second.nextAttemptAt, null);
  assert.equal(second.evidence.parserAttemptAt, "2026-08-09T13:15:00.000Z");
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

test("startup parser auditing leaves a pending original retry on its one-hour schedule", async (t) => {
  const store = temporaryStore(t);
  store.upsertRiskIdentityState({
    mint,
    provider: "geckoterminal",
    evidence: legacyEvidenceFor(token),
    status: "available",
    missingReason: "Provider token-info evidence was missing or stale; one bounded retry scheduled",
    errorCode: null,
    attemptCount: 1,
    lastAttemptAt: "2026-08-09T13:00:00.000Z",
    nextAttemptAt: "2026-08-09T14:00:00.000Z",
    lastSuccessAt: "2026-08-09T13:00:00.001Z",
    updatedAt: "2026-08-09T13:00:00.001Z"
  });
  let clock = Date.parse("2026-08-09T13:30:00.000Z");
  let calls = 0;
  const timers = scheduledTimers();
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async (requestedMint) => { calls++; return payload({}, requestedMint); } },
    now: () => clock,
    cohortLimit: 1,
    ...timers
  });
  ingestor.start([token]);
  assert.equal(ingestor.getStatus().parserRevisionAudit.selectedStateCount, 0);
  assert.equal(calls, 0);
  assert.equal(store.riskIdentityState(mint).attemptCount, 1);

  clock = Date.parse("2026-08-09T14:00:00.000Z");
  assert.equal(ingestor.enqueue(token), true);
  await drainScheduledTimers(timers.callbacks);
  const retried = store.riskIdentityState(mint);
  assert.equal(calls, 1);
  assert.equal(retried.attemptCount, 2);
  assert.equal(retried.evidence.parserRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(ingestor.getStatus().counters.revisionAuditAttempts, 0);
});

test("an ordinary current-parser retry stamps audit provenance when it retains stronger legacy factors", async (t) => {
  const store = temporaryStore(t);
  const legacyEvidence = legacyEvidenceFor(token);
  store.upsertRiskIdentityState({
    mint,
    provider: "geckoterminal",
    evidence: legacyEvidence,
    status: "available",
    missingReason: "Provider token-info evidence was missing or stale; one bounded retry scheduled",
    errorCode: null,
    attemptCount: 1,
    lastAttemptAt: "2026-08-09T13:00:00.000Z",
    nextAttemptAt: "2026-08-09T14:00:00.000Z",
    lastSuccessAt: "2026-08-09T13:00:00.001Z",
    updatedAt: "2026-08-09T13:00:00.001Z"
  });
  let clock = Date.parse("2026-08-09T13:30:00.000Z");
  const timers = scheduledTimers();
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async (requestedMint) => payload({
      name: null,
      symbol: null,
      holders: null,
      developer_address: null,
      developer_holding_percentage: null,
      twitter_handle: null,
      telegram_handle: null,
      websites: []
    }, requestedMint) },
    now: () => clock,
    cohortLimit: 1,
    ...timers
  });
  ingestor.start([token]);
  assert.equal(ingestor.getStatus().parserRevisionAudit.selectedStateCount, 0);

  clock = Date.parse("2026-08-09T14:00:00.000Z");
  assert.equal(ingestor.enqueue(token), true);
  await drainScheduledTimers(timers.callbacks);
  const retained = store.riskIdentityState(mint);
  assert.equal(retained.evidence.parserRevision, undefined);
  assert.equal(retained.evidence.parserAuditRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(retained.evidence.parserAuditAt, "2026-08-09T14:00:00.000Z");
  assert.equal(retained.evidence.factors.holderCount.value, legacyEvidence.factors.holderCount.value);
  assert.equal(ingestor.getStatus().parserRevisionAudit.currentAcquisitionCount, 1);
});

test("startup audits a deterministic bounded sample of 16 exhausted legacy cohort states without expanding the cohort", async (t) => {
  const store = temporaryStore(t);
  const cohort = Array.from({ length: 20 }, (_, index) => cohortToken(index));
  for (const row of cohort) seedExhaustedLegacyState(store, row);
  const extra = cohortToken(20);
  store.upsertToken(extra);
  const calls = [];
  const timers = scheduledTimers();
  const clock = Date.parse("2026-08-09T14:00:00.000Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async (requestedMint) => {
      calls.push(requestedMint);
      return payload({}, requestedMint);
    } },
    now: () => clock,
    cohortLimit: 20,
    betweenTokensMs: 0,
    ...timers
  });

  ingestor.start([...cohort].reverse().concat(extra));
  const queued = ingestor.getStatus();
  assert.deepEqual({
    status: queued.parserRevisionAudit.status,
    target: queued.parserRevisionAudit.targetStateCount,
    eligible: queued.parserRevisionAudit.eligibleStateCountAtStart,
    selected: queued.parserRevisionAudit.selectedStateCount,
    queueDepth: queued.parserRevisionAudit.queueDepth
  }, { status: "queued", target: 16, eligible: 16, selected: 16, queueDepth: 16 });
  assert.equal(queued.parserRevisionAudit.sampleStateCount, 16);
  assert.equal(queued.parserRevisionAudit.currentDispositionCountAtStart, 0);
  assert.equal(queued.parserRevisionAudit.currentDispositionCount, 0);
  assert.equal(queued.parserRevisionAudit.currentAcquisitionCount, 0);
  assert.equal(store.riskIdentityStates({ provider: "geckoterminal", limit: 200 }).length, 20);
  assert.equal(store.riskIdentityState(extra.mint), null);

  await drainScheduledTimers(timers.callbacks);
  const expected = [...cohort]
    .sort((left, right) => left.mint < right.mint ? -1 : left.mint > right.mint ? 1 : 0)
    .slice(0, 16)
    .map(({ mint: value }) => value);
  assert.deepEqual(calls, expected);
  for (const requestedMint of expected) {
    const state = store.riskIdentityState(requestedMint);
    assert.equal(state.attemptCount, 2);
    assert.equal(state.nextAttemptAt, null);
    assert.equal(state.evidence.parserRevision, RISK_IDENTITY_PARSER_REVISION);
  }
  const untouched = cohort.filter(({ mint: value }) => !expected.includes(value));
  assert.equal(untouched.every(({ mint: value }) => store.riskIdentityState(value).evidence.parserRevision === undefined), true);
  const completed = ingestor.getStatus();
  assert.equal(completed.parserRevisionAudit.status, "complete");
  assert.equal(completed.parserRevisionAudit.attempts, 16);
  assert.equal(completed.parserRevisionAudit.successes, 16);
  assert.equal(completed.parserRevisionAudit.failures, 0);
  assert.equal(completed.counters.attempts, 16);
  assert.equal(completed.counters.successes, 16);
  assert.equal(completed.persistence.currentParserAcquisitionCount, 16);
  assert.equal(completed.parserRevisionAudit.sampleStateCount, 16);
  assert.equal(completed.parserRevisionAudit.currentDispositionCount, 16);
  assert.equal(completed.parserRevisionAudit.currentAcquisitionCount, 16);
  assert.equal(completed.runtimeLastSuccessAt, "2026-08-09T14:00:00.000Z");
  assert.equal(completed.persistedLastSuccessAt, "2026-08-09T14:00:00.000Z");
  ingestor.close();

  let restartCalls = 0;
  const restartTimers = scheduledTimers();
  const restarted = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => { restartCalls++; return payload(); } },
    now: () => clock + 60_000,
    cohortLimit: 20,
    betweenTokensMs: 0,
    ...restartTimers
  });
  restarted.start([...cohort].reverse());
  await drainScheduledTimers(restartTimers.callbacks);
  const restartStatus = restarted.getStatus();
  assert.equal(restartCalls, 0);
  assert.equal(restartStatus.parserRevisionAudit.sampleStateCount, 16);
  assert.equal(restartStatus.parserRevisionAudit.currentDispositionCountAtStart, 16);
  assert.equal(restartStatus.parserRevisionAudit.eligibleStateCountAtStart, 0);
  assert.equal(restartStatus.parserRevisionAudit.selectedStateCount, 0);
  assert.equal(restartStatus.parserRevisionAudit.currentDispositionCount, 16);
  assert.equal(restartStatus.parserRevisionAudit.currentAcquisitionCount, 16);
  assert.equal(restartStatus.parserRevisionAudit.status, "complete");
  assert.equal(restartStatus.runtimeLastSuccessAt, null);
  assert.equal(restartStatus.persistedLastSuccessAt, "2026-08-09T14:00:00.000Z");
  assert.equal(cohort.slice(16).some(({ mint: value }) => calls.includes(value)), false);
});

test("a weaker successful current-parser audit retains stronger factors and is not repeated after restart", async (t) => {
  const store = temporaryStore(t);
  const legacyEvidence = seedExhaustedLegacyState(store, token);
  const emptyAttributes = {
    name: null,
    symbol: null,
    holders: null,
    developer_address: null,
    developer_holding_percentage: null,
    twitter_handle: null,
    telegram_handle: null,
    websites: []
  };
  const firstTimers = scheduledTimers();
  const clock = Date.parse("2026-08-09T14:00:00.000Z");
  const first = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async (requestedMint) => payload(emptyAttributes, requestedMint) },
    now: () => clock,
    cohortLimit: 1,
    ...firstTimers
  });
  first.start([token]);
  await drainScheduledTimers(firstTimers.callbacks);

  const retained = store.riskIdentityState(mint);
  assert.equal(retained.attemptCount, 2);
  assert.equal(retained.evidence.factors.holderCount.value, legacyEvidence.factors.holderCount.value);
  assert.equal(retained.evidence.fingerprints.xHandle.fingerprint, legacyEvidence.fingerprints.xHandle.fingerprint);
  assert.equal(retained.evidence.parserRevision, undefined);
  assert.equal(retained.evidence.parserAuditRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(retained.evidence.parserAuditAt, "2026-08-09T14:00:00.000Z");
  assert.match(retained.missingReason, /prior factors were retained/i);
  assert.equal(first.getStatus().counters.successes, 1);
  first.close();

  let restartCalls = 0;
  const restartTimers = scheduledTimers();
  const restarted = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => { restartCalls++; return payload(); } },
    now: () => clock + 60_000,
    cohortLimit: 1,
    ...restartTimers
  });
  restarted.start([token]);
  await drainScheduledTimers(restartTimers.callbacks);
  const restartStatus = restarted.getStatus();
  assert.equal(restartCalls, 0);
  assert.equal(restartStatus.parserRevisionAudit.eligibleStateCountAtStart, 0);
  assert.equal(restartStatus.parserRevisionAudit.selectedStateCount, 0);
  assert.equal(restartStatus.parserRevisionAudit.attempts, 0);
  assert.equal(restartStatus.persistence.currentParserAcquisitionCount, 1);
});

test("a failed current-parser audit persists a terminal disposition and is not selected again", async (t) => {
  const store = temporaryStore(t);
  const legacyEvidence = seedExhaustedLegacyState(store, token);
  const timers = scheduledTimers();
  const clock = Date.parse("2026-08-09T14:00:00.000Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => {
      throw new GeckoTerminalError("provider-unavailable", "provider unavailable", { status: 503 });
    } },
    now: () => clock,
    cohortLimit: 1,
    ...timers
  });
  ingestor.start([token]);
  await drainScheduledTimers(timers.callbacks);

  const failed = store.riskIdentityState(mint);
  assert.equal(failed.evidence.fetchedAt, legacyEvidence.fetchedAt);
  assert.equal(failed.evidence.factors.holderCount.value, legacyEvidence.factors.holderCount.value);
  assert.equal(failed.evidence.parserAttemptRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(failed.evidence.parserAttemptAt, "2026-08-09T14:00:00.000Z");
  assert.equal(failed.evidence.parserAttemptStatus, "failed");
  assert.equal(failed.status, "degraded");
  assert.equal(failed.errorCode, "provider-unavailable");
  assert.match(failed.missingReason, /current parser audit failed/i);
  assert.equal(failed.attemptCount, 2);
  assert.equal(failed.nextAttemptAt, null);
  assert.equal(failed.lastSuccessAt, "2026-08-09T13:15:00.001Z");
  const status = ingestor.getStatus();
  assert.equal(status.parserRevisionAudit.status, "failed");
  assert.equal(status.parserRevisionAudit.attempts, 1);
  assert.equal(status.parserRevisionAudit.successes, 0);
  assert.equal(status.parserRevisionAudit.failures, 1);
  assert.equal(status.counters.attempts, 1);
  assert.equal(status.counters.successes, 0);
  assert.equal(status.counters.failures, 1);
  assert.equal(status.persistence.currentParserAcquisitionCount, 0);
  assert.equal(status.parserRevisionAudit.sampleStateCount, 1);
  assert.equal(status.parserRevisionAudit.currentDispositionCount, 1);
  assert.equal(status.parserRevisionAudit.currentAcquisitionCount, 0);

  const restartTimers = scheduledTimers();
  const restarted = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async (requestedMint) => payload({}, requestedMint) },
    now: () => clock + 60_000,
    cohortLimit: 1,
    ...restartTimers
  });
  restarted.start([token]);
  assert.equal(restarted.getStatus().parserRevisionAudit.eligibleStateCountAtStart, 0);
  assert.equal(restarted.getStatus().parserRevisionAudit.selectedStateCount, 0);
  assert.equal(restarted.getStatus().parserRevisionAudit.currentDispositionCount, 1);
  assert.equal(restarted.getStatus().parserRevisionAudit.status, "failed");
  restarted.close();
});

test("a parser-invalid audit retains prior factors but records the latest state as invalid-response", async (t) => {
  const store = temporaryStore(t);
  const legacyEvidence = seedExhaustedLegacyState(store, token);
  const timers = scheduledTimers();
  const clock = Date.parse("2026-08-09T14:00:00.000Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => {
      throw new GeckoTerminalError("token-mismatch", "token mismatch");
    } },
    now: () => clock,
    cohortLimit: 1,
    ...timers
  });
  ingestor.start([token]);
  await drainScheduledTimers(timers.callbacks);

  const failed = store.riskIdentityState(mint);
  assert.equal(failed.status, "invalid-response");
  assert.equal(failed.errorCode, "token-mismatch");
  assert.equal(failed.evidence.factors.holderCount.value, legacyEvidence.factors.holderCount.value);
  assert.equal(failed.evidence.parserAttemptRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(failed.evidence.parserAttemptStatus, "failed");
  assert.equal(ingestor.getStatus().parserRevisionAudit.currentDispositionCount, 1);
});

test("a rate-limited parser audit retains prior factors with a durable rate-limited disposition", async (t) => {
  const store = temporaryStore(t);
  const legacyEvidence = seedExhaustedLegacyState(store, token);
  const timers = scheduledTimers();
  const clock = Date.parse("2026-08-09T14:00:00.000Z");
  const ingestor = new RiskIdentityIngestor({
    store,
    client: { tokenInfo: async () => {
      throw new GeckoTerminalError("rate-limited", "rate limited", { status: 429, retryAfterMs: 60_000 });
    } },
    now: () => clock,
    cohortLimit: 1,
    ...timers
  });
  ingestor.start([token]);
  await drainScheduledTimers(timers.callbacks);

  const failed = store.riskIdentityState(mint);
  assert.equal(failed.status, "rate-limited");
  assert.equal(failed.errorCode, "rate-limited");
  assert.equal(failed.evidence.factors.holderCount.value, legacyEvidence.factors.holderCount.value);
  assert.equal(failed.evidence.parserAttemptRevision, RISK_IDENTITY_PARSER_REVISION);
  assert.equal(failed.evidence.parserAttemptStatus, "failed");
  assert.equal(ingestor.getStatus().counters.rateLimited, 1);
});
