import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateOutcomeCohorts,
  calculateVerifiedOutcome,
  DEFAULT_MAX_BASELINE_LAG_MS,
  DEFAULT_MAX_STALENESS_MS,
  normalizePriceCandles,
  OUTCOME_HORIZONS,
  summarizeVerifiedOutcomes,
  toDurableOutcomeRecord,
  unavailableProviderOutcome,
  validateProviderObservedOutcome
} from "../src/outcomes.js";

const ORIGIN = Date.parse("2026-08-08T00:00:00.000Z");
const at = (seconds) => new Date(ORIGIN + seconds * 1_000).toISOString();
const launchAt = at(30);
const geckoPool = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

function candle(seconds, close, overrides = {}) {
  const intervalSeconds = overrides.intervalSeconds ?? 60;
  return {
    candleStartAt: at(seconds - intervalSeconds),
    candleEndAt: at(seconds),
    observedAt: at(seconds),
    fetchedAt: at(seconds + 5),
    close,
    volume: 1,
    source: "verified-candles",
    pool: "pool-1",
    intervalSeconds,
    ...overrides
  };
}

function outcomeAtFiveMinutes(returnPct, candleOverrides = {}) {
  return calculateVerifiedOutcome({
    launchAt,
    asOf: at(330),
    candles: [candle(120, 100, candleOverrides), candle(300, 100 * (1 + returnPct / 100), candleOverrides)]
  });
}

test("calculates auditable horizon returns from the last timely completed close at each target", () => {
  const candles = [
    candle(86_400, 50),
    candle(21_600, 100),
    candle(3_600, 125),
    candle(1_800, 80),
    candle(900, 90),
    candle(300, 110),
    candle(120, 100)
  ];
  const original = structuredClone(candles);

  const outcome = calculateVerifiedOutcome({ launchAt, asOf: at(86_430), candles });

  assert.equal(DEFAULT_MAX_STALENESS_MS, 90_000);
  assert.equal(DEFAULT_MAX_BASELINE_LAG_MS, 120_000);
  assert.deepEqual(OUTCOME_HORIZONS, ["5m", "15m", "1h", "6h", "24h"]);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.revisionPolicy, "first-observed-derived-value-per-window-provider-revision");
  assert.equal(outcome.basis, "first-wholly-post-launch-completed-candle-baseline-and-last-completed-close-at-or-before-target");
  assert.deepEqual(outcome.baseline, {
    status: "observed",
    expectedAt: launchAt,
    candleStartAt: at(60),
    candleEndAt: at(120),
    observedAt: at(120),
    fetchedAt: at(125),
    lagSeconds: 90,
    close: 100,
    volume: 1,
    source: "verified-candles",
    pool: "pool-1",
    intervalSeconds: 60,
    reason: null,
    role: "first-observed-baseline-reference-only; each window retains its own provider revision"
  });
  assert.deepEqual(Object.fromEntries(OUTCOME_HORIZONS.map((key) => [key, outcome.windows[key].returnPct])), {
    "5m": 10,
    "15m": -10,
    "1h": 25,
    "6h": 0,
    "24h": -50
  });
  assert.deepEqual(Object.fromEntries(OUTCOME_HORIZONS.map((key) => [key, outcome.windows[key].stalenessSeconds])), {
    "5m": 30,
    "15m": 30,
    "1h": 30,
    "6h": 30,
    "24h": 30
  });
  assert.equal(outcome.windows["5m"].expectedAt, at(330));
  assert.equal(outcome.windows["5m"].candleStartAt, at(240));
  assert.equal(outcome.windows["5m"].candleEndAt, at(300));
  assert.equal(outcome.windows["5m"].observedAt, at(300));
  assert.equal(outcome.windows["5m"].source, "verified-candles");
  assert.equal(outcome.windows["5m"].pool, "pool-1");
  assert.equal(outcome.windows["5m"].intervalSeconds, 60);
  assert.equal(outcome.windows["5m"].calculatedAt, at(86_430));
  assert.equal(outcome.windows["15m"].maximumDrawdownPct, 18.18181818);
  assert.equal(outcome.windows["1h"].maximumDrawdownPct, 27.27272727);
  assert.equal(outcome.windows["24h"].maximumDrawdownPct, 60);
  assert.deepEqual(outcome.windows["24h"].evidence.drawdown, {
    basis: "observed-completed-candle-closes-only",
    sampleCount: 7,
    maximumPct: 60,
    peak: candle(3_600, 125),
    trough: candle(86_400, 50)
  });
  assert.deepEqual(candles, original, "calculation mutated caller-owned candles");
});

