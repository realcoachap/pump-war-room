import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createDemoToken, tickDemoToken } from "./demo.js";
import { PumpPortalIngestor } from "./ingest.js";
import { BarkCalloutIngestor } from "./callouts.js";
import { exportCoin, exportDaily } from "./vault.js";
import { analyzeSnapshot } from "./analyst.js";
import { createRateLimiter, HttpError, readJsonBody } from "./http.js";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const port = Number(process.env.PORT || 4173);
const mode = process.env.PUMP_MODE === "live" ? "live" : "demo";
const dbPath = path.resolve(root, process.env.DB_PATH || "data/pump-war-room.db");
const vaultPath = path.resolve(root, process.env.VAULT_PATH || "vault");
const startedAt = new Date().toISOString();
const runtimeTelemetry = createRuntimeTelemetry({ version: appVersion, mode, startedAt });
process.on("uncaughtExceptionMonitor", (error, origin) => runtimeTelemetry.error("process.uncaught_exception", error, { origin }));
const store = new Store(dbPath);
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

function alertFor(token, previous) {
  let alert = null;
  if (token.status === "migration-observed" && previous?.status !== "migration-observed") {
    alert = { level: "hot", title: "Migration observed", message: `${token.symbol} appeared in the processed migration feed; finalization is unverified`, mint: token.mint };
  } else if (token.status === "graduated" && previous?.status !== "graduated") {
    alert = { level: "hot", title: "Graduated", message: `${token.symbol} reached migration`, mint: token.mint };
  } else if (token.momentum >= 78 && (!previous || previous.momentum < 78)) {
    alert = { level: "signal", title: "Velocity spike", message: `${token.symbol} momentum crossed ${token.momentum}`, mint: token.mint };
  } else if (token.smartWallets >= 4 && (!previous || previous.smartWallets < 4)) {
    alert = { level: "signal", title: "Wallet convergence", message: `${token.smartWallets} tracked wallets entered ${token.symbol}`, mint: token.mint };
  } else if (Number.isFinite(token.risk) && token.risk >= 72 && (!previous || !Number.isFinite(previous.risk) || previous.risk < 72)) {
    alert = { level: "risk", title: "Risk escalation", message: `${token.symbol} risk reached ${token.risk}`, mint: token.mint };
  }
  if (alert) {
    const saved = store.addAlert(alert);
    send("alert", saved);
    maybeSendTelegram(saved).catch((error) => runtimeTelemetry.error("telegram.send_failed", error, { mint: saved.mint }));
  }
}

async function maybeSendTelegram(alert) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = `🏛️ Pump War Room — ${alert.title}\n${alert.message}\nhttps://pump.fun/coin/${alert.mint}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!response.ok) throw new Error(`Telegram send failed with HTTP ${response.status}`);
}

function upsert(token) {
  const previous = store.token(token.mint);
  store.upsertToken(token); store.addEvent(previous ? "update" : "mint", token);
  outcomeIngestor?.enqueue(token);
  riskIdentityIngestor?.enqueue(token);
  alertFor(token, previous); send(previous ? "token-update" : "new-token", token);
}

function addCallout(callout) {
  store.upsertCallout(callout);
  store.addEvent("callout", callout);
  send("callout", callout);
}

function normalizeLiveToken(token) {
  return normalizePersistedLiveToken(token, { mode });
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
    const row = acc[token.narrative] ||= {
      name: token.narrative, coins: 0, volume: null, volumeEvidenceCount: 0,
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
  const top100 = createTop100(latestEnrichedTokens, { mode, outcomesByMint });
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
  return {
    version: appVersion, mode, status: healthStatus(feed), service: runtimeTelemetry.service(), storage, telemetry: runtimeTelemetry.snapshot(),
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
    tokens,
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
        observations: riskCohortView.tokens.map((token) => ({
          mint: token.mint,
          name: token.name,
          symbol: token.symbol,
          createdAt: token.createdAt,
          riskIdentity: token.riskIdentity
        }))
      },
      summary: riskCohortView.summary,
      disclaimer: "Provider and feed observations can be incomplete, delayed, or wrong. Exact declared-identifier or registrable-domain reuse does not establish duplicate content, common control, maliciousness, safety, or a probability of harm."
    },
    narratives, callouts: callouts.slice(0, 30), alerts: store.alerts(40)
  };
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
  riskIdentityIngestor = new RiskIdentityIngestor({
    store,
    client: geckoTerminalClient,
    onStatus: (status, telemetry = {}) => {
      const details = { status, mint: telemetry.mint, errorCode: telemetry.errorCode, nextAttemptAt: telemetry.nextAttemptAt };
      if (telemetry.error) runtimeTelemetry.error("risk_identity.worker_failed", telemetry.error, details);
      else if (["degraded", "rate-limited", "invalid-response"].includes(status)) runtimeTelemetry.warn("risk_identity.status", details);
      else if (["available", "unavailable"].includes(status)) runtimeTelemetry.info("risk_identity.status", details);
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
      const feed = feedObservation();
      const status = healthStatus(feed);
      return json(res, status === "healthy" ? 200 : 503, {
      ok: status === "healthy", status, version: appVersion, mode, requestId,
      service: runtimeTelemetry.service(), storage, feed, telemetry: runtimeTelemetry.snapshot(), feedStatus, feedHealth: feed.state, calloutStatus,
      lastEventAt, lastMintAt,
      indexed: mode === "live" ? store.countBySource("pumpportal").tokens : store.count(),
      liveMintCount: mode === "live" ? store.countBySource("pumpportal").tokens : 0,
      demoPurged: mode === "live", demoPurgedCount: cleanup.tokens,
      reconnects: feed.counters.reconnects, feedMessages: feed.counters.messages, feedParseErrors: feed.counters.malformedMessages,
      analyst: { status: "ready", engine: "local-grounded-v1" },
      outcomes: outcomeIngestor?.getStatus() || { schemaVersion: 1, source: GECKOTERMINAL_PROVIDER.id, status: mode === "live" ? "disabled" : "simulation-disabled", queueDepth: 0 },
      outcomeCoverage: store.outcomeCoverage({ provider: GECKOTERMINAL_PROVIDER.id }),
      riskIntelligence: riskIdentityIngestor?.getStatus() || { schemaVersion: 1, source: GECKOTERMINAL_PROVIDER.id, status: mode === "live" ? "disabled" : "simulation-disabled", queueDepth: 0 },
      riskIdentityCoverage: store.riskIdentityCoverage({ provider: GECKOTERMINAL_PROVIDER.id })
    });
    }
    if (url.pathname === "/api/snapshot") return json(res, 200, snapshot());
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
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff", connection: "keep-alive" });
      res.write(`event: ready\ndata: ${JSON.stringify({ mode, feedStatus })}\n\n`); clients.add(res);
      req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "POST" && url.pathname === "/api/export/daily") { await exportDaily(vaultPath, snapshot()); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname.startsWith("/api/export/coin/")) {
      const mint = decodeURIComponent(url.pathname.split("/").pop());
      const token = snapshot().tokens.find((candidate) => candidate.mint === mint);
      if (!token) return json(res, 404, { error: "Token not found" });
      await exportCoin(vaultPath, token); return json(res, 200, { ok: true });
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

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(value));
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
    }
  });
  if (cleanup.tokens) runtimeTelemetry.info("database.demo_cleanup", cleanup);
});
