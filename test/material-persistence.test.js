import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { detectMaterialAlerts } from "../src/action-intelligence.js";

const mintA = "So11111111111111111111111111111111111111112";
const mintB = "11111111111111111111111111111111";
const observedAt = "2026-08-09T10:00:00.000Z";

function temporaryStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-material-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function materialAlert(mint, suffix = "one") {
  return {
    level: "risk",
    title: "Bounded material observation",
    message: "A named observational factor crossed the versioned materiality policy.",
    mint,
    kind: "risk-concentration",
    evidenceClass: "provider-observed",
    evidenceAt: observedAt,
    dedupeKey: `material-test:${mint}:${suffix}`
  };
}

function materialEvent(mint, suffix = "one") {
  return {
    kind: "risk-evidence",
    mint,
    eventKey: `material-event-test:${mint}:${suffix}`,
    evidenceClass: "provider-observed",
    occurredAt: observedAt,
    payload: {
      mint,
      factor: "concentration",
      value: 55,
      unit: "%",
      source: "geckoterminal",
      limitation: "Uncalibrated provider observation."
    }
  };
}

test("token state, feed event, material alert, and Telegram queue commit atomically", (t) => {
  const store = temporaryStore(t);
  const committed = store.upsertTokenWithAlerts({ mint: mintA, source: "pumpportal", createdAt: observedAt }, {
    eventKind: "mint",
    alerts: [materialAlert(mintA)],
    queueTelegram: true
  });
  assert.equal(committed.token.mint, mintA);
  assert.equal(committed.alerts.length, 1);
  assert.equal(store.eventsForMint(mintA).length, 1);
  assert.equal(store.dueTelegramAlerts({ now: new Date(Date.now() + 1_000).toISOString() }).length, 1);

  assert.throws(() => store.upsertTokenWithAlerts({ mint: mintB, source: "pumpportal", createdAt: observedAt }, {
    eventKind: "mint",
    alerts: [materialAlert(mintB), { ...materialAlert(mintB, "invalid"), evidenceClass: "raw-provider-payload" }],
    queueTelegram: true
  }), /evidenceClass is invalid/);
  assert.equal(store.token(mintB), null);
  assert.equal(store.eventsForMint(mintB).length, 0);
  assert.equal(store.alertsForMint(mintB).length, 0);
});

test("risk evidence, alert outbox, and durable baseline commit or roll back as one batch", (t) => {
  const store = temporaryStore(t);
  const baseline = {
    kind: "material-baseline",
    mint: "system",
    eventKey: "material-baseline-v1",
    evidenceClass: "locally-derived",
    occurredAt: observedAt,
    payload: {
      mint: "system",
      factor: "baseline",
      value: "initialized",
      unit: null,
      source: "locally-derived",
      limitation: "Upgrade state seeded without historical alerts."
    }
  };
  const committed = store.commitIntelligenceBatch({
    events: [materialEvent(mintA), baseline],
    alerts: [materialAlert(mintA)],
    queueTelegram: true
  });
  assert.equal(committed.writtenEvents, 2);
  assert.equal(committed.alerts.length, 1);
  assert.equal(store.hasIntelligenceEvent("material-baseline-v1"), true);

  const rolledBackKey = `material-event-test:${mintB}:rollback`;
  assert.throws(() => store.commitIntelligenceBatch({
    events: [{ ...materialEvent(mintB, "rollback"), eventKey: rolledBackKey }],
    alerts: [{ ...materialAlert(mintB), evidenceClass: "private-provider-response" }],
    queueTelegram: true
  }), /evidenceClass is invalid/);
  assert.equal(store.hasIntelligenceEvent(rolledBackKey), false);
  assert.equal(store.alertsForMint(mintB).length, 0);
});

test("score recurrences persist separately while an exact occurrence replay remains deduplicated", (t) => {
  const store = temporaryStore(t);
  const token = { mint: mintA, symbol: "EVID" };
  const transitions = [
    { previousScore: 20, currentScore: 35, observedAt: "2026-08-09T12:01:00.000Z" },
    { previousScore: 35, currentScore: 20, observedAt: "2026-08-09T12:20:00.000Z" },
    { previousScore: 20, currentScore: 35, observedAt: "2026-08-09T12:45:00.000Z" }
  ];
  const alerts = transitions.map((values) => detectMaterialAlerts({ current: token, previous: token, ...values })[0]);
  const persisted = alerts.map((entry) => ({ ...entry, createdAt: entry.evidenceAt }));
  assert.equal(store.addAlert(persisted[0], { queueTelegram: true }).kind, "score-rise");
  assert.equal(store.addAlert({ ...persisted[0] }, { queueTelegram: true }), null, "exact replay must dedupe");
  assert.equal(store.addAlert(persisted[1], { queueTelegram: true }).kind, "score-drop");
  assert.equal(store.addAlert(persisted[2], { queueTelegram: true }).kind, "score-rise");
  assert.notEqual(alerts[0].dedupeKey, alerts[2].dedupeKey);
  assert.equal(store.dueTelegramAlerts({ now: "2026-08-09T13:00:00.000Z" }).length, 3);
});

test("measured activity excludes migrated legacy and non-source alerts from every material denominator", (t) => {
  const store = temporaryStore(t);
  store.upsertToken({ mint: mintA, source: "pumpportal", createdAt: observedAt });
  store.upsertToken({ mint: mintB, source: "demo", createdAt: observedAt });
  store.addAlert({ ...materialAlert(mintA, "supported"), createdAt: observedAt }, { queueTelegram: true });
  store.addAlert({
    level: "signal", title: "Pre-policy row", message: "Migrated alert", mint: mintA,
    kind: "legacy", evidenceClass: "unavailable", createdAt: observedAt
  });
  store.addAlert({ ...materialAlert(mintB, "wrong-source"), createdAt: observedAt });

  const activity = store.periodActivity({
    start: "2026-08-09T00:00:00.000Z",
    end: "2026-08-10T00:00:00.000Z",
    source: "pumpportal"
  });
  assert.equal(activity.materialAlerts, 1);
  assert.deepEqual(activity.materialByKind, { "risk-concentration": 1 });
  assert.deepEqual(activity.telegramDelivery, { pending: 1 });
  assert.equal(Object.hasOwn(activity.materialByKind, "legacy"), false);
  assert.deepEqual(store.telegramDeliveryCoverage(), {
    total: 2,
    statusCounts: { "not-queued": 1, pending: 1 }
  });
});

test("Telegram outbox schema rejects pending rows that have no recoverable due time", (t) => {
  const store = temporaryStore(t);
  const pending = store.addAlert(materialAlert(mintA, "outbox-invariant"), { queueTelegram: true });
  assert.equal(store.dueTelegramAlerts({ now: pending.createdAt }).length, 1);
  assert.throws(
    () => store.db.prepare("UPDATE alerts SET telegram_next_attempt_at=NULL WHERE id=?").run(pending.id),
    /constraint/i
  );
  assert.throws(
    () => store.db.prepare("UPDATE alerts SET telegram_next_attempt_at='zzzz' WHERE id=?").run(pending.id),
    /constraint/i
  );
  assert.equal(store.dueTelegramAlerts({ now: pending.createdAt }).length, 1);
});
