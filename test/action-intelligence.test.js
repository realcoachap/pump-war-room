import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoinComparison,
  buildCoinTimeline,
  buildMeasuredBrief,
  detectMaterialAlerts,
  sendTelegramAlert,
  telegramAlertStatus,
  telegramRetryPlan,
  TelegramDeliveryError
} from "../src/action-intelligence.js";

const mintA = "11111111111111111111111111111111";
const mintB = "22222222222222222222222222222222";
const mintC = "33333333333333333333333333333333";
const now = "2026-08-09T12:00:00.000Z";

function token(overrides = {}) {
  return {
    mint: mintA,
    symbol: "EVID",
    source: "pumpportal",
    createdAt: "2026-08-09T10:00:00.000Z",
    status: "bonding",
    ...overrides
  };
}

test("material alerts label processed migration evidence without claiming finalization", () => {
  const alerts = detectMaterialAlerts({
    previous: token(),
    current: token({
      status: "migration-observed",
      migrationEvidence: { evidenceClass: "feed-observed-processed", observedAt: "2026-08-09T11:59:00.000Z" }
    }),
    observedAt: now
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "migration-observed");
  assert.equal(alerts[0].evidenceClass, "feed-observed-processed");
  assert.match(alerts[0].message, /finalization is not independently verified/);
  assert.doesNotMatch(alerts[0].title + alerts[0].message, /graduated|finalized/i);
});

test("score alerts require two numeric observations and use a versioned hourly dedupe bucket", () => {
  assert.deepEqual(detectMaterialAlerts({ current: token(), previous: token(), currentScore: null, previousScore: 20, observedAt: now }), []);
  assert.deepEqual(detectMaterialAlerts({ current: token(), previous: null, currentScore: 80, previousScore: 20, observedAt: now }), []);
  assert.deepEqual(detectMaterialAlerts({ current: token(), previous: token(), currentScore: 34.9, previousScore: 20, observedAt: now }), []);
  const first = detectMaterialAlerts({ current: token(), previous: token(), currentScore: 35, previousScore: 20, observedAt: now })[0];
  const repeat = detectMaterialAlerts({ current: token(), previous: token(), currentScore: 35, previousScore: 20, observedAt: "2026-08-09T12:45:00.000Z" })[0];
  const later = detectMaterialAlerts({ current: token(), previous: token(), currentScore: 35, previousScore: 20, observedAt: "2026-08-09T13:00:00.000Z" })[0];
  assert.equal(first.kind, "score-rise");
  assert.match(first.dedupeKey, /material-score-v1/);
  assert.equal(first.dedupeKey, repeat.dedupeKey);
  assert.notEqual(first.dedupeKey, later.dedupeKey);
  assert.match(first.message, /not a price forecast/);
});

test("risk alerts require explicit provider evidence and named operational thresholds", () => {
  const unavailable = token({
    riskIdentity: { factors: {
      concentration: { evidenceClass: "locally-derived", top10Percentage: 99 },
      developer: { evidenceClass: "unavailable", holdingPercentage: 99 }
    } }
  });
  assert.deepEqual(detectMaterialAlerts({ current: unavailable, observedAt: now }), []);
  const observed = token({
    riskIdentity: { factors: {
      concentration: { evidenceClass: "provider-observed", top10Percentage: 50, providerUpdatedAt: now },
      developer: { evidenceClass: "provider-observed", holdingPercentage: 12, fetchedAt: now }
    } }
  });
  const alerts = detectMaterialAlerts({ current: observed, observedAt: now });
  assert.deepEqual(alerts.map(({ kind }) => kind), ["risk-concentration", "risk-developer-holding"]);
  assert.ok(alerts.every((alert) => alert.evidenceClass === "provider-observed" && /uncalibrated/.test(alert.message)));
  assert.match(alerts[0].dedupeKey, /material-concentration-v1/);

  const previous = token({ riskIdentity: { factors: {
    concentration: { evidenceClass: "provider-observed", top10Percentage: 40, providerUpdatedAt: "2026-08-09T11:00:00Z" },
    developer: { evidenceClass: "provider-observed", holdingPercentage: 10, fetchedAt: "2026-08-09T11:00:00Z" }
  } } });
  const changed = token({ riskIdentity: { factors: {
    concentration: { evidenceClass: "provider-observed", top10Percentage: 50, providerUpdatedAt: now },
    developer: { evidenceClass: "provider-observed", holdingPercentage: 15, fetchedAt: now },
    identity: { evidenceClass: "locally-derived", exactDuplicateCount: 1, calculatedAt: now },
    creatorHistory: { evidenceClass: "locally-derived", observedLaunchCount: 2, calculatedAt: now }
  } } });
  assert.deepEqual(detectMaterialAlerts({ current: changed, previous, observedAt: now }).map(({ kind }) => kind), [
    "risk-concentration", "risk-developer-holding", "risk-identity-reuse", "risk-creator-history"
  ]);
  assert.ok(detectMaterialAlerts({ current: changed, previous, observedAt: now }).slice(2).every(({ evidenceClass }) => evidenceClass === "locally-derived"));
});

test("coin timeline merges only sanitized, typed, bounded evidence", () => {
  const result = buildCoinTimeline({
    mint: mintA,
    token: token({ riskIdentity: { factors: { concentration: {
      evidenceClass: "provider-observed", top10Percentage: 51, providerUpdatedAt: "2026-08-09T11:50:00Z",
      rawResponse: "must-not-leak"
    } } } }),
    events: [
      { kind: "mint", mint: mintA, createdAt: "2026-08-09T10:00:01Z", payload: { mint: mintA, source: "pumpportal", status: "bonding", raw: "secret" } },
      { kind: "risk-evidence", mint: mintA, occurredAt: "2026-08-09T11:50:00Z", evidenceClass: "provider-observed", payload: {
        mint: mintA, factor: "concentration", value: 51, unit: "%", source: "geckoterminal", limitation: "Uncalibrated provider observation", raw: "secret"
      } },
      { kind: "risk-evidence", mint: mintB, occurredAt: now, evidenceClass: "provider-observed", payload: { mint: mintB, factor: "concentration", value: 99 } }
    ],
    alerts: [{ mint: mintA, title: "Material evidence", message: "Bounded alert", evidenceClass: "provider-observed", evidenceAt: "2026-08-09T11:55:00Z", createdAt: now }],
    callouts: [{ mint: mintA, source: "bark", caller: "alpha", multiple: 2, createdAt: "2026-08-09T11:00:00Z", raw: "secret" }],
    outcome: { mint: mintA, windows: { "5m": { status: "observed", source: "geckoterminal", calculatedAt: "2026-08-09T10:06:00Z", returnPct: 5, maximumDrawdownPct: 3, raw: "secret" } } },
    generatedAt: now
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.rawProviderPayloadsIncluded, false);
  assert.ok(result.entries.length >= 5);
  assert.ok(result.entries.every((entry) => Object.keys(entry).every((key) => ["kind", "at", "evidenceClass", "title", "detail"].includes(key))));
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|"raw"|secret/);
  assert.throws(() => buildCoinTimeline({ mint: "bad", generatedAt: now }), /base58/);
  assert.throws(() => buildCoinTimeline({ mint: mintA, generatedAt: now, limit: 201 }), /between 1 and 200/);
  const firstPage = buildCoinTimeline({
    mint: mintA, generatedAt: now, limit: 1,
    events: [
      { kind: "mint", mint: mintA, createdAt: "2026-08-09T10:00:00Z", payload: { mint: mintA, source: "pumpportal" } },
      { kind: "update", mint: mintA, createdAt: "2026-08-09T11:00:00Z", payload: { mint: mintA, source: "pumpportal" } }
    ]
  });
  const secondPage = buildCoinTimeline({
    mint: mintA, generatedAt: now, limit: 1, before: firstPage.nextBefore,
    events: [
      { kind: "mint", mint: mintA, createdAt: "2026-08-09T10:00:00Z", payload: { mint: mintA, source: "pumpportal" } },
      { kind: "update", mint: mintA, createdAt: "2026-08-09T11:00:00Z", payload: { mint: mintA, source: "pumpportal" } }
    ]
  });
  assert.notEqual(firstPage.entries[0].at, secondPage.entries[0].at);
  assert.equal(secondPage.nextBefore, null);
  assert.throws(() => buildCoinTimeline({ mint: mintA, generatedAt: now, before: "not-a-real-cursor" }), /cursor/);
});

test("comparison requires unique exact mints and keeps missing evidence explicit", () => {
  const snapshot = {
    generatedAt: now,
    tokens: [token(), token({ mint: mintB, symbol: "MISS", name: "Missing Evidence" })],
    leaderboard: { top100: [{ token: token(), score: 42, orderingBasis: "evidence-score", freshness: { state: "fresh" }, outcome: { windows: {
      "5m": { status: "observed", returnPct: 4, calculatedAt: now, source: "geckoterminal" }
    } } }] }
  };
  const result = buildCoinComparison({ mints: [mintA, mintB, mintC], snapshot });
  assert.equal(result.coins.length, 2);
  assert.deepEqual(result.missingMints, [mintC]);
  assert.equal(result.coins[0].outcomes["5m"].returnPct, 4);
  assert.equal(result.coins[1].outcomes["5m"].status, "unavailable");
  assert.equal(result.coins[1].factors.top10Percentage.value, null);
  assert.throws(() => buildCoinComparison({ mints: [mintA, mintA], snapshot }), /unique/);
  assert.throws(() => buildCoinComparison({ mints: [mintA], snapshot }), /2 to 4/);
});

function outcome(expectedAt, returnPct, maximumDrawdownPct, overrides = {}) {
  return { status: "observed", source: "geckoterminal", expectedAt, calculatedAt: now, returnPct, maximumDrawdownPct, ...overrides };
}

test("measured briefs use closed-open period denominators and withhold sparse metrics", () => {
  const outcomes = [10, -5, 20].map((value, index) => ({ windows: {
    "5m": outcome(`2026-08-09T${String(9 + index).padStart(2, "0")}:00:00Z`, value, 4 + index),
    "15m": { status: "unavailable", expectedAt: `2026-08-09T${String(9 + index).padStart(2, "0")}:15:00Z`, reason: "target-observation-missing" },
    "1h": { status: "unavailable", expectedAt: "2026-08-09T12:00:00Z", reason: "window-not-mature" }
  } }));
  const brief = buildMeasuredBrief({
    period: "daily", now,
    activity: { launchesObserved: 10, migrationObservations: 2, materialAlerts: 3, thirdPartyCallouts: 4 },
    outcomes
  });
  assert.equal(brief.methodVersion, "measured-rolling-brief-v1");
  assert.match(brief.briefId, /daily/);
  assert.equal(brief.outcomes.windows["5m"].status, "sufficient-evidence");
  assert.equal(brief.outcomes.windows["5m"].hitRatePct, 66.67);
  assert.equal(brief.outcomes.windows["5m"].medianReturnPct, 10);
  assert.equal(brief.outcomes.windows["5m"].maximumDrawdownPct, 6);
  assert.equal(brief.outcomes.windows["15m"].status, "insufficient-evidence");
  assert.equal(brief.outcomes.windows["15m"].hitRatePct, null);
  assert.equal(brief.outcomes.windows["1h"].eligibleCount, 0, "windowEnd is exclusive");
  assert.equal(brief.outcomes.windows["1h"].coverageRatio, null, "an empty denominator is unavailable, not 0% coverage");
  assert.equal(brief.feedCoverage, "unmeasured");
  assert.equal(brief.priorPeriod.windowEnd, brief.windowStart);
  assert.throws(() => buildMeasuredBrief({ period: "daily", now, activity: { launchesObserved: -1 } }), /non-negative integer/);
});

test("Telegram configuration exposes only booleans and official send contract handles success and 429", async () => {
  const config = telegramAlertStatus({ TELEGRAM_BOT_TOKEN: "top-secret-token", TELEGRAM_CHAT_ID: "123" });
  assert.deepEqual(config, {
    status: "configured", tokenConfigured: true, chatConfigured: true,
    delivery: "restart-safe-bounded-at-least-once-material-alerts-only", paidBroadcastsRequired: false
  });
  assert.doesNotMatch(JSON.stringify(config), /top-secret-token|"123"/);
  let request;
  const sent = await sendTelegramAlert({
    id: 42,
    mint: mintA, title: "Migration feed observation", message: "Finalization is not verified.",
    evidenceClass: "feed-observed-processed", evidenceAt: now
  }, {
    token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "123", baseUrl: "https://war-room.example",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 77 } }; } };
    }
  });
  assert.deepEqual(sent, { ok: true, messageId: 77 });
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.link_preview_options, { is_disabled: true });
  assert.equal(body.disable_web_page_preview, undefined);
  assert.doesNotMatch(body.text, /pump\.fun/);
  assert.match(body.text, /Event: PWR-42/);

  await assert.rejects(sendTelegramAlert({ mint: mintA, title: "Rate", message: "Limited", evidenceClass: "locally-derived", evidenceAt: now }, {
    token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "123", baseUrl: "https://war-room.example",
    fetchImpl: async () => ({ ok: false, status: 429, async json() { return { ok: false, parameters: { retry_after: 3 } }; } })
  }), (error) => error instanceof TelegramDeliveryError && error.code === "rate-limited" && error.retryAfterSeconds === 3);
});

