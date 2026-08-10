import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_PENDING_PROPOSAL_LIMIT, Store } from "./store.js";
import { CanonicalRegistry } from "./canonical-registry.js";
import { proposeIdentityCandidates } from "./identity-proposals.js";
import { createDemoToken, tickDemoToken } from "./demo.js";
import { PumpPortalIngestor } from "./ingest.js";
import { BarkCalloutIngestor } from "./callouts.js";
import { exportCoin, exportMeasuredBrief } from "./vault.js";
import { analyzeSnapshot } from "./analyst.js";
import { createRateLimiter, encodeJsonResponse, HttpError, readJsonBody } from "./http.js";
import { createTop100 } from "./ranking.js";
import { createRuntimeTelemetry, FEED_STALE_AFTER_MS, observeFeed, observeStorage } from "./observability.js";
import { GECKOTERMINAL_PROVIDER, GeckoTerminalClient } from "./geckoterminal.js";
import { VerifiedOutcomeIngestor } from "./outcome-ingest.js";
import { aggregateOutcomeCohorts, OUTCOME_REVISION_POLICY, summarizeVerifiedOutcomes, unavailableProviderOutcome, validateProviderObservedOutcome } from "./outcomes.js";
import { RiskIdentityIngestor } from "./risk-ingest.js";
import {
  RISK_IDENTITY_EVIDENCE_CLASSES,
  RISK_IDENTITY_METHOD_VERSION,
  RISK_IDENTITY_PARSER_REVISION
} from "./risk-identity.js";
import { attachRiskIdentityEvidence } from "./risk-public.js";
import { normalizePersistedLiveToken } from "./live-token.js";
import { projectPublicCallout, projectPublicToken } from "./privacy.js";
import { ACTOR_COHORT_LIMIT, ACTOR_EARLY_WINDOW_MS, ACTOR_RAW_RETENTION_MS, ACTOR_SIGNATURE_LIMIT, ACTOR_TRANSACTION_LIMIT, EarlyActorIngestor } from "./actor-ingest.js";
import { SOLANA_ACTOR_PARSER_REVISION, SOLANA_MAINNET_RPC, SolanaRpcClient } from "./solana-rpc.js";
import {
  buildCoinComparison,
  buildCoinTimeline,
  buildMeasuredBrief,
  CLOSED_BRIEF_METHOD_VERSION,
  detectMaterialAlerts,
  sendTelegramAlert,
  telegramAlertStatus,
  telegramRetryPlan
} from "./action-intelligence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const port = Number(process.env.PORT || 4173);
const mode = process.env.PUMP_MODE === "live" ? "live" : "demo";
const readinessScope = Object.freeze({
  schemaVersion: 1,
  statusBasis: mode === "live"
    ? "verified-feed-freshness-and-mounted-storage"
    : "simulated-feed-state",
  mountEvidenceRequired: mode === "live",
  releaseEligibility: "separate-smoke-data-calibration-backup-and-recovery-gates",
  cohortCoverageIncluded: false,
  calibrationIncluded: false,
  backupRecoveryIncluded: false
});
const publicDelivery = Object.freeze({
  schemaVersion: 1,
  snapshotEncoding: "gzip-when-accepted",
  browserRefresh: "coalesced-with-15-second-post-completion-cooldown",
  vaultExports: mode === "live" ? "disabled" : "local-demo-only"
});
const dbPath = path.resolve(root, process.env.DB_PATH || "data/pump-war-room.db");
const vaultPath = path.resolve(root, process.env.VAULT_PATH || "vault");
const startedAt = new Date().toISOString();
const runtimeTelemetry = createRuntimeTelemetry({ version: appVersion, mode, startedAt });
const configuredPublicBaseUrl = process.env.PUBLIC_BASE_URL;
const publicBaseUrl = typeof configuredPublicBaseUrl === "string" && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configuredPublicBaseUrl)
  ? configuredPublicBaseUrl
  : "https://pump-war-room-production.up.railway.app";
const publicMintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const rawSolanaIdentityText = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[1-9A-HJ-NP-Za-km-z]{64,88}|[1-9A-HJ-NP-Za-km-z]{32,44})(?=$|[^1-9A-HJ-NP-Za-km-z])/;
const rawSocialProfileText = /(?:^|[\s(])(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)]+)/i;
const MATERIAL_BASELINE_EVENT_KEY = "material-baseline-v1";
process.on("uncaughtExceptionMonitor", (error, origin) => runtimeTelemetry.error("process.uncaught_exception", error, { origin }));
const store = new Store(dbPath);
const actorRevisionPreparation = store.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
if (actorRevisionPreparation.changed) {
  runtimeTelemetry.info("early_actors.method_revision_prepared", actorRevisionPreparation);
}
const enforceActorRetention = () => {
  try { return store.pruneActorObservations({ now: new Date().toISOString(), maximum: 4096 }); }
  catch (error) {
    runtimeTelemetry.error("early_actors.retention_failed", error);
    return null;
  }
};
enforceActorRetention();
setInterval(enforceActorRetention, 60_000).unref();
const actorPrivacySecret = store.actorPrivacySecret();
const publicDisplayText = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && !rawSolanaIdentityText.test(normalized) && !rawSocialProfileText.test(normalized)
    ? normalized : null;
};
const publicToken = (token) => {
  const projected = projectPublicToken(token, { installationSecret: actorPrivacySecret });
  if (!projected) return projected;
  for (const key of ["name", "symbol", "narrative"]) {
    const sanitized = publicDisplayText(projected[key]);
    if (sanitized === null) delete projected[key];
    else projected[key] = sanitized;
  }
  return projected;
};
const publicCallout = (callout) => projectPublicCallout(callout, { installationSecret: actorPrivacySecret });
const identityCleanup = store.sanitizeLegacyCalloutProfiles(publicCallout);
const storage = observeStorage({
  databasePath: dbPath,
  canonicalDatabasePath: realpathSync(dbPath),
  mountInfo: (() => { try { return readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; } })()
});
const cleanup = mode === "live" ? store.purgeDemoData() : { tokens: 0, events: 0, alerts: 0 };
const clients = new Set();
const checkAgentRate = createRateLimiter({ limit: 20, windowMs: 60_000 });
let feedStatus = mode === "demo" ? "simulated" : "connecting";
let calloutStatus = process.env.BARK_API_KEY ? "connecting" : "disabled";
let lastEventAt = null;
let lastMintAt = null;
let identityProposalTimer = null;
let identityProposalLastRunAt = null;
let feedConnectedAt = null;
let feedLastMessageAt = null;
let feedLastActivityAt = null;
let feedLastErrorAt = null;
let lastLoggedFeedErrorAt = null;
let lastLoggedFeedStatus = null;
let reconnects = 0;
let feedMessages = 0;
let feedParseErrors = 0;
let pumpPortalIngestor = null;
let outcomeIngestor = null;
let riskIdentityIngestor = null;
let geckoTerminalClient = null;
let actorIngestor = null;
let solanaRpcClient = null;
let telegramDeliveryTimer = null;
let telegramDeliveryRunning = false;
let telegramLastAttemptAt = 0;
let briefBoundaryTimer = null;

const ACTOR_FAILURE_STATES = new Set(["rate-limited", "degraded", "invalid-response"]);

