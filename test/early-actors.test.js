import test from "node:test";
import assert from "node:assert/strict";
import {
  createActorLabel,
  EarlyActorCore,
  EarlyActorError,
  EARLY_ACTOR_EVIDENCE_CLASS,
  EARLY_ACTOR_METHOD_VERSION,
  EARLY_ACTOR_RPC_EVIDENCE_CLASS,
  EARLY_ACTOR_RPC_SOURCE,
  isCanonicalSolanaAddress,
  normalizeEarlyActorTrade
} from "../src/early-actors.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

const key = (byte) => encodeBase58(Buffer.alloc(32, byte));
const firstMint = key(1);
const secondMint = key(2);
const thirdMint = key(3);
const actorA = key(4);
const actorB = key(5);
const actorC = key(6);
const installationSecret = "installation-secret-material-00001";
const alternateSecret = "installation-secret-material-00002";
const startMs = Date.parse("2026-08-09T12:00:00Z");

function at(offsetMs) {
  return new Date(startMs + offsetMs).toISOString();
}

function signature(index) {
  return encodeBase58(Buffer.alloc(64, index + 10));
}

function frame({
  index = 0,
  mint = firstMint,
  actor = actorA,
  side = "buy",
  sol = 1,
  token = 10,
  sourceTimestamp = at(index * 1_000)
} = {}) {
  return {
    signature: signature(index),
    mint,
    traderPublicKey: actor,
    txType: side,
    solAmount: sol,
    tokenAmount: token,
    sourceTimestamp,
    source: "PumpPortal"
  };
}

function finalizedObservation({
  index = 0,
  mint = firstMint,
  actor = actorA,
  side = "buy",
  native = null,
  token = 10,
  slot = 358_000_000,
  sourceTimestamp = at(index * 1_000),
  observedAt = at(index * 1_000 + 2_000)
} = {}) {
  return {
    source: EARLY_ACTOR_RPC_SOURCE,
    evidenceClass: EARLY_ACTOR_RPC_EVIDENCE_CLASS,
    mint,
    actorAddress: actor,
    side,
    nativeAmount: native,
    tokenAmount: token,
    transactionId: signature(index),
    slot,
    sourceTimestamp,
    observedAt
  };
}

function options(overrides = {}) {
  return {
    installationSecret,
    observedMints: [firstMint, secondMint],
    mintCreatedAt: {
      [firstMint]: at(-60_000),
      [secondMint]: at(-60_000)
    },
    minimumEventCount: 1,
    minimumActorCount: 1,
    ...overrides
  };
}

test("normalizes an allowlisted PumpPortal frame into a strict redacted contract", () => {
  const raw = {
    ...frame({ index: 0, sol: "1.25", token: "42.5" }),
    untrustedDisplayName: "RAW_MARKER",
    lookupEndpoint: "https://private.invalid/wallet",
    nestedPayload: { secret: "DO_NOT_COPY" }
  };
  const normalized = normalizeEarlyActorTrade(raw, { ...options(), observedAt: at(2_000) });

  assert.deepEqual(Object.keys(normalized), [
    "schemaVersion", "mint", "actor", "side", "amounts", "source", "timestamps", "transactionProvenance"
  ]);
  assert.equal(normalized.mint, firstMint);
  assert.match(normalized.actor, /^Actor [1-9]\d*$/);
  assert.deepEqual(normalized.amounts, { native: 1.25, token: 42.5 });
  assert.deepEqual(normalized.source, {
    name: "pumpportal",
    evidenceClass: EARLY_ACTOR_EVIDENCE_CLASS
  });
  assert.deepEqual(normalized.timestamps, {
    source: { state: "available", value: at(0) },
    observedAt: at(2_000)
  });
  assert.deepEqual(normalized.transactionProvenance, {
    state: "internal-only",
    evidenceClass: "locally-derived",
    slot: { state: "missing", value: null }
  });

  const serialized = JSON.stringify(normalized);
  for (const privateValue of [actorA, signature(0), installationSecret, "RAW_MARKER", "private.invalid", "DO_NOT_COPY"]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const forbiddenKey of ["wallet", "address", "digest", "secret", "lookupEndpoint", "rawPayload"]) {
    assert.equal(Object.hasOwn(normalized, forbiddenKey), false);
  }
});