function sendTelegramWith(fetchImpl) {
  return sendTelegramAlert({
    mint: mintA,
    title: "Bounded delivery",
    message: "Classify this delivery result.",
    evidenceClass: "locally-derived",
    evidenceAt: now
  }, {
    token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    chatId: "123",
    baseUrl: "https://war-room.example",
    fetchImpl
  });
}

test("Telegram retry planning gives ambiguous delivery results four bounded exponential retries", () => {
  const plannedAt = Date.parse(now);
  for (const code of ["ambiguous-network-failure", "ambiguous-upstream-failure", "invalid-success-response"]) {
    const error = new TelegramDeliveryError("delivery is ambiguous", { code, ambiguous: true });
    for (const [attemptCount, delayMs] of [5_000, 10_000, 20_000, 40_000].entries()) {
      assert.deepEqual(telegramRetryPlan(error, { attemptCount: attemptCount + 1, now: plannedAt }), {
        retry: true,
        status: "retrying",
        errorCode: code,
        delayMs,
        nextAttemptAt: new Date(plannedAt + delayMs).toISOString()
      });
    }
    assert.deepEqual(telegramRetryPlan(error, { attemptCount: 5, now: plannedAt }), {
      retry: false,
      status: "dead-letter",
      errorCode: code,
      delayMs: null,
      nextAttemptAt: null
    });
  }
});