function persistedActorStatus(
  states = store.actorStates({ limit: ACTOR_COHORT_LIMIT }),
  summaries = store.actorSummaries(ACTOR_COHORT_LIMIT)
) {
  const statusCounts = Object.fromEntries(states.reduce((counts, state) => {
    counts.set(state.status, (counts.get(state.status) || 0) + 1);
    return counts;
  }, new Map()));
  const admittedCount = states.length;
  const evidenceMintCount = summaries.filter((summary) => summary.coverage?.eventCount > 0).length;
  const eligibleMintCount = summaries.filter((summary) => summary.coverage?.state === "available").length;
  const attemptedMintCount = states.filter((state) => state.attemptCount > 0).length;
  const failureStateCount = states.filter((state) => state.attemptCount > 0
    && ACTOR_FAILURE_STATES.has(state.status)).length;
  const pendingAttemptCount = states.filter((state) => state.nextAttemptAt !== null).length;
  const terminalCount = admittedCount - pendingAttemptCount;
  const terminalFailureCount = states.filter((state) => state.nextAttemptAt === null
    && ACTOR_FAILURE_STATES.has(state.status)).length;
  const acquisitionCoverage = admittedCount ? evidenceMintCount / admittedCount : null;
  return {
    schemaVersion: 1,
    source: SOLANA_MAINNET_RPC.id,
    parserRevision: SOLANA_ACTOR_PARSER_REVISION,
    status: mode === "live" ? "disabled" : "simulation-disabled",
    started: false,
    queueDepth: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    cohort: {
      limit: ACTOR_COHORT_LIMIT, admittedCount, evidenceMintCount, eligibleMintCount,
      attemptedMintCount, failureStateCount,
      failureRatio: attemptedMintCount ? failureStateCount / attemptedMintCount : null,
      pendingAttemptCount, terminalCount, terminalFailureCount, statusCounts
    },
    correlationGate: {
      status: "withheld",
      minimumEligibleMints: 20,
      minimumAcquisitionCoverage: 0.6,
      eligibleMintCount,
      acquisitionCoverage,
      labeledHoldoutCalibrationPassed: false,
      rankingImpact: "none",
      riskProbabilityImpact: "none",
      telegramAlertImpact: "none",
      recommendationImpact: "none"
    },
    counters: {
      admissions: 0, duplicates: 0, cohortFull: 0, replayTooOld: 0, attempts: 0,
      signaturesReturned: 0, transactionsRequested: 0, transactionsUnavailable: 0,
      transactionsRejected: 0, transactionRejectionReasons: {},
      observationsAccepted: 0, observationsDeduplicated: 0, failures: 0
    }
  };
}

function feedObservation() {
  const telemetry = pumpPortalIngestor?.getStatus?.() || null;
  const counters = {
    reconnects: telemetry?.counters?.reconnectsScheduled ?? reconnects,
    messages: telemetry?.counters?.messagesReceived ?? feedMessages,
    malformedMessages: telemetry?.counters?.malformedMessages ?? feedParseErrors
  };
  return {
    ...observeFeed({
      mode,
      feedStatus: telemetry?.status || feedStatus,
      lastMintAt: telemetry?.lastTokenAt || lastMintAt,
      lastActivityAt: telemetry?.lastActivityAt || feedLastActivityAt,
      lastMessageAt: telemetry?.lastMessageAt || feedLastMessageAt,
      lastEventAt,
      observedSince: telemetry?.lastConnectedAt || feedConnectedAt || startedAt,
      staleAfterMs: FEED_STALE_AFTER_MS
    }),
    counters,
    lastErrorAt: telemetry?.lastErrorAt || feedLastErrorAt
  };
}

function feedHealth() {
  return feedObservation().state;
}

function telegramHealth() {
  return { ...telegramAlertStatus(), outbox: store.telegramDeliveryCoverage() };
}

function identityRegistryHealth() {
  return {
    schemaVersion: 1,
    ...store.identityRegistryCoverage(),
    proposalMethod: "metadata-collision-proposals-v1",
    pendingProposalLimit: IDENTITY_PENDING_PROPOSAL_LIMIT,
    proposalLastRunAt: identityProposalLastRunAt,
    automatedVerification: false,
    publicWrites: false,
    primaryMeaning: "identity resolution only; not a safety, quality, or trade recommendation"
  };
}

function healthStatus(feed = feedObservation()) {
  if (mode === "live" && !storage.mountPointVerified) return "degraded";
  if (["live", "simulated"].includes(feed.state)) return "healthy";
  if (["connecting", "awaiting-data", "idle", "unknown"].includes(feed.state)) return "starting";
  return "degraded";
}

const send = (kind, payload) => {
  lastEventAt = new Date().toISOString();
  const chunk = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(chunk);
};

function radarScore(token) {
  if (!token) return null;
  const [entry] = createTop100([normalizePersistedLiveToken(token, { mode })], { mode });
  return typeof entry?.score === "number" && Number.isFinite(entry.score) ? entry.score : null;
}

function scheduleTelegramDelivery(delayMs = 0) {
  if (telegramAlertStatus().status !== "configured" || telegramDeliveryTimer !== null) return;
  telegramDeliveryTimer = setTimeout(() => {
    telegramDeliveryTimer = null;
    void processTelegramOutbox();
  }, Math.max(0, delayMs));
  telegramDeliveryTimer.unref?.();
}

async function processTelegramOutbox() {
  if (telegramDeliveryRunning || telegramAlertStatus().status !== "configured") return;
  const [alert] = store.dueTelegramAlerts({ limit: 1 });
  if (!alert) return;
  const throttleMs = Math.max(0, 1_000 - (Date.now() - telegramLastAttemptAt));
  if (throttleMs > 0) { scheduleTelegramDelivery(throttleMs); return; }
  telegramDeliveryRunning = true;
  const attemptedAt = new Date().toISOString();
  try {
    const result = await sendTelegramAlert(alert, {
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      baseUrl: publicBaseUrl
    });
    store.recordAlertTelegramAttempt(alert.id, "sent", { attemptedAt, messageId: result.messageId });
    runtimeTelemetry.info("telegram.alert_sent", { alertId: alert.id, kind: alert.kind, mint: alert.mint });
  } catch (error) {
    const attemptCount = Number(alert.telegramAttemptCount || 0) + 1;
    const retry = telegramRetryPlan(error, { attemptCount });
    if (retry.retry) {
      store.recordAlertTelegramAttempt(alert.id, "retrying", {
        attemptedAt,
        nextAttemptAt: retry.nextAttemptAt,
        errorCode: retry.errorCode
      });
      runtimeTelemetry.warn(retry.errorCode === "rate-limited" ? "telegram.rate_limited" : "telegram.retry_scheduled", {
        alertId: alert.id, kind: alert.kind, mint: alert.mint, errorCode: retry.errorCode, nextAttemptAt: retry.nextAttemptAt
      });
      scheduleTelegramDelivery(retry.delayMs);
    } else {
      try { store.recordAlertTelegramAttempt(alert.id, "dead-letter", { attemptedAt, errorCode: retry.errorCode }); } catch {}
      runtimeTelemetry.error("telegram.send_failed", error, {
        alertId: alert.id, kind: alert.kind, mint: alert.mint, errorCode: retry.errorCode, attempts: attemptCount
      });
    }
  } finally {
    telegramLastAttemptAt = Date.now();
    telegramDeliveryRunning = false;
    scheduleTelegramDelivery(1_000);
  }
}

function maybeSendTelegram(alert) {
  if (telegramAlertStatus().status !== "configured") return;
  scheduleTelegramDelivery();
}

function publicAlert(alert) {
  return {
    level: alert.level,
    title: alert.title,
    message: alert.message,
    mint: alert.mint,
    kind: alert.kind,
    evidenceClass: alert.evidenceClass,
    evidenceAt: alert.evidenceAt,
    createdAt: alert.createdAt
  };
}

function broadcastMaterialAlerts(savedAlerts) {
  for (const saved of savedAlerts) {
    send("alert", publicAlert(saved));
    send("material-change", { mint: saved.mint, kind: saved.kind, evidenceAt: saved.evidenceAt });
    maybeSendTelegram(saved);
  }
}

function priorRiskToken(token, events) {
  const byFactor = new Map();
  for (const event of events) {
    const factor = event?.payload?.factor;
    if (event?.kind === "risk-evidence" && typeof factor === "string" && !byFactor.has(factor)) byFactor.set(factor, event);
  }
  const envelope = (name, field) => {
    const event = byFactor.get(name);
    return event && typeof event.payload?.value === "number" && Number.isFinite(event.payload.value)
      ? { evidenceClass: event.evidenceClass, [field]: event.payload.value,
        providerUpdatedAt: event.occurredAt, fetchedAt: event.occurredAt, observedAt: event.occurredAt, calculatedAt: event.occurredAt }
      : { evidenceClass: "unavailable", [field]: null };
  };
  return {
    mint: token.mint,
    riskIdentity: { factors: {
      concentration: envelope("concentration", "top10Percentage"),
      developer: envelope("developer-holding", "holdingPercentage"),
      liquidity: envelope("pool-reserve", "liquidityUsd"),
      identity: envelope("identity-reuse", "exactDuplicateCount"),
      creatorHistory: envelope("creator-history", "observedLaunchCount")
    } }
  };
}

