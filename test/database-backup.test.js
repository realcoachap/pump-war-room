import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createVerifiedBackup,
  DatabaseVerificationError,
  inspectDatabaseFile,
  verifyRestorableBackup
} from "../src/database-backup.js";
import { Store } from "../src/store.js";

const createdAt = "2026-08-08T12:00:00.000Z";

function temporaryWorkspace(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-backup-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function digest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function seededStore(directory) {
  const databasePath = path.join(directory, "live.db");
  const store = new Store(databasePath);
  store.upsertToken({ mint: "LiveMintPump", symbol: "LIVE", source: "pumpportal", createdAt });
  store.addEvent("mint", { mint: "LiveMintPump", source: "pumpportal" });
  store.addAlert({ level: "signal", title: "Observed", message: "Live row", mint: "LiveMintPump", createdAt });
  store.upsertCallout({ externalId: "callout-1", mint: "LiveMintPump", source: "bark", createdAt });
  return { store, databasePath };
}

test("creates and verifies a no-clobber snapshot containing committed WAL data", (t) => {
  const directory = temporaryWorkspace(t);
  const backupDirectory = path.join(directory, "backups");
  const scratchDirectory = path.join(directory, "scratch");
  const destination = path.join(backupDirectory, "war-room-20260808.db");
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());

  assert.equal(lstatSync(`${databasePath}-wal`).isFile(), true);
  const sourceBefore = digest(databasePath);
  const walBefore = digest(`${databasePath}-wal`);
  const report = createVerifiedBackup(databasePath, destination, { scratchRoot: scratchDirectory });

  assert.equal(report.liveDatabaseReplaced, false);
  assert.equal(report.backup.path, destination);
  assert.equal(report.backup.integrityCheck, "ok");
  assert.equal(report.disposableRestore.verified, true);
  assert.deepEqual(report.disposableRestore.applicationWriteProbe, { verified: true, rolledBack: true });
  assert.deepEqual(report.backup.rowCounts, { tokens: 1, events: 1, alerts: 1, callouts: 1 });
  assert.deepEqual(report.backup.invalidJsonPayloads, { tokens: 0, events: 0, callouts: 0 });
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(digest(databasePath), sourceBefore);
  assert.equal(digest(`${databasePath}-wal`), walBefore);
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const incompatibleConstraint = path.join(directory, "incompatible-constraint.db");
  const constrained = new DatabaseSync(incompatibleConstraint);
  constrained.exec(`
    CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(payload NOT LIKE '%pumpportal%'), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL);
    CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC);
    PRAGMA user_version = 501;
  `);
  constrained.close();
  assert.throws(
    () => verifyRestorableBackup(incompatibleConstraint, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /schema objects do not exactly match/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);
  assert.equal(readdirSync(backupDirectory).some((name) => name.includes(".partial")), false);

  const restored = new DatabaseSync(destination, { readOnly: true });
  t.after(() => restored.close());
  assert.equal(JSON.parse(restored.prepare("SELECT payload FROM tokens WHERE mint=?").get("LiveMintPump").payload).symbol, "LIVE");
  assert.equal(store.token("LiveMintPump").symbol, "LIVE");
});

test("standalone restore verification is read-only and removes its disposable copy", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const destination = path.join(directory, "backup.db");
  const { store, databasePath } = seededStore(directory);
  createVerifiedBackup(databasePath, destination, { scratchRoot: scratchDirectory });
  store.db.close();

  const before = { hash: digest(destination), modifiedAt: statSync(destination).mtime.toISOString() };
  const report = verifyRestorableBackup(destination, { scratchRoot: scratchDirectory });

  assert.equal(report.disposableRestore.verified, true);
  assert.equal(report.artifact.sha256, before.hash);
  assert.equal(digest(destination), before.hash);
  assert.equal(statSync(destination).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
  assert.deepEqual(inspectDatabaseFile(destination).rowCounts, { tokens: 1, events: 1, alerts: 1, callouts: 1 });
});

test("rejects an active WAL database whose main file is not a standalone restore", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  mkdirSync(scratchDirectory);
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.upsertToken({ mint: "LiveMintPump", symbol: "UPDATED", source: "pumpportal", createdAt });

  assert.ok(statSync(`${databasePath}-wal`).size > 0);
  assert.equal(store.token("LiveMintPump").symbol, "UPDATED");
  assert.throws(
    () => verifyRestorableBackup(databasePath, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /not a standalone artifact/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);
  assert.equal(store.token("LiveMintPump").symbol, "UPDATED");
});

test("refuses same-path and overwrite attempts without changing either file", (t) => {
  const directory = temporaryWorkspace(t);
  const destination = path.join(directory, "backup.db");
  const scratchDirectory = path.join(directory, "scratch");
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());

  assert.throws(
    () => createVerifiedBackup(databasePath, databasePath, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /different from the live database/.test(error.message)
  );

  writeFileSync(destination, "keep-existing-backup");
  const existingHash = digest(destination);
  assert.throws(
    () => createVerifiedBackup(databasePath, destination, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /refusing to overwrite/.test(error.message)
  );
  assert.equal(digest(destination), existingHash);
  assert.equal(store.token("LiveMintPump").symbol, "LIVE");
  assert.equal(readdirSync(directory).some((name) => name.includes(".partial")), false);
});

test("keeps backup staging private in a pre-existing shared directory", (t) => {
  const directory = temporaryWorkspace(t);
  const destinationDirectory = path.join(directory, "shared-backups");
  mkdirSync(destinationDirectory, { mode: 0o755 });
  const destination = path.join(destinationDirectory, "private.db");
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());
  const previousUmask = process.umask(0o002);
  t.after(() => process.umask(previousUmask));

  const report = createVerifiedBackup(databasePath, destination, { scratchRoot: path.join(directory, "scratch") });

  assert.equal(report.backup.mode, "0600");
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(readdirSync(destinationDirectory).some((name) => name.includes(".partial")), false);
});

test("rejects corrupt, truncated, and wrong-schema artifacts and cleans scratch space", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const corrupt = path.join(directory, "corrupt.db");
  writeFileSync(corrupt, "not a sqlite database");
  assert.throws(() => verifyRestorableBackup(corrupt, { scratchRoot: scratchDirectory }), DatabaseVerificationError);
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const incompatibleTypes = path.join(directory, "incompatible-types.db");
  const strict = new DatabaseSync(incompatibleTypes);
  strict.exec(`
    CREATE TABLE tokens (mint INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL);
    CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  strict.close();
  assert.throws(
    () => verifyRestorableBackup(incompatibleTypes, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /incompatible declared type/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const triggered = path.join(directory, "triggered.db");
  const triggerStore = new Store(triggered);
  triggerStore.db.exec(`CREATE TRIGGER reject_events BEFORE INSERT ON events
    BEGIN SELECT RAISE(ABORT, 'event writes disabled'); END;`);
  triggerStore.db.close();
  assert.throws(
    () => verifyRestorableBackup(triggered, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /unsupported trigger/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const wrongSchema = path.join(directory, "wrong-schema.db");
  const unrelated = new DatabaseSync(wrongSchema);
  unrelated.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  unrelated.close();
  assert.throws(
    () => verifyRestorableBackup(wrongSchema, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /missing table tokens/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const incompatibleSchema = path.join(directory, "incompatible-schema.db");
  const incompatible = new DatabaseSync(incompatibleSchema);
  incompatible.exec(`
    CREATE TABLE tokens (mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL);
    CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  incompatible.close();
  assert.throws(
    () => verifyRestorableBackup(incompatibleSchema, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /tokens has an incompatible primary key/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);

  const valid = path.join(directory, "valid.db");
  const { store, databasePath } = seededStore(path.join(directory, "source"));
  createVerifiedBackup(databasePath, valid, { scratchRoot: scratchDirectory });
  store.db.close();
  truncateSync(valid, Math.max(1, Math.floor(statSync(valid).size / 2)));
  assert.throws(() => verifyRestorableBackup(valid, { scratchRoot: scratchDirectory }), DatabaseVerificationError);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("CLI creates a backup and reports an explicitly non-destructive restore drill", (t) => {
  const directory = temporaryWorkspace(t);
  const destination = path.join(directory, "cli-backup.db");
  const scratchDirectory = path.join(directory, "scratch");
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());
  const cli = path.resolve("scripts/database-cli.js");

  const backup = spawnSync(process.execPath, [cli, "backup", "--source", databasePath, "--output", destination, "--scratch-dir", scratchDirectory], {
    encoding: "utf8"
  });
  assert.equal(backup.status, 0, backup.stderr);
  const backupReport = JSON.parse(backup.stdout);
  assert.equal(backupReport.action, "verified-backup-created");
  assert.equal(backupReport.liveDatabaseReplaced, false);

  const verify = spawnSync(process.execPath, [cli, "restore-verify", "--backup", destination, "--scratch-dir", scratchDirectory], {
    encoding: "utf8"
  });
  assert.equal(verify.status, 0, verify.stderr);
  const verifyReport = JSON.parse(verify.stdout);
  assert.equal(verifyReport.action, "disposable-restore-verified");
  assert.equal(verifyReport.disposableRestore.verified, true);
  assert.equal(verifyReport.liveDatabaseReplaced, false);
  assert.equal(store.token("LiveMintPump").symbol, "LIVE");
  assert.deepEqual(readdirSync(scratchDirectory), []);
});
