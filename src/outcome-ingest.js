import { GECKOTERMINAL_PROVIDER, GeckoTerminalError } from "./geckoterminal.js";
import { calculateVerifiedOutcome, toDurableOutcomeRecord, validateProviderObservedOutcome } from "./outcomes.js";

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUTCOME_OFFSETS_MS = Object.freeze([5, 15, 60, 360, 1_440].map((minutes) => minutes * 60_000));
const HISTORY_LIMIT_MS = 24 * 60 * 60_000 + 2 * 60_000;
const MAX_OHLCV_PAGES = 2;
const OUTCOME_KEYS = Object.freeze(["5m", "15m", "1h", "6h", "24h"]);
const PROVIDER_SUCCESS_STALE_AFTER_MS = 6 * 60 * 60_000 + 15 * 60_000;
const POOL_SELECTION_DEADLINE_MS = 120_000;
const BASELINE_FINALIZATION_DELAY_MS = 5 * 60_000;

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return new Date(value).toISOString();
}

function validToken(token) {
  return token && typeof token === "object"
    && typeof token.mint === "string"
    && MINT_PATTERN.test(token.mint)
    && timestamp(token.createdAt) !== null;
}

function boundedReason(value) {
  const reason = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return reason ? reason.slice(0, 160) : null;
}

function newestTimestamp(values) {
  const milliseconds = values.map(timestamp).filter(Number.isFinite);
  return milliseconds.length ? iso(Math.max(...milliseconds)) : null;
}

function poolReserveEvidence(selection) {
  const attemptedAt = timestamp(selection?.poolSelectedAt) === null ? null : iso(timestamp(selection.poolSelectedAt));
  const reserveUsd = typeof selection?.reserveUsd === "number" && Number.isFinite(selection.reserveUsd)
    && selection.reserveUsd >= 0 ? selection.reserveUsd : null;
  const available = reserveUsd !== null && attemptedAt !== null;
  return {
    schemaVersion: 1,
    source: GECKOTERMINAL_PROVIDER.id,
    evidenceClass: available ? "provider-observed" : "unavailable",
    attemptedAt,
    observedAt: available ? attemptedAt : null,
    liquidityUsd: available ? reserveUsd : null,
    missingReasonCode: available ? null : "pool-reserve-missing",
    basis: "provider-observed-pool-reserve",
    limitation: "GeckoTerminal-observed pool reserve is not evidence of locked liquidity"
  };
}

function mergeOutcomeHistory(previousValue, candidate) {
  let previous;
  try { previous = validateProviderObservedOutcome(previousValue, { requireProspectiveSelection: true }); }
  catch { return candidate; }
  if (previous.launchAt !== candidate.launchAt || previous.poolSelection?.pool !== candidate.poolSelection?.pool) return candidate;
  const merged = structuredClone(candidate);
  const changedWindows = [];
  const missingWindows = [];
  const newlyObservedWindows = [];
  if (previous.baseline?.status === "observed") merged.baseline = previous.baseline;
  if (previous.series && (!candidate.series || previous.series.pool === candidate.series.pool)) merged.series = previous.series;
  merged.poolSelection = previous.poolSelection || candidate.poolSelection;
  for (const key of OUTCOME_KEYS) {
    const prior = previous.windows[key];
    const latest = candidate.windows[key];
    if (prior?.status !== "observed" && latest?.status === "observed") newlyObservedWindows.push(key);
    if (prior?.status !== "observed") continue;
    if (latest?.status !== "observed") missingWindows.push(key);
    else if (prior.returnPct !== latest.returnPct || prior.maximumDrawdownPct !== latest.maximumDrawdownPct
      || prior.observedAt !== latest.observedAt) changedWindows.push(key);
    merged.windows[key] = prior;
  }
  const observed = OUTCOME_KEYS.filter((key) => merged.windows[key]?.status === "observed").length;
  merged.status = observed === OUTCOME_KEYS.length ? "complete" : observed ? "partial" : merged.status;
  merged.observationCounts.retainedObservedWindows = observed;
  const history = Array.isArray(previous.revisionHistory) ? previous.revisionHistory : [];
  merged.revisionHistory = (changedWindows.length || missingWindows.length || newlyObservedWindows.length)
    ? [...history, {
        checkedAt: candidate.asOf,
        action: "first-observed-per-window-provider-revisions-retained",
        windowRevisionPolicy: candidate.revisionPolicy,
        changedWindows,
        missingWindows,
        newlyObservedWindows
      }].slice(-20)
    : history.slice(-20);
  return validateProviderObservedOutcome(merged, { requireProspectiveSelection: true });
}