function evaluateRiskMateriality({ seedOnly = !store.hasIntelligenceEvent(MATERIAL_BASELINE_EVENT_KEY) } = {}) {
  if (mode !== "live") return;
  const riskStates = store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 120 });
  const baseTokens = riskStates.map(({ mint }) => store.token(mint)).filter((token) => token?.source === "pumpportal")
    .map((token) => normalizePersistedLiveToken(token, { mode }));
  const outcomeStates = baseTokens.map(({ mint }) => store.enrichmentState(mint)).filter(Boolean);
  const currentTokens = attachRiskIdentityEvidence(baseTokens, {
    mode,
    riskStates,
    outcomeStates,
    tokenEvidenceRows: baseTokens
  }).tokens;
  const intelligenceEvents = [];
  const materialAlerts = [];
  for (const current of currentTokens) {
    const existingEvents = store.eventsForMint(current.mint, 500);
    const previous = priorRiskToken(current, existingEvents);
    const previousRiskEvents = existingEvents.filter((event) => event.kind === "risk-evidence");
    const factorEvents = [
      {
        name: "concentration", factor: current.riskIdentity?.factors?.concentration,
        field: "top10Percentage", unit: "%", at: ["providerUpdatedAt", "fetchedAt"], evidenceClass: "provider-observed", source: "geckoterminal",
        limitation: "Provider-reported top-10 share; custody exclusions are unpublished and the factor is uncalibrated."
      },
      {
        name: "developer-holding", factor: current.riskIdentity?.factors?.developer,
        field: "holdingPercentage", unit: "%", at: ["fetchedAt"], evidenceClass: "provider-observed", source: "geckoterminal",
        limitation: "Provider-reported holding; developer identity is not independently verified and the factor is uncalibrated."
      },
      {
        name: "pool-reserve", factor: current.riskIdentity?.factors?.liquidity,
        field: "liquidityUsd", unit: " USD", at: ["observedAt"], evidenceClass: "provider-observed", source: "geckoterminal",
        limitation: "Provider-observed pool reserve; this is not locked-liquidity or launch-time evidence."
      },
      {
        name: "identity-reuse", factor: current.riskIdentity?.factors?.identity,
        field: "exactDuplicateCount", unit: " other mints", at: ["calculatedAt"], evidenceClass: "locally-derived", source: "locally-derived",
        limitation: "Exact declared-identifier reuse does not establish common control, fraud, maliciousness, or safety."
      },
      {
        name: "creator-history", factor: current.riskIdentity?.factors?.creatorHistory,
        field: "observedLaunchCount", unit: " observed launches", at: ["calculatedAt"], evidenceClass: "locally-derived", source: "locally-derived",
        limitation: "Fixed prospective cohort count; not complete or all-time creator history."
      }
    ];
    if (!seedOnly) materialAlerts.push(...detectMaterialAlerts({ current, previous: previousRiskEvents.length ? previous : null }));
    for (const candidate of factorEvents) {
      const value = candidate.factor?.[candidate.field];
      const occurredAt = candidate.at.map((key) => candidate.factor?.[key]).find((item) => Number.isFinite(Date.parse(item)));
      if (candidate.factor?.evidenceClass !== candidate.evidenceClass || typeof value !== "number" || !Number.isFinite(value) || !occurredAt) continue;
      const previousEvent = previousRiskEvents.find((event) => event.payload?.factor === candidate.name);
      if (previousEvent?.payload?.value === value) continue;
      const normalizedAt = new Date(Date.parse(occurredAt)).toISOString();
      intelligenceEvents.push({
        kind: "risk-evidence",
        mint: current.mint,
        eventKey: `risk-evidence-v1:${candidate.name}:${current.mint}:${value}:${normalizedAt}`,
        evidenceClass: candidate.evidenceClass,
        occurredAt: normalizedAt,
        payload: { mint: current.mint, factor: candidate.name, value, unit: candidate.unit, source: candidate.source, limitation: candidate.limitation }
      });
    }
  }
  if (seedOnly) {
    const initializedAt = new Date().toISOString();
    intelligenceEvents.push({
      kind: "material-baseline",
      mint: "system",
      eventKey: MATERIAL_BASELINE_EVENT_KEY,
      evidenceClass: "locally-derived",
      occurredAt: initializedAt,
      payload: {
        mint: "system",
        factor: "baseline",
        value: "initialized",
        unit: null,
        source: "locally-derived",
        limitation: "Existing retained factor state was seeded without manufacturing historical material-change alerts."
      }
    });
  }
  const committed = store.commitIntelligenceBatch({
    events: intelligenceEvents,
    alerts: materialAlerts,
    queueTelegram: telegramAlertStatus().status === "configured"
  });
  broadcastMaterialAlerts(committed.alerts);
  return committed;
}

function upsert(token) {
  const previous = store.token(token.mint);
  const candidates = mode === "live" ? detectMaterialAlerts({
    current: normalizePersistedLiveToken(token, { mode }),
    previous: previous ? normalizePersistedLiveToken(previous, { mode }) : null,
    currentScore: radarScore(token),
    previousScore: radarScore(previous)
  }) : [];
  const committed = store.upsertTokenWithAlerts(token, {
    eventKind: previous ? "update" : "mint",
    alerts: candidates,
    queueTelegram: telegramAlertStatus().status === "configured"
  });
  outcomeIngestor?.enqueue(token);
  const priorRiskState = riskIdentityIngestor ? store.riskIdentityState(token.mint) : null;
  riskIdentityIngestor?.enqueue(token);
  if (!previous) actorIngestor?.admit(token);
  if (!priorRiskState && riskIdentityIngestor && store.riskIdentityState(token.mint)) {
    try { evaluateRiskMateriality(); }
    catch (error) { runtimeTelemetry.error("alerts.risk_admission_evaluation_failed", error, { mint: token.mint }); }
  }
  broadcastMaterialAlerts(committed.alerts);
  scheduleIdentityProposalRefresh();
  send(previous ? "token-update" : "new-token", publicToken(token));
}

function addCallout(callout) {
  const sanitized = publicCallout(callout);
  store.upsertCallout({ ...sanitized, externalId: callout.externalId });
  store.addEvent("callout", sanitized);
  send("callout", sanitized);
}

function normalizeLiveToken(token) {
  return normalizePersistedLiveToken(token, { mode });
}

function scheduleIdentityProposalRefresh(delayMs = 15_000) {
  if (identityProposalTimer !== null) return;
  identityProposalTimer = setTimeout(() => {
    identityProposalTimer = null;
    try {
      const proposals = proposeIdentityCandidates(store.tokens(100).map(publicToken).filter(Boolean));
      const result = store.upsertIdentityProposals(proposals);
      identityProposalLastRunAt = result.observedAt;
      runtimeTelemetry.info("identity.proposals_refreshed", result);
    } catch (error) {
      runtimeTelemetry.error("identity.proposals_failed", error);
    }
  }, Math.max(0, delayMs));
  identityProposalTimer.unref?.();
}

function resolveCanonicalIdentity(mint, token = null) {
  const stored = store.identityRegistrySnapshot();
  const resolution = new CanonicalRegistry(stored).resolveMint(mint, { token });
  const proposals = store.identityProposals({ status: "pending", limit: 500 })
    .filter((proposal) => proposal.fromMint === mint || proposal.toMint === mint)
    .map((proposal) => ({
      proposalKey: proposal.proposalKey,
      fromMint: proposal.fromMint,
      toMint: proposal.toMint,
      kind: proposal.kind,
      reviewState: "proposed",
      evidenceClass: proposal.evidenceClass,
      methodVersion: proposal.methodVersion,
      observedAt: proposal.updatedAt
    }));
  return { ...resolution, proposals };
}

