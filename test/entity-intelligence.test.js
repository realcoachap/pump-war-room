import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityIntelligence,
  ENTITY_INTELLIGENCE_METHOD_VERSION,
  ENTITY_TREND_POLICY,
  paginateEntityIntelligence
} from "../src/entity-intelligence.js";

const mintA = "11111111111111111111111111111111";
const mintB = "So11111111111111111111111111111111111111112";
const mintC = "SysvarRent111111111111111111111111111111111";
const at = "2026-08-10T12:30:00.000Z";
function generatedMint(index) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index + 1, 28);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (numeric > 0n) {
    encoded = alphabet[Number(numeric % 58n)] + encoded;
    numeric /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function registry() {
  return {
    entities: [{
      entityId: "reviewed-meme",
      displayName: "Reviewed Meme",
      symbol: "MEME",
      reviewState: "verified",
      primaryMint: mintA,
      variants: [
        { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
        { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at },
        { mint: mintC, kind: "migration", reviewState: "proposed", evidenceClass: "locally-derived", observedAt: at }
      ]
    }],
    relationships: []
  };
}

test("aggregates reviewed entity narratives and lifecycle without losing per-mint denominators", () => {
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: registry(),
    tokens: [
      { mint: mintA, name: "Reviewed Meme", symbol: "MEME", narrative: "AI agents", status: "bonding", createdAt: "2026-08-10T12:00:00.000Z", volume5m: 100, momentum: 40 },
      { mint: mintB, name: "Reviewed Meme Relaunch", symbol: "MEME2", narrative: "AI agents", status: "migration-observed", createdAt: "2026-08-10T12:05:00.000Z", volume5m: 900, momentum: 60 },
      { mint: mintC, name: "Unreviewed Mint", symbol: "UNR", narrative: "Politics", status: "bonding", createdAt: "2026-08-10T12:10:00.000Z", volume5m: 500, momentum: 50 }
    ],
    rankings: [
      { rank: 2, score: 60, token: { mint: mintA } },
      { rank: 1, score: 80, token: { mint: mintB } },
      { rank: 3, score: 50, token: { mint: mintC } }
    ]
  });
  assert.equal(intelligence.methodVersion, ENTITY_INTELLIGENCE_METHOD_VERSION);
  assert.equal(intelligence.rankingBoundary.policy, ENTITY_TREND_POLICY);
  assert.equal(intelligence.rankingBoundary.unreviewedProposalsUsed, false);
  assert.equal(intelligence.denominators.observedMintCount, 3);
  assert.equal(intelligence.denominators.reviewedVariantCount, 2);
  assert.equal(intelligence.denominators.groupedObservedMintCount, 2);
  assert.equal(intelligence.denominators.singletonObservedMintCount, 1);

  const reviewed = intelligence.entities.find(({ entityId }) => entityId === "reviewed-meme");
  assert.equal(reviewed.variants.registeredMintCount, 2);
  assert.equal(reviewed.variants.observedMintCount, 2);
  assert.equal(reviewed.variants.missingMintCount, 0);
  assert.deepEqual(reviewed.narratives.values, [{ name: "AI agents", mintCount: 2 }]);
  assert.deepEqual(reviewed.lifecycle.statusCounts, { bonding: 1, "migration-observed": 1 });
  assert.equal(reviewed.lifecycle.observedMintCount, 2);
  assert.equal(reviewed.lifecycle.missingMintCount, 0);
  assert.deepEqual(reviewed.volume, {
    availableMintCount: 2,
    missingMintCount: 0,
    contributingMintCount: 1,
    basis: "per-mint five-minute volume observations; entity trend uses at most one exact-mint contributor"
  });
  assert.equal(reviewed.variants.included[0].registryObservedAt, at);
  assert.equal(reviewed.variants.included[0].tokenObservedAt, "2026-08-10T12:00:00.000Z");
  assert.deepEqual(reviewed.variants.excluded, []);
  assert.deepEqual(reviewed.variants.reviewExcluded, [{
    mint: mintC,
    kind: "migration",
    reviewState: "proposed",
    evidenceClass: "locally-derived",
    registryObservedAt: at,
    reason: "variant-review-not-verified",
    denominatorImpact: "none"
  }]);
  assert.equal(reviewed.trend.contributingMint, mintA);
  assert.equal(reviewed.trend.selectionReason, "explicit-reviewed-primary");
  assert.equal(reviewed.trend.orderingBasis, "radar-evidence-score");
  assert.equal(reviewed.trend.radarScore, 60);
  assert.equal(reviewed.trend.volume5m, 100);
  assert.equal(reviewed.trend.excludedObservedMintCount, 1);
  assert.equal(reviewed.trend.summedAcrossVariants, false);
  assert.notEqual(reviewed.trend.volume5m, 1_000, "clone/variant volume must never be summed");

  const singleton = intelligence.entities.find(({ entityId }) => entityId === `~mint:${mintC}`);
  assert.equal(singleton.reviewState, "singleton-unreviewed");
  assert.equal(singleton.trend.contributingMint, mintC);
  assert.equal(intelligence.entities.reduce((sum, entity) => sum + entity.variants.observedMintCount, 0), intelligence.denominators.observedMintCount);
  assert.equal(intelligence.entities.reduce((sum, entity) => sum + entity.variants.registeredMintCount, 0), 3);
  assert.equal(intelligence.trending[0].entityId, "reviewed-meme");
});

