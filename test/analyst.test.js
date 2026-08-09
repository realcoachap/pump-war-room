import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot, MAX_QUESTION_LENGTH } from "../src/analyst.js";

const NOW = "2026-08-08T21:00:00.000Z";

const token = (overrides = {}) => ({
  mint: "MintPump111111111111111111111111111111pump",
  name: "Agent One",
  symbol: "ONE",
  source: "pumpportal",
  createdAt: "2026-08-08T20:59:30.000Z",
  momentum: 71,
  narrative: "AI agents",
  risk: null,
  riskConfidence: "unavailable",
  status: "bonding",
  ...overrides
});

test("returns the stable local result contract and sanitizes ordinary whitespace", () => {
  const result = analyzeSnapshot("  feed   status  ", {
    mode: "live",
    feedHealth: "live",
    lastMintAt: "2026-08-08T20:59:30.000Z",
    tokens: []
  }, { now: NOW });

  assert.deepEqual(Object.keys(result), ["answer", "evidence", "generatedAt", "mode"]);
  assert.equal(result.mode, "local");
  assert.equal(result.generatedAt, NOW);
  assert.match(result.answer, /feed health as live/i);
  assert.ok(result.evidence.every((item) => typeof item.citation === "string" && typeof item.detail === "string"));
});

test("rejects empty, oversized, non-string, and control-character questions", () => {
  const snapshot = {};
  assert.throws(() => analyzeSnapshot("   ", snapshot), /must not be empty/);
  assert.throws(() => analyzeSnapshot("x".repeat(MAX_QUESTION_LENGTH + 1), snapshot), /at most/);
  assert.throws(() => analyzeSnapshot(null, snapshot), /must be a string/);
  assert.throws(() => analyzeSnapshot("feed\u0000status", snapshot), /control characters/);
});

test("grounds feed health and freshness in snapshot telemetry", () => {
  const result = analyzeSnapshot("Is the feed live and fresh?", {
    mode: "live",
    feedHealth: "live",
    lastMintAt: "2026-08-08T20:59:30.000Z",
    reconnects: 2,
    tokens: []
  }, { now: NOW });

  assert.match(result.answer, /30s old/);
  assert.match(result.answer, /fresh/i);
  assert.ok(result.evidence.some((item) => item.citation === "snapshot.feedHealth"));
  assert.ok(result.evidence.some((item) => item.citation === "snapshot.lastMintAt"));
  assert.ok(result.evidence.some((item) => item.citation === "snapshot.reconnects"));
});

test("top momentum and newest answers exclude non-PumpPortal rows in live mode", () => {
  const result = analyzeSnapshot("Show top momentum and newest tokens", {
    mode: "live",
    tokens: [
      token({ mint: "RealOlder11111111111111111111111111111pump", symbol: "OLD", momentum: 80, createdAt: "2026-08-08T20:58:00.000Z" }),
      token({ mint: "RealNewer11111111111111111111111111111pump", symbol: "NEW", momentum: 76, createdAt: "2026-08-08T20:59:50.000Z" }),
      token({ mint: "DemoFake11111111111111111111111111111pump", symbol: "FAKE", source: "demo", momentum: 100, createdAt: "2026-08-08T20:59:59.000Z" }),
      token({ mint: "Unknown111111111111111111111111111111pump", symbol: "UNK", source: undefined, momentum: 99 })
    ]
  }, { now: NOW });

  assert.match(result.answer, /OLD 80\/100/);
  assert.match(result.answer, /Newest mint observations: NEW/);
  assert.doesNotMatch(result.answer, /FAKE|UNK/);
  assert.ok(result.evidence.some((item) => item.mint === "RealOlder11111111111111111111111111111pump"));
  assert.ok(result.evidence.some((item) => item.mint === "RealNewer11111111111111111111111111111pump"));
});

test("narrative counts are derived only from eligible supplied tokens", () => {
  const result = analyzeSnapshot("What narratives are active?", {
    mode: "live",
    tokens: [
      token({ mint: "AiOne11111111111111111111111111111111pump" }),
      token({ mint: "AiTwo11111111111111111111111111111111pump", symbol: "TWO" }),
      token({ mint: "Animal1111111111111111111111111111111pump", symbol: "CAT", narrative: "Animals" }),
      token({ mint: "DemoAnimal111111111111111111111111111pump", source: "demo", narrative: "Animals" })
    ]
  }, { now: NOW });

  assert.match(result.answer, /AI agents \(2\)/);
  assert.match(result.answer, /Animals \(1\)/);
  assert.ok(result.evidence.every((item) => item.citation === "snapshot.tokens.narrative"));
});