function snapshot() {
  const generatedAt = new Date().toISOString();
  const callouts = store.callouts(200);
  const calloutCounts = callouts.reduce((counts, callout) => counts.set(callout.mint, (counts.get(callout.mint) || 0) + 1), new Map());
  const latestTokens = store.tokens(120)
    .filter((token) => mode !== "live" || token.source === "pumpportal")
    .map(normalizeLiveToken)
    .map((token) => ({ ...token, calloutCount: calloutCounts.get(token.mint) || 0 }))
    .sort((a, b) => b.momentum - a.momentum);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const fifteen = new Date(Date.now() - 900_000).toISOString();
  const enrichmentStates = store.enrichmentStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
  const enrichmentByMint = new Map(enrichmentStates
    .map((state) => [state.mint, state]));
  const riskIdentityStates = store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
  const riskCohortTokens = mode === "demo" ? latestTokens : riskIdentityStates
    .map(({ mint }) => normalizeLiveToken(store.token(mint)))
    .filter((token) => token?.source === "pumpportal");
  const combinedTokens = new Map(latestTokens.map((token) => [token.mint, token]));
  for (const token of riskCohortTokens) {
    if (!combinedTokens.has(token.mint)) combinedTokens.set(token.mint, {
      ...token,
      calloutCount: calloutCounts.get(token.mint) || 0
    });
  }
  let tokens = [...combinedTokens.values()];
  const riskView = attachRiskIdentityEvidence(tokens, {
    mode,
    riskStates: riskIdentityStates,
    outcomeStates: enrichmentStates,
    tokenEvidenceRows: riskCohortTokens,
    generatedAt
  });
  tokens = riskView.tokens;
  const latestMints = new Set(latestTokens.map(({ mint }) => mint));
  const latestEnrichedTokens = tokens.filter((token) => latestMints.has(token.mint));
  const riskCohortView = attachRiskIdentityEvidence(riskCohortTokens, {
    mode,
    riskStates: riskIdentityStates,
    outcomeStates: enrichmentStates,
    tokenEvidenceRows: riskCohortTokens,
    generatedAt
  });
  const narratives = Object.values(latestEnrichedTokens.reduce((acc, token) => {
    const narrative = publicDisplayText(token.narrative) || "Unclassified";
    const row = acc[narrative] ||= {
      name: narrative, coins: 0, volume: null, volumeEvidenceCount: 0,
      momentum: null, momentumEvidenceCount: 0
    };
    row.coins++;
    if (typeof token.volume5m === "number" && Number.isFinite(token.volume5m) && token.volume5m >= 0) {
      row.volume = (row.volume ?? 0) + token.volume5m;
      row.volumeEvidenceCount++;
    }
    if (typeof token.momentum === "number" && Number.isFinite(token.momentum) && token.momentum >= 0) {
      row.momentum = (row.momentum ?? 0) + token.momentum;
      row.momentumEvidenceCount++;
    }
    return acc;
  }, {})).map((row) => ({
    ...row,
    momentum: row.momentumEvidenceCount ? Math.round(row.momentum / row.momentumEvidenceCount) : null
  })).sort((a, b) => b.volumeEvidenceCount - a.volumeEvidenceCount
    || (b.volume ?? 0) - (a.volume ?? 0) || b.coins - a.coins || a.name.localeCompare(b.name));
  const outcomesByMint = new Map(tokens.flatMap((token) => {
    const enrichment = enrichmentByMint.get(token.mint);
    return enrichment ? [[token.mint, enrichment]] : [];
  }));
  const top100 = createTop100(latestEnrichedTokens, { mode, outcomesByMint })
    .map((entry) => ({ ...entry, token: publicToken(entry.token) }));
  const cohortEntries = enrichmentStates.flatMap((enrichment) => {
    const token = normalizeLiveToken(store.token(enrichment.mint));
    if (!token || token.source !== "pumpportal") return [];
    const launchAt = Number.isFinite(Date.parse(token.createdAt)) ? new Date(Date.parse(token.createdAt)).toISOString() : generatedAt;
    let outcome;
    try { outcome = validateProviderObservedOutcome(enrichment.evidence?.outcome, { requireProspectiveSelection: true }); }
    catch { outcome = unavailableProviderOutcome({ launchAt, asOf: generatedAt, state: enrichment }); }
    return [{
      outcome,
      narrative: token.narrative || "Unclassified",
      lifecycle: token.status === "graduated" ? "Graduation status (unverified)" : token.status === "migration-observed" ? "Migration feed-observed" : "Bonding / observed"
    }];
  });
  const cohortOutcomes = cohortEntries.map(({ outcome }) => outcome);
  const outcomeSummary = summarizeVerifiedOutcomes(cohortOutcomes);
  const narrativeCohorts = aggregateOutcomeCohorts(cohortEntries.map(({ narrative, outcome }) => ({ cohort: narrative, outcome })));
  const lifecycleCohorts = aggregateOutcomeCohorts(cohortEntries.map(({ lifecycle, outcome }) => ({ cohort: lifecycle, outcome })));
  const observedOutcomeCount = cohortOutcomes.filter((outcome) => Object.values(outcome.windows || {}).some((window) => window.status === "observed")).length;
  const persistedOutcomeCoverage = store.outcomeCoverage({ provider: GECKOTERMINAL_PROVIDER.id });
  const feed = feedObservation();
  const source = mode === "live" ? "pumpportal" : null;
  const countSince = (iso) => source ? store.countSinceBySource(iso, source) : store.countSince(iso);
  const measuredBrief = (period) => {
    const durationMs = period === "daily" ? 86_400_000 : 7 * 86_400_000;
    const cutoff = new Date(generatedAt);
    const todayUtc = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate());
    const periodEndMs = period === "daily" ? todayUtc
      : todayUtc - ((cutoff.getUTCDay() + 6) % 7) * 86_400_000;
    const periodEnd = new Date(periodEndMs).toISOString();
    const periodStart = new Date(periodEndMs - durationMs).toISOString();
    const existing = store.briefRun(period);
    if (existing?.methodVersion === CLOSED_BRIEF_METHOD_VERSION
      && existing.periodStart === periodStart && existing.periodEnd === periodEnd) return existing.model;
    const activity = store.periodActivity({
      start: periodStart,
      end: periodEnd,
      source: mode === "live" ? "pumpportal" : "demo"
    });
    const priorActivity = store.periodActivity({
      start: new Date(periodEndMs - 2 * durationMs).toISOString(),
      end: periodStart,
      source: mode === "live" ? "pumpportal" : "demo"
    });
    const model = buildMeasuredBrief({
      period,
      now: generatedAt,
      windowStart: periodStart,
      windowEnd: periodEnd,
      activity,
      priorActivity,
      outcomes: cohortOutcomes
    });
    return store.saveBriefRun({
      briefKey: model.briefId,
      kind: period,
      periodStart,
      periodEnd,
      timezone: "UTC",
      methodVersion: model.methodVersion,
      provider: GECKOTERMINAL_PROVIDER.id,
      dataCutoff: generatedAt,
      model
    }).run.model;
  };
  const actionIntelligence = {
    schemaVersion: 1,
    generatedAt,
    watchlists: {
      persistence: "browser-local",
      maximumMints: 50,
      sharedServerWatchlist: false,
      reason: "No account or authentication boundary exists; preferences stay in the operator's browser."
    },
    alerts: {
      schemaVersion: 1,
      supportedKinds: [
        "score-rise", "score-drop", "risk-concentration", "risk-developer-holding",
        "risk-identity-reuse", "risk-creator-history", "migration-observed"
      ],
      deduplicatedPersistently: true,
      persistence: "atomic-event-alert-outbox-with-durable-baseline",
      publicDeliveryMetadata: "aggregate-only",
      scoreChangeThreshold: 15,
      riskFactorsAreUncalibrated: true,
      telegram: telegramHealth()
    },
    timelines: { endpoint: "/api/coins/{mint}/timeline", defaultEntries: 50, maximumEntries: 200, cursorPagination: true, rawProviderPayloadsIncluded: false },
    compare: { endpoint: "/api/compare?mints={mint},{mint}", minimumMints: 2, maximumMints: 4 },
    briefs: { daily: measuredBrief("daily"), weekly: measuredBrief("weekly") }
  };
  const actorStates = store.actorStates({ limit: ACTOR_COHORT_LIMIT });
  const actorSummaries = store.actorSummaries(ACTOR_COHORT_LIMIT);
  const actorSummaryByMint = new Map(actorSummaries.map((summary) => [summary.mint, summary]));
  const actorStatus = actorIngestor?.getStatus() || persistedActorStatus(actorStates, actorSummaries);
  const earlyActorIntelligence = {
    schemaVersion: 1,
    generatedAt,
    source: {
      id: SOLANA_MAINNET_RPC.id,
      parserRevision: SOLANA_ACTOR_PARSER_REVISION,
      evidenceClass: "on-chain-finalized",
      endpointClass: "documented-rate-limited-public-rpc",
      attributionUrl: SOLANA_MAINNET_RPC.attributionUrl,
      pumpProgramDocs: "https://github.com/pump-fun/pump-public-docs",
      scope: `getSignaturesForAddress newest ${ACTOR_SIGNATURE_LIMIT}; earliest ${ACTOR_TRANSACTION_LIMIT} in-window candidates inspected`,
      completeness: "partial-and-unmeasured",
      productionSuitability: "best-effort public endpoint; failures and rate limits remain explicit"
    },
    engine: actorStatus,
    sampling: {
      policy: "prospective-fixed-admission-v1",
      cohortLimit: ACTOR_COHORT_LIMIT,
      earlyWindowSeconds: ACTOR_EARLY_WINDOW_MS / 1_000,
      attemptsAtSeconds: [120, 600, 1800],
      signaturePageLimit: ACTOR_SIGNATURE_LIMIT,
      transactionLimitPerAttempt: ACTOR_TRANSACTION_LIMIT,
      rawSourcePayloadsPersisted: false,
      rawWalletsPersisted: false,
      rawTransactionIdsPersisted: false,
      normalizedObservationRetentionSeconds: ACTOR_RAW_RETENTION_MS / 1_000,
      aggregateSummariesPersisted: true
    },
    cohort: {
      admittedCount: actorStates.length,
      limit: ACTOR_COHORT_LIMIT,
      observations: actorStates.map((actorState) => {
        const token = publicToken(store.token(actorState.mint));
        return {
          mint: actorState.mint,
          name: token?.name || "Unnamed mint",
          symbol: token?.symbol || "???",
          launchObservedAt: actorState.launchObservedAt,
          acquisition: {
            status: actorState.status,
            attemptCount: actorState.attemptCount,
            lastAttemptAt: actorState.lastAttemptAt,
            nextAttemptAt: actorState.nextAttemptAt,
            lastSuccessAt: actorState.lastSuccessAt,
            missingReason: actorState.missingReason,
            errorCode: actorState.errorCode
          },
          summary: actorSummaryByMint.get(actorState.mint) || null
        };
      })
    },
    privacy: {
      labels: "per-installation keyed Actor numbers",
      rawWalletsPublic: false,
      rawProfilesPublic: false,
      actorLookupEndpoint: false,
      hiddenMappingMaterialPublic: false
    },
    downstream: actorStatus.correlationGate,
    disclaimer: "Bounded finalized observations are partial, can miss transactions, and describe activity only. They do not establish identity, coordination, automation, intent, skill, safety, or a trade signal."
  };
  return {
    version: appVersion, generatedAt, mode, status: healthStatus(feed), service: runtimeTelemetry.service(), storage,
    telemetry: runtimeTelemetry.snapshot(), readinessScope, publicDelivery, identityRegistry: identityRegistryHealth(),
    feedStatus, feedHealth: feed.state, feed, calloutStatus, lastEventAt, lastMintAt,
    liveMintCount: mode === "live" ? store.countBySource("pumpportal").tokens : 0,
    demoPurged: mode === "live", demoPurgedCount: cleanup.tokens,
    reconnects: feed.counters.reconnects, feedMessages: feed.counters.messages, feedParseErrors: feed.counters.malformedMessages,
    stats: {
      indexed: source ? store.countBySource(source).tokens : store.count(),
      mintedToday: countSince(start.toISOString()),
      lastHour: countSince(hour),
      last15m: countSince(fifteen),
      graduations: tokens.filter((t) => t.status === "graduated").length,
      migrationsObserved: tokens.filter((t) => ["migration-observed", "graduated"].includes(t.status)).length,
      calloutsLastHour: store.calloutCountSince(hour)
    },
    tokens: tokens.map(publicToken),
    leaderboard: {
      schemaVersion: 2,
      mode,
      generatedAt,
      sourceObservedAt: lastMintAt,
      freshness: feed.state,
      source: mode === "live" ? "pumpportal" : "demo",
      universe: mode === "live" ? "Pump.fun tokens observed by this service" : "simulated tokens observed by this service",
      scope: mode === "live" ? "observed-by-this-war-room" : "simulated-feed",
      rankingBasis: "numeric evidence score uses observed momentum, buyer breadth, and freshness only when a substantive input exists; otherwise score is withheld and observations are ordered by recency; uncalibrated risk factors do not affect rank",
      ranking: {
        metric: "evidence_score_or_recency_v2",
        scorePolicy: "withheld-without-substantive-input",
        fallbackOrder: "observation-recency",
        eligibilityVersion: "observed_feed_v1",
        eligibleCount: top100.length,
        limit: 100
      },
      outcomeTracking: "Returns use GeckoTerminal-observed completed pool candles; missing targets remain unavailable.",
      top100
    },
    outcomes: {
      schemaVersion: 1,
      generatedAt,
      revisionPolicy: OUTCOME_REVISION_POLICY,
      source: {
        id: GECKOTERMINAL_PROVIDER.id,
        label: "GeckoTerminal-observed pool OHLCV",
        apiVersion: GECKOTERMINAL_PROVIDER.apiVersion,
        intervalSeconds: GECKOTERMINAL_PROVIDER.intervalSeconds,
        attributionUrl: GECKOTERMINAL_PROVIDER.attributionUrl,
        poweredByUrl: "https://www.coingecko.com/",
        publicBeta: true,
        rawResponsesPersisted: false,
        rawCandlesPersisted: false,
        providerOhlcvValuesPersisted: false,
        retention: "derived metrics and minimal provenance only"
      },
      engine: outcomeIngestor?.getStatus() || { schemaVersion: 1, source: GECKOTERMINAL_PROVIDER.id, status: mode === "live" ? "disabled" : "simulation-disabled", queueDepth: 0 },
      coverage: {
        ...persistedOutcomeCoverage,
        total: cohortOutcomes.length,
        withObservedWindows: observedOutcomeCount
      },
      sampling: {
        policy: "prospective-fixed-admission-v1",
        cohortLimit: 120,
        selectionDeadlineSeconds: 120,
        poolDiscoveryScope: "GeckoTerminal contemporaneously ranked page=1 only; earliest-created eligible returned pool",
        selectionPriority: "unselected launches before candle retrieval",
        universe: "PumpPortal launches observed after the outcome engine was active; admitted in observation order until the fixed cohort is full",
        exclusionsRemainMissing: true
      },
      summary: outcomeSummary,
      cohorts: { narrative: narrativeCohorts, lifecycle: lifecycleCohorts },
      disclaimer: "Provider-observed on-chain pool data can be delayed, incomplete, revised, or manipulated; outcomes are descriptive research, not price guarantees or financial advice."
    },
    riskIntelligence: {
      schemaVersion: 1,
      generatedAt,
      evidenceClasses: [...RISK_IDENTITY_EVIDENCE_CLASSES],
      rankingImpact: "none-uncalibrated",
      source: {
        id: GECKOTERMINAL_PROVIDER.id,
        label: "GeckoTerminal token-info provider observations",
        apiVersion: GECKOTERMINAL_PROVIDER.apiVersion,
        parserRevision: RISK_IDENTITY_PARSER_REVISION,
        fingerprintMethodVersion: RISK_IDENTITY_METHOD_VERSION,
        endpoint: "/networks/solana/tokens/{mint}/info",
        attributionUrl: GECKOTERMINAL_PROVIDER.attributionUrl,
        poweredByUrl: "https://www.coingecko.com/",
        publicBeta: true,
        unvetted: true,
        rawResponsesPersisted: false,
        rawProfilesPersisted: false,
        retention: "allowlisted scalars, exact-match digests, and minimal provenance only"
      },
      engine: riskIdentityIngestor?.getStatus() || {
        schemaVersion: 1,
        source: GECKOTERMINAL_PROVIDER.id,
        status: mode === "live" ? "disabled" : "simulation-disabled",
        queueDepth: 0
      },
      coverage: {
        ...store.riskIdentityCoverage({ provider: GECKOTERMINAL_PROVIDER.id }),
        ...riskCohortView.aggregateCoverage
      },
      cohort: {
        policy: "risk-specific-prospective-fixed-admission-v1",
        limit: 120,
        admittedCount: mode === "demo" ? riskCohortTokens.length : riskIdentityStates.length,
        universe: mode === "demo" ? "Synthetic demonstration cohort"
          : "PumpPortal launches admitted by the v0.7 risk worker while active; independent from the v0.6 outcome cohort",
        observations: riskCohortView.tokens.map((token) => {
          const projected = publicToken(token);
          return {
            mint: projected.mint,
            name: projected.name || "Unnamed mint",
            symbol: projected.symbol || "???",
            createdAt: projected.createdAt,
            riskIdentity: projected.riskIdentity
          };
        })
      },
      summary: riskCohortView.summary,
      disclaimer: "Provider and feed observations can be incomplete, delayed, or wrong. Exact declared-identifier or registrable-domain reuse does not establish duplicate content, common control, maliciousness, safety, or a probability of harm."
    },
    actionIntelligence, earlyActorIntelligence,
    narratives, callouts: callouts.slice(0, 30).map(publicCallout), alerts: store.alerts(40).map(publicAlert)
  };
}

