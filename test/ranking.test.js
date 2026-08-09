import test from "node:test";
import assert from "node:assert/strict";
import { createTop100, OUTCOME_WINDOWS } from "../src/ranking.js";
import { calculateVerifiedOutcome } from "../src/outcomes.js";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const mint = (index) => `${String(index + 1).padStart(4, "1")}${"A".repeat(28)}`;
const token = (mint, overrides = {}) => ({
  mint, name: mint, symbol: mint.toUpperCase(), source: "pumpportal",
  createdAt: "2026-08-08T11:59:00.000Z", momentum: 50, bondingProgress: 25,
  uniqueBuyers: 8, riskConfidence: "unverified", risk: null, ...overrides
});

test("builds a deterministic observed-feed Top 100", () => {
  const rows = createTop100([
    token(mint(1), { name: "low", momentum: 20 }), token(mint(2), { name: "high", momentum: 90 }),
    token("demo", { source: "demo", momentum: 100 })
  ], { now, mode: "live" });
  assert.deepEqual(rows.map((row) => row.token.name), ["high", "low"]);
  assert.deepEqual(rows.map((row) => row.rank), [1, 2]);
  assert.equal(rows[0].freshness.state, "fresh");
  assert.equal(rows[0].riskConfidence, "unverified");
});

test("caps rankings at 100 rows", () => {
  const rows = createTop100(Array.from({ length: 125 }, (_, index) => token(mint(index), { momentum: index })), { now });
  assert.equal(rows.length, 100);
  assert.ok(rows[0].score <= 100);
  assert.ok(rows.every((row) => row.rank >= 1 && row.rank <= 100));
});

test("never invents unavailable outcome returns", () => {
  const [row] = createTop100([token(mint(1))], { now });
  assert.equal(row.outcome.status, "awaiting-baseline");
  for (const window of OUTCOME_WINDOWS) {
    assert.equal(row.outcome.windows[window].status, "unavailable");
    assert.equal(row.outcome.windows[window].returnPct, null);
  }
});

test("accepts only the explicit provider-grounded outcome map", () => {
  const targetMint = mint(1);
  const candle = (start, close) => ({
    candleStartAt: start,
    observedAt: new Date(Date.parse(start) + 60_000).toISOString(),
    fetchedAt: "2026-08-08T12:00:00.000Z",
    close, volume: 1, source: "geckoterminal", pool: targetMint, intervalSeconds: 60
  });
  const verified = calculateVerifiedOutcome({
    launchAt: "2026-08-08T11:50:00.000Z",
    asOf: "2026-08-08T12:00:00.000Z",
    candles: [candle("2026-08-08T11:50:00.000Z", 1), candle("2026-08-08T11:54:00.000Z", 1.125)]
  });
  verified.poolSelection = {
    policy: "prospective-earliest-created-eligible-pool-on-provider-ranked-page-1-within-2m",
    selectedAt: "2026-08-08T11:50:30.000Z",
    providerPage: 1,
    providerRank: 1,
    poolCreatedAt: "2026-08-08T11:49:59.000Z",
    source: "geckoterminal",
    pool: targetMint
  };
  const outcomesByMint = new Map([[targetMint, verified]]);
  const [row] = createTop100([token(targetMint, { createdAt: "2026-08-08T11:50:00.000Z", outcomes: { "5m": 999 } })], { now, outcomesByMint });
  assert.equal(row.outcome.status, "partial");
  assert.equal(row.outcome.windows["5m"].returnPct, 12.5);
  const [untrusted] = createTop100([token(targetMint, { createdAt: "2026-08-08T11:50:00.000Z", outcomes: { "5m": 999 } })], { now });
  assert.equal(untrusted.outcome.windows["5m"].status, "unavailable");

  const corrupt = structuredClone(verified);
  delete corrupt.windows["5m"].evidence.target;
  const [contained] = createTop100([token(targetMint, { createdAt: "2026-08-08T11:50:00.000Z" })], {
    now,
    outcomesByMint: new Map([[targetMint, corrupt]])
  });
  assert.equal(contained.outcome.windows["5m"].status, "unavailable");
});

test("preserves explicit provider failure states in unavailable outcome windows", () => {
  const tokens = [token(mint(1)), token(mint(2)), token(mint(3))]
    .map((row) => ({ ...row, createdAt: "2026-08-08T11:50:00.000Z" }));
  const outcomesByMint = new Map([
    [mint(1), { status: "queued", errorCode: null, lastAttemptAt: null, nextAttemptAt: "2026-08-08T12:01:00.000Z", evidence: {} }],
    [mint(2), { status: "invalid-response", errorCode: "selection-window-missed", lastAttemptAt: "2026-08-08T11:53:00.000Z", nextAttemptAt: null, evidence: {} }],
    [mint(3), { status: "invalid-response", errorCode: "token-mismatch", lastAttemptAt: "2026-08-08T11:55:00.000Z", nextAttemptAt: "2026-08-08T17:55:00.000Z", evidence: {} }]
  ]);
  const rows = createTop100(tokens, { now, outcomesByMint });
  const byMint = new Map(rows.map((row) => [row.token.mint, row.outcome]));
  assert.equal(byMint.get(mint(1)).windows["5m"].reason, "provider-admission-pending");
  assert.equal(byMint.get(mint(2)).windows["5m"].reason, "provider-selection-window-missed");
  assert.equal(byMint.get(mint(3)).windows["5m"].reason, "provider-invalid-response");
  assert.equal(byMint.get(mint(1)).windows["15m"].reason, "window-not-mature");
  assert.equal(byMint.get(mint(2)).missingData.providerErrorCode, "selection-window-missed");
  assert.equal(JSON.stringify(rows).includes("baseline-missing"), false);
});

test("rejects invalid live identities and contains invalid metrics", () => {
  const [row] = createTop100([
    token("not-a-solana-mint", { momentum: 99 }),
    token(mint(1), { momentum: "bad", volume5m: -20, uniqueBuyers: -5, risk: Infinity })
  ], { now, mode: "live" });
  assert.equal(row.token.momentum, null);
  assert.equal(row.token.volume5m, null);
  assert.equal(row.token.uniqueBuyers, null);
  assert.equal(row.token.risk, null);
});

test("uses deterministic ties and records graduation only from token status", () => {
  const rows = createTop100([
    token(mint(2), { status: "graduated", graduatedAt: "2026-08-08T11:59:30.000Z" }),
    token(mint(1))
  ], { now, mode: "live" });
  assert.equal(rows[0].token.mint, mint(1));
  assert.equal(rows[1].outcome.graduation.status, "observed");
  assert.equal(rows[0].outcome.graduation.status, "pending");
});
