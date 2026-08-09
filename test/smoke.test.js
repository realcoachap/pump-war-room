import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmokeChecks, SmokeCheckError } from "../scripts/smoke.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "../src/solana-rpc.js";

const version = "0.9.2";

const outcomeWindows = () => Object.fromEntries(["5m", "15m", "1h", "6h", "24h"].map((window) => [window, {
  status: "insufficient-evidence", minimumEvidence: 3, evidenceCount: 0, missingCount: 0,
  missingReasons: {}, hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
}]));

function measuredBrief(period) {
  const duration = period === "weekly" ? 7 * 86_400_000 : 86_400_000;
  const end = "2026-08-08T00:00:00.000Z";
  const start = new Date(Date.parse(end) - duration).toISOString();
  const priorStart = new Date(Date.parse(start) - duration).toISOString();
  const windows = Object.fromEntries(["5m", "15m", "1h", "6h", "24h"].map((window) => [window, {
    status: "insufficient-evidence", eligibleCount: 0, evidenceCount: 0, missingCount: 0,
    coverageRatio: null, hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
  }]));
  const activity = {
    launchesObserved: 0, migrationObservations: 0, materialAlerts: 0, materialByKind: {},
    factorEventsByEvidenceClass: {}, telegramDelivery: {}, deduplicatedSuppressed: null,
    thirdPartyCallouts: 0, cohortAdmissions: { outcome: 0, risk: 0 },
    cohortDrops: { outcome: null, risk: null, reason: "unavailable" }
  };
  return {
    schemaVersion: 1, methodVersion: "measured-closed-brief-v2",
    briefId: `measured-closed-brief-v2:${period}:${start}:${end}:UTC`, period,
    generatedAt: "2026-08-08T12:00:00.000Z", windowStart: start, windowEnd: end, timezone: "UTC",
    feedCoverage: "unmeasured", source: "pumpportal observations plus GeckoTerminal completed-candle outcomes",
    universe: "closed-period deployment-local activity", activity,
    outcomes: { minimumEvidence: 3, minimumCoverageRatio: 0.5, windows },
    priorPeriod: {
      windowStart: priorStart, windowEnd: start, activity,
      outcomes: { minimumEvidence: 3, minimumCoverageRatio: 0.5, windows },
      comparisonRule: "both denominators visible"
    },
    rawProviderPayloadsIncluded: false, disclaimer: "Observational research only"
  };
}

function actionHealth() {
  return {
    schemaVersion: 1, watchlistPersistence: "browser-local", alertDedupe: "persistent",
    materialPersistence: "atomic-with-durable-baseline",
    telegram: {
      status: "not-configured", tokenConfigured: false, chatConfigured: false,
      delivery: "restart-safe-bounded-at-least-once-material-alerts-only", paidBroadcastsRequired: false,
      outbox: { total: 0, statusCounts: {} }
    }
  };
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function cohortMint(index) {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    suffix = base58Alphabet[value % base58Alphabet.length] + suffix;
    value = Math.floor(value / base58Alphabet.length);
  }
  return `${"1".repeat(32 - suffix.length)}${suffix}`;
}

function unavailableRiskIdentity() {
  const unavailable = () => ({ evidenceClass: "unavailable", limitation: "Evidence is unavailable." });
  return {
    schemaVersion: 1,
    methodVersion: "risk-identity-exact-match-v1",
    parserRevision: null,
    parserAuditRevision: null,
    parserAuditAt: null,
    parserAttemptRevision: null,
    parserAttemptAt: null,
    parserAttemptStatus: null,
    overallEvidence: "unavailable",
    rankingImpact: "none-uncalibrated",
    factors: {
      concentration: unavailable(), developer: unavailable(), creatorHistory: unavailable(),
      identity: { ...unavailable(), exactDuplicateCount: null, exactDuplicateCounts: {}, nameSymbolCollisionCount: null },
      liquidity: unavailable(), curve: unavailable(), lifecycle: unavailable()
    },
    duplicateEvidence: Object.fromEntries(["exactDeclaredIdentifierReuse", "duplicateContent", "likelyController", "maliciousness"]
      .map((key) => [key, { value: null, evidenceClass: "unavailable" }])),
    providerObservation: { sourceStatus: "unavailable", missingReasonCode: "provider-fields-missing", lastAttemptAt: null, nextAttemptAt: null },
    missing: ["concentration", "developer", "creatorHistory", "identity", "liquidity", "curve", "lifecycle"]
  };
}

function riskObservations(count = 120) {
  return Array.from({ length: count }, (_, index) => ({
    mint: cohortMint(index), name: `Token ${index + 1}`, symbol: `T${index + 1}`,
    createdAt: "2026-08-08T11:45:00.000Z", riskIdentity: unavailableRiskIdentity()
  }));
}

function riskCoverage({ stateCount = 120, successCount = 90, statusCounts = { available: 90, unavailable: 18, "invalid-response": 12 }, invalidAcquisitionCount = 12 } = {}) {
  return {
    stateCount,
    successCount,
    statusCounts,
    errorCodeCounts: invalidAcquisitionCount ? { "invalid-response": invalidAcquisitionCount } : {},
    invalidAcquisitionCount,
    evidenceRowCount: successCount,
    providerEvidenceMintCount: successCount,
    tokenRowCount: stateCount,
    tokenEvidenceMintCount: stateCount,
    prospectivelyObservedTokenMintCount: stateCount,
    outputMintCount: stateCount,
    evidenceClass: "locally-derived"
  };
}

function actorDownstreamGate({ eligibleMintCount = 1, acquisitionCoverage = 1 } = {}) {
  return {
    status: "withheld",
    minimumEligibleMints: 20,
    minimumAcquisitionCoverage: 0.6,
    eligibleMintCount,
    acquisitionCoverage,
    labeledHoldoutCalibrationPassed: false,
    rankingImpact: "none",
    riskProbabilityImpact: "none",
    telegramAlertImpact: "none",
    recommendationImpact: "none"
  };
}

