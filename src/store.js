import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { validateRiskIdentityPersistenceEvidence } from "./risk-identity.js";

export const STORE_SCHEMA_VERSION = 700;

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

export class Store {
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
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
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS callouts (
        external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS callouts_mint_created ON callouts(mint, created_at DESC);
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
    this.alertStmt = this.db.prepare("INSERT INTO alerts (level,title,message,mint,created_at) VALUES (?,?,?,?,?)");
    this.calloutStmt = this.db.prepare(`INSERT INTO callouts (external_id,mint,payload,created_at)
      VALUES (?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload`);
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
    this.riskIdentityDueTokensStmt = this.db.prepare(`SELECT tokens.payload,tokens.created_at
      FROM risk_identity_enrichment
      JOIN tokens ON tokens.mint=risk_identity_enrichment.mint
      WHERE risk_identity_enrichment.provider=? AND risk_identity_enrichment.next_attempt_at IS NOT NULL
        AND risk_identity_enrichment.next_attempt_at<=?
      ORDER BY risk_identity_enrichment.next_attempt_at ASC,risk_identity_enrichment.mint ASC LIMIT ?`);
    this.sourceCountStmts = {
      tokens: this.db.prepare(`SELECT count(*) AS count FROM tokens
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`),
      events: this.db.prepare(`SELECT count(*) AS count FROM events
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`),
      alerts: this.db.prepare(`SELECT count(*) AS count FROM alerts
        WHERE mint IN (
          SELECT mint FROM tokens
          WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?
        )`)
    };
    this.sourceTokenCountSinceStmt = this.db.prepare(`SELECT count(*) AS count FROM tokens
      WHERE created_at >= ?
        AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`);
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
  }
  upsertToken(token) {
    const now = new Date().toISOString();
    const createdAt = token.createdAt || now;
    this.upsertStmt.run(token.mint, JSON.stringify({ ...token, createdAt }), createdAt, now);
  }
  addEvent(kind, payload) {
    this.eventStmt.run(kind, payload.mint || null, JSON.stringify(payload), new Date().toISOString());
  }
  addAlert(alert) {
    const createdAt = alert.createdAt || new Date().toISOString();
    this.alertStmt.run(alert.level, alert.title, alert.message, alert.mint || null, createdAt);
    return { ...alert, createdAt };
  }
  upsertCallout(callout) {
    this.calloutStmt.run(callout.externalId, callout.mint, JSON.stringify(callout), callout.createdAt);
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
    return {
      provider: normalizedProvider,
      status: normalizedStatus,
      stateCount: Number(row.state_count),
      successCount: Number(row.success_count || 0),
      firstUpdatedAt: row.first_updated_at,
      lastUpdatedAt: row.last_updated_at,
      statusCounts
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
      const removed = removedOutcomes + removedRiskIdentity;
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
  tokens(limit = 100) {
    return parsePayloadRows(this.db.prepare("SELECT payload FROM tokens ORDER BY updated_at DESC LIMIT ?").all(limit));
  }
  token(mint) {
    const row = this.db.prepare("SELECT payload FROM tokens WHERE mint=?").get(mint);
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }
  alerts(limit = 30) {
    return this.db.prepare("SELECT level,title,message,mint,created_at AS createdAt FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
  }
  callouts(limit = 50) {
    return parsePayloadRows(this.db.prepare("SELECT payload FROM callouts ORDER BY created_at DESC LIMIT ?").all(limit));
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
      return removed;
    } catch (error) {
      if (transactionStarted) {
        try { this.db.exec("ROLLBACK"); } catch {}
      }
      throw error;
    }
  }
  calloutCountSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM callouts WHERE created_at >= ?").get(iso).count; }
  count() { return this.db.prepare("SELECT count(*) AS count FROM tokens").get().count; }
  countSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM tokens WHERE created_at >= ?").get(iso).count; }
  countSinceBySource(iso, source) {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
    return this.sourceTokenCountSinceStmt.get(iso, source).count;
  }
}
