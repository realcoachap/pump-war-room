import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SNAPSHOT_REFRESH_COOLDOWN_MS,
  SNAPSHOT_REFRESH_DEBOUNCE_MS,
  SNAPSHOT_REFRESH_FALLBACK_MS,
  SNAPSHOT_REFRESH_MAX_WAIT_MS,
  SNAPSHOT_REFRESH_TIMEOUT_MS,
  createSnapshotLiveUpdates,
  createSnapshotRefreshScheduler
} from "../public/snapshot-refresh.js";

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay = 0) => this.addTimer(callback, delay, null);

  clearTimeout = (id) => this.timers.delete(id);

  setInterval = (callback, delay) => this.addTimer(callback, delay, delay);

  clearInterval = (id) => this.timers.delete(id);

  addTimer(callback, delay, interval) {
    const id = this.nextId++;
    this.timers.set(id, { id, callback, at: this.time + Math.max(0, delay), interval });
    return id;
  }

  async advance(duration) {
    const target = this.time + duration;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.time = next.at;
      if (!this.timers.has(next.id)) continue;
      if (next.interval === null) this.timers.delete(next.id);
      else next.at += next.interval;
      next.callback();
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }
}

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function schedulerOptions(clock, refresh, overrides = {}) {
  return {
    refresh,
    debounceMs: 100,
    maxWaitMs: 500,
    cooldownMs: 300,
    fallbackMs: 10_000,
    timeoutMs: 2_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    setIntervalFn: clock.setInterval,
    clearIntervalFn: clock.clearInterval,
    ...overrides
  };
}

test("production snapshot refresh bounds preserve prompt, capped, and fallback behavior", () => {
  assert.equal(SNAPSHOT_REFRESH_DEBOUNCE_MS, 500);
  assert.equal(SNAPSHOT_REFRESH_MAX_WAIT_MS, 5_000);
  assert.equal(SNAPSHOT_REFRESH_COOLDOWN_MS, 15_000);
  assert.equal(SNAPSHOT_REFRESH_FALLBACK_MS, 15_000);
  assert.equal(SNAPSHOT_REFRESH_TIMEOUT_MS, 10_000);
});

test("continuous SSE requests debounce to one refresh by the maximum wait", async () => {
  const clock = new FakeClock();
  const calls = [];
  const scheduler = createSnapshotRefreshScheduler(schedulerOptions(clock, ({ signal }) => {
    calls.push({ at: clock.now(), signal });
  }));
  scheduler.start();

  scheduler.request();
  for (let index = 0; index < 6; index += 1) {
    await clock.advance(80);
    scheduler.request();
  }
  await clock.advance(19);
  assert.equal(calls.length, 0);
  await clock.advance(1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].at, 500);
  assert.equal(calls[0].signal.aborted, false);
});

test("in-flight activity produces one cooldown-delayed trailing refresh without overlap", async () => {
  const clock = new FakeClock();
  const runs = [];
  let active = 0;
  let maximumActive = 0;
  const scheduler = createSnapshotRefreshScheduler(schedulerOptions(clock, ({ signal }) => {
    const completion = deferred();
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    runs.push({ at: clock.now(), completion, signal });
    return completion.promise.finally(() => { active -= 1; });
  }, { debounceMs: 50, maxWaitMs: 200 }));
  scheduler.start();

  scheduler.request();
  await clock.advance(50);
  assert.equal(runs.length, 1);

  for (let index = 0; index < 25; index += 1) scheduler.request();
  await clock.advance(1_000);
  assert.equal(runs.length, 1, "a slow snapshot never overlaps another download");

  runs[0].completion.resolve();
  await flushMicrotasks();
  await flushMicrotasks();
  await clock.advance(299);
  assert.equal(runs.length, 1, "the trailing refresh observes a post-completion cooldown");
  await clock.advance(1);
  assert.equal(runs.length, 2, "all in-flight events collapse into one trailing refresh");
  assert.equal(runs[1].at, 1_350);
  assert.equal(maximumActive, 1);

  runs[1].completion.resolve();
  await flushMicrotasks();
  await flushMicrotasks();
  await clock.advance(1_000);
  assert.equal(runs.length, 2, "the scheduler does not retain a queue of trailing work");
});

test("fallback is single-instance and stop aborts work, timers, and pending refreshes across restart", async () => {
  const clock = new FakeClock();
  const runs = [];
  const scheduler = createSnapshotRefreshScheduler(schedulerOptions(clock, ({ signal }) => {
    const completion = deferred();
    signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      completion.reject(error);
    }, { once: true });
    runs.push({ at: clock.now(), completion, signal });
    return completion.promise;
  }, { fallbackMs: 1_000 }));

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  await clock.advance(999);
  assert.equal(runs.length, 0);
  await clock.advance(1);
  assert.equal(runs.length, 1, "the periodic fallback refreshes without an SSE event");

  for (let index = 0; index < 10; index += 1) scheduler.request();
  assert.equal(scheduler.stop(), true);
  assert.equal(runs[0].signal.aborted, true);
  await flushMicrotasks();
  await flushMicrotasks();
  await clock.advance(5_000);
  assert.equal(runs.length, 1, "cleanup removes fallback and trailing timers");

  assert.equal(scheduler.start(), true);
  scheduler.request();
  await clock.advance(99);
  assert.equal(runs.length, 1);
  await clock.advance(1);
  assert.equal(runs.length, 2, "a restarted lifecycle owns one fresh timer set");
  runs[1].completion.resolve();
  await flushMicrotasks();
});

