import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runSmokeChecks, SmokeCheckError } from "../scripts/smoke.js";

const version = "0.5.1";

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
      telemetry: { format: "json-lines", errorsTotal: 0, responses5xx: 0 }
    }),
    "/api/snapshot": JSON.stringify({
      version,
      mode: "live",
      status: "healthy",
      service: { uptimeSeconds: 30 },
      storage: { mountPointVerified: true },
      feed: { state: "live", isStale: false, freshnessBasis: "verified-feed-activity" }
    }),
    "/": `<meta name="application-version" content="${version}">NO WALLET · NO EXECUTION`,
    "/app.js": "function renderFeedObservability() {}",
    ...overrides
  };
  const server = http.createServer((req, res) => {
    const value = bodies[req.url];
    if (value === undefined) { res.writeHead(404).end(); return; }
    const contentType = req.url.startsWith("/api/")
      ? "application/json; charset=utf-8"
      : req.url === "/"
        ? "text/html; charset=utf-8"
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
  assert.deepEqual(result.http, { health: 200, snapshot: 200, html: 200, appJs: 200 });
  assert.deepEqual(result.markers, { version: true, readOnly: true, observability: true });
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
