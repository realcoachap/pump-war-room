import { unavailableProviderOutcome, validateProviderObservedOutcome } from "./outcomes.js";

const WINDOWS = ["5m", "15m", "1h", "6h", "24h"];

const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const validLiveMint = (mint) => typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);

function freshness(createdAt, now) {
  const observedAt = timestamp(createdAt);
  if (!observedAt) return { state: "unverified", observedAt: null, ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((now - observedAt) / 1_000));
  const state = ageSeconds <= 300 ? "fresh" : ageSeconds <= 3_600 ? "aging" : "stale";
  return { state, observedAt: new Date(observedAt).toISOString(), ageSeconds };
}

function trustedOutcome(value) {
  try { return validateProviderObservedOutcome(value, { requireProspectiveSelection: true }); }
  catch { return null; }
}

function outcome(token, outcomesByMint, now) {
  const supplied = outcomesByMint instanceof Map ? outcomesByMint.get(token.mint) : outcomesByMint?.[token.mint];
  const providerState = supplied?.evidence && typeof supplied.evidence === "object" ? supplied : null;
  const verified = trustedOutcome(providerState?.evidence?.outcome ?? supplied);
  const asOf = new Date(now).toISOString();
  const launchAt = timestamp(token.createdAt) === null ? asOf : new Date(timestamp(token.createdAt)).toISOString();
  const fallback = unavailableProviderOutcome({ launchAt, asOf, state: providerState });
  const matchingVerified = verified && timestamp(verified.launchAt) === timestamp(token.createdAt) ? verified : null;
  return {
    ...(matchingVerified || fallback),
    graduation: token.status === "graduated"
      ? { status: "observed", observedAt: token.graduatedAt || null }
      : token.migrationEvidence?.evidenceClass === "feed-observed-processed"
        ? { status: "feed-observed-processed", observedAt: token.migrationEvidence.observedAt || null }
        : { status: "pending", observedAt: null }
  };
}

function publicToken(token) {
  const result = Object.fromEntries([
    "ingestSchemaVersion", "mint", "name", "symbol", "createdAt", "status", "narrative", "marketCap", "volume5m",
    "priceChange5m", "uniqueBuyers", "buyRatio", "bondingProgress", "momentum", "risk", "source",
    "creator", "deployer", "marketCapSol", "marketCapEvidence", "curveSol", "launchSolAmount", "migrationEvidence", "riskIdentity"
  ].filter((key) => token[key] !== undefined).map((key) => [key, token[key]]));
  for (const key of ["marketCap", "volume5m", "uniqueBuyers", "bondingProgress", "momentum", "risk"]) {
    const value = finite(result[key]);
    result[key] = value !== null && value >= 0 ? value : null;
  }
  if (!Number.isSafeInteger(result.uniqueBuyers)) result.uniqueBuyers = null;
  if (result.bondingProgress !== null && result.bondingProgress > 100) result.bondingProgress = null;
  if (result.momentum !== null && result.momentum > 100) result.momentum = null;
  if (result.risk !== null && result.risk > 100) result.risk = null;
  result.priceChange5m = finite(result.priceChange5m);
  result.buyRatio = finite(result.buyRatio);
  return result;
}

function scoreToken(token, now, outcomesByMint) {
  const rawMomentum = finite(token.momentum);
  const suppliedMomentum = rawMomentum !== null && rawMomentum >= 0 && rawMomentum <= 100 ? rawMomentum : null;
  const momentum = clamp(Math.max(0, suppliedMomentum ?? 0));
  const rawBuyers = finite(token.uniqueBuyers);
  const suppliedBuyers = Number.isSafeInteger(rawBuyers) && rawBuyers >= 0 ? rawBuyers : null;
  const buyers = Math.max(0, suppliedBuyers ?? 0);
  const confidence = token.riskConfidence || (token.source === "demo" ? "synthetic" : "unavailable");
  const fresh = freshness(token.createdAt, now);
  const freshnessPoints = fresh.state === "fresh" ? 10 : fresh.state === "aging" ? 5 : 0;
  const buyerPoints = clamp(Math.log2(buyers + 1) * 2.5, 0, 12);
  // Provider-observed risk factors are not outcome-calibrated and therefore
  // cannot alter rank in v0.7.0.
  const substantiveEvidenceAvailable = suppliedMomentum !== null || suppliedBuyers !== null;
  const score = substantiveEvidenceAvailable
    ? Math.round(clamp(momentum * .78 + buyerPoints + freshnessPoints) * 10) / 10
    : null;
  const reasons = [
    suppliedMomentum === null ? "Momentum unavailable" : `Momentum ${Math.round(momentum)}/100`,
    suppliedBuyers === null ? "Buyer breadth unavailable" : `${Math.round(buyers)} observed buyers`,
    substantiveEvidenceAvailable
      ? fresh.state === "unverified" ? "Freshness unverified" : `${fresh.state} observation`
      : "Evidence score withheld; ordered by observation recency",
    `${confidence} risk evidence; excluded from rank`
  ];
  return {
    token: publicToken(token),
    score,
    orderingBasis: substantiveEvidenceAvailable ? "evidence-score" : "observation-recency-no-substantive-inputs",
    reasons,
    freshness: fresh,
    riskConfidence: confidence,
    outcome: outcome(token, outcomesByMint, now)
  };
}

export function createTop100(tokens, { now = Date.now(), mode = "live", outcomesByMint = null } = {}) {
  if (!Array.isArray(tokens)) return [];
  return tokens
    .filter((token) => token && typeof token === "object" && token.mint)
    .filter((token) => mode !== "live" || token.source === "pumpportal")
    .filter((token) => mode !== "live" || validLiveMint(token.mint))
    .map((token) => scoreToken(token, now, outcomesByMint))
    .sort((a, b) => {
      const leftScore = finite(a.score);
      const rightScore = finite(b.score);
      if (leftScore !== null || rightScore !== null) {
        if (leftScore === null) return 1;
        if (rightScore === null) return -1;
        if (rightScore !== leftScore) return rightScore - leftScore;
      }
      return (timestamp(b.token.createdAt) ?? 0) - (timestamp(a.token.createdAt) ?? 0)
        || String(a.token.mint).localeCompare(String(b.token.mint));
    })
    .slice(0, 100)
    .map((entry, index) => ({ rank: index + 1, mode, chain: "solana", ...entry }));
}

export const OUTCOME_WINDOWS = Object.freeze([...WINDOWS]);
