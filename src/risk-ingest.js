import { GECKOTERMINAL_PROVIDER, GeckoTerminalError } from "./geckoterminal.js";
import { parseGeckoTerminalTokenInfo, RISK_IDENTITY_METHOD_VERSION } from "./risk-identity.js";

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INITIAL_DELAY_MS = 15 * 60_000;
const RETRY_DELAY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 2;
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
    this.admittedMints = new Set(store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: cohortLimit }).map(({ mint }) => mint));
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
    this.counters = {
      queued: 0, attempts: 0, successes: 0, unavailable: 0, failures: 0,
      rateLimited: 0, droppedQueue: 0, droppedCohort: 0, droppedLate: 0
    };
  }

  getStatus() {
    const states = this.store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    const persistedSuccesses = states.map((state) => timestamp(state.lastSuccessAt)).filter(Number.isFinite);
    const persistedLastSuccessAt = persistedSuccesses.length ? iso(Math.max(...persistedSuccesses)) : null;
    const lastSuccessAt = [this.lastSuccessAt, persistedLastSuccessAt]
      .map((value) => timestamp(value)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const lastSuccessIso = Number.isFinite(lastSuccessAt) ? iso(lastSuccessAt) : null;
    const lastSuccessAgeSeconds = lastSuccessIso ? Math.floor((this.now() - lastSuccessAt) / 1_000) : null;
    return {
      schemaVersion: 1,
      source: GECKOTERMINAL_PROVIDER.id,
      status: this.status,
      queueDepth: this.queue.length,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: lastSuccessIso,
      lastSuccessAgeSeconds,
      successStaleAfterSeconds: null,
      lastSuccessIsStale: null,
      evidenceAcquisition: "bounded-one-time-15m-with-one-missing-or-stale-retry",
      ongoingFreshnessRequired: false,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
      schedule: { initialDelaySeconds: INITIAL_DELAY_MS / 1_000, retryDelaySeconds: RETRY_DELAY_MS / 1_000, maxAttempts: MAX_ATTEMPTS },
      persistence: {
        stateCount: states.length,
        cohortLimit: this.cohortLimit,
        admittedCount: this.admittedMints.size,
        successfulStateCount: states.filter((state) => state.lastSuccessAt !== null && state.lastSuccessAt !== undefined).length,
        dueStateCount: states.filter((state) => timestamp(state.nextAttemptAt) !== null && timestamp(state.nextAttemptAt) <= this.now()).length
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
    for (const token of Array.isArray(tokens) ? tokens : []) this.enqueue(token);
    this.#schedule(0);
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
    this.status = "enriching";
    try { await this.refreshToken(token); }
    finally {
      this.running = false;
      if (!this.closed) this.#schedule(this.betweenTokensMs);
    }
  }

  async refreshToken(token) {
    if (!validToken(token)) throw new TypeError("token must include a valid Solana mint and createdAt timestamp");
    const existing = this.store.riskIdentityState(token.mint);
    if (!existing) throw new TypeError("risk identity token must be admitted before refresh");
    if (timestamp(existing.nextAttemptAt) > this.now()) return { status: "deferred", nextAttemptAt: existing.nextAttemptAt };
    if (existing.attemptCount >= MAX_ATTEMPTS || timestamp(existing.nextAttemptAt) === null) return existing;
    const attemptedAt = iso(this.now());
    const attemptCount = existing.attemptCount + 1;
    this.lastAttemptAt = attemptedAt;
    this.counters.attempts++;
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
      const evidence = retainedPriorEvidence ? priorEvidence : candidateEvidence;
      const effectiveQuality = retainedPriorEvidence ? priorQuality : quality;
      const retry = attemptCount < MAX_ATTEMPTS && quality.needsRetry;
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        evidence,
        status: effectiveQuality.hasEvidence ? "available" : "unavailable",
        missingReason: retainedPriorEvidence
          ? retry ? "A weaker token-info observation was received; prior factors were retained and one bounded retry remains"
            : "The bounded retry returned weaker token-info coverage; prior factors were retained"
          : quality.needsRetry
          ? retry ? "Provider token-info evidence was missing or stale; one bounded retry scheduled"
            : "Provider token-info evidence remained missing or stale after the bounded retry"
          : null,
        errorCode: null,
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: retry ? iso(this.now() + RETRY_DELAY_MS) : null,
        lastSuccessAt: completedAt,
        updatedAt: completedAt
      };
      this.store.upsertRiskIdentityState(state);
      this.status = state.status;
      this.lastSuccessAt = completedAt;
      this.lastErrorAt = null;
      this.lastErrorCode = null;
      this.counters.successes++;
      if (!effectiveQuality.hasEvidence) this.counters.unavailable++;
      this.onStatus(state.status, {
        mint: token.mint,
        nextAttemptAt: state.nextAttemptAt,
        missingCore: quality.missingCore,
        holderTimestampStale: quality.holderTimestampStale,
        retainedPriorEvidence
      });
      return state;
    } catch (error) {
      const failedAt = iso(Math.max(this.now(), (timestamp(existing.updatedAt) ?? 0) + 1));
      const providerError = error instanceof GeckoTerminalError ? error : null;
      const boundedCode = boundedProviderErrorCode(error);
      const retry = attemptCount < MAX_ATTEMPTS;
      const unavailable = ["not-found", "token-info-missing"].includes(boundedCode);
      const retainPriorEvidence = existing.lastSuccessAt !== null && existing.lastSuccessAt !== undefined
        && existing.evidence && typeof existing.evidence === "object" && existing.evidence.factors && existing.evidence.fingerprints;
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        evidence: retainPriorEvidence ? existing.evidence : unavailableEvidence(token.mint, boundedCode, attemptedAt),
        status: retainPriorEvidence ? boundedCode === "rate-limited" ? "rate-limited" : "degraded"
          : boundedCode === "rate-limited" ? "rate-limited" : unavailable ? "unavailable" : boundedCode.startsWith("invalid-") || boundedCode === "token-mismatch" ? "invalid-response" : "degraded",
        missingReason: retainPriorEvidence ? "Last valid token-info factors were retained after a refresh failure"
          : unavailable ? "Provider token-info was unavailable" : boundedCode.startsWith("invalid-") || boundedCode === "token-mismatch" ? "Provider token-info response was invalid" : "Provider token-info request failed",
        errorCode: boundedCode,
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: retry ? iso(this.now() + Math.max(RETRY_DELAY_MS, providerError?.retryAfterMs || 0)) : null,
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
      this.onStatus(state.status, { mint: token.mint, errorCode: boundedCode, nextAttemptAt: state.nextAttemptAt });
      return state;
    }
  }
}