test("Telegram retry planning honors rate limits and dead-letters permanent HTTP 4xx", () => {
  const plannedAt = Date.parse(now);
  const rateLimited = new TelegramDeliveryError("slow down", { code: "rate-limited", retryAfterSeconds: 37 });
  assert.deepEqual(telegramRetryPlan(rateLimited, { attemptCount: 1, now: plannedAt }), {
    retry: true,
    status: "retrying",
    errorCode: "rate-limited",
    delayMs: 37_000,
    nextAttemptAt: new Date(plannedAt + 37_000).toISOString()
  });
  assert.deepEqual(telegramRetryPlan(
    new TelegramDeliveryError("missing retry hint", { code: "rate-limited" }),
    { attemptCount: 4, now: plannedAt }
  ), {
    retry: true,
    status: "retrying",
    errorCode: "rate-limited",
    delayMs: 60_000,
    nextAttemptAt: new Date(plannedAt + 60_000).toISOString()
  });
  assert.deepEqual(telegramRetryPlan(rateLimited, { attemptCount: 5, now: plannedAt }), {
    retry: false,
    status: "dead-letter",
    errorCode: "rate-limited",
    delayMs: null,
    nextAttemptAt: null
  });
  assert.deepEqual(telegramRetryPlan(
    new TelegramDeliveryError("bad request", { code: "http-400" }),
    { attemptCount: 1, now: plannedAt }
  ), {
    retry: false,
    status: "dead-letter",
    errorCode: "http-400",
    delayMs: null,
    nextAttemptAt: null
  });
});

