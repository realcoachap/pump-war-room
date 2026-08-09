import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersistedLiveToken } from "../src/live-token.js";
import { createTop100 } from "../src/ranking.js";

const mint = "11111111111111111111111111111111";
const user = "So11111111111111111111111111111111111111112";

test("legacy false volume and dependent momentum cannot affect the v0.7 ranking", () => {
  const legacy = normalizePersistedLiveToken({
    mint, source: "pumpportal", creator: user, name: "Legacy", symbol: "OLD",
    createdAt: "2026-08-09T12:00:00Z", status: "bonding", volume5m: 9_999_999,
    priceChange5m: 900, uniqueBuyers: 999, buyRatio: 1, bondingProgress: 99,
    momentum: 100, smartWallets: 99, risk: 1
  });
  assert.equal(legacy.volume5m, null);
  assert.equal(legacy.momentum, null);
  assert.equal(legacy.bondingProgress, null);
  assert.equal(legacy.creator, null);
  assert.equal(legacy.deployer, null);
  assert.equal(legacy.legacySemanticsWithheld, true);

  const [entry] = createTop100([legacy], { mode: "live", now: Date.parse("2026-08-09T12:01:00Z") });
  assert.match(entry.reasons.join(" "), /Momentum unavailable/);
  assert.doesNotMatch(entry.reasons.join(" "), /99|100\/100/);
});

test("current schema and demo rows pass through unchanged", () => {
  const current = { mint, source: "pumpportal", ingestSchemaVersion: 2, momentum: null };
  const demo = { mint: "demo", source: "demo", momentum: 40 };
  assert.equal(normalizePersistedLiveToken(current), current);
  assert.equal(normalizePersistedLiveToken(demo, { mode: "demo" }), demo);
});
