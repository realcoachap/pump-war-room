import { CanonicalRegistry } from "./canonical-registry.js";
import { isCanonicalSolanaAddress } from "./early-actors.js";

const CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const RAW_SOLANA_IDENTITY_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,}/;
const RAW_SOCIAL_PROFILE_TEXT = /(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)\]}>"']+)/i;
const TOKEN_LIMIT = 500;
const PAGE_LIMIT = 100;

const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export const ENTITY_INTELLIGENCE_METHOD_VERSION = "reviewed-entity-intelligence-v1";
export const ENTITY_TREND_POLICY = "one-reviewed-primary-or-sole-mint-per-entity-v1";

export function projectVerifiedIdentityRegistry(stored = {}) {
  const entities = (Array.isArray(stored?.entities) ? stored.entities : []).flatMap((entity) => {
    if (entity?.reviewState !== "verified") return [];
    const variants = (Array.isArray(entity.variants) ? entity.variants : [])
      .filter((variant) => variant?.reviewState === "verified");
    if (!variants.length) return [];
    const verifiedMints = new Set(variants.map(({ mint }) => mint));
    return [{
      ...entity,
      primaryMint: verifiedMints.has(entity.primaryMint) ? entity.primaryMint : null,
      variants
    }];
  });
  const verifiedMints = new Set(entities.flatMap(({ variants }) => variants.map(({ mint }) => mint)));
  const relationships = (Array.isArray(stored?.relationships) ? stored.relationships : [])
    .filter((relationship) => relationship?.reviewState === "verified"
      && verifiedMints.has(relationship.fromMint) && verifiedMints.has(relationship.toMint));
  return {
    entities,
    relationships,
    ...(stored?.projection && typeof stored.projection === "object" ? { projection: stored.projection } : {}),
    ...(Array.isArray(stored?.reviewedMintOmissions) ? { reviewedMintOmissions: stored.reviewedMintOmissions } : {}),
    ...(stored?.exactOmission && typeof stored.exactOmission === "object" ? { exactOmission: stored.exactOmission } : {})
  };
}

function finite(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return null;
  return value;
}

function canonicalTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function boundedDisplay(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)
    || RAW_SOLANA_IDENTITY_TEXT.test(normalized) || RAW_SOCIAL_PROFILE_TEXT.test(normalized)) return null;
  return normalized;
}

function lifecycleStatus(value) {
  const normalized = boundedDisplay(value, 64);
  return normalized && /^[a-z0-9][a-z0-9-]*$/.test(normalized) ? normalized : null;
}

function observedToken(token, rankingsByMint) {
  if (!token || typeof token !== "object" || Array.isArray(token) || !isCanonicalSolanaAddress(token.mint)) {
    throw new TypeError("entity intelligence tokens must contain canonical Solana mints");
  }
  const ranking = rankingsByMint.get(token.mint) || {};
  return Object.freeze({
    mint: token.mint,
    name: boundedDisplay(token.name, 120),
    symbol: boundedDisplay(token.symbol, 24),
    narrative: boundedDisplay(token.narrative, 120),
    lifecycle: lifecycleStatus(token.status),
    tokenObservedAt: canonicalTime(token.createdAt),
    metrics: Object.freeze({
      radarRank: Number.isSafeInteger(ranking.rank) && ranking.rank > 0 ? ranking.rank : null,
      radarScore: finite(ranking.score, { maximum: 100 }),
      volume5m: finite(token.volume5m),
      momentum: finite(token.momentum, { maximum: 100 })
    })
  });
}

function trendOrderingBasis(contributor) {
  if (!contributor) return null;
  if (contributor.metrics.radarScore !== null) return "radar-evidence-score";
  if (contributor.metrics.volume5m !== null) return "five-minute-volume";
  if (contributor.metrics.momentum !== null) return "momentum";
  if (contributor.tokenObservedAt !== null) return "token-observation-recency-fallback";
  return null;
}