test("durable outcomes omit provider price and volume values while retaining derived audit evidence", () => {
  const outcome = outcomeAtFiveMinutes(12.5, { source: "geckoterminal", pool: geckoPool });
  outcome.poolSelection = {
    policy: "prospective-earliest-created-eligible-pool-on-provider-ranked-page-1-within-2m",
    selectedAt: at(40),
    providerPage: 1,
    providerRank: 1,
    poolCreatedAt: at(25),
    source: "geckoterminal",
    pool: geckoPool
  };
  const durable = toDurableOutcomeRecord(outcome);
  assert.doesNotMatch(JSON.stringify(durable), /"(?:close|volume)":/);
  assert.equal(durable.baseline.nonempty, true);
  assert.equal(durable.windows["5m"].evidence.target.nonempty, true);
  assert.equal(durable.windows["5m"].returnPct, 12.5);
  assert.equal(validateProviderObservedOutcome(durable, { requireProspectiveSelection: true }).windows["5m"].status, "observed");
  assert.equal(summarizeVerifiedOutcomes([durable], { minimumEvidence: 1 }).windows["5m"].medianReturnPct, 12.5);
  const encodedRawRevision = structuredClone(durable);
  encodedRawRevision.revisionHistory = [{
    checkedAt: "[[1723118400,1,2,0.5,1.5,999]]",
    action: "first-observed-per-window-provider-revisions-retained",
    windowRevisionPolicy: "first-observed-derived-value-per-window-provider-revision",
    changedWindows: [], missingWindows: [], newlyObservedWindows: []
  }];
  assert.throws(() => validateProviderObservedOutcome(encodedRawRevision, { requireProspectiveSelection: true }), /revisionHistory/);

  const rawRoot = structuredClone(durable);
  rawRoot.rawCsv = "1723118400,1,2,0.5,1.5,999";
  assert.throws(() => validateProviderObservedOutcome(rawRoot, { requireProspectiveSelection: true }), /unsupported field/);
  const rawWindow = structuredClone(durable);
  rawWindow.windows["5m"].rawJson = "[[1723118400,1,2,0.5,1.5,999]]";
  assert.throws(() => validateProviderObservedOutcome(rawWindow, { requireProspectiveSelection: true }), /unsupported field/);
  for (const mutate of [
    (copy) => { copy.baseline.expectedAt = "1723118400,1,2,0.5,1.5,999"; },
    (copy) => { copy.windows["5m"].evidence.target.fetchedAt = "[[1723118400,1,2,0.5,1.5,999]]"; },
    (copy) => { copy.observationCounts.supplied = "1723118400,1,2,0.5,1.5,999"; },
    (copy) => { copy.windows["5m"].evidence.drawdown.peak.fetchedAt = "1723118400,1,2,0.5,1.5,999"; }
  ]) {
    const encodedScalar = structuredClone(durable);
    mutate(encodedScalar);
    assert.throws(() => validateProviderObservedOutcome(encodedScalar, { requireProspectiveSelection: true }), /RFC 3339|date, time|non-negative integer|inconsistent completed-candle/);
  }
  const encodedMissingState = structuredClone(durable);
  encodedMissingState.missingData = {
    reason: "provider-unavailable", providerStatus: "1723118400,1,2,0.5,1.5,999",
    providerErrorCode: null, lastAttemptAt: null, nextAttemptAt: null, updatedAt: null
  };
  assert.throws(() => validateProviderObservedOutcome(encodedMissingState, { requireProspectiveSelection: true }), /missingData/);
  for (const mutate of [
    (copy) => { copy.observationCounts.supplied = 0; copy.observationCounts.normalized = 999; },
    (copy) => { copy.observationCounts.normalized = 1; copy.observationCounts.availableAsOf = 999; },
    (copy) => { copy.observationCounts.retainedObservedWindows = 999; },
    (copy) => {
      copy.observationCounts.availableAsOf = 0; copy.observationCounts.afterAsOf = copy.observationCounts.normalized;
      copy.observationCounts.beforeLaunch = 1;
    },
    (copy) => {
      copy.missingData = { reason: "provider-rate-limited", providerStatus: "queued", providerErrorCode: null,
        lastAttemptAt: null, nextAttemptAt: null, updatedAt: null };
    },
    (copy) => { copy.baseline.observedAt = at(20); },
    (copy) => {
      copy.windows["5m"].expectedAt = at(240);
      copy.windows["5m"].evidence.target.expectedAt = at(240);
    },
    (copy) => { copy.maxBaselineLagMs = 999_999_999; },
    (copy) => { copy.maxStalenessMs = 999_999_999; },
    (copy) => {
      const baseline = copy.windows["5m"].evidence.baseline;
      baseline.candleStartAt = at(0); baseline.candleEndAt = at(60); baseline.observedAt = at(60);
      baseline.fetchedAt = at(65); baseline.lagSeconds = 30;
    },
    (copy) => {
      const peak = copy.windows["5m"].evidence.drawdown.peak;
      peak.candleStartAt = at(0); peak.candleEndAt = at(60); peak.observedAt = at(60); peak.fetchedAt = at(65);
    },
    (copy) => { copy.windows["5m"].stalenessSeconds = 0; },
    (copy) => { copy.windows["5m"].fetchedAt = at(301); },
    (copy) => { copy.windows["5m"].candleStartAt = at(180); },
    (copy) => { copy.baseline.fetchedAt = at(400); },
    (copy) => { copy.windows["5m"].evidence.drawdown.peak.fetchedAt = at(400); }
  ]) {
    const forgedEvidence = structuredClone(durable);
    mutate(forgedEvidence);
    assert.throws(() => validateProviderObservedOutcome(forgedEvidence, { requireProspectiveSelection: true }), /inconsistent|disagrees|missingData|bounded wholly post-launch|must equal launchAt plus its horizon|completed-candle|production 90s target|invalid metrics/);
  }
  const sourceCsv = structuredClone(durable);
  const rewriteSource = (value) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "source") && value.source === "geckoterminal") value.source = "1723118400,1,2,0.5,1.5,999";
    for (const child of Object.values(value)) rewriteSource(child);
  };
  rewriteSource(sourceCsv);
  assert.throws(() => validateProviderObservedOutcome(sourceCsv, { requireProspectiveSelection: true }), /geckoterminal/i);
  const publicOutcome = validateProviderObservedOutcome(outcome, { requireProspectiveSelection: true });
  assert.doesNotMatch(JSON.stringify(publicOutcome), /"(?:close|volume)":/);

  const pending = unavailableProviderOutcome({ launchAt, asOf: at(330), state: { status: "queued" } });
  assert.equal(validateProviderObservedOutcome(pending, { requireProspectiveSelection: true }).missingData.reason, "provider-admission-pending");
  for (const mutate of [
    (copy) => { copy.baseline.reason = "provider-unavailable"; },
    (copy) => { copy.baseline.observedAt = at(60); },
    (copy) => { copy.baseline.lagSeconds = 60; },
    (copy) => { copy.baseline.source = "geckoterminal"; },
    (copy) => { copy.windows["5m"].reason = "window-not-mature"; },
    (copy) => { copy.windows["15m"].reason = "provider-admission-pending"; }
  ]) {
    const forgedPending = structuredClone(pending);
    mutate(forgedPending);
    assert.throws(() => validateProviderObservedOutcome(forgedPending, { requireProspectiveSelection: true }), /missingData|consistent missing evidence|must not retain candle provenance/);
  }

  const stale = calculateVerifiedOutcome({
    launchAt, asOf: at(1_200),
    candles: [candle(120, 100, { source: "geckoterminal", pool: geckoPool }),
      candle(331, 110, { source: "geckoterminal", pool: geckoPool })]
  });
  stale.poolSelection = { ...outcome.poolSelection };
  const durableStale = toDurableOutcomeRecord(stale);
  assert.equal(validateProviderObservedOutcome(durableStale, { requireProspectiveSelection: true }).windows["15m"].reason, "target-observation-stale");
  const staleBaseline = calculateVerifiedOutcome({
    launchAt,
    asOf: at(1_200),
    candles: [candle(151, 100, { source: "geckoterminal", pool: geckoPool })]
  });
  staleBaseline.poolSelection = { ...outcome.poolSelection };
  const durableStaleBaseline = toDurableOutcomeRecord(staleBaseline);
  assert.equal(validateProviderObservedOutcome(durableStaleBaseline, { requireProspectiveSelection: true }).baseline.reason, "baseline-observation-stale");
  for (const mutate of [
    (copy) => { copy.baseline.candleStartAt = at(1); },
    (copy) => { copy.baseline.candleEndAt = at(150); },
    (copy) => { copy.baseline.fetchedAt = at(151); },
    (copy) => { copy.baseline.candidate.lagSeconds = 120; },
    (copy) => { copy.baseline.candidate.fetchedAt = at(1_201); },
    (copy) => { copy.baseline.nonempty = false; },
    (copy) => { copy.windows["5m"].reason = "target-observation-missing"; }
  ]) {
    const forgedStaleBaseline = structuredClone(durableStaleBaseline);
    mutate(forgedStaleBaseline);
    assert.throws(() => validateProviderObservedOutcome(forgedStaleBaseline, { requireProspectiveSelection: true }), /unavailable baseline candidate|consistent missing evidence/);
  }
  for (const mutate of [
    (copy) => {
      copy.windows["15m"].stalenessSeconds = 1;
      copy.windows["15m"].evidence.target.stalenessSeconds = 1;
    },
    (copy) => { copy.windows["15m"].reason = "target-observation-missing"; },
    (copy) => {
      copy.windows["15m"].fetchedAt = at(1_201);
      copy.windows["15m"].evidence.target.fetchedAt = at(1_201);
    }
  ]) {
    const forgedStale = structuredClone(durableStale);
    mutate(forgedStale);
    assert.throws(() => validateProviderObservedOutcome(forgedStale, { requireProspectiveSelection: true }), /consistent missing evidence/);
  }
});

