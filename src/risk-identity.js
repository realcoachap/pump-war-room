import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

export const RISK_IDENTITY_SCHEMA_VERSION = 1;
export const RISK_IDENTITY_METHOD_VERSION = "risk-identity-exact-fingerprint-v1";
export const GECKOTERMINAL_INFO_API_VERSION = "20230203";
export const RISK_IDENTITY_EVIDENCE_CLASSES = Object.freeze([
  "on-chain-finalized",
  "provider-observed",
  "feed-observed-processed",
  "locally-derived",
  "unavailable"
]);

const PROVIDER = "geckoterminal";
const NETWORK = "solana";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NETWORK_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const HEX_256 = /^[a-f0-9]{64}$/;
const MAX_WEBSITES = 16;
const MAX_ROWS = 1_000;
const MAX_TEXT = 256;

const SOURCE_FIELDS = Object.freeze({
  holderCount: "data.attributes.holders.count",
  top10HolderPercentage: "data.attributes.holders.distribution_percentage.top_10",
  providerLastUpdated: "data.attributes.holders.last_updated",
  developerHoldingPercentage: "data.attributes.developer_holding_percentage",
  developerAddress: "data.attributes.developer_address",
  xHandle: "data.attributes.twitter_handle",
  telegramHandle: "data.attributes.telegram_handle",
  websiteDomains: "data.attributes.websites",
  nameSymbol: "data.attributes.name+data.attributes.symbol"
});

export class RiskIdentityError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "RiskIdentityError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new RiskIdentityError(code, message, { cause });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireMint(value, label = "mint") {
  const mint = typeof value === "string" ? value.trim() : "";
  if (!MINT_PATTERN.test(mint)) fail("invalid-mint", `${label} must be a Solana base58 address`);
  return mint;
}

function requireNetwork(value) {
  const network = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!NETWORK_PATTERN.test(network)) fail("invalid-network", "network must be a bounded provider network ID");
  if (network !== NETWORK) fail("unsupported-network", "risk identity currently supports the Solana network only");
  return network;
}

