import { createHmac } from "node:crypto";

export const EARLY_ACTOR_SCHEMA_VERSION = 1;
export const EARLY_ACTOR_METHOD_VERSION = "early-actor-keyed-label-v1";
export const EARLY_ACTOR_SOURCE = "pumpportal";
export const EARLY_ACTOR_EVIDENCE_CLASS = "feed-observed-processed";
export const EARLY_ACTOR_RPC_SOURCE = "solana-mainnet-rpc";
export const EARLY_ACTOR_RPC_EVIDENCE_CLASS = "on-chain-finalized";

export const EARLY_ACTOR_SOURCES = Object.freeze({
  [EARLY_ACTOR_SOURCE]: Object.freeze({
    evidenceClass: EARLY_ACTOR_EVIDENCE_CLASS,
    inputContract: "pumpportal-compatible-input"
  }),
  [EARLY_ACTOR_RPC_SOURCE]: Object.freeze({
    evidenceClass: EARLY_ACTOR_RPC_EVIDENCE_CLASS,
    inputContract: "finalized-solana-observation"
  })
});

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_PATTERN = MINT_PATTERN;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/;
const MAX_SECRET_BYTES = 4_096;
const MAX_OBSERVED_MINTS = 50_000;
const MAX_RETAINED_EVENTS = 100_000;
const MAX_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;
const DEFAULTS = Object.freeze({
  maxEvents: 5_000,
  maxAgeMs: 24 * 60 * 60 * 1_000,
  maxNativeAmount: 1_000_000,
  maxTokenAmount: 1_000_000_000_000_000,
  maxFutureSkewMs: 5 * 60 * 1_000,
  minimumEventCount: 5,
  minimumActorCount: 3,
  minimumSourceTimestampRatio: 0,
  burstWindowMs: 60_000,
  earlyWindowMs: 5 * 60_000
});

export class EarlyActorError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "EarlyActorError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new EarlyActorError(code, message, { cause });
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return structuredClone(value);
}

function requireBase58(value, label, pattern, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(normalized)) fail(code, `${label} must be a bounded base58 value`);
  return normalized;
}

function requireMint(value, label = "mint") {
  return requireBase58(value, label, MINT_PATTERN, "invalid-mint");
}

function requireAddress(value, label = "actor address") {
  return requireBase58(value, label, ADDRESS_PATTERN, "invalid-actor-address");
}

function requireTransactionId(value, label = "transaction ID") {
  return requireBase58(value, label, SIGNATURE_PATTERN, "invalid-transaction-provenance");
}

function parseRfc3339(value, label) {
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) fail("invalid-timestamp", `${label} must be an RFC 3339 timestamp with an explicit timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText
  ].map(Number);
  const civil = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const validCivilTime = year >= 1
    && civil.getUTCFullYear() === year
    && civil.getUTCMonth() === month - 1
    && civil.getUTCDate() === day
    && civil.getUTCHours() === hour
    && civil.getUTCMinutes() === minute
    && civil.getUTCSeconds() === second;
  const validZone = zone === "Z" || (() => {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    return hours <= 14 && minutes <= 59 && (hours < 14 || minutes === 0);
  })();
  if (!validCivilTime || !validZone) fail("invalid-timestamp", `${label} is not a real RFC 3339 timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("invalid-timestamp", `${label} is not a real timestamp`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function parseTimestamp(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("invalid-timestamp", `${label} must be a non-negative Unix timestamp or RFC 3339 timestamp`);
    }
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    if (!Number.isSafeInteger(milliseconds)) fail("invalid-timestamp", `${label} is outside the supported range`);
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) fail("invalid-timestamp", `${label} is outside the supported range`);
    return { iso: date.toISOString(), milliseconds };
  }
  return parseRfc3339(value, label);
}

function optionalSourceTimestamp(frame) {
  const value = Object.hasOwn(frame, "sourceTimestamp") ? frame.sourceTimestamp : frame.timestamp;
  if (value === undefined || value === null || value === "") return null;
  return parseTimestamp(value, "source timestamp");
}