function summarizeEntity({ entityId, displayName, symbol, reviewState, primaryMint, registeredVariants, observedVariants }) {
  const included = [...observedVariants].sort((left, right) => codeUnitCompare(left.mint, right.mint));
  const includedMints = new Set(included.map(({ mint }) => mint));
  const verifiedVariants = registeredVariants.filter(({ reviewState }) => reviewState === "verified");
  const denominatorVariants = reviewState === "singleton-unreviewed" ? registeredVariants : verifiedVariants;
  const excluded = denominatorVariants
    .filter((variant) => !includedMints.has(variant.mint))
    .map((variant) => ({
      mint: variant.mint,
      kind: variant.kind,
      reviewState: variant.reviewState,
      evidenceClass: variant.evidenceClass,
      registryObservedAt: variant.registryObservedAt,
      reason: "not-observed-in-current-tape"
    }))
    .sort((left, right) => codeUnitCompare(left.mint, right.mint));
  const reviewExcluded = (reviewState === "singleton-unreviewed" ? [] : registeredVariants)
    .filter(({ reviewState }) => reviewState !== "verified")
    .map((variant) => ({
      mint: variant.mint,
      kind: variant.kind,
      reviewState: variant.reviewState,
      evidenceClass: variant.evidenceClass,
      registryObservedAt: variant.registryObservedAt,
      reason: "variant-review-not-verified",
      denominatorImpact: "none"
    }))
    .sort((left, right) => codeUnitCompare(left.mint, right.mint));
  let contributor = null;
  let selectionReason;
  if (reviewState === "singleton-unreviewed") {
    contributor = included[0] || null;
    selectionReason = contributor ? "exact-mint-singleton" : "no-observed-variant";
  } else if (primaryMint !== null) {
    contributor = included.find(({ mint }) => mint === primaryMint) || null;
    selectionReason = contributor ? "explicit-reviewed-primary" : "reviewed-primary-not-observed";
  } else if (verifiedVariants.length === 1) {
    contributor = included.find(({ mint }) => mint === verifiedVariants[0].mint) || null;
    selectionReason = contributor ? "sole-reviewed-variant" : "sole-reviewed-variant-not-observed";
  } else {
    selectionReason = included.length ? "withheld-ambiguous-no-reviewed-primary" : "no-observed-variant";
  }
  const narratives = new Map();
  const lifecycle = new Map();
  for (const variant of included) {
    if (variant.lifecycle !== null) lifecycle.set(variant.lifecycle, (lifecycle.get(variant.lifecycle) || 0) + 1);
    if (variant.narrative !== null) narratives.set(variant.narrative, (narratives.get(variant.narrative) || 0) + 1);
  }
  const narrativeValues = [...narratives].map(([name, mintCount]) => ({ name, mintCount }))
    .sort((left, right) => right.mintCount - left.mintCount || codeUnitCompare(left.name, right.name));
  const lifecycleCounts = Object.fromEntries([...lifecycle].sort(([left], [right]) => codeUnitCompare(left, right)));
  const registeredMintCount = denominatorVariants.length;
  const observedMintCount = included.length;
  const orderingBasis = trendOrderingBasis(contributor);
  return Object.freeze({
    schemaVersion: 1,
    entityId,
    displayName,
    symbol,
    reviewState,
    primary: Object.freeze({
      mint: primaryMint,
      meaning: "identity resolution only; not a safety, quality, or trade recommendation"
    }),
    variants: Object.freeze({
      registeredMintCount,
      observedMintCount,
      missingMintCount: Math.max(0, registeredMintCount - observedMintCount),
      included: Object.freeze(included),
      excluded: Object.freeze(excluded),
      reviewExcluded: Object.freeze(reviewExcluded)
    }),
    narratives: Object.freeze({
      observedMintCount: included.filter(({ narrative }) => narrative !== null).length,
      missingMintCount: included.filter(({ narrative }) => narrative === null).length + excluded.length,
      values: Object.freeze(narrativeValues),
      basis: "per-mint observations; matching narratives do not merge unreviewed mints"
    }),
    lifecycle: Object.freeze({
      observedMintCount: included.filter(({ lifecycle }) => lifecycle !== null).length,
      missingMintCount: included.filter(({ lifecycle }) => lifecycle === null).length + excluded.length,
      statusCounts: Object.freeze(lifecycleCounts),
      basis: "per-mint discrete lifecycle observations; no continuous or finalization inference"
    }),
    volume: Object.freeze({
      availableMintCount: included.filter(({ metrics }) => metrics.volume5m !== null).length,
      missingMintCount: included.filter(({ metrics }) => metrics.volume5m === null).length + excluded.length,
      contributingMintCount: contributor?.metrics.volume5m !== null && contributor?.metrics.volume5m !== undefined ? 1 : 0,
      basis: "per-mint five-minute volume observations; entity trend uses at most one exact-mint contributor"
    }),
    trend: Object.freeze({
      policy: ENTITY_TREND_POLICY,
      contributingMint: contributor?.mint ?? null,
      selectionReason,
      orderingBasis,
      radarRank: contributor?.metrics.radarRank ?? null,
      radarScore: contributor?.metrics.radarScore ?? null,
      volume5m: contributor?.metrics.volume5m ?? null,
      momentum: contributor?.metrics.momentum ?? null,
      excludedObservedMintCount: Math.max(0, included.length - (contributor ? 1 : 0)),
      summedAcrossVariants: false
    })
  });
}

