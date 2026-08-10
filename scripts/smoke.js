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
const RAW_PROFILE_VALUE = /(?:^|[\s(])(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)]+)/i;
const RAW_SOLANA_IDENTITY_VALUE = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[1-9A-HJ-NP-Za-km-z]{64,88}|[1-9A-HJ-NP-Za-km-z]{32,44})(?=$|[^1-9A-HJ-NP-Za-km-z])/;
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
    const rawIdentityKey = RAW_PUBLIC_IDENTITY_KEYS.has(normalized)
      || /^(?:creator|deployer|caller)(?:address|wallet|publickey|profile|handle|id)$/.test(normalized)
      || normalized.endsWith("signature");
    const hiddenMaterial = !boundaryDeclaration && (HIDDEN_PUBLIC_MATERIAL_KEYS.has(normalized)
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
    status: response.status,
    url: url.toString()
  };
}

function parseJson(result, check) {
  try { return JSON.parse(result.body); }
  catch { throw new SmokeCheckError(check, "response was not valid JSON"); }
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
  const [healthResult, snapshotResult, htmlResult, scriptResult, refreshScriptResult, preferencesResult, stylesResult, termsResult, privacyResult] = await Promise.all([
    request(normalizedBaseUrl, "/api/health", { timeoutMs, fetchImpl, headers: { "accept-encoding": "gzip" } }),
    request(normalizedBaseUrl, "/api/snapshot", { timeoutMs, fetchImpl, headers: { "accept-encoding": "gzip" } }),
    request(normalizedBaseUrl, "/", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/app.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/snapshot-refresh.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/preferences.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/styles.css", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/terms.html", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/privacy.html", { timeoutMs, fetchImpl })
  ]);
  const health = parseJson(healthResult, "health");
  const snapshot = parseJson(snapshotResult, "snapshot");
  const expectedFeedState = expectedMode === "live" ? "live" : "simulated";
  requireValue(snapshot.version === expectedVersion, "snapshot", `version ${snapshot.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(snapshot.mode === expectedMode, "snapshot", `mode ${snapshot.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(snapshot.status === "healthy", "snapshot", `status ${snapshot.status ?? "missing"} was not healthy`);
  let vaultExportGuardResult = null;
  if (expectedMode === "live") {
    requireValue(snapshot.publicDelivery?.vaultExports === "disabled", "snapshot",
      "live vault export boundary was not declared disabled before guard verification");
    vaultExportGuardResult = await request(normalizedBaseUrl, "/api/export/coin/not-a-solana-mint", {
      timeoutMs,
      fetchImpl,
      method: "POST",
      expectedStatus: 403
    });
    const vaultExportGuard = parseJson(vaultExportGuardResult, "vault export guard");
    requireValue(vaultExportGuard?.ok === false
      && vaultExportGuard.code === "vault-export-disabled"
      && vaultExportGuard.mode === "live"
      && vaultExportGuardResult.contentType.toLowerCase().includes("application/json")
      && vaultExportGuardResult.nosniff.toLowerCase() === "nosniff",
    "vault export guard", "live export route did not fail closed with the typed disabled response");
  }
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
  const [dossierResult, timelineResult, compareResult, dailyBriefResult, weeklyBriefResult] = await Promise.all([
    request(normalizedBaseUrl, `/api/coins/${endpointMints[0]}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/coins/${endpointMints[0]}/timeline?limit=2`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, `/api/compare?mints=${encodeURIComponent(endpointMints.join(","))}`, { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/briefs/daily", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/briefs/weekly", { timeoutMs, fetchImpl })
  ]);
  const dossier = parseJson(dossierResult, "dossier");
  const timeline = parseJson(timelineResult, "timeline");
  const comparison = parseJson(compareResult, "compare");
  const dailyBrief = parseJson(dailyBriefResult, "daily brief");
  const weeklyBrief = parseJson(weeklyBriefResult, "weekly brief");

  for (const [check, result, expectedType] of [
    ["health", healthResult, "application/json"],
    ["snapshot", snapshotResult, "application/json"],
    ["html", htmlResult, "text/html"],
    ["app.js", scriptResult, "text/javascript"],
    ["snapshot-refresh.js", refreshScriptResult, "text/javascript"],
    ["preferences.js", preferencesResult, "text/javascript"],
    ["styles.css", stylesResult, "text/css"],
    ["terms", termsResult, "text/html"],
    ["privacy", privacyResult, "text/html"],
    ["dossier", dossierResult, "application/json"],
    ["timeline", timelineResult, "application/json"],
    ["compare", compareResult, "application/json"],
    ["daily brief", dailyBriefResult, "application/json"],
    ["weekly brief", weeklyBriefResult, "application/json"]
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
  requireValue(Object.hasOwn(dossier, "earlyActor"), "dossier", "early-actor evidence field was missing");
  if (dossier.earlyActor !== null) validateActorSummary(dossier.earlyActor, endpointMints[0], "dossier.earlyActor", "dossier");
  requireValue(timeline?.schemaVersion === 1 && timeline?.mint === endpointMints[0] && timeline?.limit === 2
    && Array.isArray(timeline.entries) && timeline.rawProviderPayloadsIncluded === false
    && (timeline.nextBefore === null || typeof timeline.nextBefore === "string"), "timeline", "typed paginated timeline contract was missing");
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
    ["compare", comparison], ["daily brief", dailyBrief], ["weekly brief", weeklyBrief]
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

  const expectedVaultExportState = expectedMode === "live" ? "disabled" : "local-demo-only";
  const expectedReadinessBasis = expectedMode === "live"
    ? "verified-feed-freshness-and-mounted-storage"
    : "simulated-feed-state";
  requireValue(snapshot.publicDelivery?.schemaVersion === 1
    && snapshot.publicDelivery?.snapshotEncoding === "gzip-when-accepted"
    && snapshot.publicDelivery?.browserRefresh === "coalesced-with-15-second-post-completion-cooldown"
    && snapshot.publicDelivery?.vaultExports === expectedVaultExportState
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
  requireValue(termsResult.body.includes("CoinGecko API Terms") && termsResult.body.includes("not verified prices")
    && termsResult.body.includes("does not prove duplicate content") && termsResult.body.includes("common control")
    && termsResult.body.includes("materiality policy") && termsResult.body.includes("migration observation"), "terms", "provider ownership, alert, or risk-evidence terms were missing");
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
      health: 200, snapshot: 200, html: 200, appJs: 200, snapshotRefreshJs: 200, preferencesJs: 200, styles: 200, terms: 200, privacy: 200,
      dossier: 200, timeline: 200, compare: 200, dailyBrief: 200, weeklyBrief: 200,
      vaultExportGuard: vaultExportGuardResult ? 403 : "not-applicable"
    },
    markers: {
      version: true, readOnly: true, observability: true, outcomeEngine: true, riskIdentity: true,
      actionableIntelligence: true, measuredBriefV2: true, outcomeDemandAwareFreshness: true,
      parserRevision: true, anonymousEarlyActors: true, publicDeliveryHardening: true, legalNotices: true
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