test("keyed actor labels are stable across restarts, change across installations, and expose no lookup mapping", () => {
  const first = normalizeEarlyActorTrade(frame({ index: 1 }), { ...options(), observedAt: at(2_000) });
  const restarted = normalizeEarlyActorTrade(frame({ index: 1 }), { ...options(), observedAt: at(3_000) });
  const otherTransaction = normalizeEarlyActorTrade(frame({ index: 2 }), { ...options(), observedAt: at(3_000) });
  const otherInstallation = normalizeEarlyActorTrade(frame({ index: 1 }), {
    ...options({ installationSecret: alternateSecret }),
    observedAt: at(2_000)
  });

  assert.equal(first.actor, restarted.actor);
  assert.equal(first.actor, otherTransaction.actor);
  assert.notEqual(first.actor, otherInstallation.actor);
  assert.equal(createActorLabel(actorA, { installationSecret }), first.actor);
  assert.equal(createActorLabel(actorA, { installationSecret }), restarted.actor);
  assert.notEqual(createActorLabel(actorA, { installationSecret: alternateSecret }), first.actor);
  assert.equal(EARLY_ACTOR_METHOD_VERSION, "early-actor-keyed-label-v1");
});

test("accepts explicit finalized Solana observations with nullable native amounts and redacted provenance", () => {
  const observation = finalizedObservation({ index: 3, native: null, token: 125, slot: 358_123_456 });
  const normalized = normalizeEarlyActorTrade(observation, options());

  assert.equal(normalized.source.name, EARLY_ACTOR_RPC_SOURCE);
  assert.equal(normalized.source.evidenceClass, EARLY_ACTOR_RPC_EVIDENCE_CLASS);
  assert.deepEqual(normalized.amounts, { native: null, token: 125 });
  assert.deepEqual(normalized.transactionProvenance, {
    state: "internal-only",
    evidenceClass: "locally-derived",
    slot: { state: "available", value: 358_123_456 }
  });
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, new RegExp(actorA));
  assert.doesNotMatch(serialized, new RegExp(signature(3)));

  const core = new EarlyActorCore(options({ minimumEventCount: 2, minimumActorCount: 2 }));
  assert.equal(core.ingest(observation).accepted, true);
  assert.equal(core.ingest(finalizedObservation({
    index: 3,
    actor: actorB,
    side: "sell",
    native: 2,
    token: 25,
    slot: 358_123_456
  })).accepted, true);
  assert.equal(core.eventsForMint(firstMint).length, 2, "one transaction may contain observations owned by different actors");
  assert.equal(core.snapshot().sourceCoverage.bySource[EARLY_ACTOR_RPC_SOURCE].observedEventCount, 2);
  assert.equal(core.snapshot().sourceCoverage.bySource.pumpportal.contractState, "input-only");
});

test("requires exact observed mints and rejects malformed or unbounded inputs", () => {
  assert.throws(
    () => new EarlyActorCore(options({ installationSecret: "too-short" })),
    (error) => error instanceof EarlyActorError && error.code === "invalid-secret"
  );

  const core = new EarlyActorCore(options({ maxNativeAmount: 10, maxTokenAmount: 100 }));
  const decoded31ByteAddress = encodeBase58(Buffer.alloc(31, 7));
  assert.match(decoded31ByteAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(isCanonicalSolanaAddress(firstMint), true);
  assert.equal(isCanonicalSolanaAddress(decoded31ByteAddress), false);
  const cases = [
    [frame({ mint: thirdMint }), "mint-not-observed"],
    [frame({ mint: decoded31ByteAddress }), "invalid-mint"],
    [{ ...frame(), traderPublicKey: "not-base58" }, "invalid-actor-address"],
    [{ ...frame(), signature: "3".repeat(20) }, "invalid-transaction-provenance"],
    [{ ...frame(), source: "pumpfun" }, "unsupported-source"],
    [{ ...frame(), txType: "purchase" }, "invalid-side"],
    [{ ...frame(), solAmount: "1e1" }, "invalid-amount"],
    [{ ...frame(), tokenAmount: -1 }, "invalid-amount"],
    [{ ...frame(), solAmount: 11 }, "invalid-amount"],
    [{ ...frame(), tokenAmount: 101 }, "invalid-amount"],
    [{ ...frame(), solAmount: 0, tokenAmount: 0 }, "invalid-amount"],
    [{ ...frame(), sourceTimestamp: "2026-02-30T00:00:00Z" }, "invalid-timestamp"],
    [{ ...frame(), sourceTimestamp: at(10 * 60 * 1_000) }, "invalid-timestamp"],
    [{ ...finalizedObservation(), source: undefined }, "unsupported-source"],
    [{ ...finalizedObservation(), evidenceClass: "provider-observed" }, "invalid-evidence-class"],
    [{ ...finalizedObservation(), slot: null }, "invalid-slot"],
    [[], "invalid-event"]
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => core.ingest(input, { observedAt: at(0) }),
      (error) => error instanceof EarlyActorError && error.code === code,
      `expected ${code}`
    );
  }
  assert.throws(
    () => core.ingest({ ...finalizedObservation(), observedAt: undefined }),
    (error) => error instanceof EarlyActorError && error.code === "invalid-timestamp"
  );
  assert.equal(core.snapshot().retention.retainedEventCount, 0);
});

