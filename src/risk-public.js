import { aggregateRiskIdentityEvidence, validateRiskIdentityPersistenceEvidence } from "./risk-identity.js";

const PUBLIC_METHOD_VERSION = "risk-identity-exact-match-v1";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function factorValue(document, key) {
  const factor = document?.factors?.[key];
  return factor?.evidenceClass === "provider-observed" ? factor.value ?? null : null;
}

function countValue(value) {
  return Number.isSafeInteger(value?.value) && value.value >= 0 ? value.value : null;
}

function validateEvidenceRows(states) {
  const rows = [];
  for (const state of Array.isArray(states) ? states : []) {
    if (!state?.evidence) continue;
    try {
      validateRiskIdentityPersistenceEvidence(state.evidence, { mint: state.mint, status: state.status });
      aggregateRiskIdentityEvidence([state.evidence], []);
      rows.push(state.evidence);
    } catch {
      // Persisted malformed or obsolete evidence is omitted, never coerced.
    }
  }
  return rows;
}

function unavailableFactor(limitation) {
  return { evidenceClass: "unavailable", limitation };
}

const PUBLIC_STATE_STATUSES = new Set([
  "queued", "available", "unavailable", "degraded", "rate-limited", "invalid-response"
]);

function safeTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function acquisitionMetadata(state) {
  if (!state || typeof state !== "object") return {
    sourceStatus: "not-admitted",
    missingReasonCode: "not-admitted",
    lastAttemptAt: null,
    nextAttemptAt: null
  };
  const sourceStatus = PUBLIC_STATE_STATUSES.has(state.status) ? state.status : "unavailable";
  const missingReasonCode = safeCode(state.evidence?.missingReasonCode)
    || safeCode(state.errorCode)
    || (sourceStatus === "queued" ? "pending" : sourceStatus === "unavailable" ? "provider-fields-missing" : null);
  return {
    sourceStatus,
    missingReasonCode,
    lastAttemptAt: safeTimestamp(state.lastAttemptAt),
    nextAttemptAt: safeTimestamp(state.nextAttemptAt)
  };
}

function unavailableProviderFactor(limitation, state) {
  return { ...unavailableFactor(limitation), ...acquisitionMetadata(state) };
}

function demoIdentity(token) {
  const concentration = finite(token.top10Pct);
  const developer = finite(token.devHoldingPct);
  return {
    schemaVersion: 1,
    methodVersion: "synthetic-demo-v1",
    overallEvidence: "synthetic",
    rankingImpact: "synthetic-demo-only",
    factors: {
      concentration: { evidenceClass: "synthetic", holderCount: null, top10Percentage: concentration, providerUpdatedAt: null, limitation: "Synthetic demonstration value." },
      developer: { evidenceClass: "synthetic", holdingPercentage: developer, limitation: "Synthetic demonstration value." },
      creatorHistory: unavailableFactor("Creator history is not simulated."),
      identity: unavailableFactor("Exact identity reuse is not simulated."),
      liquidity: unavailableFactor("Pool reserve is not simulated."),
      curve: unavailableFactor("Curve inventory is not simulated as provider evidence."),
      lifecycle: { evidenceClass: "synthetic", migrationObserved: token.status === "graduated", observedAt: null, limitation: "Synthetic demonstration lifecycle." }
    },
    duplicateEvidence: {
      exactDeclaredIdentifierReuse: { value: null, evidenceClass: "unavailable" },
      duplicateContent: { value: null, evidenceClass: "unavailable" },
      likelyController: { value: null, evidenceClass: "unavailable" },
      maliciousness: { value: null, evidenceClass: "unavailable" }
    },
    missing: ["holder count", "creator history", "identity reuse", "pool reserve"]
  };
}