function actorSummary(mint = cohortMint(0)) {
  return {
    mint,
    coverage: {
      state: "available",
      eventCount: 5,
      uniqueActorCount: 3,
      launchObservedAt: { state: "available", value: "2026-08-08T11:45:00.000Z" },
      sourceTimestamps: { state: "available", availableCount: 5, missingCount: 0, ratio: 1 },
      gate: {
        minimumEventCount: 5,
        minimumActorCount: 3,
        minimumSourceTimestampRatio: 1,
        eventCountMet: true,
        actorCountMet: true,
        sourceTimestampRatioMet: true
      }
    },
    metrics: {
      timing: {
        state: "available", basis: "source-timestamp-minus-launch-observed-at",
        launchObservedAt: "2026-08-08T11:45:00.000Z", earlyWindowMs: 1_800_000,
        firstActivityAt: "2026-08-08T11:45:10.000Z", lastActivityAt: "2026-08-08T11:46:20.000Z",
        actorsObservedWithinWindow: 3,
        actorFirstObservationOffsetMs: { minimum: 10_000, median: 20_000, maximum: 30_000 }
      },
      uniqueActors: { state: "available", count: 3 },
      repeatActivity: { state: "available", actorsWithMultipleBuys: 1, actorsWithMultipleSells: 0, actorsObservedOnBothSides: 1 },
      holdingDurationEvidence: {
        state: "available", basis: "validated-buy-to-subsequent-sell", timestampBasis: "source-timestamp",
        pairedObservationCount: 1, minimumMs: 60_000, medianMs: 60_000, maximumMs: 60_000
      },
      amountConcentration: {
        state: "available", basis: "observed-token-amount-not-holdings",
        amountCoverage: { state: "available", availableCount: 5, missingCount: 0 },
        actorCountWithAmount: 3, largestActorShare: 0.5, largestThreeActorShare: 1
      },
      activityBurst: {
        state: "available", timestampBasis: "source-timestamp", windowMs: 60_000,
        maximumEventCount: 4, maximumUniqueActorCount: 3,
        startedAt: "2026-08-08T11:45:10.000Z", endedAt: "2026-08-08T11:46:10.000Z"
      }
    }
  };
}

function actorEngine() {
  return {
    schemaVersion: 1,
    source: "solana-mainnet-rpc",
    parserRevision: SOLANA_ACTOR_PARSER_REVISION,
    status: "observing",
    started: true,
    queueDepth: 0,
    lastAttemptAt: "2026-08-08T12:00:00.000Z",
    lastSuccessAt: "2026-08-08T12:00:00.000Z",
    lastErrorAt: null,
    lastErrorCode: null,
    cohort: {
      limit: 32, admittedCount: 1, evidenceMintCount: 1, eligibleMintCount: 1,
      attemptedMintCount: 1, failureStateCount: 0, failureRatio: 0,
      pendingAttemptCount: 1, terminalCount: 0, terminalFailureCount: 0, statusCounts: { observing: 1 }
    },
    correlationGate: actorDownstreamGate(),
    counters: {
      admissions: 1, attempts: 1, transactionsRejected: 0, transactionRejectionReasons: {},
      observationsAccepted: 1, observationsDeduplicated: 0, failures: 0
    }
  };
}

function actorIntelligence() {
  const engine = actorEngine();
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-08T12:00:00.000Z",
    source: {
      id: "solana-mainnet-rpc",
      parserRevision: SOLANA_ACTOR_PARSER_REVISION,
      evidenceClass: "on-chain-finalized",
      endpointClass: "documented-rate-limited-public-rpc",
      attributionUrl: "https://solana.com/docs/references/clusters",
      pumpProgramDocs: "https://github.com/pump-fun/pump-public-docs",
      scope: "getSignaturesForAddress newest 16; earliest 8 in-window candidates inspected",
      completeness: "partial-and-unmeasured",
      productionSuitability: "best-effort public endpoint; failures and rate limits remain explicit"
    },
    engine,
    sampling: {
      policy: "prospective-fixed-admission-v1",
      cohortLimit: 32,
      earlyWindowSeconds: 1_800,
      attemptsAtSeconds: [120, 600, 1800],
      signaturePageLimit: 16,
      transactionLimitPerAttempt: 8,
      rawSourcePayloadsPersisted: false,
      rawWalletsPersisted: false,
      rawTransactionIdsPersisted: false,
      normalizedObservationRetentionSeconds: 72 * 60 * 60,
      aggregateSummariesPersisted: true
    },
    cohort: {
      admittedCount: 1,
      limit: 32,
      observations: [{
        mint: cohortMint(0), name: "Token 1", symbol: "T1",
        launchObservedAt: "2026-08-08T11:45:00.000Z",
        acquisition: {
          status: "observing", attemptCount: 1, lastAttemptAt: "2026-08-08T12:00:00.000Z",
          nextAttemptAt: "2026-08-08T12:15:00.000Z", lastSuccessAt: "2026-08-08T12:00:00.000Z",
          missingReason: "Minimum per-coin event/actor/source-time gate not yet met", errorCode: null
        },
        summary: actorSummary()
      }]
    },
    privacy: {
      labels: "per-installation keyed Actor numbers",
      rawWalletsPublic: false,
      rawProfilesPublic: false,
      actorLookupEndpoint: false,
      hiddenMappingMaterialPublic: false
    },
    downstream: actorDownstreamGate(),
    disclaimer: "Bounded finalized observations are partial and do not establish identity, coordination, or a trade signal."
  };
}

function actorObservation({
  mintIndex = 0,
  status = "queued",
  attemptCount = 0,
  lastAttemptAt = null,
  nextAttemptAt = "2026-08-08T12:15:00.000Z",
  lastSuccessAt = null,
  errorCode = null,
  summary = null
} = {}) {
  return {
    mint: cohortMint(mintIndex),
    name: `Token ${mintIndex + 1}`,
    symbol: `T${mintIndex + 1}`,
    launchObservedAt: "2026-08-08T11:45:00.000Z",
    acquisition: {
      status,
      attemptCount,
      lastAttemptAt,
      nextAttemptAt,
      lastSuccessAt,
      missingReason: summary ? "Minimum per-coin event/actor/source-time gate not yet met" : "Evidence remains unavailable",
      errorCode
    },
    summary
  };
}