function boundedAmount(value, label, maximum) {
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && value.length <= 48) {
    const normalized = value.trim();
    if (!DECIMAL.test(normalized)) fail("invalid-amount", `${label} must be a bounded decimal amount`);
    number = Number(normalized);
  } else {
    fail("invalid-amount", `${label} must be a bounded numeric amount`);
  }
  if (!Number.isFinite(number) || number < 0 || number > maximum) {
    fail("invalid-amount", `${label} must be between 0 and its configured maximum`);
  }
  return Object.is(number, -0) ? 0 : number;
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("invalid-config", `${label} must be a positive bounded integer`);
  }
  return value;
}

function nonNegativeInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid-config", `${label} must be a non-negative bounded integer`);
  }
  return value;
}

function optionalSlot(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail("invalid-slot", "slot is required for finalized Solana observations");
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid-slot", "slot must be a non-negative safe integer");
  }
  return value;
}

function positiveNumber(value, label, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    fail("invalid-config", `${label} must be a positive bounded number`);
  }
  return value;
}

function ratio(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("invalid-config", `${label} must be between 0 and 1`);
  }
  return value;
}

function installationSecret(value) {
  let secret;
  if (typeof value === "string") secret = Buffer.from(value, "utf8");
  else if (Buffer.isBuffer(value) || value instanceof Uint8Array) secret = Buffer.from(value);
  else fail("invalid-secret", "installation secret must be private byte material");
  if (secret.length < 32 || secret.length > MAX_SECRET_BYTES) {
    secret.fill(0);
    fail("invalid-secret", "installation secret must contain between 32 and 4096 bytes");
  }
  return secret;
}

function observedMintSet(value) {
  if (typeof value === "string" || value == null || typeof value[Symbol.iterator] !== "function") {
    fail("invalid-config", "observedMints must be an iterable of exact mint addresses");
  }
  const mints = new Set();
  for (const item of value) {
    if (mints.size >= MAX_OBSERVED_MINTS) fail("invalid-config", "observedMints exceeds the configured bound");
    mints.add(requireMint(item, "observed mint"));
  }
  return mints;
}

function mintCreationTimes(value, observedMints) {
  if (value === undefined || value === null) return new Map();
  const entries = value instanceof Map
    ? [...value.entries()]
    : plainObject(value) ? Object.entries(value) : null;
  if (!entries) fail("invalid-config", "mintCreatedAt must be a map or object keyed by exact observed mint");
  const result = new Map();
  for (const [rawMint, rawTimestamp] of entries) {
    const mint = requireMint(rawMint, "mintCreatedAt mint");
    if (!observedMints.has(mint)) {
      fail("invalid-config", "mintCreatedAt contains a mint outside observedMints");
    }
    result.set(mint, parseTimestamp(rawTimestamp, "token creation timestamp"));
  }
  return result;
}