function liveIdentity(token, providerDocument, providerState, aggregate, outcomeState, calculatedAt) {
  const aggregateRow = aggregate?.byMint?.[token.mint] || null;
  const holderCount = factorValue(providerDocument, "holderCount");
  const top10Percentage = factorValue(providerDocument, "top10HolderPercentage");
  const providerUpdatedAt = factorValue(providerDocument, "providerLastUpdated");
  const developerHolding = factorValue(providerDocument, "developerHoldingPercentage");
  const concentrationObserved = Number.isSafeInteger(holderCount) || finite(top10Percentage) !== null;
  const developerObserved = finite(developerHolding) !== null;

  const creatorCount = countValue(aggregateRow?.prospectiveLaunchCounts?.declaredCreator);
  const deployerCount = countValue(aggregateRow?.prospectiveLaunchCounts?.declaredDeployer);
  const providerDeveloperCount = countValue(aggregateRow?.prospectiveLaunchCounts?.providerDeveloperAddress);
  const observedLaunchCount = creatorCount ?? deployerCount ?? providerDeveloperCount;
  const creatorRole = creatorCount !== null ? "declared creator"
    : deployerCount !== null ? "observed deployer/user"
      : providerDeveloperCount !== null ? "provider developer address matched to observed creator/deployer"
        : null;

  const duplicateBreakdown = Object.fromEntries(Object.entries(aggregateRow?.exactDuplicateCounts || {})
    .map(([key, envelope]) => [key, countValue(envelope)]));
  const duplicateCounts = ["xHandle", "telegramHandle", "websiteDomain"]
    .map((key) => duplicateBreakdown[key]).filter(Number.isSafeInteger);
  // Do not sum correlated identifiers or promote common name/symbol
  // collisions to identity evidence. This is the largest exact-match set
  // for one declared social or registrable-domain identifier.
  const exactDuplicateCount = duplicateCounts.length ? Math.max(...duplicateCounts) : null;
  const nameSymbolCollisionCount = Number.isSafeInteger(duplicateBreakdown.nameSymbol)
    ? duplicateBreakdown.nameSymbol : null;

  const liquidityEvidence = providerDocument?.liquidity?.evidenceClass === "provider-observed"
    ? providerDocument.liquidity : outcomeState?.evidence?.liquidity;
  const liquidityUsd = liquidityEvidence?.evidenceClass === "provider-observed" ? finite(liquidityEvidence.liquidityUsd) : null;
  const liquidityObserved = liquidityUsd !== null;
  const curveSol = finite(token.curveSol);
  const launchSolAmount = finite(token.launchSolAmount);
  const curveObserved = curveSol !== null || launchSolAmount !== null;
  const migrationObserved = token.migrationEvidence?.evidenceClass === "feed-observed-processed";

  const locallyDerived = observedLaunchCount !== null || exactDuplicateCount !== null;
  const overallEvidence = concentrationObserved || developerObserved || liquidityObserved ? "provider-observed"
    : migrationObserved || curveObserved ? "feed-observed-processed"
      : locallyDerived ? "locally-derived"
        : "unavailable";

  const factors = {
    concentration: concentrationObserved ? {
      evidenceClass: "provider-observed",
      holderCount: Number.isSafeInteger(holderCount) ? holderCount : null,
      top10Percentage: finite(top10Percentage),
      providerUpdatedAt: typeof providerUpdatedAt === "string" ? providerUpdatedAt : null,
      fetchedAt: providerDocument?.fetchedAt || null,
      source: "geckoterminal",
      sourceFields: ["data.attributes.holders.count", "data.attributes.holders.distribution_percentage.top_10", "data.attributes.holders.last_updated"],
      limitation: "GeckoTerminal-reported top-10 distribution has unpublished custody exclusions and may include curve or liquidity custody."
    } : unavailableProviderFactor("Provider holder distribution is missing.", providerState),
    developer: developerObserved ? {
      evidenceClass: "provider-observed",
      holdingPercentage: finite(developerHolding),
      fetchedAt: providerDocument?.fetchedAt || null,
      source: "geckoterminal",
      sourceField: "data.attributes.developer_holding_percentage",
      limitation: "Provider-reported developer holding is not verified creator identity."
    } : unavailableProviderFactor("Provider developer-holding evidence is missing.", providerState),
    creatorHistory: observedLaunchCount !== null ? {
      evidenceClass: "locally-derived",
      observedLaunchCount,
      role: creatorRole,
      source: "locally-derived",
      sourceFields: ["prospective cohort token.creator", "prospective cohort token.deployer", "data.attributes.developer_address"],
      calculatedAt,
      scope: "independent fixed prospective v0.7 risk cohort of at most 120 launches observed by this deployment",
      limitation: "This bounded cohort count is not all-time or complete deployment creator history; conflicting identities remain unknown."
    } : unavailableFactor("No unambiguous prospective creator/deployer identity is available."),
    identity: exactDuplicateCount !== null ? {
      evidenceClass: "locally-derived",
      exactDuplicateCount,
      exactDuplicateCounts: duplicateBreakdown,
      nameSymbolCollisionCount,
      basis: "maximum other mints sharing any one exact normalized X, Telegram, or registrable-domain identifier",
      source: "locally-derived",
      sourceFields: ["data.attributes.twitter_handle", "data.attributes.telegram_handle", "data.attributes.websites", "data.attributes.name+data.attributes.symbol"],
      calculatedAt,
      scope: "independent fixed prospective v0.7 risk cohort of at most 120 launches",
      limitation: "Exact declared-identifier reuse does not establish duplicate content, common control, fraud, maliciousness, or safety. Name/symbol collision is disclosed separately as a low-confidence content warning."
    } : {
      ...unavailableProviderFactor("No provider-declared X, Telegram, or registrable-domain identifier is available for exact matching.", providerState),
      exactDuplicateCount: null,
      exactDuplicateCounts: duplicateBreakdown,
      nameSymbolCollisionCount
    },
    liquidity: liquidityObserved ? {
      evidenceClass: "provider-observed",
      liquidityUsd,
      observedAt: liquidityEvidence.observedAt || null,
      source: "geckoterminal",
      sourceField: "data[].attributes.reserve_in_usd",
      basis: liquidityEvidence.basis || "pool reserve at prospective pool selection",
      endpoint: liquidityEvidence.endpoint || null,
      pool: liquidityEvidence.pool || outcomeState?.pool || null,
      providerPage: liquidityEvidence.providerPage ?? outcomeState?.evidence?.providerPage ?? null,
      providerRank: liquidityEvidence.providerRank ?? outcomeState?.evidence?.providerRank ?? null,
      limitation: liquidityEvidence.limitation || "GeckoTerminal-observed pool reserve is not evidence of locked liquidity."
    } : {
      ...unavailableProviderFactor("No provider-observed pool reserve is available.", providerState),
      missingReasonCode: providerDocument?.liquidity?.missingReasonCode
        || acquisitionMetadata(providerState).missingReasonCode,
      lastAttemptAt: providerDocument?.liquidity?.attemptedAt
        || acquisitionMetadata(providerState).lastAttemptAt,
      endpoint: providerDocument?.liquidity?.endpoint || null
    },
    curve: curveObserved ? {
      evidenceClass: "feed-observed-processed",
      virtualSolReserve: curveSol,
      launchSolAmount,
      observedAt: token.createdAt || null,
      source: "pumpportal",
      sourceFields: ["vSolInBondingCurve", "solAmount"],
      limitation: "Feed-reported virtual SOL reserve (vSolInBondingCurve) and create-transaction SOL amount are separate observations; neither proves curve completion, migration, curve progress, traded volume, locked liquidity, or finalized on-chain state."
    } : unavailableFactor("No feed-reported virtual SOL reserve or create-transaction SOL amount is available."),
    lifecycle: migrationObserved ? {
      evidenceClass: "feed-observed-processed",
      migrationObserved: true,
      observedAt: token.migrationEvidence.observedAt || null,
      source: "pumpportal",
      sourceField: "subscribeMigration frame",
      limitation: "Processed-feed observation is not independently finalized migration proof."
    } : unavailableFactor("No migration observation is available; absence does not prove a token has not migrated.")
  };

  return {
    schemaVersion: 1,
    methodVersion: PUBLIC_METHOD_VERSION,
    overallEvidence,
    rankingImpact: "none-uncalibrated",
    factors,
    duplicateEvidence: {
      exactDeclaredIdentifierReuse: aggregateRow?.exactDeclaredIdentifierReuse || { value: null, evidenceClass: "unavailable" },
      duplicateContent: aggregateRow?.duplicateContent || { value: null, evidenceClass: "unavailable" },
      likelyController: aggregateRow?.likelyController || { value: null, evidenceClass: "unavailable" },
      maliciousness: aggregateRow?.maliciousness || { value: null, evidenceClass: "unavailable" }
    },
    providerObservation: acquisitionMetadata(providerState),
    missing: Object.entries(factors).filter(([, factor]) => factor.evidenceClass === "unavailable").map(([key]) => key)
  };
}

