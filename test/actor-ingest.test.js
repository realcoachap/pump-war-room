import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EarlyActorIngestor } from "../src/actor-ingest.js";
import { Store } from "../src/store.js";

const MINT = "11111111111111111111111111111111";
const ACTORS = [
  "So11111111111111111111111111111111111111112",
  "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
  "22222222222222222222222222222222"
];
const NOW = Date.parse("2026-08-09T17:30:00.000Z");
const LAUNCH = "2026-08-09T17:28:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pump-actor-ingest-"));
  const store = new Store(path.join(directory, "test.db"));
  const state = { directory, store };
  state.close = async () => {
    try { state.store.db.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  };
  return state;
}

function clientWithObservations() {
  const signatures = Array.from({ length: 5 }, (_, index) => ({
    signature: String(index + 3).repeat(64), slot: 100 + index, err: null,
    blockTime: Math.floor((Date.parse(LAUNCH) + 30_000 + index * 10_000) / 1_000), confirmationStatus: "finalized"
  }));
  return {
    signaturesForAddress: async () => signatures,
    transaction: async () => ({ marker: true }),
    extractIndex: 0,
    inputs: signatures.map((signature, index) => ({
      mint: MINT,
      actorAddress: ACTORS[index % ACTORS.length],
      side: index === 4 ? "sell" : "buy",
      tokenAmount: 10 + index,
      nativeAmount: null,
      source: "solana-mainnet-rpc",
      evidenceClass: "on-chain-finalized",
      sourceTimestamp: new Date(signature.blockTime * 1_000).toISOString(),
      observedAt: new Date(NOW).toISOString(),
      transactionId: signature.signature,
      slot: signature.slot
    }))
  };
}

test("prospective actor admission is restart-safe, bounded, and rejects replay backfill", async (t) => {
  const state = await fixture();
  t.after(state.close);
  const client = { signaturesForAddress: async () => [], transaction: async () => null };
  const ingestor = new EarlyActorIngestor({ store: state.store, client, now: () => NOW });
  ingestor.start();
  assert.equal(ingestor.admit({ mint: MINT, source: "pumpportal", createdAt: LAUNCH }).admitted, true);
  assert.equal(ingestor.admit({ mint: MINT, source: "pumpportal", createdAt: LAUNCH }).reason, "already-admitted");
  assert.equal(ingestor.admit({ mint: "22222222222222222222222222222222", source: "pumpportal", createdAt: "2026-08-09T17:00:00.000Z" }).reason, "replay-too-old-or-invalid");
  const reopenedSecret = state.store.actorPrivacySecret();
  state.store.db.close();
  state.store = new Store(path.join(state.directory, "test.db"));
  assert.deepEqual(state.store.actorPrivacySecret(), reopenedSecret);
  assert.equal(state.store.actorStates().length, 1);
});

test("bounded acquisition persists minimized deduped evidence and explicit missing gates", async (t) => {
  const state = await fixture();
  t.after(state.close);
  const fake = clientWithObservations();
  const bySignature = new Map(fake.inputs.map((input) => [input.transactionId, input]));
  const extract = ({ signatureInfo }) => ({ status: "observed", reason: null, observations: [bySignature.get(signatureInfo.signature)] });
  const ingestor = new EarlyActorIngestor({ store: state.store, client: fake, now: () => NOW, extract });
  ingestor.start();
  ingestor.admit({ mint: MINT, source: "pumpportal", createdAt: LAUNCH });
  assert.equal(await ingestor.drainDue(), true);
  assert.equal(state.store.actorState(MINT).attemptCount, 1);
  assert.equal(state.store.actorSummaries()[0].coverage.state, "available");
  assert.equal(state.store.actorSummaries()[0].coverage.uniqueActorCount, 3);
  assert.equal(state.store.actorObservationEvents(MINT).length, 5);
  assert.equal(ingestor.getStatus().correlationGate.rankingImpact, "none");
  assert.equal(JSON.stringify(state.store.actorSummaries()).includes("actorAddress"), false);
});

test("store enforces actor dedupe conflicts, retention, and aggregate privacy", async (t) => {
  const state = await fixture();
  t.after(state.close);
  state.store.admitActorMint({ mint: MINT, launchObservedAt: LAUNCH, admittedAt: LAUNCH, nextAttemptAt: LAUNCH });
  const event = {
    schemaVersion: 1, mint: MINT, actor: "Actor 42", side: "buy", amounts: { native: null, token: 5 },
    source: { name: "solana-mainnet-rpc", evidenceClass: "on-chain-finalized" },
    timestamps: { source: { state: "available", value: LAUNCH }, observedAt: LAUNCH },
    transactionProvenance: { state: "internal-only", evidenceClass: "locally-derived", slot: { state: "available", value: 10 } }
  };
  const retainedUntil = "2026-08-09T18:28:00.000Z";
  assert.equal(state.store.saveActorObservation({ eventKey: "actor:one", mint: MINT, event, sourceAt: LAUNCH, observedAt: LAUNCH, retainedUntil }).written, true);
  assert.equal(state.store.saveActorObservation({ eventKey: "actor:one", mint: MINT, event, sourceAt: LAUNCH, observedAt: LAUNCH, retainedUntil }).written, false);
  assert.throws(() => state.store.saveActorObservation({ eventKey: "actor:one", mint: MINT, event: { ...event, side: "sell" }, sourceAt: LAUNCH, observedAt: LAUNCH, retainedUntil }), /conflicts/);
  const summary = { mint: MINT, coverage: { state: "insufficient-sample", eventCount: 1 }, metrics: null };
  state.store.saveActorSummary(MINT, summary);
  assert.equal(JSON.stringify(state.store.actorSummaries()).includes("transactionProvenance"), false);
  assert.deepEqual(state.store.pruneActorObservations({ now: "2026-08-09T19:00:00.000Z", maximum: 10 }), { expired: 1, excess: 0, retained: 0 });
});
