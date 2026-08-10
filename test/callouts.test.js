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

function fakeSocketHarness() {
  const sockets = [];
  const timers = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closeCalls = 0;
      sockets.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
    send() {}
    close() { this.closeCalls++; }
  }
  return {
    sockets,
    timers,
    WebSocketImpl: FakeWebSocket,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; }
  };
}

test("reconnects after a Bark socket error without waiting for a close event", () => {
  const statuses = [];
  const harness = fakeSocketHarness();
  const ingestor = new BarkCalloutIngestor({
    apiKey: "configured",
    ...harness,
    onStatus: (status, metadata) => statuses.push({ status, metadata })
  });

  ingestor.connect();
  const failedSocket = harness.sockets[0];
  failedSocket.emit("open");
  failedSocket.emit("error", { error: new Error("upgrade returned non-101") });

  assert.equal(failedSocket.closeCalls, 1);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 1_000);
  assert.deepEqual(statuses.map(({ status }) => status), ["connecting", "live", "degraded", "reconnecting"]);
  assert.equal(statuses[2].metadata.reason, "socket-error");

  harness.timers[0].callback();
  assert.equal(harness.sockets.length, 2, "the bounded retry must construct a replacement socket");

  failedSocket.emit("error", { error: new Error("stale error") });
  failedSocket.emit("close");
  assert.equal(harness.timers.length, 1, "stale events must not schedule a duplicate retry");
  ingestor.close();
});

test("shutdown cancels a pending Bark socket-error retry", () => {
  const harness = fakeSocketHarness();
  const ingestor = new BarkCalloutIngestor({ apiKey: "configured", ...harness });

  ingestor.connect();
  harness.sockets[0].emit("error", { error: new Error("upgrade returned non-101") });
  assert.equal(harness.timers.length, 1);

  ingestor.close();
  assert.equal(harness.timers[0].cleared, true);
  harness.timers[0].callback();
  assert.equal(harness.sockets.length, 1, "a cancelled retry must not reconnect after shutdown");
});