test("deduplicates transaction provenance deterministically and fails closed on conflicts", () => {
  const core = new EarlyActorCore(options());
  const first = core.ingest(frame({ index: 0 }), { observedAt: at(2_000) });
  const replay = core.ingest(frame({ index: 0 }), { observedAt: at(9_000) });

  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  assert.equal(replay.accepted, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.timestamps.observedAt, at(2_000));
  assert.equal(core.eventsForMint(firstMint).length, 1);

  assert.throws(
    () => core.ingest({ ...frame({ index: 0 }), solAmount: 2 }, { observedAt: at(10_000) }),
    (error) => error instanceof EarlyActorError && error.code === "transaction-conflict"
  );
  assert.equal(core.eventsForMint(firstMint).length, 1);

  first.event.actor = "Actor 0";
  assert.notEqual(core.eventsForMint(firstMint)[0].actor, "Actor 0");
});

test("coverage and source timestamp absence remain explicit until every configured gate passes", () => {
  const core = new EarlyActorCore(options({
    minimumEventCount: 3,
    minimumActorCount: 2,
    minimumSourceTimestampRatio: 0.5
  }));
  const empty = core.snapshot();
  assert.equal(empty.sourceCoverage.state, "missing");
  assert.equal(empty.byMint[firstMint].coverage.state, "missing");
  assert.equal(empty.byMint[firstMint].coverage.sourceTimestamps.state, "missing");
  assert.equal(empty.byMint[firstMint].metrics, null);

  core.ingest(frame({ index: 0, sourceTimestamp: null }), { observedAt: at(0) });
  core.ingest(frame({ index: 1, sourceTimestamp: null }), { observedAt: at(10_000) });
  const insufficient = core.snapshot().byMint[firstMint];
  assert.equal(insufficient.coverage.state, "insufficient-sample");
  assert.equal(insufficient.coverage.sourceTimestamps.state, "missing");
  assert.equal(insufficient.coverage.gate.eventCountMet, false);
  assert.equal(insufficient.coverage.gate.actorCountMet, false);
  assert.equal(insufficient.coverage.gate.sourceTimestampRatioMet, false);
  assert.equal(insufficient.metrics, null);

  core.ingest(frame({ index: 2, actor: actorB, sourceTimestamp: at(19_000) }), { observedAt: at(20_000) });
  core.ingest(frame({ index: 3, actor: actorB, sourceTimestamp: at(29_000) }), { observedAt: at(30_000) });
  const available = core.snapshot().byMint[firstMint];
  assert.equal(available.coverage.state, "available");
  assert.deepEqual(available.coverage.sourceTimestamps, {
    state: "partial",
    availableCount: 2,
    missingCount: 2,
    ratio: 0.5
  });
  assert.ok(available.metrics);

  const withoutCreationEvidence = new EarlyActorCore(options({ mintCreatedAt: {} }));
  withoutCreationEvidence.ingest(frame({ index: 8 }), { observedAt: at(40_000) });
  const missingTiming = withoutCreationEvidence.snapshot().byMint[firstMint];
  assert.deepEqual(missingTiming.coverage.launchObservedAt, { state: "missing", value: null });
  assert.equal(missingTiming.metrics.timing.state, "missing");
  assert.equal(missingTiming.metrics.timing.reason, "launch-observed-at-missing");
});