function coinDossier(mint, currentSnapshot) {
  const storedToken = store.token(mint);
  if (!storedToken) return null;
  let token = currentSnapshot.tokens.find((candidate) => candidate.mint === mint) || null;
  if (!token) {
    const baseToken = normalizePersistedLiveToken(storedToken, { mode });
    const riskStates = store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    const riskTokens = riskStates.map(({ mint: riskMint }) => store.token(riskMint))
      .filter((candidate) => candidate?.source === "pumpportal")
      .map((candidate) => normalizePersistedLiveToken(candidate, { mode }));
    const outcomeStates = store.enrichmentStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 200 });
    token = attachRiskIdentityEvidence([baseToken], {
      mode,
      riskStates,
      outcomeStates,
      tokenEvidenceRows: riskTokens,
      generatedAt: currentSnapshot.generatedAt
    }).tokens[0];
  }
  const enrichment = store.enrichmentState(mint);
  const [entry] = createTop100([publicToken(token)], {
    mode,
    outcomesByMint: enrichment ? new Map([[mint, enrichment]]) : null
  });
  if (!entry) return null;
  return {
    schemaVersion: 1,
    generatedAt: currentSnapshot.generatedAt,
    token: entry.token,
    radar: {
      score: entry.score,
      orderingBasis: entry.orderingBasis,
      reasons: entry.reasons,
      freshness: entry.freshness,
      riskConfidence: entry.riskConfidence
    },
    outcome: entry.outcome,
    earlyActor: store.actorSummary(mint),
    identity: resolveCanonicalIdentity(mint, entry.token),
    timeline: `/api/coins/${mint}/timeline`,
    scope: "bounded observations retained by this deployment; not a complete market or on-chain dossier",
    disclaimer: "Observational research only; missing evidence stays unavailable and nothing here is financial advice."
  };
}