test("never uses a candle after the target and distinguishes stale, missing, and immature targets", () => {
  const input = {
    launchAt,
    asOf: at(1_200),
    candles: [
      candle(120, 100),
      candle(239, 110),
      candle(331, 999)
    ]
  };

  const outcome = calculateVerifiedOutcome(input);

  assert.equal(outcome.status, "awaiting-observations");
  assert.deepEqual({
    status: outcome.windows["5m"].status,
    expectedAt: outcome.windows["5m"].expectedAt,
    observedAt: outcome.windows["5m"].observedAt,
    stalenessSeconds: outcome.windows["5m"].stalenessSeconds,
    source: outcome.windows["5m"].source,
    pool: outcome.windows["5m"].pool,
    intervalSeconds: outcome.windows["5m"].intervalSeconds,
    returnPct: outcome.windows["5m"].returnPct,
    reason: outcome.windows["5m"].reason
  }, {
    status: "unavailable",
    expectedAt: at(330),
    observedAt: at(239),
    stalenessSeconds: 91,
    source: "verified-candles",
    pool: "pool-1",
    intervalSeconds: 60,
    returnPct: null,
    reason: "target-observation-stale"
  });
  assert.equal(outcome.windows["15m"].reason, "target-observation-stale");
  assert.equal(outcome.windows["15m"].observedAt, at(331));
  assert.equal(outcome.windows["1h"].reason, "window-not-mature");

  const withExplicitStaleness = calculateVerifiedOutcome({ ...input, maxStalenessMs: 91_000 });
  assert.equal(withExplicitStaleness.windows["5m"].status, "observed");
  assert.equal(withExplicitStaleness.windows["5m"].returnPct, 10);
  assert.equal(withExplicitStaleness.windows["5m"].stalenessSeconds, 91);

  const atDefaultStalenessBoundary = calculateVerifiedOutcome({
    launchAt,
    asOf: at(330),
    candles: [candle(120, 100), candle(240, 110), candle(331, 999)]
  });
  assert.equal(atDefaultStalenessBoundary.windows["5m"].status, "observed");
  assert.equal(atDefaultStalenessBoundary.windows["5m"].stalenessSeconds, 90);

  const notFetchedAsOf = calculateVerifiedOutcome({
    launchAt,
    asOf: at(330),
    candles: [candle(120, 100), candle(300, 110, { fetchedAt: at(400) })]
  });
  assert.equal(notFetchedAsOf.windows["5m"].status, "unavailable");
  assert.equal(notFetchedAsOf.windows["5m"].reason, "target-observation-missing");
  const fetchedLater = calculateVerifiedOutcome({
    launchAt,
    asOf: at(400),
    candles: [candle(120, 100), candle(300, 110, { fetchedAt: at(400) })]
  });
  assert.equal(fetchedLater.windows["5m"].status, "observed");

  const missing = calculateVerifiedOutcome({ launchAt, asOf: at(500), candles: [candle(120, 100)] });
  assert.equal(missing.windows["5m"].reason, "target-observation-missing");
  assert.equal(missing.windows["5m"].observedAt, null);
});