export function nextOutcomeAttemptAt(launchAt, now = Date.now()) {
  const launch = timestamp(launchAt);
  if (launch === null || !Number.isFinite(now)) return new Date(now + 15 * 60_000).toISOString();
  const nextWindow = OUTCOME_OFFSETS_MS.map((offset) => launch + offset + 90_000).find((target) => target > now);
  return iso(nextWindow ?? now + 6 * 60 * 60_000);
}

export class VerifiedOutcomeIngestor {
  constructor({
    store,
    client,
    onStatus = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    betweenTokensMs = 250,
    maxQueue = 8,
    cohortLimit = 120,
    maxAdmissionAgeMs = 5 * 60_000
  } = {}) {
    for (const method of ["upsertEnrichmentState", "enrichmentState", "enrichmentStates"]) {
      if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} must be a function`);
    }
    if (typeof client?.poolForToken !== "function" || typeof client?.ohlcv !== "function") throw new TypeError("client must implement poolForToken and ohlcv");
    if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");
    if (!Number.isFinite(betweenTokensMs) || betweenTokensMs < 0) throw new RangeError("betweenTokensMs must be non-negative");
    if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError("maxQueue must be a positive integer");
    if (!Number.isInteger(cohortLimit) || cohortLimit < 1 || cohortLimit > 200) throw new RangeError("cohortLimit must be between 1 and 200");
    if (!Number.isFinite(maxAdmissionAgeMs) || maxAdmissionAgeMs < 0) throw new RangeError("maxAdmissionAgeMs must be non-negative");
    Object.assign(this, { store, client, onStatus, now, setTimeoutFn, clearTimeoutFn, betweenTokensMs, maxQueue, cohortLimit, maxAdmissionAgeMs });
    this.queue = [];
    this.queuedMints = new Set();
    this.admittedMints = new Set(store.enrichmentStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: cohortLimit }).map(({ mint }) => mint));
    this.timer = null;
    this.running = false;
    this.closed = false;
    this.status = "idle";
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastErrorCode = null;
    this.counters = { queued: 0, attempts: 0, successes: 0, poolSelections: 0, observations: 0, noPool: 0, failures: 0, rateLimited: 0, consecutiveFailures: 0, droppedQueue: 0, droppedCohort: 0, droppedLate: 0 };
  }

  getStatus() {
    const persistedStates = this.store.enrichmentStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: this.cohortLimit });
    const persistedLastAttemptAt = newestTimestamp(persistedStates.map((state) => state.lastAttemptAt));
    const persistedLastSuccessAt = newestTimestamp(persistedStates.map((state) => state.lastSuccessAt));
    const lastAttemptAt = newestTimestamp([this.lastAttemptAt, persistedLastAttemptAt]);
    const lastSuccessAt = newestTimestamp([this.lastSuccessAt, persistedLastSuccessAt]);
    const statusAt = this.now();
    const lastSuccessAgeSeconds = lastSuccessAt === null ? null : Math.floor((statusAt - timestamp(lastSuccessAt)) / 1_000);
    const dueStateCount = persistedStates.filter((state) => timestamp(state.nextAttemptAt) !== null
      && timestamp(state.nextAttemptAt) <= statusAt).length;
    const providerWorkDue = dueStateCount > 0 || this.queue.length > 0 || this.running;
    return {
      schemaVersion: 1,
      source: GECKOTERMINAL_PROVIDER.id,
      status: this.status,
      queueDepth: this.queue.length,
      lastAttemptAt,
      lastSuccessAt,
      lastSuccessAgeSeconds,
      successStaleAfterSeconds: PROVIDER_SUCCESS_STALE_AFTER_MS / 1_000,
      successFreshnessBasis: "provider-success-age-while-scheduled-work-is-due",
      lastSuccessIsStale: lastSuccessAt === null ? null : lastSuccessAgeSeconds < 0
        || (providerWorkDue && lastSuccessAgeSeconds > PROVIDER_SUCCESS_STALE_AFTER_MS / 1_000),
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
      rateLimit: { callsPerMinute: 10, enforcedMinimumIntervalMs: this.client.minIntervalMs ?? null },
      cohort: { policy: "prospective-fixed-admission-v1", limit: this.cohortLimit, admitted: this.admittedMints.size },
      persistence: {
        stateCount: persistedStates.length,
        attemptCount: persistedStates.reduce((total, state) => total + (Number.isSafeInteger(state.attemptCount) ? state.attemptCount : 0), 0),
        successfulStateCount: persistedStates.filter((state) => state.lastSuccessAt !== null && state.lastSuccessAt !== undefined).length,
        dueStateCount,
        lastAttemptAt: persistedLastAttemptAt,
        lastSuccessAt: persistedLastSuccessAt
      },
      counters: { ...this.counters }
    };
  }

  enqueue(token) {
    if (this.closed || !validToken(token) || this.queuedMints.has(token.mint)) return false;
    let existing = this.store.enrichmentState(token.mint);
    const admitted = this.admittedMints.has(token.mint) || Boolean(existing);
    if (!admitted && this.now() - timestamp(token.createdAt) > this.maxAdmissionAgeMs) {
      this.counters.droppedLate++;
      return false;
    }
    if (!admitted && this.admittedMints.size >= this.cohortLimit) {
      this.counters.droppedCohort++;
      return false;
    }
    if (!admitted) {
      const admittedAt = iso(this.now());
      this.admittedMints.add(token.mint);
      this.store.upsertEnrichmentState({
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        pool: null,
        tokenSide: null,
        dex: null,
        sourceUrl: null,
        status: "queued",
        missingReason: "Prospective launch admitted; provider evidence pending",
        errorCode: null,
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: admittedAt,
        lastSuccessAt: null,
        updatedAt: admittedAt,
        evidence: {
          source: GECKOTERMINAL_PROVIDER.id,
          admissionPolicy: "prospective-fixed-admission-v1",
          launchObservedAt: token.createdAt,
          admittedAt,
          retention: "derived-metrics-and-minimal-provenance-only"
        }
      });
      existing = this.store.enrichmentState(token.mint);
    }
    const canonicalLaunchAt = existing?.evidence?.launchObservedAt || existing?.evidence?.outcome?.launchAt || token.createdAt;
    if (this.queue.length >= this.maxQueue) {
      const deferredOutcomeIndex = !existing?.pool ? this.queue.findLastIndex((item) => item.stage === "outcome") : -1;
      if (deferredOutcomeIndex >= 0) {
        const [deferred] = this.queue.splice(deferredOutcomeIndex, 1);
        this.queuedMints.delete(deferred.mint);
        this.counters.droppedQueue++;
      } else {
        this.counters.droppedQueue++;
        return false;
      }
    }
    const queuedToken = {
      mint: token.mint,
      createdAt: new Date(timestamp(canonicalLaunchAt)).toISOString(),
      stage: existing?.pool ? "outcome" : "selection"
    };
    if (queuedToken.stage === "selection") {
      const firstOutcomeIndex = this.queue.findIndex((item) => item.stage === "outcome");
      if (firstOutcomeIndex === -1) this.queue.push(queuedToken);
      else this.queue.splice(firstOutcomeIndex, 0, queuedToken);
    } else this.queue.push(queuedToken);
    this.queuedMints.add(token.mint);
    this.counters.queued++;
    this.#schedule(0);
    return true;
  }

  start(tokens = []) {
    if (this.closed) throw new Error("Outcome ingestor is closed");
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
      this.#drainOne().catch(() => {
        this.status = "degraded";
        this.counters.failures++;
        this.counters.consecutiveFailures++;
        this.lastErrorAt = iso(this.now());
        this.lastErrorCode = "worker-failed";
        this.onStatus("degraded", { errorCode: "worker-failed" });
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
    try {
      await this.refreshToken(token);
    } finally {
      this.running = false;
      if (!this.closed) this.#schedule(this.betweenTokensMs);
    }
  }

  async refreshToken(token) {
    if (!validToken(token)) throw new TypeError("token must include a valid Solana mint and createdAt timestamp");
    const nowMs = this.now();
    const attemptedAt = iso(nowMs);
    this.lastAttemptAt = attemptedAt;
    this.counters.attempts++;
    const existing = this.store.enrichmentState(token.mint);
    const persistedLaunchAt = existing?.evidence?.launchObservedAt || existing?.evidence?.outcome?.launchAt || null;
    if (persistedLaunchAt !== null && timestamp(persistedLaunchAt) !== timestamp(token.createdAt)) {
      throw new RangeError("token createdAt conflicts with its prospectively persisted launch timestamp");
    }
    if (timestamp(existing?.nextAttemptAt) > nowMs) {
      this.status = existing?.status || (existing?.lastSuccessAt ? "observing" : "awaiting-data");
      this.lastSuccessAt ||= existing?.lastSuccessAt || null;
      return { status: "deferred", nextAttemptAt: existing.nextAttemptAt };
    }

    let selection = existing?.provider === GECKOTERMINAL_PROVIDER.id && existing?.pool && existing?.tokenSide
      ? {
          provider: existing.provider,
          pool: existing.pool,
          tokenSide: existing.tokenSide,
          dex: existing.dex || null,
          poolCreatedAt: existing.evidence?.poolCreatedAt || existing.poolCreatedAt || token.createdAt,
          poolSelectedAt: existing.evidence?.poolSelectedAt || null,
          providerPage: existing.evidence?.providerPage ?? null,
          providerRank: existing.evidence?.providerRank ?? null,
          reserveUsd: existing.evidence?.liquidity?.liquidityUsd ?? null,
          sourceUrl: existing.sourceUrl || existing.evidence?.sourceUrl || `https://www.geckoterminal.com/solana/pools/${existing.pool}`
        }
      : null;
    try {
      if (!selection && nowMs > timestamp(token.createdAt) + POOL_SELECTION_DEADLINE_MS) {
        throw new GeckoTerminalError("selection-window-missed", "Prospective pool-selection window expired before provider discovery completed");
      }
      const selectedNow = !selection;
      selection ||= await this.client.poolForToken(token.mint, { tokenObservedAt: token.createdAt });
      const selectedMs = timestamp(selection.poolSelectedAt);
      if (selectedMs === null || selectedMs > timestamp(token.createdAt) + POOL_SELECTION_DEADLINE_MS) {
        throw new GeckoTerminalError("selection-window-missed", "Pool selection did not occur prospectively within two minutes of launch observation");
      }
      if (selectedNow && existing) {
        const selectedCompletedMs = Math.max(nowMs, this.now(), (timestamp(existing.updatedAt) ?? 0) + 1);
        const selectedCompletedAt = iso(selectedCompletedMs);
        const nextAttemptAt = iso(timestamp(token.createdAt) + OUTCOME_OFFSETS_MS[0] + 90_000);
        const state = {
          mint: token.mint,
          provider: GECKOTERMINAL_PROVIDER.id,
          pool: selection.pool,
          tokenSide: selection.tokenSide,
          dex: selection.dex,
          sourceUrl: selection.sourceUrl,
          status: "pool-selected",
          missingReason: "Fixed provider page-1 pool selected; awaiting the first mature outcome window",
          errorCode: null,
          lastAttemptAt: attemptedAt,
          nextAttemptAt,
          lastSuccessAt: selectedCompletedAt,
          updatedAt: selectedCompletedAt,
          evidence: {
            ...(existing.evidence && typeof existing.evidence === "object" ? existing.evidence : {}),
            source: GECKOTERMINAL_PROVIDER.id,
            sourceUrl: selection.sourceUrl,
            poolCreatedAt: selection.poolCreatedAt,
            poolSelectedAt: selection.poolSelectedAt,
            providerPage: selection.providerPage,
            providerRank: selection.providerRank,
            selectionScope: "provider-contemporaneously-ranked-page-1",
            liquidity: poolReserveEvidence(selection),
            retention: "derived-metrics-and-minimal-provenance-only"
          }
        };
        this.store.upsertEnrichmentState(state);
        this.counters.successes++;
        this.counters.poolSelections++;
        this.counters.consecutiveFailures = 0;
        this.lastSuccessAt = selectedCompletedAt;
        this.lastErrorAt = null;
        this.lastErrorCode = null;
        this.status = state.status;
        this.onStatus(state.status, { mint: token.mint, nextAttemptAt });
        return state;
      }
      const lowerMs = Math.max(timestamp(token.createdAt), timestamp(selection.poolCreatedAt) ?? timestamp(token.createdAt));
      const upperMs = Math.min(nowMs, lowerMs + HISTORY_LIMIT_MS);
      let beforeTimestamp = Math.floor(upperMs / 1_000) + 60;
      let received = 0;
      let rejected = 0;
      let incomplete = 0;
      let pages = 0;
      const collected = [];
      for (; pages < MAX_OHLCV_PAGES; pages++) {
        const result = await this.client.ohlcv({
          mint: token.mint,
          pool: selection.pool,
          tokenSide: selection.tokenSide,
          beforeTimestamp,
          limit: 1000
        });
        received += result.received;
        rejected += result.rejected;
        incomplete += result.incomplete || 0;
        const bounded = result.observations.filter((observation) => {
          const observed = timestamp(observation.observedAt ?? observation.minuteAt);
          return observed !== null && observed >= lowerMs - 60_000 && observed <= upperMs;
        });
        collected.push(...bounded);
        if (result.received < 1000 || !result.observations.length) { pages++; break; }
        const earliest = Math.min(...result.observations.map((observation) => timestamp(observation.candleStartAt ?? observation.minuteAt)).filter(Number.isFinite));
        if (!Number.isFinite(earliest) || earliest <= lowerMs) { pages++; break; }
        beforeTimestamp = Math.floor(earliest / 1_000);
      }
      // Raw provider responses and bulk candles are intentionally ephemeral. The
      // durable record contains only calculated metrics and the minimum source,
      // pool, completed-candle, retrieval, and missing-data evidence needed to
      // audit those metrics.
      const completedMs = Math.max(nowMs, this.now(), (timestamp(existing?.updatedAt) ?? 0) + 1);
      const completedAt = iso(completedMs);
      const outcome = calculateVerifiedOutcome({
        launchAt: token.createdAt,
        asOf: completedAt,
        candles: collected
      });
      outcome.poolSelection = {
        policy: "prospective-earliest-created-eligible-pool-on-provider-ranked-page-1-within-2m",
        selectedAt: selection.poolSelectedAt,
        providerPage: selection.providerPage,
        providerRank: selection.providerRank,
        poolCreatedAt: selection.poolCreatedAt,
        source: GECKOTERMINAL_PROVIDER.id,
        pool: selection.pool
      };
      const durableCandidate = toDurableOutcomeRecord(outcome);
      const durableOutcome = mergeOutcomeHistory(existing?.evidence?.outcome, durableCandidate);
      const candidateBaselineAt = durableCandidate.baseline?.status === "observed" ? durableCandidate.baseline.observedAt : null;
      const baselineAt = durableOutcome.baseline?.status === "observed" ? durableOutcome.baseline.observedAt : null;
      const baselineFinalizedMissing = !baselineAt && completedMs >= timestamp(token.createdAt) + BASELINE_FINALIZATION_DELAY_MS;
      const status = durableOutcome.status === "complete" ? "complete" : baselineAt ? "observing" : baselineFinalizedMissing ? "baseline-unavailable" : "awaiting-price";
      const missingReason = baselineAt ? null : baselineFinalizedMissing
        ? "No eligible completed baseline candle was provider-observed within the bounded acquisition window"
        : durableOutcome.baseline?.reason || "No completed real-trade minute candle was available";
      const nextAttemptAt = baselineAt ? nextOutcomeAttemptAt(token.createdAt, completedMs) : baselineFinalizedMissing ? null : iso(completedMs + 60_000);
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        pool: selection.pool,
        tokenSide: selection.tokenSide,
        dex: selection.dex,
        sourceUrl: selection.sourceUrl,
        status,
        missingReason,
        errorCode: null,
        lastAttemptAt: attemptedAt,
        nextAttemptAt,
        lastSuccessAt: completedAt,
        updatedAt: completedAt,
        evidence: {
          source: GECKOTERMINAL_PROVIDER.id,
          sourceUrl: selection.sourceUrl,
          poolCreatedAt: selection.poolCreatedAt,
          poolSelectedAt: selection.poolSelectedAt,
          providerPage: selection.providerPage,
          providerRank: selection.providerRank,
          liquidity: poolReserveEvidence(selection),
          received,
          rejected,
          incomplete,
          pages,
          baselineAt,
          observationCount: outcome.observationCounts.normalized,
          outcome: durableOutcome,
          retention: "derived-metrics-and-minimal-provenance-only"
        }
      };
      this.store.upsertEnrichmentState(state);
      this.counters.successes++;
      this.counters.consecutiveFailures = 0;
      this.counters.observations += collected.length;
      this.lastSuccessAt = completedAt;
      this.lastErrorAt = null;
      this.lastErrorCode = null;
      this.status = status;
      this.onStatus(status, { mint: token.mint, observations: collected.length, rejected, nextAttemptAt });
      return state;
    } catch (error) {
      const failedMs = Math.max(nowMs, this.now(), (timestamp(existing?.updatedAt) ?? 0) + 1);
      const failedAt = iso(failedMs);
      const providerError = error instanceof GeckoTerminalError ? error : null;
      const selectionExpired = !selection && failedMs > timestamp(token.createdAt) + POOL_SELECTION_DEADLINE_MS;
      const errorCode = selectionExpired ? "selection-window-missed" : providerError?.code || "enrichment-failed";
      const noPool = !selection && ["pool-unavailable", "not-found"].includes(errorCode);
      const selectedPoolUnavailable = Boolean(selection) && ["pool-unavailable", "not-found"].includes(errorCode);
      const rateLimited = errorCode === "rate-limited";
      const terminal = errorCode === "selection-window-missed" || (!selection && ["provider-request-rejected", "token-mismatch", "invalid-response"].includes(errorCode));
      const delayedInvalidRetry = Boolean(selection) && ["provider-request-rejected", "token-mismatch", "invalid-response", "invalid-json"].includes(errorCode);
      const delayedSelectedRetry = delayedInvalidRetry || selectedPoolUnavailable;
      const retryMs = delayedSelectedRetry ? 6 * 60 * 60_000
        : providerError?.retryAfterMs || (noPool || !selection ? 60_000 : rateLimited ? 60_000 : 5 * 60_000);
      const state = {
        mint: token.mint,
        provider: GECKOTERMINAL_PROVIDER.id,
        pool: selection?.pool || null,
        tokenSide: selection?.tokenSide || null,
        dex: selection?.dex || null,
        sourceUrl: selection?.sourceUrl || null,
        status: terminal || delayedInvalidRetry ? "invalid-response" : noPool ? "awaiting-pool" : rateLimited ? "rate-limited" : "degraded",
        missingReason: terminal ? "Prospective provider evidence was invalid or unavailable" : noPool ? "No eligible provider pool is available yet" : "Provider enrichment attempt failed",
        errorCode,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: terminal ? null : iso(failedMs + retryMs),
        lastSuccessAt: existing?.lastSuccessAt || null,
        updatedAt: failedAt,
        evidence: {
          ...(existing?.evidence && typeof existing.evidence === "object" ? existing.evidence : {}),
          source: GECKOTERMINAL_PROVIDER.id,
          sourceUrl: selection?.sourceUrl || null,
          poolCreatedAt: selection?.poolCreatedAt || null,
          poolSelectedAt: selection?.poolSelectedAt || null,
          providerPage: selection?.providerPage ?? null,
          providerRank: selection?.providerRank ?? null,
          httpStatus: providerError?.status ?? null,
          lastRefreshFailedAt: failedAt,
          lastRefreshErrorCode: errorCode
        }
      };
      this.store.upsertEnrichmentState(state);
      if (noPool) this.counters.noPool++;
      else if (rateLimited) this.counters.rateLimited++;
      else this.counters.failures++;
      if (noPool) this.counters.consecutiveFailures = 0;
      else this.counters.consecutiveFailures++;
      this.lastErrorAt = failedAt;
      this.lastErrorCode = errorCode;
      this.status = state.status;
      this.onStatus(state.status, { mint: token.mint, errorCode, reason: boundedReason(error?.message), nextAttemptAt: state.nextAttemptAt });
      return state;
    }
  }
}
