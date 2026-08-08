import test from "node:test";
import assert from "node:assert/strict";
import { BarkCalloutIngestor, normalizeBarkCallout } from "../src/callouts.js";
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

test("contains optional Bark construction failures and schedules a bounded reconnect", () => {
  const statuses = [];
  const timers = [];
  class InvalidWebSocket {
    constructor() { throw new DOMException("Invalid URL"); }
  }
  const ingestor = new BarkCalloutIngestor({
    url: "://invalid",
    apiKey: "configured",
    WebSocketImpl: InvalidWebSocket,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    onStatus: (status, metadata) => statuses.push({ status, metadata })
  });

  assert.doesNotThrow(() => ingestor.connect());
  assert.deepEqual(statuses.map(({ status }) => status), ["connecting", "degraded", "reconnecting"]);
  assert.equal(statuses[1].metadata.reason, "connection-failed");
  assert.ok(statuses[1].metadata.error instanceof Error);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1_000);
  ingestor.close();
  assert.equal(timers[0].cleared, true);
});