test("selects the first wholly post-launch baseline candle and fails closed when it is missing or stale", () => {
  const stale = calculateVerifiedOutcome({
    launchAt,
    asOf: at(500),
    candles: [candle(60, 95), candle(151, 100)]
  });
  assert.equal(stale.status, "awaiting-baseline");
  assert.equal(stale.baseline.reason, "baseline-observation-stale");
  assert.equal(stale.baseline.expectedAt, launchAt);
  assert.equal(stale.baseline.observedAt, at(151));
  assert.equal(stale.baseline.lagSeconds, 121);
  assert.equal(stale.baseline.candidate.close, 100);
  assert.ok(OUTCOME_HORIZONS.every((key) => stale.windows[key].reason === "baseline-observation-stale"));

  const atBaselineBoundary = calculateVerifiedOutcome({ launchAt, asOf: at(200), candles: [candle(60, 95), candle(150, 100)] });
  assert.equal(atBaselineBoundary.baseline.status, "observed");
  assert.equal(atBaselineBoundary.baseline.lagSeconds, 120);

  const missing = calculateVerifiedOutcome({ launchAt, asOf: at(60), candles: [candle(60, 95)] });
  assert.equal(missing.status, "awaiting-baseline");
  assert.equal(missing.baseline.reason, "baseline-missing");
  assert.equal(missing.baseline.observedAt, null);
  assert.ok(OUTCOME_HORIZONS.every((key) => missing.windows[key].reason === "baseline-missing"));
});

