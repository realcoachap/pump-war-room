import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { broadcastBoundedSse, createConcurrencyGuard, createRateLimiter, encodeJsonResponse, HttpError, readJsonBody } from "../src/http.js";

function request(body, headers = { "content-type": "application/json" }) {
  const stream = Readable.from(body == null ? [] : [Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

test("reads a bounded JSON object", async () => {
  assert.deepEqual(await readJsonBody(request('{"question":"status"}')), { question: "status" });
  assert.deepEqual(await readJsonBody(request('{"question":"status"}', {
    "content-type": "Application/JSON ; charset=UTF-8"
  })), { question: "status" });
});

test("rejects unsupported content, arrays, malformed JSON, and oversized bodies", async () => {
  const cases = [
    [request("{}", { "content-type": "text/plain" }), 415],
    [request("{}", { "content-type": "application/jsonp" }), 415],
    [request("{}", { "content-type": "text/application/json" }), 415],
    [request("{}", { "content-type": "application/json, text/plain" }), 415],
    [request("[]"), 400],
    [request("{"), 400],
    [request(JSON.stringify({ question: "x".repeat(100) })), 413]
  ];
  for (const [req, expected] of cases) {
    await assert.rejects(() => readJsonBody(req, { maxBytes: 32 }), (error) => error instanceof HttpError && error.status === expected);
  }
});

test("rate limiter resets its fixed window", () => {
  let timestamp = 1_000;
  const check = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => timestamp });
  assert.deepEqual(check("client"), { allowed: true, limit: 2, remaining: 1, retryAfter: 1, resetAtUnix: 2 });
  assert.equal(check("client").allowed, true);
  assert.equal(check("client").allowed, false);
  assert.deepEqual(check.snapshot(), {
    schemaVersion: 1, policy: "process-local-fixed-window-v1", limit: 2, windowSeconds: 1,
    maxKeys: 1_000, activeKeys: 1, requests: 3, allowed: 2, rejected: 1, evictedKeys: 0
  });
  timestamp = 2_001;
  assert.deepEqual(check("client"), { allowed: true, limit: 2, remaining: 1, retryAfter: 1, resetAtUnix: 4 });
  assert.equal(check.snapshot().requests, 4);
  assert.equal(check.snapshot().allowed, 3);
  timestamp = 3_002;
  assert.equal(check.snapshot().activeKeys, 0);
  assert.equal(check.snapshot().evictedKeys, 2);
});

test("rate limiter bounds active keys and validates its configuration", () => {
  let timestamp = 5_000;
  const check = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => timestamp });
  check("first");
  check("second");
  check("third");
  assert.equal(check.snapshot().activeKeys, 2);
  assert.equal(check.snapshot().evictedKeys, 1);
  timestamp = 6_001;
  check("fourth");
  assert.ok(check.snapshot().evictedKeys >= 3);
  assert.throws(() => createRateLimiter({ limit: 0 }), /positive safe integer/);
  assert.throws(() => createRateLimiter({ windowMs: 999 }), /at least 1000/);
  assert.throws(() => createRateLimiter({ maxKeys: 0 }), /positive safe integer/);
});

test("concurrency guard caps active work and releases exactly once", () => {
  const acquire = createConcurrencyGuard({ limit: 2 });
  const releaseFirst = acquire();
  const releaseSecond = acquire();
  assert.equal(typeof releaseFirst, "function");
  assert.equal(typeof releaseSecond, "function");
  assert.equal(acquire(), null);
  assert.deepEqual(acquire.snapshot(), {
    schemaVersion: 1,
    policy: "process-local-concurrent-connection-cap-v1",
    limit: 2,
    activeConnections: 2,
    acceptedConnections: 2,
    rejectedConnections: 1
  });
  assert.equal(releaseFirst(), true);
  assert.equal(releaseFirst(), false);
  const releaseThird = acquire();
  assert.equal(typeof releaseThird, "function");
  releaseSecond();
  releaseThird();
  assert.equal(acquire.snapshot().activeConnections, 0);
  assert.throws(() => createConcurrencyGuard({ limit: 0 }), /positive safe integer/);
});

test("bounded SSE broadcast drops slow clients and releases their slots", () => {
  let releases = 0;
  let destroyed = 0;
  const fast = { writableLength: 0, write: () => true, destroy: () => { destroyed++; } };
  const slow = { writableLength: 70_000, write: () => false, destroy: () => { destroyed++; } };
  const clients = new Map([
    [fast, () => { releases++; }],
    [slow, () => { releases++; }]
  ]);
  assert.deepEqual(broadcastBoundedSse(clients, "event: test\n\n"), { delivered: 1, dropped: 1 });
  assert.equal(clients.size, 1);
  assert.equal(clients.has(fast), true);
  assert.equal(releases, 1);
  assert.equal(destroyed, 1);
  assert.throws(() => broadcastBoundedSse(new Set(), "event: test\n\n"), /Map/);
});

test("compresses large JSON only when gzip is accepted and preserves exact content", () => {
  const value = { rows: Array.from({ length: 200 }, (_, index) => ({ index, state: "provider-observed" })) };
  const raw = encodeJsonResponse(value, { acceptEncoding: "br", compressionThreshold: 32 });
  assert.equal(raw.compressed, false);
  assert.equal(raw.headers.vary, "Accept-Encoding");
  assert.equal(raw.headers["content-encoding"], undefined);
  assert.equal(Number(raw.headers["content-length"]), raw.body.length);
  assert.deepEqual(JSON.parse(raw.body), value);

  const encoded = encodeJsonResponse(value, { acceptEncoding: "br, gzip; q=0.8", compressionThreshold: 32 });
  assert.equal(encoded.compressed, true);
  assert.equal(encoded.headers["content-encoding"], "gzip");
  assert.equal(encoded.headers.vary, "Accept-Encoding");
  assert.equal(Number(encoded.headers["content-length"]), encoded.body.length);
  assert.ok(encoded.body.length < raw.body.length / 4);
  assert.deepEqual(JSON.parse(gunzipSync(encoded.body)), value);
});

test("honors disabled gzip weights and validates the compression threshold", () => {
  const value = { payload: "x".repeat(1_000) };
  for (const acceptEncoding of ["gzip;q=0", "br, *;q=0", "gzip;q=bogus", "*;q=1, gzip;q=0", ""]) {
    const result = encodeJsonResponse(value, { acceptEncoding, compressionThreshold: 1 });
    assert.equal(result.compressed, false, acceptEncoding);
    assert.equal(result.headers["content-encoding"], undefined);
  }
  const small = encodeJsonResponse({ ok: true }, { acceptEncoding: "gzip", compressionThreshold: 1_024 });
  assert.equal(small.compressed, false);
  assert.equal(small.headers.vary, undefined);
  assert.throws(() => encodeJsonResponse(value, { compressionThreshold: -1 }), /compressionThreshold/);
});
