import { GECKOTERMINAL_PROVIDER, GeckoTerminalError } from "./geckoterminal.js";
import {
  parseGeckoTerminalTokenInfo,
  RISK_IDENTITY_METHOD_VERSION,
  RISK_IDENTITY_PARSER_REVISION,
  validateRiskIdentityPersistenceEvidence
} from "./risk-identity.js";

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INITIAL_DELAY_MS = 15 * 60_000;
const RETRY_DELAY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 2;
const PARSER_REVISION_AUDIT_SAMPLE_SIZE = 16;
const DEFAULT_COHORT_LIMIT = 120;
const DEFAULT_MAX_ADMISSION_AGE_MS = 20 * 60_000;
const PROVIDER_DATA_STALE_AFTER_MS = 24 * 60 * 60_000;
const PERSISTED_ERROR_CODES = new Set([
  "invalid-json", "invalid-mint", "invalid-response", "network-error", "not-found",
  "pool-unavailable", "provider-http-error", "provider-request-rejected", "provider-unavailable", "rate-limited",
  "timeout", "token-info-missing", "token-mismatch"
]);

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function validToken(token) {
  return token && typeof token === "object" && MINT_PATTERN.test(String(token.mint || "")) && timestamp(token.createdAt) !== null;
}

function hasCurrentParserAcquisition(evidence) {
  return evidence?.parserRevision === RISK_IDENTITY_PARSER_REVISION
    || evidence?.parserAuditRevision === RISK_IDENTITY_PARSER_REVISION;
}

function hasCurrentParserDisposition(evidence) {
  return hasCurrentParserAcquisition(evidence)
    || evidence?.parserAttemptRevision === RISK_IDENTITY_PARSER_REVISION;
}

function fixedParserRevisionSample(states, cohortLimit) {
  return [...states]
    .sort((left, right) => left.mint < right.mint ? -1 : left.mint > right.mint ? 1 : 0)
    .slice(0, Math.min(PARSER_REVISION_AUDIT_SAMPLE_SIZE, cohortLimit));
}

function currentParserAuditEvidence(evidence, completedAt) {
  const {
    parserAttemptRevision: _parserAttemptRevision,
    parserAttemptAt: _parserAttemptAt,
    parserAttemptStatus: _parserAttemptStatus,
    ...retained
  } = evidence;
  return {
    ...retained,
    parserAuditRevision: RISK_IDENTITY_PARSER_REVISION,
    parserAuditAt: completedAt
  };
}

function currentParserFailureEvidence(evidence, attemptedAt) {
  return {
    ...evidence,
    parserAttemptRevision: RISK_IDENTITY_PARSER_REVISION,
    parserAttemptAt: attemptedAt,
    parserAttemptStatus: "failed"
  };
}

function evidenceQuality(evidence, fetchedAt) {
  const coreKeys = ["holderCount", "top10HolderPercentage", "providerLastUpdated", "developerHoldingPercentage"];
  const missingCore = coreKeys.filter((key) => evidence?.factors?.[key]?.value === null).length;
  const digestCount = ["developerAddress", "xHandle", "telegramHandle", "nameSymbol"]
    .filter((key) => typeof evidence?.fingerprints?.[key]?.fingerprint === "string").length
    + (evidence?.fingerprints?.websiteDomains?.values?.length || 0);
  const factorCount = coreKeys.filter((key) => evidence?.factors?.[key]?.value !== null).length;
  const liquidityExpected = Object.hasOwn(evidence || {}, "liquidity");
  const liquidityAvailable = evidence?.liquidity?.evidenceClass === "provider-observed"
    && typeof evidence.liquidity.liquidityUsd === "number" && Number.isFinite(evidence.liquidity.liquidityUsd);
  const components = [
    ...coreKeys.filter((key) => evidence?.factors?.[key]?.value !== null).map((key) => `factor:${key}`),
    ...["developerAddress", "xHandle", "telegramHandle", "nameSymbol"]
      .filter((key) => typeof evidence?.fingerprints?.[key]?.fingerprint === "string").map((key) => `digest:${key}`),
    ...(evidence?.fingerprints?.websiteDomains?.values?.length ? ["digest:websiteDomains"] : []),
    ...(liquidityAvailable ? ["factor:liquidity"] : [])
  ];
  const updatedAt = timestamp(evidence?.factors?.providerLastUpdated?.value);
  const fetched = timestamp(fetchedAt);
  const holderTimestampStale = updatedAt !== null && fetched !== null
    && (updatedAt > fetched + 5 * 60_000 || fetched - updatedAt > PROVIDER_DATA_STALE_AFTER_MS);
  return {
    hasEvidence: factorCount + digestCount + (liquidityAvailable ? 1 : 0) > 0,
    evidenceCount: factorCount + digestCount + (liquidityAvailable ? 1 : 0),
    components,
    needsRetry: missingCore > 0 || holderTimestampStale || (liquidityExpected && !liquidityAvailable),
    missingCore,
    holderTimestampStale
  };
}