test("a hung snapshot is aborted at the deadline and fallback refreshes can resume", async () => {
  const clock = new FakeClock();
  const runs = [];
  const scheduler = createSnapshotRefreshScheduler(schedulerOptions(clock, ({ signal }) => {
    const completion = deferred();
    signal.addEventListener("abort", () => {
      const error = new Error("deadline exceeded");
      error.name = "AbortError";
      completion.reject(error);
    }, { once: true });
    runs.push({ at: clock.now(), signal });
    return completion.promise;
  }, { debounceMs: 0, maxWaitMs: 0, cooldownMs: 100, fallbackMs: 250, timeoutMs: 200 }));

  scheduler.start();
  scheduler.request({ immediate: true });
  await clock.advance(0);
  assert.equal(runs.length, 1);
  await clock.advance(199);
  assert.equal(runs[0].signal.aborted, false);
  await clock.advance(1);
  assert.equal(runs[0].signal.aborted, true);
  await flushMicrotasks();
  await flushMicrotasks();
  await clock.advance(99);
  assert.equal(runs.length, 1);
  await clock.advance(1);
  assert.equal(runs.length, 2, "a timed-out request does not permanently stall periodic freshness");
  scheduler.stop();
});

test("live update lifecycle relies on native reconnect and ignores closed stream callbacks", () => {
  class FakeEventSource {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      FakeEventSource.instances.push(this);
    }

    addEventListener(event, listener) {
      this.listeners.set(event, listener);
    }

    emit(event) {
      if (event === "open") this.onopen?.();
      else if (event === "error") this.onerror?.();
      else this.listeners.get(event)?.();
    }

    close() {
      this.closed = true;
    }
  }

  const calls = { request: 0, start: 0, stop: 0 };
  const scheduler = {
    request() { calls.request += 1; },
    start() { calls.start += 1; },
    stop() { calls.stop += 1; }
  };
  const states = [];
  const live = createSnapshotLiveUpdates({ scheduler, EventSourceClass: FakeEventSource, onState: (state) => states.push(state) });

  assert.equal(live.start(), true);
  assert.equal(live.start(), false);
  assert.equal(FakeEventSource.instances.length, 1);
  const first = FakeEventSource.instances[0];
  first.emit("open");
  first.emit("token-update");
  first.emit("error");
  assert.deepEqual(states, ["connecting", "open", "reconnecting"]);
  assert.equal(FakeEventSource.instances.length, 1, "EventSource owns reconnects without creating parallel streams");
  assert.equal(calls.request, 1);

  assert.equal(live.stop(), true);
  assert.equal(first.closed, true);
  first.emit("token-update");
  first.emit("open");
  assert.equal(calls.request, 1);
  assert.deepEqual(states, ["connecting", "open", "reconnecting"]);

  assert.equal(live.start(), true);
  assert.equal(FakeEventSource.instances.length, 2);
  FakeEventSource.instances[1].emit("new-token");
  assert.equal(calls.request, 2);
  assert.deepEqual(calls, { request: 2, start: 2, stop: 1 });
});

test("a failed EventSource construction keeps periodic snapshot fallback active", () => {
  class BrokenEventSource {
    constructor() { throw new Error("unavailable"); }
  }
  const calls = { start: 0, stop: 0 };
  const scheduler = {
    request() {},
    start() { calls.start += 1; },
    stop() { calls.stop += 1; }
  };
  const states = [];
  const errors = [];
  const live = createSnapshotLiveUpdates({
    scheduler,
    EventSourceClass: BrokenEventSource,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error.message)
  });

  assert.equal(live.start(), false);
  assert.deepEqual(calls, { start: 1, stop: 0 });
  assert.deepEqual(states, ["connecting", "reconnecting"]);
  assert.deepEqual(errors, ["unavailable"]);
});

test("app routes every snapshot trigger through the bounded lifecycle", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /createSnapshotRefreshScheduler\(\{ refresh \}\)/);
  assert.match(source, /addEventListener\("pagehide", \(\) => snapshotLiveUpdates\.stop\(\)\)/);
  assert.match(source, /if \(!event\.persisted\) return;[\s\S]*snapshotLiveUpdates\.start\(\);[\s\S]*request\(\{ immediate: true \}\)/);
  assert.doesNotMatch(source, /setInterval\(refresh/);
  assert.doesNotMatch(source, /addEventListener\([^\n]+refresh\(\)/);
  assert.doesNotMatch(source, /new EventSource/);
  assert.match(source, /function vaultExportsEnabled\(\) \{\s*return false;/);
  assert.match(source, /exportDaily\.hidden = !vaultExportsEnabled\(\)/);
  assert.match(source, /vaultExportsEnabled\(\) \? '<button id="export-coin">/);
  assert.match(source, /PUBLIC PROJECTION INCOMPLETE/);
  assert.match(source, /projection\.omittedCounts/);
  assert.match(source, /projection\.integrityOmittedCounts/);
  assert.match(source, /relationshipCoverage\.includedCount/);
  assert.match(source, /relationshipCoverage\.eligibleCount/);
  assert.match(source, /relationshipCoverage\.projectionOmittedCount/);
  assert.match(source, /relationshipCoverage\.integrityOmittedCount/);
  assert.match(source, /relationshipCoverage\.limitOmittedCount/);
  assert.match(source, /proposalCoverage\.includedCount/);
  assert.match(source, /proposalCoverage\.eligibleCount/);
  assert.match(source, /proposalCoverage\.omittedInvalidCount/);
  assert.match(source, /INCOMPLETE/);
  assert.match(source, /edgeOmissions\.map/);
});
