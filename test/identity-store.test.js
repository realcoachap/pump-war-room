import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IDENTITY_PENDING_PROPOSAL_LIMIT, IDENTITY_REGISTRY_CAPACITY, Store, STORE_SCHEMA_VERSION } from "../src/store.js";
import { proposeIdentityCandidates } from "../src/identity-proposals.js";
import { createVerifiedBackup } from "../src/database-backup.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "../src/solana-rpc.js";
import { buildEntityIntelligence } from "../src/entity-intelligence.js";

const mintA = "11111111111111111111111111111111";
const mintB = "So11111111111111111111111111111111111111112";
const at = "2026-08-10T11:30:00.000Z";

function temporaryDatabase(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-identity-"));
  const databasePath = path.join(directory, "war-room.db");
  const store = new Store(databasePath);
  t.after(() => {
    try { store.db.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, databasePath };
}

function decision(decisionId, subjectType, subjectId, value = "accept") {
  return {
    decisionId,
    subjectType,
    subjectId,
    decision: value,
    reasonCode: "operator-reviewed-evidence",
    decidedAt: at
  };
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    encoded = base58Alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function generatedMint(index) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index + 1, 28);
  return encodeBase58(bytes);
}

function seedLegacyAcceptedEntities(store, count) {
  const entityInsert = store.db.prepare(`INSERT INTO identity_entities
    (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  const variantInsert = store.db.prepare(`INSERT INTO identity_variants
    (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const decisionInsert = store.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id) VALUES (?,?,?,?,?,?,?,NULL)`);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index++) {
      const entityId = `legacy-capacity-${String(index).padStart(4, "0")}`;
      const mint = generatedMint(index + 10_000);
      entityInsert.run(entityId, `Legacy capacity ${index}`, null, "verified", mint, at, at);
      variantInsert.run(mint, entityId, "official", "verified", "on-chain-finalized", at, at, at);
      decisionInsert.run(`decision:${entityId}`, "entity", entityId, "accept", "legacy-reviewed-import", "{}", at);
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function insertLegacyRelationship(store, { relationshipId, fromMint, toMint, kind = "same-creator" }) {
  store.db.prepare(`INSERT INTO identity_relationships
    (relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(relationshipId, fromMint, toMint, kind, "verified", "on-chain-finalized", at, at, at);
  store.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
    VALUES (?,?,?,?,?,?,?,NULL)`).run(`decision:${relationshipId}`, "relationship", relationshipId,
    "accept", "legacy-reviewed-import", "{}", at);
}

test("persists reviewed entities, variants, relationships, and append-only decisions", (t) => {
  const { store, databasePath } = temporaryDatabase(t);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
  const entity = {
    entityId: "same-meme",
    displayName: "Same Meme",
    symbol: "SAME",
    reviewState: "verified",
    primaryMint: mintA,
    variants: [
      { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
      { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at }
    ]
  };
  assert.equal(store.saveIdentityEntity({ entity, decision: decision("decision:entity-1", "entity", entity.entityId) }).entityId, entity.entityId);
  const relationship = {
    relationshipId: "same-meme:creator-edge",
    fromMint: mintA,
    toMint: mintB,
    kind: "same-creator",
    reviewState: "verified",
    evidenceClass: "on-chain-finalized",
    observedAt: at
  };
  assert.equal(store.saveIdentityRelationship({
    relationship,
    decision: decision("decision:relationship-1", "relationship", relationship.relationshipId)
  }).kind, "same-creator");
  assert.throws(() => store.saveIdentityRelationship({
    relationship: { ...relationship, relationshipId: "same-meme:duplicate-edge", fromMint: mintB, toMint: mintA },
    decision: decision("decision:relationship-duplicate", "relationship", "same-meme:duplicate-edge")
  }), /already reviewed/);
  const { projection, ...coverage } = store.identityRegistryCoverage();
  assert.deepEqual(coverage, {
    entityCount: 1,
    variantCount: 2,
    relationshipCount: 1,
    verifiedEntityCount: 1,
    verifiedVariantCount: 2,
    verifiedRelationshipCount: 1,
    decisionCount: 2,
    proposalStatusCounts: {}
  });
  assert.deepEqual(projection.capacity, { entities: 500, variants: 2_000, relationships: 5_000 });
  assert.equal(projection.truncated, false);
  assert.equal(store.identityDecisions({ subjectType: "entity", subjectId: entity.entityId }).length, 1);

  store.db.close();
  const reopened = new Store(databasePath);
  t.after(() => reopened.db.close());
  const snapshot = reopened.identityRegistrySnapshot();
  assert.equal(snapshot.entities[0].primaryMint, mintA);
  assert.equal(snapshot.relationships[0].relationshipId, relationship.relationshipId);
  assert.equal(reopened.identityRegistryCoverage().decisionCount, 2);
});

test("dedupes legacy semantic relationships before caps without starving later distinct facts", (t) => {
  const { store } = temporaryDatabase(t);
  const entity = {
    entityId: "legacy-relationship-entity", displayName: "Legacy relationship entity", symbol: null,
    reviewState: "verified", primaryMint: mintA,
    variants: [
      { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
      { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }
    ]
  };
  store.saveIdentityEntity({ entity, decision: decision("decision:legacy-relationship-entity", "entity", entity.entityId) });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 5_001; index++) {
      insertLegacyRelationship(store, {
        relationshipId: `legacy-duplicate-${String(index).padStart(5, "0")}`,
        fromMint: index % 2 ? mintB : mintA,
        toMint: index % 2 ? mintA : mintB
      });
    }
    insertLegacyRelationship(store, {
      relationshipId: "zzzz-legacy-distinct", fromMint: mintA, toMint: mintB, kind: "name-collision"
    });
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  const snapshot = store.identityRegistrySnapshot();
  assert.deepEqual(snapshot.relationships.map(({ kind }) => kind), ["same-creator", "name-collision"]);
  assert.equal(snapshot.projection.integrityOmittedCounts.relationships, 5_000);
  assert.equal(snapshot.projection.integrityOmissionReasons.duplicateRelationships, 5_000);
  const exact = store.identityRegistrySnapshot({ prioritizeMint: mintA });
  assert.equal(exact.relationships.length, 2);
  assert.equal(exact.projection.exactRelationshipEligibleCount, 2);
  assert.equal(exact.projection.exactRelationshipPublishedCount, 2);
  assert.equal(exact.projection.exactRelationshipTruncated, false);
});

test("keeps legal-cap registry projection and cached health coverage bounded", { timeout: 15_000 }, (t) => {
  const { store } = temporaryDatabase(t);
  const entityInsert = store.db.prepare(`INSERT INTO identity_entities
    (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  const variantInsert = store.db.prepare(`INSERT INTO identity_variants
    (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const relationshipInsert = store.db.prepare(`INSERT INTO identity_relationships
    (relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const decisionInsert = store.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
    VALUES (?,?,?,?,?,?,?,NULL)`);
  const mints = [];
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (let entityIndex = 0; entityIndex < IDENTITY_REGISTRY_CAPACITY.entities; entityIndex++) {
      const entityId = `perf-entity-${String(entityIndex).padStart(4, "0")}`;
      const entityMints = Array.from({ length: 4 }, (_, offset) => generatedMint(60_000 + entityIndex * 4 + offset));
      mints.push(...entityMints);
      entityInsert.run(entityId, `Perf entity ${entityIndex}`, null, "verified", entityMints[0], at, at);
      for (const [offset, mint] of entityMints.entries()) {
        variantInsert.run(mint, entityId, offset === 0 ? "official" : "relaunch", "verified",
          "on-chain-finalized", at, at, at);
      }
      decisionInsert.run(`decision:${entityId}`, "entity", entityId, "accept", "perf-fixture", "{}", at);
    }
    let relationshipIndex = 0;
    for (let left = 0; left < mints.length && relationshipIndex < IDENTITY_REGISTRY_CAPACITY.relationships; left++) {
      for (let right = left + 1; right < mints.length && relationshipIndex < IDENTITY_REGISTRY_CAPACITY.relationships; right++) {
        const relationshipId = `perf-edge-${String(relationshipIndex).padStart(5, "0")}`;
        relationshipInsert.run(relationshipId, mints[left], mints[right], "same-creator", "verified",
          "on-chain-finalized", at, at, at);
        decisionInsert.run(`decision:${relationshipId}`, "relationship", relationshipId, "accept", "perf-fixture", "{}", at);
        relationshipIndex++;
      }
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  let startedAt = performance.now();
  const snapshot = store.identityRegistrySnapshot();
  const coldProjectionMs = performance.now() - startedAt;
  startedAt = performance.now();
  const coverage = store.identityRegistryCoverage({ projection: snapshot.projection });
  const coldCoverageMs = performance.now() - startedAt;
  startedAt = performance.now();
  store.identityRegistrySnapshot();
  store.identityRegistryCoverage({ projection: snapshot.projection });
  const cachedHealthMs = performance.now() - startedAt;
  startedAt = performance.now();
  const exact = store.identityRegistrySnapshot({ prioritizeMint: mints[0] });
  const exactColdMs = performance.now() - startedAt;
  startedAt = performance.now();
  store.identityRegistrySnapshot({ prioritizeMint: mints[0] });
  const exactCachedMs = performance.now() - startedAt;

  assert.deepEqual(snapshot.projection.publishedCounts, IDENTITY_REGISTRY_CAPACITY);
  assert.equal(coverage.verifiedRelationshipCount, IDENTITY_REGISTRY_CAPACITY.relationships);
  assert.equal(exact.projection.prioritizedMint, mints[0]);
  assert.ok(coldProjectionMs < 2_000, `cold cap projection blocked ${coldProjectionMs.toFixed(1)}ms`);
  assert.ok(coldCoverageMs < 1_000, `cold cap coverage blocked ${coldCoverageMs.toFixed(1)}ms`);
  assert.ok(cachedHealthMs < 200, `cached health basis blocked ${cachedHealthMs.toFixed(1)}ms`);
  assert.ok(exactColdMs < 1_000, `cold exact resolver blocked ${exactColdMs.toFixed(1)}ms`);
  assert.ok(exactCachedMs < 200, `cached exact resolver blocked ${exactCachedMs.toFixed(1)}ms`);
});

test("separates capacity endpoint omission from identity integrity omission", (t) => {
  const { store } = temporaryDatabase(t);
  seedLegacyAcceptedEntities(store, IDENTITY_REGISTRY_CAPACITY.entities + 26);
  const kinds = ["same-creator", "same-narrative", "probable-copycat", "name-collision"];
  for (let index = 0; index < 101; index++) {
    insertLegacyRelationship(store, {
      relationshipId: `capacity-endpoint-edge-${String(index).padStart(3, "0")}`,
      fromMint: generatedMint(10_000),
      toMint: generatedMint(10_000 + IDENTITY_REGISTRY_CAPACITY.entities + Math.floor(index / kinds.length)),
      kind: kinds[index % kinds.length]
    });
  }
  insertLegacyRelationship(store, {
    relationshipId: "zzzz-capacity-selected-edge",
    fromMint: generatedMint(10_000),
    toMint: generatedMint(10_001),
    kind: "same-creator"
  });
  const snapshot = store.identityRegistrySnapshot();
  assert.deepEqual(snapshot.relationships.map(({ relationshipId }) => relationshipId), ["zzzz-capacity-selected-edge"]);
  assert.equal(snapshot.projection.projectedEndpointRelationshipCount, 101);
  assert.equal(snapshot.projection.integrityOmittedCounts.relationships, 0);
  const exact = store.identityRegistrySnapshot({ prioritizeMint: generatedMint(10_000) });
  assert.deepEqual(exact.relationships.map(({ relationshipId }) => relationshipId), ["zzzz-capacity-selected-edge"]);
  assert.equal(exact.projection.exactRelationshipEligibleCount, 102);
  assert.equal(exact.projection.exactRelationshipPublishableEligibleCount, 1);
  assert.equal(exact.projection.exactRelationshipPublishedCount, 1);
  assert.equal(exact.projection.exactRelationshipLimitOmittedCount, 0);
  assert.equal(exact.projection.exactRelationshipProjectionOmittedCount, 101);
  assert.equal(exact.projection.exactRelationshipIntegrityOmittedCount, 0);
  assert.equal(exact.projection.exactRelationshipTruncated, false);
});

test("quarantines a legacy invalid registry entity without false singleton relabeling", (t) => {
  const { store } = temporaryDatabase(t);
  const invalidMint = "z".repeat(44);
  store.db.prepare(`INSERT INTO identity_entities
    (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run("legacy-invalid-entity", "Legacy invalid entity", null, "verified", mintA, at, at);
  const insertVariant = store.db.prepare(`INSERT INTO identity_variants
    (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  insertVariant.run(mintA, "legacy-invalid-entity", "official", "verified", "on-chain-finalized", at, at, at);
  insertVariant.run(invalidMint, "legacy-invalid-entity", "relaunch", "verified", "provider-observed", at, at, at);
  store.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
    VALUES (?,?,?,?,?,?,?,NULL)`).run("decision:legacy-invalid-entity", "entity", "legacy-invalid-entity",
    "accept", "legacy-reviewed-import", "{}", at);
  const general = store.identityRegistrySnapshot();
  assert.equal(general.entities.length, 0);
  assert.deepEqual(general.projection.integrityOmittedCounts, { entities: 1, variants: 2, relationships: 0 });
  const exact = store.identityRegistrySnapshot({ prioritizeMint: mintA });
  assert.equal(exact.exactOmission.reason, "legacy-invalid-variant");
  assert.equal(exact.exactOmission.variant.kind, "official");
  assert.equal(exact.exactOmission.isPrimary, true);
  const intelligence = buildEntityIntelligence({ tokens: [{ mint: mintA }], registry: exact, generatedAt: at });
  assert.equal(intelligence.entities.some(({ entityId }) => entityId === `~mint:${mintA}`), false);
  assert.equal(intelligence.projectionOmittedReviewed[0].reason, "legacy-invalid-variant");
});

test("quarantines a legacy invalid primary before prioritized registry construction", (t) => {
  const { store } = temporaryDatabase(t);
  const invalidPrimary = "z".repeat(44);
  store.db.prepare(`INSERT INTO identity_entities
    (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run("legacy-invalid-primary", "Legacy invalid primary", null, "verified", invalidPrimary, at, at);
  store.db.prepare(`INSERT INTO identity_variants
    (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(mintB, "legacy-invalid-primary", "official", "verified", "on-chain-finalized", at, at, at);
  store.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
    VALUES (?,?,?,?,?,?,?,NULL)`).run("decision:legacy-invalid-primary", "entity", "legacy-invalid-primary",
    "accept", "legacy-reviewed-import", "{}", at);

  const general = store.identityRegistrySnapshot();
  assert.equal(general.entities.length, 0);
  assert.deepEqual(general.projection.integrityOmittedCounts, { entities: 1, variants: 1, relationships: 0 });
  const exact = store.identityRegistrySnapshot({ prioritizeMint: mintB });
  assert.equal(exact.entities.length, 0);
  assert.equal(exact.exactOmission.reason, "legacy-invalid-primary");
  assert.equal(exact.exactOmission.isPrimary, false);
  assert.equal(exact.exactOmission.hasReviewedPrimary, false);
  assert.equal(exact.exactOmission.variant.mint, mintB);
  const intelligence = buildEntityIntelligence({ tokens: [{ mint: mintB }], registry: exact, generatedAt: at });
  assert.equal(intelligence.entities.some(({ entityId }) => entityId === `~mint:${mintB}`), false);
  assert.equal(intelligence.projectionOmittedReviewed[0].reason, "legacy-invalid-primary");
});

test("rejecting a parent cannot leave public orphan variants or relationships", (t) => {
  const { store } = temporaryDatabase(t);
  const entity = {
    entityId: "rejectable-meme",
    displayName: "Rejectable Meme",
    symbol: "REJ",
    reviewState: "verified",
    primaryMint: mintA,
    variants: [
      { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
      { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at }
    ]
  };
  store.saveIdentityEntity({ entity, decision: decision("decision:rejectable-entity", "entity", entity.entityId) });
  store.saveIdentityRelationship({
    relationship: {
      relationshipId: "rejectable-meme:edge",
      fromMint: mintA,
      toMint: mintB,
      kind: "same-creator",
      reviewState: "verified",
      evidenceClass: "on-chain-finalized",
      observedAt: at
    },
    decision: decision("decision:rejectable-edge", "relationship", "rejectable-meme:edge")
  });
  const rejected = {
    ...entity,
    reviewState: "rejected",
    primaryMint: null,
    variants: entity.variants.map((variant) => ({ ...variant, reviewState: "rejected" }))
  };
  assert.equal(store.saveIdentityEntity({
    entity: rejected,
    decision: decision("decision:rejectable-entity-rejected", "entity", entity.entityId, "reject")
  }), null);
  const rejectedSnapshot = store.identityRegistrySnapshot();
  assert.deepEqual({ schemaVersion: rejectedSnapshot.schemaVersion, entities: rejectedSnapshot.entities, relationships: rejectedSnapshot.relationships }, {
    schemaVersion: 1, entities: [], relationships: []
  });
  assert.equal(rejectedSnapshot.projection.truncated, false);
  const coverage = store.identityRegistryCoverage();
  assert.equal(coverage.entityCount, 0);
  assert.equal(coverage.variantCount, 0);
  assert.equal(coverage.relationshipCount, 0);
  assert.equal(coverage.verifiedEntityCount, 0);
  assert.equal(coverage.verifiedVariantCount, 0);
  assert.equal(coverage.verifiedRelationshipCount, 0);
});

test("review decisions cannot contradict published entity or relationship state", (t) => {
  const { store } = temporaryDatabase(t);
  const entity = {
    entityId: "decision-bound-entity",
    displayName: "Decision Bound Entity",
    symbol: "BOUND",
    reviewState: "verified",
    primaryMint: mintA,
    variants: [
      { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
      { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at }
    ]
  };
  assert.throws(() => store.saveIdentityEntity({
    entity,
    decision: decision("decision:contradictory-entity", "entity", entity.entityId, "reject")
  }), /accepted identity entities|fully rejected/);
  assert.equal(store.identityRegistrySnapshot().entities.length, 0);
  store.saveIdentityEntity({ entity, decision: decision("decision:bound-entity", "entity", entity.entityId) });
  const relationship = {
    relationshipId: "decision-bound-edge",
    fromMint: mintA,
    toMint: mintB,
    kind: "same-creator",
    reviewState: "verified",
    evidenceClass: "on-chain-finalized",
    observedAt: at
  };
  assert.throws(() => store.saveIdentityRelationship({
    relationship,
    decision: decision("decision:contradictory-edge", "relationship", relationship.relationshipId, "reject")
  }), /reject identity relationships must be rejected/);
  assert.equal(store.identityRegistrySnapshot().relationships.length, 0);
});

test("active mint ownership cannot be reassigned and a failed save rolls back before commit", (t) => {
  const { store } = temporaryDatabase(t);
  const entityA = {
    entityId: "owner-a", displayName: "Owner A", symbol: null, reviewState: "verified", primaryMint: mintA,
    variants: [
      { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
      { mint: mintB, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at }
    ]
  };
  store.saveIdentityEntity({ entity: entityA, decision: decision("decision:owner-a", "entity", "owner-a") });
  assert.throws(() => store.saveIdentityEntity({
    entity: {
      entityId: "owner-b", displayName: "Owner B", symbol: null, reviewState: "verified", primaryMint: mintA,
      variants: [{ mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
    },
    decision: decision("decision:owner-b", "entity", "owner-b")
  }), /explicitly released before reassignment/);
  const snapshot = store.identityRegistrySnapshot({ prioritizeMint: mintA });
  assert.equal(snapshot.entities.length, 1);
  assert.equal(snapshot.entities[0].entityId, "owner-a");
  assert.equal(snapshot.entities[0].primaryMint, mintA);
  assert.equal(store.identityDecisions({ subjectId: "owner-b" }).length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_entities WHERE entity_id='owner-b'").get().count, 0);
});

test("bounds whole reviewed registry projection and never relabels an omitted reviewed mint", (t) => {
  const { store } = temporaryDatabase(t);
  seedLegacyAcceptedEntities(store, IDENTITY_REGISTRY_CAPACITY.entities + 1);
  const omittedMint = generatedMint(10_000 + IDENTITY_REGISTRY_CAPACITY.entities);
  const bounded = store.identityRegistrySnapshot();
  assert.equal(bounded.entities.length, IDENTITY_REGISTRY_CAPACITY.entities);
  assert.equal(bounded.projection.truncated, true);
  assert.equal(bounded.projection.omittedCounts.entities, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 1_000_000);

  const prioritized = store.identityRegistrySnapshot({ prioritizeMints: [omittedMint] });
  assert.ok(prioritized.entities.some(({ variants }) => variants.some(({ mint }) => mint === omittedMint)));
  assert.equal(prioritized.reviewedMintOmissions.length, 0);
  assert.equal(prioritized.projection.truncated, true);

  const extraMint = generatedMint(20_000);
  assert.throws(() => store.saveIdentityEntity({
    entity: {
      entityId: "over-cap-entity", displayName: "Over cap", symbol: null, reviewState: "verified", primaryMint: extraMint,
      variants: [{ mint: extraMint, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
    },
    decision: decision("decision:over-cap-entity", "entity", "over-cap-entity")
  }), /entities capacity/);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_entities WHERE entity_id='over-cap-entity'").get().count, 0);

  const releasedMint = generatedMint(10_000);
  assert.equal(store.saveIdentityEntity({
    entity: {
      entityId: "legacy-capacity-0000", displayName: "Legacy capacity 0", symbol: null, reviewState: "rejected", primaryMint: null,
      variants: [{ mint: releasedMint, kind: "official", reviewState: "rejected", evidenceClass: "on-chain-finalized", observedAt: at }]
    },
    decision: decision("decision:legacy-capacity-0000-reject", "entity", "legacy-capacity-0000", "reject")
  }), null);
  assert.equal(store.identityRegistrySnapshot().projection.truncated, false);
});

test("whole-document identity imports roll back every row after a late invalid edge", (t) => {
  const { store } = temporaryDatabase(t);
  const importedMint = generatedMint(30_000);
  assert.throws(() => store.importIdentityRegistry({
    entities: [{
      entity: {
        entityId: "atomic-import", displayName: "Atomic import", symbol: null, reviewState: "verified", primaryMint: importedMint,
        variants: [{ mint: importedMint, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
      },
      decision: decision("decision:atomic-import", "entity", "atomic-import")
    }],
    relationships: [{
      relationship: {
        relationshipId: "atomic-import-invalid-edge", fromMint: importedMint, toMint: generatedMint(30_001),
        kind: "same-creator", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at
      },
      decision: decision("decision:atomic-import-invalid-edge", "relationship", "atomic-import-invalid-edge")
    }]
  }), /endpoints must both be registered/);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_entities").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_decisions").get().count, 0);
});

test("invalid decoded mint in a later entity variant leaves no reviewed rows or decision", (t) => {
  const { store } = temporaryDatabase(t);
  assert.throws(() => store.saveIdentityEntity({
    entity: {
      entityId: "invalid-later-variant",
      displayName: "Invalid later variant",
      symbol: null,
      reviewState: "verified",
      primaryMint: mintA,
      variants: [
        { mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at },
        { mint: "z".repeat(44), kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: at }
      ]
    },
    decision: decision("decision:invalid-later-variant", "entity", "invalid-later-variant")
  }), /canonical 32-byte Solana base58/);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_entities").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_variants").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM identity_decisions").get().count, 0);
});

test("keeps automated proposals separate from reviewed facts and records decisions", (t) => {
  const { store } = temporaryDatabase(t);
  const [proposal] = proposeIdentityCandidates([
    { mint: mintA, name: "Same", symbol: "SAME" },
    { mint: mintB, name: " same ", symbol: "same" }
  ]);
  assert.equal(store.upsertIdentityProposals([proposal], { observedAt: at }).supplied, 1);
  assert.equal(store.identityRegistrySnapshot().relationships.length, 0);
  assert.equal(store.identityProposals({ status: "pending" }).length, 1);
  const accepted = store.decideIdentityProposal({
    proposalKey: proposal.proposalKey,
    decision: decision("decision:proposal-1", "proposal", proposal.proposalKey)
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(store.identityRegistrySnapshot().relationships.length, 0);
  assert.equal(store.identityDecisions({ subjectType: "proposal" })[0].decision, "accept");
  assert.throws(() => store.decideIdentityProposal({
    proposalKey: proposal.proposalKey,
    decision: decision("decision:proposal-1", "proposal", proposal.proposalKey, "reject")
  }), /UNIQUE constraint failed/);
  assert.equal(store.identityProposals({ status: "accepted" })[0].status, "accepted");
});

test("legacy malformed proposals cannot be accepted but remain rejectable for cleanup", (t) => {
  const { store } = temporaryDatabase(t);
  store.db.prepare(`INSERT INTO identity_proposals
    (proposal_key,from_mint,to_mint,kind,evidence_class,method_version,evidence,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("legacy-malformed-proposal", mintA, mintB, "same-narrative",
    "locally-derived", "x:@private_profile", "{}", "pending", at, at);
  assert.throws(() => store.decideIdentityProposal({
    proposalKey: "legacy-malformed-proposal",
    decision: decision("decision:legacy-malformed-accept", "proposal", "legacy-malformed-proposal", "accept")
  }), /can only be rejected or superseded/);
  assert.equal(store.identityProposals({ status: "pending" }).length, 1);
  const rejected = store.decideIdentityProposal({
    proposalKey: "legacy-malformed-proposal",
    decision: decision("decision:legacy-malformed-reject", "proposal", "legacy-malformed-proposal", "reject")
  });
  assert.equal(rejected.status, "rejected");
});

test("caps the persisted pending proposal backlog while preserving reviewed rows", (t) => {
  const { store } = temporaryDatabase(t);
  const proposals = Array.from({ length: IDENTITY_PENDING_PROPOSAL_LIMIT + 20 }, (_, index) => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(index + 1, 28);
    const toMint = encodeBase58(bytes);
    return {
      proposalKey: `identity-proposal:cap-${String(index).padStart(4, "0")}`,
      fromMint: mintB, toMint, kind: "name-collision", evidenceClass: "locally-derived",
      methodVersion: "cap-test-v1", evidence: { basis: "name-and-symbol", match: "exact-normalized" }, status: "pending"
    };
  });
  const result = store.upsertIdentityProposals(proposals, { observedAt: at });
  assert.equal(result.pruned, 20);
  assert.equal(result.pendingLimit, IDENTITY_PENDING_PROPOSAL_LIMIT);
  assert.equal(store.identityRegistryCoverage().proposalStatusCounts.pending, IDENTITY_PENDING_PROPOSAL_LIMIT);
  const retained = store.identityProposals({ limit: IDENTITY_PENDING_PROPOSAL_LIMIT });
  store.decideIdentityProposal({
    proposalKey: retained[0].proposalKey,
    decision: decision("decision:cap-reviewed", "proposal", retained[0].proposalKey, "reject")
  });
  store.upsertIdentityProposals(proposals, { observedAt: "2026-08-10T11:31:00.000Z" });
  assert.equal(store.identityRegistryCoverage().proposalStatusCounts.rejected, 1);
  assert.ok(store.identityRegistryCoverage().proposalStatusCounts.pending <= IDENTITY_PENDING_PROPOSAL_LIMIT);
});

test("fails closed on secret-bearing proposal evidence and unregistered relationships", (t) => {
  const { store } = temporaryDatabase(t);
  assert.throws(() => store.upsertIdentityProposals([{
    proposalKey: "identity-proposal:bad",
    fromMint: mintA,
    toMint: mintB,
    kind: "name-collision",
    evidenceClass: "locally-derived",
    methodVersion: "method-v1",
    evidence: { source: "api-key-secret" },
    status: "pending"
  }], { observedAt: at }), /credentials or secrets/);
  assert.throws(() => store.saveIdentityRelationship({
    relationship: {
      relationshipId: "unregistered:edge",
      fromMint: mintA,
      toMint: mintB,
      kind: "same-narrative",
      reviewState: "verified",
      evidenceClass: "locally-derived",
      observedAt: at
    },
    decision: decision("decision:relationship-bad", "relationship", "unregistered:edge")
  }), /registered variants/);
});

test("verified backup and disposable restore preserve identity facts, proposals, and decisions", (t) => {
  const { store, databasePath } = temporaryDatabase(t);
  store.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
  const entity = {
    entityId: "backup-meme", displayName: "Backup Meme", symbol: "BACK", reviewState: "verified", primaryMint: mintA,
    variants: [{ mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
  };
  store.saveIdentityEntity({ entity, decision: decision("decision:backup-entity", "entity", entity.entityId) });
  const [proposal] = proposeIdentityCandidates([
    { mint: mintA, name: "Backup", symbol: "BACK" },
    { mint: mintB, name: "Backup", symbol: "BACK" }
  ]);
  store.upsertIdentityProposals([proposal], { observedAt: at });
  const backupDirectory = path.join(path.dirname(databasePath), "backups");
  const scratchDirectory = path.join(path.dirname(databasePath), "scratch");
  mkdirSync(backupDirectory);
  mkdirSync(scratchDirectory);
  const report = createVerifiedBackup(databasePath, path.join(backupDirectory, "identity.db"), { scratchRoot: scratchDirectory });
  assert.equal(report.backup.rowCounts.identity_entities, 1);
  assert.equal(report.backup.rowCounts.identity_variants, 1);
  assert.equal(report.backup.rowCounts.identity_proposals, 1);
  assert.equal(report.backup.rowCounts.identity_decisions, 1);
  assert.equal(report.disposableRestore.rowCounts.identity_entities, 1);
  assert.equal(report.disposableRestore.rowCounts.identity_proposals, 1);
  assert.equal(report.disposableRestore.identityPrivacyViolations, 0);
});
