import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { validateRiskIdentityPersistenceEvidence } from "./risk-identity.js";
import { isCanonicalSolanaAddress } from "./early-actors.js";
import { CanonicalRegistry, validateCanonicalEntity, validateCanonicalRelationship } from "./canonical-registry.js";

export const STORE_SCHEMA_VERSION = 902;
export const IDENTITY_PENDING_PROPOSAL_LIMIT = 500;
export const IDENTITY_REGISTRY_CAPACITY = Object.freeze({ entities: 500, variants: 2_000, relationships: 5_000 });
export const IDENTITY_RESOLVER_RELATIONSHIP_LIMIT = 100;
const LEGACY_ACTOR_SCHEMA_VERSION = 900;
export const ACTOR_OBSERVATION_MAX_RETENTION_MS = 72 * 60 * 60 * 1_000;

const MAX_ENRICHMENT_QUERY = 200;
const MAX_EVIDENCE_BYTES = 64 * 1_024;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const SENSITIVE_KEY = /(?:api.?key|secret|password|authorization|cookie|credential|access.?token|refresh.?token)/i;
const FORBIDDEN_BULK_KEY = /^(?:raw|rawdata|rawresponse|raw_response|payload|responsebody|response_body|ohlcv|ohlcvlist|ohlcv_list|candles|observations|rows|open|high|low|close|volume|reserveusd|volume24husd)$/i;
const GECKOTERMINAL_EVIDENCE_SCHEMA = Object.freeze({
  root: new Set(["source", "sourceUrl", "poolCreatedAt", "poolSelectedAt", "providerPage", "providerRank", "selectionScope", "received", "rejected", "incomplete", "pages", "baselineAt", "observationCount", "outcome", "liquidity", "retention", "admissionPolicy", "launchObservedAt", "admittedAt", "httpStatus", "lastRefreshFailedAt", "lastRefreshErrorCode", "providerStatus"]),
  outcome: new Set(["schemaVersion", "algorithm", "revisionPolicy", "status", "basis", "launchAt", "asOf", "maxStalenessMs", "maxBaselineLagMs", "series", "baseline", "observationCounts", "windows", "poolSelection", "revisionHistory"]),
  series: new Set(["source", "pool", "intervalSeconds"]),
  baseline: new Set(["status", "expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "lagSeconds", "source", "pool", "intervalSeconds", "reason", "candidate", "nonempty", "role"]),
  observationCounts: new Set(["supplied", "normalized", "availableAsOf", "beforeLaunch", "afterAsOf", "retainedObservedWindows"]),
  windows: new Set(["5m", "15m", "1h", "6h", "24h"]),
  window: new Set(["status", "calculatedAt", "expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "stalenessSeconds", "source", "pool", "intervalSeconds", "returnPct", "maximumDrawdownPct", "reason", "evidence"]),
  windowEvidence: new Set(["baseline", "target", "drawdown"]),
  candle: new Set(["expectedAt", "candleStartAt", "candleEndAt", "observedAt", "fetchedAt", "lagSeconds", "stalenessSeconds", "source", "pool", "intervalSeconds", "nonempty"]),
  drawdown: new Set(["basis", "sampleCount", "maximumPct", "peak", "trough"]),
  poolSelection: new Set(["policy", "selectedAt", "providerPage", "providerRank", "poolCreatedAt", "source", "pool"]),
  revisionEntry: new Set(["checkedAt", "action", "windowRevisionPolicy", "changedWindows", "missingWindows", "newlyObservedWindows"]),
  liquidity: new Set(["schemaVersion", "source", "evidenceClass", "attemptedAt", "observedAt", "liquidityUsd", "missingReasonCode", "basis", "limitation"])
});
const OUTCOME_WINDOW_KEYS = new Set(["5m", "15m", "1h", "6h", "24h"]);
const INTEGER_EVIDENCE_FIELDS = new Set(["schemaVersion", "maxStalenessMs", "maxBaselineLagMs", "intervalSeconds", "providerPage", "providerRank", "received", "rejected", "incomplete", "pages", "observationCount", "httpStatus", "sampleCount", "supplied", "normalized", "availableAsOf", "beforeLaunch", "afterAsOf", "retainedObservedWindows", "providerStatus"]);
const NUMERIC_EVIDENCE_FIELDS = new Set(["lagSeconds", "stalenessSeconds", "returnPct", "maximumDrawdownPct", "maximumPct", "liquidityUsd"]);
const BOOLEAN_EVIDENCE_FIELDS = new Set(["nonempty"]);
const OUTCOME_BASIS = "first-wholly-post-launch-completed-candle-baseline-and-last-completed-close-at-or-before-target";
const OUTCOME_ALGORITHM = "provider-observed-completed-candle-outcomes-v1";
const OUTCOME_REVISION_POLICY = "first-observed-derived-value-per-window-provider-revision";
const SELECTION_POLICY = "prospective-earliest-created-eligible-pool-on-provider-ranked-page-1-within-2m";
const BASELINE_ROLE = "first-observed-baseline-reference-only; each window retains its own provider revision";
const DRAWDOWN_BASIS = "observed-completed-candle-closes-only";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const RAW_SOCIAL_PROFILE_PATTERN = /^(?:@[A-Za-z0-9_]{1,32}|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s]+)$/i;
const ACTOR_SUMMARY_KEYS = Object.freeze({
  root: new Set(["schemaVersion", "mint", "coverage", "metrics"]),
  coverage: new Set(["state", "eventCount", "uniqueActorCount", "launchObservedAt", "sourceTimestamps", "gate"]),
  launchObservedAt: new Set(["state", "value"]),
  sourceTimestamps: new Set(["state", "availableCount", "missingCount", "ratio"]),
  gate: new Set(["minimumEventCount", "minimumActorCount", "minimumSourceTimestampRatio", "eventCountMet", "actorCountMet", "sourceTimestampRatioMet"]),
  metrics: new Set(["timing", "uniqueActors", "repeatActivity", "holdingDurationEvidence", "amountConcentration", "activityBurst"]),
  timing: new Set(["state", "basis", "reason", "launchObservedAt", "earlyWindowMs", "firstActivityAt", "lastActivityAt", "actorsObservedWithinWindow", "actorFirstObservationOffsetMs"]),
  actorFirstObservationOffsetMs: new Set(["minimum", "median", "maximum"]),
  uniqueActors: new Set(["state", "count"]),
  repeatActivity: new Set(["state", "actorsWithMultipleBuys", "actorsWithMultipleSells", "actorsObservedOnBothSides"]),
  holdingDurationEvidence: new Set(["state", "basis", "timestampBasis", "pairedObservationCount", "minimumMs", "medianMs", "maximumMs"]),
  amountConcentration: new Set(["state", "basis", "amountCoverage", "actorCountWithAmount", "largestActorShare", "largestThreeActorShare"]),
  amountCoverage: new Set(["state", "availableCount", "missingCount"]),
  activityBurst: new Set(["state", "timestampBasis", "windowMs", "maximumEventCount", "maximumUniqueActorCount", "startedAt", "endedAt"])
});
const ACTOR_OBSERVATION_KEYS = Object.freeze({
  root: new Set(["schemaVersion", "mint", "actor", "side", "amounts", "source", "timestamps", "transactionProvenance"]),
  amounts: new Set(["native", "token"]),
  source: new Set(["name", "evidenceClass"]),
  timestamps: new Set(["source", "observedAt"]),
  sourceTimestamp: new Set(["state", "value"]),
  transactionProvenance: new Set(["state", "evidenceClass", "slot"]),
  slot: new Set(["state", "value"])
});
const OUTCOME_REASONS = new Set(["baseline-missing", "baseline-observation-stale", "window-not-mature", "target-observation-missing", "target-observation-stale", "return-calculation-out-of-range"]);
const GECKOTERMINAL_STATUSES = new Set([
  "queued", "pool-selected", "awaiting-pool", "awaiting-price", "baseline-unavailable",
  "observing", "complete", "rate-limited", "degraded", "invalid-response"
]);
const GECKOTERMINAL_ERROR_CODES = new Set([
  "enrichment-failed", "invalid-before-timestamp", "invalid-fetch-timestamp", "invalid-json", "invalid-limit",
  "invalid-mint", "invalid-pool", "invalid-response", "invalid-selection-timestamp", "invalid-token-side",
  "invalid-token-timestamp", "network-error", "not-found", "pool-unavailable", "provider-http-error",
  "provider-request-rejected", "provider-unavailable", "rate-limited", "selection-window-missed", "timeout",
  "token-info-missing", "token-mismatch"
]);
const GECKOTERMINAL_MISSING_REASONS = new Set([
  "Prospective launch admitted; provider evidence pending",
  "Fixed provider page-1 pool selected; awaiting the first mature outcome window",
  "No eligible completed baseline candle was provider-observed within the bounded acquisition window",
  "No completed real-trade minute candle was available",
  "Prospective provider evidence was invalid or unavailable",
  "No eligible provider pool is available yet",
  "Provider enrichment attempt failed",
  ...OUTCOME_REASONS
]);
const RISK_IDENTITY_STATUSES = new Set(["queued", "available", "unavailable", "degraded", "rate-limited", "invalid-response"]);
const MATERIAL_ALERT_KINDS = Object.freeze([
  "score-rise", "score-drop", "risk-concentration", "risk-developer-holding",
  "risk-identity-reuse", "risk-creator-history", "migration-observed"
]);
const canonicalTokenRowPredicate = (alias = "tokens") => `(CASE WHEN json_valid(${alias}.payload) THEN
  json_type(${alias}.payload,'$.mint')='text'
  AND json_extract(${alias}.payload,'$.mint')=${alias}.mint
  AND is_canonical_solana_address(${alias}.mint)=1 ELSE 0 END)`;
const RFC3339_MILLIS_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";
const canonicalTimestampSql = (column) => `(${column} GLOB '${RFC3339_MILLIS_GLOB}'
  AND strftime('%Y-%m-%dT%H:%M:%fZ',${column})=${column})`;
const TELEGRAM_NEXT_ATTEMPT_IS_CANONICAL_SQL = canonicalTimestampSql("telegram_next_attempt_at");
const TELEGRAM_OUTBOX_CHECK_SQL = `CHECK (
  (telegram_status IS NULL AND telegram_attempted_at IS NULL AND telegram_message_id IS NULL
    AND telegram_attempt_count=0 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NULL)
  OR (telegram_status='pending' AND telegram_attempted_at IS NULL AND telegram_message_id IS NULL
    AND telegram_attempt_count=0 AND coalesce(${TELEGRAM_NEXT_ATTEMPT_IS_CANONICAL_SQL},0)=1 AND telegram_last_error_code IS NULL)
  OR (telegram_status='retrying' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NULL
    AND telegram_attempt_count>=1 AND coalesce(${TELEGRAM_NEXT_ATTEMPT_IS_CANONICAL_SQL},0)=1 AND telegram_last_error_code IS NOT NULL)
  OR (telegram_status='sent' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NOT NULL
    AND telegram_attempt_count>=1 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NULL)
  OR (telegram_status='dead-letter' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NULL
    AND telegram_attempt_count>=1 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NOT NULL)
)`;

function scalarEvidenceKey(schema) {
  if (typeof schema !== "string" || !schema.startsWith("scalar:")) return null;
  const [, parent, key] = schema.split(":");
  return { parent, key };
}

function validateProviderScalar(value, parent, key) {
  if (value === null) return null;
  if (BOOLEAN_EVIDENCE_FIELDS.has(key)) {
    if (typeof value !== "boolean") throw new TypeError(`provider evidence ${key} must be boolean`);
    return value;
  }
  if (INTEGER_EVIDENCE_FIELDS.has(key)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`provider evidence ${key} must be a non-negative integer`);
    return value;
  }
  if (NUMERIC_EVIDENCE_FIELDS.has(key)) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`provider evidence ${key} must be finite numeric data`);
    return value;
  }
  if (typeof value !== "string") throw new TypeError(`provider evidence ${key} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`provider evidence ${key} must be a bounded non-empty string without control characters`);
  }
  if (sensitiveText(normalized)) throw new TypeError(`provider evidence ${key} must not contain credentials or secrets`);
  if (normalized.startsWith("[") || normalized.startsWith("{")) {
    try {
      const decoded = JSON.parse(normalized);
      if (Array.isArray(decoded) || (decoded && typeof decoded === "object")) throw new TypeError(`provider evidence ${key} must not encode structured provider data`);
    } catch (error) {
      if (error instanceof TypeError) throw error;
    }
  }
  if (key.endsWith("At") || key === "asOf") return timestamp(normalized, key);
  if (key === "sourceUrl") return sourceUrl(normalized);
  if (key === "source") {
    if (normalized !== "geckoterminal") throw new TypeError("provider evidence source must be geckoterminal");
    return normalized;
  }
  if (key === "pool") {
    if (!MINT_PATTERN.test(normalized)) throw new TypeError("provider evidence pool must be a Solana base58 address");
    return normalized;
  }
  const exact = key === "algorithm" ? OUTCOME_ALGORITHM
    : key === "revisionPolicy" || key === "windowRevisionPolicy" ? OUTCOME_REVISION_POLICY
      : key === "role" ? BASELINE_ROLE
        : key === "policy" ? SELECTION_POLICY
          : key === "selectionScope" ? "provider-contemporaneously-ranked-page-1"
            : key === "retention" ? "derived-metrics-and-minimal-provenance-only"
              : key === "admissionPolicy" ? "prospective-fixed-admission-v1"
                : key === "action" ? "first-observed-per-window-provider-revisions-retained"
                    : key === "evidenceClass" ? null
                      : key === "limitation" ? "GeckoTerminal-observed pool reserve is not evidence of locked liquidity"
                        : key === "basis" ? parent === "drawdown" ? DRAWDOWN_BASIS : parent === "liquidity" ? "provider-observed-pool-reserve" : OUTCOME_BASIS
                    : null;
  if (exact !== null) {
    if (normalized !== exact) throw new TypeError(`provider evidence ${key} did not match the required contract`);
    return normalized;
  }
  if (key === "evidenceClass" && parent === "liquidity") {
    if (!["provider-observed", "unavailable"].includes(normalized)) throw new TypeError("provider liquidity evidence class is invalid");
    return normalized;
  }
  if (key === "missingReasonCode" && parent === "liquidity") {
    if (normalized !== "pool-reserve-missing") throw new TypeError("provider liquidity missing reason is invalid");
    return normalized;
  }
  if (key === "status") {
    const allowed = parent === "outcome" ? new Set(["awaiting-baseline", "complete", "partial", "awaiting-observations"])
      : parent === "baseline" ? new Set(["observed", "unavailable"])
        : parent === "window" ? new Set(["observed", "unavailable"])
          : new Set();
    if (!allowed.has(normalized)) throw new TypeError(`provider evidence ${parent} status is invalid`);
    return normalized;
  }
  if (key === "reason") {
    if (!OUTCOME_REASONS.has(normalized)) throw new TypeError("provider evidence missing reason is invalid");
    return normalized;
  }
  if (key === "lastRefreshErrorCode") {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) throw new TypeError("provider refresh error code is invalid");
    return normalized;
  }
  throw new TypeError(`provider evidence string field is not explicitly validated: ${parent}.${key}`);
}

function childEvidenceSchema(parent, key) {
  if (parent === "root" && key === "outcome") return "outcome";
  if (parent === "root" && key === "liquidity") return "liquidity";
  if (parent === "outcome" && ["series", "baseline", "observationCounts", "windows", "poolSelection", "revisionHistory"].includes(key)) return key;
  if (parent === "windows" && OUTCOME_WINDOW_KEYS.has(key)) return "window";
  if (parent === "window" && key === "evidence") return "windowEvidence";
  if (parent === "windowEvidence" && ["baseline", "target"].includes(key)) return "candle";
  if (parent === "windowEvidence" && key === "drawdown") return "drawdown";
  if (parent === "baseline" && key === "candidate") return "candle";
  if (parent === "drawdown" && ["peak", "trough"].includes(key)) return "candle";
  if (parent === "revisionEntry" && ["changedWindows", "missingWindows", "newlyObservedWindows"].includes(key)) return "windowKeyList";
  return parent ? `scalar:${parent}:${key}` : null;
}

function validateLiquidityEvidenceEnvelope(value) {
  const attempted = typeof value.attemptedAt === "string";
  const observed = typeof value.observedAt === "string";
  const amount = typeof value.liquidityUsd === "number" && Number.isFinite(value.liquidityUsd) && value.liquidityUsd >= 0;
  if (value.schemaVersion !== 1 || value.source !== "geckoterminal" || !attempted) {
    throw new TypeError("provider liquidity evidence requires schema version 1, source, and an attempted timestamp");
  }
  if (value.evidenceClass === "provider-observed") {
    if (!observed || !amount || value.missingReasonCode !== null) {
      throw new TypeError("provider-observed liquidity evidence requires observed timestamps, a non-negative value, and no missing reason");
    }
    return value;
  }
  if (value.evidenceClass === "unavailable") {
    if (value.observedAt !== null || value.liquidityUsd !== null || value.missingReasonCode !== "pool-reserve-missing") {
      throw new TypeError("unavailable liquidity evidence requires null observation/value and an explicit missing reason");
    }
    return value;
  }
  throw new TypeError("provider liquidity evidence class is invalid");
}

function restrictDatabasePermissions(databasePath) {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try { chmodSync(candidate, 0o600); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function text(value, label, { max = 256, optional = false, code = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`);
  if (normalized.length > max) throw new RangeError(`${label} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${label} must not contain control characters`);
  if (code && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new TypeError(`${label} must be a stable code`);
  }
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an RFC 3339 string`);
  const match = RFC3339.exec(value);
  if (!match) throw new TypeError(`${label} must be an RFC 3339 timestamp with an explicit timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new TypeError(`${label} must be a valid RFC 3339 timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function boundedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function actorSummaryObject(value, label, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ACTOR_SUMMARY_KEYS[schema].has(key)) throw new TypeError(`${label}.${key} was outside the public aggregate contract`);
  }
  return value;
}

function actorObservationObject(value, label, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ACTOR_OBSERVATION_KEYS[schema].has(key)) {
      throw new TypeError(`${label}.${key} contained raw identity or data outside the minimized observation contract`);
    }
  }
  return value;
}

function validateActorObservationContract(event) {
  actorObservationObject(event, "actor event", "root");
  actorObservationObject(event.amounts, "actor event.amounts", "amounts");
  actorObservationObject(event.source, "actor event.source", "source");
  actorObservationObject(event.timestamps, "actor event.timestamps", "timestamps");
  actorObservationObject(event.timestamps.source, "actor event.timestamps.source", "sourceTimestamp");
  actorObservationObject(event.transactionProvenance, "actor event.transactionProvenance", "transactionProvenance");
  actorObservationObject(event.transactionProvenance.slot, "actor event.transactionProvenance.slot", "slot");
  if (event.schemaVersion !== 1
    || !Number.isFinite(event.amounts.token) || event.amounts.token <= 0 || event.amounts.token > 1_000_000_000_000_000
    || (event.amounts.native !== null && (!Number.isFinite(event.amounts.native) || event.amounts.native < 0 || event.amounts.native > 1_000_000_000_000))
    || !["solana-mainnet-rpc", "pumpportal"].includes(event.source.name)
    || !["on-chain-finalized", "provider-observed"].includes(event.source.evidenceClass)
    || (event.source.name === "solana-mainnet-rpc" && event.source.evidenceClass !== "on-chain-finalized")
    || (event.source.name === "pumpportal" && event.source.evidenceClass !== "provider-observed")) {
    throw new TypeError("actor event values did not match the minimized observation contract");
  }
  timestamp(event.timestamps.observedAt, "actor event observedAt");
  if (event.timestamps.source.state === "available") timestamp(event.timestamps.source.value, "actor event source timestamp");
  else if (event.timestamps.source.state !== "missing" || event.timestamps.source.value !== null) {
    throw new TypeError("actor event source timestamp state was invalid");
  }
  if (event.transactionProvenance.state !== "internal-only"
    || event.transactionProvenance.evidenceClass !== "locally-derived"
    || !["available", "missing"].includes(event.transactionProvenance.slot.state)
    || (event.transactionProvenance.slot.state === "available"
      && (!Number.isSafeInteger(event.transactionProvenance.slot.value) || event.transactionProvenance.slot.value < 1))
    || (event.transactionProvenance.slot.state === "missing" && event.transactionProvenance.slot.value !== null)) {
    throw new TypeError("actor event provenance did not match the minimized observation contract");
  }
  return event;
}

function actorObservationEvidenceKey(event) {
  return JSON.stringify([
    event.schemaVersion,
    event.mint,
    event.actor,
    event.side,
    event.amounts.native,
    event.amounts.token,
    event.source.name,
    event.source.evidenceClass,
    event.timestamps.source.state,
    event.timestamps.source.value,
    event.transactionProvenance.state,
    event.transactionProvenance.evidenceClass,
    event.transactionProvenance.slot.state,
    event.transactionProvenance.slot.value
  ]);
}

function rejectActorSummaryIdentity(value, mint, path = "actor summary") {
  if (typeof value === "string") {
    if ((MINT_PATTERN.test(value) && value !== mint) || SOLANA_SIGNATURE_PATTERN.test(value)
      || RAW_SOCIAL_PROFILE_PATTERN.test(value)) {
      throw new TypeError(`${path} contained raw identity or transaction material`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) rejectActorSummaryIdentity(entry, mint, `${path}.${key}`);
}

function validateActorSummaryContract(summary, mint) {
  actorSummaryObject(summary, "actor summary", "root");
  const coverage = actorSummaryObject(summary.coverage, "actor summary.coverage", "coverage");
  if (coverage.launchObservedAt !== undefined) actorSummaryObject(coverage.launchObservedAt, "actor summary.coverage.launchObservedAt", "launchObservedAt");
  if (coverage.sourceTimestamps !== undefined) actorSummaryObject(coverage.sourceTimestamps, "actor summary.coverage.sourceTimestamps", "sourceTimestamps");
  if (coverage.gate !== undefined) actorSummaryObject(coverage.gate, "actor summary.coverage.gate", "gate");
  if (summary.metrics !== null && summary.metrics !== undefined) {
    const metrics = actorSummaryObject(summary.metrics, "actor summary.metrics", "metrics");
    for (const key of ["timing", "uniqueActors", "repeatActivity", "holdingDurationEvidence", "amountConcentration", "activityBurst"]) {
      if (metrics[key] !== undefined) actorSummaryObject(metrics[key], `actor summary.metrics.${key}`, key);
    }
    if (metrics.timing?.actorFirstObservationOffsetMs !== null && metrics.timing?.actorFirstObservationOffsetMs !== undefined) {
      actorSummaryObject(metrics.timing.actorFirstObservationOffsetMs,
        "actor summary.metrics.timing.actorFirstObservationOffsetMs", "actorFirstObservationOffsetMs");
    }
    if (metrics.amountConcentration?.amountCoverage !== undefined) {
      actorSummaryObject(metrics.amountConcentration.amountCoverage,
        "actor summary.metrics.amountConcentration.amountCoverage", "amountCoverage");
    }
  }
  rejectActorSummaryIdentity(summary, mint);
  return summary;
}

function sensitiveText(value) {
  if (/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  try {
    const candidate = new URL(value);
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return true;
    for (const key of candidate.searchParams.keys()) if (SENSITIVE_KEY.test(key)) return true;
  } catch {}
  return false;
}

function canonicalJsonValue(value, depth = 0, schema = null) {
  if (depth > 12) throw new RangeError("evidence must not exceed 12 levels");
  const scalar = scalarEvidenceKey(schema);
  if (scalar) return validateProviderScalar(value, scalar.parent, scalar.key);
  if (value === null) return value;
  if (typeof value === "boolean") {
    if (schema) throw new TypeError(`evidence ${schema} must be a structured value`);
    return value;
  }
  if (typeof value === "number") {
    if (schema) throw new TypeError(`evidence ${schema} must be a structured value`);
    if (!Number.isFinite(value)) throw new TypeError("evidence numbers must be finite");
    return value;
  }
  if (typeof value === "string") {
    if (schema) throw new TypeError(`evidence ${schema} must be a structured value`);
    if (value.length > 2_048) throw new RangeError("evidence strings must be at most 2048 characters");
    if (sensitiveText(value)) throw new TypeError("evidence must not contain credentials or secrets");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 250) throw new RangeError("evidence arrays must have at most 250 items");
    if (schema === "revisionHistory") return value.map((item) => canonicalJsonValue(item, depth + 1, "revisionEntry"));
    if (schema === "windowKeyList") {
      if (value.some((item) => typeof item !== "string" || !OUTCOME_WINDOW_KEYS.has(item))) throw new TypeError("outcome revision window lists may contain only supported horizon keys");
      return [...value];
    }
    if (schema) throw new TypeError(`evidence ${schema} must not be an array`);
    return value.map((item) => canonicalJsonValue(item, depth + 1));
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("evidence must contain only JSON-compatible values");
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 100) throw new RangeError("evidence objects must have at most 100 keys");
  const allowedKeys = schema ? GECKOTERMINAL_EVIDENCE_SCHEMA[schema] : null;
  if (schema && !allowedKeys) throw new TypeError(`unknown evidence schema: ${schema}`);
  const normalized = Object.fromEntries(keys.map((key) => {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`evidence key is not allowed: ${key}`);
    if (FORBIDDEN_BULK_KEY.test(key)) throw new TypeError(`raw provider data is not allowed in evidence: ${key}`);
    if (allowedKeys && !allowedKeys.has(key)) throw new TypeError(`evidence key is not permitted for this provider: ${key}`);
    return [key, canonicalJsonValue(value[key], depth + 1, childEvidenceSchema(schema, key))];
  }));
  return schema === "liquidity" ? validateLiquidityEvidenceEnvelope(normalized) : normalized;
}

function evidenceJson(value = {}, { provider = null } = {}) {
  const normalized = canonicalJsonValue(value, 0, provider === "geckoterminal" ? "root" : null);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new TypeError("evidence must be a JSON object");
  }
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) {
    throw new RangeError(`evidence must be at most ${MAX_EVIDENCE_BYTES} bytes`);
  }
  return encoded;
}

function sourceUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = text(value, "sourceUrl", { max: 2_048 });
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new TypeError("sourceUrl must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("sourceUrl must be an HTTP(S) URL without credentials, query parameters, or fragments");
  }
  return parsed.toString();
}

function normalizeEnrichment(value, existing = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("enrichment state must be an object");
  const provider = text(value.provider, "provider", { max: 64, optional: true, code: true });
  const pool = text(value.pool, "pool", { max: 256, optional: true });
  const tokenSide = text(value.tokenSide, "tokenSide", { max: 5, optional: true, code: true })?.toLowerCase() ?? null;
  if ((pool === null) !== (tokenSide === null) || (pool !== null && provider === null)) {
    throw new TypeError("pool and tokenSide must be supplied together and require provider");
  }
  if (tokenSide !== null && !["base", "quote"].includes(tokenSide)) throw new RangeError("tokenSide must be base or quote");
  const lastAttemptAt = value.lastAttemptAt == null ? null : timestamp(value.lastAttemptAt, "lastAttemptAt");
  const inferredAttemptCount = value.attemptCount === undefined
    ? existing && lastAttemptAt === existing.lastAttemptAt ? existing.attemptCount : (existing?.attemptCount ?? 0) + 1
    : value.attemptCount;
  const attemptCount = boundedInteger(inferredAttemptCount, "attemptCount", { max: 1_000_000_000 });
  if ((attemptCount === 0) !== (lastAttemptAt === null)) {
    throw new TypeError("lastAttemptAt must be null only when attemptCount is zero");
  }
  const updatedAt = timestamp(value.updatedAt ?? value.lastAttemptAt, "updatedAt");
  const nextAttemptAt = value.nextAttemptAt == null ? null : timestamp(value.nextAttemptAt, "nextAttemptAt");
  const lastSuccessAt = value.lastSuccessAt == null ? null : timestamp(value.lastSuccessAt, "lastSuccessAt");
  if (lastAttemptAt && lastAttemptAt > updatedAt) throw new RangeError("lastAttemptAt must not be after updatedAt");
  if (lastSuccessAt && lastSuccessAt > updatedAt) throw new RangeError("lastSuccessAt must not be after updatedAt");
  const mint = text(value.mint, "mint", { max: 128 });
  const status = text(value.status, "status", { max: 64, code: true });
  const missingReason = (() => {
    const reason = text(value.missingReason, "missingReason", { max: 160, optional: true });
    if (reason && sensitiveText(reason)) throw new TypeError("missingReason must not contain credentials or secrets");
    return reason;
  })();
  const errorCode = text(value.errorCode, "errorCode", { max: 64, optional: true, code: true });
  const normalizedSourceUrl = sourceUrl(value.sourceUrl);
  if (provider === "geckoterminal") {
    if (!MINT_PATTERN.test(mint)) throw new TypeError("geckoterminal mint must be a Solana base58 address");
    if (pool !== null && !MINT_PATTERN.test(pool)) throw new TypeError("geckoterminal pool must be a Solana base58 address");
    if (!GECKOTERMINAL_STATUSES.has(status)) throw new TypeError("geckoterminal status is invalid");
    if (missingReason !== null && !GECKOTERMINAL_MISSING_REASONS.has(missingReason)) {
      throw new TypeError("geckoterminal missingReason is invalid");
    }
    if (errorCode !== null && !GECKOTERMINAL_ERROR_CODES.has(errorCode)) {
      throw new TypeError("geckoterminal errorCode is invalid");
    }
    if (normalizedSourceUrl !== null) {
      const parsed = new URL(normalizedSourceUrl);
      if (parsed.hostname !== "www.geckoterminal.com" || !parsed.pathname.startsWith("/solana/pools/")) {
        throw new TypeError("geckoterminal sourceUrl must identify a GeckoTerminal Solana pool page");
      }
    }
  }
  return {
    mint,
    provider,
    pool,
    tokenSide,
    dex: text(value.dex, "dex", { max: 64, optional: true, code: true }),
    sourceUrl: normalizedSourceUrl,
    evidenceJson: evidenceJson(value.evidence, { provider }),
    status,
    missingReason,
    errorCode,
    attemptCount,
    lastAttemptAt,
    nextAttemptAt,
    lastSuccessAt,
    updatedAt
  };
}

function normalizeRiskIdentityState(value, existing = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("risk identity state must be an object");
  const mint = text(value.mint, "mint", { max: 128 });
  const provider = text(value.provider, "provider", { max: 64, code: true });
  const status = text(value.status, "status", { max: 64, code: true });
  const lastAttemptAt = value.lastAttemptAt == null ? null : timestamp(value.lastAttemptAt, "lastAttemptAt");
  const inferredAttemptCount = value.attemptCount === undefined
    ? existing && lastAttemptAt === existing.lastAttemptAt ? existing.attemptCount : (existing?.attemptCount ?? 0) + 1
    : value.attemptCount;
  const attemptCount = boundedInteger(inferredAttemptCount, "attemptCount", { max: 2 });
  if ((attemptCount === 0) !== (lastAttemptAt === null)) throw new TypeError("lastAttemptAt must be null only when attemptCount is zero");
  const updatedAt = timestamp(value.updatedAt ?? value.lastAttemptAt, "updatedAt");
  const nextAttemptAt = value.nextAttemptAt == null ? null : timestamp(value.nextAttemptAt, "nextAttemptAt");
  const lastSuccessAt = value.lastSuccessAt == null ? null : timestamp(value.lastSuccessAt, "lastSuccessAt");
  if (lastAttemptAt && lastAttemptAt > updatedAt) throw new RangeError("lastAttemptAt must not be after updatedAt");
  if (lastSuccessAt && lastSuccessAt > updatedAt) throw new RangeError("lastSuccessAt must not be after updatedAt");
  const missingReason = (() => {
    const reason = text(value.missingReason, "missingReason", { max: 200, optional: true });
    if (reason && sensitiveText(reason)) throw new TypeError("missingReason must not contain credentials or secrets");
    return reason;
  })();
  const errorCode = text(value.errorCode, "errorCode", { max: 64, optional: true, code: true });
  if (provider === "geckoterminal") {
    if (!MINT_PATTERN.test(mint)) throw new TypeError("geckoterminal mint must be a Solana base58 address");
    if (!RISK_IDENTITY_STATUSES.has(status)) throw new TypeError("risk identity status is invalid");
    if (errorCode !== null && !GECKOTERMINAL_ERROR_CODES.has(errorCode)) throw new TypeError("risk identity errorCode is invalid");
  }
  return {
    mint,
    provider,
    evidenceJson: evidenceJson(provider === "geckoterminal"
      ? validateRiskIdentityPersistenceEvidence(value.evidence, { mint, status })
      : value.evidence),
    status,
    missingReason,
    errorCode,
    attemptCount,
    lastAttemptAt,
    nextAttemptAt,
    lastSuccessAt,
    updatedAt
  };
}

function rowEnrichment(row) {
  if (!row) return null;
  return {
    mint: row.mint, provider: row.provider, pool: row.pool, tokenSide: row.token_side, dex: row.dex,
    sourceUrl: row.source_url, evidence: JSON.parse(row.evidence), status: row.status,
    missingReason: row.missing_reason, errorCode: row.error_code, attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at, nextAttemptAt: row.next_attempt_at,
    lastSuccessAt: row.last_success_at, updatedAt: row.updated_at
  };
}

function rowRiskIdentityState(row) {
  if (!row) return null;
  return {
    mint: row.mint,
    provider: row.provider,
    evidence: JSON.parse(row.evidence),
    status: row.status,
    missingReason: row.missing_reason,
    errorCode: row.error_code,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at
  };
}

function sameEnrichment(candidate, current) {
  const fields = ["mint", "provider", "pool", "tokenSide", "dex", "sourceUrl", "status", "missingReason", "errorCode",
    "attemptCount", "lastAttemptAt", "nextAttemptAt", "lastSuccessAt", "updatedAt"];
  return fields.every((key) => candidate[key] === current[key]) &&
    candidate.evidenceJson === JSON.stringify(current.evidence);
}

function sameRiskIdentityState(candidate, current) {
  const fields = ["mint", "provider", "status", "missingReason", "errorCode", "attemptCount", "lastAttemptAt", "nextAttemptAt", "lastSuccessAt", "updatedAt"];
  return fields.every((key) => candidate[key] === current[key]) && candidate.evidenceJson === JSON.stringify(current.evidence);
}

function parsePayloadRows(rows) {
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.payload)]; } catch { return []; }
  });
}

function parseTokenRows(rows) {
  return rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload);
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? [{ ...payload, createdAt: row.created_at }]
        : [];
    } catch { return []; }
  });
}

function validateBriefModel(value, depth = 0) {
  if (depth > 10) throw new RangeError("brief model nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 500) throw new RangeError("brief model arrays are too large");
    for (const child of value) validateBriefModel(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("brief model must contain only JSON-compatible values");
  }
  const keys = Object.keys(value);
  if (keys.length > 100) throw new RangeError("brief model objects have too many keys");
  for (const key of keys) {
    if (SENSITIVE_KEY.test(key) || FORBIDDEN_BULK_KEY.test(key)) throw new TypeError(`brief model key is not allowed: ${key}`);
    validateBriefModel(value[key], depth + 1);
  }
}

function rowBriefRun(row) {
  if (!row) return null;
  return {
    briefKey: row.brief_key,
    kind: row.kind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    timezone: row.timezone,
    methodVersion: row.method_version,
    provider: row.provider,
    dataCutoff: row.data_cutoff,
    model: JSON.parse(row.model),
    createdAt: row.created_at
  };
}

function identityEvidence(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(["basis", "match", "source", "scope", "variantCount", "proposalKey"]);
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} key is not allowed: ${key}`);
    normalized[key] = key === "variantCount"
      ? boundedInteger(entry, `${label}.${key}`, { min: 0, max: 100 })
      : text(entry, `${label}.${key}`, { max: key === "proposalKey" ? 128 : 80, code: key !== "proposalKey" });
    if (typeof normalized[key] === "string" && SENSITIVE_KEY.test(normalized[key])) {
      throw new TypeError(`${label} must not contain credentials or secrets`);
    }
  }
  if (sensitiveText(JSON.stringify(normalized))) throw new TypeError(`${label} must not contain credentials or secrets`);
  return normalized;
}