function timestamp(value, label) {
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) {
    fail("invalid-timestamp", `${label} must be an RFC 3339 timestamp with an explicit timezone`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const civil = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const validCivilTime = year >= 1 && civil.getUTCFullYear() === year && civil.getUTCMonth() === month - 1
    && civil.getUTCDate() === day && civil.getUTCHours() === hour
    && civil.getUTCMinutes() === minute && civil.getUTCSeconds() === second;
  const validZone = zone === "Z" || (() => {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    return zoneHours <= 14 && zoneMinutes <= 59 && (zoneHours < 14 || zoneMinutes === 0);
  })();
  if (!validCivilTime || !validZone) fail("invalid-timestamp", `${label} is not a real RFC 3339 timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("invalid-timestamp", `${label} is not a real timestamp`);
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(value, label) {
  return value === null || value === undefined ? null : timestamp(value, label);
}

function boundedString(value, label, max = MAX_TEXT) {
  if (typeof value !== "string") fail("invalid-response", `${label} must be a string`);
  if (value.length > max * 4) fail("invalid-response", `${label} is too long`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    fail("invalid-response", `${label} must be bounded text without control or format characters`);
  }
  return normalized;
}

function percentage(value, label, { stringAllowed = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && !(stringAllowed && typeof value === "string")) {
    fail("invalid-response", `${label} must be a percentage`);
  }
  if (typeof value === "string" && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    fail("invalid-response", `${label} must be a decimal percentage`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    fail("invalid-response", `${label} must be between 0 and 100`);
  }
  return parsed;
}

function holderCount(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid-response", "holder count must be a non-negative safe integer");
  }
  return value;
}

function normalizedIdentityText(value, label, max) {
  return boundedString(value, label, max).replace(/\s+/gu, " ").toLowerCase();
}

function sha256(domain, ...parts) {
  const hash = createHash("sha256");
  hash.update("pump-war-room/risk-identity\0");
  hash.update(RISK_IDENTITY_METHOD_VERSION);
  hash.update("\0");
  hash.update(domain);
  for (const part of parts) {
    const value = String(part);
    hash.update("\0");
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("hex");
}

function addressFingerprint(address) {
  return sha256("solana-address", requireMint(address, "declared address"));
}

function nameSymbolFingerprint(name, symbol) {
  const normalizedName = normalizedIdentityText(name, "token name", 128);
  const normalizedSymbol = normalizedIdentityText(symbol, "token symbol", 32);
  return sha256("name-symbol", normalizedName, normalizedSymbol);
}

function normalizeHandle(value, platform) {
  if (value === null || value === undefined || value === "") return null;
  let handle = boundedString(value, `${platform} handle`, 64);
  if (handle.startsWith("@")) handle = handle.slice(1);
  const maximum = platform === "x" ? 15 : 32;
  if (!new RegExp(`^[A-Za-z0-9_]{1,${maximum}}$`).test(handle)) {
    fail("invalid-response", `${platform} handle is not a conservative provider-declared handle`);
  }
  return handle.toLowerCase();
}

function normalizeWebsite(value) {
  const raw = boundedString(value, "website", 2_048);
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    fail("invalid-response", "website must be an absolute WHATWG URL", cause);
  }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    fail("invalid-response", "website must use HTTP(S) without credentials");
  }
  const unqualifiedHost = url.hostname.replace(/\.$/, "").toLowerCase();
  const host = domainToASCII(unqualifiedHost).toLowerCase();
  const labels = host.split(".");
  if (!host || host.length > 253 || labels.length < 2 || isIP(host)
    || labels.some((label) => !label || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    fail("invalid-response", "website must contain a valid IDNA domain name");
  }
  const domain = getDomain(host, { allowPrivateDomains: true });
  if (!domain) fail("invalid-response", "website must contain a registrable public or private domain");
  url.hostname = host;
  url.hash = "";
  url.search = "";
  const website = url.toString();
  if (website.length > 2_048) fail("invalid-response", "normalized website is too long");
  return { domain, website, fingerprint: sha256("website-domain", domain) };
}

function observed(value, sourceField) {
  return { value, evidenceClass: "provider-observed", sourceField };
}

function unavailable(sourceField) {
  return { value: null, evidenceClass: "unavailable", sourceField };
}

function derivedFingerprint(fingerprint, sourceField) {
  return { fingerprint, evidenceClass: "locally-derived", sourceField };
}

function unavailableFingerprint(sourceField) {
  return { fingerprint: null, evidenceClass: "unavailable", sourceField };
}

function parseWebsites(value) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return { values: [], evidenceClass: "unavailable", sourceField: SOURCE_FIELDS.websiteDomains };
  }
  if (!Array.isArray(value) || value.length > MAX_WEBSITES) {
    fail("invalid-response", `websites must be an array of at most ${MAX_WEBSITES} URLs`);
  }
  const byDomain = new Map();
  for (const item of value) {
    const normalized = normalizeWebsite(item);
    const current = byDomain.get(normalized.domain);
    if (!current || lexical(normalized.website, current.website) < 0) {
      byDomain.set(normalized.domain, normalized);
    }
  }
  return {
    values: [...byDomain.values()]
      .sort((left, right) => lexical(left.domain, right.domain) || lexical(left.website, right.website))
      .map(({ fingerprint }) => ({ fingerprint })),
    evidenceClass: "locally-derived",
    sourceField: SOURCE_FIELDS.websiteDomains
  };
}

/**
 * Parse only the documented GeckoTerminal token-info fields used by this
 * method. Unknown provider keys are deliberately not copied into the result.
 */
export function parseGeckoTerminalTokenInfo(payload, {
  mint: mintValue,
  network: networkValue = NETWORK,
  fetchedAt
} = {}) {
  const mint = requireMint(mintValue);
  const network = requireNetwork(networkValue);
  const fetchedIso = timestamp(fetchedAt, "fetchedAt");
  if (!plainObject(payload) || !plainObject(payload.data) || !plainObject(payload.data.attributes)) {
    fail("invalid-response", "token-info response must contain data.attributes");
  }
  if (payload.data.type !== "token") fail("invalid-response", "token-info data type must be token");
  if (payload.data.id !== `${network}_${mint}` || payload.data.attributes.address !== mint) {
    fail("token-mismatch", "token-info identity did not match the requested network and mint");
  }

  const attributes = payload.data.attributes;
  let holders = null;
  if (attributes.holders !== null && attributes.holders !== undefined) {
    if (!plainObject(attributes.holders)) fail("invalid-response", "holders must be an object when present");
    holders = attributes.holders;
  }
  let distribution = null;
  if (holders?.distribution_percentage !== null && holders?.distribution_percentage !== undefined) {
    if (!plainObject(holders.distribution_percentage)) {
      fail("invalid-response", "holder distribution_percentage must be an object when present");
    }
    distribution = holders.distribution_percentage;
  }

  const count = holderCount(holders?.count);
  const top10 = percentage(distribution?.top_10, "top-10 holder distribution", { stringAllowed: true });
  const lastUpdated = optionalTimestamp(holders?.last_updated, "holders.last_updated");
  const developerHolding = percentage(attributes.developer_holding_percentage, "developer holding percentage");
  const developerAddress = attributes.developer_address === null || attributes.developer_address === undefined || attributes.developer_address === ""
    ? null
    : addressFingerprint(attributes.developer_address);
  const xHandle = normalizeHandle(attributes.twitter_handle, "x");
  const telegramHandle = normalizeHandle(attributes.telegram_handle, "telegram");

  let normalizedNameSymbol = null;
  const nameMissing = attributes.name === null || attributes.name === undefined || attributes.name === "";
  const symbolMissing = attributes.symbol === null || attributes.symbol === undefined || attributes.symbol === "";
  if (!nameMissing && !symbolMissing) normalizedNameSymbol = nameSymbolFingerprint(attributes.name, attributes.symbol);
  else if (nameMissing !== symbolMissing) {
    // A partial pair cannot support an exact pair fingerprint, but remains
    // unavailable instead of inventing the absent component.
    if (!nameMissing) boundedString(attributes.name, "token name", 128);
    if (!symbolMissing) boundedString(attributes.symbol, "token symbol", 32);
  }

  const endpoint = `/networks/${network}/tokens/${mint}/info`;
  return {
    schemaVersion: RISK_IDENTITY_SCHEMA_VERSION,
    mint,
    network,
    provider: PROVIDER,
    source: PROVIDER,
    endpoint,
    apiVersion: GECKOTERMINAL_INFO_API_VERSION,
    fetchedAt: fetchedIso,
    methodVersion: RISK_IDENTITY_METHOD_VERSION,
    factors: {
      holderCount: count === null ? unavailable(SOURCE_FIELDS.holderCount) : observed(count, SOURCE_FIELDS.holderCount),
      top10HolderPercentage: top10 === null ? unavailable(SOURCE_FIELDS.top10HolderPercentage) : observed(top10, SOURCE_FIELDS.top10HolderPercentage),
      providerLastUpdated: lastUpdated === null ? unavailable(SOURCE_FIELDS.providerLastUpdated) : observed(lastUpdated, SOURCE_FIELDS.providerLastUpdated),
      developerHoldingPercentage: developerHolding === null ? unavailable(SOURCE_FIELDS.developerHoldingPercentage) : observed(developerHolding, SOURCE_FIELDS.developerHoldingPercentage)
    },
    fingerprints: {
      developerAddress: developerAddress === null
        ? unavailableFingerprint(SOURCE_FIELDS.developerAddress)
        : derivedFingerprint(developerAddress, SOURCE_FIELDS.developerAddress),
      xHandle: xHandle === null
        ? unavailableFingerprint(SOURCE_FIELDS.xHandle)
        : derivedFingerprint(sha256("x-handle", xHandle), SOURCE_FIELDS.xHandle),
      telegramHandle: telegramHandle === null
        ? unavailableFingerprint(SOURCE_FIELDS.telegramHandle)
        : derivedFingerprint(sha256("telegram-handle", telegramHandle), SOURCE_FIELDS.telegramHandle),
      websiteDomains: parseWebsites(attributes.websites),
      nameSymbol: normalizedNameSymbol === null
        ? unavailableFingerprint(SOURCE_FIELDS.nameSymbol)
        : derivedFingerprint(normalizedNameSymbol, SOURCE_FIELDS.nameSymbol)
    }
  };
}

function tokenTimestamp(row) {
  const candidate = row?.observedAt ?? row?.createdAt;
  try {
    return optionalTimestamp(candidate, "token observation timestamp");
  } catch {
    return null;
  }
}

function optionalAddressFingerprint(value) {
  if (value === null || value === undefined || value === "" || value === "unknown") return null;
  try {
    return addressFingerprint(value);
  } catch {
    return null;
  }
}

function optionalNameSymbolFingerprint(name, symbol) {
  if (name === null || name === undefined || name === "" || symbol === null || symbol === undefined || symbol === "") return null;
  try {
    return nameSymbolFingerprint(name, symbol);
  } catch {
    return null;
  }
}

/** Normalize the minimum token-row identity needed by the aggregate. */
export function deriveTokenIdentityEvidence(tokenRows = []) {
  if (!Array.isArray(tokenRows) || tokenRows.length > MAX_ROWS) {
    throw new TypeError(`tokenRows must be an array of at most ${MAX_ROWS} rows`);
  }
  return tokenRows.flatMap((row) => {
    if (!plainObject(row)) return [];
    let mint;
    try { mint = requireMint(row.mint, "token row mint"); }
    catch { return []; }
    const observedAt = tokenTimestamp(row);
    const source = typeof row.source === "string" ? row.source.trim().toLowerCase() : null;
    const prospectiveDeclaration = row.prospectivelyObserved === true
      || (row.prospectivelyObserved !== false && source === "pumpportal");
    const prospectivelyObserved = prospectiveDeclaration && observedAt !== null;
    const creatorFingerprint = prospectivelyObserved ? optionalAddressFingerprint(row.creator) : null;
    const deployerFingerprint = prospectivelyObserved ? optionalAddressFingerprint(row.deployer) : null;
    const nameSymbol = optionalNameSymbolFingerprint(row.name, row.symbol);
    return [{
      mint,
      prospectivelyObserved,
      observedAt: prospectivelyObserved ? observedAt : null,
      nameSymbol: nameSymbol === null
        ? { fingerprint: null, evidenceClass: "unavailable" }
        : { fingerprint: nameSymbol, evidenceClass: "locally-derived" },
      declaredCreator: creatorFingerprint === null
        ? { fingerprint: null, evidenceClass: "unavailable" }
        : { fingerprint: creatorFingerprint, evidenceClass: "locally-derived" },
      declaredDeployer: deployerFingerprint === null
        ? { fingerprint: null, evidenceClass: "unavailable" }
        : { fingerprint: deployerFingerprint, evidenceClass: "locally-derived" }
    }];
  });
}

function validFingerprint(value) {
  return typeof value === "string" && HEX_256.test(value);
}

function addFingerprint(target, kind, fingerprint, mint) {
  if (!validFingerprint(fingerprint)) return;
  let byFingerprint = target.get(kind);
  if (!byFingerprint) {
    byFingerprint = new Map();
    target.set(kind, byFingerprint);
  }
  let mints = byFingerprint.get(fingerprint);
  if (!mints) {
    mints = new Set();
    byFingerprint.set(fingerprint, mints);
  }
  mints.add(mint);
}

function mintFingerprintSet(target, kind, mint, fingerprint) {
  if (!validFingerprint(fingerprint)) return;
  let byMint = target.get(kind);
  if (!byMint) {
    byMint = new Map();
    target.set(kind, byMint);
  }
  let values = byMint.get(mint);
  if (!values) {
    values = new Set();
    byMint.set(mint, values);
  }
  values.add(fingerprint);
}

function countOtherMints(kind, mint, groups, fingerprintsByMint) {
  const fingerprints = fingerprintsByMint.get(kind)?.get(mint);
  if (!fingerprints?.size) return null;
  const matches = new Set();
  for (const fingerprint of fingerprints) {
    for (const matchingMint of groups.get(kind)?.get(fingerprint) || []) {
      if (matchingMint !== mint) matches.add(matchingMint);
    }
  }
  return matches.size;
}

function countLaunches(kind, mint, groups, fingerprintsByMint) {
  const fingerprints = fingerprintsByMint.get(kind)?.get(mint);
  if (!fingerprints || fingerprints.size !== 1) return null;
  return groups.get(kind)?.get([...fingerprints][0])?.size ?? null;
}

function countProviderDeveloperLaunches(mint, groups, fingerprintsByMint) {
  const fingerprints = fingerprintsByMint.get("providerDeveloper")?.get(mint);
  if (!fingerprints || fingerprints.size !== 1) return null;
  const fingerprint = [...fingerprints][0];
  const launches = new Set([
    ...(groups.get("declaredCreator")?.get(fingerprint) || []),
    ...(groups.get("declaredDeployer")?.get(fingerprint) || [])
  ]);
  return launches.size || null;
}

function countEnvelope(value) {
  return value === null
    ? { value: null, evidenceClass: "unavailable" }
    : { value, evidenceClass: "locally-derived" };
}

function unknownEnvelope() {
  return { value: null, evidenceClass: "unavailable" };
}

function assertEvidenceDocument(row) {
  if (!plainObject(row) || row.schemaVersion !== RISK_IDENTITY_SCHEMA_VERSION
    || row.methodVersion !== RISK_IDENTITY_METHOD_VERSION || row.provider !== PROVIDER
    || row.source !== PROVIDER || row.network !== NETWORK || row.apiVersion !== GECKOTERMINAL_INFO_API_VERSION
    || !plainObject(row.fingerprints)) {
    throw new TypeError("evidenceRows must contain normalized risk-identity parser objects");
  }
  const mint = requireMint(row.mint, "evidence mint");
  if (row.endpoint !== `/networks/${NETWORK}/tokens/${mint}/info`) {
    throw new TypeError("evidence endpoint did not match its mint");
  }
  timestamp(row.fetchedAt, "evidence fetchedAt");
  return mint;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains fields outside the persistence allowlist`);
  }
}

