import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIdentityCli } from "../scripts/identity-cli.js";
import { Store } from "../src/store.js";
import { proposeIdentityCandidates } from "../src/identity-proposals.js";

const mintA = "11111111111111111111111111111111";
const mintB = "So11111111111111111111111111111111111111112";
const at = "2026-08-10T12:00:00.000Z";

test("local identity CLI lists and decides proposals without a public write surface", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-identity-cli-"));
  const database = path.join(directory, "war-room.db");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(database);
  const [proposal] = proposeIdentityCandidates([
    { mint: mintA, name: "Same", symbol: "SAME" },
    { mint: mintB, name: "Same", symbol: "SAME" }
  ]);
  store.upsertIdentityProposals([proposal], { observedAt: at });
  store.db.close();

  assert.equal(runIdentityCli(["status", "--database", database]).coverage.proposalStatusCounts.pending, 1);
  assert.equal(runIdentityCli(["proposals", "--database", database, "--status", "pending"]).proposals.length, 1);
  const decided = runIdentityCli([
    "decide", "--database", database,
    "--proposal", proposal.proposalKey,
    "--decision", "reject",
    "--decision-id", "decision:cli-proposal-1",
    "--reason-code", "name-match-insufficient",
    "--decided-at", at
  ]);
  assert.equal(decided.proposal.status, "rejected");
  assert.equal(runIdentityCli(["proposals", "--database", database, "--status", "pending"]).proposals.length, 0);
});

test("local identity CLI imports only bounded reviewed documents", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-identity-import-"));
  const database = path.join(directory, "war-room.db");
  const file = path.join(directory, "import.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(database);
  store.db.close();
  writeFileSync(file, JSON.stringify({
    entities: [{
      entity: {
        entityId: "same-meme",
        displayName: "Same Meme",
        symbol: "SAME",
        reviewState: "verified",
        primaryMint: mintA,
        variants: [{ mint: mintA, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: at }]
      },
      decision: {
        decisionId: "decision:cli-entity-1",
        subjectType: "entity",
        subjectId: "same-meme",
        decision: "accept",
        reasonCode: "operator-reviewed-evidence",
        decidedAt: at
      }
    }],
    relationships: []
  }));
  const result = runIdentityCli(["import", "--database", database, "--file", file]);
  assert.deepEqual(result.imported, { entities: 1, relationships: 0 });
  assert.equal(result.coverage.entityCount, 1);
  assert.throws(() => runIdentityCli(["status", "--database", path.join(directory, "missing.db")]), /does not exist/);
});