test("risk analysis reports evidence classes while withholding uncalibrated composites", () => {
  const result = analyzeSnapshot("Explain risk confidence", {
    mode: "live",
    tokens: [
      token({ mint: "Unavailable111111111111111111111111111pump", symbol: "UNK", risk: 99, riskConfidence: "unavailable" }),
      token({
        mint: "Observed111111111111111111111111111111pump", symbol: "OBS", risk: 42,
        riskConfidence: "provider-observed",
        riskIdentity: { overallEvidence: "provider-observed", factors: { concentration: { top10Percentage: 51.2 } } }
      })
    ]
  }, { now: NOW });

  assert.doesNotMatch(result.answer, /99|42\/100/);
  assert.match(result.answer, /provider-observed 1/);
  assert.match(result.answer, /does not establish duplicate content, common control, fraud, or safety/i);
  const observed = result.evidence.find((item) => item.mint?.startsWith("Observed"));
  assert.match(observed.detail, /top-10: 51.2%/);
  assert.match(observed.detail, /numeric composite withheld/);
});

test("lifecycle answers cite token mints or the snapshot aggregate without claiming finalization", () => {
  const detailed = analyzeSnapshot("Any graduations?", {
    mode: "live",
    stats: { migrationsObserved: 1 },
    tokens: [token({ mint: "Graduate111111111111111111111111111111pump", symbol: "GRAD", status: "migration-observed", migrationEvidence: { evidenceClass: "feed-observed-processed" } })]
  }, { now: NOW });
  assert.match(detailed.answer, /GRAD/);
  assert.match(detailed.answer, /not independently finalized proof/i);
  assert.equal(detailed.evidence[0].mint, "Graduate111111111111111111111111111111pump");

  const aggregateOnly = analyzeSnapshot("Any graduations?", {
    mode: "live",
    stats: { migrationsObserved: 2 },
    tokens: []
  }, { now: NOW });
  assert.match(aggregateOnly.answer, /mint-level details are unavailable/);
  assert.equal(aggregateOnly.evidence[0].citation, "snapshot.stats.migrationsObserved");
});

test("callouts remain explicitly third-party and mint-cited", () => {
  const result = analyzeSnapshot("What are the latest callouts?", {
    mode: "live",
    tokens: [],
    callouts: [{
      mint: "Callout11111111111111111111111111111111pump",
      symbol: "CALL",
      sourceActor: "Actor 27",
      multiple: 3.5,
      createdAt: "2026-08-08T20:58:00.000Z"
    }]
  }, { now: NOW });

  assert.match(result.answer, /Actor 27 on CALL/);
  assert.doesNotMatch(result.answer, /@observer|caller/i);
  assert.match(result.answer, /third-party observations/i);
  assert.equal(result.evidence[0].citation, "snapshot.callouts");
  assert.equal(result.evidence[0].mint, "Callout11111111111111111111111111111111pump");
});

test("trade and external-data requests stop at the read-only snapshot boundary", () => {
  const snapshot = { mode: "live", tokens: [token()] };
  const trade = analyzeSnapshot("What should I buy?", snapshot, { now: NOW });
  assert.match(trade.answer, /cannot recommend, execute, or simulate a trade/i);

  const external = analyzeSnapshot("Search Twitter for this token", snapshot, { now: NOW });
  assert.match(external.answer, /does not call external services/i);
});

test("early-actor evidence cannot change rankings or recommendation-boundary answers", () => {
  const baseline = { mode: "live", tokens: [token()] };
  const actorDecorated = {
    mode: "live",
    tokens: [{
      ...token(),
      earlyActor: {
        coverage: { state: "available", uniqueActorCount: 12, eventCount: 40 },
        metrics: { concentration: { largestObservedActivitySharePct: 97 } },
        actors: ["Actor 19"]
      }
    }],
    earlyActorIntelligence: {
      downstream: {
        status: "withheld",
        rankingImpact: "none",
        riskProbabilityImpact: "none",
        telegramAlertImpact: "none",
        recommendationImpact: "none"
      }
    }
  };

  for (const question of ["What should I buy?", "Show top momentum"]) {
    assert.deepEqual(
      analyzeSnapshot(question, actorDecorated, { now: NOW }),
      analyzeSnapshot(question, baseline, { now: NOW })
    );
  }
});

test("analysis does not mutate the supplied snapshot", () => {
  const snapshot = {
    mode: "live",
    tokens: [
      token({ mint: "Lower11111111111111111111111111111111pump", momentum: 10 }),
      token({ mint: "Higher1111111111111111111111111111111pump", momentum: 90 })
    ]
  };
  const before = JSON.stringify(snapshot);
  analyzeSnapshot("top momentum", snapshot, { now: NOW });
  assert.equal(JSON.stringify(snapshot), before);
});