function configureActorScenario(engine, observations, status) {
  const admittedCount = observations.length;
  const evidenceMintCount = observations.filter((observation) => observation.summary?.coverage?.eventCount > 0).length;
  const eligibleMintCount = observations.filter((observation) => observation.summary?.coverage?.state === "available").length;
  const attemptedMintCount = observations.filter((observation) => observation.acquisition.attemptCount > 0).length;
  const failureStateCount = observations.filter((observation) => observation.acquisition.attemptCount > 0
    && ["rate-limited", "degraded", "invalid-response"].includes(observation.acquisition.status)).length;
  const failureRatio = attemptedMintCount ? failureStateCount / attemptedMintCount : null;
  const pendingAttemptCount = observations.filter((observation) => observation.acquisition.nextAttemptAt !== null).length;
  const terminalCount = admittedCount - pendingAttemptCount;
  const terminalFailureCount = observations.filter((observation) => observation.acquisition.nextAttemptAt === null
    && ["rate-limited", "degraded", "invalid-response"].includes(observation.acquisition.status)).length;
  const statusCounts = Object.fromEntries(observations.reduce((counts, observation) => {
    counts.set(observation.acquisition.status, (counts.get(observation.acquisition.status) || 0) + 1);
    return counts;
  }, new Map()));
  const acquisitionCoverage = admittedCount ? evidenceMintCount / admittedCount : null;
  engine.status = status;
  engine.cohort = {
    limit: 32,
    admittedCount,
    evidenceMintCount,
    eligibleMintCount,
    attemptedMintCount,
    failureStateCount,
    failureRatio,
    pendingAttemptCount,
    terminalCount,
    terminalFailureCount,
    statusCounts
  };
  engine.correlationGate = actorDownstreamGate({ eligibleMintCount, acquisitionCoverage });
  return engine.correlationGate;
}

function configureActorHealth(health, observations, status) {
  configureActorScenario(health.earlyActors, observations, status);
}

function configureActorSnapshot(snapshot, observations, status) {
  const actor = snapshot.earlyActorIntelligence;
  const gate = configureActorScenario(actor.engine, observations, status);
  actor.cohort = { limit: 32, admittedCount: observations.length, observations };
  actor.downstream = { ...gate };
}

