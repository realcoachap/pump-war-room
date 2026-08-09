import test from "node:test";
import assert from "node:assert/strict";
import { momentumScore, riskScore, riskConfidence, classifyNarrative } from "../src/signals.js";

test("momentum rewards velocity and buyer breadth", () => {
  const quiet = momentumScore({ volume5m: 100, uniqueBuyers: 2, buyRatio: .48, bondingProgress: 10 });
  const hot = momentumScore({ volume5m: 15_000, uniqueBuyers: 35, buyRatio: .75, bondingProgress: 88 });
  assert.ok(hot > quiet); assert.ok(hot >= 75);
});
test("live risk remains withheld until outcome calibration exists", () => {
  assert.equal(riskScore({ source: "pumpportal", devHoldingPct: 22, top10Pct: 74, buyRatio: .3, creatorRisk: true }), null);
  assert.equal(riskScore({ source: "demo", risk: 73 }), null);
  assert.equal(momentumScore({ volume5m: null, uniqueBuyers: null, buyRatio: null, bondingProgress: null }), null);
});
test("risk confidence separates synthetic and unenriched live data", () => {
  assert.equal(riskConfidence({ source: "demo" }), "synthetic");
  assert.equal(riskConfidence({ source: "pumpportal", devHoldingPct: null, top10Pct: null, buyRatio: null, creatorRisk: null }), "unavailable");
  assert.equal(riskConfidence({ source: "pumpportal", riskIdentity: { overallEvidence: "provider-observed" } }), "provider-observed");
  assert.equal(riskConfidence({ source: "pumpportal", riskIdentity: { overallEvidence: "locally-derived" } }), "locally-derived");
});
test("narratives are deterministic", () => {
  assert.equal(classifyNarrative("Neural AI agent coin"), "AI agents");
  assert.equal(classifyNarrative("the duck is viral"), "Animals");
  assert.equal(classifyNarrative("plain token"), "Other");
});
