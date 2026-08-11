import { createHmac } from "node:crypto";
import { createActorLabel } from "./early-actors.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const RAW_IDENTITY_KEYS = new Set(["creator", "deployer", "caller", "traderPublicKey", "actorAddress"]);
const SCALAR = Symbol("public scalar");
const SCALAR_ARRAY = Symbol("public scalar array");
const IDENTIFIER = Symbol("public identifier");
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RAW_SOCIAL_PROFILE = /(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)\]}>"']+)/i;
const SOLANA_IDENTITY_FRAGMENT = /[1-9A-HJ-NP-Za-km-z]{32,}/;

const PUBLIC_RISK_FACTOR_SCHEMAS = Object.freeze({
  concentration: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, sourceStatus: SCALAR, missingReasonCode: SCALAR,
    lastAttemptAt: SCALAR, nextAttemptAt: SCALAR, holderCount: SCALAR, top10Percentage: SCALAR,
    providerUpdatedAt: SCALAR, fetchedAt: SCALAR, source: SCALAR, sourceFields: SCALAR_ARRAY
  }),
  developer: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, sourceStatus: SCALAR, missingReasonCode: SCALAR,
    lastAttemptAt: SCALAR, nextAttemptAt: SCALAR, holdingPercentage: SCALAR, fetchedAt: SCALAR,
    source: SCALAR, sourceField: SCALAR
  }),
  creatorHistory: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, observedLaunchCount: SCALAR, role: SCALAR,
    source: SCALAR, sourceFields: SCALAR_ARRAY, calculatedAt: SCALAR, scope: SCALAR
  }),
  identity: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, sourceStatus: SCALAR, missingReasonCode: SCALAR,
    lastAttemptAt: SCALAR, nextAttemptAt: SCALAR, exactDuplicateCount: SCALAR,
    exactDuplicateCounts: Object.freeze({
      xHandle: SCALAR, telegramHandle: SCALAR, websiteDomain: SCALAR, nameSymbol: SCALAR
    }),
    nameSymbolCollisionCount: SCALAR, basis: SCALAR, source: SCALAR, sourceFields: SCALAR_ARRAY,
    calculatedAt: SCALAR, scope: SCALAR
  }),
  liquidity: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, sourceStatus: SCALAR, missingReasonCode: SCALAR,
    lastAttemptAt: SCALAR, nextAttemptAt: SCALAR, liquidityUsd: SCALAR, observedAt: SCALAR,
    source: SCALAR, sourceField: SCALAR, basis: SCALAR, endpoint: SCALAR, pool: IDENTIFIER,
    providerPage: SCALAR, providerRank: SCALAR
  }),
  curve: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, virtualSolReserve: SCALAR, launchSolAmount: SCALAR,
    observedAt: SCALAR, source: SCALAR, sourceFields: SCALAR_ARRAY
  }),
  lifecycle: Object.freeze({
    evidenceClass: SCALAR, limitation: SCALAR, migrationObserved: SCALAR, observedAt: SCALAR,
    source: SCALAR, sourceField: SCALAR
  })
});

const PUBLIC_DUPLICATE_EVIDENCE_SCHEMA = Object.freeze({ value: SCALAR, evidenceClass: SCALAR });
const PUBLIC_RISK_IDENTITY_SCHEMA = Object.freeze({
  schemaVersion: SCALAR,
  methodVersion: SCALAR,
  parserRevision: SCALAR,
  parserAuditRevision: SCALAR,
  parserAuditAt: SCALAR,
  parserAttemptRevision: SCALAR,
  parserAttemptAt: SCALAR,
  parserAttemptStatus: SCALAR,
  overallEvidence: SCALAR,
  rankingImpact: SCALAR,
  factors: PUBLIC_RISK_FACTOR_SCHEMAS,
  duplicateEvidence: Object.freeze({
    exactDeclaredIdentifierReuse: PUBLIC_DUPLICATE_EVIDENCE_SCHEMA,
    duplicateContent: PUBLIC_DUPLICATE_EVIDENCE_SCHEMA,
    likelyController: PUBLIC_DUPLICATE_EVIDENCE_SCHEMA,
    maliciousness: PUBLIC_DUPLICATE_EVIDENCE_SCHEMA
  }),
  providerObservation: Object.freeze({
    sourceStatus: SCALAR, missingReasonCode: SCALAR, lastAttemptAt: SCALAR, nextAttemptAt: SCALAR
  }),
  missing: SCALAR_ARRAY
});