async function fixture(t, overrides = {}, headerOverrides = {}) {
  const bodies = {
    "/api/health": JSON.stringify({
      ok: true,
      status: "healthy",
      version,
      mode: "live",
      service: { startedAt: "2026-08-08T11:59:30.000Z", uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 },
      actionIntelligence: actionHealth(),
      outcomes: {
        source: "geckoterminal", status: "observing", queueDepth: 2,
        lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 30,
        successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
        successFreshnessBasis: "provider-success-age-while-scheduled-work-is-due",
        persistence: { attemptCount: 2, successfulStateCount: 1, dueStateCount: 2 },
        counters: { attempts: 2, successes: 1, consecutiveFailures: 0 }
      },
      riskIntelligence: {
        source: "geckoterminal", status: "available", queueDepth: 0,
        lastAttemptAt: "2026-08-08T12:00:00.000Z",
        lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 30,
        successStaleAfterSeconds: null, lastSuccessIsStale: null,
        evidenceAcquisition: "bounded-one-time-15m-with-one-missing-or-stale-retry",
        ongoingFreshnessRequired: false,
        persistence: { stateCount: 120, admittedCount: 120, successfulStateCount: 90 },
        counters: { attempts: 3, successes: 2 },
        runtimeLastSuccessAt: "2026-08-08T12:00:00.000Z",
        persistedLastSuccessAt: "2026-08-08T12:00:00.000Z",
        parserRevisionAudit: {
          status: "complete-with-failures",
          currentRevision: "geckoterminal-token-info-parser-v2",
          targetStateCount: 16,
          fullCohortAtStart: true,
          sampleStateCount: 16,
          currentDispositionCountAtStart: 0,
          currentDispositionCount: 16,
          currentAcquisitionCount: 14,
          eligibleStateCountAtStart: 16,
          selectedStateCount: 16,
          attempts: 16,
          successes: 14,
          failures: 2
        }
      },
      riskIdentityCoverage: riskCoverage(),
      earlyActors: actorEngine()
    }),
    "/api/snapshot": JSON.stringify({
      version,
      mode: "live",
      status: "healthy",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, freshnessBasis: "verified-feed-activity" },
      leaderboard: {
        schemaVersion: 2,
        ranking: { metric: "evidence_score_or_recency_v2", scorePolicy: "withheld-without-substantive-input" },
        top100: []
      },
      outcomes: {
        schemaVersion: 1,
        revisionPolicy: "first-observed-derived-value-per-window-provider-revision",
        source: { id: "geckoterminal", apiVersion: "20230203", rawResponsesPersisted: false, rawCandlesPersisted: false, providerOhlcvValuesPersisted: false },
        sampling: {
          policy: "prospective-fixed-admission-v1", cohortLimit: 120, selectionDeadlineSeconds: 120,
          poolDiscoveryScope: "GeckoTerminal contemporaneously ranked page=1 only; earliest-created eligible returned pool",
          selectionPriority: "unselected launches before candle retrieval"
        },
        summary: { windows: outcomeWindows() },
        cohorts: { narrative: { cohorts: [] }, lifecycle: { cohorts: [] } }
      },
      actionIntelligence: {
        schemaVersion: 1,
        watchlists: { persistence: "browser-local", maximumMints: 50, sharedServerWatchlist: false, reason: "No account boundary" },
        alerts: {
          schemaVersion: 1,
          supportedKinds: ["score-rise", "score-drop", "risk-concentration", "risk-developer-holding", "risk-identity-reuse", "risk-creator-history", "migration-observed"],
          deduplicatedPersistently: true,
          persistence: "atomic-event-alert-outbox-with-durable-baseline", publicDeliveryMetadata: "aggregate-only",
          scoreChangeThreshold: 15, riskFactorsAreUncalibrated: true,
          telegram: {
            status: "not-configured", tokenConfigured: false, chatConfigured: false,
            delivery: "restart-safe-bounded-at-least-once-material-alerts-only", paidBroadcastsRequired: false,
            outbox: { total: 0, statusCounts: {} }
          }
        },
        timelines: { endpoint: "/api/coins/{mint}/timeline", defaultEntries: 50, maximumEntries: 200, cursorPagination: true, rawProviderPayloadsIncluded: false },
        compare: { endpoint: "/api/compare?mints={mint},{mint}", minimumMints: 2, maximumMints: 4 },
        briefs: { daily: measuredBrief("daily"), weekly: measuredBrief("weekly") }
      },
      riskIntelligence: {
        schemaVersion: 1,
        engine: { schemaVersion: 1, source: "geckoterminal", status: "available", queueDepth: 0 },
        source: {
          id: "geckoterminal", apiVersion: "20230203",
          parserRevision: "geckoterminal-token-info-parser-v2",
          fingerprintMethodVersion: "risk-identity-exact-fingerprint-v1",
          rawResponsesPersisted: false, rawProfilesPersisted: false
        },
        rankingImpact: "none-uncalibrated",
        evidenceClasses: ["on-chain-finalized", "provider-observed", "feed-observed-processed", "locally-derived", "unavailable"],
        coverage: riskCoverage(),
        cohort: {
          policy: "risk-specific-prospective-fixed-admission-v1", limit: 120, admittedCount: 120,
          universe: "PumpPortal launches admitted by the v0.7 risk worker while active; independent from the v0.6 outcome cohort",
          observations: riskObservations()
        },
        summary: { totalTracked: 120 }
      },
      earlyActorIntelligence: actorIntelligence()
    }),
    [`/api/coins/${cohortMint(0)}`]: JSON.stringify({
      schemaVersion: 1, generatedAt: "2026-08-08T12:00:00.000Z", token: { mint: cohortMint(0), symbol: "T1" },
      radar: { score: null, orderingBasis: "recency", reasons: [], freshness: { state: "fresh" }, riskConfidence: "unavailable" },
      outcome: { windows: {} }, earlyActor: actorSummary(), timeline: `/api/coins/${cohortMint(0)}/timeline`, scope: "bounded", disclaimer: "observational"
    }),
    [`/api/coins/${cohortMint(0)}/timeline?limit=2`]: JSON.stringify({
      schemaVersion: 1, mint: cohortMint(0), generatedAt: "2026-08-08T12:00:00.000Z", limit: 2,
      entries: [], nextBefore: null, historyAvailableSince: "2026-08-08T11:45:00.000Z",
      scope: "bounded", rawProviderPayloadsIncluded: false
    }),
    [`/api/compare?mints=${encodeURIComponent(`${cohortMint(0)},${cohortMint(1)}`)}`]: JSON.stringify({
      schemaVersion: 1, generatedAt: "2026-08-08T12:00:00.000Z", requestedMints: [cohortMint(0), cohortMint(1)],
      missingMints: [], coins: [
        { mint: cohortMint(0), riskEvidence: "unavailable", outcomes: {} },
        { mint: cohortMint(1), riskEvidence: "unavailable", outcomes: {} }
      ],
      rankingBoundary: "uncalibrated risk factors do not affect radar rank", disclaimer: "observational"
    }),
    "/api/briefs/daily": JSON.stringify(measuredBrief("daily")),
    "/api/briefs/weekly": JSON.stringify(measuredBrief("weekly")),
    "/": `<meta name="application-version" content="${version}">NO WALLET · NO EXECUTION <section data-release-marker="provider-observed-outcome-engine">On-chain data provided by GeckoTerminal · Powered by CoinGecko</section><section data-release-marker="risk-identity-evidence-v1">NO COMPOSITE SCORE</section><section data-release-marker="actionable-intelligence-v1">BROWSER-LOCAL WORKBENCH · MATERIALITY POLICY v1</section><section data-release-marker="anonymous-early-actor-v1">Per-installation keyed Actor numbers · CORRELATIONS WITHHELD</section>`,
    "/app.js": "const PREFERENCE_KEY='x'; localStorage.getItem(PREFERENCE_KEY); function renderFeedObservability() {} function renderOutcomes() {} function renderRiskIntelligence() {} function renderActionIntelligence() {} function renderCoinTimeline() {} function renderEarlyActors() {} function earlyActorDetail() {} fetch('/api/compare?mints='); // raw candle retention off; identifier reuse only—not duplicate content; SYNTHETIC DEMO; installation-scoped, non-reversible labels; not a trade signal",
    "/preferences.js": "export const WATCHLIST_LIMIT = 50; export const PRESET_LIMIT = 12; export function normalizePreferences() {}",
    "/styles.css": "/* v0.9 anonymous early-actor intelligence */.outcome-source,footer{font-size:10px}.risk-intelligence-source{}.action-intelligence{}.comparison-table{}.timeline-entry{}.early-actors{}.early-actor-detail{}@media(max-width:650px){}",
    "/terms.html": "<h1>Terms</h1><p>CoinGecko API Terms</p><p>provider observations, not verified prices; exact reuse does not prove duplicate content or common control; materiality policy is not calibrated risk; migration observation is not finalization</p><p>Early-actor evidence has partial and unmeasured coverage and does not establish identity or coordination and is not a trade signal.</p>",
    "/privacy.html": "<h1>Minimal data by design</h1><p>does not persist or expose bulk GeckoTerminal responses; domain-separated hashes; browser-local preferences; Telegram Bot API delivery; opt out at any time</p><p>Per-installation keyed Actor numbers replace raw wallet addresses. Transaction signatures and mapping material are not persisted; normalized observations expire after 72 hours.</p>"
  };
  for (const [pathname, override] of Object.entries(overrides)) {
    bodies[pathname] = typeof override === "function" ? override(bodies[pathname]) : override;
  }
  const server = http.createServer((req, res) => {
    const value = bodies[req.url];
    if (value === undefined) { res.writeHead(404).end(); return; }
    const contentType = req.url.startsWith("/api/")
      ? "application/json; charset=utf-8"
      : req.url === "/" || req.url.endsWith(".html")
        ? "text/html; charset=utf-8"
        : req.url.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8";
    res.writeHead(200, { "content-type": contentType, "x-content-type-options": "nosniff", ...headerOverrides[req.url] });
    res.end(value);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function jsonOverride(update) {
  return (body) => {
    const value = JSON.parse(body);
    update(value);
    return JSON.stringify(value);
  };
}

test("verifies health, snapshot, assets, hardening telemetry, and safety markers", async (t) => {
  const baseUrl = await fixture(t);
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.http, {
    health: 200, snapshot: 200, html: 200, appJs: 200, preferencesJs: 200, styles: 200, terms: 200, privacy: 200,
    dossier: 200, timeline: 200, compare: 200, dailyBrief: 200, weeklyBrief: 200
  });
  assert.deepEqual(result.markers, {
    version: true, readOnly: true, observability: true, outcomeEngine: true, riskIdentity: true,
    actionableIntelligence: true, measuredBriefV2: true, outcomeDemandAwareFreshness: true,
    parserRevision: true, anonymousEarlyActors: true, legalNotices: true
  });
});

test("fails release smoke when the live actor worker is explicitly disabled", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.earlyActors.status = "disabled";
      health.earlyActors.started = false;
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.earlyActorIntelligence.engine.status = "disabled";
      snapshot.earlyActorIntelligence.engine.started = false;
    })
  });

  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /current early-actor parser was not exercised/.test(error.message)
  );
});