function identityDecision(value, { subjectType, subjectId, defaultEvidence } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("identity decision must be an object");
  const normalizedSubjectType = text(subjectType ?? value.subjectType, "identity decision subjectType", { max: 24, code: true });
  if (!["entity", "relationship", "proposal"].includes(normalizedSubjectType)) throw new TypeError("identity decision subjectType is invalid");
  const normalizedSubjectId = text(subjectId ?? value.subjectId, "identity decision subjectId", { max: 160 });
  const normalizedDecision = text(value.decision, "identity decision", { max: 24, code: true });
  if (!["accept", "reject", "supersede", "split"].includes(normalizedDecision)) throw new TypeError("identity decision is invalid");
  return {
    decisionId: text(value.decisionId, "identity decisionId", { max: 128, code: true }),
    subjectType: normalizedSubjectType,
    subjectId: normalizedSubjectId,
    decision: normalizedDecision,
    reasonCode: text(value.reasonCode, "identity decision reasonCode", { max: 80, code: true }),
    evidence: identityEvidence(value.evidence ?? defaultEvidence ?? {}, "identity decision evidence"),
    decidedAt: timestamp(value.decidedAt, "identity decision decidedAt"),
    supersedesDecisionId: text(value.supersedesDecisionId, "identity decision supersedesDecisionId", { max: 128, optional: true, code: true })
  };
}