function configuration(options = {}) {
  if (!plainObject(options)) fail("invalid-config", "options must be an object");
  const observedMints = observedMintSet(options.observedMints);
  const mintCreatedAt = mintCreationTimes(options.mintCreatedAt, observedMints);
  const secret = installationSecret(options.installationSecret);
  try {
    const config = {
      secret,
      observedMints,
      mintCreatedAt,
      maxEvents: positiveInteger(options.maxEvents ?? DEFAULTS.maxEvents, "maxEvents", MAX_RETAINED_EVENTS),
      maxAgeMs: positiveInteger(options.maxAgeMs ?? DEFAULTS.maxAgeMs, "maxAgeMs", MAX_RETENTION_MS),
      maxNativeAmount: positiveNumber(
        options.maxNativeAmount ?? options.maxSolAmount ?? DEFAULTS.maxNativeAmount,
        "maxNativeAmount",
        Number.MAX_SAFE_INTEGER
      ),
      maxTokenAmount: positiveNumber(
        options.maxTokenAmount ?? DEFAULTS.maxTokenAmount,
        "maxTokenAmount",
        Number.MAX_SAFE_INTEGER
      ),
      maxFutureSkewMs: nonNegativeInteger(
        options.maxFutureSkewMs ?? DEFAULTS.maxFutureSkewMs,
        "maxFutureSkewMs",
        24 * 60 * 60 * 1_000
      ),
      minimumEventCount: positiveInteger(
        options.minimumEventCount ?? DEFAULTS.minimumEventCount,
        "minimumEventCount",
        MAX_RETAINED_EVENTS
      ),
      minimumActorCount: positiveInteger(
        options.minimumActorCount ?? DEFAULTS.minimumActorCount,
        "minimumActorCount",
        MAX_RETAINED_EVENTS
      ),
      minimumSourceTimestampRatio: ratio(
        options.minimumSourceTimestampRatio ?? DEFAULTS.minimumSourceTimestampRatio,
        "minimumSourceTimestampRatio"
      ),
      burstWindowMs: positiveInteger(
        options.burstWindowMs ?? DEFAULTS.burstWindowMs,
        "burstWindowMs",
        MAX_RETENTION_MS
      ),
      earlyWindowMs: positiveInteger(
        options.earlyWindowMs ?? DEFAULTS.earlyWindowMs,
        "earlyWindowMs",
        MAX_RETENTION_MS
      )
    };
    if (config.minimumEventCount > config.maxEvents) {
      fail("invalid-config", "minimumEventCount cannot exceed maxEvents");
    }
    if (config.minimumActorCount > config.minimumEventCount) {
      fail("invalid-config", "minimumActorCount cannot exceed minimumEventCount");
    }
    return config;
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

function keyedValue(secret, domain, ...parts) {
  const hmac = createHmac("sha256", secret);
  hmac.update("pump-war-room/early-actors\0");
  hmac.update(EARLY_ACTOR_METHOD_VERSION);
  hmac.update("\0");
  hmac.update(domain);
  for (const part of parts) {
    const value = String(part);
    hmac.update("\0");
    hmac.update(String(Buffer.byteLength(value, "utf8")));
    hmac.update(":");
    hmac.update(value);
  }
  return hmac.digest();
}

function opaqueLabel(secret, domain, prefix, value) {
  const digest = keyedValue(secret, domain, value);
  const number = (digest.readBigUInt64BE(0) & 0x7fffffffffffffffn) + 1n;
  digest.fill(0);
  return `${prefix} ${number}`;
}

export function createActorLabel(value, options = {}) {
  if (!plainObject(options)) fail("invalid-config", "actor label options must be an object");
  const address = requireAddress(value);
  const secret = installationSecret(options.installationSecret);
  try {
    return opaqueLabel(secret, "actor-label", "Actor", address);
  } finally {
    secret.fill(0);
  }
}

function privateKey(secret, domain, ...parts) {
  const digest = keyedValue(secret, domain, ...parts);
  const key = digest.toString("base64url");
  digest.fill(0);
  return key;
}

function normalizeSide(value) {
  const side = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (side !== "buy" && side !== "sell") fail("invalid-side", "txType must be buy or sell");
  return side;
}

function normalizeSource(value, frame) {
  if (value === undefined || value === null || value === "") {
    if (Object.hasOwn(frame, "traderPublicKey") || Object.hasOwn(frame, "signature")) {
      return EARLY_ACTOR_SOURCE;
    }
    fail("unsupported-source", "source must identify an allowlisted early-actor input contract");
  }
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.hasOwn(EARLY_ACTOR_SOURCES, source)) {
    fail("unsupported-source", "source must identify an allowlisted early-actor input contract");
  }
  return source;
}

function validateEvidenceClass(value, source) {
  const expected = EARLY_ACTOR_SOURCES[source].evidenceClass;
  if (value === undefined && source === EARLY_ACTOR_SOURCE) return expected;
  if (value !== expected) {
    fail("invalid-evidence-class", "evidenceClass must match the allowlisted source contract");
  }
  return expected;
}

function normalizeInternal(frame, config, observedAtValue) {
  if (!plainObject(frame)) fail("invalid-event", "trade event must be an object");
  const mint = requireMint(frame.mint);
  if (!config.observedMints.has(mint)) {
    fail("mint-not-observed", "trade mint is outside the exact observed-mint allowlist");
  }
  const source = normalizeSource(frame.source, frame);
  const evidenceClass = validateEvidenceClass(frame.evidenceClass, source);
  const finalizedRpc = source === EARLY_ACTOR_RPC_SOURCE;
  const address = requireAddress(
    finalizedRpc ? frame.actorAddress : frame.traderPublicKey,
    finalizedRpc ? "actorAddress" : "traderPublicKey"
  );
  const transactionId = requireTransactionId(
    finalizedRpc ? frame.transactionId : frame.signature,
    finalizedRpc ? "transactionId" : "signature"
  );
  const side = normalizeSide(finalizedRpc ? frame.side : frame.txType ?? frame.side);
  const nativeInput = finalizedRpc ? frame.nativeAmount : frame.solAmount;
  const native = finalizedRpc && (nativeInput === null || nativeInput === undefined || nativeInput === "")
    ? null
    : boundedAmount(nativeInput, finalizedRpc ? "nativeAmount" : "solAmount", config.maxNativeAmount);
  const token = boundedAmount(frame.tokenAmount, "tokenAmount", config.maxTokenAmount);
  if (token === 0) fail("invalid-amount", "tokenAmount must be greater than zero");
  const slot = optionalSlot(frame.slot, { required: finalizedRpc });
  const observedAt = parseTimestamp(observedAtValue ?? frame.observedAt, "observation timestamp");
  const sourceTimestamp = optionalSourceTimestamp(frame);
  if (sourceTimestamp && sourceTimestamp.milliseconds > observedAt.milliseconds + config.maxFutureSkewMs) {
    fail("invalid-timestamp", "source timestamp is beyond the configured observation-time tolerance");
  }

  const actor = opaqueLabel(config.secret, "actor-label", "Actor", address);
  const event = {
    schemaVersion: EARLY_ACTOR_SCHEMA_VERSION,
    mint,
    actor,
    side,
    amounts: { native, token },
    source: {
      name: source,
      evidenceClass
    },
    timestamps: {
      source: sourceTimestamp
        ? { state: "available", value: sourceTimestamp.iso }
        : { state: "missing", value: null },
      observedAt: observedAt.iso
    },
    transactionProvenance: {
      state: "internal-only",
      evidenceClass: "locally-derived",
      slot: slot === null
        ? { state: "missing", value: null }
        : { state: "available", value: slot }
    }
  };
  const dedupeKey = privateKey(config.secret, "event-dedupe", source, mint, transactionId, address);
  const integrityKey = privateKey(
    config.secret,
    "event-integrity",
    source,
    mint,
    transactionId,
    address,
    side,
    native ?? "missing",
    token,
    slot ?? "missing",
    sourceTimestamp?.iso ?? "missing"
  );
  return { event, dedupeKey, integrityKey, observedAtMs: observedAt.milliseconds };
}

export function normalizeEarlyActorTrade(frame, options = {}) {
  const config = configuration(options);
  try {
    return clone(normalizeInternal(frame, config, options.observedAt).event);
  } finally {
    config.secret.fill(0);
  }
}

function eventOrder(left, right) {
  const leftAt = Date.parse(left.timestamps.source?.state === "available" ? left.timestamps.source.value : left.timestamps.observedAt);
  const rightAt = Date.parse(right.timestamps.source?.state === "available" ? right.timestamps.source.value : right.timestamps.observedAt);
  return leftAt - rightAt
    || Date.parse(left.timestamps.observedAt) - Date.parse(right.timestamps.observedAt)
    || lexical(left.actor, right.actor)
    || lexical(left.side, right.side)
    || lexical(left.source.name, right.source.name)
    || (left.transactionProvenance.slot.value ?? -1) - (right.transactionProvenance.slot.value ?? -1)
    || (left.amounts.native ?? -1) - (right.amounts.native ?? -1)
    || left.amounts.token - right.amounts.token;
}

function activityTimestamp(event) {
  return Date.parse(event.timestamps.source?.state === "available"
    ? event.timestamps.source.value
    : event.timestamps.observedAt);
}

function activityTimestampBasis(events) {
  const sourceCount = events.filter((event) => event.timestamps.source?.state === "available").length;
  return sourceCount === events.length ? "source-timestamp"
    : sourceCount === 0 ? "observation-timestamp"
      : "source-timestamp-when-available-otherwise-observation-timestamp";
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function timestampCoverage(events) {
  const availableCount = events.reduce(
    (count, event) => count + Number(event.timestamps.source.state === "available"),
    0
  );
  const ratioValue = events.length === 0 ? 0 : availableCount / events.length;
  const state = availableCount === 0 ? "missing" : availableCount === events.length ? "available" : "partial";
  return {
    state,
    availableCount,
    missingCount: events.length - availableCount,
    ratio: round(ratioValue)
  };
}

function holdingDurationEvidence(events) {
  const unmatchedBuys = new Map();
  const durations = [];
  for (const event of events) {
    const at = activityTimestamp(event);
    if (event.side === "buy") {
      const queue = unmatchedBuys.get(event.actor) || [];
      queue.push(at);
      unmatchedBuys.set(event.actor, queue);
      continue;
    }
    const queue = unmatchedBuys.get(event.actor);
    if (!queue?.length || queue[0] >= at) continue;
    durations.push(at - queue.shift());
  }
  if (durations.length === 0) {
    return {
      state: "missing",
      basis: "validated-buy-to-subsequent-sell",
      timestampBasis: activityTimestampBasis(events),
      pairedObservationCount: 0,
      minimumMs: null,
      medianMs: null,
      maximumMs: null
    };
  }
  return {
    state: "available",
    basis: "validated-buy-to-subsequent-sell",
    timestampBasis: activityTimestampBasis(events),
    pairedObservationCount: durations.length,
    minimumMs: durations.reduce((minimum, value) => Math.min(minimum, value), Infinity),
    medianMs: median(durations),
    maximumMs: durations.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
  };
}

function concentration(events) {
  const byActor = new Map();
  let total = 0;
  for (const event of events) {
    total += event.amounts.token;
    byActor.set(event.actor, (byActor.get(event.actor) || 0) + event.amounts.token);
  }
  if (total <= 0) {
    return {
      state: "missing",
      basis: "observed-token-amount-not-holdings",
      amountCoverage: { state: "missing", availableCount: 0, missingCount: events.length },
      actorCountWithAmount: 0,
      largestActorShare: null,
      largestThreeActorShare: null
    };
  }
  const amounts = [...byActor.values()].filter((amount) => amount > 0).sort((left, right) => right - left);
  return {
    state: "available",
    basis: "observed-token-amount-not-holdings",
    amountCoverage: { state: "available", availableCount: events.length, missingCount: 0 },
    actorCountWithAmount: amounts.length,
    largestActorShare: round(amounts[0] / total),
    largestThreeActorShare: round(amounts.slice(0, 3).reduce((sum, amount) => sum + amount, 0) / total)
  };
}

function activityBurst(events, windowMs) {
  let left = 0;
  let best = null;
  const actorCounts = new Map();
  for (let right = 0; right < events.length; right += 1) {
    const actor = events[right].actor;
    actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
    const rightAt = activityTimestamp(events[right]);
    while (rightAt - activityTimestamp(events[left]) > windowMs) {
      const leaving = events[left].actor;
      const remaining = actorCounts.get(leaving) - 1;
      if (remaining === 0) actorCounts.delete(leaving);
      else actorCounts.set(leaving, remaining);
      left += 1;
    }
    const candidate = {
      eventCount: right - left + 1,
      uniqueActorCount: actorCounts.size,
      startedAt: new Date(activityTimestamp(events[left])).toISOString(),
      endedAt: new Date(activityTimestamp(events[right])).toISOString()
    };
    if (!best
      || candidate.eventCount > best.eventCount
      || (candidate.eventCount === best.eventCount && candidate.uniqueActorCount > best.uniqueActorCount)) {
      best = candidate;
    }
  }
  return {
    state: best ? "available" : "missing",
    timestampBasis: activityTimestampBasis(events),
    windowMs,
    maximumEventCount: best?.eventCount ?? 0,
    maximumUniqueActorCount: best?.uniqueActorCount ?? 0,
    startedAt: best?.startedAt ?? null,
    endedAt: best?.endedAt ?? null
  };
}

function aggregateMetrics(events, burstWindowMs, createdAt, earlyWindowMs) {
  const firstByActor = new Map();
  const activityByActor = new Map();
  for (const event of events) {
    const at = activityTimestamp(event);
    if (!firstByActor.has(event.actor)) firstByActor.set(event.actor, at);
    const activity = activityByActor.get(event.actor) || { buy: 0, sell: 0 };
    activity[event.side] += 1;
    activityByActor.set(event.actor, activity);
  }
  const offsets = createdAt
    ? [...firstByActor.values()].map((at) => at - createdAt.milliseconds)
    : [];
  const activities = [...activityByActor.values()];
  const timestampBasis = activityTimestampBasis(events);
  return {
    timing: createdAt
      ? {
        state: "available",
        basis: `${timestampBasis}-minus-launch-observed-at`,
        launchObservedAt: createdAt.iso,
        earlyWindowMs,
        firstActivityAt: new Date(activityTimestamp(events[0])).toISOString(),
        lastActivityAt: new Date(activityTimestamp(events.at(-1))).toISOString(),
        actorsObservedWithinWindow: offsets.filter((offset) => offset >= -1_000 && offset <= earlyWindowMs).length,
        actorFirstObservationOffsetMs: {
          minimum: offsets.reduce((minimum, value) => Math.min(minimum, value), Infinity),
          median: median(offsets),
          maximum: offsets.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
        }
      }
      : {
        state: "missing",
        basis: `${timestampBasis}-minus-launch-observed-at`,
        reason: "launch-observed-at-missing",
        launchObservedAt: null,
        earlyWindowMs,
        firstActivityAt: new Date(activityTimestamp(events[0])).toISOString(),
        lastActivityAt: new Date(activityTimestamp(events.at(-1))).toISOString(),
        actorsObservedWithinWindow: null,
        actorFirstObservationOffsetMs: null
      },
    uniqueActors: {
      state: "available",
      count: firstByActor.size
    },
    repeatActivity: {
      state: "available",
      actorsWithMultipleBuys: activities.filter(({ buy }) => buy > 1).length,
      actorsWithMultipleSells: activities.filter(({ sell }) => sell > 1).length,
      actorsObservedOnBothSides: activities.filter(({ buy, sell }) => buy > 0 && sell > 0).length
    },
    holdingDurationEvidence: holdingDurationEvidence(events),
    amountConcentration: concentration(events),
    activityBurst: activityBurst(events, burstWindowMs)
  };
}

function coinSummary(mint, events, config) {
  const uniqueActorCount = new Set(events.map(({ actor }) => actor)).size;
  const sourceTimestamps = timestampCoverage(events);
  const createdAt = config.mintCreatedAt.get(mint) ?? null;
  const gate = {
    minimumEventCount: config.minimumEventCount,
    minimumActorCount: config.minimumActorCount,
    minimumSourceTimestampRatio: config.minimumSourceTimestampRatio,
    eventCountMet: events.length >= config.minimumEventCount,
    actorCountMet: uniqueActorCount >= config.minimumActorCount,
    sourceTimestampRatioMet: (events.length === 0
      ? 0
      : sourceTimestamps.availableCount / events.length) >= config.minimumSourceTimestampRatio
  };
  const available = gate.eventCountMet && gate.actorCountMet && gate.sourceTimestampRatioMet;
  const state = events.length === 0 ? "missing" : available ? "available" : "insufficient-sample";
  return {
    mint,
    coverage: {
      state,
      eventCount: events.length,
      uniqueActorCount,
      launchObservedAt: createdAt
        ? { state: "available", value: createdAt.iso }
        : { state: "missing", value: null },
      sourceTimestamps,
      gate
    },
    metrics: available
      ? aggregateMetrics(events, config.burstWindowMs, createdAt, config.earlyWindowMs)
      : null
  };
}

export function summarizeEarlyActorEvents(mintValue, eventsValue, options = {}) {
  const mint = requireMint(mintValue);
  if (!Array.isArray(eventsValue) || eventsValue.length > MAX_RETAINED_EVENTS) {
    fail("invalid-event", "normalized events must be a bounded array");
  }
  const events = eventsValue.map((event) => {
    if (!plainObject(event) || event.schemaVersion !== EARLY_ACTOR_SCHEMA_VERSION || event.mint !== mint
      || typeof event.actor !== "string" || !/^Actor [1-9][0-9]{0,19}$/.test(event.actor)
      || !["buy", "sell"].includes(event.side)
      || !plainObject(event.amounts) || !plainObject(event.source) || !plainObject(event.timestamps)) {
      fail("invalid-event", "normalized event did not match the aggregate contract");
    }
    if (!Object.hasOwn(EARLY_ACTOR_SOURCES, event.source.name)
      || event.source.evidenceClass !== EARLY_ACTOR_SOURCES[event.source.name].evidenceClass) {
      fail("invalid-event", "normalized event source contract was invalid");
    }
    boundedAmount(event.amounts.token, "tokenAmount", options.maxTokenAmount ?? DEFAULTS.maxTokenAmount);
    if (event.amounts.native !== null) boundedAmount(event.amounts.native, "nativeAmount", options.maxNativeAmount ?? DEFAULTS.maxNativeAmount);
    parseTimestamp(event.timestamps.observedAt, "observation timestamp");
    if (event.timestamps.source?.state === "available") parseTimestamp(event.timestamps.source.value, "source timestamp");
    else if (event.timestamps.source?.state !== "missing" || event.timestamps.source?.value !== null) {
      fail("invalid-event", "normalized source timestamp state was invalid");
    }
    return clone(event);
  }).sort(eventOrder);
  const createdAt = options.mintCreatedAt === undefined || options.mintCreatedAt === null
    ? new Map()
    : new Map([[mint, parseTimestamp(options.mintCreatedAt, "token creation timestamp")]]);
  const config = {
    minimumEventCount: positiveInteger(options.minimumEventCount ?? DEFAULTS.minimumEventCount, "minimumEventCount", MAX_RETAINED_EVENTS),
    minimumActorCount: positiveInteger(options.minimumActorCount ?? DEFAULTS.minimumActorCount, "minimumActorCount", MAX_RETAINED_EVENTS),
    minimumSourceTimestampRatio: ratio(options.minimumSourceTimestampRatio ?? DEFAULTS.minimumSourceTimestampRatio, "minimumSourceTimestampRatio"),
    burstWindowMs: positiveInteger(options.burstWindowMs ?? DEFAULTS.burstWindowMs, "burstWindowMs", MAX_RETENTION_MS),
    earlyWindowMs: positiveInteger(options.earlyWindowMs ?? DEFAULTS.earlyWindowMs, "earlyWindowMs", MAX_RETENTION_MS),
    mintCreatedAt: createdAt
  };
  if (config.minimumActorCount > config.minimumEventCount) fail("invalid-config", "minimumActorCount cannot exceed minimumEventCount");
  return coinSummary(mint, events, config);
}

function saturatingIncrement(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

export class EarlyActorCore {
  #config;
  #events = new Map();
  #highWaterMs = null;
  #droppedEventCount = 0;

  constructor(options = {}) {
    this.#config = configuration(options);
  }

  ingest(frame, { observedAt } = {}) {
    const normalized = normalizeInternal(frame, this.#config, observedAt);
    const existing = this.#events.get(normalized.dedupeKey);
    if (existing) {
      if (existing.integrityKey !== normalized.integrityKey) {
        fail("transaction-conflict", "transaction provenance conflicts with an already retained observation");
      }
      return {
        accepted: false,
        duplicate: true,
        retained: true,
        event: clone(existing.event)
      };
    }

    this.#events.set(normalized.dedupeKey, normalized);
    this.#highWaterMs = this.#highWaterMs === null
      ? normalized.observedAtMs
      : Math.max(this.#highWaterMs, normalized.observedAtMs);
    this.#prune();
    return {
      accepted: true,
      duplicate: false,
      retained: this.#events.has(normalized.dedupeKey),
      event: clone(normalized.event)
    };
  }

  eventsForMint(value) {
    const mint = requireMint(value);
    if (!this.#config.observedMints.has(mint)) fail("mint-not-observed", "mint is outside the exact observed-mint allowlist");
    return [...this.#events.values()]
      .map(({ event }) => event)
      .filter((event) => event.mint === mint)
      .sort(eventOrder)
      .map(clone);
  }

  snapshot() {
    const mints = [...this.#config.observedMints].sort(lexical);
    const events = [...this.#events.values()].map(({ event }) => event).sort(eventOrder);
    const byMint = Object.fromEntries(mints.map((mint) => [
      mint,
      coinSummary(mint, events.filter((event) => event.mint === mint), this.#config)
    ]));
    const sourceTimestamps = timestampCoverage(events);
    const mintsWithEvidence = Object.values(byMint).filter(({ coverage }) => coverage.eventCount > 0).length;
    const bySource = Object.fromEntries(Object.entries(EARLY_ACTOR_SOURCES).map(([source, policy]) => {
      const sourceEvents = events.filter((event) => event.source.name === source);
      return [source, {
        state: sourceEvents.length === 0 ? "missing" : "available",
        contractState: "input-only",
        evidenceClass: policy.evidenceClass,
        observedEventCount: sourceEvents.length,
        sourceTimestamps: timestampCoverage(sourceEvents)
      }];
    }));
    return {
      schemaVersion: EARLY_ACTOR_SCHEMA_VERSION,
      methodVersion: EARLY_ACTOR_METHOD_VERSION,
      purpose: "descriptive-activity-evidence",
      downstreamState: "calibration-required",
      sourceCoverage: {
        state: events.length === 0 ? "missing" : mintsWithEvidence === mints.length ? "available" : "partial",
        observedEventCount: events.length,
        observedMintCount: mints.length,
        mintsWithEvidence,
        sourceTimestamps,
        bySource
      },
      retention: {
        maxEvents: this.#config.maxEvents,
        maxAgeMs: this.#config.maxAgeMs,
        retainedEventCount: events.length,
        droppedEventCount: this.#droppedEventCount,
        oldestObservedAt: events[0]?.timestamps.observedAt ?? null,
        newestObservedAt: events.at(-1)?.timestamps.observedAt ?? null
      },
      byMint
    };
  }

  #prune() {
    if (this.#highWaterMs === null) return;
    const cutoff = this.#highWaterMs - this.#config.maxAgeMs;
    for (const [key, value] of this.#events) {
      if (value.observedAtMs < cutoff) {
        this.#events.delete(key);
        this.#droppedEventCount = saturatingIncrement(this.#droppedEventCount);
      }
    }
    if (this.#events.size <= this.#config.maxEvents) return;
    const ordered = [...this.#events.entries()].sort((left, right) => (
      left[1].observedAtMs - right[1].observedAtMs || lexical(left[0], right[0])
    ));
    const removeCount = ordered.length - this.#config.maxEvents;
    for (let index = 0; index < removeCount; index += 1) {
      this.#events.delete(ordered[index][0]);
      this.#droppedEventCount = saturatingIncrement(this.#droppedEventCount);
    }
  }
}
