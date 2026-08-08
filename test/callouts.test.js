import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBarkCallout } from "../src/callouts.js";
import { Store } from "../src/store.js";

test("normalizes Bark Pump.fun callouts by mint and provenance", () => {
  const callout = normalizeBarkCallout({
    _id: "call-1", time: 1768853008938, url: "https://pump.fun/coin/ABCpump",
    tags: { TYPE: "PUMPFUN_CALLOUT", CONTRACT_ADDRESS: "ABCpump", CALLOUT_USER: "alpha", CALLOUT_PRICE: "0.00005", CALLOUT_MULTIPLE: "3.5", CALLOUT_MAX_PRICE_SOL: "0.000175", MARKET_CAP_USD: "750000", SYMBOL: "CALL", NAME: "Called Token" }
  });
  assert.equal(callout.externalId, "call-1");
  assert.equal(callout.mint, "ABCpump");
  assert.equal(callout.caller, "alpha");
  assert.equal(callout.multiple, 3.5);
  assert.equal(callout.marketCap, 750000);
  assert.equal(callout.confidence, "third-party");
});

test("ignores unrelated Bark events and callouts without a mint", () => {
  assert.equal(normalizeBarkCallout({ tags: { TYPE: "TWEET" } }), null);
  assert.equal(normalizeBarkCallout({ tags: { TYPE: "PUMPFUN_CALLOUT" } }), null);
});

test("persists callouts once by external event id", () => {
  const store = new Store(":memory:");
  const callout = { externalId: "same-event", mint: "ABCpump", caller: "alpha", createdAt: new Date().toISOString() };
  store.upsertCallout(callout);
  store.upsertCallout({ ...callout, caller: "updated" });
  assert.equal(store.callouts().length, 1);
  assert.equal(store.callouts()[0].caller, "updated");
});