function validateFactorEnvelope(value, key) {
  exactKeys(value, ["value", "evidenceClass", "sourceField"], `risk identity factor ${key}`);
  if (value.sourceField !== SOURCE_FIELDS[key]) throw new TypeError(`risk identity factor ${key} source field is invalid`);
  const unavailableValue = value.value === null;
  if (value.evidenceClass !== (unavailableValue ? "unavailable" : "provider-observed")) {
    throw new TypeError(`risk identity factor ${key} evidence class is invalid`);
  }
  if (unavailableValue) return;
  if (key === "holderCount") holderCount(value.value);
  else if (key === "providerLastUpdated") timestamp(value.value, "providerLastUpdated");
  else percentage(value.value, key);
}

function validateFingerprintEnvelope(value, key) {
  exactKeys(value, ["fingerprint", "evidenceClass", "sourceField"], `risk identity digest ${key}`);
  if (value.sourceField !== SOURCE_FIELDS[key]) throw new TypeError(`risk identity digest ${key} source field is invalid`);
  const unavailableValue = value.fingerprint === null;
  if (value.evidenceClass !== (unavailableValue ? "unavailable" : "locally-derived")) {
    throw new TypeError(`risk identity digest ${key} evidence class is invalid`);
  }
  if (!unavailableValue && !validFingerprint(value.fingerprint)) throw new TypeError(`risk identity digest ${key} is invalid`);
}

