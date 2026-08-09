import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmokeChecks, SmokeCheckError } from "../scripts/smoke.js";

const version = "0.7.2";

const outcomeWindows = () => Object.fromEntries(["5m", "15m", "1h", "6h", "24h"].map((window) => [window, {
  status: "insufficient-evidence", minimumEvidence: 3, evidenceCount: 0, missingCount: 0,
  missingReasons: {}, hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
}]));

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
      outcomes: {
        source: "geckoterminal", status: "observing", queueDepth: 2,
        lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 30,
        successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
        persistence: { attemptCount: 2, successfulStateCount: 1 },
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
      riskIdentityCoverage: riskCoverage()
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
      }
    }),
    "/": `<meta name="application-version" content="${version}">NO WALLET · NO EXECUTION <section data-release-marker="provider-observed-outcome-engine">On-chain data provided by GeckoTerminal · Powered by CoinGecko</section><section data-release-marker="risk-identity-evidence-v1">NO COMPOSITE SCORE</section>`,
    "/app.js": "function renderFeedObservability() {} function renderOutcomes() {} function renderRiskIntelligence() {} // raw candle retention off; identifier reuse only—not duplicate content; SYNTHETIC DEMO",
    "/styles.css": ".outcome-source,footer{font-size:10px}.risk-intelligence-source{}",
    "/terms.html": "<h1>Terms</h1><p>CoinGecko API Terms</p><p>provider observations, not verified prices; exact reuse does not prove duplicate content or common control</p>",
    "/privacy.html": "<h1>Minimal data by design</h1><p>does not persist or expose bulk GeckoTerminal responses; domain-separated hashes</p>"
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
  assert.deepEqual(result.http, { health: 200, snapshot: 200, html: 200, appJs: 200, styles: 200, terms: 200, privacy: 200 });
  assert.deepEqual(result.markers, { version: true, readOnly: true, observability: true, outcomeEngine: true, riskIdentity: true, parserRevision: true, legalNotices: true });
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
    outcomes: {
      source: "geckoterminal", status: "idle", queueDepth: 0,
      lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 3_600,
      successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
      persistence: { attemptCount: 7, successfulStateCount: 1 },
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
    riskIdentityCoverage: riskCoverage()
  };
  const baseUrl = await fixture(t, { "/api/health": JSON.stringify(health) });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
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
