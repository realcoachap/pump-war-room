import test from "node:test";
import assert from "node:assert/strict";
import { createTop100, OUTCOME_WINDOWS } from "../src/ranking.js";

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
  assert.equal(row.outcome.status, "awaiting-enrichment");
  for (const window of OUTCOME_WINDOWS) {
    assert.equal(row.outcome.windows[window].status, "unavailable");
    assert.equal(row.outcome.windows[window].returnPct, null);
  }
});

test("accepts only finite supplied outcome observations", () => {
  const [row] = createTop100([token(mint(1), { outcomes: { "5m": { returnPct: 12.5 }, "15m": "bad" } })], { now });
  assert.equal(row.outcome.status, "partial");
  assert.equal(row.outcome.windows["5m"].returnPct, 12.5);
  assert.equal(row.outcome.windows["15m"].status, "unavailable");
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