function validateLiquidityEnvelope(value, mint) {
  const keys = [
    "schemaVersion", "source", "endpoint", "evidenceClass", "attemptedAt", "observedAt",
    "pool", "poolCreatedAt", "providerPage", "providerRank", "sourceField", "liquidityUsd",
    "missingReasonCode", "basis", "limitation"
  ];
  exactKeys(value, keys, "risk identity liquidity evidence");
  if (value.schemaVersion !== 1 || value.source !== PROVIDER
    || value.endpoint !== `/networks/${NETWORK}/tokens/${mint}/pools`
    || value.sourceField !== "data[].attributes.reserve_in_usd"
    || value.basis !== "current-provider-ranked-page-1-pool-snapshot"
    || value.limitation !== "Current GeckoTerminal-observed pool reserve is not launch-time liquidity or evidence of locked liquidity") {
    throw new TypeError("risk identity liquidity provenance is invalid");
  }
  timestamp(value.attemptedAt, "liquidity attemptedAt");
  if (value.evidenceClass === "provider-observed") {
    timestamp(value.observedAt, "liquidity observedAt");
    timestamp(value.poolCreatedAt, "liquidity poolCreatedAt");
    requireMint(value.pool, "liquidity pool");
    if (!Number.isSafeInteger(value.providerPage) || value.providerPage < 1
      || !Number.isSafeInteger(value.providerRank) || value.providerRank < 1
      || typeof value.liquidityUsd !== "number" || !Number.isFinite(value.liquidityUsd) || value.liquidityUsd < 0
      || value.missingReasonCode !== null) {
      throw new TypeError("provider-observed risk identity liquidity values are invalid");
    }
    return;
  }
  if (value.evidenceClass !== "unavailable" || value.observedAt !== null || value.pool !== null
    || value.poolCreatedAt !== null || value.providerPage !== null || value.providerRank !== null
    || value.liquidityUsd !== null || typeof value.missingReasonCode !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.missingReasonCode)) {
    throw new TypeError("unavailable risk identity liquidity values are invalid");
  }
}