function comparisonEntry(dossier) {
  return {
    token: dossier.token,
    score: dossier.radar.score,
    orderingBasis: dossier.radar.orderingBasis,
    reasons: dossier.radar.reasons,
    freshness: dossier.radar.freshness,
    riskConfidence: dossier.radar.riskConfidence,
    outcome: dossier.outcome
  };
}

function scheduleBriefBoundary() {
  if (briefBoundaryTimer !== null) return;
  const now = new Date();
  const nextBoundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
  briefBoundaryTimer = setTimeout(() => {
    briefBoundaryTimer = null;
    try { snapshot(); }
    catch (error) { runtimeTelemetry.error("briefs.generation_failed", error); }
    scheduleBriefBoundary();
  }, Math.max(1_000, nextBoundary - Date.now()));
  briefBoundaryTimer.unref?.();
}

if (mode === "live" && (process.env.OUTCOME_ENRICHMENT !== "false" || process.env.RISK_IDENTITY_ENRICHMENT !== "false")) {
  geckoTerminalClient = new GeckoTerminalClient({
    userAgent: `PumpWarRoom/${appVersion} (+https://pump-war-room-production.up.railway.app)`
  });
}

if (mode === "live" && process.env.OUTCOME_ENRICHMENT !== "false") {
  outcomeIngestor = new VerifiedOutcomeIngestor({
    store,
    client: geckoTerminalClient,
    onStatus: (status, telemetry = {}) => {
      const details = { status, mint: telemetry.mint, errorCode: telemetry.errorCode, nextAttemptAt: telemetry.nextAttemptAt };
      if (["degraded", "rate-limited"].includes(status)) runtimeTelemetry.warn("outcomes.status", details);
      else if (["pool-selected", "observing", "complete"].includes(status)) runtimeTelemetry.info("outcomes.status", { ...details, observations: telemetry.observations, rejected: telemetry.rejected });
    }
  });
  outcomeIngestor.start(store.dueEnrichmentTokens({
    provider: GECKOTERMINAL_PROVIDER.id,
    now: new Date().toISOString(),
    limit: 120
  }));
  setInterval(() => {
    for (const token of store.dueEnrichmentTokens({
      provider: GECKOTERMINAL_PROVIDER.id,
      now: new Date().toISOString(),
      limit: 120
    })) outcomeIngestor.enqueue(token);
  }, 60_000).unref();
}

if (mode === "live" && process.env.RISK_IDENTITY_ENRICHMENT !== "false") {
  evaluateRiskMateriality();
  riskIdentityIngestor = new RiskIdentityIngestor({
    store,
    client: geckoTerminalClient,
    onStatus: (status, telemetry = {}) => {
      const details = { status, mint: telemetry.mint, errorCode: telemetry.errorCode, nextAttemptAt: telemetry.nextAttemptAt };
      if (telemetry.error) runtimeTelemetry.error("risk_identity.worker_failed", telemetry.error, details);
      else if (["degraded", "rate-limited", "invalid-response"].includes(status)) runtimeTelemetry.warn("risk_identity.status", details);
      else if (["available", "unavailable"].includes(status)) runtimeTelemetry.info("risk_identity.status", details);
      if (status === "available" && telemetry.mint) {
        try { evaluateRiskMateriality(); }
        catch (error) { runtimeTelemetry.error("alerts.risk_evaluation_failed", error, details); }
      }
    }
  });
  const cohortTokens = store.riskIdentityStates({ provider: GECKOTERMINAL_PROVIDER.id, limit: 120 })
    .map(({ mint }) => store.token(mint))
    .filter((token) => token?.source === "pumpportal");
  riskIdentityIngestor.start(cohortTokens);
  setInterval(() => {
    for (const token of store.dueRiskIdentityTokens({
      provider: GECKOTERMINAL_PROVIDER.id,
      now: new Date().toISOString(),
      limit: 120
    })) riskIdentityIngestor.enqueue(token);
  }, 60_000).unref();
  setInterval(() => {
    try { evaluateRiskMateriality(); }
    catch (error) { runtimeTelemetry.error("alerts.risk_recovery_evaluation_failed", error); }
  }, 300_000).unref();
}

if (mode === "live" && process.env.EARLY_ACTOR_ENRICHMENT !== "false") {
  solanaRpcClient = new SolanaRpcClient({ endpoint: SOLANA_MAINNET_RPC.endpoint });
  actorIngestor = new EarlyActorIngestor({
    store,
    client: solanaRpcClient,
    onStatus: (status, telemetry = {}) => {
      const details = { status, mint: telemetry.mint, errorCode: telemetry.errorCode, coverageState: telemetry.coverageState };
      if (telemetry.error) runtimeTelemetry.error("early_actors.worker_failed", telemetry.error, details);
      else if (["degraded", "rate-limited", "invalid-response"].includes(status)) runtimeTelemetry.warn("early_actors.status", details);
      else if (["observing", "complete"].includes(status)) runtimeTelemetry.info("early_actors.status", details);
    }
  });
  actorIngestor.start();
  void actorIngestor.drainDue().catch((error) => runtimeTelemetry.error("early_actors.drain_failed", error));
  setInterval(() => {
    void actorIngestor.drainDue().catch((error) => runtimeTelemetry.error("early_actors.drain_failed", error));
  }, 15_000).unref();
}

if (process.env.BARK_API_KEY) {
  const calloutIngestor = new BarkCalloutIngestor({
    url: process.env.BARK_URL || "wss://news.bark.gg/ws",
    apiKey: process.env.BARK_API_KEY,
    onCallout: addCallout,
    onStatus: (status, telemetry = {}) => {
      calloutStatus = status;
      if (telemetry.error) runtimeTelemetry.error("callout.ingest_error", telemetry.error, { status, reason: telemetry.reason });
      else if (["error", "failed", "degraded", "reconnecting"].includes(String(status).toLowerCase())) runtimeTelemetry.warn("callout.status", { status, reason: telemetry.reason });
      send("status", { calloutStatus });
    }
  });
  calloutIngestor.connect();
}

