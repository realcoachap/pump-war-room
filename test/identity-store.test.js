import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IDENTITY_PENDING_PROPOSAL_LIMIT, Store, STORE_SCHEMA_VERSION } from "../src/store.js";
import { proposeIdentityCandidates } from "../src/identity-proposals.js";
import { createVerifiedBackup } from "../src/database-backup.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "../src/solana-rpc.js";

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
  assert.deepEqual(store.identityRegistryCoverage(), {
    entityCount: 1,
    variantCount: 2,
    relationshipCount: 1,
    decisionCount: 2,
    proposalStatusCounts: {}
  });
  assert.equal(store.identityDecisions({ subjectType: "entity", subjectId: entity.entityId }).length, 1);

  store.db.close();
  const reopened = new Store(databasePath);
  t.after(() => reopened.db.close());
  const snapshot = reopened.identityRegistrySnapshot();
  assert.equal(snapshot.entities[0].primaryMint, mintA);
  assert.equal(snapshot.relationships[0].relationshipId, relationship.relationshipId);
  assert.equal(reopened.identityRegistryCoverage().decisionCount, 2);
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