test("Telegram network and HTTP 5xx results remain ambiguous for bounded retry", async () => {
  await assert.rejects(sendTelegramWith(async () => {
    throw new TypeError("socket closed after request upload");
  }), (error) => {
    assert.ok(error instanceof TelegramDeliveryError);
    assert.equal(error.code, "ambiguous-network-failure");
    assert.equal(error.ambiguous, true);
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });

  for (const status of [500, 502, 503]) {
    await assert.rejects(sendTelegramWith(async () => ({
      ok: false,
      status,
      async json() { return { ok: false }; }
    })), (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "ambiguous-upstream-failure");
      assert.equal(error.ambiguous, true);
      assert.equal(error.retryAfterSeconds, null);
      return true;
    });
  }
});

test("Telegram ordinary HTTP 4xx results are permanent rather than ambiguous", async () => {
  for (const status of [400, 401, 403, 404]) {
    await assert.rejects(sendTelegramWith(async () => ({
      ok: false,
      status,
      async json() { return { ok: false }; }
    })), (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, `http-${status}`);
      assert.equal(error.ambiguous, false);
      assert.equal(error.retryAfterSeconds, null);
      return true;
    });
  }
});

test("Telegram malformed HTTP 2xx success remains ambiguous", async () => {
  for (const json of [
    async () => ({ ok: true }),
    async () => ({ ok: true, result: {} }),
    async () => ({ ok: true, result: { message_id: 0 } }),
    async () => { throw new SyntaxError("truncated response body"); }
  ]) {
    await assert.rejects(sendTelegramWith(async () => ({
      ok: true,
      status: 200,
      json
    })), (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "invalid-success-response");
      assert.equal(error.ambiguous, true);
      assert.equal(error.retryAfterSeconds, null);
      return true;
    });
  }
});

test("Telegram malformed 429 responses retain a safe deterministic bounded-retry fallback", async () => {
  for (const json of [
    async () => ({ ok: false }),
    async () => ({ ok: false, parameters: { retry_after: "not-a-delay" } }),
    async () => ({ ok: false, parameters: { retry_after: 0 } }),
    async () => { throw new SyntaxError("truncated response body"); }
  ]) {
    await assert.rejects(sendTelegramWith(async () => ({
      ok: false,
      status: 429,
      json
    })), (error) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, "rate-limited");
      assert.equal(error.ambiguous, false);
      assert.equal(error.retryAfterSeconds, 60);
      return true;
    });
  }
});