function requireEntityDecisionState(entity, decision) {
  if (decision.decision === "accept") {
    if (entity.reviewState !== "verified" || entity.variants.some(({ reviewState }) => reviewState !== "verified")) {
      throw new TypeError("accepted identity entities and variants must be verified");
    }
    return;
  }
  if (entity.reviewState !== "rejected" || entity.primaryMint !== null
    || entity.variants.some(({ reviewState }) => reviewState !== "rejected")) {
    throw new TypeError("rejected, split, or superseded identity entities must be fully rejected with no primary mint");
  }
}

function requireRelationshipDecisionState(relationship, decision) {
  const expected = decision.decision === "accept" ? "verified" : "rejected";
  if (relationship.reviewState !== expected) {
    throw new TypeError(`${decision.decision} identity relationships must be ${expected}`);
  }
}

function rowIdentityProposal(row) {
  if (!row) return null;
  let evidence = null;
  try { evidence = JSON.parse(row.evidence); } catch {}
  return {
    proposalKey: row.proposal_key,
    fromMint: row.from_mint,
    toMint: row.to_mint,
    kind: row.kind,
    evidenceClass: row.evidence_class,
    methodVersion: row.method_version,
    evidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function isPublishableIdentityProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isCanonicalSolanaAddress(value.fromMint) || !isCanonicalSolanaAddress(value.toMint)
    || value.fromMint === value.toMint
    || !["same-narrative", "name-collision"].includes(value.kind)
    || value.evidenceClass !== "locally-derived"
    || typeof value.methodVersion !== "string" || value.methodVersion.length < 1 || value.methodVersion.length > 80
    || !/^[a-z0-9][a-z0-9._:-]*$/.test(value.methodVersion)) return false;
  try { identityEvidence(value.evidence, "identity proposal evidence"); }
  catch { return false; }
  for (const candidate of [value.createdAt, value.updatedAt].filter((entry) => entry !== undefined)) {
    const parsed = typeof candidate === "string" ? Date.parse(candidate) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) return false;
  }
  return true;
}