test("withholds ambiguous multi-variant trend metrics when no reviewed primary exists", () => {
  const ambiguous = registry();
  ambiguous.entities[0].primaryMint = null;
  ambiguous.entities[0].variants = ambiguous.entities[0].variants.slice(0, 2);
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: ambiguous,
    tokens: [
      { mint: mintA, createdAt: at, status: "bonding", volume5m: 100, momentum: 40 },
      { mint: mintB, createdAt: at, status: "bonding", volume5m: 90, momentum: 60 }
    ],
    rankings: [
      { rank: 1, score: 80, token: { mint: mintB } },
      { rank: 2, score: 60, token: { mint: mintA } }
    ]
  });
  const reviewed = intelligence.entities.find(({ entityId }) => entityId === "reviewed-meme");
  assert.equal(reviewed.trend.contributingMint, null);
  assert.equal(reviewed.trend.selectionReason, "withheld-ambiguous-no-reviewed-primary");
  assert.equal(reviewed.trend.orderingBasis, null);
  assert.equal(reviewed.trend.radarScore, null);
  assert.equal(reviewed.trend.volume5m, null);
  assert.equal(reviewed.trend.summedAcrossVariants, false);
  assert.deepEqual(intelligence.trending, []);
});

test("keeps missing reviewed variants explicit and withholds entity trends without an observed mint", () => {
  const intelligence = buildEntityIntelligence({ tokens: [], registry: registry(), generatedAt: at });
  const [reviewed] = intelligence.entities;
  assert.equal(reviewed.entityId, "reviewed-meme");
  assert.equal(reviewed.variants.registeredMintCount, 2);
  assert.equal(reviewed.variants.observedMintCount, 0);
  assert.equal(reviewed.variants.missingMintCount, 2);
  assert.equal(reviewed.narratives.missingMintCount, 2);
  assert.equal(reviewed.lifecycle.missingMintCount, 2);
  assert.equal(reviewed.volume.availableMintCount, 0);
  assert.equal(reviewed.volume.missingMintCount, 2);
  assert.equal(reviewed.volume.contributingMintCount, 0);
  assert.equal(reviewed.trend.contributingMint, null);
  assert.equal(reviewed.trend.volume5m, null);
  assert.deepEqual(intelligence.trending, []);
});

test("does not publish a proposed primary and retains null missing semantics", () => {
  const proposedPrimary = registry();
  proposedPrimary.entities[0].primaryMint = mintC;
  proposedPrimary.entities[0].variants = [proposedPrimary.entities[0].variants[0], proposedPrimary.entities[0].variants[2]];
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: proposedPrimary,
    tokens: [
      { mint: mintA, createdAt: "2026-08-10T12:00:00.000Z" },
      { mint: mintC, createdAt: "2026-08-10T12:10:00.000Z", status: "not valid!", volume5m: 0 }
    ]
  });
  const reviewed = intelligence.entities.find(({ entityId }) => entityId === "reviewed-meme");
  assert.equal(reviewed.primary.mint, null);
  assert.equal(reviewed.trend.contributingMint, mintA);
  assert.equal(reviewed.trend.selectionReason, "sole-reviewed-variant");
  assert.equal(reviewed.trend.volume5m, null);
  assert.equal(reviewed.lifecycle.observedMintCount, 0);
  assert.equal(reviewed.lifecycle.missingMintCount, 1);
  assert.equal(reviewed.volume.availableMintCount, 0);
  assert.equal(reviewed.volume.missingMintCount, 1);
  assert.equal(reviewed.volume.contributingMintCount, 0);
  assert.equal(intelligence.entities.find(({ entityId }) => entityId === `~mint:${mintC}`).trend.volume5m, 0);
});