test("fails when early-actor sampling loses its bounded raw-data retention contract", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.earlyActorIntelligence.sampling.rawTransactionIdsPersisted = true;
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /sampling and retention contract/.test(error.message)
  );
});

test("fails when the early-actor parser revision does not match the account-bound parser", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => { health.earlyActors.parserRevision = "legacy-parser"; }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.earlyActorIntelligence.source.parserRevision = "legacy-parser";
      snapshot.earlyActorIntelligence.engine.parserRevision = "legacy-parser";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && /early-actor engine contract/.test(error.message)
  );
});

test("fails when actor evidence is allowed into any downstream decision surface", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.earlyActors.correlationGate.telegramAlertImpact = "enabled";
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.earlyActorIntelligence.engine.correlationGate.telegramAlertImpact = "enabled";
      snapshot.earlyActorIntelligence.downstream.telegramAlertImpact = "enabled";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && /downstream use withheld/.test(error.message)
  );
});

test("fails when every admitted actor mint is terminal with zero evidence", async (t) => {
  const terminal = () => [actorObservation({
    status: "complete",
    attemptCount: 3,
    lastAttemptAt: "2026-08-08T12:15:00.000Z",
    nextAttemptAt: null,
    lastSuccessAt: "2026-08-08T12:15:00.000Z"
  })];
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => configureActorHealth(health, terminal(), "complete-with-missing")),
    "/api/snapshot": jsonOverride((snapshot) => configureActorSnapshot(snapshot, terminal(), "complete-with-missing"))
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /exhausted every admitted mint with zero actor evidence/.test(error.message)
  );
});

test("fails when early-actor rejection-reason telemetry does not reconcile", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.earlyActors.counters.transactionsRejected = 2;
      health.earlyActors.counters.transactionRejectionReasons = { "official-pump-instruction-invalid": 1 };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /rejection-reason telemetry did not reconcile/.test(error.message)
  );
});

test("fails release smoke before the current actor parser accepts evidence", async (t) => {
  const prospective = () => [actorObservation()];
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => configureActorHealth(health, prospective(), "observing")),
    "/api/snapshot": jsonOverride((snapshot) => configureActorSnapshot(snapshot, prospective(), "observing"))
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /no accepted evidence from the current early-actor parser/.test(error.message)
  );
});

test("fails when one failed attempted mint is hidden by one untouched prospective admission", async (t) => {
  const partial = () => [
    actorObservation({
      status: "invalid-response",
      attemptCount: 3,
      lastAttemptAt: "2026-08-08T12:15:00.000Z",
      nextAttemptAt: null,
      errorCode: "invalid-transaction-response"
    }),
    actorObservation({ mintIndex: 1 })
  ];
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => configureActorHealth(health, partial(), "degraded")),
    "/api/snapshot": jsonOverride((snapshot) => configureActorSnapshot(snapshot, partial(), "degraded"))
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /failure-state ratio 1\/1 exceeded 25%/.test(error.message)
  );
});

test("fails a pending-retry false green when the attempted cohort is entirely failed", async (t) => {
  const retrying = () => [
    actorObservation({
      status: "rate-limited",
      attemptCount: 1,
      lastAttemptAt: "2026-08-08T12:00:00.000Z",
      errorCode: "rate-limited"
    }),
    actorObservation({ mintIndex: 1 })
  ];
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => configureActorHealth(health, retrying(), "degraded")),
    "/api/snapshot": jsonOverride((snapshot) => configureActorSnapshot(snapshot, retrying(), "degraded"))
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
      && /failure-state ratio 1\/1 exceeded 25%/.test(error.message)
  );
});

