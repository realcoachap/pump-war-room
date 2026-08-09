import { createHmac } from "node:crypto";
import {
  EARLY_ACTOR_RPC_SOURCE,
  normalizeEarlyActorTrade,
  summarizeEarlyActorEvents
} from "./early-actors.js";
import { extractFinalizedActorInputs, SOLANA_MAINNET_RPC, SolanaRpcError } from "./solana-rpc.js";

export const ACTOR_COHORT_LIMIT = 32;
export const ACTOR_SIGNATURE_LIMIT = 16;
export const ACTOR_TRANSACTION_LIMIT = 8;
export const ACTOR_RAW_RETENTION_MS = 72 * 60 * 60 * 1_000;
export const ACTOR_EARLY_WINDOW_MS = 30 * 60 * 1_000;
const ATTEMPT_OFFSETS_MS = Object.freeze([2 * 60_000, 10 * 60_000, 30 * 60_000]);
const REPLAY_MAX_AGE_MS = 2 * 60_000;

function iso(value, label) {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function eventKey(secret, input) {
  const hmac = createHmac("sha256", secret);
  hmac.update("pump-war-room/actor-observation-v1\0");
  for (const part of [input.source, input.mint, input.transactionId, input.actorAddress]) {
    hmac.update(String(Buffer.byteLength(part)));
    hmac.update(":");
    hmac.update(part);
    hmac.update("\0");
  }
  return `actor:${hmac.digest("hex")}`;
}

function nextAttemptAt(launchAtMs, completedAttemptCount) {
  const offset = ATTEMPT_OFFSETS_MS[completedAttemptCount];
  return offset === undefined ? null : new Date(launchAtMs + offset).toISOString();
}

function publicErrorCode(error) {
  if (error instanceof SolanaRpcError) return error.code;
  const code = typeof error?.code === "string" ? error.code : "actor-acquisition-failed";
  return /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : "actor-acquisition-failed";
}

export class EarlyActorIngestor {
  constructor({ store, client, now = () => Date.now(), onStatus, extract = extractFinalizedActorInputs } = {}) {
    if (!store || typeof store.actorPrivacySecret !== "function") throw new TypeError("store must provide actor persistence");
    if (!client || typeof client.signaturesForAddress !== "function" || typeof client.transaction !== "function") {
      throw new TypeError("client must provide bounded Solana RPC reads");
    }
    if (typeof extract !== "function") throw new TypeError("extract must validate finalized Pump transactions");
    this.store = store;
    this.client = client;
    this.now = now;
    this.onStatus = onStatus;
    this.extract = extract;
    this.secret = store.actorPrivacySecret();
    this.running = false;
    this.started = false;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastErrorCode = null;
    this.counters = {
      admissions: 0,
      duplicates: 0,
      cohortFull: 0,
      replayTooOld: 0,
      attempts: 0,
      signaturesReturned: 0,
      transactionsRequested: 0,
      transactionsUnavailable: 0,
      transactionsRejected: 0,
      observationsAccepted: 0,
      observationsDeduplicated: 0,
      failures: 0
    };
  }

  start() {
    this.started = true;
    this.#emit("idle");
  }

  admit(token) {
    if (!token || token.source !== "pumpportal" || typeof token.mint !== "string") return { admitted: false, reason: "ineligible-source" };
    const launchAt = Date.parse(token.createdAt);
    const now = this.now();
    if (!Number.isFinite(launchAt) || launchAt > now + 5 * 60_000 || now - launchAt > REPLAY_MAX_AGE_MS) {
      this.counters.replayTooOld++;
      return { admitted: false, reason: "replay-too-old-or-invalid" };
    }
    const result = this.store.admitActorMint({
      mint: token.mint,
      launchObservedAt: new Date(launchAt).toISOString(),
      admittedAt: new Date(now).toISOString(),
      nextAttemptAt: nextAttemptAt(launchAt, 0),
      limit: ACTOR_COHORT_LIMIT
    });
    if (result.admitted) this.counters.admissions++;
    else if (result.reason === "already-admitted") this.counters.duplicates++;
    else if (result.reason === "cohort-full") this.counters.cohortFull++;
    this.#emit(result.admitted ? "queued" : "idle", { mint: token.mint, reason: result.reason });
    return result;
  }

  async drainDue() {
    if (!this.started || this.running) return false;
    const [state] = this.store.dueActorStates({ now: new Date(this.now()).toISOString(), limit: 1 });
    if (!state) return false;
    this.running = true;
    try { await this.#acquire(state); }
    finally { this.running = false; }
    return true;
  }

  getStatus() {
    const states = this.store.actorStates({ limit: ACTOR_COHORT_LIMIT });
    const statusCounts = Object.fromEntries(states.reduce((counts, state) => {
      counts.set(state.status, (counts.get(state.status) || 0) + 1);
      return counts;
    }, new Map()));
    const summaries = this.store.actorSummaries(ACTOR_COHORT_LIMIT);
    const evidenceMintCount = summaries.filter((summary) => summary.coverage?.eventCount > 0).length;
    const eligibleMintCount = summaries.filter((summary) => summary.coverage?.state === "available").length;
    const admittedCount = states.length;
    const acquisitionCoverage = admittedCount ? evidenceMintCount / admittedCount : null;
    const correlationGate = {
      status: eligibleMintCount >= 20 && acquisitionCoverage !== null && acquisitionCoverage >= 0.6 ? "review-required" : "withheld",
      minimumEligibleMints: 20,
      minimumAcquisitionCoverage: 0.6,
      eligibleMintCount,
      acquisitionCoverage,
      labeledHoldoutCalibrationPassed: false,
      rankingImpact: "none",
      riskProbabilityImpact: "none",
      telegramAlertImpact: "none",
      recommendationImpact: "none"
    };
    return {
      schemaVersion: 1,
      source: SOLANA_MAINNET_RPC.id,
      status: this.running ? "acquiring" : admittedCount ? "observing" : "awaiting-prospective-admission",
      started: this.started,
      queueDepth: this.store.dueActorStates({ now: new Date(this.now()).toISOString(), limit: ACTOR_COHORT_LIMIT }).length,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
      cohort: { limit: ACTOR_COHORT_LIMIT, admittedCount, evidenceMintCount, eligibleMintCount, statusCounts },
      correlationGate,
      counters: { ...this.counters }
    };
  }

  async #acquire(state) {
    const attemptedAt = new Date(this.now()).toISOString();
    const launchAtMs = Date.parse(state.launchObservedAt);
    const completedAttemptCount = state.attemptCount + 1;
    const scheduledNext = nextAttemptAt(launchAtMs, completedAttemptCount);
    this.lastAttemptAt = attemptedAt;
    this.counters.attempts++;
    this.#emit("acquiring", { mint: state.mint });
    try {
      const signatures = await this.client.signaturesForAddress(state.mint, { limit: ACTOR_SIGNATURE_LIMIT });
      this.counters.signaturesReturned += signatures.length;
      const launchSourceFloorMs = Math.floor(launchAtMs / 1_000) * 1_000;
      const candidates = signatures
        .filter((entry) => entry.blockTime * 1_000 >= launchSourceFloorMs && entry.blockTime * 1_000 <= launchAtMs + ACTOR_EARLY_WINDOW_MS)
        .sort((left, right) => left.blockTime - right.blockTime || left.signature.localeCompare(right.signature))
        .slice(0, ACTOR_TRANSACTION_LIMIT);
      let observed = 0;
      let rejected = 0;
      for (const signature of candidates) {
        this.counters.transactionsRequested++;
        const transaction = await this.client.transaction(signature.signature);
        if (!transaction) {
          this.counters.transactionsUnavailable++;
          continue;
        }
        const extracted = this.extract({ mint: state.mint, signatureInfo: signature, transaction, observedAt: attemptedAt });
        if (extracted.status !== "observed") {
          rejected++;
          this.counters.transactionsRejected++;
          continue;
        }
        for (const input of extracted.observations) {
          const normalized = normalizeEarlyActorTrade(input, {
            installationSecret: this.secret,
            observedMints: [state.mint],
            mintCreatedAt: { [state.mint]: state.launchObservedAt },
            observedAt: input.observedAt,
            minimumEventCount: 5,
            minimumActorCount: 3,
            minimumSourceTimestampRatio: 1,
            earlyWindowMs: ACTOR_EARLY_WINDOW_MS
          });
          const saved = this.store.saveActorObservation({
            eventKey: eventKey(this.secret, input),
            mint: state.mint,
            event: normalized,
            sourceAt: normalized.timestamps.source.value,
            observedAt: normalized.timestamps.observedAt,
            retainedUntil: new Date(Date.parse(normalized.timestamps.observedAt) + ACTOR_RAW_RETENTION_MS).toISOString()
          });
          if (saved.written) {
            observed++;
            this.counters.observationsAccepted++;
          } else {
            this.counters.observationsDeduplicated++;
          }
        }
      }
      const events = this.store.actorObservationEvents(state.mint, 512);
      const summary = summarizeEarlyActorEvents(state.mint, events, {
        mintCreatedAt: state.launchObservedAt,
        minimumEventCount: 5,
        minimumActorCount: 3,
        minimumSourceTimestampRatio: 1,
        earlyWindowMs: ACTOR_EARLY_WINDOW_MS
      });
      this.store.saveActorSummary(state.mint, summary);
      this.store.pruneActorObservations({ now: attemptedAt, maximum: 4096 });
      const terminal = scheduledNext === null;
      const status = terminal ? "complete" : summary.coverage.eventCount > 0 ? "observing" : "unavailable";
      const missingReason = summary.coverage.eventCount > 0
        ? summary.coverage.state === "available" ? null : "Minimum per-coin event/actor/source-time gate not yet met"
        : candidates.length === 0
          ? "No finalized address-referencing signatures were returned inside the bounded early window"
          : "Bounded transactions did not contain unambiguous official Pump buy/sell evidence";
      this.store.recordActorState({
        mint: state.mint,
        status,
        attemptedAt,
        nextAttemptAt: scheduledNext,
        successAt: attemptedAt,
        missingReason,
        errorCode: null
      });
      this.lastSuccessAt = attemptedAt;
      this.lastErrorCode = null;
      this.#emit(status, { mint: state.mint, observed, rejected, coverageState: summary.coverage.state });
    } catch (error) {
      const errorCode = publicErrorCode(error);
      const terminal = scheduledNext === null;
      const status = errorCode === "rate-limited" ? "rate-limited"
        : errorCode.startsWith("invalid-") ? "invalid-response"
          : "degraded";
      this.store.recordActorState({
        mint: state.mint,
        status,
        attemptedAt,
        nextAttemptAt: terminal ? null : scheduledNext,
        successAt: null,
        missingReason: "Bounded finalized transaction acquisition failed; evidence remains unavailable",
        errorCode
      });
      this.lastErrorAt = attemptedAt;
      this.lastErrorCode = errorCode;
      this.counters.failures++;
      this.#emit(status, { mint: state.mint, errorCode, error });
    }
  }

  #emit(status, details = {}) {
    this.onStatus?.(status, { ...details, status, source: EARLY_ACTOR_RPC_SOURCE });
  }
}
