import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmokeChecks, SmokeCheckError } from "../scripts/smoke.js";

const version = "0.6.0";

const outcomeWindows = () => Object.fromEntries(["5m", "15m", "1h", "6h", "24h"].map((window) => [window, {
  status: "insufficient-evidence", minimumEvidence: 3, evidenceCount: 0, missingCount: 0,
  missingReasons: {}, hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
}]));

async function fixture(t, overrides = {}, headerOverrides = {}) {
  const bodies = {
    "/api/health": JSON.stringify({
      ok: true,
      status: "healthy",
      version,
      mode: "live",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
      telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 },
      outcomes: {
        source: "geckoterminal", status: "observing", queueDepth: 2,
        lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 30,
        successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
        persistence: { attemptCount: 2, successfulStateCount: 1 },
        counters: { attempts: 2, successes: 1, consecutiveFailures: 0 }
      }
    }),
    "/api/snapshot": JSON.stringify({
      version,
      mode: "live",
      status: "healthy",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, freshnessBasis: "verified-feed-activity" },
      leaderboard: { top100: [] },
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
      }
    }),
    "/": `<meta name="application-version" content="${version}">NO WALLET · NO EXECUTION <section data-release-marker="provider-observed-outcome-engine">On-chain data provided by GeckoTerminal · Powered by CoinGecko</section>`,
    "/app.js": "function renderFeedObservability() {} function renderOutcomes() {} // raw candle retention off",
    "/styles.css": ".outcome-source,footer{font-size:10px}",
    "/terms.html": "<h1>Terms</h1><p>CoinGecko API Terms</p><p>provider observations, not verified prices</p>",
    "/privacy.html": "<h1>Minimal data by design</h1><p>does not persist or expose bulk GeckoTerminal responses</p>",
    ...overrides
  };
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

test("verifies health, snapshot, assets, hardening telemetry, and safety markers", async (t) => {
  const baseUrl = await fixture(t);
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.http, { health: 200, snapshot: 200, html: 200, appJs: 200, styles: 200, terms: 200, privacy: 200 });
  assert.deepEqual(result.markers, { version: true, readOnly: true, observability: true, outcomeEngine: true, legalNotices: true });
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

test("accepts fresh persisted provider evidence after a process restart with zero runtime counters", async (t) => {
  const health = {
    ok: true,
    status: "healthy",
    version,
    mode: "live",
    service: { uptimeSeconds: 3 },
    storage: { mountPointVerified: true },
    feed: { state: "live", isStale: false, staleAfterSeconds: 90 },
    telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 },
    outcomes: {
      source: "geckoterminal", status: "idle", queueDepth: 0,
      lastSuccessAt: "2026-08-08T12:00:00.000Z", lastSuccessAgeSeconds: 3_600,
      successStaleAfterSeconds: 22_500, lastSuccessIsStale: false,
      persistence: { attemptCount: 7, successfulStateCount: 1 },
      counters: { attempts: 0, successes: 0, consecutiveFailures: 0 }
    }
  };
  const baseUrl = await fixture(t, { "/api/health": JSON.stringify(health) });
  const result = await runSmokeChecks({ baseUrl, expectedVersion: version, expectedMode: "live" });
  assert.equal(result.ok, true);
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