test("drops verified shells with no verified membership so resolver and aggregates agree", () => {
  const inactive = registry();
  inactive.entities[0].variants = [inactive.entities[0].variants[2]];
  inactive.entities[0].primaryMint = mintC;
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: inactive,
    tokens: [{ mint: mintC, createdAt: at, status: "bonding", volume5m: 12 }]
  });
  assert.equal(intelligence.denominators.reviewedEntityCount, 0);
  assert.equal(intelligence.denominators.reviewedVariantCount, 0);
  assert.equal(intelligence.entities.some(({ entityId }) => entityId === "reviewed-meme"), false);
  assert.equal(intelligence.entities[0].entityId, `~mint:${mintC}`);
});

test("paginates in stable entity-id order with opaque bounded cursors", () => {
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    tokens: [
      { mint: mintA, createdAt: at, status: "bonding" },
      { mint: mintB, createdAt: at, status: "bonding" },
      { mint: mintC, createdAt: at, status: "bonding" }
    ]
  });
  const first = paginateEntityIntelligence(intelligence, { limit: 2 });
  assert.equal(first.page.order, "entity-id-ascending");
  assert.equal(first.page.count, 2);
  assert.match(first.page.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = paginateEntityIntelligence(intelligence, { limit: 2, cursor: first.page.nextCursor });
  assert.equal(second.page.count, 1);
  assert.equal(second.page.nextCursor, null);
  assert.deepEqual([...first.entities, ...second.entities].map(({ entityId }) => entityId), intelligence.entities.map(({ entityId }) => entityId));
  assert.throws(() => paginateEntityIntelligence(intelligence, { limit: 0 }), /between 1 and 100/);
  assert.throws(() => paginateEntityIntelligence(intelligence, { cursor: "not-a-valid-cursor" }), /cursor is invalid/);
  const invalidSingletonCursor = Buffer.from(JSON.stringify({ v: 1, after: `~mint:${"z".repeat(44)}` })).toString("base64url");
  assert.throws(() => paginateEntityIntelligence(intelligence, { cursor: invalidSingletonCursor }), /cursor is invalid/);
});

test("rejects lexical base58 strings that do not decode to 32-byte Solana mints", () => {
  for (const mint of ["z".repeat(44), "1".repeat(44), "2".repeat(32)]) {
    assert.throws(() => buildEntityIntelligence({ generatedAt: at, tokens: [{ mint }] }), /canonical Solana mints/);
  }
});

test("removes embedded Solana identity material from controlled display labels", () => {
  const rawIdentityLabel = `xx${mintB}`;
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    tokens: [{ mint: mintA, name: rawIdentityLabel, symbol: rawIdentityLabel, narrative: rawIdentityLabel, createdAt: at }]
  });
  const [singleton] = intelligence.entities;
  assert.equal(singleton.displayName.includes(mintB), false);
  assert.equal(singleton.symbol, null);
  assert.equal(singleton.variants.included[0].name, null);
  assert.equal(singleton.variants.included[0].narrative, null);
});

test("removes punctuation-prefixed social identities from controlled labels", () => {
  for (const label of ["x:@private_profile", "telegram:@private_group", "link:https://x.com/private_profile"]) {
    const intelligence = buildEntityIntelligence({
      generatedAt: at,
      tokens: [{ mint: mintA, name: label, narrative: label, createdAt: at }]
    });
    const [singleton] = intelligence.entities;
    assert.equal(singleton.variants.included[0].name, null);
    assert.equal(singleton.variants.included[0].narrative, null);
    assert.equal(JSON.stringify(singleton).includes("private_"), false);
  }
});