function boundedProviderErrorCode(error) {
  const code = error instanceof GeckoTerminalError ? error.code
    : typeof error?.code === "string" ? error.code : "invalid-response";
  return PERSISTED_ERROR_CODES.has(code) ? code : "invalid-response";
}

function currentLiquidityEvidence(mint, attemptedAt, selection = null, error = null) {
  const reserve = typeof selection?.reserveUsd === "number" && Number.isFinite(selection.reserveUsd)
    && selection.reserveUsd >= 0 ? selection.reserveUsd : null;
  const pool = typeof selection?.pool === "string" && MINT_PATTERN.test(selection.pool) ? selection.pool : null;
  const observedAt = timestamp(selection?.poolSelectedAt) === null ? null : iso(timestamp(selection.poolSelectedAt));
  const poolCreatedAt = timestamp(selection?.poolCreatedAt) === null ? null : iso(timestamp(selection.poolCreatedAt));
  const providerPage = Number.isSafeInteger(selection?.providerPage) && selection.providerPage >= 1 ? selection.providerPage : null;
  const providerRank = Number.isSafeInteger(selection?.providerRank) && selection.providerRank >= 1 ? selection.providerRank : null;
  const available = reserve !== null && pool !== null && observedAt !== null && poolCreatedAt !== null
    && providerPage !== null && providerRank !== null;
  return {
    schemaVersion: 1,
    source: GECKOTERMINAL_PROVIDER.id,
    endpoint: `/networks/solana/tokens/${mint}/pools`,
    evidenceClass: available ? "provider-observed" : "unavailable",
    attemptedAt,
    observedAt: available ? observedAt : null,
    pool: available ? pool : null,
    poolCreatedAt: available ? poolCreatedAt : null,
    providerPage: available ? providerPage : null,
    providerRank: available ? providerRank : null,
    sourceField: "data[].attributes.reserve_in_usd",
    liquidityUsd: available ? reserve : null,
    missingReasonCode: available ? null : error ? boundedProviderErrorCode(error) : "pool-reserve-missing",
    basis: "current-provider-ranked-page-1-pool-snapshot",
    limitation: "Current GeckoTerminal-observed pool reserve is not launch-time liquidity or evidence of locked liquidity"
  };
}

function unavailableEvidence(mint, errorCode, attemptedAt) {
  return {
    schemaVersion: 1,
    mint,
    provider: GECKOTERMINAL_PROVIDER.id,
    source: GECKOTERMINAL_PROVIDER.id,
    endpoint: `/networks/solana/tokens/${mint}/info`,
    apiVersion: GECKOTERMINAL_PROVIDER.apiVersion,
    methodVersion: RISK_IDENTITY_METHOD_VERSION,
    evidenceClass: "unavailable",
    fetchedAt: null,
    attemptedAt,
    missingReasonCode: errorCode,
    retention: "normalized-scalars-and-domain-separated-fingerprints-only"
  };
}