/**
 * Defense-in-depth validation for the exact document persisted by the risk
 * worker. This rejects normalized identifiers and any provider field that the
 * ingestion parser did not explicitly allowlist.
 */
export function validateRiskIdentityPersistenceEvidence(value, { mint: mintValue, status } = {}) {
  const mint = requireMint(mintValue);
  if (status === "available" || plainObject(value?.factors)) {
    const keys = ["schemaVersion", "mint", "network", "provider", "source", "endpoint", "apiVersion", "fetchedAt", "methodVersion", "factors", "fingerprints"];
    if (Object.hasOwn(value, "liquidity")) keys.push("liquidity");
    exactKeys(value, keys, "risk identity evidence");
    assertEvidenceDocument(value);
    if (value.mint !== mint) throw new TypeError("risk identity evidence mint mismatch");
    exactKeys(value.factors, Object.keys(SOURCE_FIELDS).filter((key) => ["holderCount", "top10HolderPercentage", "providerLastUpdated", "developerHoldingPercentage"].includes(key)), "risk identity factors");
    for (const key of ["holderCount", "top10HolderPercentage", "providerLastUpdated", "developerHoldingPercentage"]) {
      validateFactorEnvelope(value.factors[key], key);
    }
    exactKeys(value.fingerprints, ["developerAddress", "xHandle", "telegramHandle", "websiteDomains", "nameSymbol"], "risk identity digests");
    for (const key of ["developerAddress", "xHandle", "telegramHandle", "nameSymbol"]) validateFingerprintEnvelope(value.fingerprints[key], key);
    const websites = value.fingerprints.websiteDomains;
    exactKeys(websites, ["values", "evidenceClass", "sourceField"], "risk identity website-host digests");
    if (websites.sourceField !== SOURCE_FIELDS.websiteDomains || !Array.isArray(websites.values) || websites.values.length > MAX_WEBSITES) {
      throw new TypeError("risk identity website-host digests are invalid");
    }
    const websiteClass = websites.values.length ? "locally-derived" : "unavailable";
    if (websites.evidenceClass !== websiteClass) throw new TypeError("risk identity website-host evidence class is invalid");
    for (const entry of websites.values) {
      exactKeys(entry, ["fingerprint"], "risk identity website-host digest");
      if (!validFingerprint(entry.fingerprint)) throw new TypeError("risk identity website-host digest is invalid");
    }
    if (Object.hasOwn(value, "liquidity")) validateLiquidityEnvelope(value.liquidity, mint);
    return value;
  }

  exactKeys(value, ["schemaVersion", "mint", "provider", "source", "endpoint", "apiVersion", "methodVersion", "evidenceClass", "fetchedAt", "attemptedAt", "missingReasonCode", "retention"], "unavailable risk identity evidence");
  if (value.schemaVersion !== RISK_IDENTITY_SCHEMA_VERSION || value.mint !== mint || value.provider !== PROVIDER
    || value.source !== PROVIDER || value.endpoint !== `/networks/${NETWORK}/tokens/${mint}/info`
    || value.apiVersion !== GECKOTERMINAL_INFO_API_VERSION || value.methodVersion !== RISK_IDENTITY_METHOD_VERSION
    || value.evidenceClass !== "unavailable" || value.fetchedAt !== null
    || value.retention !== "normalized-scalars-and-domain-separated-fingerprints-only") {
    throw new TypeError("unavailable risk identity evidence contract is invalid");
  }
  timestamp(value.attemptedAt, "risk identity attemptedAt");
  if (typeof value.missingReasonCode !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.missingReasonCode)) {
    throw new TypeError("unavailable risk identity missing reason is invalid");
  }
  return value;
}