test("synthetic singleton namespace cannot collide with reviewed entity IDs", () => {
  const colliding = {
    entities: [{
      entityId: `mint:${mintA}`,
      displayName: "Legacy collision",
      symbol: null,
      reviewState: "verified",
      primaryMint: mintB,
      variants: [{ mint: mintB, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
    }],
    relationships: []
  };
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: colliding,
    tokens: [{ mint: mintA, createdAt: at }, { mint: mintB, createdAt: at }]
  });
  assert.deepEqual(intelligence.entities.map(({ entityId }) => entityId), [`mint:${mintA}`, `~mint:${mintA}`].sort());
  const first = paginateEntityIntelligence(intelligence, { limit: 1 });
  const second = paginateEntityIntelligence(intelligence, { limit: 1, cursor: first.page.nextCursor });
  assert.equal(new Set([...first.entities, ...second.entities].map(({ entityId }) => entityId)).size, 2);
});

test("orders tied null-metric entity trends by token observation recency", () => {
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    tokens: [
      { mint: mintA, createdAt: "2026-08-10T12:00:00.000Z" },
      { mint: mintB, createdAt: "2026-08-10T12:10:00.000Z" }
    ]
  });
  assert.deepEqual(intelligence.trending.map(({ trend }) => trend.contributingMint), [mintB, mintA]);
  assert.equal(intelligence.trending[0].trend.volume5m, null);
  assert.ok(intelligence.trending.every(({ trend }) => trend.orderingBasis === "token-observation-recency-fallback"));
});

test("does not rank an evidence-free timestampless contributor as a trend", () => {
  const intelligence = buildEntityIntelligence({ generatedAt: at, tokens: [{ mint: mintA }] });
  assert.equal(intelligence.entities[0].trend.contributingMint, mintA);
  assert.equal(intelligence.entities[0].trend.orderingBasis, null);
  assert.deepEqual(intelligence.trending, []);
});

test("rejects duplicate or malformed token identities instead of double counting them", () => {
  const token = { mint: mintA, createdAt: at, status: "bonding" };
  assert.throws(() => buildEntityIntelligence({ tokens: [token, token], generatedAt: at }), /duplicated/);
  assert.throws(() => buildEntityIntelligence({ tokens: [{ mint: "bad" }], generatedAt: at }), /canonical Solana mints/);
  assert.throws(() => buildEntityIntelligence({ tokens: [], generatedAt: "not-a-time" }), /generatedAt/);
});

test("does not brick snapshots when the reviewed registry grows beyond one import batch", () => {
  const entities = Array.from({ length: 501 }, (_, index) => ({
    entityId: `reviewed-entity-${String(index).padStart(3, "0")}`,
    displayName: `Reviewed entity ${index}`,
    symbol: null,
    reviewState: "verified",
    primaryMint: generatedMint(index),
    variants: [{
      mint: generatedMint(index),
      kind: "official",
      reviewState: "verified",
      evidenceClass: "on-chain-finalized",
      observedAt: at
    }]
  }));
  const intelligence = buildEntityIntelligence({ tokens: [], registry: { entities, relationships: [] }, generatedAt: at });
  assert.equal(intelligence.denominators.reviewedEntityCount, 501);
  assert.equal(intelligence.entities.length, 501);
});

test("sanitizes raw identity-shaped display labels from entity aggregates", () => {
  const unsafe = registry();
  unsafe.entities[0].displayName = mintC;
  unsafe.entities[0].symbol = "@private_profile";
  const intelligence = buildEntityIntelligence({
    generatedAt: at,
    registry: unsafe,
    tokens: [{ mint: mintA, name: mintC, symbol: "@private_profile", createdAt: at, status: "bonding" }]
  });
  const reviewed = intelligence.entities.find(({ entityId }) => entityId === "reviewed-meme");
  assert.equal(reviewed.displayName, "Unnamed reviewed entity");
  assert.equal(reviewed.symbol, null);
  assert.equal(reviewed.variants.included[0].name, null);
  assert.equal(reviewed.variants.included[0].symbol, null);
  assert.doesNotMatch(JSON.stringify(reviewed), /private_profile/);
});
