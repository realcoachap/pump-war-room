import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

const createdAt = "2026-08-08T12:00:00.000Z";

function temporaryStore(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-store-"));
  const store = new Store(path.join(directory, "war-room.db"));
  t.after(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function seedMixedSources(store) {
  store.upsertToken({ mint: "demo-mint", symbol: "DEMO", source: "demo", createdAt });
  store.upsertToken({ mint: "live-mint", symbol: "LIVE", source: "pumpportal", createdAt });
  store.upsertToken({ mint: "unknown-mint", symbol: "UNKNOWN", createdAt });

  store.addEvent("mint", { mint: "demo-mint", source: "demo" });
  store.addEvent("update", { mint: "demo-mint", source: "demo" });
  store.addEvent("mint", { mint: "live-mint", source: "pumpportal" });
  store.addEvent("update", { mint: "unknown-mint" });

  store.addAlert({ level: "signal", title: "Demo alert", message: "synthetic", mint: "demo-mint", createdAt });
  store.addAlert({ level: "signal", title: "Live alert", message: "verified", mint: "live-mint", createdAt });
  store.addAlert({ level: "signal", title: "Orphan alert", message: "unknown", mint: "orphan-mint", createdAt });

  store.upsertCallout({ externalId: "demo-named-callout", mint: "demo-mint", source: "demo", createdAt });
  store.upsertCallout({ externalId: "live-callout", mint: "live-mint", source: "bark", createdAt });
}

test("counts token, event, and associated alert rows by JSON payload source", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.countBySource("demo"), { tokens: 1, events: 2, alerts: 1 });
  assert.deepEqual(store.countBySource("pumpportal"), { tokens: 1, events: 1, alerts: 1 });
  assert.deepEqual(store.countBySource("missing"), { tokens: 0, events: 0, alerts: 0 });
  assert.throws(() => store.countBySource(""), /non-empty string/);
});

test("source operations tolerate malformed legacy JSON without treating it as demo data", (t) => {
  const store = temporaryStore(t);
  const insertToken = store.db.prepare("INSERT INTO tokens (mint,payload,created_at,updated_at) VALUES (?,?,?,?)");
  const insertEvent = store.db.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)");
  insertToken.run("malformed-mint", "{not-json", createdAt, createdAt);
  insertEvent.run("mint", "malformed-mint", "{not-json", createdAt);

  assert.deepEqual(store.countBySource("demo"), { tokens: 0, events: 0, alerts: 0 });
  assert.deepEqual(store.purgeDemoData(), { alerts: 0, events: 0, tokens: 0 });
  assert.deepEqual(store.tokens(), []);
  assert.equal(store.token("malformed-mint"), null);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM tokens WHERE mint='malformed-mint'").get().count, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM events WHERE mint='malformed-mint'").get().count, 1);
});

test("purges only demo tokens, demo events, and alerts tied to demo tokens", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.purgeDemoData(), { alerts: 1, events: 2, tokens: 1 });
  assert.deepEqual(store.countBySource("demo"), { tokens: 0, events: 0, alerts: 0 });

  assert.deepEqual(store.tokens().map((token) => token.mint).sort(), ["live-mint", "unknown-mint"]);
  assert.deepEqual(store.alerts().map((alert) => alert.title).sort(), ["Live alert", "Orphan alert"]);
  assert.deepEqual(store.callouts().map((callout) => callout.externalId).sort(), ["demo-named-callout", "live-callout"]);

  const remainingEvents = store.db.prepare("SELECT payload FROM events ORDER BY id").all().map((row) => JSON.parse(row.payload));
  assert.deepEqual(remainingEvents.map((event) => event.mint), ["live-mint", "unknown-mint"]);
});

test("demo purge is idempotent", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);

  assert.deepEqual(store.purgeDemoData(), { alerts: 1, events: 2, tokens: 1 });
  assert.deepEqual(store.purgeDemoData(), { alerts: 0, events: 0, tokens: 0 });
  assert.equal(store.count(), 2);
  assert.equal(store.callouts().length, 2);
});

test("demo purge rolls back every deletion when any step fails", (t) => {
  const store = temporaryStore(t);
  seedMixedSources(store);
  store.db.exec(`CREATE TRIGGER reject_demo_event_delete
    BEFORE DELETE ON events
    WHEN json_valid(OLD.payload) AND json_extract(OLD.payload, '$.source') = 'demo'
    BEGIN SELECT RAISE(ABORT, 'blocked demo event deletion'); END;`);

  assert.throws(() => store.purgeDemoData(), /blocked demo event deletion/);
  assert.deepEqual(store.countBySource("demo"), { tokens: 1, events: 2, alerts: 1 });
  assert.equal(store.alerts().length, 3);
  assert.equal(store.callouts().length, 2);
});
