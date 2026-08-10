import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_RELATIONSHIP_KINDS,
  CANONICAL_VARIANT_KINDS,
  CanonicalRegistry
} from "../src/canonical-registry.js";

const mintA = "11111111111111111111111111111111";
const mintB = "22222222222222222222222222222222";
const observedAt = "2026-08-10T11:00:00.000Z";

function variant(mint, kind = "official") {
  return { mint, kind, reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt };
}

test("exports a closed relationship vocabulary", () => {
  assert.deepEqual(CANONICAL_VARIANT_KINDS, ["official", "migration", "relaunch"]);
  assert.deepEqual(CANONICAL_RELATIONSHIP_KINDS, ["same-creator", "same-narrative", "probable-copycat", "name-collision"]);
});

test("resolves every valid unknown mint as an exact singleton without merging names", () => {
  const registry = new CanonicalRegistry();
  const first = registry.resolveMint(mintA, { token: { name: "Same Name", symbol: "SAME" } });
  const second = registry.resolveMint(mintB, { token: { name: "Same Name", symbol: "SAME" } });

  assert.equal(first.resolvedBy, "singleton-exact-mint");
  assert.equal(first.entity.entityId, `mint:${mintA}`);
  assert.equal(first.primary.mint, mintA);
  assert.equal(second.entity.entityId, `mint:${mintB}`);
  assert.notEqual(first.entity.entityId, second.entity.entityId);
  assert.match(first.limitations.join(" "), /never merge mints automatically/);
});

test("resolves reviewed variants to one entity and exposes only an explicit primary", () => {
  const registry = new CanonicalRegistry({
    entities: [{
      entityId: "example-meme",
      displayName: "Example Meme",
      symbol: "MEME",
      reviewState: "verified",
      primaryMint: mintB,
      variants: [variant(mintA), variant(mintB, "migration")]
    }],
    relationships: [{
      relationshipId: "example-copycat-edge",
      fromMint: mintA,
      toMint: mintB,
      kind: "same-creator",
      reviewState: "verified",
      evidenceClass: "on-chain-finalized",
      observedAt
    }]
  });

  const resolution = registry.resolveMint(mintA);
  assert.equal(resolution.resolvedBy, "reviewed-registry-variant");
  assert.equal(resolution.entity.entityId, "example-meme");
  assert.equal(resolution.variant.kind, "official");
  assert.deepEqual(resolution.primary, {
    mint: mintB,
    selectionReason: "explicit-reviewed-primary",
    meaning: "identity resolution only; not a safety, quality, or trade recommendation"
  });
  assert.equal(resolution.relationships[0].kind, "same-creator");
});

test("withholds a primary when a multi-variant entity has no reviewed choice", () => {
  const registry = new CanonicalRegistry({ entities: [{
    entityId: "ambiguous-meme",
    displayName: "Ambiguous Meme",
    reviewState: "proposed",
    variants: [variant(mintA), variant(mintB, "relaunch")]
  }] });
  const resolution = registry.resolveMint(mintB);
  assert.equal(resolution.primary.mint, null);
  assert.equal(resolution.primary.selectionReason, "withheld-ambiguous");
});

test("rejects invalid, duplicated, and cross-entity mint claims", () => {
  assert.throws(() => new CanonicalRegistry().resolveMint("not-a-mint"), /Solana base58/);
  assert.throws(() => new CanonicalRegistry({ entities: [{
    entityId: "duplicates",
    displayName: "Duplicates",
    reviewState: "verified",
    variants: [variant(mintA), variant(mintA)]
  }] }), /duplicate mints/);
  assert.throws(() => new CanonicalRegistry({ entities: [
    { entityId: "first", displayName: "First", reviewState: "verified", variants: [variant(mintA)] },
    { entityId: "second", displayName: "Second", reviewState: "verified", variants: [variant(mintA)] }
  ] }), /more than one entity/);
});

