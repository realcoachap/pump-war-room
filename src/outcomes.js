const HORIZONS = Object.freeze([
  Object.freeze({ key: "5m", offsetMs: 5 * 60_000 }),
  Object.freeze({ key: "15m", offsetMs: 15 * 60_000 }),
  Object.freeze({ key: "1h", offsetMs: 60 * 60_000 }),
  Object.freeze({ key: "6h", offsetMs: 6 * 60 * 60_000 }),
  Object.freeze({ key: "24h", offsetMs: 24 * 60 * 60_000 })
]);

export const OUTCOME_HORIZONS = Object.freeze(HORIZONS.map(({ key }) => key));
export const DEFAULT_MAX_STALENESS_MS = 90_000;
export const DEFAULT_MAX_BASELINE_LAG_MS = 120_000;
export const DEFAULT_MINIMUM_EVIDENCE = 3;
export const DEFAULT_MINIMUM_COVERAGE_RATIO = 0.5;
export const OUTCOME_ALGORITHM = "provider-observed-completed-candle-outcomes-v1";
export const OUTCOME_REVISION_POLICY = "first-observed-derived-value-per-window-provider-revision";
const OUTCOME_BASIS = "first-wholly-post-launch-completed-candle-baseline-and-last-completed-close-at-or-before-target";
const OUTCOME_STATUSES = new Set(["awaiting-baseline", "complete", "partial", "awaiting-observations"]);
const OUTCOME_MISSING_REASONS = new Set([
  "baseline-missing", "baseline-observation-stale", "window-not-mature", "target-observation-missing",
  "target-observation-stale", "return-calculation-out-of-range", "provider-admission-pending",
  "provider-observation-pending", "provider-pool-unavailable", "provider-selection-window-missed",
  "provider-invalid-response", "provider-rate-limited", "provider-unavailable", "provider-baseline-unavailable",
  "provider-evidence-unavailable"
]);
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUTCOME_KEYS = new Set(["schemaVersion", "algorithm", "revisionPolicy", "status", "basis", "launchAt", "asOf", "maxStalenessMs", "maxBaselineLagMs", "series", "baseline", "observationCounts", "windows", "poolSelection", "revisionHistory", "missingData"]);
const SERIES_KEYS = new Set(["source", "pool", "intervalSeconds"]);
const BASELINE_KEYS = new Set(["status", "expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "lagSeconds", "source", "pool", "intervalSeconds", "close", "volume", "nonempty", "reason", "candidate", "role"]);
const OBSERVATION_COUNT_KEYS = new Set(["supplied", "normalized", "availableAsOf", "beforeLaunch", "afterAsOf", "retainedObservedWindows"]);
const WINDOW_KEYS = new Set(["status", "calculatedAt", "expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "stalenessSeconds", "source", "pool", "intervalSeconds", "returnPct", "maximumDrawdownPct", "reason", "evidence"]);
const WINDOW_EVIDENCE_KEYS = new Set(["baseline", "target", "drawdown"]);
const CANDLE_KEYS = new Set(["expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "lagSeconds", "stalenessSeconds", "source", "pool", "intervalSeconds", "close", "volume", "nonempty"]);
const DRAWDOWN_KEYS = new Set(["basis", "sampleCount", "maximumPct", "peak", "trough"]);
const POOL_SELECTION_KEYS = new Set(["policy", "selectedAt", "providerPage", "providerRank", "poolCreatedAt", "source", "pool"]);
const REVISION_KEYS = new Set(["checkedAt", "action", "windowRevisionPolicy", "changedWindows", "missingWindows", "newlyObservedWindows"]);
const MISSING_DATA_KEYS = new Set(["reason", "providerStatus", "providerErrorCode", "lastAttemptAt", "nextAttemptAt", "updatedAt"]);
const OUTCOME_TIMESTAMP_FIELDS = new Set(["launchAt", "asOf", "expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "calculatedAt", "selectedAt", "poolCreatedAt", "checkedAt", "lastAttemptAt", "nextAttemptAt", "updatedAt"]);
const OUTCOME_INTEGER_FIELDS = new Set(["schemaVersion", "maxStalenessMs", "maxBaselineLagMs", "intervalSeconds", "supplied", "normalized", "availableAsOf", "beforeLaunch", "afterAsOf", "retainedObservedWindows", "sampleCount", "providerPage", "providerRank"]);
const OUTCOME_NUMBER_FIELDS = new Set(["lagSeconds", "stalenessSeconds", "returnPct", "maximumDrawdownPct", "maximumPct", "close", "volume"]);
const OUTCOME_BOOLEAN_FIELDS = new Set(["nonempty"]);
const OUTCOME_STRING_FIELDS = new Set(["algorithm", "revisionPolicy", "status", "basis", "source", "pool", "reason", "role", "policy", "action", "windowRevisionPolicy", "providerStatus", "providerErrorCode"]);
const PROVIDER_STATE_STATUSES = new Set(["queued", "pool-selected", "awaiting-pool", "awaiting-price", "baseline-unavailable", "observing", "complete", "rate-limited", "degraded", "invalid-response"]);
const PROVIDER_ERROR_CODES = new Set(["enrichment-failed", "invalid-before-timestamp", "invalid-fetch-timestamp", "invalid-json", "invalid-limit", "invalid-mint", "invalid-pool", "invalid-response", "invalid-selection-timestamp", "invalid-token-side", "invalid-token-timestamp", "network-error", "not-found", "pool-unavailable", "provider-http-error", "provider-request-rejected", "provider-unavailable", "rate-limited", "selection-window-missed", "timeout", "token-mismatch"]);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value) {
  return Number(value.toFixed(8));
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an RFC 3339 timestamp string`);
  const input = value.trim();
  const match = RFC3339.exec(input);
  if (!match) throw new TypeError(`${label} must include a date, time, seconds, and UTC offset`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const offset = zone === "Z" ? null : zone.slice(1).split(":").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59 || (offset && (offset[0] > 23 || offset[1] > 59))) {
    throw new RangeError(`${label} is not a valid calendar timestamp`);
  }
  const timestampMs = Date.parse(input);
  if (!Number.isFinite(timestampMs)) throw new RangeError(`${label} is outside the supported timestamp range`);
  return { timestampMs, observedAt: new Date(timestampMs).toISOString() };
}

function normalizeLabel(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (CONTROL_CHARACTERS.test(normalized)) throw new TypeError(`${label} must not contain control characters`);
  return normalized;
}

function normalizeCandle(candle, label) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) throw new TypeError(`${label} must be an object`);
  if (typeof candle.close !== "number" || !Number.isFinite(candle.close) || candle.close <= 0) {
    throw new RangeError(`${label}.close must be a finite positive number`);
  }
  if (typeof candle.volume !== "number" || !Number.isFinite(candle.volume) || candle.volume <= 0) {
    throw new RangeError(`${label}.volume must be a finite positive number proving a nonempty candle`);
  }
  if (typeof candle.intervalSeconds !== "number" || !Number.isSafeInteger(candle.intervalSeconds) || candle.intervalSeconds < 1) {
    throw new RangeError(`${label}.intervalSeconds must be a positive integer`);
  }
  if (candle.intervalSeconds !== 60) throw new RangeError(`${label}.intervalSeconds must be 60 for one-minute outcomes`);
  const start = normalizeTimestamp(candle.candleStartAt, `${label}.candleStartAt`);
  const timestamp = normalizeTimestamp(candle.observedAt, `${label}.observedAt`);
  const explicitEnd = candle.candleEndAt == null ? timestamp : normalizeTimestamp(candle.candleEndAt, `${label}.candleEndAt`);
  const fetched = normalizeTimestamp(candle.fetchedAt, `${label}.fetchedAt`);
  const expectedCloseMs = start.timestampMs + candle.intervalSeconds * 1_000;
  if (timestamp.timestampMs !== expectedCloseMs) {
    throw new RangeError(`${label}.observedAt must equal candleStartAt plus intervalSeconds`);
  }
  if (explicitEnd.timestampMs !== timestamp.timestampMs) {
    throw new RangeError(`${label}.candleEndAt must equal observedAt`);
  }
  if (fetched.timestampMs < timestamp.timestampMs) {
    throw new RangeError(`${label}.fetchedAt must not be before the completed close`);
  }
  const source = normalizeLabel(candle.source ?? candle.provider, `${label}.source`);
  if (candle.source != null && candle.provider != null
    && normalizeLabel(candle.provider, `${label}.provider`) !== source) {
    throw new RangeError(`${label}.source and provider must agree when both are supplied`);
  }
  return {
    candleStartMs: start.timestampMs,
    timestampMs: timestamp.timestampMs,
    fetchedAtMs: fetched.timestampMs,
    candleStartAt: start.observedAt,
    candleEndAt: timestamp.observedAt,
    observedAt: timestamp.observedAt,
    fetchedAt: fetched.observedAt,
    close: candle.close,
    volume: candle.volume,
    source,
    pool: normalizeLabel(candle.pool, `${label}.pool`),
    intervalSeconds: candle.intervalSeconds
  };
}

function sameCompletedCandle(left, right) {
  return left.timestampMs === right.timestampMs
    && left.close === right.close
    && left.volume === right.volume
    && left.source === right.source
    && left.pool === right.pool
    && left.intervalSeconds === right.intervalSeconds
    && left.candleStartAt === right.candleStartAt;
}

function sameSeries(left, right) {
  return left.source === right.source && left.pool === right.pool && left.intervalSeconds === right.intervalSeconds;
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const sorted = candles.map((candle, index) => normalizeCandle(candle, `candles[${index}]`))
    .sort((left, right) => left.timestampMs - right.timestampMs
      || left.fetchedAtMs - right.fetchedAtMs
      || compareText(left.source, right.source)
      || compareText(left.pool, right.pool)
      || left.intervalSeconds - right.intervalSeconds
      || left.close - right.close);
  const normalized = [];
  for (const candle of sorted) {
    const previous = normalized.at(-1);
    if (previous?.timestampMs === candle.timestampMs) {
      if (sameCompletedCandle(previous, candle)) continue;
      throw new RangeError(`candles contain conflicting observations at ${candle.observedAt}`);
    }
    normalized.push(candle);
  }
  const series = normalized[0];
  if (series && normalized.some((candle) => !sameSeries(candle, series))) {
    throw new RangeError("candles must contain exactly one source, pool, and interval series");
  }
  return normalized;
}

function publicCandle(candle) {
  return {
    candleStartAt: candle.candleStartAt,
    candleEndAt: candle.candleEndAt,
    observedAt: candle.observedAt,
    fetchedAt: candle.fetchedAt,
    close: candle.close,
    volume: candle.volume,
    source: candle.source,
    pool: candle.pool,
    intervalSeconds: candle.intervalSeconds
  };
}

export function normalizePriceCandles(candles) {
  return normalizeCandles(candles).map(publicCandle);
}

function normalizeMilliseconds(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeMinimumEvidence(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("minimumEvidence must be a positive integer");
  }
  return value;
}

function normalizeCoverageRatio(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("minimumCoverageRatio must be a number between 0 and 1");
  }
  return value;
}

function selection(candle) {
  if (!candle) return null;
  return {
    candleStartAt: candle.candleStartAt,
    candleEndAt: candle.candleEndAt,
    observedAt: candle.observedAt,
    fetchedAt: candle.fetchedAt,
    close: candle.close,
    volume: candle.volume,
    source: candle.source,
    pool: candle.pool,
    intervalSeconds: candle.intervalSeconds
  };
}

function baselineSelection(candle, launchMs) {
  const evidence = selection(candle);
  return evidence ? {
    expectedAt: new Date(launchMs).toISOString(),
    ...evidence,
    lagSeconds: round((candle.timestampMs - launchMs) / 1_000)
  } : null;
}

function targetSelection(candle, expectedMs) {
  const evidence = selection(candle);
  return evidence ? {
    expectedAt: new Date(expectedMs).toISOString(),
    ...evidence,
    stalenessSeconds: round((expectedMs - candle.timestampMs) / 1_000)
  } : null;
}

function firstBaseline(candles, launchMs) {
  return candles.find((candle) => candle.candleStartMs >= launchMs) || null;
}

function lastAtOrBefore(candles, expectedMs, afterMs) {
  for (let index = candles.length - 1; index >= 0; index--) {
    const candle = candles[index];
    if (candle.timestampMs <= expectedMs && candle.timestampMs > afterMs) return candle;
  }
  return null;
}

function observedDrawdown(candles) {
  let peak = candles[0];
  let maximumPct = 0;
  let maximumPeak = peak;
  let maximumTrough = peak;
  for (const candle of candles.slice(1)) {
    if (candle.close > peak.close) {
      peak = candle;
      continue;
    }
    const drawdownPct = ((peak.close - candle.close) / peak.close) * 100;
    if (drawdownPct > maximumPct) {
      maximumPct = drawdownPct;
      maximumPeak = peak;
      maximumTrough = candle;
    }
  }
  return {
    basis: "observed-completed-candle-closes-only",
    sampleCount: candles.length,
    maximumPct: round(maximumPct),
    peak: publicCandle(maximumPeak),
    trough: publicCandle(maximumTrough)
  };
}

function unavailableWindow(expectedMs, reason, baseline, candidate = null, calculatedAt = null) {
  const observed = targetSelection(candidate, expectedMs);
  return {
    status: "unavailable",
    calculatedAt,
    expectedAt: new Date(expectedMs).toISOString(),
    candleStartAt: observed?.candleStartAt || null,
    candleEndAt: observed?.candleEndAt || null,
    observedAt: observed?.observedAt || null,
    fetchedAt: observed?.fetchedAt || null,
    stalenessSeconds: observed?.stalenessSeconds ?? null,
    source: observed?.source || null,
    pool: observed?.pool || null,
    intervalSeconds: observed?.intervalSeconds ?? null,
    returnPct: null,
    maximumDrawdownPct: null,
    reason,
    evidence: { baseline, target: observed, drawdown: null }
  };
}

function assertAllowedObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${label} contains an unsupported field: ${unknown}`);
}

function assertCandleFields(value, label) {
  if (value == null) return;
  assertAllowedObject(value, CANDLE_KEYS, label);
  const hasIdentity = value.source !== null && value.source !== undefined
    || value.pool !== null && value.pool !== undefined || value.intervalSeconds !== null && value.intervalSeconds !== undefined;
  if (hasIdentity && (typeof value.source !== "string" || typeof value.pool !== "string"
    || !Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 1)) {
    throw new TypeError(`${label} must keep source, pool, and interval identity together`);
  }
  const hasCompletedCandleFields = [value.candleStartAt, value.candleEndAt, value.fetchedAt]
    .some((item) => item !== null && item !== undefined);
  if (hasCompletedCandleFields) {
    const startMs = Date.parse(value.candleStartAt);
    const endMs = Date.parse(value.candleEndAt);
    const observedMs = Date.parse(value.observedAt);
    const fetchedMs = Date.parse(value.fetchedAt);
    if (![startMs, endMs, observedMs, fetchedMs].every(Number.isFinite)
      || !Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 1
      || startMs + value.intervalSeconds * 1_000 !== observedMs || endMs !== observedMs || fetchedMs < observedMs) {
      throw new RangeError(`${label} has inconsistent completed-candle timestamps`);
    }
  }
}

function assertOutcomeScalarTypes(value, label = "outcome") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item !== null && typeof item === "object") assertOutcomeScalarTypes(item, `${label}[${index}]`);
      else if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string or object`);
    });
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must be structured outcome data`);
  for (const [key, child] of Object.entries(value)) {
    const childLabel = `${label}.${key}`;
    if (child === null) continue;
    if (OUTCOME_TIMESTAMP_FIELDS.has(key)) {
      normalizeTimestamp(child, childLabel);
    } else if (OUTCOME_INTEGER_FIELDS.has(key)) {
      if (!Number.isSafeInteger(child) || child < 0) throw new TypeError(`${childLabel} must be a non-negative integer`);
    } else if (OUTCOME_NUMBER_FIELDS.has(key)) {
      if (typeof child !== "number" || !Number.isFinite(child)) throw new TypeError(`${childLabel} must be finite numeric data`);
      if (["close", "volume"].includes(key) && child <= 0) throw new RangeError(`${childLabel} must be positive`);
      if (["lagSeconds", "stalenessSeconds", "maximumDrawdownPct", "maximumPct"].includes(key) && child < 0) {
        throw new RangeError(`${childLabel} must be non-negative`);
      }
      if (["maximumDrawdownPct", "maximumPct"].includes(key) && child > 100) {
        throw new RangeError(`${childLabel} must not exceed 100`);
      }
    } else if (OUTCOME_BOOLEAN_FIELDS.has(key)) {
      if (typeof child !== "boolean") throw new TypeError(`${childLabel} must be boolean`);
    } else if (OUTCOME_STRING_FIELDS.has(key)) {
      if (typeof child !== "string" || child.trim() === "" || CONTROL_CHARACTERS.test(child)) {
        throw new TypeError(`${childLabel} must be a non-empty string without control characters`);
      }
    } else if (typeof child === "object") {
      assertOutcomeScalarTypes(child, childLabel);
    } else {
      throw new TypeError(`${childLabel} has no supported scalar contract`);
    }
  }
}

function assertGeckoTerminalIdentity(value, label = "outcome") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertGeckoTerminalIdentity(item, `${label}[${index}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "source" && child !== null && child !== "geckoterminal") {
      throw new RangeError(`${label}.source must be geckoterminal`);
    }
    if (key === "pool" && child !== null && !SOLANA_ADDRESS.test(child)) {
      throw new RangeError(`${label}.pool must be a Solana base58 address`);
    }
    if (key === "intervalSeconds" && child !== null && child !== 60) {
      throw new RangeError(`${label}.intervalSeconds must be 60`);
    }
    assertGeckoTerminalIdentity(child, `${label}.${key}`);
  }
}

function assertOutcomeFields(outcome, index) {
  const label = `outcomes[${index}]`;
  assertAllowedObject(outcome, OUTCOME_KEYS, label);
  if (outcome.series !== null) assertAllowedObject(outcome.series, SERIES_KEYS, `${label}.series`);
  assertAllowedObject(outcome.baseline, BASELINE_KEYS, `${label}.baseline`);
  assertCandleFields(outcome.baseline.candidate, `${label}.baseline.candidate`);
  assertAllowedObject(outcome.observationCounts, OBSERVATION_COUNT_KEYS, `${label}.observationCounts`);
  assertAllowedObject(outcome.windows, new Set(OUTCOME_HORIZONS), `${label}.windows`);
  for (const { key } of HORIZONS) {
    const window = outcome.windows[key];
    assertAllowedObject(window, WINDOW_KEYS, `${label}.windows.${key}`);
    assertAllowedObject(window.evidence, WINDOW_EVIDENCE_KEYS, `${label}.windows.${key}.evidence`);
    assertCandleFields(window.evidence.baseline, `${label}.windows.${key}.evidence.baseline`);
    assertCandleFields(window.evidence.target, `${label}.windows.${key}.evidence.target`);
    if (window.evidence.drawdown !== null) {
      assertAllowedObject(window.evidence.drawdown, DRAWDOWN_KEYS, `${label}.windows.${key}.evidence.drawdown`);
      assertCandleFields(window.evidence.drawdown.peak, `${label}.windows.${key}.evidence.drawdown.peak`);
      assertCandleFields(window.evidence.drawdown.trough, `${label}.windows.${key}.evidence.drawdown.trough`);
    }
  }
  if (outcome.poolSelection !== undefined) assertAllowedObject(outcome.poolSelection, POOL_SELECTION_KEYS, `${label}.poolSelection`);
  if (outcome.revisionHistory !== undefined) {
    if (!Array.isArray(outcome.revisionHistory)) throw new TypeError(`${label}.revisionHistory must be an array`);
    outcome.revisionHistory.forEach((entry, revisionIndex) => assertAllowedObject(entry, REVISION_KEYS, `${label}.revisionHistory[${revisionIndex}]`));
  }
  if (outcome.missingData !== undefined) assertAllowedObject(outcome.missingData, MISSING_DATA_KEYS, `${label}.missingData`);
  assertOutcomeScalarTypes(outcome, label);
}

export function calculateVerifiedOutcome({
  launchAt,
  asOf,
  candles,
  maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
  maxBaselineLagMs = DEFAULT_MAX_BASELINE_LAG_MS
} = {}) {
  const launch = normalizeTimestamp(launchAt, "launchAt");
  const snapshot = normalizeTimestamp(asOf, "asOf");
  if (snapshot.timestampMs < launch.timestampMs) throw new RangeError("asOf must not be before launchAt");
  const stalenessLimit = normalizeMilliseconds(maxStalenessMs, "maxStalenessMs");
  const baselineLagLimit = normalizeMilliseconds(maxBaselineLagMs, "maxBaselineLagMs");
  if (baselineLagLimit > DEFAULT_MAX_BASELINE_LAG_MS) {
    throw new RangeError(`maxBaselineLagMs must not exceed ${DEFAULT_MAX_BASELINE_LAG_MS}`);
  }
  const normalized = normalizeCandles(candles);
  const available = normalized.filter((candle) => candle.timestampMs <= snapshot.timestampMs && candle.fetchedAtMs <= snapshot.timestampMs);
  const baselineCandidate = firstBaseline(available, launch.timestampMs);
  const baselineLagMs = baselineCandidate ? baselineCandidate.timestampMs - launch.timestampMs : null;
  const baselineObserved = baselineCandidate && baselineLagMs <= baselineLagLimit;
  const baselineReason = baselineObserved ? null : baselineCandidate ? "baseline-observation-stale" : "baseline-missing";
  const baselineEvidence = baselineSelection(baselineCandidate, launch.timestampMs);
  const baseline = baselineObserved
    ? { status: "observed", ...baselineEvidence, reason: null }
    : {
        status: "unavailable",
        expectedAt: launch.observedAt,
        candleStartAt: baselineEvidence?.candleStartAt || null,
        candleEndAt: baselineEvidence?.candleEndAt || null,
        observedAt: baselineEvidence?.observedAt || null,
        fetchedAt: baselineEvidence?.fetchedAt || null,
        lagSeconds: baselineEvidence?.lagSeconds ?? null,
        close: null,
        volume: null,
        nonempty: baselineEvidence ? true : null,
        source: baselineEvidence?.source || null,
        pool: baselineEvidence?.pool || null,
        intervalSeconds: baselineEvidence?.intervalSeconds ?? null,
        reason: baselineReason,
        candidate: baselineEvidence
      };

  let observedCount = 0;
  const windows = Object.fromEntries(HORIZONS.map(({ key, offsetMs }) => {
    const expectedMs = launch.timestampMs + offsetMs;
    if (!baselineObserved) return [key, unavailableWindow(expectedMs, baselineReason, null, null, snapshot.observedAt)];
    if (snapshot.timestampMs < expectedMs) return [key, unavailableWindow(expectedMs, "window-not-mature", baselineEvidence, null, snapshot.observedAt)];
    const candidate = lastAtOrBefore(available, expectedMs, baselineCandidate.timestampMs);
    if (!candidate) return [key, unavailableWindow(expectedMs, "target-observation-missing", baselineEvidence, null, snapshot.observedAt)];
    if (expectedMs - candidate.timestampMs > stalenessLimit) {
      return [key, unavailableWindow(expectedMs, "target-observation-stale", baselineEvidence, candidate, snapshot.observedAt)];
    }
    const target = targetSelection(candidate, expectedMs);
    const priceRatio = candidate.close / baselineCandidate.close;
    if (!Number.isFinite(priceRatio) || priceRatio <= 0) {
      return [key, unavailableWindow(expectedMs, "return-calculation-out-of-range", baselineEvidence, candidate, snapshot.observedAt)];
    }
    const path = available.filter((candle) => candle.timestampMs >= baselineCandidate.timestampMs && candle.timestampMs <= candidate.timestampMs);
    const drawdown = observedDrawdown(path);
    observedCount++;
    return [key, {
      status: "observed",
      calculatedAt: snapshot.observedAt,
      expectedAt: target.expectedAt,
      candleStartAt: target.candleStartAt,
      candleEndAt: target.candleEndAt,
      observedAt: target.observedAt,
      fetchedAt: target.fetchedAt,
      stalenessSeconds: target.stalenessSeconds,
      source: target.source,
      pool: target.pool,
      intervalSeconds: target.intervalSeconds,
      returnPct: round((priceRatio - 1) * 100),
      maximumDrawdownPct: drawdown.maximumPct,
      reason: null,
      evidence: { baseline: baselineEvidence, target, drawdown }
    }];
  }));

  return {
    schemaVersion: 1,
    algorithm: OUTCOME_ALGORITHM,
    revisionPolicy: OUTCOME_REVISION_POLICY,
    status: !baselineObserved
      ? "awaiting-baseline"
      : observedCount === HORIZONS.length
        ? "complete"
        : observedCount > 0
          ? "partial"
          : "awaiting-observations",
    basis: OUTCOME_BASIS,
    launchAt: launch.observedAt,
    asOf: snapshot.observedAt,
    maxStalenessMs: stalenessLimit,
    maxBaselineLagMs: baselineLagLimit,
    series: normalized[0]
      ? { source: normalized[0].source, pool: normalized[0].pool, intervalSeconds: normalized[0].intervalSeconds }
      : null,
    baseline: { ...baseline, role: "first-observed-baseline-reference-only; each window retains its own provider revision" },
    observationCounts: {
      supplied: candles.length,
      normalized: normalized.length,
      availableAsOf: available.length,
      beforeLaunch: available.filter((candle) => candle.timestampMs < launch.timestampMs).length,
      afterAsOf: normalized.filter((candle) => candle.timestampMs > snapshot.timestampMs || candle.fetchedAtMs > snapshot.timestampMs).length
    },
    windows
  };
}

function safeStateCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function safeProviderStatus(value) {
  const code = safeStateCode(value);
  return PROVIDER_STATE_STATUSES.has(code) ? code : null;
}

function safeProviderErrorCode(value) {
  const code = safeStateCode(value);
  return PROVIDER_ERROR_CODES.has(code) ? code : null;
}

function safeStateTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function providerMissingReason(state) {
  const status = safeProviderStatus(state?.status);
  const errorCode = safeProviderErrorCode(state?.errorCode);
  if (errorCode === "selection-window-missed") return "provider-selection-window-missed";
  if (["pool-unavailable", "not-found"].includes(errorCode) || status === "awaiting-pool") return "provider-pool-unavailable";
  if (errorCode === "rate-limited" || status === "rate-limited") return "provider-rate-limited";
  if (["token-mismatch", "invalid-response", "invalid-json", "provider-request-rejected"].includes(errorCode)
    || status === "invalid-response") return "provider-invalid-response";
  if (["provider-unavailable", "network-error", "timeout", "provider-http-error", "enrichment-failed"].includes(errorCode)
    || status === "degraded") return "provider-unavailable";
  if (status === "baseline-unavailable") return "provider-baseline-unavailable";
  if (["pool-selected", "awaiting-price", "observing", "complete"].includes(status)) return "provider-observation-pending";
  if (status === "queued") return "provider-admission-pending";
  return "provider-evidence-unavailable";
}

export function unavailableProviderOutcome({ launchAt, asOf, state = null } = {}) {
  const result = calculateVerifiedOutcome({ launchAt, asOf, candles: [] });
  const reason = providerMissingReason(state);
  const asOfMs = Date.parse(result.asOf);
  result.baseline.reason = reason;
  for (const { key } of HORIZONS) {
    const window = result.windows[key];
    window.reason = Date.parse(window.expectedAt) <= asOfMs ? reason : "window-not-mature";
  }
  result.missingData = {
    reason,
    providerStatus: safeProviderStatus(state?.status),
    providerErrorCode: safeProviderErrorCode(state?.errorCode),
    lastAttemptAt: safeStateTimestamp(state?.lastAttemptAt),
    nextAttemptAt: safeStateTimestamp(state?.nextAttemptAt),
    updatedAt: safeStateTimestamp(state?.updatedAt)
  };
  return result;
}

function validateOutcome(outcome, index) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || !outcome.windows || typeof outcome.windows !== "object") {
    throw new TypeError(`outcomes[${index}] must be a calculated outcome`);
  }
  assertOutcomeFields(outcome, index);
  if (outcome.schemaVersion !== 1 || outcome.algorithm !== OUTCOME_ALGORITHM || outcome.revisionPolicy !== OUTCOME_REVISION_POLICY || outcome.basis !== OUTCOME_BASIS
    || !OUTCOME_STATUSES.has(outcome.status)
    || !Number.isSafeInteger(outcome.maxStalenessMs) || outcome.maxStalenessMs < 0
    || !Number.isSafeInteger(outcome.maxBaselineLagMs) || outcome.maxBaselineLagMs < 0) {
    throw new TypeError(`outcomes[${index}] has an incompatible calculation policy`);
  }
  const launchMs = Date.parse(outcome.launchAt);
  const asOfMs = Date.parse(outcome.asOf);
  if (!Number.isFinite(launchMs) || !Number.isFinite(asOfMs) || asOfMs < launchMs
    || outcome.baseline?.role !== "first-observed-baseline-reference-only; each window retains its own provider revision") {
    throw new TypeError(`outcomes[${index}] has invalid calculation timestamps or baseline role`);
  }
  if (!["observed", "unavailable"].includes(outcome.baseline.status)
    || (outcome.baseline.status === "observed" && outcome.baseline.reason !== null)
    || (outcome.baseline.status === "unavailable" && !OUTCOME_MISSING_REASONS.has(outcome.baseline.reason))) {
    throw new TypeError(`outcomes[${index}] has invalid baseline availability evidence`);
  }
  if (outcome.baseline.expectedAt !== outcome.launchAt) {
    throw new TypeError(`outcomes[${index}] baseline expectedAt must equal launchAt`);
  }
  if (outcome.baseline.status === "observed") {
    const baselineStartMs = Date.parse(outcome.baseline.candleStartAt);
    const baselineObservedMs = Date.parse(outcome.baseline.observedAt);
    const baselineFetchedMs = Date.parse(outcome.baseline.fetchedAt);
    const baselineLagMs = baselineObservedMs - launchMs;
    if (![baselineStartMs, baselineObservedMs, baselineFetchedMs].every(Number.isFinite)
      || baselineStartMs < launchMs || baselineObservedMs !== baselineStartMs + outcome.baseline.intervalSeconds * 1_000
      || Date.parse(outcome.baseline.candleEndAt) !== baselineObservedMs || baselineFetchedMs < baselineObservedMs
      || baselineFetchedMs > asOfMs
      || baselineLagMs < 0 || baselineLagMs > outcome.maxBaselineLagMs
      || outcome.baseline.lagSeconds !== round(baselineLagMs / 1_000)
      || !outcome.series || outcome.baseline.source !== outcome.series.source || outcome.baseline.pool !== outcome.series.pool
      || outcome.baseline.intervalSeconds !== outcome.series.intervalSeconds
      || !((outcome.baseline.nonempty === true) || (outcome.baseline.close > 0 && outcome.baseline.volume > 0))) {
      throw new RangeError(`outcomes[${index}] baseline is not a bounded wholly post-launch completed candle`);
    }
  } else if (outcome.baseline.candidate !== null) {
    const candidate = outcome.baseline.candidate;
    const candidateStartMs = Date.parse(candidate.candleStartAt);
    const candidateObservedMs = Date.parse(candidate.observedAt);
    const candidateFetchedMs = Date.parse(candidate.fetchedAt);
    const candidateLagMs = candidateObservedMs - launchMs;
    const candidateNonempty = candidate.nonempty === true
      || (typeof candidate.close === "number" && candidate.close > 0
        && typeof candidate.volume === "number" && candidate.volume > 0);
    if (outcome.baseline.reason !== "baseline-observation-stale"
      || candidate.expectedAt !== outcome.launchAt
      || ![candidateStartMs, candidateObservedMs, candidateFetchedMs].every(Number.isFinite)
      || candidateStartMs < launchMs
      || candidateObservedMs !== candidateStartMs + candidate.intervalSeconds * 1_000
      || Date.parse(candidate.candleEndAt) !== candidateObservedMs
      || candidateFetchedMs < candidateObservedMs || candidateFetchedMs > asOfMs
      || candidateLagMs <= outcome.maxBaselineLagMs
      || candidate.lagSeconds !== round(candidateLagMs / 1_000)
      || !candidateNonempty
      || !outcome.series || candidate.source !== outcome.series.source || candidate.pool !== outcome.series.pool
      || candidate.intervalSeconds !== outcome.series.intervalSeconds
      || outcome.baseline.candleStartAt !== candidate.candleStartAt
      || outcome.baseline.candleEndAt !== candidate.candleEndAt
      || outcome.baseline.observedAt !== candidate.observedAt
      || outcome.baseline.fetchedAt !== candidate.fetchedAt
      || outcome.baseline.source !== candidate.source || outcome.baseline.pool !== candidate.pool
      || outcome.baseline.intervalSeconds !== candidate.intervalSeconds
      || outcome.baseline.lagSeconds !== candidate.lagSeconds
      || outcome.baseline.nonempty !== true
      || (outcome.baseline.close !== null && outcome.baseline.close !== undefined)
      || (outcome.baseline.volume !== null && outcome.baseline.volume !== undefined)) {
      throw new RangeError(`outcomes[${index}] unavailable baseline candidate is inconsistent`);
    }
  } else if ([outcome.baseline.candleStartAt, outcome.baseline.candleEndAt, outcome.baseline.observedAt,
    outcome.baseline.fetchedAt, outcome.baseline.lagSeconds, outcome.baseline.source, outcome.baseline.pool,
    outcome.baseline.intervalSeconds, outcome.baseline.close, outcome.baseline.volume, outcome.baseline.nonempty]
    .some((value) => value !== null && value !== undefined)) {
    throw new RangeError(`outcomes[${index}] unavailable baseline without a candidate must not retain candle provenance`);
  }
  for (const key of ["supplied", "normalized", "availableAsOf", "beforeLaunch", "afterAsOf"]) {
    if (!Number.isSafeInteger(outcome.observationCounts[key]) || outcome.observationCounts[key] < 0) {
      throw new TypeError(`outcomes[${index}].observationCounts.${key} is required`);
    }
  }
  if (outcome.observationCounts.normalized > outcome.observationCounts.supplied
    || outcome.observationCounts.availableAsOf > outcome.observationCounts.normalized
    || outcome.observationCounts.beforeLaunch > outcome.observationCounts.availableAsOf
    || outcome.observationCounts.afterAsOf > outcome.observationCounts.normalized
    || outcome.observationCounts.availableAsOf + outcome.observationCounts.afterAsOf !== outcome.observationCounts.normalized) {
    throw new RangeError(`outcomes[${index}] observation counts are inconsistent`);
  }
  if (outcome.missingData !== undefined) {
    if (!OUTCOME_MISSING_REASONS.has(outcome.missingData.reason)
      || (outcome.missingData.providerStatus !== null && !PROVIDER_STATE_STATUSES.has(outcome.missingData.providerStatus))
      || (outcome.missingData.providerErrorCode !== null && !PROVIDER_ERROR_CODES.has(outcome.missingData.providerErrorCode))
      || providerMissingReason({ status: outcome.missingData.providerStatus, errorCode: outcome.missingData.providerErrorCode }) !== outcome.missingData.reason
      || outcome.baseline.reason !== outcome.missingData.reason) {
      throw new TypeError(`outcomes[${index}].missingData is invalid`);
    }
  }
  if (outcome.revisionHistory !== undefined) {
    if (!Array.isArray(outcome.revisionHistory) || outcome.revisionHistory.length > 20) {
      throw new TypeError(`outcomes[${index}].revisionHistory must be a bounded array`);
    }
    for (const [revisionIndex, revision] of outcome.revisionHistory.entries()) {
      const lists = [revision?.changedWindows, revision?.missingWindows, revision?.newlyObservedWindows];
      if (!revision || typeof revision !== "object" || Array.isArray(revision)
        || revision.action !== "first-observed-per-window-provider-revisions-retained"
        || revision.windowRevisionPolicy !== OUTCOME_REVISION_POLICY
        || !Number.isFinite(Date.parse(revision.checkedAt)) || Date.parse(revision.checkedAt) < launchMs || Date.parse(revision.checkedAt) > asOfMs
        || lists.some((list) => !Array.isArray(list) || new Set(list).size !== list.length
          || list.some((key) => !OUTCOME_HORIZONS.includes(key)))) {
        throw new TypeError(`outcomes[${index}].revisionHistory[${revisionIndex}] is invalid`);
      }
    }
  }
  if (outcome.series !== null && (!outcome.series || typeof outcome.series.source !== "string"
    || typeof outcome.series.pool !== "string" || !Number.isSafeInteger(outcome.series.intervalSeconds))) {
    throw new TypeError(`outcomes[${index}] has invalid series evidence`);
  }
  let observedWindowCount = 0;
  for (const { key, offsetMs } of HORIZONS) {
    const window = outcome.windows[key];
    if (!window || !["observed", "unavailable"].includes(window.status)) {
      throw new TypeError(`outcomes[${index}].windows.${key} has an invalid status`);
    }
    if (typeof window.calculatedAt !== "string" || !Number.isFinite(Date.parse(window.calculatedAt))
      || Date.parse(window.calculatedAt) < launchMs || Date.parse(window.calculatedAt) > asOfMs) {
      throw new TypeError(`outcomes[${index}].windows.${key} must include its provider-revision calculation timestamp`);
    }
    const expectedMs = launchMs + offsetMs;
    if (window.expectedAt !== new Date(expectedMs).toISOString()) {
      throw new TypeError(`outcomes[${index}].windows.${key}.expectedAt must equal launchAt plus its horizon`);
    }
    if (window.status === "observed") {
      observedWindowCount++;
      const target = window.evidence?.target;
      const baseline = window.evidence?.baseline;
      const targetHasValues = typeof target?.close === "number" && Number.isFinite(target.close) && target.close > 0
        && typeof target?.volume === "number" && Number.isFinite(target.volume) && target.volume > 0;
      const targetHasDerivedProof = target?.nonempty === true && target.close === undefined && target.volume === undefined;
      const baselineStartMs = Date.parse(baseline?.candleStartAt);
      const baselineObservedMs = Date.parse(baseline?.observedAt);
      const targetObservedMs = Date.parse(target?.observedAt);
      const peakObservedMs = Date.parse(window.evidence?.drawdown?.peak?.observedAt);
      const troughObservedMs = Date.parse(window.evidence?.drawdown?.trough?.observedAt);
      if (typeof window.returnPct !== "number" || !Number.isFinite(window.returnPct)
        || typeof window.maximumDrawdownPct !== "number" || !Number.isFinite(window.maximumDrawdownPct)
        || window.maximumDrawdownPct < 0 || window.maximumDrawdownPct > 100
        || typeof window.observedAt !== "string" || typeof window.source !== "string" || typeof window.pool !== "string"
        || !Number.isSafeInteger(window.intervalSeconds) || window.evidence?.drawdown?.basis !== "observed-completed-candle-closes-only"
        || !Number.isSafeInteger(window.evidence?.drawdown?.sampleCount) || window.evidence.drawdown.sampleCount < 2
        || window.evidence.drawdown.maximumPct !== window.maximumDrawdownPct
        || !window.evidence.drawdown.peak || !window.evidence.drawdown.trough
        || !((window.evidence.drawdown.peak.nonempty === true)
          || (window.evidence.drawdown.peak.close > 0 && window.evidence.drawdown.peak.volume > 0))
        || !((window.evidence.drawdown.trough.nonempty === true)
          || (window.evidence.drawdown.trough.close > 0 && window.evidence.drawdown.trough.volume > 0))
        || !outcome.series || outcome.series.source !== window.source || outcome.series.pool !== window.pool
        || outcome.series.intervalSeconds !== window.intervalSeconds
        || !target || target.expectedAt !== window.expectedAt || target.observedAt !== window.observedAt
        || target.source !== window.source || target.pool !== window.pool || target.intervalSeconds !== window.intervalSeconds
        || target.candleStartAt !== window.candleStartAt || target.candleEndAt !== window.candleEndAt
        || target.fetchedAt !== window.fetchedAt || target.stalenessSeconds !== window.stalenessSeconds
        || typeof target.candleStartAt !== "string" || typeof target.fetchedAt !== "string"
        || (!targetHasValues && !targetHasDerivedProof)
        || window.reason !== null
        || !baseline || baseline.source !== window.source || baseline.pool !== window.pool
        || baseline.intervalSeconds !== window.intervalSeconds
        || baseline.expectedAt !== outcome.launchAt || baselineStartMs < launchMs
        || baselineObservedMs !== baselineStartMs + baseline.intervalSeconds * 1_000
        || baselineObservedMs - launchMs > outcome.maxBaselineLagMs
        || baseline.lagSeconds !== round((baselineObservedMs - launchMs) / 1_000)
        || !((baseline.nonempty === true) || (baseline.close > 0 && baseline.volume > 0))
        || Date.parse(window.calculatedAt) < Date.parse(baseline.fetchedAt)
        || targetObservedMs > expectedMs
        || target.stalenessSeconds !== round((expectedMs - targetObservedMs) / 1_000)
        || target.stalenessSeconds * 1_000 > outcome.maxStalenessMs
        || Date.parse(window.calculatedAt) < Date.parse(target.fetchedAt)
        || peakObservedMs < baselineObservedMs || peakObservedMs > targetObservedMs
        || troughObservedMs < peakObservedMs || troughObservedMs > targetObservedMs
        || Date.parse(window.evidence.drawdown.peak.fetchedAt) > Date.parse(window.calculatedAt)
        || Date.parse(window.evidence.drawdown.trough.fetchedAt) > Date.parse(window.calculatedAt)
        || window.evidence.drawdown.peak.source !== window.source || window.evidence.drawdown.peak.pool !== window.pool
        || window.evidence.drawdown.trough.source !== window.source || window.evidence.drawdown.trough.pool !== window.pool
        || window.evidence.drawdown.peak.intervalSeconds !== window.intervalSeconds
        || window.evidence.drawdown.trough.intervalSeconds !== window.intervalSeconds) {
        throw new RangeError(`outcomes[${index}].windows.${key} has invalid metrics`);
      }
    } else {
      const target = window.evidence?.target;
      const baseline = window.evidence?.baseline;
      const stateReason = outcome.missingData === undefined ? null
        : expectedMs <= asOfMs ? outcome.missingData.reason : "window-not-mature";
      const targetObservedMs = Date.parse(target?.observedAt);
      const targetStalenessSeconds = target === null ? null : round((expectedMs - targetObservedMs) / 1_000);
      const targetReason = target === null ? null
        : targetStalenessSeconds * 1_000 > outcome.maxStalenessMs
          ? "target-observation-stale" : "return-calculation-out-of-range";
      if (!OUTCOME_MISSING_REASONS.has(window.reason)
        || (stateReason !== null && window.reason !== stateReason)
        || (outcome.missingData === undefined && outcome.baseline.status === "unavailable"
          && window.reason !== outcome.baseline.reason)
        || window.returnPct !== null || window.maximumDrawdownPct !== null || window.evidence?.drawdown !== null
        || (baseline !== null && Date.parse(baseline.fetchedAt) > Date.parse(window.calculatedAt))
        || (target === null && [window.candleStartAt, window.candleEndAt, window.observedAt, window.fetchedAt,
          window.stalenessSeconds, window.source, window.pool, window.intervalSeconds].some((value) => value !== null))
        || (target === null && ["target-observation-stale", "return-calculation-out-of-range"].includes(window.reason))
        || (target !== null && (target.expectedAt !== window.expectedAt || target.observedAt !== window.observedAt
          || target.source !== window.source || target.pool !== window.pool || target.intervalSeconds !== window.intervalSeconds
          || target.candleStartAt !== window.candleStartAt || target.candleEndAt !== window.candleEndAt
          || target.fetchedAt !== window.fetchedAt || target.stalenessSeconds !== window.stalenessSeconds
          || targetObservedMs > expectedMs || target.stalenessSeconds !== targetStalenessSeconds
          || Date.parse(target.fetchedAt) > Date.parse(window.calculatedAt) || window.reason !== targetReason
          || !outcome.series || target.source !== outcome.series.source || target.pool !== outcome.series.pool
          || target.intervalSeconds !== outcome.series.intervalSeconds
          || !((target.nonempty === true) || (target.close > 0 && target.volume > 0))))) {
        throw new TypeError(`outcomes[${index}].windows.${key} must include consistent missing evidence`);
      }
    }
  }
  const expectedStatus = outcome.baseline.status !== "observed" ? "awaiting-baseline"
    : observedWindowCount === HORIZONS.length ? "complete"
      : observedWindowCount > 0 ? "partial" : "awaiting-observations";
  if (outcome.status !== expectedStatus) throw new TypeError(`outcomes[${index}] status disagrees with its windows`);
  if (outcome.observationCounts.retainedObservedWindows !== undefined
    && outcome.observationCounts.retainedObservedWindows !== observedWindowCount) {
    throw new RangeError(`outcomes[${index}] retainedObservedWindows disagrees with observed windows`);
  }
  return outcome;
}

function stripProviderValues(candle) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) return;
  if ((typeof candle.close === "number" && Number.isFinite(candle.close) && candle.close > 0)
    || (typeof candle.volume === "number" && Number.isFinite(candle.volume) && candle.volume > 0)) {
    candle.nonempty = true;
  }
  delete candle.close;
  delete candle.volume;
}

export function toDurableOutcomeRecord(outcome) {
  const durable = structuredClone(validateOutcome(outcome, 0));
  stripProviderValues(durable.baseline);
  stripProviderValues(durable.baseline?.candidate);
  for (const { key } of HORIZONS) {
    const window = durable.windows[key];
    stripProviderValues(window);
    stripProviderValues(window?.evidence?.baseline);
    stripProviderValues(window?.evidence?.target);
    stripProviderValues(window?.evidence?.drawdown?.peak);
    stripProviderValues(window?.evidence?.drawdown?.trough);
  }
  return durable;
}

export function validateProviderObservedOutcome(outcome, { requireProspectiveSelection = false } = {}) {
  const validated = validateOutcome(outcome, 0);
  const hasObserved = HORIZONS.some(({ key }) => validated.windows[key].status === "observed");
  if (requireProspectiveSelection) {
    assertGeckoTerminalIdentity(validated);
    if (validated.maxStalenessMs !== DEFAULT_MAX_STALENESS_MS
      || validated.maxBaselineLagMs !== DEFAULT_MAX_BASELINE_LAG_MS) {
      throw new RangeError("outcome provider lag policy must use the production 90s target and 120s baseline bounds");
    }
    const selectionEvidence = validated.poolSelection;
    if (hasObserved || selectionEvidence !== undefined) {
      const launchMs = Date.parse(validated.launchAt);
      const selectedMs = Date.parse(selectionEvidence?.selectedAt);
      const createdMs = Date.parse(selectionEvidence?.poolCreatedAt);
      if (selectionEvidence?.policy !== "prospective-earliest-created-eligible-pool-on-provider-ranked-page-1-within-2m"
        || (validated.series !== null && selectionEvidence?.source !== validated.series.source)
        || (validated.series !== null && selectionEvidence?.pool !== validated.series.pool)
        || selectionEvidence?.source !== "geckoterminal" || !SOLANA_ADDRESS.test(selectionEvidence?.pool)
        || selectionEvidence?.providerPage !== 1
        || !Number.isInteger(selectionEvidence?.providerRank) || selectionEvidence.providerRank < 1
        || !Number.isFinite(launchMs) || !Number.isFinite(selectedMs) || !Number.isFinite(createdMs)
        || selectedMs < launchMs || selectedMs > launchMs + 120_000
        || selectedMs < createdMs
        || createdMs < launchMs - 5 * 60_000 || createdMs > launchMs + 60_000) {
        throw new RangeError("outcome lacks valid prospective pool-selection evidence");
      }
    }
  }
  return toDurableOutcomeRecord(validated);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeWindow(outcomes, key, minimumEvidence, minimumCoverageRatio) {
  const observed = outcomes.map((outcome) => outcome.windows[key]).filter((window) => window.status === "observed");
  const missingReasons = new Map();
  for (const window of outcomes.map((outcome) => outcome.windows[key]).filter((window) => window.status === "unavailable")) {
    missingReasons.set(window.reason, (missingReasons.get(window.reason) || 0) + 1);
  }
  const coverageRatio = outcomes.length ? observed.length / outcomes.length : 0;
  const sufficient = observed.length >= minimumEvidence && coverageRatio >= minimumCoverageRatio;
  const hits = observed.filter((window) => window.returnPct > 0).length;
  const worstDrawdown = observed.reduce((worst, window) => !worst || window.maximumDrawdownPct > worst.maximumDrawdownPct ? window : worst, null);
  return {
    status: sufficient ? "sufficient-evidence" : "insufficient-evidence",
    minimumEvidence,
    minimumCoverageRatio,
    evidenceCount: observed.length,
    missingCount: outcomes.length - observed.length,
    coverageRatio: round(coverageRatio),
    missingReasons: Object.fromEntries([...missingReasons].sort(([left], [right]) => compareText(left, right))),
    hitDefinition: "returnPct > 0",
    hitCount: sufficient ? hits : null,
    hitRatePct: sufficient ? round((hits / observed.length) * 100) : null,
    medianReturnPct: sufficient ? round(median(observed.map((window) => window.returnPct))) : null,
    maximumDrawdownPct: sufficient ? round(worstDrawdown.maximumDrawdownPct) : null,
    maximumDrawdownSampleCount: sufficient ? worstDrawdown.evidence.drawdown.sampleCount : null,
    drawdownBasis: "maximum observed completed-candle-close drawdown; sparse samples may understate intraperiod drawdown"
  };
}

export function summarizeVerifiedOutcomes(outcomes, {
  minimumEvidence = DEFAULT_MINIMUM_EVIDENCE,
  minimumCoverageRatio = DEFAULT_MINIMUM_COVERAGE_RATIO
} = {}) {
  if (!Array.isArray(outcomes)) throw new TypeError("outcomes must be an array");
  const threshold = normalizeMinimumEvidence(minimumEvidence);
  const coverageThreshold = normalizeCoverageRatio(minimumCoverageRatio);
  const validated = outcomes.map(validateOutcome);
  const first = validated[0] || null;
  const sources = [...new Set(validated.map((outcome) => outcome.series?.source).filter(Boolean))];
  const intervals = [...new Set(validated.map((outcome) => outcome.series?.intervalSeconds).filter((value) => value != null))];
  if (first && (validated.some((outcome) => outcome.algorithm !== first.algorithm
    || outcome.revisionPolicy !== first.revisionPolicy || outcome.basis !== first.basis || outcome.maxStalenessMs !== first.maxStalenessMs
    || outcome.maxBaselineLagMs !== first.maxBaselineLagMs)
    || sources.length > 1 || intervals.length > 1)) {
    throw new RangeError("outcomes must use one calculation, source, interval, and lag policy");
  }
  const policy = first ? {
    algorithm: first.algorithm,
    revisionPolicy: first.revisionPolicy,
    basis: first.basis,
    maxStalenessMs: first.maxStalenessMs,
    maxBaselineLagMs: first.maxBaselineLagMs,
    source: sources[0] || null,
    intervalSeconds: intervals[0] ?? null
  } : null;
  return {
    schemaVersion: 1,
    outcomeCount: validated.length,
    minimumEvidence: threshold,
    minimumCoverageRatio: coverageThreshold,
    policy,
    windows: Object.fromEntries(HORIZONS.map(({ key }) => [key, summarizeWindow(validated, key, threshold, coverageThreshold)]))
  };
}

export function aggregateOutcomeCohorts(entries, {
  minimumEvidence = DEFAULT_MINIMUM_EVIDENCE,
  minimumCoverageRatio = DEFAULT_MINIMUM_COVERAGE_RATIO
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const threshold = normalizeMinimumEvidence(minimumEvidence);
  const coverageThreshold = normalizeCoverageRatio(minimumCoverageRatio);
  const grouped = new Map();
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`entries[${index}] must be an object`);
    const cohort = normalizeLabel(entry.cohort, `entries[${index}].cohort`);
    const outcome = validateOutcome(entry.outcome, index);
    const values = grouped.get(cohort) || [];
    values.push(outcome);
    grouped.set(cohort, values);
  });
  const cohorts = [...grouped].sort(([left], [right]) => compareText(left, right)).map(([cohort, outcomes]) => {
    const summary = summarizeVerifiedOutcomes(outcomes, { minimumEvidence: threshold, minimumCoverageRatio: coverageThreshold });
    return { cohort, outcomeCount: outcomes.length, policy: summary.policy, windows: summary.windows };
  });
  return {
    schemaVersion: 1,
    minimumEvidence: threshold,
    minimumCoverageRatio: coverageThreshold,
    outcomeCount: entries.length,
    cohortCount: cohorts.length,
    cohorts
  };
}