test("normalizes deterministically and rejects invalid, conflicting, or mixed-series candles", () => {
  const normalized = normalizePriceCandles([
    candle(120, 101),
    candle(60, 100, { fetchedAt: at(80) }),
    candle(60, 100, { observedAt: "2026-08-07T20:01:00-04:00", source: " verified-candles ", pool: " pool-1 " }),
    candle(60, 100)
  ]);
  assert.deepEqual(normalized, [candle(60, 100), candle(120, 101)]);

  assert.throws(() => normalizePriceCandles([candle(60, "100")]), /finite positive number/);
  assert.throws(() => normalizePriceCandles([candle(60, 0)]), /finite positive number/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { volume: 0 })]), /nonempty candle/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { observedAt: "2026-08-08 00:01:00" })]), /UTC offset/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { intervalSeconds: 60.5 })]), /positive integer/);
  assert.throws(() => normalizePriceCandles([candle(300, 100, { intervalSeconds: 300 })]), /must be 60/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { candleStartAt: at(1) })]), /plus intervalSeconds/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { candleEndAt: at(59) })]), /must equal observedAt/);
  assert.throws(() => normalizePriceCandles([candle(60, 100, { fetchedAt: at(59) })]), /completed close/);
  assert.throws(() => normalizePriceCandles([candle(60, 100), candle(60, 101)]), /conflicting observations/);
  assert.throws(() => normalizePriceCandles([candle(60, 100), candle(120, 101, { pool: "pool-2" })]), /exactly one source/);
  assert.throws(() => calculateVerifiedOutcome({ launchAt, asOf: at(60), candles: [], maxStalenessMs: 1.5 }), /maxStalenessMs/);
  assert.throws(() => calculateVerifiedOutcome({ launchAt, asOf: at(60), candles: [], maxBaselineLagMs: 120_001 }), /must not exceed/);
  assert.throws(() => calculateVerifiedOutcome({ launchAt, asOf: at(20), candles: [] }), /before launchAt/);

  const outOfRange = calculateVerifiedOutcome({
    launchAt,
    asOf: at(330),
    candles: [candle(120, Number.MIN_VALUE), candle(300, Number.MAX_VALUE)]
  });
  assert.equal(outOfRange.windows["5m"].status, "unavailable");
  assert.equal(outOfRange.windows["5m"].reason, "return-calculation-out-of-range");
});

