export const SNAPSHOT_REFRESH_DEBOUNCE_MS = 500;
export const SNAPSHOT_REFRESH_MAX_WAIT_MS = 5_000;
export const SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000;
export const SNAPSHOT_REFRESH_FALLBACK_MS = 15_000;
export const SNAPSHOT_REFRESH_TIMEOUT_MS = 10_000;

export const SNAPSHOT_STREAM_EVENTS = Object.freeze([
  "new-token",
  "token-update",
  "callout",
  "alert",
  "material-change",
  "status"
]);

function duration(name, value, { allowZero = true } = {}) {
  if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} finite duration`);
  }
  return value;
}

export function createSnapshotRefreshScheduler({
  refresh,
  debounceMs = SNAPSHOT_REFRESH_DEBOUNCE_MS,
  maxWaitMs = SNAPSHOT_REFRESH_MAX_WAIT_MS,
  cooldownMs = SNAPSHOT_REFRESH_COOLDOWN_MS,
  fallbackMs = SNAPSHOT_REFRESH_FALLBACK_MS,
  timeoutMs = SNAPSHOT_REFRESH_TIMEOUT_MS,
  now = () => globalThis.performance.now(),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = (timer) => globalThis.clearInterval(timer),
  createAbortController = () => new globalThis.AbortController(),
  onError = (error) => globalThis.console.warn("Snapshot refresh scheduler failed", error)
} = {}) {
  if (typeof refresh !== "function") throw new TypeError("refresh must be a function");
  debounceMs = duration("debounceMs", debounceMs);
  maxWaitMs = duration("maxWaitMs", maxWaitMs);
  cooldownMs = duration("cooldownMs", cooldownMs);
  fallbackMs = duration("fallbackMs", fallbackMs, { allowZero: false });
  timeoutMs = duration("timeoutMs", timeoutMs, { allowZero: false });
  if (maxWaitMs < debounceMs) throw new RangeError("maxWaitMs must be at least debounceMs");

  let active = false;
  let generation = 0;
  let fallbackTimer = null;
  let refreshTimer = null;
  let refreshTimerAt = null;
  let pendingSince = null;
  let lastRequestedAt = null;
  let pendingImmediate = false;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  let inFlight = null;

  function clearRefreshTimer() {
    if (refreshTimer === null) return;
    clearTimeoutFn(refreshTimer);
    refreshTimer = null;
    refreshTimerAt = null;
  }

  function pendingDueAt() {
    const burstDueAt = pendingImmediate
      ? pendingSince
      : Math.min(lastRequestedAt + debounceMs, pendingSince + maxWaitMs);
    return Math.max(burstDueAt, lastCompletedAt + cooldownMs);
  }

  function schedulePending() {
    if (!active || inFlight || pendingSince === null) return;
    const scheduledAt = pendingDueAt();
    if (refreshTimer !== null && refreshTimerAt === scheduledAt) return;
    clearRefreshTimer();
    refreshTimerAt = scheduledAt;
    refreshTimer = setTimeoutFn(() => {
      refreshTimer = null;
      refreshTimerAt = null;
      runPending();
    }, Math.max(0, scheduledAt - now()));
  }

  function runPending() {
    if (!active || inFlight || pendingSince === null) return;
    if (pendingDueAt() > now()) {
      schedulePending();
      return;
    }

    pendingSince = null;
    lastRequestedAt = null;
    pendingImmediate = false;

    const runGeneration = generation;
    const controller = createAbortController();
    const timeoutTimer = setTimeoutFn(() => controller.abort(), timeoutMs);
    const run = { controller, generation: runGeneration, timeoutTimer };
    inFlight = run;

    void (async () => {
      try {
        await refresh({ signal: controller.signal });
      } catch (error) {
        if (error?.name !== "AbortError") {
          try { onError(error); } catch {}
        }
      } finally {
        clearTimeoutFn(timeoutTimer);
        if (runGeneration === generation) lastCompletedAt = now();
        if (inFlight === run) inFlight = null;
        schedulePending();
      }
    })();
  }

  function request({ immediate = false } = {}) {
    if (!active) return false;
    const requestedAt = now();
    if (pendingSince === null) pendingSince = requestedAt;
    lastRequestedAt = requestedAt;
    pendingImmediate ||= immediate;
    schedulePending();
    return true;
  }

  function start() {
    if (active) return false;
    active = true;
    generation += 1;
    lastCompletedAt = Number.NEGATIVE_INFINITY;
    fallbackTimer = setIntervalFn(() => request({ immediate: true }), fallbackMs);
    schedulePending();
    return true;
  }

  function stop() {
    const wasActive = active;
    active = false;
    generation += 1;
    if (fallbackTimer !== null) clearIntervalFn(fallbackTimer);
    fallbackTimer = null;
    clearRefreshTimer();
    pendingSince = null;
    lastRequestedAt = null;
    pendingImmediate = false;
    inFlight?.controller.abort();
    return wasActive;
  }

  return Object.freeze({ request, start, stop });
}

export function createSnapshotLiveUpdates({
  scheduler,
  EventSourceClass = globalThis.EventSource,
  streamUrl = "/api/stream",
  events = SNAPSHOT_STREAM_EVENTS,
  onState = () => {},
  onError = () => {}
} = {}) {
  if (!scheduler || !["request", "start", "stop"].every((method) => typeof scheduler[method] === "function")) {
    throw new TypeError("scheduler must expose request, start, and stop functions");
  }
  if (typeof EventSourceClass !== "function") throw new TypeError("EventSourceClass must be a constructor");

  let stream = null;

  function start() {
    if (stream) return false;
    scheduler.start();
    onState("connecting");

    let nextStream;
    try {
      nextStream = new EventSourceClass(streamUrl);
    } catch (error) {
      onState("reconnecting");
      onError(error);
      return false;
    }
    stream = nextStream;
    nextStream.onopen = () => {
      if (stream === nextStream) onState("open");
    };
    nextStream.onerror = () => {
      if (stream === nextStream) onState("reconnecting");
    };
    for (const event of events) {
      nextStream.addEventListener(event, () => {
        if (stream === nextStream) scheduler.request();
      });
    }
    return true;
  }

  function stop() {
    const previousStream = stream;
    stream = null;
    previousStream?.close();
    scheduler.stop();
    return Boolean(previousStream);
  }

  return Object.freeze({ start, stop });
}