if (mode === "demo") {
  if (store.count() === 0) Array.from({ length: 12 }, (_, i) => upsert(createDemoToken(i, i * 3)));
  setInterval(() => {
    const tokens = store.tokens(50);
    if (Math.random() > 0.55) upsert(createDemoToken(Math.floor(Math.random() * 12)));
    for (const token of tokens.sort(() => Math.random() - 0.5).slice(0, 4)) upsert(tickDemoToken(token));
  }, 2_500).unref();
} else {
  const ingestor = new PumpPortalIngestor({
    url: process.env.PUMPPORTAL_URL || "wss://pumpportal.fun/api/data",
    watchTrades: false,
    onToken: (token) => {
      lastMintAt = token.createdAt || new Date().toISOString();
      feedLastMessageAt = lastMintAt;
      feedLastActivityAt = lastMintAt;
      upsert(token);
    },
    onMigration: ({ mint, observedAt, raw }) => {
      feedLastActivityAt = observedAt || new Date().toISOString();
      feedLastMessageAt = feedLastActivityAt;
      const token = store.token(mint);
      if (token) upsert({
        ...token,
        status: "migration-observed",
        migrationEvidence: {
          evidenceClass: "feed-observed-processed",
          source: "pumpportal",
          observedAt: observedAt || new Date().toISOString(),
          pool: typeof raw?.pool === "string" ? raw.pool : null,
          limitation: "Feed observation is processed-commitment evidence, not independently finalized migration proof."
        }
      });
    },
    onStatus: (status, telemetry = {}) => {
      feedStatus = status;
      feedConnectedAt = telemetry.lastConnectedAt || feedConnectedAt;
      feedLastMessageAt = telemetry.lastMessageAt || feedLastMessageAt;
      feedLastActivityAt = telemetry.lastActivityAt || feedLastActivityAt;
      feedLastErrorAt = telemetry.lastErrorAt || feedLastErrorAt;
      reconnects = telemetry.counters?.reconnectsScheduled ?? telemetry.reconnects ?? reconnects;
      feedMessages = telemetry.counters?.messagesReceived ?? telemetry.messages ?? feedMessages;
      feedParseErrors = telemetry.counters?.malformedMessages ?? telemetry.parseErrors ?? feedParseErrors;
      if (telemetry.lastErrorAt && telemetry.lastErrorAt !== lastLoggedFeedErrorAt) {
        lastLoggedFeedErrorAt = telemetry.lastErrorAt;
        runtimeTelemetry.error("feed.ingest_error", new Error(telemetry.lastError || "Feed ingest error"), { status, reason: telemetry.reason });
      } else if (status !== lastLoggedFeedStatus) {
        const method = ["degraded", "error", "failed", "reconnecting"].includes(status) ? "warn" : "info";
        runtimeTelemetry[method]("feed.status", { status, reason: telemetry.reason, connectionStatus: telemetry.connectionStatus });
      }
      lastLoggedFeedStatus = status;
      const feed = feedObservation();
      send("status", { feedStatus, feedHealth: feed.state, feed, reconnects, feedMessages, feedParseErrors });
    }
  });
  pumpPortalIngestor = ingestor;
  ingestor.connect();
}

if (telegramAlertStatus().status === "configured") {
  scheduleTelegramDelivery(1_000);
  setInterval(() => scheduleTelegramDelivery(), 30_000).unref();
}

