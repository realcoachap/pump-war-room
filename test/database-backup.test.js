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
import { parseGeckoTerminalTokenInfo } from "../src/risk-identity.js";

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
  store.upsertEnrichmentState({
    mint: "LiveMintPump", provider: "dexscreener", pool: "Pool111", tokenSide: "base", dex: "raydium",
    sourceUrl: "https://dex.example/pools/Pool111", evidence: {
      outcome: { baseline: { observedAt: createdAt, nonempty: true }, windows: { "5m": { returnPct: 10, maximumDrawdownPct: 2 } } }
    }, status: "partial",
    missingReason: "missing-24h", errorCode: null, attemptCount: 1, lastAttemptAt: createdAt,
    nextAttemptAt: null, lastSuccessAt: createdAt, updatedAt: createdAt
  });
  store.upsertRiskIdentityState({
    mint: "11111111111111111111111111111111", provider: "geckoterminal",
    evidence: parseGeckoTerminalTokenInfo({ data: {
      id: "solana_11111111111111111111111111111111",
      type: "token",
      attributes: {
        address: "11111111111111111111111111111111", name: null, symbol: null, holders: null,
        developer_address: null, developer_holding_percentage: null, twitter_handle: null, telegram_handle: null, websites: []
      }
    } }, { mint: "11111111111111111111111111111111", fetchedAt: createdAt }),
    status: "available", missingReason: null, errorCode: null, attemptCount: 1, lastAttemptAt: createdAt,
    nextAttemptAt: null, lastSuccessAt: createdAt, updatedAt: createdAt
  });
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
  assert.deepEqual(report.backup.rowCounts, {
    tokens: 1, events: 1, alerts: 1, callouts: 1, outcome_enrichment: 1, risk_identity_enrichment: 1
  });
  assert.deepEqual(report.backup.invalidJsonPayloads, {
    tokens: 0, events: 0, callouts: 0, outcome_enrichment: 0, risk_identity_enrichment: 0
  });
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
    CREATE TABLE outcome_enrichment (
      mint TEXT PRIMARY KEY NOT NULL, provider TEXT, pool TEXT, token_side TEXT, dex TEXT, source_url TEXT,
      evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
      status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), last_attempt_at TEXT,
      next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL,
      CHECK(token_side IS NULL OR token_side IN ('base','quote'))
    );
    CREATE INDEX outcome_enrichment_provider_status_updated ON outcome_enrichment(provider, status, updated_at DESC, mint);
    PRAGMA user_version = 600;
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
  assert.deepEqual(JSON.parse(restored.prepare("SELECT evidence FROM outcome_enrichment WHERE mint=?").get("LiveMintPump").evidence), {
    outcome: { baseline: { nonempty: true, observedAt: createdAt }, windows: { "5m": { maximumDrawdownPct: 2, returnPct: 10 } } }
  });
  assert.equal(JSON.parse(restored.prepare("SELECT evidence FROM risk_identity_enrichment").get().evidence).provider, "geckoterminal");
  assert.equal(restored.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='price_observations'").get().count, 0);
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
  assert.deepEqual(inspectDatabaseFile(destination).rowCounts, {
    tokens: 1, events: 1, alerts: 1, callouts: 1, outcome_enrichment: 1, risk_identity_enrichment: 1
  });
});

test("verifies an exact v0.5.1 artifact by migrating only the disposable restore copy", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const legacyPath = path.join(directory, "v0.5.1-backup.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL);
    CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC);
    INSERT INTO tokens VALUES ('legacy-mint','{"mint":"legacy-mint","source":"pumpportal"}','${createdAt}','${createdAt}');
    PRAGMA user_version = 501;
  `);
  legacy.close();
  const before = { hash: digest(legacyPath), modifiedAt: statSync(legacyPath).mtime.toISOString() };

  const report = verifyRestorableBackup(legacyPath, { scratchRoot: scratchDirectory });

  assert.equal(report.artifact.userVersion, 501);
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 501);
  assert.equal(report.disposableRestore.userVersion, 700);
  assert.equal(report.disposableRestore.rowCounts.tokens, 1);
  assert.equal(report.disposableRestore.rowCounts.outcome_enrichment, 0);
  assert.equal(report.disposableRestore.rowCounts.risk_identity_enrichment, 0);
  assert.equal(digest(legacyPath), before.hash);
  assert.equal(statSync(legacyPath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("verifies an exact v0.6.0 artifact by migrating only the disposable restore copy", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const outcomePath = path.join(directory, "v0.6.0-backup.db");
  const outcomeStore = new Store(outcomePath);
  outcomeStore.upsertToken({ mint: "outcome-mint", source: "pumpportal", createdAt });
  outcomeStore.db.exec(`
    DROP INDEX risk_identity_provider_due;
    DROP INDEX risk_identity_provider_status_updated;
    DROP TABLE risk_identity_enrichment;
    PRAGMA user_version = 600;
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA journal_mode = DELETE;
  `);
  outcomeStore.db.close();
  const before = { hash: digest(outcomePath), modifiedAt: statSync(outcomePath).mtime.toISOString() };

  const report = verifyRestorableBackup(outcomePath, { scratchRoot: scratchDirectory });

  assert.equal(report.artifact.userVersion, 600);
  assert.equal(report.artifact.rowCounts.outcome_enrichment, 0);
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 600);
  assert.equal(report.disposableRestore.userVersion, 700);
  assert.equal(report.disposableRestore.rowCounts.tokens, 1);
  assert.equal(report.disposableRestore.rowCounts.risk_identity_enrichment, 0);
  assert.equal(digest(outcomePath), before.hash);
  assert.equal(statSync(outcomePath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
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

test("requires the outcome-enrichment lookup index before creating a backup", (t) => {
  const directory = temporaryWorkspace(t);
  const { store, databasePath } = seededStore(directory);
  t.after(() => store.db.close());
  store.db.exec("DROP INDEX outcome_enrichment_provider_status_updated");

  assert.throws(
    () => createVerifiedBackup(databasePath, path.join(directory, "must-not-publish.db"), {
      scratchRoot: path.join(directory, "scratch")
    }),
    (error) => error instanceof DatabaseVerificationError && /schema objects do not exactly match/.test(error.message)
  );
  assert.equal(readdirSync(directory).includes("must-not-publish.db"), false);
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
