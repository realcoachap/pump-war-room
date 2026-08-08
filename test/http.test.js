import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRateLimiter, HttpError, readJsonBody } from "../src/http.js";

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