test("accepts actor acquisition at the 25% attempted-mint failure boundary", async (t) => {
  const boundary = () => [
    actorObservation({
      status: "invalid-response", attemptCount: 1, lastAttemptAt: "2026-08-08T12:00:00.000Z",
      errorCode: "invalid-transaction-response"
    }),
    ...[1, 2, 3].map((mintIndex) => actorObservation({
      mintIndex, status: mintIndex === 1 ? "observing" : "unavailable", attemptCount: 1,
      lastAttemptAt: "2026-08-08T12:00:00.000Z", lastSuccessAt: "2026-08-08T12:00:00.000Z",
      summary: mintIndex === 1 ? actorSummary(cohortMint(mintIndex)) : null
    }))
  ];
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => configureActorHealth(health, boundary(), "degraded")),
    "/api/snapshot": jsonOverride((snapshot) => configureActorSnapshot(snapshot, boundary(), "degraded"))
  });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("recursively rejects raw identity keys from every public JSON surface", async (t) => {
  const baseUrl = await fixture(t, {
    [`/api/coins/${cohortMint(0)}`]: jsonOverride((dossier) => {
      dossier.earlyActor.audit = { actorAddress: cohortMint(15) };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "dossier" && /raw public identity key/.test(error.message)
  );
});

test("recursively rejects normalized wallet, owner, signer, account, and profile aliases", async (t) => {
  for (const alias of [
    "wallet", "wallet_address", "owner", "signerPublicKey", "userWallet", "participantAddress",
    "authority", "feePayer", "account", "public_key", "profile", "profileUrl", "username"
  ]) {
    await t.test(alias, async (t) => {
      const baseUrl = await fixture(t, {
        [`/api/coins/${cohortMint(0)}`]: jsonOverride((dossier) => {
          dossier.earlyActor.audit = { nested: { [alias]: cohortMint(15) } };
        })
      });
      await assert.rejects(
        runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
        (error) => error instanceof SmokeCheckError && error.check === "dossier"
          && /raw public identity key/.test(error.message)
      );
    });
  }
});

test("rejects raw Solana identities in controlled labels and unknown narrative fields", async (t) => {
  for (const [name, pathname, update] of [
    ["risk cohort name", "/api/snapshot", (snapshot) => {
      snapshot.riskIntelligence.cohort.observations[0].name = cohortMint(15);
    }],
    ["actor cohort symbol", "/api/snapshot", (snapshot) => {
      snapshot.earlyActorIntelligence.cohort.observations[0].symbol = "3".repeat(64);
    }],
    ["unknown narrative scalar", `/api/coins/${cohortMint(0)}`, (dossier) => {
      dossier.researchNarrative = { observation: `Controller ${cohortMint(15)}` };
    }]
  ]) {
    await t.test(name, async (t) => {
      const baseUrl = await fixture(t, { [pathname]: jsonOverride(update) });
      await assert.rejects(
        runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
        (error) => error instanceof SmokeCheckError && /raw Solana identity value/.test(error.message)
      );
    });
  }
});

test("allows exact Solana identifiers only in mint, pool, and ordinary URL contexts", async (t) => {
  const baseUrl = await fixture(t, {
    [`/api/coins/${cohortMint(0)}`]: jsonOverride((dossier) => {
      dossier.references = {
        mint: cohortMint(15),
        selectedPool: cohortMint(16),
        explorerUrl: `https://solscan.io/account/${cohortMint(17)}`
      };
    })
  });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("recursively rejects hidden actor mapping or provenance material", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.earlyActorIntelligence.cohort.observations[0].internal = { provenanceDigest: "opaque-but-public" };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /hidden mapping, key, digest, or provenance/.test(error.message)
  );
});

test("recursively rejects raw social profile strings outside the risk schema", async (t) => {
  const baseUrl = await fixture(t, {
    [`/api/coins/${cohortMint(0)}/timeline?limit=2`]: jsonOverride((timeline) => {
      timeline.entries.push({ sourceActor: "https://x.com/raw_handle" });
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "timeline" && /raw social profile value/.test(error.message)
  );
});

test("fails when the dossier omits its explicit early-actor missing state", async (t) => {
  const baseUrl = await fixture(t, {
    [`/api/coins/${cohortMint(0)}`]: jsonOverride((dossier) => {
      delete dossier.earlyActor;
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "dossier" && /evidence field was missing/.test(error.message)
  );
});

test("fails when the current parser revision marker is absent", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      delete snapshot.riskIntelligence.source.parserRevision;
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /parser revision/.test(error.message)
  );
});

test("fails when a measured brief retains a legacy alert in its material denominator", async (t) => {
  const corruptBrief = (body) => {
    const brief = JSON.parse(body);
    brief.activity.materialAlerts = 1;
    brief.activity.materialByKind = { legacy: 1 };
    brief.activity.telegramDelivery = { "not-queued": 1 };
    return JSON.stringify(brief);
  };
  const baseUrl = await fixture(t, {
    "/api/briefs/daily": corruptBrief,
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.actionIntelligence.briefs.daily.activity.materialAlerts = 1;
      snapshot.actionIntelligence.briefs.daily.activity.materialByKind = { legacy: 1 };
      snapshot.actionIntelligence.briefs.daily.activity.telegramDelivery = { "not-queued": 1 };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && /pre-policy kind/.test(error.message)
  );
});

test("accepts the fixed risk cohort at the explicit coverage boundaries", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIntelligence.persistence.successfulStateCount = 60;
      health.riskIdentityCoverage = riskCoverage({ successCount: 60, statusCounts: { available: 60, unavailable: 30, "invalid-response": 30 }, invalidAcquisitionCount: 30 });
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.coverage = riskCoverage({
        successCount: 60,
        statusCounts: { available: 60, unavailable: 30, "invalid-response": 30 },
        invalidAcquisitionCount: 30
      });
    })
  });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("fails when successful risk acquisition covers less than half of the fixed cohort", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIntelligence.persistence.successfulStateCount = 59;
      health.riskIdentityCoverage = riskCoverage({ successCount: 59, statusCounts: { available: 59, unavailable: 61 }, invalidAcquisitionCount: 0 });
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.coverage = riskCoverage({
        successCount: 59,
        statusCounts: { available: 59, unavailable: 61 },
        invalidAcquisitionCount: 0
      });
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot"
      && /successful acquisition coverage 59\/120 was below 60\/120/.test(error.message)
  );
});

test("fails when invalid risk responses exceed one quarter of the fixed cohort", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIntelligence.persistence.successfulStateCount = 60;
      health.riskIdentityCoverage = riskCoverage({ successCount: 60, statusCounts: { available: 60, unavailable: 29, "invalid-response": 31 }, invalidAcquisitionCount: 31 });
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.coverage = riskCoverage({
        successCount: 60,
        statusCounts: { available: 60, unavailable: 29, "invalid-response": 31 },
        invalidAcquisitionCount: 31
      });
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot"
      && /invalid-response coverage 31\/120 exceeded 30\/120/.test(error.message)
  );
});

test("fails when risk coverage describes an incomplete fixed cohort", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIntelligence.persistence = { ...health.riskIntelligence.persistence, stateCount: 119, admittedCount: 119, successfulStateCount: 60 };
      health.riskIdentityCoverage = riskCoverage({ stateCount: 119, successCount: 60, statusCounts: { available: 60, unavailable: 30, "invalid-response": 29 }, invalidAcquisitionCount: 29 });
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.cohort.admittedCount = 119;
      snapshot.riskIntelligence.coverage = riskCoverage({
        stateCount: 119,
        successCount: 60,
        statusCounts: { available: 60, unavailable: 30, "invalid-response": 29 },
        invalidAcquisitionCount: 29
      });
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /fixed cohort was incomplete/.test(error.message)
  );
});

