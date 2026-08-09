import test from "node:test";
import assert from "node:assert/strict";
import { parseGeckoTerminalTokenInfo } from "../src/risk-identity.js";
import { attachRiskIdentityEvidence } from "../src/risk-public.js";

const mintA = "11111111111111111111111111111111";
const mintB = "22222222222222222222222222222222";
const creator = "So11111111111111111111111111111111111111112";
const now = "2026-08-09T12:00:00Z";

function evidence(mint, overrides = {}) {
  return parseGeckoTerminalTokenInfo({
    data: {
      id: `solana_${mint}`,
      type: "token",
      attributes: {
        address: mint,
        name: "Exact Coin",
        symbol: "EXACT",
        holders: { count: 100, distribution_percentage: { top_10: "31.5" }, last_updated: "2026-08-09T11:55:00Z" },
        developer_address: creator,
        developer_holding_percentage: 3.25,
        twitter_handle: "@exact_coin",
        telegram_handle: null,
        websites: ["https://exact.example/path"],
        ...overrides
      }
    }
  }, { mint, fetchedAt: now });
}

function token(mint, overrides = {}) {
  return {
    mint, name: "Exact Coin", symbol: "EXACT", source: "pumpportal", creator,
    deployer: creator, createdAt: "2026-08-09T10:00:00Z", status: "bonding",
    curveSol: 30, launchSolAmount: 1.25, ...overrides
  };
}

test("publishes attributed factors and conservative exact-match counts without private identity digests", () => {
  const riskStates = [mintA, mintB].map((mint) => ({ mint, status: "available", evidence: evidence(mint) }));
  const outcomeStates = [{
    mint: mintA,
    evidence: { liquidity: { evidenceClass: "provider-observed", liquidityUsd: 12_500, observedAt: now } }
  }];
  const result = attachRiskIdentityEvidence([token(mintA), token(mintB)], { riskStates, outcomeStates });
  const first = result.tokens[0].riskIdentity;

  assert.equal(first.overallEvidence, "provider-observed");
  assert.equal(first.rankingImpact, "none-uncalibrated");
  assert.equal(first.factors.concentration.holderCount, 100);
  assert.equal(first.factors.concentration.top10Percentage, 31.5);
  assert.equal(first.factors.developer.holdingPercentage, 3.25);
  assert.equal(first.factors.creatorHistory.observedLaunchCount, 2);
  assert.match(first.factors.creatorHistory.scope, /v0\.7 risk cohort/);
  assert.equal(first.factors.identity.exactDuplicateCount, 1);
  assert.match(first.factors.identity.scope, /v0\.7 risk cohort/);
  assert.equal(first.factors.liquidity.liquidityUsd, 12_500);
  assert.equal(first.factors.curve.virtualSolReserve, 30);
  assert.equal(first.factors.curve.launchSolAmount, 1.25);
  assert.equal(first.factors.curve.sourceFields[0], "vSolInBondingCurve");
  assert.equal(first.duplicateEvidence.exactDeclaredIdentifierReuse.value, 1);
  assert.equal(first.duplicateEvidence.duplicateContent.value, null);
  assert.equal(first.duplicateEvidence.likelyController.value, null);
  assert.equal(first.duplicateEvidence.maliciousness.value, null);
  assert.equal(result.summary.exactDuplicateTokenCount, 2);
  assert.doesNotMatch(JSON.stringify(result.tokens), /"fingerprint"\s*:|exact_coin|exact\.example/i);
});

test("keeps missing evidence unknown and labels processed migration separately", () => {
  const result = attachRiskIdentityEvidence([token(mintA, {
    creator: null,
    deployer: null,
    name: null,
    symbol: null,
    curveSol: null,
    launchSolAmount: null,
    status: "migration-observed",
    migrationEvidence: { evidenceClass: "feed-observed-processed", observedAt: now }
  })]);
  const identity = result.tokens[0].riskIdentity;
  assert.equal(identity.overallEvidence, "feed-observed-processed");
  assert.equal(identity.factors.lifecycle.migrationObserved, true);
  assert.equal(identity.factors.concentration.evidenceClass, "unavailable");
  assert.equal(identity.factors.identity.exactDuplicateCount, null);
  assert.deepEqual(identity.duplicateEvidence.duplicateContent, { value: null, evidenceClass: "unavailable" });
  assert.match(identity.missing.join(" "), /concentration|developer|identity|liquidity/);
});

test("preserves bounded provider acquisition failure metadata in unavailable factors", () => {
  const riskStates = [{
    mint: mintA,
    status: "rate-limited",
    errorCode: "rate-limited",
    lastAttemptAt: "2026-08-09T11:00:00Z",
    nextAttemptAt: "2026-08-09T12:00:00Z",
    evidence: { missingReasonCode: "rate-limited" }
  }];
  const result = attachRiskIdentityEvidence([token(mintA)], { riskStates });
  const concentration = result.tokens[0].riskIdentity.factors.concentration;
  assert.equal(concentration.evidenceClass, "unavailable");
  assert.equal(concentration.sourceStatus, "rate-limited");
  assert.equal(concentration.missingReasonCode, "rate-limited");
  assert.equal(concentration.lastAttemptAt, "2026-08-09T11:00:00.000Z");
  assert.equal(concentration.nextAttemptAt, "2026-08-09T12:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(result), /raw provider failure/i);
});

test("omits malformed persisted provider factors before public assembly", () => {
  const malformed = evidence(mintA);
  malformed.factors.top10HolderPercentage.value = 999;
  const result = attachRiskIdentityEvidence([token(mintA)], {
    riskStates: [{ mint: mintA, status: "available", evidence: malformed }]
  });
  const identity = result.tokens[0].riskIdentity;
  assert.equal(identity.factors.concentration.evidenceClass, "unavailable");
  assert.equal(identity.factors.developer.evidenceClass, "unavailable");
  assert.equal(result.aggregateCoverage.evidenceRowCount, 0);
});

test("demo factors remain explicitly synthetic", () => {
  const result = attachRiskIdentityEvidence([token(mintA, { source: "demo", top10Pct: 44, devHoldingPct: 8 })], { mode: "demo" });
  const identity = result.tokens[0].riskIdentity;
  assert.equal(identity.overallEvidence, "synthetic");
  assert.equal(identity.factors.concentration.top10Percentage, 44);
  assert.equal(identity.factors.concentration.evidenceClass, "synthetic");
  assert.equal(result.summary.holderEvidenceCount, 1);
});
