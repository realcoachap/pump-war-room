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
  const prospective = ingestor.getStatus().cohort;
  assert.equal(prospective.attemptedMintCount, 0);
  assert.equal(prospective.failureStateCount, 0);
  assert.equal(prospective.failureRatio, null);
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
  const status = ingestor.getStatus();
  assert.equal(status.correlationGate.rankingImpact, "none");
  assert.equal(status.cohort.attemptedMintCount, 1);
  assert.equal(status.cohort.failureStateCount, 0);
  assert.equal(status.cohort.failureRatio, 0);
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
  assert.throws(() => state.store.saveActorObservation({
    eventKey: "actor:too-long", mint: MINT, event, sourceAt: LAUNCH, observedAt: LAUNCH,
    retainedUntil: new Date(Date.parse(LAUNCH) + 72 * 60 * 60 * 1_000 + 1).toISOString()
  }), /no more than 72 hours/);
  assert.equal(state.store.saveActorObservation({ eventKey: "actor:one", mint: MINT, event, sourceAt: LAUNCH, observedAt: LAUNCH, retainedUntil }).written, false);
  assert.throws(() => state.store.saveActorObservation({ eventKey: "actor:one", mint: MINT, event: { ...event, side: "sell" }, sourceAt: LAUNCH, observedAt: LAUNCH, retainedUntil }), /conflicts/);
  const summary = { mint: MINT, coverage: { state: "insufficient-sample", eventCount: 1 }, metrics: null };
  state.store.saveActorSummary(MINT, summary);
  assert.throws(() => state.store.saveActorSummary(MINT, {
    ...summary,
    audit: { wallet: ACTORS[0], transactionId: "3".repeat(64), provenanceDigest: "hidden" }
  }), /outside the public aggregate contract/);
  assert.equal(JSON.stringify(state.store.actorSummaries()).includes("transactionProvenance"), false);
  assert.deepEqual(state.store.pruneActorObservations({ now: "2026-08-09T19:00:00.000Z", maximum: 10 }), { expired: 1, excess: 0, retained: 0 });
});

test("retention runs without due acquisition work and a mid-batch failure still publishes partial evidence", async (t) => {
  const state = await fixture();
  t.after(state.close);
  let now = NOW;
  const fake = clientWithObservations();
  let transactionCount = 0;
  fake.transaction = async () => {
    transactionCount += 1;
    if (transactionCount === 2) throw Object.assign(new Error("provider stopped mid-batch"), { code: "network-error" });
    return { marker: true };
  };
  const bySignature = new Map(fake.inputs.map((input) => [input.transactionId, input]));
  const extract = ({ signatureInfo }) => ({ status: "observed", reason: null, observations: [bySignature.get(signatureInfo.signature)] });
  const ingestor = new EarlyActorIngestor({ store: state.store, client: fake, now: () => now, extract });
  ingestor.start();
  ingestor.admit({ mint: MINT, source: "pumpportal", createdAt: LAUNCH });
  assert.equal(await ingestor.drainDue(), true);
  assert.equal(state.store.actorState(MINT).status, "degraded");
  assert.equal(state.store.actorSummary(MINT).coverage.eventCount, 1);
  assert.equal(state.store.actorObservationEvents(MINT).length, 1);
  assert.match(state.store.actorState(MINT).missingReason, /Partial bounded evidence retained/);

  state.store.db.prepare("UPDATE actor_cohort SET next_attempt_at=NULL WHERE mint=?").run(MINT);
  now += 73 * 60 * 60 * 1_000;
  assert.equal(await ingestor.drainDue(), false);
  assert.equal(state.store.actorObservationEvents(MINT).length, 0);
});

test("headline status distinguishes retrying degradation from terminal zero-evidence failure", async (t) => {
  const state = await fixture();
  t.after(state.close);
  let now = NOW;
  const client = {
    signaturesForAddress: async () => { throw Object.assign(new Error("rpc unavailable"), { code: "network-error" }); },
    transaction: async () => null
  };
  const ingestor = new EarlyActorIngestor({ store: state.store, client, now: () => now });
  ingestor.start();
  ingestor.admit({ mint: MINT, source: "pumpportal", createdAt: LAUNCH });
  assert.equal(await ingestor.drainDue(), true);
  const retryingStatus = ingestor.getStatus();
  assert.equal(retryingStatus.status, "degraded");
  assert.equal(retryingStatus.cohort.attemptedMintCount, 1);
  assert.equal(retryingStatus.cohort.failureStateCount, 1);
  assert.equal(retryingStatus.cohort.failureRatio, 1);

  now = Date.parse(LAUNCH) + 10 * 60_000;
  assert.equal(await ingestor.drainDue(), true);
  now = Date.parse(LAUNCH) + 30 * 60_000;
  assert.equal(await ingestor.drainDue(), true);
  const status = ingestor.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.cohort.pendingAttemptCount, 0);
  assert.equal(status.cohort.terminalCount, 1);
  assert.equal(status.cohort.terminalFailureCount, 1);
  assert.equal(status.cohort.attemptedMintCount, 1);
  assert.equal(status.cohort.failureStateCount, 1);
  assert.equal(status.cohort.failureRatio, 1);
  assert.equal(status.cohort.evidenceMintCount, 0);
});