test("fails closed on version disagreement", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": JSON.stringify({ version: "0.5.0", mode: "live", status: "healthy", service: { uptimeSeconds: 1 }, storage: { mountPointVerified: true }, feed: { state: "live", isStale: false, freshnessBasis: "verified-feed-activity" } })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /did not match/.test(error.message)
  );
});

test("fails when observability evidence is absent", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": JSON.stringify({ ok: true, status: "healthy", version, mode: "live", service: { uptimeSeconds: 3 }, storage: { mountPointVerified: true }, feed: { state: "live", isStale: false }, telemetry: { errorsTotal: 0, responses5xx: 0 } })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health"
  );
});

test("fails closed on degraded or stale production state", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": JSON.stringify({
      ok: true,
      status: "degraded",
      version,
      mode: "live",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "stale", isStale: true, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 999, responses5xx: 0 }
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /not healthy/.test(error.message)
  );
});

test("fails when the runtime recorded HTTP 5xx responses", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": JSON.stringify({
      ok: true,
      status: "healthy",
      version,
      mode: "live",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 1, responses5xx: 1 }
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /HTTP 5xx/.test(error.message)
  );
});

test("fails when the live outcome provider has no successful refresh", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": JSON.stringify({
      ok: true,
      status: "healthy",
      version,
      mode: "live",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 },
      actionIntelligence: actionHealth(),
      outcomes: { source: "geckoterminal", status: "degraded", queueDepth: 2, lastSuccessAt: null, counters: { attempts: 2, successes: 0, consecutiveFailures: 2 } }
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /no successful .*refresh/.test(error.message)
  );
});

test("accepts fresh persisted outcome evidence after a restart with a current-process risk success", async (t) => {
  const health = {
    ok: true,
    status: "healthy",
    version,
    mode: "live",
    service: { startedAt: "2026-08-08T12:59:57.000Z", uptimeSeconds: 3 },
    storage: { mountPointVerified: true },
    feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
    telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 },
    actionIntelligence: actionHealth(),
    outcomes: {
      source: "geckoterminal", status: "idle", queueDepth: 0,
      lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 3_600,
      successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
      successFreshnessBasis: "provider-success-age-while-scheduled-work-is-due",
      persistence: { attemptCount: 7, successfulStateCount: 1, dueStateCount: 0 },
      counters: { attempts: 0, successes: 0, consecutiveFailures: 0 }
    },
    riskIntelligence: {
      source: "geckoterminal", status: "idle", queueDepth: 0,
      lastAttemptAt: "2026-08-08T13:00:00.000Z",
      lastSuccessAt: "2026-08-08T13:00:00.000Z", lastSuccessAgeSeconds: 0,
      successStaleAfterSeconds: null, lastSuccessIsStale: null,
      evidenceAcquisition: "bounded-one-time-15m-with-one-missing-or-stale-retry",
      ongoingFreshnessRequired: false,
      persistence: { stateCount: 120, admittedCount: 120, successfulStateCount: 90 },
      counters: { attempts: 1, successes: 1 },
      runtimeLastSuccessAt: "2026-08-08T13:00:00.000Z",
      persistedLastSuccessAt: "2026-08-08T13:00:00.000Z",
      parserRevisionAudit: {
        status: "complete-with-failures", currentRevision: "geckoterminal-token-info-parser-v2",
        targetStateCount: 16, fullCohortAtStart: true, sampleStateCount: 16,
        currentDispositionCountAtStart: 0,
        currentDispositionCount: 16, currentAcquisitionCount: 14, eligibleStateCountAtStart: 16,
        selectedStateCount: 16, attempts: 16, successes: 14, failures: 2
      }
    },
    riskIdentityCoverage: riskCoverage(),
    earlyActors: actorEngine()
  };
  const baseUrl = await fixture(t, { "/api/health": JSON.stringify(health) });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("accepts old outcome success evidence while every persisted horizon is scheduled for the future", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.outcomes.status = "idle";
      health.outcomes.queueDepth = 0;
      health.outcomes.lastSuccessAgeSeconds = 27_600;
      health.outcomes.successStaleAfterSeconds = 22_500;
      health.outcomes.successFreshnessBasis = "provider-success-age-while-scheduled-work-is-due";
      health.outcomes.lastSuccessIsStale = false;
      health.outcomes.persistence.dueStateCount = 0;
      health.outcomes.counters = { attempts: 0, successes: 0, consecutiveFailures: 0 };
    })
  });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("fails when overdue outcome work has only stale provider success evidence", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.outcomes.status = "idle";
      health.outcomes.queueDepth = 0;
      health.outcomes.lastSuccessAgeSeconds = 27_600;
      health.outcomes.successStaleAfterSeconds = 22_500;
      health.outcomes.successFreshnessBasis = "provider-success-age-while-scheduled-work-is-due";
      health.outcomes.lastSuccessIsStale = true;
      health.outcomes.persistence.dueStateCount = 1;
      health.outcomes.counters = { attempts: 0, successes: 0, consecutiveFailures: 0 };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /success evidence is stale/.test(error.message)
  );
});