test("gated aggregates report timing, repeat activity, bounded duration evidence, concentration, and bursts", () => {
  const core = new EarlyActorCore(options({
    minimumEventCount: 7,
    minimumActorCount: 3,
    minimumSourceTimestampRatio: 1,
    burstWindowMs: 60_000
  }));
  const observations = [
    { index: 0, actor: actorA, side: "buy", sol: 4, token: 40, offset: 0 },
    { index: 1, actor: actorB, side: "buy", sol: 3, token: 30, offset: 20_000 },
    { index: 2, actor: actorA, side: "buy", sol: 2, token: 20, offset: 40_000 },
    { index: 3, actor: actorC, side: "buy", sol: 1, token: 10, offset: 90_000 },
    { index: 4, actor: actorA, side: "sell", sol: 1, token: 10, offset: 120_000 },
    { index: 5, actor: actorB, side: "sell", sol: 1, token: 10, offset: 180_000 },
    { index: 6, actor: actorB, side: "sell", sol: 0.5, token: 5, offset: 200_000 }
  ];
  for (const observation of observations) {
    core.ingest(frame({
      ...observation,
      sourceTimestamp: at(observation.offset - 1_000)
    }), { observedAt: at(observation.offset) });
  }

  const coin = core.snapshot().byMint[firstMint];
  assert.equal(coin.coverage.state, "available");
  assert.equal(coin.coverage.eventCount, 7);
  assert.equal(coin.coverage.uniqueActorCount, 3);
  assert.deepEqual(coin.metrics.timing.actorFirstObservationOffsetMs, {
    minimum: 59_000,
    median: 79_000,
    maximum: 149_000
  });
  assert.equal(coin.metrics.timing.basis, "source-timestamp-minus-launch-observed-at");
  assert.equal(coin.metrics.timing.earlyWindowMs, 300_000);
  assert.equal(coin.metrics.timing.actorsObservedWithinWindow, 3);
  assert.deepEqual(coin.metrics.repeatActivity, {
    state: "available",
    actorsWithMultipleBuys: 1,
    actorsWithMultipleSells: 1,
    actorsObservedOnBothSides: 2
  });
  assert.deepEqual(coin.metrics.holdingDurationEvidence, {
    state: "available",
    basis: "validated-buy-to-subsequent-sell",
    timestampBasis: "source-timestamp",
    pairedObservationCount: 2,
    minimumMs: 120_000,
    medianMs: 140_000,
    maximumMs: 160_000
  });
  assert.equal(coin.metrics.amountConcentration.largestActorShare, 0.56);
  assert.equal(coin.metrics.amountConcentration.largestThreeActorShare, 1);
  assert.deepEqual(coin.metrics.activityBurst, {
    state: "available",
    timestampBasis: "source-timestamp",
    windowMs: 60_000,
    maximumEventCount: 3,
    maximumUniqueActorCount: 2,
    startedAt: at(-1_000),
    endedAt: at(39_000)
  });

  const retained = core.eventsForMint(firstMint);
  assert.equal(retained.length, 7);
  assert.deepEqual(retained.map(({ timestamps }) => timestamps.observedAt), observations.map(({ offset }) => at(offset)));
  const serialized = JSON.stringify({ coin, retained });
  for (const privateValue of [actorA, actorB, actorC, ...observations.map(({ index }) => signature(index))]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue));
  }
  for (const disallowedOutputTerm of ["smart money", "coordinated actors", "insider", "\\bbot\\b", "trade signal"]) {
    assert.doesNotMatch(serialized.toLowerCase(), new RegExp(disallowedOutputTerm));
  }
});

test("retention is deterministically bounded by event count and observation-time high water", () => {
  const byCount = new EarlyActorCore(options({
    maxEvents: 2,
    maxAgeMs: 1_000_000,
    minimumEventCount: 2
  }));
  byCount.ingest(frame({ index: 0 }), { observedAt: at(0) });
  byCount.ingest(frame({ index: 1 }), { observedAt: at(10_000) });
  byCount.ingest(frame({ index: 2 }), { observedAt: at(20_000) });
  assert.deepEqual(
    byCount.eventsForMint(firstMint).map(({ timestamps }) => timestamps.observedAt),
    [at(10_000), at(20_000)]
  );
  assert.equal(byCount.snapshot().retention.droppedEventCount, 1);

  const byAge = new EarlyActorCore(options({
    maxEvents: 10,
    maxAgeMs: 60_000
  }));
  byAge.ingest(frame({ index: 0 }), { observedAt: at(0) });
  byAge.ingest(frame({ index: 1 }), { observedAt: at(30_000) });
  byAge.ingest(frame({ index: 2 }), { observedAt: at(120_000) });
  assert.deepEqual(
    byAge.eventsForMint(firstMint).map(({ timestamps }) => timestamps.observedAt),
    [at(120_000)]
  );
  assert.equal(byAge.snapshot().retention.droppedEventCount, 2);

  const staleReplay = byAge.ingest(frame({ index: 0 }), { observedAt: at(0) });
  assert.equal(staleReplay.accepted, true);
  assert.equal(staleReplay.retained, false);
  assert.equal(byAge.eventsForMint(firstMint).length, 1);
  assert.equal(byAge.snapshot().retention.droppedEventCount, 3);
});
