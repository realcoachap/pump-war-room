import test from "node:test";
import assert from "node:assert/strict";
import { momentumScore, riskScore, classifyNarrative } from "../src/signals.js";

test("momentum rewards velocity and buyer breadth", () => {
  const quiet = momentumScore({ volume5m: 100, uniqueBuyers: 2, buyRatio: .48, bondingProgress: 10 });
  const hot = momentumScore({ volume5m: 15_000, uniqueBuyers: 35, buyRatio: .75, bondingProgress: 88 });
  assert.ok(hot > quiet); assert.ok(hot >= 75);
});
test("risk rises with concentration and creator flags", () => {
  const low = riskScore({ devHoldingPct: 2, top10Pct: 20, buyRatio: .7, creatorRisk: false });
  const high = riskScore({ devHoldingPct: 22, top10Pct: 74, buyRatio: .3, creatorRisk: true });
  assert.ok(high > low); assert.ok(high >= 70);
});
test("narratives are deterministic", () => {
  assert.equal(classifyNarrative("Neural AI agent coin"), "AI agents");
  assert.equal(classifyNarrative("the duck is viral"), "Animals");
  assert.equal(classifyNarrative("plain token"), "Other");
});