snapshot();
scheduleIdentityProposalRefresh(0);
scheduleBriefBoundary();

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  res.once("finish", () => runtimeTelemetry.recordResponse(res.statusCode, {
    readiness: req.url?.split("?")[0] === "/api/health"
  }));
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      const feed = feedObservation();
      const status = healthStatus(feed);
      return json(res, status === "healthy" ? 200 : 503, {
      ok: status === "healthy", status, version: appVersion, mode, requestId,
      service: runtimeTelemetry.service(), storage, feed, telemetry: runtimeTelemetry.snapshot(), readinessScope, publicDelivery,
      feedStatus, feedHealth: feed.state, calloutStatus,
      lastEventAt, lastMintAt,
      indexed: mode === "live" ? store.countBySource("pumpportal").tokens : store.count(),
      liveMintCount: mode === "live" ? store.countBySource("pumpportal").tokens : 0,
      demoPurged: mode === "live", demoPurgedCount: cleanup.tokens,
      reconnects: feed.counters.reconnects, feedMessages: feed.counters.messages, feedParseErrors: feed.counters.malformedMessages,
      analyst: { status: "ready", engine: "local-grounded-v1" },
      outcomes: outcomeIngestor?.getStatus() || { schemaVersion: 1, source: GECKOTERMINAL_PROVIDER.id, status: mode === "live" ? "disabled" : "simulation-disabled", queueDepth: 0 },
      outcomeCoverage: store.outcomeCoverage({ provider: GECKOTERMINAL_PROVIDER.id }),
      riskIntelligence: riskIdentityIngestor?.getStatus() || { schemaVersion: 1, source: GECKOTERMINAL_PROVIDER.id, status: mode === "live" ? "disabled" : "simulation-disabled", queueDepth: 0 },
      riskIdentityCoverage: store.riskIdentityCoverage({ provider: GECKOTERMINAL_PROVIDER.id }),
      actionIntelligence: {
        schemaVersion: 1,
        watchlistPersistence: "browser-local",
        alertDedupe: "persistent",
        materialPersistence: "atomic-with-durable-baseline",
        telegram: telegramHealth()
      },
      earlyActors: actorIngestor?.getStatus() || persistedActorStatus(),
      identityRegistry: identityRegistryHealth()
    });
    }
    if (url.pathname === "/api/snapshot") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      return json(res, 200, snapshot());
    }
    if (url.pathname === "/api/v1/entities/resolve") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      if ([...url.searchParams.keys()].some((key) => key !== "mint") || url.searchParams.getAll("mint").length !== 1) {
        throw new HttpError(400, "Entity resolution requires one mint query parameter");
      }
      const mint = String(url.searchParams.get("mint") || "").trim();
      if (!publicMintPattern.test(mint)) throw new HttpError(400, "Mint must be a Solana base58 address");
      const storedToken = store.token(mint);
      const currentToken = snapshot().tokens.find((candidate) => candidate.mint === mint) || null;
      const token = currentToken || (storedToken ? publicToken(normalizePersistedLiveToken(storedToken, { mode })) : null);
      return json(res, 200, resolveCanonicalIdentity(mint, token));
    }
    if (url.pathname.startsWith("/api/coins/") && url.pathname.endsWith("/timeline")) {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      if ([...url.searchParams.keys()].some((key) => !["limit", "before"].includes(key))
        || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("before").length > 1) {
        throw new HttpError(400, "Timeline supports only one limit and one before cursor");
      }
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 50 : Number(limitText);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (limitText !== null && String(limit) !== limitText)) {
        throw new HttpError(400, "Timeline limit must be an integer between 1 and 200");
      }
      const before = url.searchParams.get("before");
      const encodedMint = url.pathname.slice("/api/coins/".length, -"/timeline".length).replace(/\/$/, "");
      let mint;
      try { mint = decodeURIComponent(encodedMint); } catch { throw new HttpError(400, "Mint path is invalid"); }
      if (!publicMintPattern.test(mint)) throw new HttpError(400, "Mint must be a Solana base58 address");
      const storedToken = store.token(mint);
      if (!storedToken) return json(res, 404, { ok: false, error: "Coin was not observed by this deployment", requestId });
      const currentSnapshot = snapshot();
      const token = currentSnapshot.tokens.find((candidate) => candidate.mint === mint) || publicToken(normalizePersistedLiveToken(storedToken, { mode }));
      const enrichment = store.enrichmentState(mint);
      let outcome = null;
      try {
        if (enrichment?.evidence?.outcome) outcome = { mint, ...validateProviderObservedOutcome(enrichment.evidence.outcome, { requireProspectiveSelection: true }) };
      } catch {}
      try {
        return json(res, 200, buildCoinTimeline({
          mint,
          token,
          events: store.eventsForMint(mint, 500).map((row) => row.kind === "callout"
            ? { ...row, payload: publicCallout(row.payload) }
            : row),
          alerts: store.alertsForMint(mint, 200),
          callouts: store.calloutsForMint(mint, 200).map(publicCallout),
          outcome,
          generatedAt: currentSnapshot.generatedAt,
          limit,
          before
        }));
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (url.pathname.startsWith("/api/coins/")) {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      const encodedMint = url.pathname.slice("/api/coins/".length);
      if (!encodedMint || encodedMint.includes("/")) throw new HttpError(404, "Coin endpoint not found");
      let mint;
      try { mint = decodeURIComponent(encodedMint); } catch { throw new HttpError(400, "Mint path is invalid"); }
      if (!publicMintPattern.test(mint)) throw new HttpError(400, "Mint must be a Solana base58 address");
      const currentSnapshot = snapshot();
      const dossier = coinDossier(mint, currentSnapshot);
      if (!dossier) return json(res, 404, { ok: false, error: "Coin was not observed inside the public live-evidence contract", requestId });
      return json(res, 200, dossier);
    }
    if (url.pathname === "/api/compare") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      if ([...url.searchParams.keys()].some((key) => key !== "mints") || url.searchParams.getAll("mints").length !== 1) {
        throw new HttpError(400, "Compare requires one mints query parameter");
      }
      const mints = String(url.searchParams.get("mints") || "").split(",").map((value) => value.trim()).filter(Boolean);
      if (mints.length < 2 || mints.length > 4 || mints.some((mint) => !publicMintPattern.test(mint)) || new Set(mints).size !== mints.length) {
        throw new HttpError(400, "Compare requires 2 to 4 unique Solana base58 mints");
      }
      const currentSnapshot = snapshot();
      const knownTokens = new Set(currentSnapshot.tokens.map((token) => token.mint));
      const knownEntries = new Set(currentSnapshot.leaderboard.top100.map((entry) => entry.token?.mint));
      for (const mint of mints) {
        const dossier = coinDossier(mint, currentSnapshot);
        if (!dossier) continue;
        if (!knownTokens.has(mint)) currentSnapshot.tokens.push(dossier.token);
        if (!knownEntries.has(mint)) currentSnapshot.leaderboard.top100.push(comparisonEntry(dossier));
      }
      return json(res, 200, buildCoinComparison({ mints, snapshot: currentSnapshot }));
    }
    if (url.pathname === "/api/briefs/daily" || url.pathname === "/api/briefs/weekly") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      const period = url.pathname.endsWith("/weekly") ? "weekly" : "daily";
      return json(res, 200, snapshot().actionIntelligence.briefs[period]);
    }
    if (url.pathname === "/api/agent/chat") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "POST" });
      const rate = checkAgentRate(req.socket.remoteAddress || "unknown");
      if (!rate.allowed) return json(res, 429, { ok: false, error: "Too many analyst requests", requestId }, { "retry-after": String(rate.retryAfter) });
      const body = await readJsonBody(req, { maxBytes: 2_048 });
      if (Object.keys(body).length !== 1 || !("question" in body)) throw new HttpError(400, "Request must contain only question");
      let analysis;
      try { analysis = analyzeSnapshot(body.question, snapshot()); }
      catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(400, error.message);
        throw error;
      }
      const evidence = analysis.evidence.map((item) => ({
        label: item.detail || item.citation,
        ...(item.mint ? { mint: item.mint } : {})
      }));
      return json(res, 200, {
        ok: true, schemaVersion: 1, requestId, engine: "local-grounded-v1",
        answer: analysis.answer, evidence, generatedAt: analysis.generatedAt, mode: analysis.mode,
        meta: { mode, feedHealth: feedHealth(), lastMintAt, freshness: feedHealth() === "live" ? "fresh" : feedHealth() },
        disclaimer: "Observational research only; not financial advice."
      });
    }
    if (url.pathname === "/api/stream") {
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "GET" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff", connection: "keep-alive" });
      res.write(`event: ready\ndata: ${JSON.stringify({ mode, feedStatus })}\n\n`); clients.add(res);
      req.on("close", () => clients.delete(res)); return;
    }
    if (url.pathname === "/api/export/daily" || url.pathname === "/api/export/weekly") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "POST" });
      if (mode === "live") return liveVaultExportDisabled(res, requestId);
      const period = url.pathname.endsWith("weekly") ? "weekly" : "daily";
      await exportMeasuredBrief(vaultPath, snapshot().actionIntelligence.briefs[period]);
      return json(res, 200, { ok: true, period, mode, scope: "local-demo-operator-vault", requestId });
    }
    if (url.pathname.startsWith("/api/export/coin/")) {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed", requestId }, { allow: "POST" });
      if (mode === "live") return liveVaultExportDisabled(res, requestId);
      let mint;
      try { mint = decodeURIComponent(url.pathname.split("/").pop()); } catch { throw new HttpError(400, "Mint path is invalid"); }
      if (!publicMintPattern.test(mint)) throw new HttpError(400, "Mint must be a Solana base58 address");
      const token = snapshot().tokens.find((candidate) => candidate.mint === mint);
      if (!token) return json(res, 404, { error: "Token not found" });
      await exportCoin(vaultPath, token);
      return json(res, 200, { ok: true, resource: "coin", mode, scope: "local-demo-operator-vault", requestId });
    }
    let target = url.pathname === "/" ? "/index.html" : url.pathname;
    target = path.normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = path.join(root, "public", target);
    if (!file.startsWith(path.join(root, "public"))) return json(res, 403, { error: "Forbidden" });
    let body = await readFile(file);
    if (target === "/index.html") body = Buffer.from(body.toString("utf8").replaceAll("__APP_VERSION__", appVersion));
    res.writeHead(200, {
      "content-type": types[path.extname(file)] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return json(res, 404, { error: "Not found", requestId });
    if (error instanceof HttpError) {
      runtimeTelemetry.warn("http.client_error", { requestId, status: error.status, method: req.method, path: req.url?.split("?")[0] });
      return json(res, error.status, { ok: false, error: error.message, requestId });
    }
    runtimeTelemetry.error("http.unhandled_error", error, { requestId, method: req.method, path: req.url?.split("?")[0] });
    json(res, 500, { error: "Internal error", requestId });
  }
});

function liveVaultExportDisabled(res, requestId) {
  return json(res, 403, {
    ok: false,
    code: "vault-export-disabled",
    error: "Vault export is disabled in live mode",
    mode: "live",
    requestId
  });
}

function json(res, status, value, headers = {}) {
  const encoded = encodeJsonResponse(value, { acceptEncoding: res.req?.headers?.["accept-encoding"] });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
    ...encoded.headers
  });
  res.end(encoded.body);
}
server.headersTimeout = 5_000;
server.requestTimeout = 10_000;
server.listen(port, "0.0.0.0", () => {
  runtimeTelemetry.info("service.started", {
    bind: "0.0.0.0",
    port,
    database: {
      path: dbPath,
      storageState: storage.state,
      requiredMountPath: storage.requiredMountPath,
      mountPointVerified: storage.mountPointVerified,
      filesystemType: storage.filesystemType
    },
    feedStaleAfterSeconds: FEED_STALE_AFTER_MS / 1_000,
    outcomes: {
      source: GECKOTERMINAL_PROVIDER.id,
      enabled: Boolean(outcomeIngestor),
      apiVersion: GECKOTERMINAL_PROVIDER.apiVersion,
      rawCandlesPersisted: false
    },
    riskIdentity: {
      source: GECKOTERMINAL_PROVIDER.id,
      enabled: Boolean(riskIdentityIngestor),
      apiVersion: GECKOTERMINAL_PROVIDER.apiVersion,
      rawProfilesPersisted: false
    },
    earlyActors: {
      source: SOLANA_MAINNET_RPC.id,
      parserRevision: SOLANA_ACTOR_PARSER_REVISION,
      enabled: Boolean(actorIngestor),
      cohortLimit: ACTOR_COHORT_LIMIT,
      rawWalletsPersisted: false,
      rawTransactionsPersisted: false
    }
  });
  if (cleanup.tokens) runtimeTelemetry.info("database.demo_cleanup", cleanup);
  if (identityCleanup.callouts || identityCleanup.events) runtimeTelemetry.info("database.identity_cleanup", identityCleanup);
});
