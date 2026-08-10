import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { createRateLimiter, encodeJsonResponse, HttpError, readJsonBody } from "../src/http.js";

function request(body, headers = { "content-type": "application/json" }) {
  const stream = Readable.from(body == null ? [] : [Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

test("reads a bounded JSON object", async () => {
  assert.deepEqual(await readJsonBody(request('{"question":"status"}')), { question: "status" });
});

test("rejects unsupported content, arrays, malformed JSON, and oversized bodies", async () => {
  const cases = [
    [request("{}", { "content-type": "text/plain" }), 415],
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
  assert.equal(check("client").allowed, true);
  assert.equal(check("client").allowed, true);
  assert.equal(check("client").allowed, false);
  timestamp = 2_001;
  assert.equal(check("client").allowed, true);
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