test("fails when only historical risk successes exist after a process restart", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.service.startedAt = "2026-08-08T13:00:00.000Z";
      health.riskIntelligence.lastAttemptAt = null;
      health.riskIntelligence.lastSuccessAt = "2026-08-08T12:00:00.000Z";
      health.riskIntelligence.persistence.successfulStateCount = 90;
      health.riskIntelligence.counters = { attempts: 0, successes: 0 };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /neither fresh in this process/.test(error.message)
  );
});

test("fails when a claimed process-local risk success predates service start", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.service.startedAt = "2026-08-08T12:01:00.000Z";
      health.riskIntelligence.lastSuccessAt = "2026-08-08T12:00:00.000Z";
      health.riskIntelligence.counters = { attempts: 1, successes: 1 };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /neither fresh in this process/.test(error.message)
  );
});

test("accepts a complete persisted current-parser sample after a routine restart", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.service.startedAt = "2026-08-08T13:00:00.000Z";
      health.riskIntelligence.counters = { attempts: 0, successes: 0 };
      health.riskIntelligence.runtimeLastSuccessAt = null;
      health.riskIntelligence.parserRevisionAudit = {
        ...health.riskIntelligence.parserRevisionAudit,
        status: "complete-with-failures",
        currentDispositionCountAtStart: 16,
        eligibleStateCountAtStart: 0,
        selectedStateCount: 0,
        attempts: 0,
        successes: 0,
        failures: 0
      };
    })
  });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
});

test("fails when the fixed current-parser audit sample is not fully dispositioned", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIntelligence.parserRevisionAudit.currentDispositionCount = 15;
      health.riskIntelligence.parserRevisionAudit.status = "incomplete";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /audit sample was incomplete/.test(error.message)
  );
});

test("does not relabel an in-process failed pending retry as a persisted restart proof", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.service.startedAt = "2026-08-08T13:00:00.000Z";
      health.riskIntelligence.counters = { attempts: 1, successes: 0 };
      health.riskIntelligence.runtimeLastSuccessAt = null;
      health.riskIntelligence.parserRevisionAudit = {
        ...health.riskIntelligence.parserRevisionAudit,
        status: "complete-with-failures",
        currentDispositionCountAtStart: 15,
        currentDispositionCount: 16,
        eligibleStateCountAtStart: 0,
        selectedStateCount: 0,
        attempts: 0,
        successes: 0,
        failures: 0
      };
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /neither fresh in this process/.test(error.message)
  );
});

test("counts parser-invalid acquisitions even when prior evidence was retained", async (t) => {
  const retainedInvalidCoverage = riskCoverage({
    successCount: 90,
    statusCounts: { available: 60, degraded: 31, unavailable: 29 },
    invalidAcquisitionCount: 31
  });
  retainedInvalidCoverage.errorCodeCounts = { "invalid-response": 31 };
  const baseUrl = await fixture(t, {
    "/api/health": jsonOverride((health) => {
      health.riskIdentityCoverage = retainedInvalidCoverage;
    }),
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.coverage = retainedInvalidCoverage;
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot"
      && /invalid-response coverage 31\/120 exceeded 30\/120/.test(error.message)
  );
});

test("fails when the fixed cohort observations are not fully inspectable", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.cohort.observations = [];
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /120 unique inspectable observations/.test(error.message)
  );
});

test("fails when a raw social profile escapes the exact public identity schema", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.cohort.observations[0].riskIdentity.factors.identity.profile = "https://x.com/raw_handle";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /outside the public risk-identity schema|raw social profile/.test(error.message)
  );
});

test("rejects factor-incompatible fields instead of using a permissive factor union", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.cohort.observations[0].riskIdentity.factors.identity.sourceField = "raw_handle";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /outside the public risk-identity schema/.test(error.message)
  );
});

test("rejects unexpected raw-profile fields in public risk coverage", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/snapshot": jsonOverride((snapshot) => {
      snapshot.riskIntelligence.coverage.rawProfile = "https://x.com/raw_handle";
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "snapshot" && /outside the public risk-identity schema/.test(error.message)
  );
});

test("fails when live mount evidence is absent", async (t) => {
  const baseUrl = await fixture(t, {
    "/api/health": JSON.stringify({
      ok: true,
      status: "healthy",
      version,
      mode: "live",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: false },
      feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 }
    })
  });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "health" && /mount point was not verified/.test(error.message)
  );
});

test("fails on unsafe or incorrect asset response headers", async (t) => {
  const baseUrl = await fixture(t, {}, { "/app.js": { "content-type": "text/plain", "x-content-type-options": "" } });
  await assert.rejects(
    runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" }),
    (error) => error instanceof SmokeCheckError && error.check === "app.js" && /content-type/.test(error.message)
  );
});

test("validates configuration before making requests", async () => {
  await assert.rejects(runSmokeChecks({ baseUrl: "file:///tmp/app", expectedVersion: version, expectedMode: "live" }), /http or https/);
  await assert.rejects(runSmokeChecks({ baseUrl: "http://example.test", expectedVersion: "v1", expectedMode: "live" }), /semantic/);
  await assert.rejects(runSmokeChecks({ baseUrl: "http://example.test", expectedVersion: version, expectedMode: "paper" }), /live or demo/);
});