/**
 * Produce descriptive exact-match counts only. A zero count means no other
 * exact match in this bounded input, never safety. The three interpretation
 * fields remain unknown because exact identity reuse does not establish them.
 */
export function aggregateRiskIdentityEvidence(evidenceRows = [], tokenRows = []) {
  if (!Array.isArray(evidenceRows) || evidenceRows.length > MAX_ROWS) {
    throw new TypeError(`evidenceRows must be an array of at most ${MAX_ROWS} rows`);
  }
  const tokenEvidence = deriveTokenIdentityEvidence(tokenRows);
  const groups = new Map();
  const fingerprintsByMint = new Map();
  const allMints = new Set();
  const providerMints = new Set();

  for (const row of evidenceRows) {
    const mint = assertEvidenceDocument(row);
    allMints.add(mint);
    providerMints.add(mint);
    const entries = [
      ["xHandle", row.fingerprints.xHandle?.fingerprint],
      ["telegramHandle", row.fingerprints.telegramHandle?.fingerprint],
      ["nameSymbol", row.fingerprints.nameSymbol?.fingerprint],
      ["providerDeveloper", row.fingerprints.developerAddress?.fingerprint]
    ];
    for (const website of row.fingerprints.websiteDomains?.values || []) {
      entries.push(["websiteDomain", website?.fingerprint]);
    }
    for (const [kind, fingerprint] of entries) {
      addFingerprint(groups, kind, fingerprint, mint);
      mintFingerprintSet(fingerprintsByMint, kind, mint, fingerprint);
    }
  }

  const prospectiveMints = new Set();
  for (const row of tokenEvidence) {
    allMints.add(row.mint);
    if (row.prospectivelyObserved) prospectiveMints.add(row.mint);
    addFingerprint(groups, "nameSymbol", row.nameSymbol.fingerprint, row.mint);
    mintFingerprintSet(fingerprintsByMint, "nameSymbol", row.mint, row.nameSymbol.fingerprint);
    mintFingerprintSet(fingerprintsByMint, "declaredCreator", row.mint, row.declaredCreator.fingerprint);
    mintFingerprintSet(fingerprintsByMint, "declaredDeployer", row.mint, row.declaredDeployer.fingerprint);
  }
  // Repeated updates for one mint never inflate launch history. Conflicting
  // declarations for the same mint/role are ambiguous and contribute no
  // address to anyone's exact launch count.
  for (const kind of ["declaredCreator", "declaredDeployer"]) {
    for (const [mint, fingerprints] of fingerprintsByMint.get(kind) || []) {
      if (fingerprints.size === 1) addFingerprint(groups, kind, [...fingerprints][0], mint);
    }
  }

  const byMintEntries = [...allMints].sort().map((mint) => {
    const exactDuplicateCounts = {
      xHandle: countEnvelope(countOtherMints("xHandle", mint, groups, fingerprintsByMint)),
      telegramHandle: countEnvelope(countOtherMints("telegramHandle", mint, groups, fingerprintsByMint)),
      websiteDomain: countEnvelope(countOtherMints("websiteDomain", mint, groups, fingerprintsByMint)),
      nameSymbol: countEnvelope(countOtherMints("nameSymbol", mint, groups, fingerprintsByMint))
    };
    const declaredIdentifierCounts = ["xHandle", "telegramHandle", "websiteDomain"]
      .map((key) => exactDuplicateCounts[key].value)
      .filter(Number.isSafeInteger);
    const exactDeclaredIdentifierReuseCount = declaredIdentifierCounts.length ? Math.max(...declaredIdentifierCounts) : null;
    return [mint, {
      mint,
      methodVersion: RISK_IDENTITY_METHOD_VERSION,
      exactDuplicateCounts,
      prospectiveLaunchCounts: {
        declaredCreator: countEnvelope(countLaunches("declaredCreator", mint, groups, fingerprintsByMint)),
        declaredDeployer: countEnvelope(countLaunches("declaredDeployer", mint, groups, fingerprintsByMint)),
        providerDeveloperAddress: countEnvelope(countProviderDeveloperLaunches(mint, groups, fingerprintsByMint))
      },
      exactDeclaredIdentifierReuse: countEnvelope(exactDeclaredIdentifierReuseCount),
      duplicateContent: unknownEnvelope(),
      likelyController: unknownEnvelope(),
      maliciousness: unknownEnvelope()
    }];
  });

  return {
    methodVersion: RISK_IDENTITY_METHOD_VERSION,
    byMint: Object.fromEntries(byMintEntries),
    coverage: {
      evidenceRowCount: evidenceRows.length,
      providerEvidenceMintCount: providerMints.size,
      tokenRowCount: tokenRows.length,
      tokenEvidenceMintCount: new Set(tokenEvidence.map((row) => row.mint)).size,
      prospectivelyObservedTokenMintCount: prospectiveMints.size,
      outputMintCount: allMints.size,
      evidenceClass: "locally-derived"
    }
  };
}
