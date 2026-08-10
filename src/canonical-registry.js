const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const CANONICAL_VARIANT_KINDS = Object.freeze(["official", "migration", "relaunch"]);
export const CANONICAL_RELATIONSHIP_KINDS = Object.freeze([
  "same-creator",
  "same-narrative",
  "probable-copycat",
  "name-collision"
]);
export const CANONICAL_REVIEW_STATES = Object.freeze(["proposed", "verified", "rejected"]);
export const CANONICAL_EVIDENCE_CLASSES = Object.freeze([
  "on-chain-finalized",
  "provider-observed",
  "feed-observed-processed",
  "locally-derived",
  "unavailable"
]);

const variantKinds = new Set(CANONICAL_VARIANT_KINDS);
const relationshipKinds = new Set(CANONICAL_RELATIONSHIP_KINDS);
const reviewStates = new Set(CANONICAL_REVIEW_STATES);
const evidenceClasses = new Set(CANONICAL_EVIDENCE_CLASSES);

function boundedText(value, label, { maximum = 160, code = false, optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`);
  if (normalized.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError(`${label} must not contain control characters`);
  if (code && !/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)) throw new TypeError(`${label} must be a stable lowercase code`);
  return normalized;
}

function mint(value, label = "mint") {
  const normalized = boundedText(value, label, { maximum: 44 });
  if (!SOLANA_MINT_PATTERN.test(normalized)) throw new TypeError(`${label} must be a Solana base58 address`);
  return normalized;
}

function member(value, allowed, label) {
  const normalized = boundedText(value, label, { maximum: 64, code: true });
  if (!allowed.has(normalized)) throw new TypeError(`${label} is not supported`);
  return normalized;
}

function canonicalTimestamp(value, label) {
  const normalized = boundedText(value, label, { maximum: 32 });
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new TypeError(`${label} must be a canonical RFC 3339 timestamp`);
  }
  return normalized;
}

function normalizeVariant(value, entityId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("canonical variant must be an object");
  return Object.freeze({
    mint: mint(value.mint, "variant mint"),
    kind: member(value.kind, variantKinds, "variant kind"),
    reviewState: member(value.reviewState, reviewStates, "variant reviewState"),
    evidenceClass: member(value.evidenceClass, evidenceClasses, "variant evidenceClass"),
    observedAt: canonicalTimestamp(value.observedAt, "variant observedAt"),
    entityId
  });
}

function normalizeEntity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("canonical entity must be an object");
  const entityId = boundedText(value.entityId, "entityId", { maximum: 96, code: true });
  if (!Array.isArray(value.variants) || value.variants.length === 0 || value.variants.length > 100) {
    throw new TypeError("canonical entity variants must contain between 1 and 100 entries");
  }
  const variants = value.variants.map((variant) => normalizeVariant(variant, entityId));
  const uniqueMints = new Set(variants.map((variant) => variant.mint));
  if (uniqueMints.size !== variants.length) throw new TypeError(`canonical entity ${entityId} contains duplicate mints`);
  const primaryMint = value.primaryMint === null || value.primaryMint === undefined
    ? null
    : mint(value.primaryMint, "primaryMint");
  if (primaryMint !== null && !uniqueMints.has(primaryMint)) throw new TypeError(`canonical entity ${entityId} primaryMint must be one of its variants`);
  return Object.freeze({
    entityId,
    displayName: boundedText(value.displayName, "displayName", { maximum: 120 }),
    symbol: boundedText(value.symbol, "symbol", { maximum: 24, optional: true }),
    reviewState: member(value.reviewState, reviewStates, "entity reviewState"),
    primaryMint,
    variants: Object.freeze(variants)
  });
}

function normalizeRelationship(value, registeredMints) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("canonical relationship must be an object");
  const fromMint = mint(value.fromMint, "relationship fromMint");
  const toMint = mint(value.toMint, "relationship toMint");
  if (fromMint === toMint) throw new TypeError("canonical relationship endpoints must be different mints");
  if (!registeredMints.has(fromMint) || !registeredMints.has(toMint)) {
    throw new TypeError("canonical relationship endpoints must both be registered variants");
  }
  return Object.freeze({
    relationshipId: boundedText(value.relationshipId, "relationshipId", { maximum: 128, code: true }),
    fromMint,
    toMint,
    kind: member(value.kind, relationshipKinds, "relationship kind"),
    reviewState: member(value.reviewState, reviewStates, "relationship reviewState"),
    evidenceClass: member(value.evidenceClass, evidenceClasses, "relationship evidenceClass"),
    observedAt: canonicalTimestamp(value.observedAt, "relationship observedAt")
  });
}

export function validateCanonicalEntity(value) {
  return normalizeEntity(value);
}

export function validateCanonicalRelationship(value, registeredMints) {
  const mintSet = registeredMints instanceof Set
    ? new Map([...registeredMints].map((value) => [value, true]))
    : registeredMints;
  if (!mintSet || typeof mintSet.has !== "function") throw new TypeError("registeredMints must support exact membership checks");
  return normalizeRelationship(value, mintSet);
}

function singletonResolution(exactMint, token) {
  const displayName = typeof token?.name === "string" && token.name.trim()
    ? token.name.trim().slice(0, 120)
    : typeof token?.symbol === "string" && token.symbol.trim()
      ? token.symbol.trim().slice(0, 24)
      : `Mint ${exactMint.slice(0, 6)}…${exactMint.slice(-4)}`;
  const symbol = typeof token?.symbol === "string" && token.symbol.trim()
    ? token.symbol.trim().slice(0, 24)
    : null;
  return {
    schemaVersion: 1,
    resolvedBy: "singleton-exact-mint",
    mint: exactMint,
    entity: {
      entityId: `mint:${exactMint}`,
      displayName,
      symbol,
      reviewState: "proposed"
    },
    variant: {
      mint: exactMint,
      kind: "unresolved",
      reviewState: "proposed",
      evidenceClass: "unavailable"
    },
    primary: {
      mint: exactMint,
      selectionReason: "only-exact-mint",
      meaning: "identity resolution only; not a safety, quality, or trade recommendation"
    },
    relationships: [],
    limitations: [
      "No reviewed cross-mint relationship is registered.",
      "Matching names, symbols, images, or narratives never merge mints automatically."
    ]
  };
}

export class CanonicalRegistry {
  constructor({ entities = [], relationships = [] } = {}) {
    if (!Array.isArray(entities) || !Array.isArray(relationships)) throw new TypeError("canonical registry inputs must be arrays");
    this.entities = Object.freeze(entities.map(normalizeEntity));
    this.entityByMint = new Map();
    for (const entity of this.entities) {
      for (const variant of entity.variants) {
        if (this.entityByMint.has(variant.mint)) throw new TypeError(`canonical mint ${variant.mint} belongs to more than one entity`);
        this.entityByMint.set(variant.mint, entity);
      }
    }
    this.relationships = Object.freeze(relationships.map((relationship) => normalizeRelationship(relationship, this.entityByMint)));
    const relationshipIds = new Set(this.relationships.map(({ relationshipId }) => relationshipId));
    if (relationshipIds.size !== this.relationships.length) throw new TypeError("canonical relationship IDs must be unique");
  }

  resolveMint(value, { token = null } = {}) {
    const exactMint = mint(value);
    const entity = this.entityByMint.get(exactMint);
    if (!entity) return singletonResolution(exactMint, token);
    const variant = entity.variants.find((candidate) => candidate.mint === exactMint);
    const primaryMint = entity.primaryMint ?? (entity.variants.length === 1 ? entity.variants[0].mint : null);
    return {
      schemaVersion: 1,
      resolvedBy: "reviewed-registry-variant",
      mint: exactMint,
      entity: {
        entityId: entity.entityId,
        displayName: entity.displayName,
        symbol: entity.symbol,
        reviewState: entity.reviewState
      },
      variant,
      primary: {
        mint: primaryMint,
        selectionReason: entity.primaryMint ? "explicit-reviewed-primary" : primaryMint ? "only-reviewed-variant" : "withheld-ambiguous",
        meaning: "identity resolution only; not a safety, quality, or trade recommendation"
      },
      relationships: this.relationships.filter((relationship) => relationship.fromMint === exactMint || relationship.toMint === exactMint),
      limitations: primaryMint === null
        ? ["Primary mint is withheld until a reviewed selection exists."]
        : []
    };
  }
}