test("summaries calculate per-horizon hit rate, median return, and maximum drawdown only with enough evidence", () => {
  const outcomes = [outcomeAtFiveMinutes(10), outcomeAtFiveMinutes(0), outcomeAtFiveMinutes(-20)];
  const summary = summarizeVerifiedOutcomes(outcomes, { minimumEvidence: 3 });

  assert.equal(summary.outcomeCount, 3);
  assert.equal(summary.policy.revisionPolicy, "first-observed-derived-value-per-window-provider-revision");
  assert.deepEqual(summary.windows["5m"], {
    status: "sufficient-evidence",
    minimumEvidence: 3,
    minimumCoverageRatio: 0.5,
    evidenceCount: 3,
    missingCount: 0,
    coverageRatio: 1,
    missingReasons: {},
    hitDefinition: "returnPct > 0",
    hitCount: 1,
    hitRatePct: 33.33333333,
    medianReturnPct: 0,
    maximumDrawdownPct: 20,
    maximumDrawdownSampleCount: 2,
    drawdownBasis: "maximum observed completed-candle-close drawdown; sparse samples may understate intraperiod drawdown"
  });
  assert.equal(summary.windows["15m"].status, "insufficient-evidence");
  assert.equal(summary.windows["15m"].evidenceCount, 0);
  assert.equal(summary.windows["15m"].missingReasons["window-not-mature"], 3);
  assert.equal(summary.windows["15m"].hitCount, null);
  assert.equal(summary.windows["15m"].hitRatePct, null);
  assert.equal(summary.windows["15m"].medianReturnPct, null);
  assert.equal(summary.windows["15m"].maximumDrawdownPct, null);
  assert.equal(summary.windows["15m"].maximumDrawdownSampleCount, null);

  const suppressed = summarizeVerifiedOutcomes(outcomes.slice(0, 2), { minimumEvidence: 3 }).windows["5m"];
  assert.equal(suppressed.status, "insufficient-evidence");
  assert.equal(suppressed.evidenceCount, 2);
  assert.equal(suppressed.hitCount, null);
  assert.equal(suppressed.hitRatePct, null);
  assert.equal(suppressed.medianReturnPct, null);
  assert.equal(suppressed.maximumDrawdownPct, null);
  assert.equal(suppressed.maximumDrawdownSampleCount, null);

  const missingFiveMinute = calculateVerifiedOutcome({ launchAt, asOf: at(500), candles: [candle(120, 100)] });
  const lowCoverage = summarizeVerifiedOutcomes([
    ...outcomes,
    ...Array.from({ length: 7 }, () => missingFiveMinute)
  ], { minimumEvidence: 3 });
  assert.equal(lowCoverage.windows["5m"].evidenceCount, 3);
  assert.equal(lowCoverage.windows["5m"].coverageRatio, 0.3);
  assert.equal(lowCoverage.windows["5m"].status, "insufficient-evidence");
  assert.equal(lowCoverage.windows["5m"].hitRatePct, null);
});

test("cohort aggregates are sorted deterministically and enforce evidence thresholds independently", () => {
  const cohorts = aggregateOutcomeCohorts([
    { cohort: "Solo", outcome: outcomeAtFiveMinutes(50) },
    { cohort: " Momentum ", outcome: outcomeAtFiveMinutes(-20) },
    { cohort: "Momentum", outcome: outcomeAtFiveMinutes(10) }
  ], { minimumEvidence: 2 });

  assert.equal(cohorts.outcomeCount, 3);
  assert.equal(cohorts.cohortCount, 2);
  assert.deepEqual(cohorts.cohorts.map(({ cohort }) => cohort), ["Momentum", "Solo"]);
  const momentum = cohorts.cohorts[0];
  assert.equal(momentum.outcomeCount, 2);
  assert.equal(momentum.windows["5m"].status, "sufficient-evidence");
  assert.equal(momentum.windows["5m"].hitRatePct, 50);
  assert.equal(momentum.windows["5m"].medianReturnPct, -5);
  assert.equal(momentum.windows["5m"].maximumDrawdownPct, 20);
  const solo = cohorts.cohorts[1];
  assert.equal(solo.windows["5m"].status, "insufficient-evidence");
  assert.equal(solo.windows["5m"].evidenceCount, 1);
  assert.equal(solo.windows["5m"].hitRatePct, null);

  assert.throws(() => summarizeVerifiedOutcomes([], { minimumEvidence: 0 }), /minimumEvidence/);
  assert.throws(() => summarizeVerifiedOutcomes([], { minimumCoverageRatio: 1.1 }), /minimumCoverageRatio/);
  assert.throws(() => summarizeVerifiedOutcomes([
    outcomeAtFiveMinutes(1),
    calculateVerifiedOutcome({
      launchAt,
      asOf: at(330),
      maxStalenessMs: 60_000,
      candles: [candle(120, 100), candle(300, 101)]
    })
  ]), /one calculation/);
  assert.throws(() => aggregateOutcomeCohorts([{ cohort: "", outcome: outcomeAtFiveMinutes(1) }]), /non-empty string/);
});