function entityTrendComparator(left, right) {
  const priorities = {
    "radar-evidence-score": 0,
    "five-minute-volume": 1,
    momentum: 2,
    "token-observation-recency-fallback": 3
  };
  const basisDifference = priorities[left.trend.orderingBasis] - priorities[right.trend.orderingBasis];
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
  if (recencyDifference) return recencyDifference;
  return codeUnitCompare(left.entityId, right.entityId);
}

export function buildEntityIntelligence({ tokens, registry = {}, rankings = [], generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(tokens) || tokens.length > TOKEN_LIMIT) throw new RangeError(`entity intelligence tokens must contain at most ${TOKEN_LIMIT} entries`);
  if (!Array.isArray(rankings) || rankings.length > TOKEN_LIMIT) throw new RangeError(`entity intelligence rankings must contain at most ${TOKEN_LIMIT} entries`);
  const canonicalGeneratedAt = canonicalTime(generatedAt);
  if (canonicalGeneratedAt === null) throw new TypeError("entity intelligence generatedAt must be a timestamp");
  const canonical = new CanonicalRegistry({
    entities: Array.isArray(registry.entities) ? registry.entities : [],
    relationships: Array.isArray(registry.relationships) ? registry.relationships : []
  });
  const activeEntityIds = new Set(projectVerifiedIdentityRegistry(registry).entities.map(({ entityId }) => entityId));
  const rankingsByMint = new Map(rankings.flatMap((entry) => {
    const mint = entry?.token?.mint;
    return isCanonicalSolanaAddress(mint) ? [[mint, entry]] : [];
  }));
  const observedByMint = new Map();
  for (const token of tokens) {
    const observed = observedToken(token, rankingsByMint);
    if (observedByMint.has(observed.mint)) throw new TypeError(`entity intelligence token ${observed.mint} is duplicated`);
    observedByMint.set(observed.mint, observed);
  }

  const reviewedMintOmissions = (Array.isArray(registry.reviewedMintOmissions) ? registry.reviewedMintOmissions : [])
    .flatMap((omission) => observedByMint.has(omission?.mint) && isCanonicalSolanaAddress(omission.mint) ? [{
      mint: omission.mint,
      entityId: CODE_PATTERN.test(omission.entityId || "") ? omission.entityId : null,
      displayName: boundedDisplay(omission.displayName, 120),
      symbol: boundedDisplay(omission.symbol, 24),
      reviewState: "verified-projection-omitted",
      reason: ["legacy-entity-variant-cap-exceeded", "projection-capacity-exhausted", "legacy-invalid-variant", "legacy-invalid-primary"].includes(omission.reason)
        ? omission.reason : "projection-capacity-exhausted",
      registeredVariantCount: Number.isSafeInteger(omission.registeredVariantCount) && omission.registeredVariantCount > 0
        ? omission.registeredVariantCount : null
    }] : []);
  const omittedReviewedMints = new Set(reviewedMintOmissions.map(({ mint }) => mint));

  const verifiedVariantOwners = new Map();
  const summaries = [];
  let reviewedVariantCount = 0;
  for (const entity of canonical.entities.filter(({ entityId }) => activeEntityIds.has(entityId))) {
    const registeredVariants = entity.variants.map((variant) => ({
      mint: variant.mint,
      kind: variant.kind,
      reviewState: variant.reviewState,
      evidenceClass: variant.evidenceClass,
      registryObservedAt: variant.observedAt
    }));
    const verifiedVariants = registeredVariants.filter(({ reviewState }) => reviewState === "verified");
    reviewedVariantCount += verifiedVariants.length;
    for (const variant of verifiedVariants) verifiedVariantOwners.set(variant.mint, entity.entityId);
    const observedVariants = verifiedVariants.flatMap((variant) => {
      const observed = observedByMint.get(variant.mint);
      return observed ? [{ ...variant, ...observed }] : [];
    });
    const verifiedPrimaryMint = verifiedVariants.some(({ mint }) => mint === entity.primaryMint) ? entity.primaryMint : null;
    summaries.push(summarizeEntity({
      entityId: entity.entityId,
      displayName: boundedDisplay(entity.displayName, 120) || "Unnamed reviewed entity",
      symbol: boundedDisplay(entity.symbol, 24),
      reviewState: "verified",
      primaryMint: verifiedPrimaryMint,
      registeredVariants,
      observedVariants
    }));
  }

  for (const observed of observedByMint.values()) {
    if (verifiedVariantOwners.has(observed.mint) || omittedReviewedMints.has(observed.mint)) continue;
    summaries.push(summarizeEntity({
      entityId: `~mint:${observed.mint}`,
      displayName: observed.name || observed.symbol || `Mint ${observed.mint.slice(0, 6)}…${observed.mint.slice(-4)}`,
      symbol: observed.symbol,
      reviewState: "singleton-unreviewed",
      primaryMint: observed.mint,
      registeredVariants: [{ mint: observed.mint, kind: "unresolved", reviewState: "unreviewed", evidenceClass: "unavailable", registryObservedAt: null }],
      observedVariants: [{ mint: observed.mint, kind: "unresolved", reviewState: "unreviewed", evidenceClass: "unavailable", registryObservedAt: null, ...observed }]
    }));
  }

  summaries.sort((left, right) => codeUnitCompare(left.entityId, right.entityId));
  const trending = [...summaries].filter(({ trend }) => trend.orderingBasis !== null)
    .sort(entityTrendComparator).slice(0, 20).map((entity, index) => ({ ...entity, trendRank: index + 1 }));
  const groupedObservedMintCount = [...verifiedVariantOwners].filter(([mint]) => observedByMint.has(mint)).length;
  return Object.freeze({
    schemaVersion: 1,
    methodVersion: ENTITY_INTELLIGENCE_METHOD_VERSION,
    generatedAt: canonicalGeneratedAt,
    universe: "current public snapshot plus reviewed registry variants",
    registryProjection: registry?.projection && typeof registry.projection === "object" ? Object.freeze(registry.projection) : null,
    denominators: Object.freeze({
      observedMintCount: observedByMint.size,
      reviewedEntityCount: activeEntityIds.size,
      reviewedVariantCount,
      groupedObservedMintCount,
      singletonObservedMintCount: observedByMint.size - groupedObservedMintCount - reviewedMintOmissions.length,
      projectionOmittedReviewedMintCount: reviewedMintOmissions.length,
      entityCount: summaries.length,
      trendingEntityCount: trending.length
    }),
    projectionOmittedReviewed: Object.freeze(reviewedMintOmissions),
    rankingBoundary: Object.freeze({
      leaderboardChanged: false,
      unreviewedProposalsUsed: false,
      entityTrendAffectsMintRank: false,
      unreviewedProposalImpact: "none",
      rankingImpact: "none",
      policy: ENTITY_TREND_POLICY
    }),
    api: Object.freeze({
      list: "/api/v1/entities",
      resolver: "/api/v1/entities/resolve?mint={mint}",
      specification: "/api/v1/openapi.json",
      documentation: "/api.html",
      externalApiKeys: "not-offered"
    }),
    entities: Object.freeze(summaries),
    trending: Object.freeze(trending),
    limitations: Object.freeze([
      "Entity aggregation preserves exact-mint denominators and uses at most one observed mint as a trend contribution.",
      "Missing variants and evidence remain explicit; unreviewed proposals never group mints or affect ranking.",
      "Identity relationships do not establish safety, legitimacy, common control, or a recommendation."
    ])
  });
}

