import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

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