export function nextRiskIdentityAttemptAt(createdAt, now = Date.now()) {
  const created = timestamp(createdAt);
  if (created === null || !Number.isFinite(now)) throw new TypeError("createdAt and now must be valid timestamps");
  return iso(Math.max(now, created + INITIAL_DELAY_MS));
}

export class RiskIdentityIngestor {
  constructor({
    store,
    client,
    onStatus = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    betweenTokensMs = 250,
    maxQueue = 16,
    cohortLimit = DEFAULT_COHORT_LIMIT,
    maxAdmissionAgeMs = DEFAULT_MAX_ADMISSION_AGE_MS
  } = {}) {
    for (const method of ["upsertRiskIdentityState", "riskIdentityState", "riskIdentityStates"]) {
      if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} must be a function`);
    }
    if (typeof client?.tokenInfo !== "function") throw new TypeError("client must implement tokenInfo");
    if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");
    if (!Number.isFinite(betweenTokensMs) || betweenTokensMs < 0) throw new RangeError("betweenTokensMs must be non-negative");
    if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError("maxQueue must be a positive integer");
    if (!Number.isInteger(cohortLimit) || cohortLimit < 1 || cohortLimit > 200) throw new RangeError("cohortLimit must be between 1 and 200");
    if (!Number.isFinite(maxAdmissionAgeMs) || maxAdmissionAgeMs < 0) throw new RangeError("maxAdmissionAgeMs must be non-negative");
    Object.assign(this, { store, client, onStatus, now, setTimeoutFn, clearTimeoutFn, betweenTokensMs, maxQueue, cohortLimit, maxAdmissionAgeMs });
    const existingStates = store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    this.admittedMints = new Set(existingStates.map(({ mint }) => mint));
    this.queue = [];
    this.queuedMints = new Set();
    this.timer = null;
    this.running = false;
    this.closed = false;
    this.status = "idle";
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastErrorCode = null;
    this.activeQueueKind = null;
    this.parserRevisionAudit = {
      started: false,
      fullCohort: false,
      sampleStateCount: 0,
      currentDispositionCountAtStart: 0,
      eligibleStateCount: 0,
      selectedStateCount: 0
    };
    this.counters = {
      queued: 0, attempts: 0, successes: 0, unavailable: 0, failures: 0,
      rateLimited: 0, droppedQueue: 0, droppedCohort: 0, droppedLate: 0,
      revisionAuditQueued: 0, revisionAuditAttempts: 0, revisionAuditSuccesses: 0,
      revisionAuditFailures: 0, revisionAuditSkippedCurrent: 0
    };
  }

  getStatus() {
    const states = this.store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    const sampleStates = fixedParserRevisionSample(states, this.cohortLimit);
    const currentDispositionCount = sampleStates.filter((state) => hasCurrentParserDisposition(state.evidence)).length;
    const currentAcquisitionCount = sampleStates.filter((state) => hasCurrentParserAcquisition(state.evidence)).length;
    const currentFailureDispositionCount = sampleStates.filter((state) =>
      state.evidence?.parserAttemptRevision === RISK_IDENTITY_PARSER_REVISION
      && !hasCurrentParserAcquisition(state.evidence)).length;
    const persistedSuccesses = states.map((state) => timestamp(state.lastSuccessAt)).filter(Number.isFinite);
    const persistedLastSuccessAt = persistedSuccesses.length ? iso(Math.max(...persistedSuccesses)) : null;
    const lastSuccessAt = [this.lastSuccessAt, persistedLastSuccessAt]
      .map((value) => timestamp(value)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const lastSuccessIso = Number.isFinite(lastSuccessAt) ? iso(lastSuccessAt) : null;
    const lastSuccessAgeSeconds = lastSuccessIso ? Math.floor((this.now() - lastSuccessAt) / 1_000) : null;
    const revisionAuditQueueDepth = this.queue.filter(({ kind }) => kind === "parser-revision-audit").length;
    const revisionAuditComplete = this.parserRevisionAudit.fullCohort
      && sampleStates.length === Math.min(PARSER_REVISION_AUDIT_SAMPLE_SIZE, this.cohortLimit)
      && currentDispositionCount === sampleStates.length;
    const revisionAuditStatus = !this.parserRevisionAudit.started ? "not-started"
      : !this.parserRevisionAudit.fullCohort ? "not-applicable"
      : this.activeQueueKind === "parser-revision-audit" ? "running"
      : revisionAuditQueueDepth > 0 ? "queued"
      : this.counters.revisionAuditFailures > 0 && this.counters.revisionAuditSuccesses > 0 ? "complete-with-failures"
      : this.counters.revisionAuditFailures > 0 ? "failed"
      : revisionAuditComplete && currentFailureDispositionCount > 0 && currentAcquisitionCount > 0 ? "complete-with-failures"
      : revisionAuditComplete && currentFailureDispositionCount > 0 ? "failed"
      : revisionAuditComplete ? "complete"
      : "incomplete";
    return {
      schemaVersion: 1,
      source: GECKOTERMINAL_PROVIDER.id,
      status: this.status,
      queueDepth: this.queue.length,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: lastSuccessIso,
      runtimeLastSuccessAt: this.lastSuccessAt,
      persistedLastSuccessAt,
      lastSuccessAgeSeconds,
      successStaleAfterSeconds: null,
      lastSuccessIsStale: null,
      evidenceAcquisition: "bounded-one-time-15m-with-one-missing-or-stale-retry",
      ongoingFreshnessRequired: false,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
      schedule: { initialDelaySeconds: INITIAL_DELAY_MS / 1_000, retryDelaySeconds: RETRY_DELAY_MS / 1_000, maxAttempts: MAX_ATTEMPTS },
      parserRevisionAudit: {
        status: revisionAuditStatus,
        currentRevision: RISK_IDENTITY_PARSER_REVISION,
        targetStateCount: Math.min(PARSER_REVISION_AUDIT_SAMPLE_SIZE, this.cohortLimit),
        fullCohortAtStart: this.parserRevisionAudit.fullCohort,
        sampleStateCount: sampleStates.length,
        currentDispositionCountAtStart: this.parserRevisionAudit.currentDispositionCountAtStart,
        currentDispositionCount,
        currentAcquisitionCount,
        eligibleStateCountAtStart: this.parserRevisionAudit.eligibleStateCount,
        selectedStateCount: this.parserRevisionAudit.selectedStateCount,
        queueDepth: revisionAuditQueueDepth,
        attempts: this.counters.revisionAuditAttempts,
        successes: this.counters.revisionAuditSuccesses,
        failures: this.counters.revisionAuditFailures,
        skippedCurrent: this.counters.revisionAuditSkippedCurrent
      },
      persistence: {
        stateCount: states.length,
        cohortLimit: this.cohortLimit,
        admittedCount: this.admittedMints.size,
        successfulStateCount: states.filter((state) => state.lastSuccessAt !== null && state.lastSuccessAt !== undefined).length,
        dueStateCount: states.filter((state) => timestamp(state.nextAttemptAt) !== null && timestamp(state.nextAttemptAt) <= this.now()).length,
        currentParserAcquisitionCount: states.filter((state) => hasCurrentParserAcquisition(state.evidence)).length
      },
      counters: { ...this.counters }
    };
  }

  enqueue(token) {
    if (this.closed || !validToken(token) || this.queuedMints.has(token.mint)) return false;
    let state = this.store.riskIdentityState(token.mint);
    if (!state) {
      const nowMs = this.now();
      const createdMs = timestamp(token.createdAt);
      if (this.admittedMints.size >= this.cohortLimit) {
        this.counters.droppedCohort++;
        return false;
      }
      if (createdMs === null || nowMs - createdMs > this.maxAdmissionAgeMs || createdMs > nowMs + 5 * 60_000) {
        this.counters.droppedLate++;
        return false;
      }
      const dueAt = nextRiskIdentityAttemptAt(token.createdAt, nowMs);
      const updatedAt = iso(nowMs);
      this.store.upsertRiskIdentityState({
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        status: "queued",
        missingReason: "Provider token-info evidence pending",
        errorCode: null,
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: dueAt,
        lastSuccessAt: null,
        updatedAt,
        evidence: unavailableEvidence(token.mint, "pending", updatedAt)
      });
      this.admittedMints.add(token.mint);
      state = this.store.riskIdentityState(token.mint);
    }
    if (state.attemptCount >= MAX_ATTEMPTS || timestamp(state.nextAttemptAt) === null || timestamp(state.nextAttemptAt) > this.now()) return false;
    if (this.queue.length >= this.maxQueue) {
      this.counters.droppedQueue++;
      return false;
    }
    this.queue.push({ mint: token.mint, createdAt: new Date(timestamp(token.createdAt)).toISOString() });
    this.queuedMints.add(token.mint);
    this.counters.queued++;
    this.#schedule(0);
    return true;
  }

  start(tokens = []) {
    if (this.closed) throw new Error("Risk identity ingestor is closed");
    const tokenRows = Array.isArray(tokens) ? tokens : [];
    if (!this.parserRevisionAudit.started) this.#enqueueParserRevisionAudit(tokenRows);
    for (const token of tokenRows) this.enqueue(token);
    this.#schedule(0);
  }

  #enqueueParserRevisionAudit(tokens) {
    this.parserRevisionAudit.started = true;
    const states = this.store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    this.parserRevisionAudit.fullCohort = states.length >= this.cohortLimit && this.admittedMints.size >= this.cohortLimit;
    const sampleStates = fixedParserRevisionSample(states, this.cohortLimit);
    this.parserRevisionAudit.sampleStateCount = sampleStates.length;
    this.parserRevisionAudit.currentDispositionCountAtStart = sampleStates
      .filter((state) => hasCurrentParserDisposition(state.evidence)).length;
    const eligibleStates = sampleStates.filter((state) => !hasCurrentParserDisposition(state.evidence)
      && (state.attemptCount >= MAX_ATTEMPTS || timestamp(state.nextAttemptAt) === null));
    this.parserRevisionAudit.eligibleStateCount = eligibleStates.length;
    if (!this.parserRevisionAudit.fullCohort) return;

    const tokensByMint = new Map(tokens.filter(validToken).map((token) => [token.mint, token]));
    const selectionLimit = Math.min(PARSER_REVISION_AUDIT_SAMPLE_SIZE, Math.max(0, this.maxQueue - this.queue.length));
    for (const state of eligibleStates) {
      if (this.parserRevisionAudit.selectedStateCount >= selectionLimit) break;
      const token = tokensByMint.get(state.mint);
      const current = this.store.riskIdentityState(state.mint);
      if (!token || !current || hasCurrentParserDisposition(current.evidence) || this.queuedMints.has(state.mint)) continue;
      this.queue.push({
        mint: token.mint,
        createdAt: new Date(timestamp(token.createdAt)).toISOString(),
        kind: "parser-revision-audit"
      });
      this.queuedMints.add(token.mint);
      this.parserRevisionAudit.selectedStateCount++;
      this.counters.queued++;
      this.counters.revisionAuditQueued++;
    }
  }

  close() {
    this.closed = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queuedMints.clear();
    this.status = "closed";
  }

  #schedule(delay) {
    if (this.closed || this.running || this.timer || !this.queue.length) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.#drainOne().catch((error) => {
        this.status = "degraded";
        this.counters.failures++;
        this.lastErrorAt = iso(this.now());
        this.lastErrorCode = "enrichment-failed";
        this.onStatus("degraded", { errorCode: "enrichment-failed", error });
      });
    }, delay);
    this.timer?.unref?.();
  }

  async #drainOne() {
    if (this.closed || this.running) return;
    const token = this.queue.shift();
    if (!token) return;
    this.queuedMints.delete(token.mint);
    this.running = true;
    this.activeQueueKind = token.kind || "normal";
    this.status = "enriching";
    try { await this.#refreshToken(token, token.kind === "parser-revision-audit"); }
    catch (error) {
      if (token.kind === "parser-revision-audit") this.counters.revisionAuditFailures++;
      throw error;
    }
    finally {
      this.running = false;
      this.activeQueueKind = null;
      if (!this.closed) this.#schedule(this.betweenTokensMs);
    }
  }

  async refreshToken(token) {
    return this.#refreshToken(token, false);
  }

  async #refreshToken(token, parserRevisionAudit) {
    if (!validToken(token)) throw new TypeError("token must include a valid Solana mint and createdAt timestamp");
    const existing = this.store.riskIdentityState(token.mint);
    if (!existing) throw new TypeError("risk identity token must be admitted before refresh");
    if (parserRevisionAudit && hasCurrentParserDisposition(existing.evidence)) {
      this.counters.revisionAuditSkippedCurrent++;
      return existing;
    }
    if (!parserRevisionAudit && timestamp(existing.nextAttemptAt) > this.now()) return { status: "deferred", nextAttemptAt: existing.nextAttemptAt };
    if (!parserRevisionAudit && (existing.attemptCount >= MAX_ATTEMPTS || timestamp(existing.nextAttemptAt) === null)) return existing;
    const attemptedAt = iso(this.now());
    const attemptCount = parserRevisionAudit ? existing.attemptCount : existing.attemptCount + 1;
    const persistedLastAttemptAt = parserRevisionAudit && attemptCount === 0 ? existing.lastAttemptAt : attemptedAt;
    this.lastAttemptAt = attemptedAt;
    this.counters.attempts++;
    if (parserRevisionAudit) this.counters.revisionAuditAttempts++;
    try {
      const payload = await this.client.tokenInfo(token.mint);
      const tokenFetchedAt = iso(Math.max(this.now(), (timestamp(existing.updatedAt) ?? 0) + 1));
      let candidateEvidence = parseGeckoTerminalTokenInfo(payload, { mint: token.mint, network: "solana", fetchedAt: tokenFetchedAt });
      if (typeof this.client.currentPoolForToken === "function") {
        let selection = null;
        let liquidityError = null;
        try { selection = await this.client.currentPoolForToken(token.mint); }
        catch (error) { liquidityError = error; }
        candidateEvidence = {
          ...candidateEvidence,
          liquidity: currentLiquidityEvidence(token.mint, iso(this.now()), selection, liquidityError)
        };
      }
      const completedAt = iso(Math.max(this.now(), (timestamp(existing.updatedAt) ?? 0) + 1));
      const quality = evidenceQuality(candidateEvidence, candidateEvidence.fetchedAt);
      const priorEvidence = existing.lastSuccessAt !== null && existing.lastSuccessAt !== undefined
        && existing.evidence && typeof existing.evidence === "object" && existing.evidence.factors && existing.evidence.fingerprints
        ? existing.evidence : null;
      const priorQuality = priorEvidence ? evidenceQuality(priorEvidence, priorEvidence.fetchedAt) : null;
      const candidateComponents = new Set(quality.components);
      const retainedPriorEvidence = Boolean(priorQuality?.components.length)
        && (priorQuality.evidenceCount > quality.evidenceCount
          || !priorQuality.components.every((component) => candidateComponents.has(component)));
      const evidence = retainedPriorEvidence
        ? currentParserAuditEvidence(priorEvidence, completedAt)
        : candidateEvidence;
      const effectiveQuality = retainedPriorEvidence ? priorQuality : quality;
      const retry = !parserRevisionAudit && attemptCount < MAX_ATTEMPTS && quality.needsRetry;
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        evidence,
        status: effectiveQuality.hasEvidence ? "available" : "unavailable",
        missingReason: retainedPriorEvidence
          ? parserRevisionAudit ? "The current parser audit returned weaker token-info coverage; prior factors were retained"
            : retry ? "A weaker token-info observation was received; prior factors were retained and one bounded retry remains"
              : "The bounded retry returned weaker token-info coverage; prior factors were retained"
          : quality.needsRetry
          ? parserRevisionAudit ? "Current parser audit evidence was missing or stale; the audit acquisition was bounded to one request"
            : retry ? "Provider token-info evidence was missing or stale; one bounded retry scheduled"
              : "Provider token-info evidence remained missing or stale after the bounded retry"
          : null,
        errorCode: null,
        attemptCount,
        lastAttemptAt: persistedLastAttemptAt,
        nextAttemptAt: parserRevisionAudit ? existing.nextAttemptAt : retry ? iso(this.now() + RETRY_DELAY_MS) : null,
        lastSuccessAt: completedAt,
        updatedAt: completedAt
      };
      validateRiskIdentityPersistenceEvidence(state.evidence, {
        mint: state.mint,
        status: state.status,
        requireCurrentProvenance: true
      });
      this.store.upsertRiskIdentityState(state);
      this.status = state.status;
      this.lastSuccessAt = completedAt;
      this.lastErrorAt = null;
      this.lastErrorCode = null;
      this.counters.successes++;
      if (parserRevisionAudit) this.counters.revisionAuditSuccesses++;
      if (!effectiveQuality.hasEvidence) this.counters.unavailable++;
      this.onStatus(state.status, {
        mint: token.mint,
        nextAttemptAt: state.nextAttemptAt,
        missingCore: quality.missingCore,
        holderTimestampStale: quality.holderTimestampStale,
        retainedPriorEvidence,
        parserRevisionAudit
      });
      return state;
    } catch (error) {
      const failedAt = iso(Math.max(this.now(), (timestamp(existing.updatedAt) ?? 0) + 1));
      const providerError = error instanceof GeckoTerminalError ? error : null;
      const boundedCode = boundedProviderErrorCode(error);
      const retry = !parserRevisionAudit && attemptCount < MAX_ATTEMPTS;
      const unavailable = ["not-found", "token-info-missing"].includes(boundedCode);
      const retainPriorEvidence = existing.lastSuccessAt !== null && existing.lastSuccessAt !== undefined
        && existing.evidence && typeof existing.evidence === "object" && existing.evidence.factors && existing.evidence.fingerprints;
      const baseEvidence = retainPriorEvidence ? existing.evidence : unavailableEvidence(token.mint, boundedCode, attemptedAt);
      const invalidResponse = boundedCode.startsWith("invalid-") || boundedCode === "token-mismatch";
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        evidence: currentParserFailureEvidence(baseEvidence, attemptedAt),
        status: boundedCode === "rate-limited" ? "rate-limited"
          : invalidResponse ? "invalid-response"
            : retainPriorEvidence ? "degraded" : unavailable ? "unavailable" : "degraded",
        missingReason: retainPriorEvidence ? parserRevisionAudit
          ? "Last valid token-info factors were retained after the current parser audit failed"
          : "Last valid token-info factors were retained after a refresh failure"
          : unavailable ? "Provider token-info was unavailable" : invalidResponse ? "Provider token-info response was invalid" : "Provider token-info request failed",
        errorCode: boundedCode,
        attemptCount,
        lastAttemptAt: persistedLastAttemptAt,
        nextAttemptAt: parserRevisionAudit ? existing.nextAttemptAt : retry ? iso(this.now() + Math.max(RETRY_DELAY_MS, providerError?.retryAfterMs || 0)) : null,
        lastSuccessAt: existing.lastSuccessAt,
        updatedAt: failedAt
      };
      this.store.upsertRiskIdentityState(state);
      this.status = state.status;
      this.lastErrorAt = failedAt;
      this.lastErrorCode = boundedCode;
      if (unavailable) this.counters.unavailable++;
      else if (boundedCode === "rate-limited") this.counters.rateLimited++;
      else this.counters.failures++;
      if (parserRevisionAudit) this.counters.revisionAuditFailures++;
      this.onStatus(state.status, { mint: token.mint, errorCode: boundedCode, nextAttemptAt: state.nextAttemptAt, parserRevisionAudit });
      return state;
    }
  }
}