function decodeCursor(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new TypeError("Entity cursor is invalid");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new TypeError("Entity cursor is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "after,v" || parsed.v !== 1
    || typeof parsed.after !== "string"
    || (!CODE_PATTERN.test(parsed.after)
      && !(parsed.after.startsWith("~mint:") && isCanonicalSolanaAddress(parsed.after.slice("~mint:".length))))) {
    throw new TypeError("Entity cursor is invalid");
  }
  return parsed.after;
}

function encodeCursor(entityId) {
  return Buffer.from(JSON.stringify({ v: 1, after: entityId })).toString("base64url");
}

export function paginateEntityIntelligence(intelligence, { limit = 20, cursor = null } = {}) {
  if (!intelligence || typeof intelligence !== "object" || !Array.isArray(intelligence.entities)) {
    throw new TypeError("entity intelligence envelope is required");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw new RangeError(`Entity page limit must be an integer between 1 and ${PAGE_LIMIT}`);
  }
  const after = cursor === null ? null : decodeCursor(cursor);
  const start = after === null ? 0 : intelligence.entities.findIndex(({ entityId }) => codeUnitCompare(entityId, after) > 0);
  const offset = start === -1 ? intelligence.entities.length : start;
  const entities = intelligence.entities.slice(offset, offset + limit);
  const hasMore = offset + entities.length < intelligence.entities.length;
  return {
    schemaVersion: intelligence.schemaVersion,
    methodVersion: intelligence.methodVersion,
    generatedAt: intelligence.generatedAt,
    universe: intelligence.universe,
    registryProjection: intelligence.registryProjection,
    denominators: intelligence.denominators,
    rankingBoundary: intelligence.rankingBoundary,
    api: intelligence.api,
    page: {
      order: "entity-id-ascending",
      limit,
      count: entities.length,
      nextCursor: hasMore && entities.length ? encodeCursor(entities.at(-1).entityId) : null
    },
    entities,
    projectionOmittedReviewed: intelligence.projectionOmittedReviewed,
    limitations: intelligence.limitations
  };
}