const PUBLIC_TOKEN_SCHEMA = Object.freeze({
  ingestSchemaVersion: SCALAR,
  mint: IDENTIFIER,
  name: SCALAR,
  symbol: SCALAR,
  createdAt: SCALAR,
  graduatedAt: SCALAR,
  status: SCALAR,
  narrative: SCALAR,
  marketCap: SCALAR,
  marketCapSol: SCALAR,
  marketCapEvidence: Object.freeze({ evidenceClass: SCALAR, basis: SCALAR, solUsd: SCALAR }),
  volume5m: SCALAR,
  priceChange5m: SCALAR,
  uniqueBuyers: SCALAR,
  buyRatio: SCALAR,
  bondingProgress: SCALAR,
  momentum: SCALAR,
  risk: SCALAR,
  curveSol: SCALAR,
  launchSolAmount: SCALAR,
  source: SCALAR,
  riskConfidence: SCALAR,
  calloutCount: SCALAR,
  legacySemanticsWithheld: SCALAR,
  migrationEvidence: Object.freeze({
    evidenceClass: SCALAR, source: SCALAR, observedAt: SCALAR, pool: IDENTIFIER, limitation: SCALAR
  }),
  riskIdentity: PUBLIC_RISK_IDENTITY_SCHEMA
});
const PUBLIC_CALLOUT_SCHEMA = Object.freeze({
  mint: IDENTIFIER,
  name: SCALAR,
  symbol: SCALAR,
  calloutPrice: SCALAR,
  multiple: SCALAR,
  maxPriceSol: SCALAR,
  marketCap: SCALAR,
  createdAt: SCALAR,
  source: SCALAR,
  confidence: SCALAR
});

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function publicScalar(value, { identifier = false } = {}) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  if (typeof value !== "string" || !value || value.length > 2_048 || CONTROL.test(value)
    || RAW_SOCIAL_PROFILE.test(value)) return false;
  if (identifier) return !SOLANA_IDENTITY_FRAGMENT.test(value) || SOLANA_ADDRESS.test(value);
  return !SOLANA_IDENTITY_FRAGMENT.test(value);
}

function projectAllowlisted(value, schema) {
  if (schema === SCALAR) return publicScalar(value) ? value : undefined;
  if (schema === IDENTIFIER) return publicScalar(value, { identifier: true }) ? value : undefined;
  if (schema === SCALAR_ARRAY) {
    return Array.isArray(value) && value.every((entry) => publicScalar(entry)) ? [...value] : undefined;
  }
  if (!plainObject(value)) return undefined;
  const projected = {};
  for (const [key, childSchema] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key)) continue;
    const child = projectAllowlisted(value[key], childSchema);
    if (child !== undefined) projected[key] = child;
  }
  return projected;
}

function keyMaterial(value) {
  const secret = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!secret || secret.length !== 32) throw new TypeError("installation secret must contain exactly 32 private bytes");
  return secret;
}

function identity(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 256 || CONTROL.test(normalized)) throw new TypeError(`${label} must be bounded identity text`);
  return normalized;
}

export function opaqueActorLabel(value, { installationSecret, namespace = "identity" } = {}) {
  const secret = keyMaterial(installationSecret);
  const normalized = identity(value, "identity");
  const domain = identity(namespace, "identity namespace").toLowerCase();
  const digest = createHmac("sha256", secret)
    .update("pump-war-room/public-actor-v1\0")
    .update(domain)
    .update("\0")
    .update(normalized)
    .digest();
  secret.fill(0);
  const number = (digest.readBigUInt64BE(0) & 0x7fffffffffffffffn) + 1n;
  digest.fill(0);
  return `Actor ${number}`;
}

export function projectPublicToken(token, { installationSecret } = {}) {
  if (!plainObject(token)) return null;
  const projected = projectAllowlisted(token, PUBLIC_TOKEN_SCHEMA);
  if (typeof token.creator === "string" && token.creator.trim()) {
    try { projected.creatorActor = createActorLabel(token.creator, { installationSecret }); }
    catch {}
  }
  if (typeof token.deployer === "string" && token.deployer.trim()) {
    try { projected.deployerActor = createActorLabel(token.deployer, { installationSecret }); }
    catch {}
  }
  return projected;
}

export function projectPublicCallout(callout, { installationSecret } = {}) {
  if (!plainObject(callout)) return null;
  const projected = projectAllowlisted(callout, PUBLIC_CALLOUT_SCHEMA);
  if (typeof callout.caller === "string" && callout.caller.trim() && callout.caller.trim().toLowerCase() !== "unknown") {
    try { projected.sourceActor = opaqueActorLabel(callout.caller, { installationSecret, namespace: "bark-profile" }); }
    catch { projected.sourceActor = null; }
  } else projected.sourceActor = typeof callout.sourceActor === "string" && /^Actor [1-9][0-9]{0,19}$/.test(callout.sourceActor)
    ? callout.sourceActor : null;
  if (typeof callout.mint === "string" && callout.mint.trim()) {
    projected.url = `https://pump.fun/coin/${encodeURIComponent(callout.mint.trim())}`;
  } else {
    delete projected.url;
  }
  return projected;
}

export function containsRawIdentityKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRawIdentityKey);
  return Object.entries(value).some(([key, entry]) => RAW_IDENTITY_KEYS.has(key) || containsRawIdentityKey(entry));
}