export class Store {
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.function("is_canonical_solana_address", { deterministic: true, directOnly: true },
      (value) => isCanonicalSolanaAddress(value) ? 1 : 0);
    restrictDatabasePermissions(dbPath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      const existingVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version);
      if (existingVersion > STORE_SCHEMA_VERSION) {
        throw new Error(`Database schema version ${existingVersion} is newer than supported version ${STORE_SCHEMA_VERSION}`);
      }
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL,
        event_key TEXT, evidence_class TEXT NOT NULL DEFAULT 'unavailable', occurred_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT,
        kind TEXT NOT NULL DEFAULT 'legacy', evidence_class TEXT NOT NULL DEFAULT 'unavailable', evidence_at TEXT,
        dedupe_key TEXT, telegram_status TEXT, telegram_attempted_at TEXT, telegram_message_id INTEGER,
        telegram_attempt_count INTEGER NOT NULL DEFAULT 0, telegram_next_attempt_at TEXT, telegram_last_error_code TEXT,
        created_at TEXT NOT NULL,
        ${TELEGRAM_OUTBOX_CHECK_SQL}
      );
      CREATE TABLE IF NOT EXISTS callouts (
        external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS callouts_mint_created ON callouts(mint, created_at DESC);
      CREATE TABLE IF NOT EXISTS brief_runs (
        brief_key TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
        timezone TEXT NOT NULL, method_version TEXT NOT NULL, provider TEXT NOT NULL, data_cutoff TEXT NOT NULL,
        model TEXT NOT NULL CHECK(json_valid(model) AND json_type(model) = 'object'), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outcome_enrichment (
        mint TEXT PRIMARY KEY NOT NULL, provider TEXT, pool TEXT, token_side TEXT, dex TEXT, source_url TEXT,
        evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
        status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), last_attempt_at TEXT,
        next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL,
        CHECK(token_side IS NULL OR token_side IN ('base','quote'))
      );
      CREATE INDEX IF NOT EXISTS outcome_enrichment_provider_status_updated
        ON outcome_enrichment(provider, status, updated_at DESC, mint);
      CREATE INDEX IF NOT EXISTS outcome_enrichment_provider_due
        ON outcome_enrichment(provider, next_attempt_at, mint);
      CREATE TABLE IF NOT EXISTS risk_identity_enrichment (
        mint TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
        status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 2), last_attempt_at TEXT,
        next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS risk_identity_provider_status_updated
        ON risk_identity_enrichment(provider, status, updated_at DESC, mint);
      CREATE INDEX IF NOT EXISTS risk_identity_provider_due
        ON risk_identity_enrichment(provider, next_attempt_at, mint);
      CREATE TABLE IF NOT EXISTS actor_installation (
        id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
        secret BLOB NOT NULL CHECK(length(secret)=32),
        created_at TEXT NOT NULL,
        method_revision TEXT NOT NULL DEFAULT 'uninitialized'
      );
      CREATE TABLE IF NOT EXISTS actor_cohort (
        mint TEXT PRIMARY KEY NOT NULL,
        launch_observed_at TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','observing','available','unavailable','rate-limited','degraded','invalid-response','complete')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count>=0 AND attempt_count<=3),
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_success_at TEXT,
        missing_reason TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS actor_cohort_due ON actor_cohort(next_attempt_at,mint);
      CREATE INDEX IF NOT EXISTS actor_cohort_status_updated ON actor_cohort(status,updated_at DESC,mint);
      CREATE TABLE IF NOT EXISTS actor_observations (
        event_key TEXT PRIMARY KEY NOT NULL,
        mint TEXT NOT NULL,
        event TEXT NOT NULL CHECK(json_valid(event) AND json_type(event)='object'),
        source_at TEXT,
        observed_at TEXT NOT NULL,
        retained_until TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS actor_observations_mint_observed ON actor_observations(mint,observed_at,event_key);
      CREATE INDEX IF NOT EXISTS actor_observations_retention ON actor_observations(retained_until,event_key);
      CREATE TABLE IF NOT EXISTS actor_summaries (
        mint TEXT PRIMARY KEY NOT NULL,
        summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_entities (
        entity_id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        symbol TEXT,
        review_state TEXT NOT NULL CHECK(review_state IN ('proposed','verified','rejected')),
        primary_mint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_variants (
        mint TEXT PRIMARY KEY NOT NULL,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('official','migration','relaunch')),
        review_state TEXT NOT NULL CHECK(review_state IN ('proposed','verified','rejected')),
        evidence_class TEXT NOT NULL CHECK(evidence_class IN ('on-chain-finalized','provider-observed','feed-observed-processed','locally-derived','unavailable')),
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(entity_id) REFERENCES identity_entities(entity_id)
      );
      CREATE INDEX IF NOT EXISTS identity_variants_entity ON identity_variants(entity_id,mint);
      CREATE TABLE IF NOT EXISTS identity_relationships (
        relationship_id TEXT PRIMARY KEY NOT NULL,
        from_mint TEXT NOT NULL,
        to_mint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('same-creator','same-narrative','probable-copycat','name-collision')),
        review_state TEXT NOT NULL CHECK(review_state IN ('proposed','verified','rejected')),
        evidence_class TEXT NOT NULL CHECK(evidence_class IN ('on-chain-finalized','provider-observed','feed-observed-processed','locally-derived','unavailable')),
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(from_mint) REFERENCES identity_variants(mint),
        FOREIGN KEY(to_mint) REFERENCES identity_variants(mint),
        CHECK(from_mint<>to_mint)
      );
      CREATE INDEX IF NOT EXISTS identity_relationships_from ON identity_relationships(from_mint,updated_at DESC,relationship_id);
      CREATE INDEX IF NOT EXISTS identity_relationships_to ON identity_relationships(to_mint,updated_at DESC,relationship_id);
      CREATE TABLE IF NOT EXISTS identity_proposals (
        proposal_key TEXT PRIMARY KEY NOT NULL,
        from_mint TEXT NOT NULL,
        to_mint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('same-narrative','name-collision')),
        evidence_class TEXT NOT NULL CHECK(evidence_class='locally-derived'),
        method_version TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='object'),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(from_mint<>to_mint)
      );
      CREATE INDEX IF NOT EXISTS identity_proposals_status_updated ON identity_proposals(status,updated_at DESC,proposal_key);
      CREATE TABLE IF NOT EXISTS identity_decisions (
        decision_id TEXT PRIMARY KEY NOT NULL,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('entity','relationship','proposal')),
        subject_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('accept','reject','supersede','split')),
        reason_code TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='object'),
        decided_at TEXT NOT NULL,
        supersedes_decision_id TEXT,
        FOREIGN KEY(supersedes_decision_id) REFERENCES identity_decisions(decision_id)
      );
      CREATE INDEX IF NOT EXISTS identity_decisions_subject ON identity_decisions(subject_type,subject_id,decided_at,decision_id);
      `);
      const alertColumns = new Set(this.db.prepare("PRAGMA table_info(alerts)").all().map(({ name }) => name));
      for (const [name, definition] of [
        ["kind", "TEXT NOT NULL DEFAULT 'legacy'"],
        ["evidence_class", "TEXT NOT NULL DEFAULT 'unavailable'"],
        ["evidence_at", "TEXT"],
        ["dedupe_key", "TEXT"],
        ["telegram_status", "TEXT"],
        ["telegram_attempted_at", "TEXT"],
        ["telegram_message_id", "INTEGER"],
        ["telegram_attempt_count", "INTEGER NOT NULL DEFAULT 0"],
        ["telegram_next_attempt_at", "TEXT"],
        ["telegram_last_error_code", "TEXT"]
      ]) {
        if (!alertColumns.has(name)) this.db.exec(`ALTER TABLE alerts ADD COLUMN ${name} ${definition}`);
      }
      const eventColumns = new Set(this.db.prepare("PRAGMA table_info(events)").all().map(({ name }) => name));
      for (const [name, definition] of [
        ["event_key", "TEXT"],
        ["evidence_class", "TEXT NOT NULL DEFAULT 'unavailable'"],
        ["occurred_at", "TEXT"]
      ]) {
        if (!eventColumns.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
      }
      const actorInstallationColumns = new Set(this.db.prepare("PRAGMA table_info(actor_installation)").all().map(({ name }) => name));
      if (!actorInstallationColumns.has("method_revision")) {
        this.db.exec("ALTER TABLE actor_installation ADD COLUMN method_revision TEXT NOT NULL DEFAULT 'uninitialized'");
      }
      if (existingVersion > 0 && existingVersion < LEGACY_ACTOR_SCHEMA_VERSION) {
        this.db.exec(`
        ALTER TABLE events RENAME TO events_schema_legacy;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL,
          event_key TEXT, evidence_class TEXT NOT NULL DEFAULT 'unavailable', occurred_at TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO events (id,kind,mint,payload,event_key,evidence_class,occurred_at,created_at)
          SELECT id,kind,mint,payload,event_key,evidence_class,occurred_at,created_at FROM events_schema_legacy;
        DROP TABLE events_schema_legacy;
        ALTER TABLE alerts RENAME TO alerts_schema_legacy;
        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT,
          kind TEXT NOT NULL DEFAULT 'legacy', evidence_class TEXT NOT NULL DEFAULT 'unavailable', evidence_at TEXT,
          dedupe_key TEXT, telegram_status TEXT, telegram_attempted_at TEXT, telegram_message_id INTEGER,
          telegram_attempt_count INTEGER NOT NULL DEFAULT 0, telegram_next_attempt_at TEXT, telegram_last_error_code TEXT,
          created_at TEXT NOT NULL,
          ${TELEGRAM_OUTBOX_CHECK_SQL}
        );
        INSERT INTO alerts
          (id,level,title,message,mint,kind,evidence_class,evidence_at,dedupe_key,telegram_status,telegram_attempted_at,
           telegram_message_id,telegram_attempt_count,telegram_next_attempt_at,telegram_last_error_code,created_at)
          SELECT id,level,title,message,mint,kind,evidence_class,evidence_at,dedupe_key,telegram_status,telegram_attempted_at,
                 telegram_message_id,telegram_attempt_count,
                 CASE WHEN telegram_status IN ('pending','retrying')
                   AND NOT coalesce(${TELEGRAM_NEXT_ATTEMPT_IS_CANONICAL_SQL},0)
                   THEN CASE WHEN ${canonicalTimestampSql("created_at")} THEN created_at
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
                   ELSE telegram_next_attempt_at END,
                 telegram_last_error_code,created_at
          FROM alerts_schema_legacy;
        DROP TABLE alerts_schema_legacy;
        `);
      }
      this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedupe_key ON alerts(dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS alerts_mint_created ON alerts(mint, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_mint_created ON events(mint, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS events_event_key ON events(event_key) WHERE event_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS brief_runs_kind_period_end ON brief_runs(kind, period_end DESC);
      INSERT OR IGNORE INTO actor_installation (id,secret,created_at)
        VALUES (1,randomblob(32),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
      COMMIT;`);
      restrictDatabasePermissions(dbPath);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      try { this.db.close(); } catch {}
      throw error;
    }
    this.upsertStmt = this.db.prepare(`INSERT INTO tokens (mint,payload,created_at,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET
        payload=json_set(excluded.payload,'$.createdAt',tokens.created_at), updated_at=excluded.updated_at`);
    this.eventStmt = this.db.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)");
    this.intelligenceEventStmt = this.db.prepare(`INSERT OR IGNORE INTO events
      (kind,mint,payload,event_key,evidence_class,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)`);
    this.intelligenceEventExistsStmt = this.db.prepare("SELECT 1 AS present FROM events WHERE event_key=? LIMIT 1");
    this.alertStmt = this.db.prepare(`INSERT OR IGNORE INTO alerts
      (level,title,message,mint,kind,evidence_class,evidence_at,dedupe_key,telegram_status,telegram_attempted_at,telegram_message_id,
       telegram_attempt_count,telegram_next_attempt_at,telegram_last_error_code,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.alertDeliveryQueueStmt = this.db.prepare(`UPDATE alerts SET telegram_status='pending',telegram_next_attempt_at=?,telegram_last_error_code=NULL
      WHERE id=? AND telegram_status IS NULL`);
    this.alertDeliveryAttemptStmt = this.db.prepare(`UPDATE alerts SET telegram_status=?,telegram_attempted_at=?,telegram_message_id=?,
      telegram_attempt_count=telegram_attempt_count+1,telegram_next_attempt_at=?,telegram_last_error_code=? WHERE id=?`);
    this.alertDeliveryDueStmt = this.db.prepare(`SELECT id,level,title,message,mint,kind,evidence_class AS evidenceClass,
      evidence_at AS evidenceAt,dedupe_key AS dedupeKey,telegram_status AS telegramStatus,
      telegram_attempted_at AS telegramAttemptedAt,telegram_message_id AS telegramMessageId,
      telegram_attempt_count AS telegramAttemptCount,telegram_next_attempt_at AS telegramNextAttemptAt,
      telegram_last_error_code AS telegramLastErrorCode,created_at AS createdAt
      FROM alerts WHERE telegram_status IN ('pending','retrying') AND telegram_next_attempt_at<=?
      ORDER BY telegram_next_attempt_at ASC,id ASC LIMIT ?`);
    this.eventListStmt = this.db.prepare(`SELECT kind,mint,payload,event_key AS eventKey,evidence_class AS evidenceClass,
      occurred_at AS occurredAt,created_at AS createdAt FROM events
      WHERE mint=? ORDER BY id DESC LIMIT ?`);
    this.alertMintListStmt = this.db.prepare(`SELECT id,level,title,message,mint,kind,evidence_class AS evidenceClass,
      evidence_at AS evidenceAt,dedupe_key AS dedupeKey,telegram_status AS telegramStatus,
      telegram_attempted_at AS telegramAttemptedAt,telegram_message_id AS telegramMessageId,
      telegram_attempt_count AS telegramAttemptCount,telegram_next_attempt_at AS telegramNextAttemptAt,
      telegram_last_error_code AS telegramLastErrorCode,created_at AS createdAt
      FROM alerts WHERE mint=? ORDER BY id DESC LIMIT ?`);
    this.calloutStmt = this.db.prepare(`INSERT INTO callouts (external_id,mint,payload,created_at)
      VALUES (?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload`);
    this.calloutMintListStmt = this.db.prepare(`SELECT payload FROM callouts WHERE mint=? ORDER BY created_at DESC LIMIT ?`);
    this.identityProposalInsertStmt = this.db.prepare(`INSERT INTO identity_proposals
      (proposal_key,from_mint,to_mint,kind,evidence_class,method_version,evidence,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_key) DO UPDATE SET
        updated_at=CASE WHEN identity_proposals.status='pending' THEN excluded.updated_at ELSE identity_proposals.updated_at END`);
    this.briefInsertStmt = this.db.prepare(`INSERT OR IGNORE INTO brief_runs
      (brief_key,kind,period_start,period_end,timezone,method_version,provider,data_cutoff,model,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    this.briefByKeyStmt = this.db.prepare("SELECT * FROM brief_runs WHERE brief_key=?");
    this.briefLatestStmt = this.db.prepare(`SELECT * FROM brief_runs WHERE kind=?
      ORDER BY period_end DESC,created_at DESC,brief_key DESC LIMIT 1`);
    this.enrichmentSelectStmt = this.db.prepare("SELECT * FROM outcome_enrichment WHERE mint=?");
    this.enrichmentInsertStmt = this.db.prepare(`INSERT INTO outcome_enrichment
      (mint,provider,pool,token_side,dex,source_url,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.enrichmentUpdateStmt = this.db.prepare(`UPDATE outcome_enrichment SET
      provider=?,pool=?,token_side=?,dex=?,source_url=?,evidence=?,status=?,missing_reason=?,error_code=?,
      attempt_count=?,last_attempt_at=?,next_attempt_at=?,last_success_at=?,updated_at=? WHERE mint=?`);
    this.enrichmentListStmt = this.db.prepare(`SELECT * FROM outcome_enrichment
      WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
      ORDER BY updated_at DESC, mint ASC LIMIT ?`);
    this.enrichmentCoverageStmt = this.db.prepare(`SELECT count(*) AS state_count,
        count(pool) AS provider_selected_count,
        sum(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS success_count,
        min(updated_at) AS first_updated_at, max(updated_at) AS last_updated_at
      FROM outcome_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)`);
    this.enrichmentStatusCoverageStmt = this.db.prepare(`SELECT status,count(*) AS count
      FROM outcome_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
      GROUP BY status ORDER BY status ASC`);
    this.enrichmentDueTokensStmt = this.db.prepare(`SELECT tokens.payload,tokens.created_at
      FROM outcome_enrichment
      JOIN tokens ON tokens.mint=outcome_enrichment.mint
      WHERE outcome_enrichment.provider=? AND outcome_enrichment.next_attempt_at IS NOT NULL
        AND outcome_enrichment.next_attempt_at<=?
      ORDER BY outcome_enrichment.next_attempt_at ASC,outcome_enrichment.mint ASC LIMIT ?`);
    this.enrichmentDeleteProviderStmt = this.db.prepare("DELETE FROM outcome_enrichment WHERE provider=?");
    this.riskIdentitySelectStmt = this.db.prepare("SELECT * FROM risk_identity_enrichment WHERE mint=?");
    this.riskIdentityInsertStmt = this.db.prepare(`INSERT INTO risk_identity_enrichment
      (mint,provider,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    this.riskIdentityUpdateStmt = this.db.prepare(`UPDATE risk_identity_enrichment SET
      provider=?,evidence=?,status=?,missing_reason=?,error_code=?,attempt_count=?,last_attempt_at=?,next_attempt_at=?,last_success_at=?,updated_at=? WHERE mint=?`);
    this.riskIdentityListStmt = this.db.prepare(`SELECT * FROM risk_identity_enrichment
      WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
      ORDER BY updated_at DESC, mint ASC LIMIT ?`);
    this.riskIdentityCoverageStmt = this.db.prepare(`SELECT count(*) AS state_count,
        sum(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS success_count,
        min(updated_at) AS first_updated_at, max(updated_at) AS last_updated_at
      FROM risk_identity_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)`);
    this.riskIdentityStatusCoverageStmt = this.db.prepare(`SELECT status,count(*) AS count
      FROM risk_identity_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
      GROUP BY status ORDER BY status ASC`);
    this.riskIdentityErrorCoverageStmt = this.db.prepare(`SELECT error_code,count(*) AS count
      FROM risk_identity_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
        AND error_code IS NOT NULL
      GROUP BY error_code ORDER BY error_code ASC`);
    this.riskIdentityInvalidAcquisitionCoverageStmt = this.db.prepare(`SELECT count(*) AS count
      FROM risk_identity_enrichment WHERE (? IS NULL OR provider=?) AND (? IS NULL OR status=?)
        AND (status='invalid-response' OR error_code LIKE 'invalid-%' OR error_code='token-mismatch')`);
    this.riskIdentityDueTokensStmt = this.db.prepare(`SELECT tokens.payload,tokens.created_at
      FROM risk_identity_enrichment
      JOIN tokens ON tokens.mint=risk_identity_enrichment.mint
      WHERE risk_identity_enrichment.provider=? AND risk_identity_enrichment.next_attempt_at IS NOT NULL
        AND risk_identity_enrichment.next_attempt_at<=?
      ORDER BY risk_identity_enrichment.next_attempt_at ASC,risk_identity_enrichment.mint ASC LIMIT ?`);
    this.sourceCountStmts = {
      tokens: this.db.prepare(`SELECT count(*) AS count FROM tokens
        WHERE ${canonicalTokenRowPredicate()} AND json_extract(payload, '$.source') = ?`),
      events: this.db.prepare(`SELECT count(*) AS count FROM events
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`),
      alerts: this.db.prepare(`SELECT count(*) AS count FROM alerts
        WHERE mint IN (
          SELECT mint FROM tokens
          WHERE ${canonicalTokenRowPredicate()} AND json_extract(payload, '$.source') = ?
        )`)
    };
    this.sourceTokenCountSinceStmt = this.db.prepare(`SELECT count(*) AS count FROM tokens
      WHERE created_at >= ?
        AND ${canonicalTokenRowPredicate()} AND json_extract(payload, '$.source') = ?`);
    this.deleteDemoStmts = {
      alerts: this.db.prepare(`DELETE FROM alerts
        WHERE mint IN (
          SELECT mint FROM tokens
          WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'
        )`),
      events: this.db.prepare(`DELETE FROM events
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'`),
      tokens: this.db.prepare(`DELETE FROM tokens
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'`)
    };
    this.identityRegistrySnapshotCache = new Map();
    this.identityResolverSnapshotCache = new Map();
    this.identityRegistryCoverageCache = null;
    this.tokenIntegrityCoverageCache = new Map();
    this.cacheDataVersion = Number(this.db.prepare("PRAGMA data_version").get().data_version);
  }
  upsertToken(token) {
    const now = new Date().toISOString();
    const createdAt = token.createdAt || now;
    this.upsertStmt.run(token.mint, JSON.stringify({ ...token, createdAt }), createdAt, now);
  }
  addEvent(kind, payload) {
    this.eventStmt.run(kind, payload.mint || null, JSON.stringify(payload), new Date().toISOString());
  }
  upsertTokenWithAlerts(token, { eventKind, alerts = [], queueTelegram = false } = {}) {
    if (!token || typeof token !== "object" || Array.isArray(token) || !isCanonicalSolanaAddress(token.mint)) {
      throw new TypeError("token must be an object with a canonical 32-byte Solana mint");
    }
    const normalizedEventKind = text(eventKind, "event kind", { max: 64, code: true }).toLowerCase();
    if (!Array.isArray(alerts) || alerts.length > 20) throw new RangeError("alerts must be an array of at most 20 entries");
    if (typeof queueTelegram !== "boolean") throw new TypeError("queueTelegram must be boolean");
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.upsertToken(token);
      this.addEvent(normalizedEventKind, token);
      const savedAlerts = alerts.flatMap((candidate) => {
        const saved = this.addAlert(candidate, { queueTelegram });
        return saved ? [saved] : [];
      });
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { token: this.token(token.mint), alerts: savedAlerts };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  addIntelligenceEvent({ kind, mint, eventKey, evidenceClass, occurredAt, payload } = {}) {
    const normalizedKind = text(kind, "intelligence event kind", { max: 64, code: true }).toLowerCase();
    const normalizedMint = text(mint, "intelligence event mint", { max: 128 });
    const normalizedEventKey = text(eventKey, "intelligence event key", { max: 320 });
    const normalizedEvidenceClass = text(evidenceClass, "intelligence event evidence class", { max: 40, code: true }).toLowerCase();
    if (!["provider-observed", "feed-observed-processed", "locally-derived", "unavailable", "synthetic"].includes(normalizedEvidenceClass)) {
      throw new TypeError("intelligence event evidence class is invalid");
    }
    const normalizedOccurredAt = timestamp(occurredAt, "intelligence event occurredAt");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("intelligence event payload must be an object");
    const allowedKeys = new Set(["mint", "factor", "value", "unit", "source", "limitation"]);
    for (const key of Object.keys(payload)) if (!allowedKeys.has(key)) throw new TypeError(`intelligence event payload key is not allowed: ${key}`);
    if (payload.mint !== normalizedMint) throw new TypeError("intelligence event payload mint must match");
    const normalizedPayload = {
      mint: normalizedMint,
      factor: text(payload.factor, "intelligence event factor", { max: 64, code: true }).toLowerCase(),
      value: payload.value == null ? null : typeof payload.value === "number" && Number.isFinite(payload.value) ? payload.value
        : text(payload.value, "intelligence event value", { max: 120 }),
      unit: text(payload.unit, "intelligence event unit", { max: 32, optional: true }),
      source: text(payload.source, "intelligence event source", { max: 64, code: true }).toLowerCase(),
      limitation: text(payload.limitation, "intelligence event limitation", { max: 320 })
    };
    if (sensitiveText(JSON.stringify(normalizedPayload))) throw new TypeError("intelligence event payload must not contain credentials or secrets");
    const createdAt = new Date().toISOString();
    const result = this.intelligenceEventStmt.run(normalizedKind, normalizedMint, JSON.stringify(normalizedPayload), normalizedEventKey,
      normalizedEvidenceClass, normalizedOccurredAt, createdAt);
    return { written: result.changes === 1, eventKey: normalizedEventKey, occurredAt: normalizedOccurredAt };
  }
  hasIntelligenceEvent(eventKey) {
    const normalizedEventKey = text(eventKey, "intelligence event key", { max: 320 });
    return Boolean(this.intelligenceEventExistsStmt.get(normalizedEventKey));
  }
  commitIntelligenceBatch({ events = [], alerts = [], queueTelegram = false } = {}) {
    if (!Array.isArray(events) || events.length > 1_000) throw new RangeError("events must be an array of at most 1000 entries");
    if (!Array.isArray(alerts) || alerts.length > 1_000) throw new RangeError("alerts must be an array of at most 1000 entries");
    if (typeof queueTelegram !== "boolean") throw new TypeError("queueTelegram must be boolean");
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const writtenEvents = events.reduce((count, event) => count + (this.addIntelligenceEvent(event).written ? 1 : 0), 0);
      const savedAlerts = alerts.flatMap((candidate) => {
        const saved = this.addAlert(candidate, { queueTelegram });
        return saved ? [saved] : [];
      });
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { writtenEvents, alerts: savedAlerts };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  addAlert(alert, { queueTelegram = false } = {}) {
    if (!alert || typeof alert !== "object" || Array.isArray(alert)) throw new TypeError("alert must be an object");
    const level = text(alert.level, "alert.level", { max: 24, code: true });
    const title = text(alert.title, "alert.title", { max: 96 });
    const message = text(alert.message, "alert.message", { max: 640 });
    const alertMint = text(alert.mint, "alert.mint", { max: 128, optional: true });
    const kind = text(alert.kind ?? "legacy", "alert.kind", { max: 64, code: true }).toLowerCase();
    const evidenceClass = text(alert.evidenceClass ?? "unavailable", "alert.evidenceClass", { max: 40, code: true }).toLowerCase();
    if (!["provider-observed", "feed-observed-processed", "locally-derived", "unavailable", "synthetic"].includes(evidenceClass)) {
      throw new TypeError("alert.evidenceClass is invalid");
    }
    const createdAt = timestamp(alert.createdAt || new Date().toISOString(), "alert.createdAt");
    const evidenceAt = alert.evidenceAt == null ? null : timestamp(alert.evidenceAt, "alert.evidenceAt");
    const dedupeKey = text(alert.dedupeKey, "alert.dedupeKey", { max: 320, optional: true });
    if (typeof queueTelegram !== "boolean") throw new TypeError("queueTelegram must be boolean");
    const telegramStatus = queueTelegram ? "pending" : null;
    const telegramNextAttemptAt = queueTelegram ? createdAt : null;
    const result = this.alertStmt.run(level, title, message, alertMint, kind, evidenceClass, evidenceAt, dedupeKey,
      telegramStatus, null, null, 0, telegramNextAttemptAt, null, createdAt);
    if (result.changes === 0) return null;
    return {
      id: Number(result.lastInsertRowid), level, title, message, mint: alertMint, kind,
      evidenceClass, evidenceAt, dedupeKey, telegramStatus,
      telegramAttemptedAt: null, telegramMessageId: null, telegramAttemptCount: 0,
      telegramNextAttemptAt, telegramLastErrorCode: null, createdAt
    };
  }
  queueAlertTelegramDelivery(id, { nextAttemptAt = new Date().toISOString() } = {}) {
    const normalizedId = boundedInteger(id, "alert id", { min: 1 });
    const normalizedNextAttemptAt = timestamp(nextAttemptAt, "Telegram nextAttemptAt");
    const result = this.alertDeliveryQueueStmt.run(normalizedNextAttemptAt, normalizedId);
    if (result.changes !== 1) throw new RangeError("alert id does not exist or is already queued");
    return { id: normalizedId, status: "pending", nextAttemptAt: normalizedNextAttemptAt };
  }
  recordAlertTelegramAttempt(id, status, {
    attemptedAt = new Date().toISOString(), messageId = null, nextAttemptAt = null, errorCode = null
  } = {}) {
    const normalizedId = boundedInteger(id, "alert id", { min: 1 });
    const normalizedStatus = text(status, "Telegram delivery status", { max: 24, code: true }).toLowerCase();
    if (!["sent", "retrying", "dead-letter"].includes(normalizedStatus)) throw new TypeError("Telegram delivery status is invalid");
    const normalizedAttemptedAt = timestamp(attemptedAt, "Telegram attemptedAt");
    const normalizedMessageId = messageId == null ? null : boundedInteger(messageId, "Telegram message id", { min: 1 });
    if (normalizedStatus === "sent" && normalizedMessageId === null) throw new TypeError("sent Telegram delivery requires a message id");
    if (normalizedStatus !== "sent" && normalizedMessageId !== null) throw new TypeError("unsent Telegram delivery must not retain a message id");
    const normalizedNextAttemptAt = nextAttemptAt == null ? null : timestamp(nextAttemptAt, "Telegram nextAttemptAt");
    const normalizedErrorCode = text(errorCode, "Telegram error code", { max: 64, optional: true, code: true })?.toLowerCase() ?? null;
    if (normalizedStatus === "retrying" && (normalizedNextAttemptAt === null || normalizedErrorCode === null)) {
      throw new TypeError("retrying Telegram delivery requires nextAttemptAt and errorCode");
    }
    if (normalizedStatus === "dead-letter" && (normalizedNextAttemptAt !== null || normalizedErrorCode === null)) {
      throw new TypeError("dead-letter Telegram delivery requires errorCode and no nextAttemptAt");
    }
    if (normalizedStatus === "sent" && (normalizedNextAttemptAt !== null || normalizedErrorCode !== null)) {
      throw new TypeError("sent Telegram delivery must not retain retry evidence");
    }
    const result = this.alertDeliveryAttemptStmt.run(normalizedStatus, normalizedAttemptedAt, normalizedMessageId,
      normalizedNextAttemptAt, normalizedErrorCode, normalizedId);
    if (result.changes !== 1) throw new RangeError("alert id does not exist");
    return { id: normalizedId, status: normalizedStatus, attemptedAt: normalizedAttemptedAt,
      messageId: normalizedMessageId, nextAttemptAt: normalizedNextAttemptAt, errorCode: normalizedErrorCode };
  }
  dueTelegramAlerts({ now = new Date().toISOString(), limit = 20 } = {}) {
    const normalizedNow = timestamp(now, "Telegram queue now");
    const normalizedLimit = boundedInteger(limit, "Telegram queue limit", { min: 1, max: 100 });
    return this.alertDeliveryDueStmt.all(normalizedNow, normalizedLimit);
  }
  telegramDeliveryCoverage() {
    const materialKindPlaceholders = MATERIAL_ALERT_KINDS.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT coalesce(telegram_status,'not-queued') AS status,count(*) AS count
      FROM alerts WHERE kind IN (${materialKindPlaceholders})
      GROUP BY coalesce(telegram_status,'not-queued') ORDER BY status`).all(...MATERIAL_ALERT_KINDS);
    return { total: rows.reduce((total, row) => total + Number(row.count), 0), statusCounts: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])) };
  }
  upsertCallout(callout) {
    const payload = { ...callout };
    delete payload.externalId;
    this.calloutStmt.run(callout.externalId, callout.mint, JSON.stringify(payload), callout.createdAt);
  }
  sanitizeLegacyCalloutProfiles(project) {
    if (typeof project !== "function") throw new TypeError("callout projection must be a function");
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      let callouts = 0;
      let events = 0;
      for (const row of this.db.prepare("SELECT external_id,payload FROM callouts ORDER BY external_id").all()) {
        let value;
        try { value = JSON.parse(row.payload); } catch { continue; }
        const sanitized = project(value);
        if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) continue;
        delete sanitized.externalId;
        const payload = JSON.stringify(sanitized);
        if (payload !== row.payload) {
          this.db.prepare("UPDATE callouts SET payload=? WHERE external_id=?").run(payload, row.external_id);
          callouts++;
        }
      }
      for (const row of this.db.prepare("SELECT id,payload FROM events WHERE kind='callout' ORDER BY id").all()) {
        let value;
        try { value = JSON.parse(row.payload); } catch { continue; }
        const sanitized = project(value);
        if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) continue;
        delete sanitized.externalId;
        const payload = JSON.stringify(sanitized);
        if (payload !== row.payload) {
          this.db.prepare("UPDATE events SET payload=? WHERE id=?").run(payload, row.id);
          events++;
        }
      }
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { callouts, events };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  upsertEnrichmentState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("enrichment state must be an object");
    const mint = text(state.mint, "mint", { max: 128 });
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const row = this.enrichmentSelectStmt.get(mint);
      const current = rowEnrichment(row);
      const candidate = normalizeEnrichment({ ...state, mint }, current);
      if (current && candidate.updatedAt < current.updatedAt) {
        this.db.exec("COMMIT");
        transactionStarted = false;
        return { written: false, stale: true, state: current };
      }
      if (current && candidate.attemptCount < current.attemptCount) {
        throw new RangeError("attemptCount must not decrease");
      }
      if (current && candidate.updatedAt === current.updatedAt) {
        if (!sameEnrichment(candidate, current)) {
          throw new TypeError(`conflicting enrichment state for ${candidate.mint} at ${candidate.updatedAt}`);
        }
        this.db.exec("COMMIT");
        transactionStarted = false;
        return { written: false, stale: false, state: current };
      }
      const values = [candidate.provider, candidate.pool, candidate.tokenSide, candidate.dex, candidate.sourceUrl,
        candidate.evidenceJson, candidate.status, candidate.missingReason, candidate.errorCode, candidate.attemptCount,
        candidate.lastAttemptAt, candidate.nextAttemptAt, candidate.lastSuccessAt, candidate.updatedAt];
      if (current) this.enrichmentUpdateStmt.run(...values, candidate.mint);
      else this.enrichmentInsertStmt.run(candidate.mint, ...values);
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { written: true, stale: false, state: this.enrichmentState(candidate.mint) };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  upsertRiskIdentityState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("risk identity state must be an object");
    const mint = text(state.mint, "mint", { max: 128 });
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const current = rowRiskIdentityState(this.riskIdentitySelectStmt.get(mint));
      const candidate = normalizeRiskIdentityState({ ...state, mint }, current);
      if (current && candidate.updatedAt < current.updatedAt) {
        this.db.exec("COMMIT");
        transactionStarted = false;
        return { written: false, stale: true, state: current };
      }
      if (current && candidate.attemptCount < current.attemptCount) throw new RangeError("attemptCount must not decrease");
      if (current && candidate.updatedAt === current.updatedAt) {
        if (!sameRiskIdentityState(candidate, current)) throw new TypeError(`conflicting risk identity state for ${candidate.mint} at ${candidate.updatedAt}`);
        this.db.exec("COMMIT");
        transactionStarted = false;
        return { written: false, stale: false, state: current };
      }
      const values = [candidate.provider, candidate.evidenceJson, candidate.status, candidate.missingReason, candidate.errorCode,
        candidate.attemptCount, candidate.lastAttemptAt, candidate.nextAttemptAt, candidate.lastSuccessAt, candidate.updatedAt];
      if (current) this.riskIdentityUpdateStmt.run(...values, candidate.mint);
      else this.riskIdentityInsertStmt.run(candidate.mint, ...values);
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { written: true, stale: false, state: this.riskIdentityState(candidate.mint) };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  riskIdentityState(mint) {
    return rowRiskIdentityState(this.riskIdentitySelectStmt.get(text(mint, "mint", { max: 128 })));
  }
  riskIdentityStates({ provider = null, status = null, limit = 100 } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, optional: true, code: true });
    const normalizedStatus = text(status, "status", { max: 64, optional: true, code: true });
    const normalizedLimit = boundedInteger(limit, "limit", { min: 1, max: MAX_ENRICHMENT_QUERY });
    return this.riskIdentityListStmt.all(normalizedProvider, normalizedProvider, normalizedStatus, normalizedStatus, normalizedLimit).map(rowRiskIdentityState);
  }
  riskIdentityCoverage({ provider = null, status = null } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, optional: true, code: true });
    const normalizedStatus = text(status, "status", { max: 64, optional: true, code: true });
    const bindings = [normalizedProvider, normalizedProvider, normalizedStatus, normalizedStatus];
    const row = this.riskIdentityCoverageStmt.get(...bindings);
    const statusCounts = Object.fromEntries(this.riskIdentityStatusCoverageStmt.all(...bindings).map(({ status: name, count }) => [name, Number(count)]));
    const errorCodeCounts = Object.fromEntries(this.riskIdentityErrorCoverageStmt.all(...bindings).map(({ error_code: name, count }) => [name, Number(count)]));
    const invalidAcquisitionCount = Number(this.riskIdentityInvalidAcquisitionCoverageStmt.get(...bindings).count);
    return {
      provider: normalizedProvider,
      status: normalizedStatus,
      stateCount: Number(row.state_count),
      successCount: Number(row.success_count || 0),
      firstUpdatedAt: row.first_updated_at,
      lastUpdatedAt: row.last_updated_at,
      statusCounts,
      errorCodeCounts,
      invalidAcquisitionCount
    };
  }
  dueRiskIdentityTokens({ provider, now = new Date().toISOString(), limit = 100 } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, code: true });
    const normalizedNow = timestamp(now, "now");
    const normalizedLimit = boundedInteger(limit, "limit", { min: 1, max: MAX_ENRICHMENT_QUERY });
    return parseTokenRows(this.riskIdentityDueTokensStmt.all(normalizedProvider, normalizedNow, normalizedLimit));
  }
  enrichmentState(mint) {
    return rowEnrichment(this.enrichmentSelectStmt.get(text(mint, "mint", { max: 128 })));
  }
  enrichmentStates({ provider = null, status = null, limit = 100 } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, optional: true, code: true });
    const normalizedStatus = text(status, "status", { max: 64, optional: true, code: true });
    const normalizedLimit = boundedInteger(limit, "limit", { min: 1, max: MAX_ENRICHMENT_QUERY });
    return this.enrichmentListStmt.all(normalizedProvider, normalizedProvider, normalizedStatus, normalizedStatus, normalizedLimit)
      .map(rowEnrichment);
  }
  outcomeCoverage({ provider = null, status = null } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, optional: true, code: true });
    const normalizedStatus = text(status, "status", { max: 64, optional: true, code: true });
    const bindings = [normalizedProvider, normalizedProvider, normalizedStatus, normalizedStatus];
    const row = this.enrichmentCoverageStmt.get(...bindings);
    const statusCounts = Object.fromEntries(this.enrichmentStatusCoverageStmt.all(...bindings)
      .map(({ status: statusName, count }) => [statusName, Number(count)]));
    return {
      provider: normalizedProvider, status: normalizedStatus, stateCount: Number(row.state_count),
      providerSelectedCount: Number(row.provider_selected_count), successCount: Number(row.success_count || 0),
      firstUpdatedAt: row.first_updated_at, lastUpdatedAt: row.last_updated_at, statusCounts
    };
  }
  dueEnrichmentTokens({ provider, now = new Date().toISOString(), limit = 100 } = {}) {
    const normalizedProvider = text(provider, "provider", { max: 64, code: true });
    const normalizedNow = timestamp(now, "now");
    const normalizedLimit = boundedInteger(limit, "limit", { min: 1, max: MAX_ENRICHMENT_QUERY });
    return parseTokenRows(this.enrichmentDueTokensStmt.all(normalizedProvider, normalizedNow, normalizedLimit));
  }
  deleteEnrichmentByProvider(provider) {
    const normalizedProvider = text(provider, "provider", { max: 64, code: true });
    let transactionStarted = false;
    let switchedToDeleteJournal = false;
    try {
      const initialCheckpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (initialCheckpoint.busy !== 0 || initialCheckpoint.log !== 0 || initialCheckpoint.checkpointed !== 0) {
        throw new Error("SQLite WAL could not be exclusively checkpointed before purge");
      }
      const deleteJournal = this.db.prepare("PRAGMA journal_mode=DELETE").get().journal_mode;
      if (deleteJournal !== "delete") throw new Error("SQLite journal could not enter exclusive purge mode");
      switchedToDeleteJournal = true;
      const lockingMode = this.db.prepare("PRAGMA locking_mode=EXCLUSIVE").get().locking_mode;
      if (lockingMode !== "exclusive") throw new Error("SQLite could not acquire exclusive purge locking mode");
      this.db.exec("PRAGMA secure_delete = ON");
      if (this.db.prepare("PRAGMA secure_delete").get().secure_delete !== 1) {
        throw new Error("SQLite secure_delete could not be enabled");
      }
      this.db.exec("BEGIN EXCLUSIVE");
      transactionStarted = true;
      const removedOutcomes = this.db.prepare("DELETE FROM outcome_enrichment WHERE provider=?").run(normalizedProvider).changes;
      const removedRiskIdentity = this.db.prepare("DELETE FROM risk_identity_enrichment WHERE provider=?").run(normalizedProvider).changes;
      const removedEvents = this.db.prepare(`DELETE FROM events WHERE ?='geckoterminal' AND kind='risk-evidence'
        AND json_valid(payload) AND (json_extract(payload,'$.source')='geckoterminal'
          OR json_extract(payload,'$.factor') IN ('identity-reuse','creator-history'))`).run(normalizedProvider).changes;
      const removedAlerts = this.db.prepare("DELETE FROM alerts WHERE ?='geckoterminal' AND kind LIKE 'risk-%'").run(normalizedProvider).changes;
      const removedBriefs = this.db.prepare("DELETE FROM brief_runs WHERE provider=?").run(normalizedProvider).changes;
      const removed = removedOutcomes + removedRiskIdentity + removedEvents + removedAlerts + removedBriefs;
      this.db.exec("COMMIT");
      transactionStarted = false;
      this.db.exec("VACUUM");
      const freelistCount = this.db.prepare("PRAGMA freelist_count").get().freelist_count;
      if (freelistCount !== 0) throw new Error("SQLite purge vacuum left reusable pages behind");
      const normalLocking = this.db.prepare("PRAGMA locking_mode=NORMAL").get().locking_mode;
      if (normalLocking !== "normal") throw new Error("SQLite locking mode could not be restored");
      const walJournal = this.db.prepare("PRAGMA journal_mode=WAL").get().journal_mode;
      if (walJournal !== "wal") throw new Error("SQLite WAL journal mode could not be restored");
      switchedToDeleteJournal = false;
      const finalCheckpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (finalCheckpoint.busy !== 0 || finalCheckpoint.log !== 0 || finalCheckpoint.checkpointed !== 0) {
        throw new Error("SQLite WAL could not be verified empty after purge");
      }
      restrictDatabasePermissions(this.dbPath);
      return {
        provider: normalizedProvider,
        removed,
        removedOutcomes,
        removedRiskIdentity,
        removedEvents,
        removedAlerts,
        removedBriefs,
        exclusiveAccessVerified: true,
        secureDelete: true,
        vacuumed: true,
        freelistCount,
        walTruncated: true,
        journalModeRestored: "wal"
      };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      if (switchedToDeleteJournal) {
        try { this.db.prepare("PRAGMA locking_mode=NORMAL").get(); } catch {}
        try { this.db.prepare("PRAGMA journal_mode=WAL").get(); } catch {}
      }
      throw new Error(`Provider purge requires exclusive database access and verified SQLite cleanup: ${error.message}`, { cause: error });
    }
  }
  #publishedIdentityCounts() {
    const entities = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_entities e
      WHERE e.review_state='verified' AND EXISTS (
        SELECT 1 FROM identity_variants v WHERE v.entity_id=e.entity_id AND v.review_state='verified'
      ) AND (
        SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
      )='accept'`).get().count);
    const variants = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_variants v
      JOIN identity_entities e ON e.entity_id=v.entity_id
      WHERE v.review_state<>'rejected' AND e.review_state='verified' AND (
        SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
      )='accept'`).get().count);
    const relationships = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint
      CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint
      CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
        AND ef.review_state='verified' AND et.review_state='verified'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'`).get().count);
    return { entities, variants, relationships };
  }
  #assertIdentityCapacity(before) {
    const after = this.#publishedIdentityCounts();
    for (const key of Object.keys(IDENTITY_REGISTRY_CAPACITY)) {
      const maximum = Math.max(IDENTITY_REGISTRY_CAPACITY[key], before[key]);
      if (after[key] > maximum) {
        throw new RangeError(`identity registry ${key} capacity ${IDENTITY_REGISTRY_CAPACITY[key]} would be exceeded`);
      }
    }
    return after;
  }
  identityRegistrySnapshot({ prioritizeMint = null, prioritizeMints = [] } = {}) {
    this.#refreshCacheCoherence();
    if (prioritizeMint !== null && !isCanonicalSolanaAddress(prioritizeMint)) throw new TypeError("identity registry prioritized mint is invalid");
    if (!Array.isArray(prioritizeMints) || prioritizeMints.length > 500
      || prioritizeMints.some((mint) => !isCanonicalSolanaAddress(mint))) {
      throw new TypeError("identity registry prioritized mints are invalid");
    }
    const requestedPriorityMints = [...new Set([...(prioritizeMint === null ? [] : [prioritizeMint]), ...prioritizeMints])];
    if (prioritizeMint !== null) {
      const cachedResolverSnapshot = this.identityResolverSnapshotCache.get(prioritizeMint);
      if (cachedResolverSnapshot && cachedResolverSnapshot.expiresAt > Date.now()) return cachedResolverSnapshot.value;
      if (cachedResolverSnapshot) this.identityResolverSnapshotCache.delete(prioritizeMint);
    }
    const snapshotCacheKey = prioritizeMint === null ? JSON.stringify(requestedPriorityMints) : null;
    if (snapshotCacheKey !== null && this.identityRegistrySnapshotCache.has(snapshotCacheKey)) {
      return this.identityRegistrySnapshotCache.get(snapshotCacheKey);
    }
    const eligibleCounts = this.#publishedIdentityCounts();
    const legacyInvalidEntityCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_entities e
      WHERE e.review_state='verified' AND (SELECT d.decision FROM identity_decisions d
        WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (EXISTS (SELECT 1 FROM identity_variants v WHERE v.entity_id=e.entity_id
          AND v.review_state<>'rejected' AND is_canonical_solana_address(v.mint)=0)
          OR (e.primary_mint IS NOT NULL AND is_canonical_solana_address(e.primary_mint)=0))`).get().count);
    const legacyInvalidVariantCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_variants v
      JOIN identity_entities e ON e.entity_id=v.entity_id
      WHERE v.review_state<>'rejected' AND e.review_state='verified'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (EXISTS (SELECT 1 FROM identity_variants invalidv WHERE invalidv.entity_id=e.entity_id
          AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0)
          OR (e.primary_mint IS NOT NULL AND is_canonical_solana_address(e.primary_mint)=0))`).get().count);
    const entityRows = this.db.prepare(`WITH eligible AS (
        SELECT e.entity_id,e.display_name,e.symbol,e.review_state,e.primary_mint,e.created_at,e.updated_at,
          (SELECT count(*) FROM identity_variants v WHERE v.entity_id=e.entity_id AND v.review_state<>'rejected') AS variant_count
        FROM identity_entities e WHERE e.review_state='verified' AND EXISTS (
          SELECT 1 FROM identity_variants v WHERE v.entity_id=e.entity_id AND v.review_state='verified'
        ) AND NOT EXISTS (SELECT 1 FROM identity_variants invalidv
          WHERE invalidv.entity_id=e.entity_id AND invalidv.review_state<>'rejected'
            AND is_canonical_solana_address(invalidv.mint)=0)
        AND (e.primary_mint IS NULL OR is_canonical_solana_address(e.primary_mint)=1)
        AND (SELECT d.decision FROM identity_decisions d
          WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
      ), bounded AS (
        SELECT *,sum(variant_count) OVER (ORDER BY entity_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_variants
        FROM eligible WHERE variant_count BETWEEN 1 AND 100
      ) SELECT entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at,variant_count
        FROM bounded WHERE cumulative_variants<=? ORDER BY entity_id LIMIT ?`)
      .all(IDENTITY_REGISTRY_CAPACITY.variants, IDENTITY_REGISTRY_CAPACITY.entities);
    let exactOmission = null;
    const reviewedMintOmissions = [];
    const priorityEntityIds = new Set();
    const exactRowsByMint = new Map();
    const exactEntity = this.db.prepare(`SELECT e.entity_id,e.display_name,e.symbol,e.review_state,e.primary_mint,e.created_at,e.updated_at,
          v.kind AS exact_kind,v.review_state AS exact_review_state,v.evidence_class AS exact_evidence_class,
          v.observed_at AS exact_observed_at,
          (SELECT count(*) FROM identity_variants invalidv WHERE invalidv.entity_id=e.entity_id
            AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0) AS invalid_variant_count,
          CASE WHEN e.primary_mint IS NOT NULL AND is_canonical_solana_address(e.primary_mint)=0 THEN 1 ELSE 0 END AS invalid_primary,
          (SELECT count(*) FROM identity_variants allv WHERE allv.entity_id=e.entity_id AND allv.review_state<>'rejected') AS variant_count
        FROM identity_variants v JOIN identity_entities e ON e.entity_id=v.entity_id
        WHERE v.mint=? AND v.review_state='verified' AND e.review_state='verified' AND (
          SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
        )='accept'`);
    for (const requestedMint of requestedPriorityMints) {
      const exact = exactEntity.get(requestedMint);
      if (!exact) continue;
      exactRowsByMint.set(requestedMint, exact);
      if (entityRows.some(({ entity_id }) => entity_id === exact.entity_id)) {
        priorityEntityIds.add(exact.entity_id);
        continue;
      }
      if (exact) {
        if (exact.invalid_variant_count > 0 || exact.invalid_primary > 0) {
          const omission = {
            mint: requestedMint,
            entityId: exact.entity_id,
            displayName: exact.display_name,
            symbol: exact.symbol,
            variant: {
              mint: requestedMint,
              kind: exact.exact_kind,
              reviewState: exact.exact_review_state,
              evidenceClass: exact.exact_evidence_class,
              observedAt: exact.exact_observed_at
            },
            isPrimary: exact.primary_mint === requestedMint,
            hasReviewedPrimary: exact.primary_mint !== null && exact.invalid_primary === 0,
            reason: exact.invalid_variant_count > 0 ? "legacy-invalid-variant" : "legacy-invalid-primary",
            registeredVariantCount: Number(exact.variant_count)
          };
          reviewedMintOmissions.push(omission);
          if (prioritizeMint === requestedMint) exactOmission = omission;
        } else if (exact.variant_count < 1 || exact.variant_count > 100) {
          const omission = {
            mint: requestedMint,
            entityId: exact.entity_id,
            displayName: exact.display_name,
            symbol: exact.symbol,
            variant: {
              mint: requestedMint,
              kind: exact.exact_kind,
              reviewState: exact.exact_review_state,
              evidenceClass: exact.exact_evidence_class,
              observedAt: exact.exact_observed_at
            },
            isPrimary: exact.primary_mint === requestedMint,
            hasReviewedPrimary: exact.primary_mint !== null,
            reason: "legacy-entity-variant-cap-exceeded",
            registeredVariantCount: Number(exact.variant_count)
          };
          reviewedMintOmissions.push(omission);
          if (prioritizeMint === requestedMint) exactOmission = omission;
        } else {
          while (entityRows.length >= IDENTITY_REGISTRY_CAPACITY.entities
            || entityRows.reduce((sum, row) => sum + Number(row.variant_count), 0) + Number(exact.variant_count) > IDENTITY_REGISTRY_CAPACITY.variants) {
            const removableIndex = entityRows.findLastIndex(({ entity_id }) => !priorityEntityIds.has(entity_id));
            if (removableIndex < 0) break;
            entityRows.splice(removableIndex, 1);
          }
          if (entityRows.length >= IDENTITY_REGISTRY_CAPACITY.entities
            || entityRows.reduce((sum, row) => sum + Number(row.variant_count), 0) + Number(exact.variant_count) > IDENTITY_REGISTRY_CAPACITY.variants) {
            const omission = {
              mint: requestedMint,
              entityId: exact.entity_id,
              displayName: exact.display_name,
              symbol: exact.symbol,
              variant: {
                mint: requestedMint,
                kind: exact.exact_kind,
                reviewState: exact.exact_review_state,
                evidenceClass: exact.exact_evidence_class,
                observedAt: exact.exact_observed_at
              },
              isPrimary: exact.primary_mint === requestedMint,
              hasReviewedPrimary: exact.primary_mint !== null,
              reason: "projection-capacity-exhausted",
              registeredVariantCount: Number(exact.variant_count)
            };
            reviewedMintOmissions.push(omission);
            if (prioritizeMint === requestedMint) exactOmission = omission;
            continue;
          }
          entityRows.push(exact);
          priorityEntityIds.add(exact.entity_id);
        }
      }
    }
    entityRows.sort((left, right) => left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0);
    const entityIds = entityRows.map(({ entity_id }) => entity_id);
    const rawVariantRows = entityIds.length ? this.db.prepare(`SELECT v.mint,v.entity_id,v.kind,v.review_state,v.evidence_class,v.observed_at,v.created_at,v.updated_at
      FROM identity_variants v WHERE v.review_state<>'rejected' AND v.entity_id IN (${entityIds.map(() => "?").join(",")})
      ORDER BY v.entity_id,v.mint`).all(...entityIds) : [];
    const invalidEntityIds = new Set(rawVariantRows.flatMap((row) => isCanonicalSolanaAddress(row.mint) ? [] : [row.entity_id]));
    const invalidEntityMints = new Set(rawVariantRows
      .filter(({ entity_id }) => invalidEntityIds.has(entity_id)).map(({ mint }) => mint));
    const publishedEntityRows = entityRows.filter(({ entity_id }) => !invalidEntityIds.has(entity_id));
    const variantRows = rawVariantRows.filter(({ entity_id }) => !invalidEntityIds.has(entity_id));
    for (const [requestedMint, exact] of exactRowsByMint) {
      if (!invalidEntityIds.has(exact.entity_id)
        || reviewedMintOmissions.some(({ mint }) => mint === requestedMint)) continue;
      const omission = {
        mint: requestedMint,
        entityId: exact.entity_id,
        displayName: exact.display_name,
        symbol: exact.symbol,
        variant: {
          mint: requestedMint,
          kind: exact.exact_kind,
          reviewState: exact.exact_review_state,
          evidenceClass: exact.exact_evidence_class,
          observedAt: exact.exact_observed_at
        },
        isPrimary: exact.primary_mint === requestedMint,
        hasReviewedPrimary: exact.primary_mint !== null,
        reason: "legacy-invalid-variant",
        registeredVariantCount: Number(exact.variant_count)
      };
      reviewedMintOmissions.push(omission);
      if (prioritizeMint === requestedMint) exactOmission = omission;
    }
    const variantsByEntity = new Map();
    for (const row of variantRows) {
      const variants = variantsByEntity.get(row.entity_id) || [];
      variants.push({
        mint: row.mint,
        kind: row.kind,
        reviewState: row.review_state,
        evidenceClass: row.evidence_class,
        observedAt: row.observed_at
      });
      variantsByEntity.set(row.entity_id, variants);
    }
    const entities = publishedEntityRows.flatMap((row) => {
      const variants = variantsByEntity.get(row.entity_id) || [];
      return variants.length ? [{
        entityId: row.entity_id,
        displayName: row.display_name,
        symbol: row.symbol,
        reviewState: row.review_state,
        primaryMint: row.primary_mint,
        variants
      }] : [];
    });
    const registeredMints = new Set(variantRows.map(({ mint }) => mint));
    const registeredMintList = [...registeredMints];
    const registeredMintPlaceholders = registeredMintList.map(() => "?").join(",");
    const globalRelationshipRows = prioritizeMint !== null || registeredMintList.length === 0 ? [] : this.db.prepare(`WITH eligible AS (
      SELECT r.relationship_id,r.from_mint,r.to_mint,r.kind,r.review_state,r.evidence_class,r.observed_at,
        row_number() OVER (PARTITION BY r.kind,
          CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END,
          CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END
          ORDER BY r.relationship_id) AS semantic_rank
      FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
        AND ef.review_state='verified' AND et.review_state='verified' AND (
        SELECT d.decision FROM identity_decisions d
        WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
      )='accept' AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND r.from_mint IN (${registeredMintPlaceholders})
        AND r.to_mint IN (${registeredMintPlaceholders})
      ) SELECT relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at
        FROM eligible WHERE semantic_rank=1 ORDER BY relationship_id LIMIT ?`)
      .all(...registeredMintList, ...registeredMintList, IDENTITY_REGISTRY_CAPACITY.relationships + 1);
    const relationshipRows = prioritizeMint === null ? globalRelationshipRows : registeredMintList.length === 0 ? [] : this.db.prepare(`WITH eligible AS (
        SELECT r.relationship_id,r.from_mint,r.to_mint,r.kind,r.review_state,r.evidence_class,r.observed_at,
          row_number() OVER (PARTITION BY r.kind,
            CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END,
            CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END
            ORDER BY r.relationship_id) AS semantic_rank
        FROM identity_relationships r
        CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
        CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
        WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
          AND ef.review_state='verified' AND et.review_state='verified'
          AND (r.from_mint=? OR r.to_mint=?)
          AND r.from_mint IN (${registeredMintPlaceholders})
          AND r.to_mint IN (${registeredMintPlaceholders})
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
      ) SELECT relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at
        FROM eligible WHERE semantic_rank=1 ORDER BY relationship_id LIMIT ?`)
      .all(prioritizeMint, prioritizeMint, ...registeredMintList, ...registeredMintList,
        IDENTITY_RESOLVER_RELATIONSHIP_LIMIT + 1);
    const seenRelationshipFacts = new Set();
    const duplicateRelationshipCount = prioritizeMint === null ? Number(this.db.prepare(`WITH eligible AS (
      SELECT row_number() OVER (PARTITION BY r.kind,
        CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END,
        CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END
        ORDER BY r.relationship_id) AS semantic_rank
      FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
        AND ef.review_state='verified' AND et.review_state='verified'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
      ) SELECT count(*) AS count FROM eligible WHERE semantic_rank>1`).get().count) : 0;
    const publishedSemanticRelationshipCount = prioritizeMint === null && registeredMintList.length > 0
      ? Number(this.db.prepare(`SELECT count(*) AS count FROM (
          SELECT r.kind,
            CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END AS first_mint,
            CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END AS second_mint
          FROM identity_relationships r
          CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
          CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
          WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
            AND ef.review_state='verified' AND et.review_state='verified'
            AND r.from_mint IN (${registeredMintPlaceholders})
            AND r.to_mint IN (${registeredMintPlaceholders})
            AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
              ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
            AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
              ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
            AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
              ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          GROUP BY r.kind,first_mint,second_mint)`)
        .get(...registeredMintList, ...registeredMintList).count) : 0;
    const invalidEndpointRelationshipCount = prioritizeMint === null ? Number(this.db.prepare(`SELECT count(*) AS count FROM (
        SELECT r.kind,
          CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END AS first_mint,
          CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END AS second_mint
        FROM identity_relationships r
        CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
        CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
        WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
          AND ef.review_state='verified' AND et.review_state='verified'
          AND (EXISTS (SELECT 1 FROM identity_variants invalidv WHERE invalidv.entity_id=ef.entity_id
              AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0)
            OR (ef.primary_mint IS NOT NULL AND is_canonical_solana_address(ef.primary_mint)=0)
            OR EXISTS (SELECT 1 FROM identity_variants invalidv WHERE invalidv.entity_id=et.entity_id
              AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0)
            OR (et.primary_mint IS NOT NULL AND is_canonical_solana_address(et.primary_mint)=0))
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
            ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        GROUP BY r.kind,first_mint,second_mint)`).get().count) : 0;
    const semanticRelationshipCount = prioritizeMint === null
      ? Math.max(0, eligibleCounts.relationships - duplicateRelationshipCount) : 0;
    const projectedEndpointRelationshipCount = prioritizeMint === null
      ? Math.max(0, semanticRelationshipCount - publishedSemanticRelationshipCount - invalidEndpointRelationshipCount) : 0;
    let relationships = relationshipRows.slice(0, IDENTITY_REGISTRY_CAPACITY.relationships).flatMap((row) => {
      if (!registeredMints.has(row.from_mint) || !registeredMints.has(row.to_mint)) {
        return [];
      }
      const [first, second] = row.from_mint < row.to_mint
        ? [row.from_mint, row.to_mint] : [row.to_mint, row.from_mint];
      const semanticKey = `${row.kind}\u0000${first}\u0000${second}`;
      if (seenRelationshipFacts.has(semanticKey)) {
        return [];
      }
      seenRelationshipFacts.add(semanticKey);
      return [{
          relationshipId: row.relationship_id,
          fromMint: row.from_mint,
          toMint: row.to_mint,
          kind: row.kind,
          reviewState: row.review_state,
          evidenceClass: row.evidence_class,
          observedAt: row.observed_at
        }];
    });
    const integrityOmittedRelationshipCount = invalidEndpointRelationshipCount + duplicateRelationshipCount;
    if (prioritizeMint !== null) {
      relationships = relationships.filter(({ fromMint, toMint }) => fromMint === prioritizeMint || toMint === prioritizeMint)
        .slice(0, IDENTITY_RESOLVER_RELATIONSHIP_LIMIT);
    }
    const exactRelationshipMetrics = prioritizeMint === null ? null : this.db.prepare(`WITH semantic AS (
      SELECT r.kind,
        CASE WHEN r.from_mint<r.to_mint THEN r.from_mint ELSE r.to_mint END AS first_mint,
        CASE WHEN r.from_mint<r.to_mint THEN r.to_mint ELSE r.from_mint END AS second_mint,
        ${registeredMintList.length > 0 ? `CASE WHEN r.from_mint IN (${registeredMintPlaceholders})
          AND r.to_mint IN (${registeredMintPlaceholders}) THEN 1 ELSE 0 END` : "0"} AS publishable,
        CASE WHEN EXISTS (SELECT 1 FROM identity_variants invalidv WHERE invalidv.entity_id=ef.entity_id
              AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0)
            OR (ef.primary_mint IS NOT NULL AND is_canonical_solana_address(ef.primary_mint)=0)
            OR EXISTS (SELECT 1 FROM identity_variants invalidv WHERE invalidv.entity_id=et.entity_id
              AND invalidv.review_state<>'rejected' AND is_canonical_solana_address(invalidv.mint)=0)
            OR (et.primary_mint IS NOT NULL AND is_canonical_solana_address(et.primary_mint)=0)
          THEN 1 ELSE 0 END AS integrity_omitted
      FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
        AND ef.review_state='verified' AND et.review_state='verified' AND (r.from_mint=? OR r.to_mint=?)
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
      GROUP BY r.kind,first_mint,second_mint
    ) SELECT count(*) AS eligible_count,coalesce(sum(publishable),0) AS publishable_count,
        coalesce(sum(integrity_omitted),0) AS integrity_omitted_count FROM semantic`)
      .get(...(registeredMintList.length > 0 ? [...registeredMintList, ...registeredMintList] : []), prioritizeMint, prioritizeMint);
    const exactRelationshipEligibleCount = prioritizeMint === null ? null : Number(exactRelationshipMetrics.eligible_count);
    const exactRelationshipPublishableEligibleCount = prioritizeMint === null ? null : Number(exactRelationshipMetrics.publishable_count);
    const exactRelationshipIntegrityOmittedCount = prioritizeMint === null ? null : Number(exactRelationshipMetrics.integrity_omitted_count);
    const exactRelationshipPublishedCount = prioritizeMint === null ? null
      : relationships.filter(({ fromMint, toMint }) => fromMint === prioritizeMint || toMint === prioritizeMint).length;
    const exactRelationshipProjectionOmittedCount = prioritizeMint === null ? null : Math.max(0,
      exactRelationshipEligibleCount - exactRelationshipPublishableEligibleCount - exactRelationshipIntegrityOmittedCount);
    const exactRelationshipLimitOmittedCount = prioritizeMint === null ? null
      : Math.max(0, exactRelationshipPublishableEligibleCount - exactRelationshipPublishedCount);
    const publishedCounts = { entities: entities.length, variants: variantRows.length, relationships: relationships.length };
    const omittedCounts = Object.fromEntries(Object.keys(eligibleCounts)
      .map((key) => [key, Math.max(0, eligibleCounts[key] - publishedCounts[key])]));
    const projection = {
      schemaVersion: 1,
      policy: "bounded-whole-reviewed-entities-v1",
      capacity: { ...IDENTITY_REGISTRY_CAPACITY },
      eligibleCounts,
      publishedCounts,
      omittedCounts,
      integrityOmittedCounts: {
        entities: legacyInvalidEntityCount,
        variants: legacyInvalidVariantCount,
        relationships: integrityOmittedRelationshipCount
      },
      integrityOmissionReasons: { duplicateRelationships: duplicateRelationshipCount },
      projectedEndpointRelationshipCount,
      truncated: Object.values(omittedCounts).some((count) => count > 0),
      prioritizedMintCount: requestedPriorityMints.length,
      reviewedMintOmissionCount: reviewedMintOmissions.length,
      ...(prioritizeMint === null ? {} : {
        prioritizedMint: prioritizeMint,
        exactRelationshipEligibleCount,
        exactRelationshipPublishableEligibleCount,
        exactRelationshipPublishedCount,
        exactRelationshipLimitOmittedCount,
        exactRelationshipProjectionOmittedCount,
        exactRelationshipIntegrityOmittedCount,
        exactRelationshipTruncated: exactRelationshipLimitOmittedCount > 0
      })
    };
    new CanonicalRegistry({ entities, relationships });
    const result = {
      schemaVersion: 1,
      entities,
      relationships,
      projection,
      reviewedMintOmissions,
      ...(exactOmission ? { exactOmission } : {})
    };
    if (snapshotCacheKey !== null) {
      this.identityRegistrySnapshotCache.set(snapshotCacheKey, result);
      while (this.identityRegistrySnapshotCache.size > 4) {
        const evictionKey = [...this.identityRegistrySnapshotCache.keys()].find((key) => key !== "[]");
        if (evictionKey === undefined) break;
        this.identityRegistrySnapshotCache.delete(evictionKey);
      }
    }
    if (prioritizeMint !== null) {
      this.identityResolverSnapshotCache.set(prioritizeMint, { value: result, expiresAt: Date.now() + 15_000 });
      while (this.identityResolverSnapshotCache.size > 8) {
        this.identityResolverSnapshotCache.delete(this.identityResolverSnapshotCache.keys().next().value);
      }
    }
    return result;
  }
  hasReviewedIdentityMint(mint) {
    if (!isCanonicalSolanaAddress(mint)) throw new TypeError("identity mint is invalid");
    return Boolean(this.db.prepare(`SELECT 1 AS found FROM identity_variants v
      JOIN identity_entities e ON e.entity_id=v.entity_id
      WHERE v.mint=? AND v.review_state='verified' AND e.review_state='verified'
        AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept' LIMIT 1`).get(mint));
  }
  saveIdentityEntity({ entity, decision } = {}) {
    const normalized = validateCanonicalEntity(entity);
    const reviewed = identityDecision(decision, {
      subjectType: "entity",
      subjectId: normalized.entityId,
      defaultEvidence: { scope: "entity-and-variants", variantCount: normalized.variants.length }
    });
    if (!["accept", "reject", "split", "supersede"].includes(reviewed.decision)) throw new TypeError("identity entity decision is invalid");
    requireEntityDecisionState(normalized, reviewed);
    let transactionStarted = false;
    try {
      if (!this.db.isTransaction) {
        this.db.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
      }
      const capacityBefore = this.#publishedIdentityCounts();
      const now = reviewed.decidedAt;
      const existing = this.db.prepare("SELECT created_at FROM identity_entities WHERE entity_id=?").get(normalized.entityId);
      this.db.prepare(`INSERT INTO identity_entities
        (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(entity_id) DO UPDATE SET display_name=excluded.display_name,symbol=excluded.symbol,
          review_state=excluded.review_state,primary_mint=excluded.primary_mint,updated_at=excluded.updated_at`)
        .run(normalized.entityId, normalized.displayName, normalized.symbol, normalized.reviewState,
          normalized.primaryMint, existing?.created_at ?? now, now);
      for (const variant of normalized.variants) {
        const existingVariant = this.db.prepare(`SELECT v.created_at,v.entity_id,v.review_state,e.review_state AS entity_review_state
          FROM identity_variants v JOIN identity_entities e ON e.entity_id=v.entity_id WHERE v.mint=?`).get(variant.mint);
        if (existingVariant && existingVariant.entity_id !== normalized.entityId
          && existingVariant.review_state !== "rejected" && existingVariant.entity_review_state !== "rejected") {
          throw new TypeError(`identity variant ${variant.mint} must be explicitly released before reassignment`);
        }
        this.db.prepare(`INSERT INTO identity_variants
          (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(mint) DO UPDATE SET entity_id=excluded.entity_id,kind=excluded.kind,review_state=excluded.review_state,
            evidence_class=excluded.evidence_class,observed_at=excluded.observed_at,updated_at=excluded.updated_at`)
          .run(variant.mint, normalized.entityId, variant.kind, variant.reviewState, variant.evidenceClass,
            variant.observedAt, existingVariant?.created_at ?? now, now);
      }
      const keep = new Set(normalized.variants.map(({ mint }) => mint));
      for (const { mint } of this.db.prepare("SELECT mint FROM identity_variants WHERE entity_id=?").all(normalized.entityId)) {
        if (!keep.has(mint)) this.db.prepare("UPDATE identity_variants SET review_state='rejected',updated_at=? WHERE mint=?").run(now, mint);
      }
      this.#insertIdentityDecision(reviewed);
      this.#assertIdentityCapacity(capacityBefore);
      const saved = reviewed.decision === "accept" && normalized.reviewState === "verified"
        ? normalized : null;
      if (transactionStarted) {
        this.db.exec("COMMIT");
        transactionStarted = false;
      }
      this.#invalidateIdentityRegistryCaches();
      return saved;
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  saveIdentityRelationship({ relationship, decision } = {}) {
    const registeredMints = new Set();
    for (const candidate of [relationship?.fromMint, relationship?.toMint]) {
      if (!isCanonicalSolanaAddress(candidate)) continue;
      const found = this.db.prepare(`SELECT 1 AS found FROM identity_variants v JOIN identity_entities e ON e.entity_id=v.entity_id
        WHERE v.mint=? AND v.review_state='verified' AND e.review_state='verified' AND (
          SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
        )='accept'`).get(candidate);
      if (found) registeredMints.add(candidate);
    }
    const normalized = validateCanonicalRelationship(relationship, registeredMints);
    const reviewed = identityDecision(decision, {
      subjectType: "relationship",
      subjectId: normalized.relationshipId,
      defaultEvidence: { scope: "reviewed-cross-mint-edge" }
    });
    requireRelationshipDecisionState(normalized, reviewed);
    let transactionStarted = false;
    try {
      if (!this.db.isTransaction) {
        this.db.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
      }
      const capacityBefore = this.#publishedIdentityCounts();
      const now = reviewed.decidedAt;
      if (reviewed.decision === "accept") {
        const duplicate = this.db.prepare(`SELECT r.relationship_id FROM identity_relationships r
          WHERE r.relationship_id<>? AND r.kind=? AND r.review_state='verified'
            AND ((r.from_mint=? AND r.to_mint=?) OR (r.from_mint=? AND r.to_mint=?))
            AND (SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship'
              AND d.subject_id=r.relationship_id ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1)='accept'
          LIMIT 1`).get(normalized.relationshipId, normalized.kind,
          normalized.fromMint, normalized.toMint, normalized.toMint, normalized.fromMint);
        if (duplicate) throw new TypeError("identity relationship endpoint and kind fact is already reviewed");
      }
      const existing = this.db.prepare("SELECT created_at FROM identity_relationships WHERE relationship_id=?").get(normalized.relationshipId);
      this.db.prepare(`INSERT INTO identity_relationships
        (relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(relationship_id) DO UPDATE SET
          from_mint=excluded.from_mint,to_mint=excluded.to_mint,kind=excluded.kind,review_state=excluded.review_state,
          evidence_class=excluded.evidence_class,observed_at=excluded.observed_at,updated_at=excluded.updated_at`)
        .run(normalized.relationshipId, normalized.fromMint, normalized.toMint, normalized.kind,
          normalized.reviewState, normalized.evidenceClass, normalized.observedAt, existing?.created_at ?? now, now);
      this.#insertIdentityDecision(reviewed);
      this.#assertIdentityCapacity(capacityBefore);
      const saved = reviewed.decision === "accept" && normalized.reviewState === "verified"
        ? normalized : null;
      if (transactionStarted) {
        this.db.exec("COMMIT");
        transactionStarted = false;
      }
      this.#invalidateIdentityRegistryCaches();
      return saved;
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  importIdentityRegistry({ entities, relationships } = {}) {
    if (!Array.isArray(entities) || !Array.isArray(relationships) || entities.length > 100 || relationships.length > 500) {
      throw new RangeError("identity registry import exceeds bounded document limits");
    }
    if (this.db.isTransaction) throw new Error("identity registry import requires its own transaction");
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const savedEntities = entities.map((entry) => this.saveIdentityEntity(entry));
      const savedRelationships = relationships.map((entry) => this.saveIdentityRelationship(entry));
      this.db.exec("COMMIT");
      transactionStarted = false;
      return {
        entities: savedEntities.length,
        relationships: savedRelationships.length,
        coverage: this.identityRegistryCoverage()
      };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  upsertIdentityProposals(proposals, { observedAt = new Date().toISOString() } = {}) {
    if (!Array.isArray(proposals) || proposals.length > 2_000) throw new RangeError("identity proposals must be an array of at most 2000 entries");
    const now = timestamp(observedAt, "identity proposals observedAt");
    let written = 0;
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const proposal of proposals) {
        if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new TypeError("identity proposal must be an object");
        const proposalKey = text(proposal.proposalKey, "identity proposalKey", { max: 128, code: true });
        const fromMint = text(proposal.fromMint, "identity proposal fromMint", { max: 44 });
        const toMint = text(proposal.toMint, "identity proposal toMint", { max: 44 });
        if (!isCanonicalSolanaAddress(fromMint) || !isCanonicalSolanaAddress(toMint) || fromMint === toMint) throw new TypeError("identity proposal mints are invalid");
        const kind = text(proposal.kind, "identity proposal kind", { max: 32, code: true });
        if (!["same-narrative", "name-collision"].includes(kind)) throw new TypeError("identity proposal kind is invalid");
        if (proposal.evidenceClass !== "locally-derived" || proposal.status !== "pending") throw new TypeError("identity proposals must remain pending locally-derived evidence");
        const methodVersion = text(proposal.methodVersion, "identity proposal methodVersion", { max: 80, code: true });
        const evidence = identityEvidence(proposal.evidence, "identity proposal evidence");
        const existing = this.db.prepare("SELECT created_at FROM identity_proposals WHERE proposal_key=?").get(proposalKey);
        const result = this.identityProposalInsertStmt.run(proposalKey, fromMint, toMint, kind, "locally-derived",
          methodVersion, JSON.stringify(evidence), "pending", existing?.created_at ?? now, now);
        written += Number(result.changes > 0);
      }
      const pruned = Number(this.db.prepare(`DELETE FROM identity_proposals WHERE status='pending' AND proposal_key NOT IN (
        SELECT proposal_key FROM identity_proposals WHERE status='pending'
        ORDER BY updated_at DESC,proposal_key ASC LIMIT ?
      )`).run(IDENTITY_PENDING_PROPOSAL_LIMIT).changes);
      this.db.exec("COMMIT");
      transactionStarted = false;
      this.identityRegistryCoverageCache = null;
      return { observedAt: now, supplied: proposals.length, written, pruned, pendingLimit: IDENTITY_PENDING_PROPOSAL_LIMIT };
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  identityProposals({ status = "pending", limit = 100 } = {}) {
    const normalizedStatus = text(status, "identity proposal status", { max: 24, code: true });
    if (!["pending", "accepted", "rejected", "superseded"].includes(normalizedStatus)) throw new TypeError("identity proposal status is invalid");
    const normalizedLimit = boundedInteger(limit, "identity proposal limit", { min: 1, max: 500 });
    return this.db.prepare(`SELECT * FROM identity_proposals WHERE status=?
      ORDER BY updated_at DESC,proposal_key LIMIT ?`).all(normalizedStatus, normalizedLimit).map(rowIdentityProposal);
  }
  decideIdentityProposal({ proposalKey, decision } = {}) {
    const normalizedKey = text(proposalKey, "identity proposalKey", { max: 128, code: true });
    const proposal = this.db.prepare("SELECT * FROM identity_proposals WHERE proposal_key=?").get(normalizedKey);
    if (!proposal) throw new TypeError("identity proposal does not exist");
    const reviewed = identityDecision(decision, {
      subjectType: "proposal",
      subjectId: normalizedKey,
      defaultEvidence: { proposalKey: normalizedKey, scope: "proposal-review-only" }
    });
    const status = reviewed.decision === "accept" ? "accepted"
      : reviewed.decision === "reject" ? "rejected"
        : reviewed.decision === "supersede" ? "superseded" : null;
    if (!status) throw new TypeError("identity proposal decisions support accept, reject, or supersede");
    if (status === "accepted" && !isPublishableIdentityProposal(rowIdentityProposal(proposal))) {
      throw new TypeError("invalid legacy identity proposal can only be rejected or superseded");
    }
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.db.prepare("UPDATE identity_proposals SET status=?,updated_at=? WHERE proposal_key=?")
        .run(status, reviewed.decidedAt, normalizedKey);
      this.#insertIdentityDecision(reviewed);
      this.db.exec("COMMIT");
      transactionStarted = false;
      this.identityRegistryCoverageCache = null;
      return rowIdentityProposal(this.db.prepare("SELECT * FROM identity_proposals WHERE proposal_key=?").get(normalizedKey));
    } catch (error) {
      if (transactionStarted) try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  identityDecisions({ subjectType = null, subjectId = null, limit = 100 } = {}) {
    const normalizedType = subjectType == null ? null : text(subjectType, "identity decision subjectType", { max: 24, code: true });
    const normalizedId = subjectId == null ? null : text(subjectId, "identity decision subjectId", { max: 160 });
    const normalizedLimit = boundedInteger(limit, "identity decision limit", { min: 1, max: 500 });
    return this.db.prepare(`SELECT decision_id AS decisionId,subject_type AS subjectType,subject_id AS subjectId,
      decision,reason_code AS reasonCode,evidence,decided_at AS decidedAt,supersedes_decision_id AS supersedesDecisionId
      FROM identity_decisions WHERE (? IS NULL OR subject_type=?) AND (? IS NULL OR subject_id=?)
      ORDER BY decided_at DESC,decision_id DESC LIMIT ?`).all(normalizedType, normalizedType, normalizedId, normalizedId, normalizedLimit)
      .map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }
  identityRegistryCoverage({ projection: suppliedProjection = null } = {}) {
    this.#refreshCacheCoherence();
    if (this.identityRegistryCoverageCache) {
      return {
        ...this.identityRegistryCoverageCache,
        projection: suppliedProjection ?? this.identityRegistrySnapshot().projection
      };
    }
    const entityCount = Number(this.db.prepare("SELECT count(*) AS count FROM identity_entities WHERE review_state<>'rejected'").get().count);
    const variantCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_variants v
      JOIN identity_entities e ON e.entity_id=v.entity_id
      WHERE v.review_state<>'rejected' AND e.review_state<>'rejected'`).get().count);
    const relationshipCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint
      CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint
      CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state<>'rejected' AND vf.review_state<>'rejected' AND vt.review_state<>'rejected'
        AND ef.review_state<>'rejected' AND et.review_state<>'rejected'`).get().count);
    const verifiedEntityCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_entities e
      WHERE e.review_state='verified' AND EXISTS (
        SELECT 1 FROM identity_variants v WHERE v.entity_id=e.entity_id AND v.review_state='verified'
      ) AND (
        SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
      )='accept'`).get().count);
    const verifiedVariantCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_variants v
      JOIN identity_entities e ON e.entity_id=v.entity_id
      WHERE v.review_state='verified' AND e.review_state='verified' AND (
        SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=e.entity_id
        ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
      )='accept'`).get().count);
    const verifiedRelationshipCount = Number(this.db.prepare(`SELECT count(*) AS count FROM identity_relationships r
      CROSS JOIN identity_variants vf ON vf.mint=r.from_mint
      CROSS JOIN identity_entities ef ON ef.entity_id=vf.entity_id
      CROSS JOIN identity_variants vt ON vt.mint=r.to_mint
      CROSS JOIN identity_entities et ON et.entity_id=vt.entity_id
      WHERE r.review_state='verified' AND vf.review_state='verified' AND vt.review_state='verified'
        AND ef.review_state='verified' AND et.review_state='verified'
        AND (
          SELECT d.decision FROM identity_decisions d WHERE d.subject_type='relationship' AND d.subject_id=r.relationship_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
        )='accept'
        AND (
          SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=ef.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
        )='accept'
        AND (
          SELECT d.decision FROM identity_decisions d WHERE d.subject_type='entity' AND d.subject_id=et.entity_id
          ORDER BY d.decided_at DESC,d.decision_id DESC LIMIT 1
        )='accept'`).get().count);
    const decisionCount = Number(this.db.prepare("SELECT count(*) AS count FROM identity_decisions").get().count);
    const proposalStatusCounts = Object.fromEntries(this.db.prepare("SELECT status,count(*) AS count FROM identity_proposals GROUP BY status ORDER BY status")
      .all().map(({ status, count }) => [status, Number(count)]));
    const projection = suppliedProjection ?? this.identityRegistrySnapshot().projection;
    const coverage = {
      entityCount, variantCount, relationshipCount,
      verifiedEntityCount, verifiedVariantCount, verifiedRelationshipCount,
      decisionCount, proposalStatusCounts
    };
    this.identityRegistryCoverageCache = coverage;
    return { ...coverage, projection };
  }
  #invalidateIdentityRegistryCaches() {
    this.identityRegistrySnapshotCache.clear();
    this.identityResolverSnapshotCache.clear();
    this.identityRegistryCoverageCache = null;
  }
  #refreshCacheCoherence() {
    const dataVersion = Number(this.db.prepare("PRAGMA data_version").get().data_version);
    if (dataVersion !== this.cacheDataVersion) {
      this.identityRegistrySnapshotCache.clear();
      this.identityResolverSnapshotCache.clear();
      this.identityRegistryCoverageCache = null;
      this.tokenIntegrityCoverageCache.clear();
      this.cacheDataVersion = dataVersion;
    }
  }
  databaseChangeVersion() {
    return Number(this.db.prepare("PRAGMA data_version").get().data_version);
  }
  #insertIdentityDecision(decision) {
    this.db.prepare(`INSERT INTO identity_decisions
      (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(decision.decisionId, decision.subjectType, decision.subjectId, decision.decision,
        decision.reasonCode, JSON.stringify(decision.evidence), decision.decidedAt, decision.supersedesDecisionId);
  }
  tokens(limit = 100) {
    return parsePayloadRows(this.db.prepare("SELECT payload FROM tokens ORDER BY updated_at DESC LIMIT ?").all(limit));
  }
  canonicalTokens(limit = 100) {
    const normalizedLimit = boundedInteger(limit, "canonical token limit", { min: 1, max: 10_000 });
    return this.db.prepare(`SELECT mint,payload FROM tokens
      WHERE ${canonicalTokenRowPredicate()}
      ORDER BY updated_at DESC LIMIT ?`).all(normalizedLimit)
      .flatMap((row) => {
        try {
          const payload = JSON.parse(row.payload);
          return payload && typeof payload === "object" && !Array.isArray(payload)
            && payload.mint === row.mint && isCanonicalSolanaAddress(row.mint) ? [payload] : [];
        } catch { return []; }
      });
  }
  tokenMintIntegrityCoverage() {
    this.#refreshCacheCoherence();
    const cacheKey = "full-retained-table";
    const cached = this.tokenIntegrityCoverageCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.coverage;
    }
    if (cached) this.tokenIntegrityCoverageCache.delete(cacheKey);
    const aggregate = this.db.prepare(`SELECT count(*) AS retainedCount,
      coalesce(sum(${canonicalTokenRowPredicate()}),0) AS validCount FROM tokens`).get();
    const retainedCount = Number(aggregate.retainedCount);
    const validCount = Number(aggregate.validCount);
    const coverage = {
      schemaVersion: 1,
      policy: "quarantine-invalid-retained-token-identities-v1",
      calculatedAt: new Date().toISOString(),
      maxStalenessSeconds: 5,
      basis: "cached-full-retained-token-sql-aggregate",
      retainedCount,
      checkedCount: retainedCount,
      validCount,
      quarantinedCount: retainedCount - validCount,
      unscannedCount: 0,
      complete: true
    };
    this.tokenIntegrityCoverageCache.set(cacheKey, { coverage, expiresAt: Date.now() + 5_000 });
    return coverage;
  }
  token(mint) {
    const row = this.db.prepare("SELECT payload FROM tokens WHERE mint=?").get(mint);
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }
  alerts(limit = 30) {
    const normalizedLimit = boundedInteger(limit, "alert limit", { min: 1, max: 200 });
    return this.db.prepare(`SELECT id,level,title,message,mint,kind,evidence_class AS evidenceClass,
      evidence_at AS evidenceAt,dedupe_key AS dedupeKey,telegram_status AS telegramStatus,
      telegram_attempted_at AS telegramAttemptedAt,telegram_message_id AS telegramMessageId,
      telegram_attempt_count AS telegramAttemptCount,telegram_next_attempt_at AS telegramNextAttemptAt,
      telegram_last_error_code AS telegramLastErrorCode,created_at AS createdAt
      FROM alerts ORDER BY id DESC LIMIT ?`).all(normalizedLimit);
  }
  alertsForMint(mint, limit = 80) {
    const normalizedMint = text(mint, "mint", { max: 128 });
    const normalizedLimit = boundedInteger(limit, "alert limit", { min: 1, max: 200 });
    return this.alertMintListStmt.all(normalizedMint, normalizedLimit);
  }
  eventsForMint(mint, limit = 120) {
    const normalizedMint = text(mint, "mint", { max: 128 });
    const normalizedLimit = boundedInteger(limit, "event limit", { min: 1, max: 500 });
    return this.eventListStmt.all(normalizedMint, normalizedLimit).flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload);
        return payload && typeof payload === "object" && !Array.isArray(payload) ? [{ ...row, payload }] : [];
      } catch { return []; }
    });
  }
  callouts(limit = 50) {
    const normalizedLimit = boundedInteger(limit, "callout limit", { min: 1, max: 500 });
    return parsePayloadRows(this.db.prepare("SELECT payload FROM callouts ORDER BY created_at DESC LIMIT ?").all(normalizedLimit));
  }
  calloutsForMint(mint, limit = 80) {
    const normalizedMint = text(mint, "mint", { max: 128 });
    const normalizedLimit = boundedInteger(limit, "callout limit", { min: 1, max: 200 });
    return parsePayloadRows(this.calloutMintListStmt.all(normalizedMint, normalizedLimit));
  }
  saveBriefRun({ briefKey, kind, periodStart, periodEnd, timezone = "UTC", methodVersion, provider, dataCutoff, model } = {}) {
    const normalizedKey = text(briefKey, "brief key", { max: 320 });
    const normalizedKind = text(kind, "brief kind", { max: 16, code: true }).toLowerCase();
    if (!["daily", "weekly"].includes(normalizedKind)) throw new TypeError("brief kind must be daily or weekly");
    const normalizedStart = timestamp(periodStart, "brief periodStart");
    const normalizedEnd = timestamp(periodEnd, "brief periodEnd");
    const normalizedCutoff = timestamp(dataCutoff, "brief dataCutoff");
    if (normalizedStart >= normalizedEnd) throw new RangeError("brief periodStart must be before periodEnd");
    if (normalizedCutoff < normalizedEnd) throw new RangeError("brief dataCutoff must not precede periodEnd");
    if (timezone !== "UTC") throw new TypeError("brief timezone must be UTC");
    const normalizedMethod = text(methodVersion, "brief methodVersion", { max: 64, code: true });
    if (!["measured-closed-brief-v1", "measured-closed-brief-v2"].includes(normalizedMethod)) {
      throw new TypeError("brief methodVersion is unsupported");
    }
    const normalizedProvider = text(provider, "brief provider", { max: 64, code: true }).toLowerCase();
    validateBriefModel(model);
    const encoded = JSON.stringify(model);
    if (Buffer.byteLength(encoded) > 256 * 1_024) throw new RangeError("brief model is too large");
    if (model?.briefId !== normalizedKey || model?.methodVersion !== normalizedMethod || model?.period !== normalizedKind
      || model?.windowStart !== normalizedStart || model?.windowEnd !== normalizedEnd || model?.generatedAt !== normalizedCutoff) {
      throw new TypeError("brief model metadata does not match its persisted envelope");
    }
    const createdAt = new Date().toISOString();
    const result = this.briefInsertStmt.run(normalizedKey, normalizedKind, normalizedStart, normalizedEnd, "UTC",
      normalizedMethod, normalizedProvider, normalizedCutoff, encoded, createdAt);
    return { written: result.changes === 1, run: rowBriefRun(this.briefByKeyStmt.get(normalizedKey)) };
  }
  briefRun(kind) {
    const normalizedKind = text(kind, "brief kind", { max: 16, code: true }).toLowerCase();
    if (!["daily", "weekly"].includes(normalizedKind)) throw new TypeError("brief kind must be daily or weekly");
    return rowBriefRun(this.briefLatestStmt.get(normalizedKind));
  }
  periodActivity({ start, end, source = "pumpportal" } = {}) {
    const normalizedStart = timestamp(start, "period start");
    const normalizedEnd = timestamp(end, "period end");
    if (normalizedStart >= normalizedEnd) throw new RangeError("period start must be before end");
    const normalizedSource = text(source, "source", { max: 64, code: true });
    const bindings = [normalizedStart, normalizedEnd, normalizedSource];
    const launchesObserved = Number(this.db.prepare(`SELECT count(*) AS count FROM tokens
      WHERE created_at>=? AND created_at<? AND ${canonicalTokenRowPredicate()}
        AND json_extract(payload,'$.source')=?`).get(...bindings).count);
    const migrationObservations = Number(this.db.prepare(`SELECT count(DISTINCT mint) AS count FROM events
      WHERE created_at>=? AND created_at<? AND json_valid(payload) AND json_extract(payload,'$.source')=?
        AND json_extract(payload,'$.status')='migration-observed' AND mint IN (
          SELECT mint FROM tokens WHERE ${canonicalTokenRowPredicate()}
            AND json_extract(payload,'$.source')=?)`).get(...bindings, normalizedSource).count);
    const materialKindPlaceholders = MATERIAL_ALERT_KINDS.map(() => "?").join(",");
    const materialBindings = [normalizedStart, normalizedEnd, ...MATERIAL_ALERT_KINDS, normalizedSource];
    const materialPredicate = `created_at>=? AND created_at<? AND kind IN (${materialKindPlaceholders}) AND mint IN (
      SELECT mint FROM tokens WHERE ${canonicalTokenRowPredicate()} AND json_extract(payload,'$.source')=?)`;
    const materialAlerts = Number(this.db.prepare(`SELECT count(*) AS count FROM alerts
      WHERE ${materialPredicate}`).get(...materialBindings).count);
    const thirdPartyCallouts = Number(this.db.prepare(`SELECT count(*) AS count FROM callouts
      WHERE created_at>=? AND created_at<?`).get(normalizedStart, normalizedEnd).count);
    const materialByKind = Object.fromEntries(this.db.prepare(`SELECT kind,count(*) AS count FROM alerts
      WHERE ${materialPredicate} GROUP BY kind ORDER BY kind`).all(...materialBindings)
      .map(({ kind, count }) => [kind, Number(count)]));
    const factorEventsByEvidenceClass = Object.fromEntries(this.db.prepare(`SELECT evidence_class,count(*) AS count FROM events
      WHERE created_at>=? AND created_at<? AND kind='risk-evidence' GROUP BY evidence_class ORDER BY evidence_class`)
      .all(normalizedStart, normalizedEnd).map(({ evidence_class: evidenceClass, count }) => [evidenceClass, Number(count)]));
    const telegramDelivery = Object.fromEntries(this.db.prepare(`SELECT coalesce(telegram_status,'not-queued') AS status,count(*) AS count
      FROM alerts WHERE ${materialPredicate} GROUP BY coalesce(telegram_status,'not-queued') ORDER BY status`)
      .all(...materialBindings).map(({ status, count }) => [status, Number(count)]));
    const outcomeCohortAdmissions = Number(this.db.prepare(`SELECT count(*) AS count FROM outcome_enrichment
      JOIN tokens USING(mint) WHERE tokens.created_at>=? AND tokens.created_at<?
        AND ${canonicalTokenRowPredicate("tokens")}`).get(normalizedStart, normalizedEnd).count);
    const riskCohortAdmissions = Number(this.db.prepare(`SELECT count(*) AS count FROM risk_identity_enrichment
      JOIN tokens USING(mint) WHERE tokens.created_at>=? AND tokens.created_at<?
        AND ${canonicalTokenRowPredicate("tokens")}`).get(normalizedStart, normalizedEnd).count);
    return {
      start: normalizedStart,
      end: normalizedEnd,
      source: normalizedSource,
      launchesObserved,
      migrationObservations,
      materialAlerts,
      materialByKind,
      factorEventsByEvidenceClass,
      telegramDelivery,
      deduplicatedSuppressed: null,
      thirdPartyCallouts,
      cohortAdmissions: { outcome: outcomeCohortAdmissions, risk: riskCohortAdmissions },
      cohortDrops: { outcome: null, risk: null, reason: "Historical cohort removals are not tracked; null means unavailable, not zero." }
    };
  }
  actorPrivacySecret() {
    const row = this.db.prepare("SELECT secret FROM actor_installation WHERE id=1").get();
    if (!(Buffer.isBuffer(row?.secret) || row?.secret instanceof Uint8Array) || row.secret.length !== 32) {
      throw new Error("actor installation secret is unavailable");
    }
    return Buffer.from(row.secret);
  }
  prepareActorMethodRevision(revision) {
    const normalizedRevision = text(revision, "actor method revision", { max: 64, code: true });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT method_revision AS methodRevision FROM actor_installation WHERE id=1").get();
      if (!row) throw new Error("actor installation metadata is unavailable");
      if (row.methodRevision === normalizedRevision) {
        this.db.exec("COMMIT");
        return {
          changed: false,
          previousRevision: normalizedRevision,
          currentRevision: normalizedRevision,
          reset: { cohort: 0, observations: 0, summaries: 0 }
        };
      }
      const reset = {
        cohort: Number(this.db.prepare("SELECT count(*) AS count FROM actor_cohort").get().count),
        observations: Number(this.db.prepare("SELECT count(*) AS count FROM actor_observations").get().count),
        summaries: Number(this.db.prepare("SELECT count(*) AS count FROM actor_summaries").get().count)
      };
      this.db.exec("DELETE FROM actor_summaries; DELETE FROM actor_observations; DELETE FROM actor_cohort");
      this.db.prepare("UPDATE actor_installation SET method_revision=? WHERE id=1").run(normalizedRevision);
      this.db.exec("COMMIT");
      return {
        changed: true,
        previousRevision: row.methodRevision,
        currentRevision: normalizedRevision,
        reset
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  admitActorMint({ mint, launchObservedAt, admittedAt = new Date().toISOString(), nextAttemptAt, limit = 16 } = {}) {
    const normalizedMint = text(mint, "actor mint", { max: 44 });
    if (!isCanonicalSolanaAddress(normalizedMint)) throw new TypeError("actor mint must be a canonical 32-byte Solana base58 address");
    const normalizedLaunchAt = timestamp(launchObservedAt, "actor launchObservedAt");
    const normalizedAdmittedAt = timestamp(admittedAt, "actor admittedAt");
    const normalizedNextAt = timestamp(nextAttemptAt, "actor nextAttemptAt");
    const normalizedLimit = boundedInteger(limit, "actor cohort limit", { min: 1, max: 64 });
    const existing = this.db.prepare("SELECT * FROM actor_cohort WHERE mint=?").get(normalizedMint);
    if (existing) return { admitted: false, reason: "already-admitted", state: this.actorState(normalizedMint) };
    const count = Number(this.db.prepare("SELECT count(*) AS count FROM actor_cohort").get().count);
    if (count >= normalizedLimit) return { admitted: false, reason: "cohort-full", state: null };
    this.db.prepare(`INSERT INTO actor_cohort
      (mint,launch_observed_at,admitted_at,status,attempt_count,last_attempt_at,next_attempt_at,last_success_at,missing_reason,error_code,updated_at)
      VALUES (?,?,?,'queued',0,NULL,?,NULL,'Awaiting bounded finalized transaction acquisition',NULL,?)`)
      .run(normalizedMint, normalizedLaunchAt, normalizedAdmittedAt, normalizedNextAt, normalizedAdmittedAt);
    return { admitted: true, reason: null, state: this.actorState(normalizedMint) };
  }
  actorState(mint) {
    const normalizedMint = text(mint, "actor mint", { max: 44 });
    const row = this.db.prepare(`SELECT mint,launch_observed_at AS launchObservedAt,admitted_at AS admittedAt,status,
      attempt_count AS attemptCount,last_attempt_at AS lastAttemptAt,next_attempt_at AS nextAttemptAt,
      last_success_at AS lastSuccessAt,missing_reason AS missingReason,error_code AS errorCode,updated_at AS updatedAt
      FROM actor_cohort WHERE mint=?`).get(normalizedMint);
    return row || null;
  }
  actorStates({ limit = 64 } = {}) {
    const normalizedLimit = boundedInteger(limit, "actor state limit", { min: 1, max: 200 });
    return this.db.prepare(`SELECT mint,launch_observed_at AS launchObservedAt,admitted_at AS admittedAt,status,
      attempt_count AS attemptCount,last_attempt_at AS lastAttemptAt,next_attempt_at AS nextAttemptAt,
      last_success_at AS lastSuccessAt,missing_reason AS missingReason,error_code AS errorCode,updated_at AS updatedAt
      FROM actor_cohort ORDER BY admitted_at ASC,mint ASC LIMIT ?`).all(normalizedLimit);
  }
  dueActorStates({ now = new Date().toISOString(), limit = 16 } = {}) {
    const normalizedNow = timestamp(now, "actor due time");
    const normalizedLimit = boundedInteger(limit, "actor due limit", { min: 1, max: 32 });
    return this.db.prepare(`SELECT mint,launch_observed_at AS launchObservedAt,admitted_at AS admittedAt,status,
      attempt_count AS attemptCount,last_attempt_at AS lastAttemptAt,next_attempt_at AS nextAttemptAt,
      last_success_at AS lastSuccessAt,missing_reason AS missingReason,error_code AS errorCode,updated_at AS updatedAt
      FROM actor_cohort WHERE next_attempt_at IS NOT NULL AND next_attempt_at<=?
      ORDER BY next_attempt_at ASC,mint ASC LIMIT ?`).all(normalizedNow, normalizedLimit);
  }
  recordActorState({ mint, status, attemptedAt, nextAttemptAt = null, successAt = null, missingReason = null, errorCode = null } = {}) {
    const normalizedMint = text(mint, "actor mint", { max: 44 });
    const normalizedStatus = text(status, "actor status", { max: 32, code: true }).toLowerCase();
    if (!["observing", "available", "unavailable", "rate-limited", "degraded", "invalid-response", "complete"].includes(normalizedStatus)) {
      throw new TypeError("actor status is unsupported");
    }
    const normalizedAttemptedAt = timestamp(attemptedAt, "actor attemptedAt");
    const normalizedNextAt = nextAttemptAt === null ? null : timestamp(nextAttemptAt, "actor nextAttemptAt");
    const normalizedSuccessAt = successAt === null ? null : timestamp(successAt, "actor successAt");
    const normalizedReason = missingReason === null ? null : text(missingReason, "actor missingReason", { max: 512 });
    const normalizedError = errorCode === null ? null : text(errorCode, "actor errorCode", { max: 64, code: true }).toLowerCase();
    const result = this.db.prepare(`UPDATE actor_cohort SET status=?,attempt_count=attempt_count+1,last_attempt_at=?,
      next_attempt_at=?,last_success_at=coalesce(?,last_success_at),missing_reason=?,error_code=?,updated_at=?
      WHERE mint=? AND attempt_count<3`).run(normalizedStatus, normalizedAttemptedAt, normalizedNextAt,
      normalizedSuccessAt, normalizedReason, normalizedError, normalizedAttemptedAt, normalizedMint);
    if (result.changes !== 1) throw new Error("actor cohort state could not record a bounded attempt");
    return this.actorState(normalizedMint);
  }
  saveActorObservation({ eventKey, mint, event, sourceAt = null, observedAt, retainedUntil } = {}) {
    const normalizedEventKey = text(eventKey, "actor event key", { max: 192, code: true });
    const normalizedMint = text(mint, "actor observation mint", { max: 44 });
    if (!isCanonicalSolanaAddress(normalizedMint)) throw new TypeError("actor observation mint must be a canonical 32-byte Solana base58 address");
    const normalizedObservedAt = timestamp(observedAt, "actor observedAt");
    const normalizedSourceAt = sourceAt === null ? null : timestamp(sourceAt, "actor sourceAt");
    const normalizedRetainedUntil = timestamp(retainedUntil, "actor retainedUntil");
    const retentionMs = Date.parse(normalizedRetainedUntil) - Date.parse(normalizedObservedAt);
    if (retentionMs <= 0 || retentionMs > ACTOR_OBSERVATION_MAX_RETENTION_MS) {
      throw new RangeError("actor retainedUntil must follow observedAt by no more than 72 hours");
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || event.mint !== normalizedMint
      || typeof event.actor !== "string" || !/^Actor [1-9][0-9]{0,19}$/.test(event.actor)
      || !["buy", "sell"].includes(event.side)) throw new TypeError("actor event did not match the minimized persistence contract");
    validateActorObservationContract(event);
    const eventSourceAt = event.timestamps.source.state === "available" ? event.timestamps.source.value : null;
    if (event.timestamps.observedAt !== normalizedObservedAt || eventSourceAt !== normalizedSourceAt) {
      throw new TypeError("actor event timestamps did not match persistence metadata");
    }
    const encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > 8 * 1_024 || /(?:traderPublicKey|actorAddress|signature|cookie|authorization|privateKey)/i.test(encoded)) {
      throw new TypeError("actor event contained raw identity, transaction, credential, or oversized data");
    }
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO actor_observations
      (event_key,mint,event,source_at,observed_at,retained_until,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(normalizedEventKey, normalizedMint, encoded, normalizedSourceAt, normalizedObservedAt, normalizedRetainedUntil, createdAt);
    if (result.changes === 0) {
      const existing = this.db.prepare(`SELECT mint,event,source_at AS sourceAt,observed_at AS observedAt
        FROM actor_observations WHERE event_key=?`).get(normalizedEventKey);
      let existingEvent = null;
      try {
        existingEvent = validateActorObservationContract(JSON.parse(existing?.event));
      } catch {}
      const existingSourceAt = existingEvent?.timestamps.source.state === "available"
        ? existingEvent.timestamps.source.value
        : null;
      if (!existing || !existingEvent || existing.mint !== normalizedMint
        || existingEvent.mint !== normalizedMint
        || existingEvent.timestamps.observedAt !== existing.observedAt
        || existingSourceAt !== existing.sourceAt
        || existing.sourceAt !== normalizedSourceAt
        || actorObservationEvidenceKey(existingEvent) !== actorObservationEvidenceKey(event)) {
        throw new Error("actor observation dedupe key conflicts with retained evidence");
      }
    }
    return { written: result.changes === 1 };
  }
  actorObservationEvents(mint, limit = 512) {
    const normalizedMint = text(mint, "actor mint", { max: 44 });
    const normalizedLimit = boundedInteger(limit, "actor event limit", { min: 1, max: 4096 });
    return this.db.prepare(`SELECT event FROM actor_observations WHERE mint=? ORDER BY observed_at ASC,event_key ASC LIMIT ?`)
      .all(normalizedMint, normalizedLimit).flatMap(({ event }) => {
        try { return [JSON.parse(event)]; } catch { return []; }
      });
  }
  pruneActorObservations({ now = new Date().toISOString(), maximum = 4096 } = {}) {
    const normalizedNow = timestamp(now, "actor retention time");
    const normalizedMaximum = boundedInteger(maximum, "actor retention maximum", { min: 1, max: 100_000 });
    const expired = this.db.prepare("DELETE FROM actor_observations WHERE retained_until<=?").run(normalizedNow).changes;
    const excess = this.db.prepare(`DELETE FROM actor_observations WHERE event_key IN (
      SELECT event_key FROM actor_observations ORDER BY observed_at DESC,event_key DESC LIMIT -1 OFFSET ?
    )`).run(normalizedMaximum).changes;
    return { expired, excess, retained: Number(this.db.prepare("SELECT count(*) AS count FROM actor_observations").get().count) };
  }
  saveActorSummary(mint, summary) {
    const normalizedMint = text(mint, "actor summary mint", { max: 44 });
    if (!isCanonicalSolanaAddress(normalizedMint)) throw new TypeError("actor summary mint must be a canonical 32-byte Solana base58 address");
    if (!summary || typeof summary !== "object" || Array.isArray(summary) || summary.mint !== normalizedMint
      || !summary.coverage || !["missing", "insufficient-sample", "available"].includes(summary.coverage.state)) {
      throw new TypeError("actor summary did not match the public aggregate contract");
    }
    validateActorSummaryContract(summary, normalizedMint);
    const encoded = JSON.stringify(summary);
    if (Buffer.byteLength(encoded) > 32 * 1_024 || /(?:traderPublicKey|actorAddress|signature|transactionProvenance|cookie|authorization|privateKey)/i.test(encoded)) {
      throw new TypeError("actor summary contained private, raw, or oversized data");
    }
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO actor_summaries (mint,summary,updated_at) VALUES (?,?,?)
      ON CONFLICT(mint) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at`)
      .run(normalizedMint, encoded, updatedAt);
    return { ...summary, updatedAt };
  }
  actorSummaries(limit = 64) {
    const normalizedLimit = boundedInteger(limit, "actor summary limit", { min: 1, max: 200 });
    return this.db.prepare("SELECT mint,summary,updated_at AS updatedAt FROM actor_summaries ORDER BY updated_at DESC,mint ASC LIMIT ?")
      .all(normalizedLimit).flatMap(({ mint, summary, updatedAt }) => {
        try {
          const decoded = JSON.parse(summary);
          if (decoded.mint !== mint) return [];
          validateActorSummaryContract(decoded, mint);
          return [{ ...decoded, updatedAt }];
        } catch { return []; }
      });
  }
  actorSummary(mint) {
    const normalizedMint = text(mint, "actor summary mint", { max: 44 });
    const row = this.db.prepare("SELECT summary,updated_at AS updatedAt FROM actor_summaries WHERE mint=?").get(normalizedMint);
    if (!row) return null;
    try {
      const decoded = JSON.parse(row.summary);
      validateActorSummaryContract(decoded, normalizedMint);
      return { ...decoded, updatedAt: row.updatedAt };
    } catch { return null; }
  }
  countBySource(source) {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
    return {
      tokens: this.sourceCountStmts.tokens.get(source).count,
      events: this.sourceCountStmts.events.get(source).count,
      alerts: this.sourceCountStmts.alerts.get(source).count
    };
  }
  purgeDemoData() {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const removed = {
        alerts: this.deleteDemoStmts.alerts.run().changes,
        events: this.deleteDemoStmts.events.run().changes,
        tokens: this.deleteDemoStmts.tokens.run().changes
      };
      this.db.exec("COMMIT");
      transactionStarted = false;
      this.tokenIntegrityCoverageCache.clear();
      return removed;
    } catch (error) {
      if (transactionStarted) {
        try { this.db.exec("ROLLBACK"); } catch {}
      }
      throw error;
    }
  }
  calloutCountSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM callouts WHERE created_at >= ?").get(iso).count; }
  count() { return this.db.prepare(`SELECT count(*) AS count FROM tokens WHERE ${canonicalTokenRowPredicate()}`).get().count; }
  countSince(iso) { return this.db.prepare(`SELECT count(*) AS count FROM tokens WHERE created_at >= ? AND ${canonicalTokenRowPredicate()}`).get(iso).count; }
  countSinceBySource(iso, source) {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
    return this.sourceTokenCountSinceStmt.get(iso, source).count;
  }
}