export function attachRiskIdentityEvidence(tokens, {
  mode = "live",
  riskStates = [],
  outcomeStates = [],
  tokenEvidenceRows = tokens,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!Array.isArray(tokens)) throw new TypeError("tokens must be an array");
  const evidenceRows = validateEvidenceRows(riskStates);
  const aggregate = aggregateRiskIdentityEvidence(evidenceRows, mode === "live" ? tokenEvidenceRows : []);
  const evidenceByMint = new Map(evidenceRows.map((row) => [row.mint, row]));
  const stateByMint = new Map((Array.isArray(riskStates) ? riskStates : []).filter((row) => row?.mint).map((row) => [row.mint, row]));
  const outcomeByMint = new Map((Array.isArray(outcomeStates) ? outcomeStates : []).map((row) => [row.mint, row]));
  const enrichedTokens = tokens.map((token) => {
    const riskIdentity = mode === "demo" ? demoIdentity(token)
      : liveIdentity(token, evidenceByMint.get(token.mint), stateByMint.get(token.mint), aggregate, outcomeByMint.get(token.mint), generatedAt);
    return { ...token, riskIdentity, riskConfidence: riskIdentity.overallEvidence };
  });
  const summary = {
    totalTracked: enrichedTokens.length,
    holderEvidenceCount: enrichedTokens.filter((token) => token.riskIdentity.factors.concentration.evidenceClass !== "unavailable").length,
    developerEvidenceCount: enrichedTokens.filter((token) => token.riskIdentity.factors.developer.evidenceClass !== "unavailable").length,
    exactDuplicateTokenCount: enrichedTokens.filter((token) => Number(token.riskIdentity.factors.identity.exactDuplicateCount) > 0).length,
    identityHistoryCount: enrichedTokens.filter((token) => Number.isSafeInteger(token.riskIdentity.factors.creatorHistory.observedLaunchCount)).length,
    liquidityEvidenceCount: enrichedTokens.filter((token) => token.riskIdentity.factors.liquidity.evidenceClass === "provider-observed").length,
    curveEvidenceCount: enrichedTokens.filter((token) => token.riskIdentity.factors.curve.evidenceClass === "feed-observed-processed").length,
    migrationObservationCount: enrichedTokens.filter((token) => token.riskIdentity.factors.lifecycle.evidenceClass === "feed-observed-processed").length
  };
  return { tokens: enrichedTokens, aggregateCoverage: aggregate.coverage, summary };
}

export const RISK_IDENTITY_PUBLIC_METHOD_VERSION = PUBLIC_METHOD_VERSION;
