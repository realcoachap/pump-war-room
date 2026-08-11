#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  RISK_IDENTITY_METHOD_VERSION,
  RISK_IDENTITY_PARSER_REVISION
} from "../src/risk-identity.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "../src/solana-rpc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RISK_COHORT_LIMIT = 120;
const RISK_PARSER_AUDIT_SAMPLE_LIMIT = 16;
const RISK_MINIMUM_SUCCESS_COVERAGE_RATIO = 0.5;
const RISK_MAXIMUM_INVALID_RESPONSE_RATIO = 0.25;
const ACTOR_COHORT_LIMIT = 32;
const ACTOR_MINIMUM_ELIGIBLE_MINTS = 20;
const ACTOR_MINIMUM_ACQUISITION_COVERAGE = 0.6;
const ACTOR_ACQUISITION_ATTEMPT_LIMIT = 3;
const ACTOR_MAXIMUM_FAILURE_RATIO = 0.25;
const ACTOR_ACQUISITION_STATES = new Set([
  "queued", "observing", "available", "unavailable", "rate-limited", "degraded", "invalid-response", "complete"
]);
const ACTOR_FAILURE_STATES = new Set(["rate-limited", "degraded", "invalid-response"]);
const MATERIAL_ALERT_KINDS = new Set([
  "score-rise", "score-drop", "risk-concentration", "risk-developer-holding",
  "risk-identity-reuse", "risk-creator-history", "migration-observed"
]);
const TELEGRAM_DELIVERY_STATES = new Set(["not-queued", "pending", "retrying", "sent", "dead-letter"]);
const ENTITY_PAGE_LIMIT = 100;
const TIMELINE_PAGE_LIMIT = 200;
const MAX_ENTITY_PAGES = 10;
const MAX_TIMELINE_PAGES = 10;
const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OPENAPI_ROUTE_METHODS = Object.freeze({
  "/api/health": "get",
  "/api/snapshot": "get",
  "/api/v1/entities": "get",
  "/api/v1/entities/resolve": "get",
  "/api/v1/openapi.json": "get",
  "/api/coins/{mint}": "get",
  "/api/coins/{mint}/timeline": "get",
  "/api/compare": "get",
  "/api/briefs/daily": "get",
  "/api/briefs/weekly": "get",
  "/api/agent/chat": "post",
  "/api/stream": "get"
});

const PUBLIC_RISK_IDENTITY_KEYS = new Set([
  "schemaVersion", "methodVersion", "parserRevision", "parserAuditRevision", "parserAuditAt",
  "parserAttemptRevision", "parserAttemptAt", "parserAttemptStatus", "overallEvidence", "rankingImpact",
  "factors", "duplicateEvidence", "providerObservation", "missing"
]);
const PUBLIC_RISK_FACTOR_KEYS = Object.freeze({
  concentration: new Set(["evidenceClass", "limitation", "sourceStatus", "missingReasonCode", "lastAttemptAt", "nextAttemptAt", "holderCount", "top10Percentage", "providerUpdatedAt", "fetchedAt", "source", "sourceFields"]),
  developer: new Set(["evidenceClass", "limitation", "sourceStatus", "missingReasonCode", "lastAttemptAt", "nextAttemptAt", "holdingPercentage", "fetchedAt", "source", "sourceField"]),
  creatorHistory: new Set(["evidenceClass", "limitation", "observedLaunchCount", "role", "source", "sourceFields", "calculatedAt", "scope"]),
  identity: new Set(["evidenceClass", "limitation", "sourceStatus", "missingReasonCode", "lastAttemptAt", "nextAttemptAt", "exactDuplicateCount", "exactDuplicateCounts", "nameSymbolCollisionCount", "basis", "source", "sourceFields", "calculatedAt", "scope"]),
  liquidity: new Set(["evidenceClass", "limitation", "sourceStatus", "missingReasonCode", "lastAttemptAt", "nextAttemptAt", "liquidityUsd", "observedAt", "source", "sourceField", "basis", "endpoint", "pool", "providerPage", "providerRank"]),
  curve: new Set(["evidenceClass", "limitation", "virtualSolReserve", "launchSolAmount", "observedAt", "source", "sourceFields"]),
  lifecycle: new Set(["evidenceClass", "limitation", "migrationObserved", "observedAt", "source", "sourceField"])
});
const PUBLIC_RISK_ENGINE_KEYS = new Set([
  "schemaVersion", "source", "status", "queueDepth", "lastAttemptAt", "lastSuccessAt",
  "runtimeLastSuccessAt", "persistedLastSuccessAt", "lastSuccessAgeSeconds", "successStaleAfterSeconds",
  "lastSuccessIsStale", "evidenceAcquisition", "ongoingFreshnessRequired", "lastErrorAt", "lastErrorCode",
  "schedule", "parserRevisionAudit", "persistence", "counters"
]);
const PUBLIC_RISK_COVERAGE_KEYS = new Set([
  "provider", "status", "stateCount", "successCount", "firstUpdatedAt", "lastUpdatedAt", "statusCounts",
  "errorCodeCounts", "invalidAcquisitionCount", "evidenceRowCount", "providerEvidenceMintCount", "tokenRowCount",
  "tokenEvidenceMintCount", "prospectivelyObservedTokenMintCount", "outputMintCount", "evidenceClass"
]);
const PUBLIC_RISK_SUMMARY_KEYS = new Set([
  "totalTracked", "holderEvidenceCount", "developerEvidenceCount", "exactDuplicateTokenCount",
  "identityHistoryCount", "liquidityEvidenceCount", "curveEvidenceCount", "migrationObservationCount"
]);
const RAW_PROFILE_VALUE = /(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)\]}>"']+)/i;
const RAW_SOLANA_IDENTITY_VALUE = /[1-9A-HJ-NP-Za-km-z]{32,}/;
const RAW_PUBLIC_IDENTITY_KEYS = new Set([
  "creator", "deployer", "caller", "trader", "traderaddress", "traderwallet", "traderpublickey",
  "actoraddress", "signature", "transactionid", "txid",
  "wallet", "walletaddress", "walletid", "walletpublickey", "publicwallet", "connectedwallet",
  "owner", "owneraddress", "ownerwallet", "ownerpublickey",
  "signer", "signeraddress", "signerwallet", "signerpublickey",
  "user", "useraddress", "userwallet", "userpublickey",
  "participant", "participantaddress", "participantwallet", "participantpublickey",
  "authority", "authorityaddress", "authoritywallet", "authoritypublickey",
  "payer", "payeraddress", "payerwallet", "feepayer", "sender", "recipient",
  "address", "account", "accountaddress", "accountkey", "accountpublickey", "publickey",
  "profile", "profileid", "profileurl", "profilehandle", "username", "handle",
  "sourceprofile", "sourceprofileid", "sourceprofileurl", "sourceprofilehandle"
]);
const HIDDEN_PUBLIC_MATERIAL_KEYS = new Set([
  "secret", "installationsecret", "actorsecret", "key", "privatekey", "hmackey", "keymaterial",
  "mapping", "mappingmaterial", "hiddenmappingmaterial", "actormapping", "addressmapping",
  "digest", "provenance", "transactionprovenance", "provenancekey", "provenancedigest",
  "eventkey", "dedupekey", "integritykey"
]);

export class SmokeCheckError extends Error {
  constructor(check, message) {
    super(`${check}: ${message}`);
    this.name = "SmokeCheckError";
    this.check = check;
  }
}

function requireValue(condition, check, message) {
  if (!condition) throw new SmokeCheckError(check, message);
}

function requireAllowedKeys(value, allowed, path) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "snapshot", `${path} was not an object`);
  for (const key of Object.keys(value)) {
    requireValue(allowed.has(key), "snapshot", `${path}.${key} was outside the public risk-identity schema`);
  }
}

function rejectRawIdentityValues(value, path) {
  if (typeof value === "string") {
    requireValue(!RAW_PROFILE_VALUE.test(value), "snapshot", `${path} exposed a raw social profile value`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectRawIdentityValues(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    rejectRawIdentityValues(entry, `${path}.${key}`);
  }
}

function normalizedPublicKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function allowsPublicSolanaIdentifier(key, value) {
  const normalized = normalizedPublicKey(key || "");
  if (normalized === "entityid" && value.startsWith("~mint:")) return true;
  if (["cursor", "nextcursor", "before", "nextbefore"].includes(normalized)) return true;
  if (/^(?:name|symbol)$/.test(normalized)
    || /(?:narrative|label|title|description|message|detail|reason|scope|limitation|note|text)$/.test(normalized)) return false;
  if (normalized === "mint" || normalized === "mints" || normalized.endsWith("mint") || normalized.endsWith("mints")
    || normalized === "pool" || normalized === "pools" || normalized.endsWith("pool") || normalized.endsWith("pools")) return true;
  if (!/(?:url|uri|href|link|timeline|endpoint|docs?|page)$/.test(normalized)) return false;
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function rejectPublicIdentityLeaks(value, path, check, contextKey = "") {
  if (typeof value === "string") {
    requireValue(!RAW_PROFILE_VALUE.test(value), check, `${path} exposed a raw social profile value`);
    requireValue(!RAW_SOLANA_IDENTITY_VALUE.test(value) || allowsPublicSolanaIdentifier(contextKey, value),
      check, `${path} exposed a raw Solana identity value outside a mint, pool, or URL field`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPublicIdentityLeaks(entry, `${path}[${index}]`, check, contextKey));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedPublicKey(key);
    const boundaryDeclaration = entry === false && /(?:public|persisted|included)$/.test(normalized);
    const publicLimiterKey = normalized === "key"
      && ["single-shared-bucket", "one-shared-bucket-per-endpoint"].includes(entry);
    const rawIdentityKey = RAW_PUBLIC_IDENTITY_KEYS.has(normalized)
      || /^(?:creator|deployer|caller)(?:address|wallet|publickey|profile|handle|id)$/.test(normalized)
      || normalized.endsWith("signature");
    const hiddenMaterial = !boundaryDeclaration && !publicLimiterKey && (HIDDEN_PUBLIC_MATERIAL_KEYS.has(normalized)
      || normalized.includes("provenance") || normalized.includes("mapping")
      || normalized.endsWith("digest") || normalized.endsWith("secret") || normalized.endsWith("key")
      || normalized === "hmac");
    requireValue(!rawIdentityKey, check, `${path}.${key} exposed a raw public identity key`);
    requireValue(!hiddenMaterial, check, `${path}.${key} exposed hidden mapping, key, digest, or provenance material`);
    rejectPublicIdentityLeaks(entry, `${path}.${key}`, check, key);
  }
}

function validateActorDownstreamGate(gate, path, check) {
  requireValue(gate && typeof gate === "object" && !Array.isArray(gate), check, `${path} was missing`);
  requireValue(["withheld", "review-required"].includes(gate.status)
    && gate.minimumEligibleMints === ACTOR_MINIMUM_ELIGIBLE_MINTS
    && gate.minimumAcquisitionCoverage === ACTOR_MINIMUM_ACQUISITION_COVERAGE,
  check, `${path} minimum-sample or coverage gate was invalid`);
  requireValue(Number.isSafeInteger(gate.eligibleMintCount) && gate.eligibleMintCount >= 0
    && (gate.acquisitionCoverage === null || (Number.isFinite(gate.acquisitionCoverage)
      && gate.acquisitionCoverage >= 0 && gate.acquisitionCoverage <= 1)),
  check, `${path} evidence denominators were invalid`);
  requireValue(gate.labeledHoldoutCalibrationPassed === false
    && gate.rankingImpact === "none" && gate.riskProbabilityImpact === "none"
    && gate.telegramAlertImpact === "none" && gate.recommendationImpact === "none",
  check, `${path} did not keep every downstream use withheld pending separately reviewed calibration`);
}

function validateActorSummary(summary, mint, path, check) {
  requireValue(summary && typeof summary === "object" && !Array.isArray(summary) && summary.mint === mint,
    check, `${path} did not identify the exact mint`);
  const coverage = summary.coverage;
  requireValue(coverage && ["missing", "insufficient-sample", "available"].includes(coverage.state)
    && Number.isSafeInteger(coverage.eventCount) && coverage.eventCount >= 0
    && Number.isSafeInteger(coverage.uniqueActorCount) && coverage.uniqueActorCount >= 0
    && coverage.uniqueActorCount <= coverage.eventCount,
  check, `${path}.coverage was invalid`);
  requireValue(coverage.launchObservedAt && ["available", "missing"].includes(coverage.launchObservedAt.state)
    && (coverage.launchObservedAt.state === "available"
      ? Number.isFinite(Date.parse(coverage.launchObservedAt.value))
      : coverage.launchObservedAt.value === null),
  check, `${path}.coverage launch-observed timestamp evidence was invalid`);
  const sourceTimestamps = coverage.sourceTimestamps;
  requireValue(sourceTimestamps && ["available", "partial", "missing"].includes(sourceTimestamps.state)
    && Number.isSafeInteger(sourceTimestamps.availableCount) && sourceTimestamps.availableCount >= 0
    && Number.isSafeInteger(sourceTimestamps.missingCount) && sourceTimestamps.missingCount >= 0
    && sourceTimestamps.availableCount + sourceTimestamps.missingCount === coverage.eventCount
    && Number.isFinite(sourceTimestamps.ratio) && sourceTimestamps.ratio >= 0 && sourceTimestamps.ratio <= 1,
  check, `${path}.coverage source-timestamp evidence was invalid`);
  const gate = coverage.gate;
  requireValue(gate && Number.isSafeInteger(gate.minimumEventCount) && gate.minimumEventCount > 0
    && Number.isSafeInteger(gate.minimumActorCount) && gate.minimumActorCount > 0
    && gate.minimumSourceTimestampRatio === 1
    && [gate.eventCountMet, gate.actorCountMet, gate.sourceTimestampRatioMet].every((value) => typeof value === "boolean"),
  check, `${path}.coverage eligibility gate was invalid`);
  requireValue(coverage.state === "available" ? summary.metrics && typeof summary.metrics === "object" : summary.metrics === null,
    check, `${path} presented metrics outside the explicit per-coin evidence gate`);
  if (summary.metrics) {
    requireValue(["available", "missing"].includes(summary.metrics.timing?.state)
      && summary.metrics.timing?.basis === "source-timestamp-minus-launch-observed-at"
      && Number.isFinite(Date.parse(summary.metrics.timing?.launchObservedAt))
      && summary.metrics.uniqueActors?.state === "available"
      && summary.metrics.uniqueActors?.count === coverage.uniqueActorCount
      && summary.metrics.repeatActivity?.state === "available"
      && ["available", "missing"].includes(summary.metrics.holdingDurationEvidence?.state)
      && summary.metrics.holdingDurationEvidence?.basis === "validated-buy-to-subsequent-sell"
      && summary.metrics.holdingDurationEvidence?.timestampBasis === "source-timestamp"
      && ["available", "missing"].includes(summary.metrics.amountConcentration?.state)
      && summary.metrics.amountConcentration?.basis === "observed-token-amount-not-holdings"
      && ["available", "missing"].includes(summary.metrics.activityBurst?.state)
      && summary.metrics.activityBurst?.timestampBasis === "source-timestamp",
    check, `${path}.metrics lacked launch-relative timing, duration, concentration, or burst evidence`);
  }
}

function validateActorEngine(engine, path, check, expectedMode) {
  const allowedStates = expectedMode === "live"
    ? [
      "awaiting-prospective-admission", "queued", "acquiring", "observing", "complete", "complete-partial",
      "complete-with-missing", "failed", "unavailable", "rate-limited", "degraded", "invalid-response", "disabled"
    ]
    : ["simulation-disabled"];
  requireValue(engine?.schemaVersion === 1 && engine.source === "solana-mainnet-rpc"
    && engine.parserRevision === SOLANA_ACTOR_PARSER_REVISION
    && allowedStates.includes(engine.status) && Number.isSafeInteger(engine.queueDepth) && engine.queueDepth >= 0,
  check, `${path} early-actor engine contract was missing`);
  if (expectedMode !== "live") return;
  requireValue(engine.status === "disabled" ? engine.started === false : engine.started === true,
    check, `${path} enabled/started state was inconsistent`);
  requireValue(engine.cohort?.limit === ACTOR_COHORT_LIMIT
    && Number.isSafeInteger(engine.cohort?.admittedCount) && engine.cohort.admittedCount >= 0
    && engine.cohort.admittedCount <= ACTOR_COHORT_LIMIT
    && Number.isSafeInteger(engine.cohort?.evidenceMintCount) && engine.cohort.evidenceMintCount >= 0
    && Number.isSafeInteger(engine.cohort?.eligibleMintCount) && engine.cohort.eligibleMintCount >= 0
    && engine.cohort.eligibleMintCount <= engine.cohort.evidenceMintCount
    && engine.cohort.evidenceMintCount <= engine.cohort.admittedCount
    && Number.isSafeInteger(engine.cohort?.attemptedMintCount) && engine.cohort.attemptedMintCount >= 0
    && engine.cohort.attemptedMintCount <= engine.cohort.admittedCount
    && engine.cohort.evidenceMintCount <= engine.cohort.attemptedMintCount
    && Number.isSafeInteger(engine.cohort?.failureStateCount) && engine.cohort.failureStateCount >= 0
    && engine.cohort.failureStateCount <= engine.cohort.attemptedMintCount
    && (engine.cohort.attemptedMintCount === 0
      ? engine.cohort.failureRatio === null
      : Number.isFinite(engine.cohort.failureRatio) && engine.cohort.failureRatio >= 0
        && engine.cohort.failureRatio <= 1
        && engine.cohort.failureRatio === engine.cohort.failureStateCount / engine.cohort.attemptedMintCount)
    && Number.isSafeInteger(engine.cohort?.pendingAttemptCount) && engine.cohort.pendingAttemptCount >= 0
    && Number.isSafeInteger(engine.cohort?.terminalCount) && engine.cohort.terminalCount >= 0
    && engine.cohort.pendingAttemptCount + engine.cohort.terminalCount === engine.cohort.admittedCount
    && Number.isSafeInteger(engine.cohort?.terminalFailureCount) && engine.cohort.terminalFailureCount >= 0
    && engine.cohort.terminalFailureCount <= engine.cohort.terminalCount
    && engine.cohort.statusCounts && typeof engine.cohort.statusCounts === "object"
    && !Array.isArray(engine.cohort.statusCounts)
    && Object.values(engine.cohort.statusCounts).every((count) => Number.isSafeInteger(count) && count >= 0)
    && Object.values(engine.cohort.statusCounts).reduce((total, count) => total + count, 0) === engine.cohort.admittedCount,
  check, `${path} cohort coverage was invalid`);
  validateActorDownstreamGate(engine.correlationGate, `${path}.correlationGate`, check);
  const rejectionReasons = engine.counters?.transactionRejectionReasons;
  requireValue(Number.isSafeInteger(engine.counters?.transactionsRejected)
    && engine.counters.transactionsRejected >= 0
    && rejectionReasons && typeof rejectionReasons === "object" && !Array.isArray(rejectionReasons)
    && Object.keys(rejectionReasons).length <= 32
    && Object.entries(rejectionReasons).every(([reason, count]) => /^[a-z][a-z0-9-]{0,63}$/.test(reason)
      && Number.isSafeInteger(count) && count > 0)
    && Object.values(rejectionReasons).reduce((total, count) => total + count, 0)
      === engine.counters.transactionsRejected,
  check, `${path} bounded transaction rejection-reason telemetry did not reconcile`);
  const expectedCoverage = engine.cohort.admittedCount
    ? engine.cohort.evidenceMintCount / engine.cohort.admittedCount : null;
  requireValue(engine.correlationGate.eligibleMintCount === engine.cohort.eligibleMintCount
    && engine.correlationGate.acquisitionCoverage === expectedCoverage,
  check, `${path} acquisition coverage did not reconcile with the admitted cohort`);
  if (engine.status !== "disabled") {
    requireValue(engine.cohort.failureRatio === null || engine.cohort.failureRatio <= ACTOR_MAXIMUM_FAILURE_RATIO,
      check, `${path} failure-state ratio ${engine.cohort.failureStateCount}/${engine.cohort.attemptedMintCount} exceeded 25% of attempted mints`);
    requireValue(!(engine.cohort.admittedCount > 0
      && engine.cohort.evidenceMintCount === 0
      && engine.cohort.pendingAttemptCount === 0),
    check, `${path} exhausted every admitted mint with zero actor evidence`);
  }
  requireValue(engine.status !== "disabled", check,
    `${path} was disabled, so the current early-actor parser was not exercised`);
  requireValue(engine.cohort.evidenceMintCount >= 1, check,
    `${path} had no accepted evidence from the current early-actor parser`);
}

function validatePublicRiskIdentity(identity, path) {
  requireAllowedKeys(identity, PUBLIC_RISK_IDENTITY_KEYS, path);
  requireAllowedKeys(identity.factors, new Set(Object.keys(PUBLIC_RISK_FACTOR_KEYS)), `${path}.factors`);
  for (const [factorName, factor] of Object.entries(identity.factors)) {
    requireAllowedKeys(factor, PUBLIC_RISK_FACTOR_KEYS[factorName], `${path}.factors.${factorName}`);
    if (factor.exactDuplicateCounts !== undefined) {
      requireAllowedKeys(factor.exactDuplicateCounts, new Set(["xHandle", "telegramHandle", "websiteDomain", "nameSymbol"]), `${path}.factors.${factorName}.exactDuplicateCounts`);
    }
  }
  requireAllowedKeys(identity.duplicateEvidence, new Set(["exactDeclaredIdentifierReuse", "duplicateContent", "likelyController", "maliciousness"]), `${path}.duplicateEvidence`);
  for (const [key, envelope] of Object.entries(identity.duplicateEvidence)) {
    requireAllowedKeys(envelope, new Set(["value", "evidenceClass"]), `${path}.duplicateEvidence.${key}`);
  }
  if (identity.providerObservation !== undefined) {
    requireAllowedKeys(identity.providerObservation, new Set(["sourceStatus", "missingReasonCode", "lastAttemptAt", "nextAttemptAt"]), `${path}.providerObservation`);
  } else {
    requireValue(identity.methodVersion === "synthetic-demo-v1", "snapshot", `${path}.providerObservation was missing from live evidence`);
  }
  requireValue(Array.isArray(identity.missing) && identity.missing.every((entry) => typeof entry === "string"), "snapshot", `${path}.missing was invalid`);
  rejectRawIdentityValues(identity, path);
}

function validateEmbeddedRiskIdentities(value, path = "snapshot") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEmbeddedRiskIdentities(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "riskIdentity" && entry !== null) validatePublicRiskIdentity(entry, `${path}.${key}`);
    else validateEmbeddedRiskIdentities(entry, `${path}.${key}`);
  }
}

async function request(baseUrl, pathname, {
  timeoutMs,
  fetchImpl,
  method = "GET",
  expectedStatus = 200,
  headers = {}
}) {
  const url = new URL(pathname, `${baseUrl}/`);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: "application/json,text/html,text/javascript", ...headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new SmokeCheckError(pathname, `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  requireValue(response.status === expectedStatus, pathname, `expected HTTP ${expectedStatus}, received ${response.status}`);
  return {
    body,
    contentType: response.headers.get("content-type") || "",
    contentEncoding: response.headers.get("content-encoding") || "",
    contentLength: response.headers.get("content-length") || "",
    nosniff: response.headers.get("x-content-type-options") || "",
    vary: response.headers.get("vary") || "",
    rateLimit: response.headers.get("x-ratelimit-limit") || "",
    rateRemaining: response.headers.get("x-ratelimit-remaining") || "",
    rateReset: response.headers.get("x-ratelimit-reset") || "",
    retryAfter: response.headers.get("retry-after") || "",
    status: response.status,
    url: url.toString()
  };
}

function parseJson(result, check) {
  try { return JSON.parse(result.body); }
  catch { throw new SmokeCheckError(check, "response was not valid JSON"); }
}

const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isNullableFinite = (value) => value === null || (typeof value === "number" && Number.isFinite(value));
const isCanonicalTimeOrNull = (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(codeUnitCompare).map((key) => [key, canonicalJson(value[key])]));
}

function canonicalJsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function validateRateHeaders(result, expectedLimit, check) {
  const remaining = Number(result.rateRemaining);
  const reset = Number(result.rateReset);
  const nowUnix = Math.floor(Date.now() / 1_000);
  requireValue(result.rateLimit === String(expectedLimit)
    && /^\d+$/.test(result.rateRemaining) && isNonNegativeInteger(remaining) && remaining <= expectedLimit
    && /^\d+$/.test(result.rateReset) && Number.isSafeInteger(reset)
    && reset >= nowUnix - 5 && reset <= nowUnix + 65,
  check, `rate-limit headers did not expose the ${expectedLimit}/minute endpoint bucket`);
}

function validateLimiterCounters(limiter, expectedLimit, minimumAllowed, path) {
  requireValue(limiter?.schemaVersion === 1
    && limiter.policy === "process-local-fixed-window-v1"
    && limiter.limit === expectedLimit && limiter.windowSeconds === 60
    && Number.isSafeInteger(limiter.maxKeys) && limiter.maxKeys >= 1
    && isNonNegativeInteger(limiter.activeKeys) && limiter.activeKeys <= limiter.maxKeys
    && isNonNegativeInteger(limiter.requests) && isNonNegativeInteger(limiter.allowed)
    && isNonNegativeInteger(limiter.rejected) && isNonNegativeInteger(limiter.evictedKeys)
    && limiter.requests === limiter.allowed + limiter.rejected
    && limiter.allowed >= minimumAllowed,
  "health", `${path} limiter counters were missing or inconsistent`);
}

function validateTokenIntegrity(integrity, path, check) {
  const calculatedAt = Date.parse(integrity?.calculatedAt);
  const ageSeconds = (Date.now() - calculatedAt) / 1_000;
  requireValue(integrity?.schemaVersion === 1
    && integrity.policy === "quarantine-invalid-retained-token-identities-v1"
    && Number.isFinite(calculatedAt) && ageSeconds >= -5
    && integrity.maxStalenessSeconds === 5 && ageSeconds <= integrity.maxStalenessSeconds + 5
    && integrity.basis === "cached-full-retained-token-sql-aggregate"
    && isNonNegativeInteger(integrity.retainedCount)
    && isNonNegativeInteger(integrity.checkedCount)
    && isNonNegativeInteger(integrity.validCount)
    && isNonNegativeInteger(integrity.quarantinedCount)
    && isNonNegativeInteger(integrity.unscannedCount)
    && integrity.checkedCount + integrity.unscannedCount === integrity.retainedCount
    && integrity.validCount + integrity.quarantinedCount === integrity.checkedCount
    && integrity.complete === (integrity.unscannedCount === 0)
    && integrity.complete === true && integrity.quarantinedCount === 0,
  check, `${path} did not prove a complete retained-token scan with no quarantine`);
}

function validateRegistryProjection(projection, path, check) {
  const countKeys = ["entities", "variants", "relationships"];
  const validCounts = (value) => value && typeof value === "object" && !Array.isArray(value)
    && countKeys.every((key) => isNonNegativeInteger(value[key]));
  requireValue(projection?.schemaVersion === 1
    && projection.policy === "bounded-whole-reviewed-entities-v1"
    && projection.capacity?.entities === 500 && projection.capacity?.variants === 2_000
    && projection.capacity?.relationships === 5_000
    && validCounts(projection.eligibleCounts) && validCounts(projection.publishedCounts)
    && validCounts(projection.omittedCounts) && validCounts(projection.integrityOmittedCounts)
    && isNonNegativeInteger(projection.integrityOmissionReasons?.duplicateRelationships)
    && isNonNegativeInteger(projection.projectedEndpointRelationshipCount)
    && isNonNegativeInteger(projection.prioritizedMintCount)
    && isNonNegativeInteger(projection.reviewedMintOmissionCount),
  check, `${path} registry projection contract was missing`);
  for (const key of countKeys) {
    requireValue(projection.eligibleCounts[key]
      === projection.publishedCounts[key] + projection.omittedCounts[key],
    check, `${path}.${key} eligible/published/omitted counts did not reconcile`);
    requireValue(projection.publishedCounts[key] <= projection.capacity[key]
      && projection.integrityOmittedCounts[key] <= projection.omittedCounts[key],
    check, `${path}.${key} exceeded capacity or hid an integrity omission`);
  }
  const anyOmission = countKeys.some((key) => projection.omittedCounts[key] > 0);
  requireValue(projection.truncated === anyOmission,
    check, `${path}.truncated disagreed with omitted counts`);
  requireValue(projection.omittedCounts.relationships
    === projection.integrityOmittedCounts.relationships + projection.projectedEndpointRelationshipCount,
  check, `${path} relationship projection omissions did not reconcile`);
  requireValue(projection.integrityOmittedCounts.relationships
    >= projection.integrityOmissionReasons.duplicateRelationships,
  check, `${path} duplicate relationship omissions exceeded integrity omissions`);
  requireValue(projection.truncated === false
    && countKeys.every((key) => projection.omittedCounts[key] === 0)
    && countKeys.every((key) => projection.integrityOmittedCounts[key] === 0)
    && projection.integrityOmissionReasons.duplicateRelationships === 0
    && projection.projectedEndpointRelationshipCount === 0
    && projection.reviewedMintOmissionCount === 0,
  check, `${path} was truncated, omitted reviewed data, or quarantined registry integrity`);
}

function expectedTrendOrderingBasis(contributor) {
  if (!contributor) return null;
  if (contributor.metrics.radarScore !== null) return "radar-evidence-score";
  if (contributor.metrics.volume5m !== null) return "five-minute-volume";
  if (contributor.metrics.momentum !== null) return "momentum";
  return contributor.tokenObservedAt !== null ? "token-observation-recency-fallback" : null;
}

function validateEntityAggregate(entity, path, check) {
  const variants = entity?.variants;
  requireValue(entity?.schemaVersion === 1 && typeof entity.entityId === "string" && entity.entityId.length > 0
    && typeof entity.displayName === "string" && entity.displayName.length > 0
    && ["verified", "singleton-unreviewed"].includes(entity.reviewState)
    && variants && isNonNegativeInteger(variants.registeredMintCount)
    && isNonNegativeInteger(variants.observedMintCount) && isNonNegativeInteger(variants.missingMintCount)
    && variants.registeredMintCount === variants.observedMintCount + variants.missingMintCount
    && Array.isArray(variants.included) && variants.included.length === variants.observedMintCount
    && Array.isArray(variants.excluded) && variants.excluded.length === variants.missingMintCount
    && Array.isArray(variants.reviewExcluded),
  check, `${path} lost exact-mint variant denominators`);

  const includedMints = new Set();
  for (const [index, variant] of variants.included.entries()) {
    requireValue(variant && SOLANA_MINT_PATTERN.test(variant.mint || "") && !includedMints.has(variant.mint)
      && typeof variant.kind === "string" && typeof variant.reviewState === "string"
      && typeof variant.evidenceClass === "string" && Object.hasOwn(variant, "registryObservedAt")
      && Object.hasOwn(variant, "tokenObservedAt") && isCanonicalTimeOrNull(variant.registryObservedAt)
      && isCanonicalTimeOrNull(variant.tokenObservedAt)
      && variant.metrics && (variant.metrics.radarRank === null
        || (Number.isSafeInteger(variant.metrics.radarRank) && variant.metrics.radarRank > 0))
      && isNullableFinite(variant.metrics.radarScore) && isNullableFinite(variant.metrics.volume5m)
      && isNullableFinite(variant.metrics.momentum),
    check, `${path}.variants.included[${index}] was not a unique typed exact-mint observation`);
    includedMints.add(variant.mint);
  }
  const excludedMints = new Set();
  for (const [index, variant] of variants.excluded.entries()) {
    requireValue(variant && SOLANA_MINT_PATTERN.test(variant.mint || "")
      && !includedMints.has(variant.mint) && !excludedMints.has(variant.mint)
      && variant.reason === "not-observed-in-current-tape" && isCanonicalTimeOrNull(variant.registryObservedAt),
    check, `${path}.variants.excluded[${index}] was not a unique explicit missing mint`);
    excludedMints.add(variant.mint);
  }
  for (const [index, variant] of variants.reviewExcluded.entries()) {
    requireValue(variant && SOLANA_MINT_PATTERN.test(variant.mint || "")
      && !includedMints.has(variant.mint) && !excludedMints.has(variant.mint)
      && variant.reviewState !== "verified" && variant.reason === "variant-review-not-verified"
      && variant.denominatorImpact === "none" && isCanonicalTimeOrNull(variant.registryObservedAt),
    check, `${path}.variants.reviewExcluded[${index}] affected a reviewed denominator`);
  }

  const registeredMints = new Set([...includedMints, ...excludedMints]);
  requireValue(entity.primary?.meaning === "identity resolution only; not a safety, quality, or trade recommendation"
    && (entity.primary.mint === null || registeredMints.has(entity.primary.mint)),
  check, `${path}.primary escaped the reviewed exact-mint denominator`);

  const narratives = entity.narratives;
  const narrativeValueCount = Array.isArray(narratives?.values)
    ? narratives.values.reduce((sum, value) => sum + (isNonNegativeInteger(value?.mintCount) ? value.mintCount : NaN), 0) : NaN;
  requireValue(isNonNegativeInteger(narratives?.observedMintCount)
    && isNonNegativeInteger(narratives?.missingMintCount)
    && narratives.observedMintCount + narratives.missingMintCount === variants.registeredMintCount
    && narrativeValueCount === narratives.observedMintCount && typeof narratives.basis === "string",
  check, `${path}.narratives denominator was inconsistent`);
  const lifecycle = entity.lifecycle;
  const lifecycleValueCount = lifecycle?.statusCounts && typeof lifecycle.statusCounts === "object" && !Array.isArray(lifecycle.statusCounts)
    ? Object.values(lifecycle.statusCounts).reduce((sum, count) => sum + (isNonNegativeInteger(count) ? count : NaN), 0) : NaN;
  requireValue(isNonNegativeInteger(lifecycle?.observedMintCount)
    && isNonNegativeInteger(lifecycle?.missingMintCount)
    && lifecycle.observedMintCount + lifecycle.missingMintCount === variants.registeredMintCount
    && lifecycleValueCount === lifecycle.observedMintCount && typeof lifecycle.basis === "string",
  check, `${path}.lifecycle denominator was inconsistent`);
  const volume = entity.volume;
  requireValue(isNonNegativeInteger(volume?.availableMintCount) && isNonNegativeInteger(volume?.missingMintCount)
    && volume.availableMintCount + volume.missingMintCount === variants.registeredMintCount
    && [0, 1].includes(volume.contributingMintCount) && typeof volume.basis === "string",
  check, `${path}.volume denominator or one-mint contribution boundary was inconsistent`);

  const trend = entity.trend;
  requireValue(trend?.policy === "one-reviewed-primary-or-sole-mint-per-entity-v1"
    && trend.summedAcrossVariants === false && isNonNegativeInteger(trend.excludedObservedMintCount),
  check, `${path}.trend contribution policy was unsafe`);
  if (trend.contributingMint === null) {
    requireValue(trend.orderingBasis === null && trend.radarRank === null && trend.radarScore === null
      && trend.volume5m === null && trend.momentum === null
      && trend.excludedObservedMintCount === variants.observedMintCount
      && volume.contributingMintCount === 0,
    check, `${path}.trend exposed ordering or metrics without an exact-mint contributor`);
  } else {
    const contributor = variants.included.find(({ mint }) => mint === trend.contributingMint);
    requireValue(contributor
      && trend.radarRank === contributor.metrics.radarRank
      && trend.radarScore === contributor.metrics.radarScore
      && trend.volume5m === contributor.metrics.volume5m
      && trend.momentum === contributor.metrics.momentum
      && trend.orderingBasis === expectedTrendOrderingBasis(contributor)
      && trend.excludedObservedMintCount === variants.observedMintCount - 1
      && volume.contributingMintCount === (contributor.metrics.volume5m === null ? 0 : 1),
    check, `${path}.trend metrics did not cross-check to its one exact contributing mint`);
  }

  if (entity.reviewState === "singleton-unreviewed") {
    const [only] = variants.included;
    requireValue(variants.registeredMintCount === 1 && variants.observedMintCount === 1
      && variants.missingMintCount === 0 && variants.reviewExcluded.length === 0
      && entity.entityId === `~mint:${only?.mint}` && entity.primary.mint === only?.mint
      && only?.kind === "unresolved" && only?.reviewState === "unreviewed"
      && only?.evidenceClass === "unavailable" && only?.registryObservedAt === null
      && trend.contributingMint === only?.mint && trend.selectionReason === "exact-mint-singleton",
    check, `${path} violated singleton exact-mint state semantics`);
  } else {
    requireValue(!entity.entityId.startsWith("~mint:")
      && variants.included.every(({ reviewState }) => reviewState === "verified")
      && variants.excluded.every(({ reviewState }) => reviewState === "verified")
      && [
        "explicit-reviewed-primary", "reviewed-primary-not-observed", "sole-reviewed-variant",
        "sole-reviewed-variant-not-observed", "withheld-ambiguous-no-reviewed-primary", "no-observed-variant"
      ].includes(trend.selectionReason),
    check, `${path} violated reviewed entity state semantics`);
  }
}

function entityTrendComparator(left, right) {
  const priority = {
    "radar-evidence-score": 0,
    "five-minute-volume": 1,
    momentum: 2,
    "token-observation-recency-fallback": 3
  };
  const basisDifference = priority[left.trend.orderingBasis] - priority[right.trend.orderingBasis];
  if (basisDifference) return basisDifference;
  if (left.trend.orderingBasis === "radar-evidence-score") {
    if (right.trend.radarScore !== left.trend.radarScore) return right.trend.radarScore - left.trend.radarScore;
    if (left.trend.radarRank !== null && right.trend.radarRank !== null && left.trend.radarRank !== right.trend.radarRank) {
      return left.trend.radarRank - right.trend.radarRank;
    }
  } else if (left.trend.orderingBasis === "five-minute-volume" && right.trend.volume5m !== left.trend.volume5m) {
    return right.trend.volume5m - left.trend.volume5m;
  } else if (left.trend.orderingBasis === "momentum" && right.trend.momentum !== left.trend.momentum) {
    return right.trend.momentum - left.trend.momentum;
  }
  const leftObserved = left.variants.included.find(({ mint }) => mint === left.trend.contributingMint);
  const rightObserved = right.variants.included.find(({ mint }) => mint === right.trend.contributingMint);
  const recencyDifference = (Date.parse(rightObserved?.tokenObservedAt || "") || 0)
    - (Date.parse(leftObserved?.tokenObservedAt || "") || 0);
  return recencyDifference || codeUnitCompare(left.entityId, right.entityId);
}

function validateEntityEnvelope(intelligence, { path, check, complete }) {
  const denominators = intelligence?.denominators;
  const denominatorKeys = [
    "observedMintCount", "reviewedEntityCount", "reviewedVariantCount", "groupedObservedMintCount",
    "singletonObservedMintCount", "projectionOmittedReviewedMintCount", "entityCount", "trendingEntityCount"
  ];
  requireValue(intelligence?.schemaVersion === 1
    && intelligence.methodVersion === "reviewed-entity-intelligence-v1"
    && Number.isFinite(Date.parse(intelligence.generatedAt))
    && typeof intelligence.universe === "string"
    && denominatorKeys.every((key) => isNonNegativeInteger(denominators?.[key]))
    && denominators.trendingEntityCount <= 20
    && denominators.observedMintCount === denominators.groupedObservedMintCount
      + denominators.singletonObservedMintCount + denominators.projectionOmittedReviewedMintCount
    && denominators.entityCount === denominators.reviewedEntityCount + denominators.singletonObservedMintCount
    && Array.isArray(intelligence.entities)
    && Array.isArray(intelligence.projectionOmittedReviewed)
    && intelligence.projectionOmittedReviewed.length === denominators.projectionOmittedReviewedMintCount
    && intelligence.rankingBoundary?.leaderboardChanged === false
    && intelligence.rankingBoundary?.unreviewedProposalsUsed === false
    && intelligence.rankingBoundary?.entityTrendAffectsMintRank === false
    && intelligence.rankingBoundary?.unreviewedProposalImpact === "none"
    && intelligence.rankingBoundary?.rankingImpact === "none"
    && intelligence.rankingBoundary?.policy === "one-reviewed-primary-or-sole-mint-per-entity-v1"
    && intelligence.api?.list === "/api/v1/entities"
    && intelligence.api?.resolver === "/api/v1/entities/resolve?mint={mint}"
    && intelligence.api?.specification === "/api/v1/openapi.json"
    && intelligence.api?.documentation === "/api.html"
    && intelligence.api?.externalApiKeys === "not-offered",
  check, `${path} envelope, denominator equations, or ranking boundary was invalid`);
  validateRegistryProjection(intelligence.registryProjection, `${path}.registryProjection`, check);
  requireValue(intelligence.registryProjection.reviewedMintOmissionCount
    === intelligence.projectionOmittedReviewed.length,
  check, `${path} projection omission count disagreed with its disclosed rows`);
  for (const [index, entity] of intelligence.entities.entries()) {
    validateEntityAggregate(entity, `${path}.entities[${index}]`, check);
  }
  if (!complete) return;
  const reviewed = intelligence.entities.filter(({ reviewState }) => reviewState === "verified");
  const singletons = intelligence.entities.filter(({ reviewState }) => reviewState === "singleton-unreviewed");
  requireValue(denominators.entityCount === intelligence.entities.length
    && denominators.reviewedEntityCount === reviewed.length
    && denominators.singletonObservedMintCount === singletons.length
    && denominators.reviewedVariantCount
      === reviewed.reduce((sum, entity) => sum + entity.variants.registeredMintCount, 0)
    && denominators.groupedObservedMintCount
      === reviewed.reduce((sum, entity) => sum + entity.variants.observedMintCount, 0)
    && intelligence.registryProjection.publishedCounts.entities === denominators.reviewedEntityCount
    && intelligence.registryProjection.publishedCounts.variants >= denominators.reviewedVariantCount
    && intelligence.registryProjection.prioritizedMintCount === denominators.observedMintCount,
  check, `${path} complete entity arrays did not reconcile to global denominators or registry projection`);
}

function validateEntityTrending(intelligence, check) {
  requireValue(Array.isArray(intelligence.trending)
    && intelligence.trending.length === intelligence.denominators.trendingEntityCount,
  check, "entity trending count did not match its denominator");
  const expected = [...intelligence.entities].filter(({ trend }) => trend.orderingBasis !== null)
    .sort(entityTrendComparator).slice(0, 20);
  requireValue(expected.length === intelligence.trending.length,
    check, "entity trending omitted or added an ordering-eligible entity");
  for (const [index, actual] of intelligence.trending.entries()) {
    const { trendRank, ...entity } = actual;
    requireValue(trendRank === index + 1 && canonicalJsonEqual(entity, expected[index]),
      check, `entity trending rank ${index + 1} did not follow disclosed ordering/null semantics`);
  }
}

function validateResolver(identity, expectedMint) {
  const normalStates = new Set(["singleton-exact-mint", "reviewed-registry-variant"]);
  const omissionStates = new Set(["reviewed-registry-capacity-omitted", "reviewed-registry-integrity-omitted"]);
  requireValue(identity?.schemaVersion === 1 && identity.mint === expectedMint
    && (normalStates.has(identity.resolvedBy) || omissionStates.has(identity.resolvedBy))
    && identity.entity && typeof identity.entity.entityId === "string"
    && identity.variant?.mint === expectedMint
    && identity.primary?.meaning === "identity resolution only; not a safety, quality, or trade recommendation"
    && (identity.primary.mint === null || SOLANA_MINT_PATTERN.test(identity.primary.mint))
    && Array.isArray(identity.relationships) && Array.isArray(identity.proposals)
    && Array.isArray(identity.limitations),
  "identity resolver", "typed exact-mint identity resolution contract was missing");
  const relationshipCoverage = identity.relationshipCoverage;
  requireValue(isNonNegativeInteger(relationshipCoverage?.eligibleCount)
    && isNonNegativeInteger(relationshipCoverage?.publishableEligibleCount)
    && isNonNegativeInteger(relationshipCoverage?.includedCount)
    && isNonNegativeInteger(relationshipCoverage?.limitOmittedCount)
    && isNonNegativeInteger(relationshipCoverage?.projectionOmittedCount)
    && isNonNegativeInteger(relationshipCoverage?.integrityOmittedCount)
    && relationshipCoverage.includedCount === identity.relationships.length
    && relationshipCoverage.eligibleCount === relationshipCoverage.publishableEligibleCount
      + relationshipCoverage.projectionOmittedCount + relationshipCoverage.integrityOmittedCount
    && relationshipCoverage.publishableEligibleCount
      === relationshipCoverage.includedCount + relationshipCoverage.limitOmittedCount
    && relationshipCoverage.limit === 100 && relationshipCoverage.includedCount <= relationshipCoverage.limit
    && relationshipCoverage.truncated === (relationshipCoverage.limitOmittedCount > 0),
  "identity resolver", "reviewed relationship coverage did not reconcile");
  const relationshipKeys = new Set();
  for (const relationship of identity.relationships) {
    const key = JSON.stringify(canonicalJson(relationship));
    requireValue(relationship?.reviewState === "verified"
      && (relationship.fromMint === expectedMint || relationship.toMint === expectedMint)
      && SOLANA_MINT_PATTERN.test(relationship.fromMint || "") && SOLANA_MINT_PATTERN.test(relationship.toMint || "")
      && !relationshipKeys.has(key),
    "identity resolver", "reviewed relationships were not unique verified incident facts");
    relationshipKeys.add(key);
  }
  const proposalCoverage = identity.proposalCoverage;
  requireValue(isNonNegativeInteger(proposalCoverage?.eligibleCount)
    && isNonNegativeInteger(proposalCoverage?.includedCount)
    && isNonNegativeInteger(proposalCoverage?.omittedInvalidCount)
    && proposalCoverage.includedCount === identity.proposals.length
    && proposalCoverage.eligibleCount
      === proposalCoverage.includedCount + proposalCoverage.omittedInvalidCount,
  "identity resolver", "proposal coverage did not reconcile");
  for (const proposal of identity.proposals) {
    requireValue(proposal?.reviewState === "proposed"
      && (proposal.fromMint === expectedMint || proposal.toMint === expectedMint)
      && SOLANA_MINT_PATTERN.test(proposal.fromMint || "") && SOLANA_MINT_PATTERN.test(proposal.toMint || ""),
    "identity resolver", "unreviewed proposals were not visibly separate exact-mint incident candidates");
  }
  if (identity.resolvedBy === "singleton-exact-mint") {
    requireValue(identity.entity.entityId === `~mint:${expectedMint}`
      && identity.entity.reviewState === "singleton-unreviewed"
      && identity.variant.kind === "unresolved" && identity.variant.reviewState === "unreviewed"
      && identity.variant.evidenceClass === "unavailable"
      && identity.primary.mint === expectedMint && identity.primary.selectionReason === "only-exact-mint"
      && identity.relationships.length === 0 && relationshipCoverage.eligibleCount === 0
      && relationshipCoverage.publishableEligibleCount === 0
      && relationshipCoverage.limitOmittedCount === 0
      && relationshipCoverage.projectionOmittedCount === 0
      && relationshipCoverage.integrityOmittedCount === 0,
    "identity resolver", "singleton resolution state semantics were invalid");
  } else {
    requireValue(identity.entity.reviewState === "verified" && identity.variant.reviewState === "verified",
      "identity resolver", "reviewed or omission resolution was mislabeled as unreviewed");
    if (identity.resolvedBy === "reviewed-registry-variant") {
      requireValue(["explicit-reviewed-primary", "only-reviewed-variant", "withheld-ambiguous"].includes(identity.primary.selectionReason),
        "identity resolver", "reviewed primary selection state was invalid");
    } else {
      requireValue(identity.relationships.length === 0
        && ["explicit-reviewed-primary", "reviewed-primary-outside-bounded-projection", "withheld-ambiguous"].includes(identity.primary.selectionReason),
      "identity resolver", "typed registry omission state was invalid");
    }
  }
}

function validateTimelinePage(timeline, expectedMint, path) {
  requireValue(timeline?.schemaVersion === 1 && timeline.mint === expectedMint
    && timeline.limit === TIMELINE_PAGE_LIMIT && Array.isArray(timeline.entries)
    && timeline.entries.length <= TIMELINE_PAGE_LIMIT
    && timeline.rawProviderPayloadsIncluded === false
    && (timeline.nextBefore === null || (typeof timeline.nextBefore === "string" && timeline.nextBefore.length > 0))
    && isCanonicalTimeOrNull(timeline.historyAvailableSince),
  "timeline", `${path} typed paginated timeline contract was missing`);
  for (const [index, entry] of timeline.entries.entries()) {
    requireValue(entry && typeof entry.kind === "string" && Number.isFinite(Date.parse(entry.at))
      && typeof entry.evidenceClass === "string" && typeof entry.title === "string" && typeof entry.detail === "string",
    "timeline", `${path}.entries[${index}] was not a typed retained observation`);
  }
}

function resolveOpenApiReference(document, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined, document);
}

function validateOpenApi(openapi, checkedIn, expectedVersion) {
  requireValue(canonicalJsonEqual(openapi, checkedIn), "openapi",
    "served specification drifted from public/openapi.json");
  requireValue(openapi?.openapi === "3.1.0" && openapi.info?.version === expectedVersion
    && Array.isArray(openapi.security) && openapi.security.length === 0
    && openapi.components?.securitySchemes === undefined,
  "openapi", "version, root security, or security-scheme boundary was invalid");
  const paths = openapi.paths;
  requireValue(paths && canonicalJsonEqual(Object.keys(paths).sort(codeUnitCompare), Object.keys(OPENAPI_ROUTE_METHODS).sort(codeUnitCompare)),
    "openapi", "documented route set drifted from the runtime contract");
  for (const [pathname, method] of Object.entries(OPENAPI_ROUTE_METHODS)) {
    requireValue(paths[pathname] && canonicalJsonEqual(Object.keys(paths[pathname]), [method])
      && paths[pathname][method]?.responses?.["200"] && paths[pathname][method]?.responses?.["405"],
    "openapi", `${pathname} did not document exactly the supported ${method.toUpperCase()} method`);
  }
  requireValue(Object.keys(paths).every((pathname) => !pathname.startsWith("/api/export/")),
    "openapi", "filesystem export routes appeared in the public specification");
  const visit = (value, path = "openapi") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (key === "$ref") {
        requireValue(typeof child === "string" && child.startsWith("#/")
          && resolveOpenApiReference(openapi, child) !== undefined,
        "openapi", `${childPath} was external or unresolved`);
      }
      if (key === "security" && childPath !== "openapi.security") {
        requireValue(false, "openapi", `${childPath} introduced an operation security requirement`);
      }
      visit(child, childPath);
    }
  };
  visit(openapi);
}

function validateMeasuredBrief(brief, period, check) {
  requireValue(brief?.schemaVersion === 1 && brief.methodVersion === "measured-closed-brief-v2" && brief.period === period,
    check, `${period} frozen brief contract was missing`);
  requireValue(brief.timezone === "UTC" && brief.feedCoverage === "unmeasured"
    && brief.rawProviderPayloadsIncluded === false, check, `${period} brief truthfulness boundary was missing`);
  requireValue(Number.isFinite(Date.parse(brief.windowStart)) && Number.isFinite(Date.parse(brief.windowEnd))
    && Date.parse(brief.windowStart) < Date.parse(brief.windowEnd), check, `${period} brief closed interval was invalid`);
  const validateActivity = (activity, path) => {
    requireValue(activity && Number.isSafeInteger(activity.launchesObserved)
      && Number.isSafeInteger(activity.materialAlerts), check, `${path} activity denominators were missing`);
    const materialByKind = activity.materialByKind;
    const telegramDelivery = activity.telegramDelivery;
    requireValue(materialByKind && typeof materialByKind === "object" && !Array.isArray(materialByKind)
      && Object.entries(materialByKind).every(([kind, count]) => MATERIAL_ALERT_KINDS.has(kind)
        && Number.isSafeInteger(count) && count >= 0)
      && Object.values(materialByKind).reduce((total, count) => total + count, 0) === activity.materialAlerts,
    check, `${path} material-event denominator was inconsistent or included a pre-policy kind`);
    requireValue(telegramDelivery && typeof telegramDelivery === "object" && !Array.isArray(telegramDelivery)
      && Object.entries(telegramDelivery).every(([status, count]) => TELEGRAM_DELIVERY_STATES.has(status)
        && Number.isSafeInteger(count) && count >= 0)
      && Object.values(telegramDelivery).reduce((total, count) => total + count, 0) === activity.materialAlerts,
    check, `${path} Telegram denominator was inconsistent with material events`);
  };
  validateActivity(brief.activity, `${period} brief`);
  validateActivity(brief.priorPeriod?.activity, `${period} prior-period brief`);
  requireValue(brief.priorPeriod?.windowEnd === brief.windowStart, check, `${period} prior-period comparison boundary was missing`);
  for (const windowName of ["5m", "15m", "1h", "6h", "24h"]) {
    const metric = brief.outcomes?.windows?.[windowName];
    requireValue(metric && Number.isSafeInteger(metric.eligibleCount) && Number.isSafeInteger(metric.evidenceCount)
      && metric.evidenceCount <= metric.eligibleCount, check, `${period} ${windowName} denominator was invalid`);
    requireValue(metric.eligibleCount === 0 ? metric.coverageRatio === null
      : Number.isFinite(metric.coverageRatio) && metric.coverageRatio >= 0 && metric.coverageRatio <= 1,
    check, `${period} ${windowName} coverage did not distinguish an empty denominator from 0%`);
    if (metric.status === "insufficient-evidence") {
      requireValue(metric.hitRatePct === null && metric.medianReturnPct === null && metric.maximumDrawdownPct === null,
        check, `${period} ${windowName} sparse evidence was presented as performance`);
    }
  }
}

export async function runSmokeChecks({ baseUrl, expectedVersion, expectedMode, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  requireValue(typeof baseUrl === "string" && /^https?:\/\//.test(baseUrl), "configuration", "baseUrl must use http or https");
  requireValue(typeof expectedVersion === "string" && /^\d+\.\d+\.\d+$/.test(expectedVersion), "configuration", "expectedVersion must be semantic x.y.z");
  requireValue(["live", "demo"].includes(expectedMode), "configuration", "expectedMode must be live or demo");

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const [healthResult, snapshotResult, htmlResult, scriptResult, refreshScriptResult, preferencesResult, stylesResult, helpResult, apiDocsResult, openapiResult, termsResult, privacyResult] = await Promise.all([
    request(normalizedBaseUrl, "/api/health", { timeoutMs, fetchImpl, headers: { "accept-encoding": "gzip" } }),
    request(normalizedBaseUrl, "/api/snapshot", { timeoutMs, fetchImpl, headers: { "accept-encoding": "gzip" } }),
    request(normalizedBaseUrl, "/", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/app.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/snapshot-refresh.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/preferences.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/styles.css", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/help.html", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api.html", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/v1/openapi.json", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/terms.html", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/privacy.html", { timeoutMs, fetchImpl })
  ]);
  const initialHealth = parseJson(healthResult, "health");
  const snapshot = parseJson(snapshotResult, "snapshot");
  const expectedFeedState = expectedMode === "live" ? "live" : "simulated";
  requireValue(snapshot.version === expectedVersion, "snapshot", `version ${snapshot.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(snapshot.mode === expectedMode, "snapshot", `mode ${snapshot.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(snapshot.status === "healthy", "snapshot", `status ${snapshot.status ?? "missing"} was not healthy`);
  requireValue(snapshot.publicDelivery?.vaultExports === "disabled", "snapshot",
    "HTTP vault export boundary was not declared disabled before guard verification");
  const vaultExportGuardResult = await request(normalizedBaseUrl, "/api/export/coin/not-a-solana-mint", {
    timeoutMs,
    fetchImpl,
    method: "POST",
    expectedStatus: 403
  });
  const vaultExportGuard = parseJson(vaultExportGuardResult, "vault export guard");
  requireValue(vaultExportGuard?.ok === false
    && vaultExportGuard.code === "vault-export-disabled"
    && vaultExportGuard.error === "Filesystem-writing HTTP vault export is disabled"
    && vaultExportGuard.mode === expectedMode
    && typeof vaultExportGuard.requestId === "string" && vaultExportGuard.requestId.length > 0
    && vaultExportGuardResult.contentType.toLowerCase().includes("application/json")
    && vaultExportGuardResult.nosniff.toLowerCase() === "nosniff",
  "vault export guard", "HTTP export route did not fail closed in the configured mode");
  if (expectedMode === "live" && (!Array.isArray(snapshot.riskIntelligence?.cohort?.observations)
    || snapshot.riskIntelligence.cohort.observations.length !== RISK_COHORT_LIMIT)) {
    throw new SmokeCheckError("snapshot", "risk identity fixed cohort did not expose 120 unique inspectable observations");
  }
  const endpointMints = [...new Set([
    ...(snapshot.riskIntelligence?.cohort?.observations || []).map(({ mint }) => mint),
    ...(snapshot.tokens || []).map(({ mint }) => mint),
    ...(snapshot.leaderboard?.top100 || []).map((entry) => entry?.token?.mint)
  ].filter((mint) => typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)))].slice(0, 2);
  requireValue(endpointMints.length === 2, "snapshot", "two exact retained mints were unavailable for release endpoint smoke checks");
  const [dossierResult, timelineResult, compareResult, dailyBriefResult, weeklyBriefResult, entityListResult, identityResult, identityWriteGuardResult] = await Promise.all([
    request(normalizedBaseUrl, `/api/coins/${endpointMints[0]}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/coins/${endpointMints[0]}/timeline?limit=${TIMELINE_PAGE_LIMIT}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/compare?mints=${encodeURIComponent(endpointMints.join(","))}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/briefs/daily", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/briefs/weekly", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/v1/entities?limit=${ENTITY_PAGE_LIMIT}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/v1/entities/resolve?mint=${encodeURIComponent(endpointMints[0])}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/v1/entities/resolve?mint=${encodeURIComponent(endpointMints[0])}`, { timeoutMs, fetchImpl, method: "POST", expectedStatus: 405 })
  ]);
  const dossier = parseJson(dossierResult, "dossier");
  const timeline = parseJson(timelineResult, "timeline");
  const comparison = parseJson(compareResult, "compare");
  const dailyBrief = parseJson(dailyBriefResult, "daily brief");
  const weeklyBrief = parseJson(weeklyBriefResult, "weekly brief");
  const entityList = parseJson(entityListResult, "entity list");
  const identity = parseJson(identityResult, "identity resolver");
  const identityWriteGuard = parseJson(identityWriteGuardResult, "identity write guard");
  const openapi = parseJson(openapiResult, "openapi");

  for (const [check, result, expectedType] of [
    ["health", healthResult, "application/json"],
    ["snapshot", snapshotResult, "application/json"],
    ["html", htmlResult, "text/html"],
    ["app.js", scriptResult, "text/javascript"],
    ["snapshot-refresh.js", refreshScriptResult, "text/javascript"],
    ["preferences.js", preferencesResult, "text/javascript"],
    ["styles.css", stylesResult, "text/css"],
    ["help", helpResult, "text/html"],
    ["api docs", apiDocsResult, "text/html"],
    ["openapi", openapiResult, "application/json"],
    ["terms", termsResult, "text/html"],
    ["privacy", privacyResult, "text/html"],
    ["dossier", dossierResult, "application/json"],
    ["timeline", timelineResult, "application/json"],
    ["compare", compareResult, "application/json"],
    ["daily brief", dailyBriefResult, "application/json"],
    ["weekly brief", weeklyBriefResult, "application/json"]
    , ["entity list", entityListResult, "application/json"]
    , ["identity resolver", identityResult, "application/json"]
    , ["identity write guard", identityWriteGuardResult, "application/json"]
  ]) {
    requireValue(result.contentType.toLowerCase().includes(expectedType), check, `content-type ${result.contentType || "missing"} did not include ${expectedType}`);
    requireValue(result.nosniff.toLowerCase() === "nosniff", check, "x-content-type-options nosniff was missing");
  }
  const compressedLength = Number(snapshotResult.contentLength);
  requireValue(snapshotResult.contentEncoding.toLowerCase() === "gzip", "snapshot",
    `gzip content encoding was missing at the public edge (${snapshotResult.contentEncoding || "none"})`);
  requireValue(snapshotResult.vary.toLowerCase().split(",").map((value) => value.trim()).includes("accept-encoding"),
    "snapshot", `Vary: Accept-Encoding was missing at the public edge (${snapshotResult.vary || "none"})`);
  requireValue(Number.isSafeInteger(compressedLength) && compressedLength > 0
    && compressedLength < Buffer.byteLength(snapshotResult.body) / 2,
  "snapshot", "public snapshot was not materially smaller over gzip transport");

  requireValue(dossier?.schemaVersion === 1 && dossier?.token?.mint === endpointMints[0]
    && dossier?.radar && dossier?.timeline === `/api/coins/${endpointMints[0]}/timeline`, "dossier", "strict public dossier contract was missing");
  requireValue(dossier?.identity?.mint === endpointMints[0] && Array.isArray(dossier.identity.proposals),
    "dossier", "canonical identity projection was missing from the dossier");
  validateResolver(identity, endpointMints[0]);
  requireValue(identityWriteGuard?.ok === false && identityWriteGuardResult.status === 405,
    "identity write guard", "public identity writes did not fail closed");
  validateRateHeaders(snapshotResult, 120, "snapshot");
  validateRateHeaders(identityResult, 120, "identity resolver");

  const entityPages = [entityList];
  const entityPageResults = [entityListResult];
  const entityCursors = new Set();
  while (entityPages.at(-1)?.page?.nextCursor !== null) {
    const cursor = entityPages.at(-1)?.page?.nextCursor;
    requireValue(typeof cursor === "string" && cursor.length > 0 && !entityCursors.has(cursor),
      "entity list", "entity cursor was empty or repeated");
    requireValue(entityPages.length < MAX_ENTITY_PAGES,
      "entity list", "entity pagination exceeded the bounded registry capacity");
    entityCursors.add(cursor);
    const result = await request(normalizedBaseUrl,
      `/api/v1/entities?limit=${ENTITY_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`,
      { timeoutMs, fetchImpl });
    requireValue(result.contentType.toLowerCase().includes("application/json")
      && result.nosniff.toLowerCase() === "nosniff",
    "entity list", "a followed entity page lost JSON or nosniff response hardening");
    validateRateHeaders(result, 120, "entity list");
    entityPageResults.push(result);
    entityPages.push(parseJson(result, "entity list"));
  }
  const pagedEntityIds = [];
  for (const [pageIndex, page] of entityPages.entries()) {
    validateRateHeaders(entityPageResults[pageIndex], 120, "entity list");
    validateEntityEnvelope(page, { path: `entity list page ${pageIndex + 1}`, check: "entity list", complete: false });
    requireValue(page.page?.order === "entity-id-ascending" && page.page.limit === ENTITY_PAGE_LIMIT
      && page.page.count === page.entities.length && page.entities.length <= ENTITY_PAGE_LIMIT
      && (page.page.nextCursor === null || (typeof page.page.nextCursor === "string" && page.entities.length > 0)),
    "entity list", `page ${pageIndex + 1} pagination metadata was invalid`);
    for (const entity of page.entities) pagedEntityIds.push(entity.entityId);
    rejectPublicIdentityLeaks(page, `entity list page ${pageIndex + 1}`, "entity list");
  }
  requireValue(pagedEntityIds.length > 0
    && new Set(pagedEntityIds).size === pagedEntityIds.length
    && pagedEntityIds.every((entityId, index) => index === 0
      || codeUnitCompare(pagedEntityIds[index - 1], entityId) < 0),
  "entity list", "followed entity pages were duplicated or not in strict code-unit entity-ID order");

  const timelinePages = [timeline];
  const timelineCursors = new Set();
  validateTimelinePage(timeline, endpointMints[0], "page 1");
  while (timelinePages.at(-1).nextBefore !== null) {
    const before = timelinePages.at(-1).nextBefore;
    requireValue(typeof before === "string" && before.length > 0 && !timelineCursors.has(before),
      "timeline", "timeline cursor was empty or repeated");
    requireValue(timelinePages.length < MAX_TIMELINE_PAGES,
      "timeline", "timeline pagination exceeded the bounded retained surface");
    timelineCursors.add(before);
    const result = await request(normalizedBaseUrl,
      `/api/coins/${endpointMints[0]}/timeline?limit=${TIMELINE_PAGE_LIMIT}&before=${encodeURIComponent(before)}`,
      { timeoutMs, fetchImpl });
    requireValue(result.contentType.toLowerCase().includes("application/json")
      && result.nosniff.toLowerCase() === "nosniff",
    "timeline", "a followed timeline page lost JSON or nosniff response hardening");
    const page = parseJson(result, "timeline");
    validateTimelinePage(page, endpointMints[0], `page ${timelinePages.length + 1}`);
    timelinePages.push(page);
  }
  const timelineEntries = timelinePages.flatMap(({ entries }) => entries);
  const timelineEntryKeys = timelineEntries.map((entry) => JSON.stringify(canonicalJson(entry)));
  requireValue(new Set(timelineEntryKeys).size === timelineEntryKeys.length
    && timelineEntries.every((entry, index) => index === 0
      || Date.parse(timelineEntries[index - 1].at) >= Date.parse(entry.at)),
  "timeline", "followed timeline pages contained duplicates or violated reverse-time order");
  for (const [index, page] of timelinePages.entries()) {
    rejectPublicIdentityLeaks(page, `timeline page ${index + 1}`, "timeline");
  }

  let checkedInOpenApi;
  try {
    checkedInOpenApi = JSON.parse((await readFile(path.join(root, "public", "openapi.json"), "utf8"))
      .replaceAll("__APP_VERSION__", expectedVersion));
  } catch (error) {
    throw new SmokeCheckError("openapi", `checked-in public/openapi.json was unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateOpenApi(openapi, checkedInOpenApi, expectedVersion);
  requireValue(Object.hasOwn(dossier, "earlyActor"), "dossier", "early-actor evidence field was missing");
  if (dossier.earlyActor !== null) validateActorSummary(dossier.earlyActor, endpointMints[0], "dossier.earlyActor", "dossier");
  requireValue(comparison?.schemaVersion === 1 && JSON.stringify(comparison.requestedMints) === JSON.stringify(endpointMints)
    && Array.isArray(comparison.coins) && comparison.coins.length === endpointMints.length
    && Array.isArray(comparison.missingMints) && comparison.missingMints.length === 0
    && comparison.rankingBoundary === "uncalibrated risk factors do not affect radar rank", "compare", "bounded comparison contract was missing");
  const comparedDossier = comparison.coins.find((coin) => coin.mint === endpointMints[0]);
  requireValue(comparedDossier?.riskEvidence === (dossier.token?.riskIdentity?.overallEvidence || "unavailable"),
    "compare", "comparison and dossier risk projections disagreed");
  for (const windowName of ["5m", "15m", "1h", "6h", "24h"]) {
    const dossierWindow = dossier.outcome?.windows?.[windowName];
    if (dossierWindow?.status === "observed") {
      requireValue(comparedDossier?.outcomes?.[windowName]?.status === "observed"
        && comparedDossier.outcomes[windowName].returnPct === dossierWindow.returnPct,
      "compare", `${windowName} retained outcome disagreed with the dossier`);
    }
  }
  validateMeasuredBrief(dailyBrief, "daily", "daily brief");
  validateMeasuredBrief(weeklyBrief, "weekly", "weekly brief");

  const healthAfterCallsResult = await request(normalizedBaseUrl, "/api/health", {
    timeoutMs, fetchImpl, headers: { "accept-encoding": "gzip" }
  });
  requireValue(healthAfterCallsResult.contentType.toLowerCase().includes("application/json")
    && healthAfterCallsResult.nosniff.toLowerCase() === "nosniff",
  "health", "post-call health refetch lost JSON or nosniff response hardening");
  const health = parseJson(healthAfterCallsResult, "health");
  requireValue(initialHealth?.version === expectedVersion && initialHealth.mode === expectedMode,
    "health", "initial health response disagreed with release configuration");

  requireValue(health.ok === true, "health", "ok was not true");
  requireValue(health.status === "healthy", "health", `status ${health.status ?? "missing"} was not healthy`);
  requireValue(health.version === expectedVersion, "health", `version ${health.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(health.mode === expectedMode, "health", `mode ${health.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(Number.isFinite(health.service?.uptimeSeconds) && health.service.uptimeSeconds >= 0, "health", "service uptime telemetry was missing");
  requireValue(Number.isFinite(health.feed?.staleAfterSeconds) && health.feed.staleAfterSeconds > 0, "health", "feed staleness threshold was missing");
  requireValue(health.feed?.state === expectedFeedState, "health", `feed state ${health.feed?.state ?? "missing"} did not match ${expectedFeedState}`);
  if (expectedMode === "live") requireValue(health.feed?.isStale === false, "health", "live feed was not explicitly fresh");
  if (expectedMode === "live") requireValue(health.storage?.mountPointVerified === true, "health", "database mount point was not verified");
  requireValue(health.telemetry?.format === "json-lines" && Number.isFinite(health.telemetry?.errorsTotal), "health", "structured error telemetry was missing");
  requireValue(health.telemetry?.responses5xx === 0, "health", `runtime recorded ${health.telemetry?.responses5xx ?? "missing"} HTTP 5xx responses`);
  requireValue(health.actionIntelligence?.schemaVersion === 1
    && health.actionIntelligence?.watchlistPersistence === "browser-local"
    && health.actionIntelligence?.alertDedupe === "persistent"
    && health.actionIntelligence?.materialPersistence === "atomic-with-durable-baseline",
  "health", "action intelligence health contract was missing");
  requireValue(health.identityRegistry?.schemaVersion === 1
    && health.identityRegistry.proposalMethod === "metadata-collision-proposals-v1"
    && health.identityRegistry.pendingProposalLimit === 500
    && Number(health.identityRegistry.proposalStatusCounts?.pending || 0) <= health.identityRegistry.pendingProposalLimit
    && health.identityRegistry.automatedVerification === false
    && health.identityRegistry.publicWrites === false
    && /identity resolution only/.test(health.identityRegistry.primaryMeaning || ""),
  "health", "canonical identity review and public-write boundaries were missing");
  requireValue(["configured", "not-configured"].includes(health.actionIntelligence?.telegram?.status)
    && typeof health.actionIntelligence?.telegram?.tokenConfigured === "boolean"
    && typeof health.actionIntelligence?.telegram?.chatConfigured === "boolean"
    && health.actionIntelligence?.telegram?.outbox
    && Number.isSafeInteger(health.actionIntelligence.telegram.outbox.total), "health", "aggregate Telegram outbox health was missing");
  requireValue(!/(?:bot\d*:|telegram_chat_id|telegram_bot_token|chatId|token\s*[=:])/i.test(JSON.stringify(health.actionIntelligence)),
    "health", "Telegram credentials or destination identifiers leaked into health");
  requireValue(health.outcomes?.source === "geckoterminal", "health", "outcome provider identity was missing");
  const allowedOutcomeStates = expectedMode === "live"
    ? ["idle", "enriching", "pool-selected", "observing", "awaiting-data", "awaiting-pool", "awaiting-price", "baseline-unavailable", "rate-limited", "degraded", "invalid-response", "complete"]
    : ["simulation-disabled"];
  requireValue(allowedOutcomeStates.includes(health.outcomes?.status), "health", `outcome engine state ${health.outcomes?.status ?? "missing"} was not explicit`);
  requireValue(Number.isFinite(health.outcomes?.queueDepth) && health.outcomes.queueDepth >= 0, "health", "outcome queue telemetry was missing");
  if (expectedMode === "live") {
    const attemptedInRuntime = Number.isFinite(health.outcomes?.counters?.attempts) && health.outcomes.counters.attempts >= 1;
    const attemptedPersistently = Number.isFinite(health.outcomes?.persistence?.attemptCount) && health.outcomes.persistence.attemptCount >= 1;
    const succeededInRuntime = Number.isFinite(health.outcomes?.counters?.successes) && health.outcomes.counters.successes >= 1;
    const succeededPersistently = Number.isFinite(health.outcomes?.persistence?.successfulStateCount) && health.outcomes.persistence.successfulStateCount >= 1;
    requireValue(attemptedInRuntime || attemptedPersistently, "health", "outcome provider was never attempted in runtime or persisted state");
    requireValue(succeededInRuntime || succeededPersistently, "health", "outcome provider has no successful runtime or persisted refresh");
    requireValue(typeof health.outcomes?.lastSuccessAt === "string", "health", "outcome provider has no successful timestamp");
    const dueStateCount = health.outcomes?.persistence?.dueStateCount;
    requireValue(Number.isSafeInteger(dueStateCount) && dueStateCount >= 0,
      "health", "outcome provider due-work telemetry is missing or invalid");
    requireValue(health.outcomes?.successFreshnessBasis === "provider-success-age-while-scheduled-work-is-due",
      "health", "outcome provider demand-aware freshness basis is missing");
    const providerWorkDue = dueStateCount > 0 || health.outcomes.queueDepth > 0 || health.outcomes.status === "enriching";
    const expectedStale = health.outcomes.lastSuccessAgeSeconds < 0
      || (providerWorkDue && health.outcomes.lastSuccessAgeSeconds > health.outcomes.successStaleAfterSeconds);
    requireValue(Number.isFinite(health.outcomes?.lastSuccessAgeSeconds) && Number.isFinite(health.outcomes?.successStaleAfterSeconds)
      && health.outcomes.lastSuccessIsStale === expectedStale,
    "health", "outcome provider demand-aware freshness telemetry was inconsistent");
    requireValue(health.outcomes.lastSuccessIsStale === false, "health", "outcome provider success evidence is stale or missing");
    requireValue(Number(health.outcomes?.counters?.consecutiveFailures) <= 3, "health", "outcome provider has repeated consecutive failures");
  }
  requireValue(health.riskIntelligence?.source === "geckoterminal", "health", "risk identity provider identity was missing");
  const allowedRiskStates = expectedMode === "live"
    ? ["idle", "enriching", "queued", "available", "unavailable", "rate-limited", "degraded", "invalid-response"]
    : ["simulation-disabled"];
  requireValue(allowedRiskStates.includes(health.riskIntelligence?.status), "health", `risk identity engine state ${health.riskIntelligence?.status ?? "missing"} was not explicit`);
  requireValue(Number.isFinite(health.riskIntelligence?.queueDepth) && health.riskIntelligence.queueDepth >= 0, "health", "risk identity queue telemetry was missing");
  if (expectedMode === "live") {
    const attempts = health.riskIntelligence?.counters?.attempts;
    const successes = health.riskIntelligence?.counters?.successes;
    requireValue(
      Number.isSafeInteger(attempts) && attempts >= 0
        && Number.isSafeInteger(successes) && successes >= 0 && attempts >= successes,
      "health", "risk identity process-local acquisition counters were missing or inconsistent"
    );
    const serviceStartedAt = Date.parse(health.service?.startedAt);
    const runtimeLastSuccessAt = Date.parse(health.riskIntelligence?.runtimeLastSuccessAt);
    requireValue(Number.isFinite(serviceStartedAt), "health", "service start timestamp was missing for post-deploy risk evidence");
    const audit = health.riskIntelligence?.parserRevisionAudit;
    requireValue(
      audit && audit.currentRevision === RISK_IDENTITY_PARSER_REVISION
        && audit.fullCohortAtStart === true
        && audit.targetStateCount === RISK_PARSER_AUDIT_SAMPLE_LIMIT
        && audit.sampleStateCount === RISK_PARSER_AUDIT_SAMPLE_LIMIT
        && Number.isSafeInteger(audit.currentDispositionCountAtStart)
        && audit.currentDispositionCountAtStart >= 0
        && audit.currentDispositionCountAtStart <= RISK_PARSER_AUDIT_SAMPLE_LIMIT
        && audit.currentDispositionCount === RISK_PARSER_AUDIT_SAMPLE_LIMIT
        && Number.isSafeInteger(audit.currentAcquisitionCount) && audit.currentAcquisitionCount >= 1
        && audit.currentAcquisitionCount <= audit.currentDispositionCount
        && ["complete", "complete-with-failures"].includes(audit.status),
      "health", "risk identity current-parser audit sample was incomplete or had no successful acquisition"
    );
    const freshRuntimeAcquisition = successes >= 1
      && Number.isFinite(runtimeLastSuccessAt) && runtimeLastSuccessAt >= serviceStartedAt;
    const completePersistedRestartProof = audit.currentDispositionCountAtStart === RISK_PARSER_AUDIT_SAMPLE_LIMIT
      && audit.eligibleStateCountAtStart === 0
      && audit.selectedStateCount === 0 && audit.attempts === 0;
    requireValue(freshRuntimeAcquisition || completePersistedRestartProof, "health",
      "risk identity parser acquisition was neither fresh in this process nor a complete persisted restart proof");
    requireValue(typeof health.riskIntelligence?.persistedLastSuccessAt === "string", "health",
      "risk identity persisted successful acquisition timestamp was missing");
    requireValue(health.riskIntelligence?.ongoingFreshnessRequired === false
      && health.riskIntelligence?.evidenceAcquisition === "bounded-one-time-15m-with-one-missing-or-stale-retry", "health", "risk identity bounded acquisition policy was missing");
  }
  validateActorEngine(health.earlyActors, "health.earlyActors", "health", expectedMode);

  requireValue(snapshot.version === expectedVersion, "snapshot", `version ${snapshot.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(snapshot.mode === expectedMode, "snapshot", `mode ${snapshot.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(snapshot.status === "healthy", "snapshot", `status ${snapshot.status ?? "missing"} was not healthy`);
  requireValue(snapshot.feed?.freshnessBasis === "verified-feed-activity", "snapshot", "verified feed freshness evidence was missing");
  requireValue(snapshot.feed?.state === expectedFeedState, "snapshot", `feed state ${snapshot.feed?.state ?? "missing"} did not match ${expectedFeedState}`);
  if (expectedMode === "live") requireValue(snapshot.feed?.isStale === false, "snapshot", "live feed was not explicitly fresh");
  if (expectedMode === "live") requireValue(snapshot.storage?.mountPointVerified === true, "snapshot", "database mount point was not verified");
  requireValue(Number.isFinite(snapshot.service?.uptimeSeconds), "snapshot", "service uptime was missing");
  requireValue(snapshot.outcomes?.schemaVersion === 1, "snapshot", "outcome engine schema was missing");
  requireValue(snapshot.identityRegistry?.schemaVersion === 1
    && snapshot.identityRegistry.automatedVerification === false
    && snapshot.identityRegistry.publicWrites === false,
  "snapshot", "canonical identity review boundary was missing");
  for (const key of [
    "entityCount", "variantCount", "relationshipCount", "verifiedEntityCount",
    "verifiedVariantCount", "verifiedRelationshipCount", "decisionCount"
  ]) {
    requireValue(isNonNegativeInteger(snapshot.identityRegistry[key])
      && snapshot.identityRegistry[key] === health.identityRegistry?.[key],
    "snapshot", `canonical identity ${key} coverage disagreed across health and snapshot`);
  }
  requireValue(snapshot.leaderboard?.schemaVersion === 2
    && snapshot.leaderboard?.ranking?.metric === "evidence_score_or_recency_v2"
    && snapshot.leaderboard?.ranking?.scorePolicy === "withheld-without-substantive-input", "snapshot", "truthful v2 leaderboard contract was missing");
  requireValue(snapshot.outcomes?.revisionPolicy === "first-observed-derived-value-per-window-provider-revision", "snapshot", "per-window provider revision policy was missing");
  requireValue(snapshot.outcomes?.source?.id === "geckoterminal" && snapshot.outcomes.source.apiVersion === "20230203", "snapshot", "pinned GeckoTerminal source evidence was missing");
  requireValue(snapshot.outcomes?.source?.rawResponsesPersisted === false && snapshot.outcomes?.source?.rawCandlesPersisted === false
    && snapshot.outcomes?.source?.providerOhlcvValuesPersisted === false, "snapshot", "provider retention boundary was missing");
  requireValue(snapshot.outcomes?.sampling?.policy === "prospective-fixed-admission-v1"
    && snapshot.outcomes.sampling.cohortLimit === 120 && snapshot.outcomes.sampling.selectionDeadlineSeconds === 120
    && snapshot.outcomes.sampling.poolDiscoveryScope?.includes("page=1")
    && snapshot.outcomes.sampling.selectionPriority === "unselected launches before candle retrieval",
  "snapshot", "prospective outcome sampling policy was missing");
  requireValue(!/"(?:open|high|low|close|volume)":/.test(JSON.stringify(snapshot.outcomes)), "snapshot", "persisted provider OHLCV values leaked into the public outcome contract");
  for (const window of ["5m", "15m", "1h", "6h", "24h"]) {
    const metric = snapshot.outcomes?.summary?.windows?.[window];
    requireValue(metric && ["sufficient-evidence", "insufficient-evidence"].includes(metric.status), "snapshot", `${window} outcome summary status was missing`);
    requireValue(Number.isFinite(metric.evidenceCount) && Number.isFinite(metric.missingCount), "snapshot", `${window} outcome coverage counts were missing`);
    if (metric.status === "sufficient-evidence") {
      requireValue(Number.isFinite(metric.hitRatePct) && Number.isFinite(metric.medianReturnPct) && Number.isFinite(metric.maximumDrawdownPct), "snapshot", `${window} measured outcome metrics were invalid`);
    } else {
      requireValue(metric.hitRatePct === null && metric.medianReturnPct === null && metric.maximumDrawdownPct === null, "snapshot", `${window} insufficient evidence was presented as performance`);
    }
  }
  requireValue(Array.isArray(snapshot.outcomes?.cohorts?.narrative?.cohorts) && Array.isArray(snapshot.outcomes?.cohorts?.lifecycle?.cohorts), "snapshot", "outcome cohort contracts were missing");
  const action = snapshot.actionIntelligence;
  requireValue(action?.schemaVersion === 1 && action.watchlists?.persistence === "browser-local"
    && action.watchlists?.maximumMints === 50 && action.watchlists?.sharedServerWatchlist === false,
  "snapshot", "browser-local watchlist boundary was missing");
  requireValue(action.alerts?.deduplicatedPersistently === true && action.alerts?.scoreChangeThreshold === 15
    && action.alerts?.riskFactorsAreUncalibrated === true
    && action.alerts?.persistence === "atomic-event-alert-outbox-with-durable-baseline"
    && action.alerts?.publicDeliveryMetadata === "aggregate-only"
    && ["risk-identity-reuse", "risk-creator-history", "migration-observed"].every((kind) => action.alerts?.supportedKinds?.includes(kind)),
  "snapshot", "material-change policy contract was missing");
  requireValue(action.timelines?.cursorPagination === true && action.timelines?.maximumEntries === 200
    && action.timelines?.rawProviderPayloadsIncluded === false
    && action.compare?.minimumMints === 2 && action.compare?.maximumMints === 4,
  "snapshot", "timeline or comparison contract was missing");
  validateMeasuredBrief(action.briefs?.daily, "daily", "snapshot");
  validateMeasuredBrief(action.briefs?.weekly, "weekly", "snapshot");
  requireValue(!/(?:telegram_chat_id|telegram_bot_token|chatId|bot\d*:)/i.test(JSON.stringify(action.alerts?.telegram)),
    "snapshot", "Telegram credentials or destination identifiers leaked into snapshot");
  for (const [index, alert] of (Array.isArray(snapshot.alerts) ? snapshot.alerts : []).entries()) {
    requireAllowedKeys(alert, new Set([
      "level", "title", "message", "mint", "kind", "evidenceClass", "evidenceAt", "createdAt"
    ]), `snapshot.alerts[${index}]`);
  }
  requireValue(snapshot.riskIntelligence?.schemaVersion === 1, "snapshot", "risk identity schema was missing");
  requireAllowedKeys(snapshot.riskIntelligence, new Set([
    "schemaVersion", "generatedAt", "evidenceClasses", "rankingImpact", "source", "engine",
    "coverage", "cohort", "summary", "disclaimer"
  ]), "snapshot.riskIntelligence");
  requireAllowedKeys(snapshot.riskIntelligence.source, new Set([
    "id", "label", "apiVersion", "parserRevision", "fingerprintMethodVersion", "endpoint",
    "attributionUrl", "poweredByUrl", "publicBeta", "unvetted", "rawResponsesPersisted",
    "rawProfilesPersisted", "retention"
  ]), "snapshot.riskIntelligence.source");
  requireAllowedKeys(snapshot.riskIntelligence.cohort, new Set([
    "policy", "limit", "admittedCount", "universe", "observations"
  ]), "snapshot.riskIntelligence.cohort");
  requireAllowedKeys(snapshot.riskIntelligence.engine, PUBLIC_RISK_ENGINE_KEYS, "snapshot.riskIntelligence.engine");
  requireAllowedKeys(snapshot.riskIntelligence.coverage, PUBLIC_RISK_COVERAGE_KEYS, "snapshot.riskIntelligence.coverage");
  requireAllowedKeys(snapshot.riskIntelligence.summary, PUBLIC_RISK_SUMMARY_KEYS, "snapshot.riskIntelligence.summary");
  if (snapshot.riskIntelligence.engine.schedule !== undefined) {
    requireAllowedKeys(snapshot.riskIntelligence.engine.schedule, new Set(["initialDelaySeconds", "retryDelaySeconds", "maxAttempts"]), "snapshot.riskIntelligence.engine.schedule");
  }
  if (snapshot.riskIntelligence.engine.parserRevisionAudit !== undefined) {
    requireAllowedKeys(snapshot.riskIntelligence.engine.parserRevisionAudit, new Set([
      "status", "currentRevision", "targetStateCount", "fullCohortAtStart", "sampleStateCount",
      "currentDispositionCountAtStart", "currentDispositionCount", "currentAcquisitionCount",
      "eligibleStateCountAtStart", "selectedStateCount", "queueDepth", "attempts", "successes",
      "failures", "skippedCurrent"
    ]), "snapshot.riskIntelligence.engine.parserRevisionAudit");
  }
  if (snapshot.riskIntelligence.engine.persistence !== undefined) {
    requireAllowedKeys(snapshot.riskIntelligence.engine.persistence, new Set([
      "stateCount", "cohortLimit", "admittedCount", "successfulStateCount", "dueStateCount",
      "currentParserAcquisitionCount"
    ]), "snapshot.riskIntelligence.engine.persistence");
  }
  if (snapshot.riskIntelligence.engine.counters !== undefined) {
    requireAllowedKeys(snapshot.riskIntelligence.engine.counters, new Set([
      "queued", "attempts", "successes", "unavailable", "failures", "rateLimited", "droppedQueue",
      "droppedCohort", "droppedLate", "revisionAuditQueued", "revisionAuditAttempts",
      "revisionAuditSuccesses", "revisionAuditFailures", "revisionAuditSkippedCurrent"
    ]), "snapshot.riskIntelligence.engine.counters");
  }
  rejectRawIdentityValues(snapshot.riskIntelligence, "snapshot.riskIntelligence");
  requireValue(snapshot.riskIntelligence?.source?.id === "geckoterminal" && snapshot.riskIntelligence.source.apiVersion === "20230203", "snapshot", "pinned risk identity source evidence was missing");
  requireValue(snapshot.riskIntelligence?.source?.parserRevision === RISK_IDENTITY_PARSER_REVISION
    && snapshot.riskIntelligence?.source?.fingerprintMethodVersion === RISK_IDENTITY_METHOD_VERSION,
  "snapshot", "current parser revision or stable fingerprint method marker was missing");
  requireValue(snapshot.riskIntelligence?.source?.rawResponsesPersisted === false && snapshot.riskIntelligence?.source?.rawProfilesPersisted === false, "snapshot", "risk identity retention boundary was missing");
  requireValue(snapshot.riskIntelligence?.rankingImpact === "none-uncalibrated", "snapshot", "risk identity ranking boundary was missing");
  requireValue(snapshot.riskIntelligence?.cohort?.policy === "risk-specific-prospective-fixed-admission-v1"
    && snapshot.riskIntelligence?.cohort?.limit === RISK_COHORT_LIMIT
    && typeof snapshot.riskIntelligence?.cohort?.universe === "string"
    && (expectedMode !== "live" || snapshot.riskIntelligence.cohort.universe.includes("independent from the v0.6 outcome cohort"))
    && Array.isArray(snapshot.riskIntelligence?.cohort?.observations), "snapshot", "independent inspectable risk cohort contract was missing");
  requireValue(JSON.stringify(snapshot.riskIntelligence?.evidenceClasses) === JSON.stringify(["on-chain-finalized", "provider-observed", "feed-observed-processed", "locally-derived", "unavailable"]), "snapshot", "risk identity evidence classes were missing");
  requireValue(Number.isFinite(snapshot.riskIntelligence?.coverage?.stateCount) && Number.isFinite(snapshot.riskIntelligence?.coverage?.successCount), "snapshot", "risk identity coverage was missing");
  if (expectedMode === "live") {
    const admittedCount = snapshot.riskIntelligence.cohort.admittedCount;
    const observations = snapshot.riskIntelligence.cohort.observations;
    const stateCount = snapshot.riskIntelligence.coverage.stateCount;
    const successCount = snapshot.riskIntelligence.coverage.successCount;
    const statusCounts = snapshot.riskIntelligence.coverage.statusCounts;
    requireValue(
      Number.isSafeInteger(admittedCount) && admittedCount === RISK_COHORT_LIMIT
        && Number.isSafeInteger(stateCount) && stateCount === RISK_COHORT_LIMIT,
      "snapshot", `risk identity fixed cohort was incomplete: expected ${RISK_COHORT_LIMIT} admitted and persisted states, received ${admittedCount ?? "missing"} and ${stateCount ?? "missing"}`
    );
    const observationMints = observations.map((observation) => observation?.mint);
    observations.forEach((observation, index) => requireAllowedKeys(
      observation,
      new Set(["mint", "name", "symbol", "createdAt", "riskIdentity"]),
      `snapshot.riskIntelligence.cohort.observations[${index}]`
    ));
    requireValue(
      observations.length === RISK_COHORT_LIMIT
        && observations.every((observation) => observation && typeof observation.mint === "string" && observation.mint.length > 0
          && observation.riskIdentity && typeof observation.riskIdentity === "object" && !Array.isArray(observation.riskIdentity))
        && new Set(observationMints).size === RISK_COHORT_LIMIT,
      "snapshot", "risk identity fixed cohort did not expose 120 unique inspectable observations"
    );
    requireValue(Number.isSafeInteger(successCount) && successCount >= 0 && successCount <= stateCount,
      "snapshot", "risk identity successful acquisition coverage count was invalid");
    requireValue(
      statusCounts && typeof statusCounts === "object" && !Array.isArray(statusCounts)
        && Object.values(statusCounts).every((count) => Number.isSafeInteger(count) && count >= 0)
        && Object.values(statusCounts).reduce((total, count) => total + count, 0) === stateCount,
      "snapshot", "risk identity status coverage did not account for the full fixed cohort"
    );
    const coverage = snapshot.riskIntelligence.coverage;
    requireValue(
      coverage.tokenRowCount === stateCount
        && coverage.tokenEvidenceMintCount === stateCount
        && coverage.prospectivelyObservedTokenMintCount === stateCount
        && coverage.outputMintCount === stateCount
        && coverage.evidenceRowCount === successCount
        && coverage.providerEvidenceMintCount === successCount
        && snapshot.riskIntelligence.summary?.totalTracked === stateCount,
      "snapshot", "risk identity public evidence coverage did not reconcile with persisted fixed-cohort coverage"
    );
    requireValue(
      health.riskIntelligence?.persistence?.stateCount === stateCount
        && health.riskIntelligence?.persistence?.admittedCount === admittedCount
        && health.riskIntelligence?.persistence?.successfulStateCount === successCount
        && health.riskIdentityCoverage?.stateCount === stateCount
        && health.riskIdentityCoverage?.successCount === successCount,
      "snapshot", "risk identity health and snapshot coverage did not agree"
    );
    const minimumSuccessCount = Math.ceil(stateCount * RISK_MINIMUM_SUCCESS_COVERAGE_RATIO);
    const invalidResponseCount = coverage.invalidAcquisitionCount;
    const maximumInvalidResponseCount = Math.floor(stateCount * RISK_MAXIMUM_INVALID_RESPONSE_RATIO);
    requireValue(successCount >= minimumSuccessCount, "snapshot",
      `risk identity successful acquisition coverage ${successCount}/${stateCount} was below ${minimumSuccessCount}/${stateCount}`);
    requireValue(Number.isSafeInteger(invalidResponseCount) && invalidResponseCount >= 0 && invalidResponseCount <= stateCount,
      "snapshot", "risk identity latest parser-invalid acquisition count was invalid");
    requireValue(invalidResponseCount <= maximumInvalidResponseCount, "snapshot",
      `risk identity invalid-response coverage ${invalidResponseCount}/${stateCount} exceeded ${maximumInvalidResponseCount}/${stateCount}`);
  }
  requireValue(!/"(?:fingerprint|normalizedName|normalizedSymbol|normalizedHandle|normalizedDomain|normalizedWebsite)"\s*:/i.test(JSON.stringify({ riskIntelligence: snapshot.riskIntelligence, tokens: snapshot.tokens, leaderboard: snapshot.leaderboard })), "snapshot", "private normalized identity values leaked into the public contract");
  validateEmbeddedRiskIdentities({
    cohort: snapshot.riskIntelligence?.cohort?.observations,
    tokens: snapshot.tokens,
    leaderboard: snapshot.leaderboard?.top100
  });
  const actorIntelligence = snapshot.earlyActorIntelligence;
  requireValue(actorIntelligence?.schemaVersion === 1, "snapshot", "early-actor intelligence schema was missing");
  requireValue(actorIntelligence.source?.id === "solana-mainnet-rpc"
    && actorIntelligence.source?.parserRevision === SOLANA_ACTOR_PARSER_REVISION
    && actorIntelligence.source?.evidenceClass === "on-chain-finalized"
    && actorIntelligence.source?.endpointClass === "documented-rate-limited-public-rpc"
    && actorIntelligence.source?.attributionUrl === "https://solana.com/docs/references/clusters"
    && actorIntelligence.source?.pumpProgramDocs === "https://github.com/pump-fun/pump-public-docs"
    && actorIntelligence.source?.completeness === "partial-and-unmeasured"
    && typeof actorIntelligence.source?.scope === "string"
    && actorIntelligence.source.scope.includes("newest")
    && actorIntelligence.source.scope.includes("in-window")
    && typeof actorIntelligence.source?.productionSuitability === "string"
    && actorIntelligence.source.productionSuitability.includes("best-effort"),
  "snapshot", "bounded finalized public-RPC source contract was missing");
  requireValue(actorIntelligence.sampling?.policy === "prospective-fixed-admission-v1"
    && actorIntelligence.sampling?.cohortLimit === ACTOR_COHORT_LIMIT
    && actorIntelligence.sampling?.earlyWindowSeconds === 1_800
    && JSON.stringify(actorIntelligence.sampling?.attemptsAtSeconds) === JSON.stringify([120, 600, 1800])
    && actorIntelligence.sampling?.signaturePageLimit === 16
    && actorIntelligence.sampling?.transactionLimitPerAttempt === 8
    && actorIntelligence.sampling?.rawSourcePayloadsPersisted === false
    && actorIntelligence.sampling?.rawWalletsPersisted === false
    && actorIntelligence.sampling?.rawTransactionIdsPersisted === false
    && actorIntelligence.sampling?.normalizedObservationRetentionSeconds === 72 * 60 * 60
    && actorIntelligence.sampling?.aggregateSummariesPersisted === true,
  "snapshot", "prospective bounded early-actor sampling and retention contract was missing");
  requireValue(actorIntelligence.privacy?.labels === "per-installation keyed Actor numbers"
    && actorIntelligence.privacy?.rawWalletsPublic === false
    && actorIntelligence.privacy?.rawProfilesPublic === false
    && actorIntelligence.privacy?.actorLookupEndpoint === false
    && actorIntelligence.privacy?.hiddenMappingMaterialPublic === false,
  "snapshot", "early-actor public privacy boundary was missing");
  validateActorEngine(actorIntelligence.engine, "snapshot.earlyActorIntelligence.engine", "snapshot", expectedMode);
  validateActorDownstreamGate(actorIntelligence.downstream, "snapshot.earlyActorIntelligence.downstream", "snapshot");
  requireValue(JSON.stringify(actorIntelligence.downstream) === JSON.stringify(actorIntelligence.engine.correlationGate),
    "snapshot", "early-actor engine and public downstream gates disagreed");
  requireValue(actorIntelligence.cohort?.limit === ACTOR_COHORT_LIMIT
    && Number.isSafeInteger(actorIntelligence.cohort?.admittedCount)
    && actorIntelligence.cohort.admittedCount === actorIntelligence.engine.cohort.admittedCount
    && Array.isArray(actorIntelligence.cohort?.observations)
    && actorIntelligence.cohort.observations.length === actorIntelligence.cohort.admittedCount,
  "snapshot", "inspectable early-actor cohort contract was missing or inconsistent");
  const actorObservationMints = new Set();
  let actorEvidenceMintCount = 0;
  let actorAttemptedMintCount = 0;
  let actorFailureStateCount = 0;
  let actorPendingAttemptCount = 0;
  let actorTerminalFailureCount = 0;
  for (const [index, observation] of actorIntelligence.cohort.observations.entries()) {
    const path = `snapshot.earlyActorIntelligence.cohort.observations[${index}]`;
    requireValue(observation && typeof observation.mint === "string" && !actorObservationMints.has(observation.mint)
      && typeof observation.name === "string" && typeof observation.symbol === "string"
      && Number.isFinite(Date.parse(observation.launchObservedAt))
      && observation.acquisition && ACTOR_ACQUISITION_STATES.has(observation.acquisition.status)
      && Number.isSafeInteger(observation.acquisition.attemptCount) && observation.acquisition.attemptCount >= 0
      && observation.acquisition.attemptCount <= ACTOR_ACQUISITION_ATTEMPT_LIMIT
      && (observation.acquisition.lastAttemptAt === null || Number.isFinite(Date.parse(observation.acquisition.lastAttemptAt)))
      && (observation.acquisition.nextAttemptAt === null || Number.isFinite(Date.parse(observation.acquisition.nextAttemptAt)))
      && (observation.acquisition.lastSuccessAt === null || Number.isFinite(Date.parse(observation.acquisition.lastSuccessAt))),
    "snapshot", `${path} acquisition evidence was invalid`);
    requireValue(observation.acquisition.attemptCount > 0 || observation.acquisition.lastAttemptAt === null,
      "snapshot", `${path} claimed an attempt timestamp before acquisition began`);
    requireValue(observation.acquisition.nextAttemptAt !== null
      || observation.acquisition.attemptCount === ACTOR_ACQUISITION_ATTEMPT_LIMIT,
    "snapshot", `${path} became terminal before its bounded acquisition attempts were exhausted`);
    actorObservationMints.add(observation.mint);
    if (observation.acquisition.attemptCount > 0) {
      actorAttemptedMintCount++;
      if (ACTOR_FAILURE_STATES.has(observation.acquisition.status)) actorFailureStateCount++;
    }
    if (observation.acquisition.nextAttemptAt !== null) actorPendingAttemptCount++;
    else if (ACTOR_FAILURE_STATES.has(observation.acquisition.status)) actorTerminalFailureCount++;
    if (observation.summary !== null) {
      validateActorSummary(observation.summary, observation.mint, `${path}.summary`, "snapshot");
      if (observation.summary.coverage.eventCount > 0) actorEvidenceMintCount++;
    }
  }
  if (expectedMode === "live") {
    requireValue(health.earlyActors.cohort.admittedCount === actorIntelligence.cohort.admittedCount
      && health.earlyActors.cohort.evidenceMintCount === actorIntelligence.engine.cohort.evidenceMintCount
      && health.earlyActors.cohort.eligibleMintCount === actorIntelligence.engine.cohort.eligibleMintCount
      && health.earlyActors.cohort.attemptedMintCount === actorIntelligence.engine.cohort.attemptedMintCount
      && health.earlyActors.cohort.failureStateCount === actorIntelligence.engine.cohort.failureStateCount,
    "snapshot", "early-actor health and snapshot coverage disagreed");
    requireValue(actorEvidenceMintCount === actorIntelligence.engine.cohort.evidenceMintCount
      && actorAttemptedMintCount === actorIntelligence.engine.cohort.attemptedMintCount
      && actorFailureStateCount === actorIntelligence.engine.cohort.failureStateCount
      && actorPendingAttemptCount === actorIntelligence.engine.cohort.pendingAttemptCount
      && actorIntelligence.cohort.admittedCount - actorPendingAttemptCount === actorIntelligence.engine.cohort.terminalCount
      && actorTerminalFailureCount === actorIntelligence.engine.cohort.terminalFailureCount,
    "snapshot", "early-actor observations did not reconcile with engine acquisition telemetry");
  }
  for (const [check, value] of [
    ["health", health], ["snapshot", snapshot], ["dossier", dossier], ["timeline", timeline],
    ["compare", comparison], ["identity resolver", identity], ["entity list", entityList],
    ["daily brief", dailyBrief], ["weekly brief", weeklyBrief]
  ]) rejectPublicIdentityLeaks(value, check, check);
  for (const entry of snapshot.leaderboard?.top100 || []) {
    for (const window of ["5m", "15m", "1h", "6h", "24h"]) {
      const outcome = entry?.outcome?.windows?.[window];
      requireValue(outcome && ["observed", "unavailable"].includes(outcome.status), "snapshot", `${window} leaderboard outcome status was invalid`);
      if (outcome.status === "observed") requireValue(Number.isFinite(outcome.returnPct) && outcome.source === "geckoterminal"
        && typeof outcome.observedAt === "string" && typeof outcome.calculatedAt === "string", "snapshot", `${window} observed outcome evidence was incomplete`);
      else requireValue(typeof outcome.reason === "string" && outcome.reason.length > 0, "snapshot", `${window} missing-data reason was absent`);
    }
  }

  const expectedReadinessBasis = expectedMode === "live"
    ? "verified-feed-freshness-and-mounted-storage"
    : "simulated-feed-state";
  requireValue(snapshot.publicDelivery?.schemaVersion === 1
    && snapshot.publicDelivery?.snapshotEncoding === "gzip-when-accepted"
    && snapshot.publicDelivery?.browserRefresh === "coalesced-with-15-second-post-completion-cooldown"
    && snapshot.publicDelivery?.vaultExports === "disabled"
    && JSON.stringify(health.publicDelivery) === JSON.stringify(snapshot.publicDelivery),
  "snapshot", "public delivery hardening contract was missing or disagreed across health and snapshot");
  requireValue(health.readinessScope?.schemaVersion === 1
    && health.readinessScope?.statusBasis === expectedReadinessBasis
    && health.readinessScope?.mountEvidenceRequired === (expectedMode === "live")
    && health.readinessScope?.releaseEligibility === "separate-smoke-data-calibration-backup-and-recovery-gates"
    && health.readinessScope?.cohortCoverageIncluded === false
    && health.readinessScope?.calibrationIncluded === false
    && health.readinessScope?.backupRecoveryIncluded === false
    && JSON.stringify(snapshot.readinessScope) === JSON.stringify(health.readinessScope),
  "health", "readiness scope falsely implied release, calibration, backup, or recovery verification");
  requireValue(Array.isArray(snapshot.tokens)
    && new Set(snapshot.tokens.map(({ mint }) => mint)).size === snapshot.tokens.length,
  "snapshot", "snapshot token inventory contained duplicate exact mints");
  validateTokenIntegrity(snapshot.tokenIntegrity, "snapshot.tokenIntegrity", "snapshot");
  validateTokenIntegrity(health.tokenIntegrity, "health.tokenIntegrity", "health");
  validateEntityEnvelope(snapshot.entityIntelligence,
    { path: "snapshot.entityIntelligence", check: "snapshot", complete: true });
  requireValue(snapshot.entityIntelligence.denominators.observedMintCount === snapshot.tokens.length,
    "snapshot", "entity observed-mint denominator disagreed with the exact snapshot inventory");
  validateEntityTrending(snapshot.entityIntelligence, "snapshot");
  validateRegistryProjection(health.identityRegistry?.projection, "health.identityRegistry.projection", "health");
  requireValue(health.identityRegistry?.api?.version === "v1"
    && health.identityRegistry.api.list === "/api/v1/entities"
    && health.identityRegistry.api.resolver === "/api/v1/entities/resolve?mint={mint}"
    && health.identityRegistry.api.specification === "/api/v1/openapi.json"
    && health.identityRegistry.api.documentation === "/api.html"
    && health.identityRegistry.api.pagination === "opaque-cursor-entity-id-order"
    && health.identityRegistry.api.authentication === "none-read-only"
    && health.identityRegistry.api.quotaScope === "process-global-per-instance"
    && isNonNegativeInteger(health.identityRegistry.verifiedEntityCount)
    && isNonNegativeInteger(health.identityRegistry.verifiedVariantCount)
    && isNonNegativeInteger(health.identityRegistry.verifiedRelationshipCount)
    && health.identityRegistry.verifiedEntityCount <= health.identityRegistry.entityCount
    && health.identityRegistry.verifiedVariantCount <= health.identityRegistry.variantCount
    && health.identityRegistry.verifiedRelationshipCount <= health.identityRegistry.relationshipCount
    && health.identityRegistry.api.externalApiKeys === "not-offered"
    && health.identityRegistry.projection.eligibleCounts.entities === health.identityRegistry.verifiedEntityCount
    && health.identityRegistry.projection.eligibleCounts.variants >= health.identityRegistry.verifiedVariantCount
    && health.identityRegistry.projection.eligibleCounts.relationships === health.identityRegistry.verifiedRelationshipCount,
  "health", "versioned identity API or verified registry coverage was missing or inconsistent");
  const snapshotLimiter = health.apiLimits?.snapshot;
  requireValue(health.apiLimits?.schemaVersion === 1
    && health.apiLimits.scope === "process-global-per-instance"
    && health.apiLimits.key === "single-shared-bucket",
  "health", "snapshot limiter health envelope was missing");
  validateLimiterCounters(snapshotLimiter, 120, 1, "apiLimits.snapshot");
  const identityLimiters = health.identityRegistry.api.limiter;
  requireValue(identityLimiters?.schemaVersion === 1
    && identityLimiters.scope === "process-global-per-instance"
    && identityLimiters.key === "one-shared-bucket-per-endpoint",
  "health", "nested list/resolver limiter envelope was missing");
  validateLimiterCounters(identityLimiters.list, 120, entityPages.length, "identityRegistry.api.limiter.list");
  validateLimiterCounters(identityLimiters.resolver, 120, 1, "identityRegistry.api.limiter.resolver");

  requireValue(htmlResult.body.includes(`<meta name="application-version" content="${expectedVersion}">`), "html", "release version marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="public-delivery-hardening-v1"')
    && htmlResult.body.includes('id="export-daily" class="quiet-button" hidden'),
  "html", "public delivery hardening marker or fail-closed live export control was missing");
  requireValue(htmlResult.body.includes("NO WALLET · NO EXECUTION"), "html", "read-only safety marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="provider-observed-outcome-engine"') && htmlResult.body.includes("On-chain data provided by GeckoTerminal") && htmlResult.body.includes("Powered by CoinGecko"), "html", "outcome engine attribution marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="risk-identity-evidence-v1"') && htmlResult.body.includes("NO COMPOSITE SCORE"), "html", "risk identity release marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="actionable-intelligence-v1"')
    && htmlResult.body.includes("BROWSER-LOCAL WORKBENCH") && htmlResult.body.includes("MATERIALITY POLICY v1"),
  "html", "actionable intelligence release marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="anonymous-early-actor-v1"')
    && htmlResult.body.includes("Per-installation keyed Actor numbers")
    && htmlResult.body.includes("CORRELATIONS WITHHELD"),
  "html", "anonymous early-actor privacy or downstream-withholding marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="canonical-identity-v1"')
    && htmlResult.body.includes("NO PUBLIC WRITES · NO AUTOMATED CANONIZATION")
    && htmlResult.body.includes("Primary mint means identity resolution only")
    && htmlResult.body.includes('id="entity-trends"') && htmlResult.body.includes('href="/api.html"'),
  "html", "canonical identity review boundary marker was missing");
  requireValue(htmlResult.body.includes('class="section-nav"') && htmlResult.body.includes('href="/help.html"'),
    "html", "compact section navigation or help entry point was missing");
  requireValue(scriptResult.body.includes("renderFeedObservability"), "app.js", "feed observability UI marker was missing");
  requireValue(scriptResult.body.includes("renderOutcomes") && scriptResult.body.includes("raw candle retention off"), "app.js", "outcome engine UI marker was missing");
  requireValue(scriptResult.body.includes("renderRiskIntelligence")
    && scriptResult.body.includes("identifier reuse only—not duplicate content")
    && scriptResult.body.includes("SYNTHETIC DEMO"), "app.js", "risk identity UI truthfulness markers were missing");
  requireValue(scriptResult.body.includes("PREFERENCE_KEY") && scriptResult.body.includes("localStorage")
    && scriptResult.body.includes("renderActionIntelligence") && scriptResult.body.includes("renderCoinTimeline")
    && scriptResult.body.includes("/api/compare?mints="), "app.js", "watchlist, timeline, or compare UI markers were missing");
  requireValue(scriptResult.body.includes("renderEarlyActors") && scriptResult.body.includes("earlyActorDetail")
    && scriptResult.body.includes("installation-scoped, non-reversible labels")
    && scriptResult.body.includes("trade signal"),
  "app.js", "anonymous early-actor evidence UI markers were missing");
  requireValue(scriptResult.body.includes("renderIdentityRegistry") && scriptResult.body.includes("identityDetail")
    && scriptResult.body.includes("PROPOSED · NOT A FACT")
    && scriptResult.body.includes("/api/coins/${encodeURIComponent(mint)}")
    && scriptResult.body.includes("entityIntelligence")
    && scriptResult.body.includes("ENTITY TREND // ONE MINT CONTRIBUTION MAX")
    && scriptResult.body.includes("Each trend has at most one exact-mint contributor")
    && scriptResult.body.includes("variants are never summed"),
  "app.js", "canonical identity summary, dossier, or proposal truthfulness markers were missing");
  requireValue(scriptResult.body.includes("createSnapshotRefreshScheduler")
    && scriptResult.body.includes("vaultExportsEnabled")
    && refreshScriptResult.body.includes("SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000")
    && refreshScriptResult.body.includes("SNAPSHOT_REFRESH_TIMEOUT_MS = 10_000")
    && refreshScriptResult.body.includes("createSnapshotLiveUpdates"),
  "snapshot-refresh.js", "bounded snapshot refresh or public vault-write UI gate was missing");
  requireValue(preferencesResult.body.includes("normalizePreferences") && preferencesResult.body.includes("WATCHLIST_LIMIT = 50")
    && preferencesResult.body.includes("PRESET_LIMIT = 12"), "preferences.js", "bounded browser preference contract was missing");
  requireValue(stylesResult.body.includes(".outcome-source,footer{font-size:10px}"), "styles.css", "minimum-size provider attribution style was missing");
  requireValue(stylesResult.body.includes(".risk-intelligence-source"), "styles.css", "risk identity responsive style was missing");
  requireValue(stylesResult.body.includes(".action-intelligence") && stylesResult.body.includes(".comparison-table")
    && stylesResult.body.includes(".timeline-entry"), "styles.css", "action intelligence responsive styles were missing");
  requireValue(stylesResult.body.includes("v0.9 anonymous early-actor intelligence")
    && stylesResult.body.includes(".early-actors") && stylesResult.body.includes(".early-actor-detail")
    && stylesResult.body.includes("@media(max-width:650px)"),
  "styles.css", "anonymous early-actor desktop or responsive styles were missing");
  requireValue(stylesResult.body.includes(".identity-registry") && stylesResult.body.includes(".identity-detail")
    && stylesResult.body.includes(".identity-edge.proposed"),
  "styles.css", "canonical identity desktop or responsive styles were missing");
  requireValue(stylesResult.body.includes("v0.10.2 compact navigation and help center")
    && stylesResult.body.includes(".section-nav") && stylesResult.body.includes(".method-disclosure"),
  "styles.css", "compact navigation or disclosure styles were missing");
  requireValue(stylesResult.body.includes("v0.10.3 entity intelligence and API hardening")
    && stylesResult.body.includes(".entity-trends") && stylesResult.body.includes(".entity-trend-row")
    && stylesResult.body.includes(".api-page"),
  "styles.css", "entity intelligence or API documentation responsive styles were missing");
  requireValue(helpResult.body.includes("The 3-minute workflow")
    && helpResult.body.includes("Canonical identity graph") && helpResult.body.includes("Common questions")
    && helpResult.body.includes("pending proposal backlog is hard-capped at 500")
    && helpResult.body.includes('href="/api.html"'),
  "help", "tutorial, identity guide, FAQ, or bounded-backlog explanation was missing");
  requireValue(apiDocsResult.body.includes(`<meta name="application-version" content="${expectedVersion}">`)
    && apiDocsResult.body.includes('data-release-marker="entity-api-hardening-v1"')
    && apiDocsResult.body.includes("cap reviewed incident edges at 100")
    && apiDocsResult.body.includes("ordered by stable code-unit entity ID")
    && apiDocsResult.body.includes("Each entity trend has at most one exact-mint contributor")
    && apiDocsResult.body.includes("500 whole entities, 2,000 variants, and 5,000 relationships")
    && apiDocsResult.body.includes("does not offer external API keys")
    && apiDocsResult.body.includes("process-global 120/minute")
    && apiDocsResult.body.includes("Snapshot, entity-list, and resolver attempts each share separate process-global 120/minute")
    && apiDocsResult.body.includes("Readiness is not rate-limited")
    && apiDocsResult.body.includes("typed HTTP 403 in every mode")
    && apiDocsResult.body.includes("Live weak consistency"),
  "api docs", "versioned identity, denominator, pagination, limiter, or fail-closed export documentation was missing");
  requireValue(termsResult.body.includes("CoinGecko API Terms") && termsResult.body.includes("not verified prices")
    && termsResult.body.includes("does not prove duplicate content") && termsResult.body.includes("common control")
    && termsResult.body.includes("materiality policy") && termsResult.body.includes("migration observation")
    && termsResult.body.includes("Automated metadata collisions remain proposals")
    && termsResult.body.includes("Public registry endpoints are read-only"), "terms", "provider ownership, alert, risk-evidence, or identity terms were missing");
  requireValue(privacyResult.body.includes("Minimal data by design") && privacyResult.body.includes("does not persist or expose bulk GeckoTerminal responses") && privacyResult.body.includes("domain-separated hashes"), "privacy", "privacy and retention notice was missing");
  requireValue(privacyResult.body.includes("browser-local") && privacyResult.body.includes("Telegram")
    && privacyResult.body.includes("Bot API") && privacyResult.body.includes("opt out"), "privacy", "watchlist or Telegram privacy notice was missing");
  requireValue(/early[- ]actor/i.test(termsResult.body) && /partial.{0,40}unmeasured/is.test(termsResult.body)
    && /does not (?:establish|prove).{0,100}(?:identity|coordination)/is.test(termsResult.body)
    && /trade signal/i.test(termsResult.body),
  "terms", "early-actor source limitations or neutral-use terms were missing");
  requireValue(/per-installation keyed Actor/i.test(privacyResult.body)
    && /raw wallet addresses/i.test(privacyResult.body) && /transaction signatures/i.test(privacyResult.body)
    && /(?:72[- ]hour|72 hours)/i.test(privacyResult.body) && /mapping material/i.test(privacyResult.body),
  "privacy", "early-actor pseudonymization, retention, or raw-identity privacy notice was missing");
  requireValue(privacyResult.body.includes("append-only review decisions")
    && privacyResult.body.includes("Proposed edges remain visibly separate from reviewed facts")
    && privacyResult.body.includes("exposes no write operation"),
  "privacy", "canonical identity review-data privacy notice was missing");

  return {
    ok: true,
    baseUrl: normalizedBaseUrl,
    version: expectedVersion,
    mode: expectedMode,
    health: {
      status: health.status,
      feedState: health.feed.state,
      uptimeSeconds: health.service.uptimeSeconds,
      errorsTotal: health.telemetry.errorsTotal,
      responses5xx: health.telemetry.responses5xx,
      outcomeState: health.outcomes.status,
      riskIdentityState: health.riskIntelligence.status,
      earlyActorState: health.earlyActors.status
    },
    http: {
      health: 200, snapshot: 200, html: 200, appJs: 200, snapshotRefreshJs: 200, preferencesJs: 200, styles: 200, help: 200, apiDocs: 200, openapi: 200, terms: 200, privacy: 200,
      dossier: 200, timeline: 200, compare: 200, dailyBrief: 200, weeklyBrief: 200, entityList: 200, identityResolver: 200,
      identityWriteGuard: 405,
      vaultExportGuard: 403
    },
    markers: {
      version: true, readOnly: true, observability: true, outcomeEngine: true, riskIdentity: true,
      actionableIntelligence: true, measuredBriefV2: true, outcomeDemandAwareFreshness: true,
      parserRevision: true, anonymousEarlyActors: true, canonicalIdentity: true, entityIntelligence: true, identityApiHardening: true, compactHelp: true, publicDeliveryHardening: true, legalNotices: true
    }
  };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!["--url", "--version", "--mode", "--timeout-ms"].includes(argument)) throw new SmokeCheckError("configuration", `unknown argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new SmokeCheckError("configuration", `${argument} requires a value`);
    values[argument.slice(2)] = value;
  }
  return values;
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const args = parseArgs(process.argv.slice(2));
  const result = await runSmokeChecks({
    baseUrl: args.url || process.env.SMOKE_BASE_URL || "http://127.0.0.1:4173",
    expectedVersion: args.version || process.env.EXPECTED_VERSION || packageJson.version,
    expectedMode: args.mode || process.env.EXPECTED_MODE || "demo",
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 10_000
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const result = { ok: false, check: error?.check || "smoke", error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
}
