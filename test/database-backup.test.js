import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
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
import { Store, STORE_SCHEMA_VERSION } from "../src/store.js";
import { parseGeckoTerminalTokenInfo } from "../src/risk-identity.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "../src/solana-rpc.js";

const createdAt = "2026-08-08T12:00:00.000Z";
const actorMint = "So11111111111111111111111111111111111111112";

function actorObservation(overrides = {}) {
  return {
    schemaVersion: 1,
    mint: actorMint,
    actor: "Actor 42",
    side: "buy",
    amounts: { native: null, token: 2.5 },
    source: { name: "solana-mainnet-rpc", evidenceClass: "on-chain-finalized" },
    timestamps: { source: { state: "available", value: createdAt }, observedAt: createdAt },
    transactionProvenance: {
      state: "internal-only", evidenceClass: "locally-derived", slot: { state: "available", value: 42 }
    },
    ...overrides
  };
}

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
  store.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
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
  store.admitActorMint({
    mint: actorMint,
    launchObservedAt: createdAt,
    admittedAt: createdAt,
    nextAttemptAt: createdAt,
    limit: 16
  });
  store.saveActorObservation({
    eventKey: "seeded-actor-observation",
    mint: actorMint,
    event: actorObservation(),
    sourceAt: createdAt,
    observedAt: createdAt,
    retainedUntil: "2026-08-10T12:00:00.000Z"
  });
  store.saveActorSummary(actorMint, {
    schemaVersion: 1,
    mint: actorMint,
    coverage: { state: "insufficient-sample", eventCount: 1, uniqueActorCount: 1 },
    metrics: null
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
  const actorSecretBefore = store.actorPrivacySecret().toString("hex");
  const sourceBefore = digest(databasePath);
  const walBefore = digest(`${databasePath}-wal`);
  const report = createVerifiedBackup(databasePath, destination, { scratchRoot: scratchDirectory });

  assert.equal(report.liveDatabaseReplaced, false);
  assert.equal(report.backup.path, destination);
  assert.equal(report.backup.integrityCheck, "ok");
  assert.equal(report.disposableRestore.verified, true);
  assert.deepEqual(report.disposableRestore.applicationWriteProbe, {
    verified: true,
    rolledBack: true,
    telegramOutboxDue: true,
    invalidPendingRejected: true,
    actor: {
      installationSecretStable: true,
      admissionWritten: true,
      observationWritten: true,
      duplicateSuppressed: true,
      conflictRejected: true,
      summaryWritten: true,
      retentionEnforced: true,
      rawIdentityRejected: true,
      rawIdentityViolations: 0
    }
  });
  assert.deepEqual(report.backup.rowCounts, {
    tokens: 1, events: 1, alerts: 1, callouts: 1, brief_runs: 0, outcome_enrichment: 1, risk_identity_enrichment: 1,
    actor_installation: 1, actor_cohort: 1, actor_observations: 1, actor_summaries: 1
  });
  assert.deepEqual(report.backup.invalidJsonPayloads, {
    tokens: 0, events: 0, callouts: 0, brief_runs: 0, outcome_enrichment: 0, risk_identity_enrichment: 0,
    actor_observations: 0, actor_summaries: 0
  });
  assert.equal(report.backup.actorInstallationSecretValid, true);
  assert.equal(report.backup.actorMethodRevision, SOLANA_ACTOR_PARSER_REVISION);
  assert.equal(report.backup.actorPrivacyViolations, 0);
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
  assert.equal(Buffer.from(restored.prepare("SELECT secret FROM actor_installation WHERE id=1").get().secret).toString("hex"), actorSecretBefore);
  assert.equal(JSON.parse(restored.prepare("SELECT event FROM actor_observations").get().event).actor, "Actor 42");
  assert.equal(JSON.parse(restored.prepare("SELECT summary FROM actor_summaries").get().summary).mint, actorMint);
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
    tokens: 1, events: 1, alerts: 1, callouts: 1, brief_runs: 0, outcome_enrichment: 1, risk_identity_enrichment: 1,
    actor_installation: 1, actor_cohort: 1, actor_observations: 1, actor_summaries: 1
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
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(report.disposableRestore.rowCounts.tokens, 1);
  assert.equal(report.disposableRestore.rowCounts.outcome_enrichment, 0);
  assert.equal(report.disposableRestore.rowCounts.risk_identity_enrichment, 0);
  assert.equal(report.disposableRestore.rowCounts.brief_runs, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_installation, 1);
  assert.equal(report.disposableRestore.rowCounts.actor_cohort, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_observations, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_summaries, 0);
  assert.equal(digest(legacyPath), before.hash);
  assert.equal(statSync(legacyPath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("verifies an exact v0.6.0 artifact by migrating only the disposable restore copy", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const outcomePath = path.join(directory, "v0.6.0-backup.db");
  const outcomeStore = new DatabaseSync(outcomePath);
  outcomeStore.exec(`
    CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    CREATE INDEX outcome_enrichment_provider_due ON outcome_enrichment(provider, next_attempt_at, mint);
    INSERT INTO tokens VALUES ('outcome-mint','{"mint":"outcome-mint","source":"pumpportal"}','${createdAt}','${createdAt}');
    PRAGMA user_version = 600;
  `);
  outcomeStore.close();
  const before = { hash: digest(outcomePath), modifiedAt: statSync(outcomePath).mtime.toISOString() };

  const report = verifyRestorableBackup(outcomePath, { scratchRoot: scratchDirectory });

  assert.equal(report.artifact.userVersion, 600);
  assert.equal(report.artifact.rowCounts.outcome_enrichment, 0);
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 600);
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(report.disposableRestore.rowCounts.tokens, 1);
  assert.equal(report.disposableRestore.rowCounts.risk_identity_enrichment, 0);
  assert.equal(report.disposableRestore.rowCounts.brief_runs, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_installation, 1);
  assert.equal(report.disposableRestore.rowCounts.actor_cohort, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_observations, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_summaries, 0);
  assert.equal(digest(outcomePath), before.hash);
  assert.equal(statSync(outcomePath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("verifies an exact v0.7 artifact and migrates only the disposable restore copy", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const riskPath = path.join(directory, "v0.7-backup.db");
  const riskMint = "11111111111111111111111111111111";
  const migrationEvent = {
    id: 7, kind: "risk-evidence", mint: riskMint,
    payload: { mint: riskMint, source: "geckoterminal", factor: "concentration", value: 52, unit: "%" },
    createdAt
  };
  const migrationAlert = {
    id: 11, level: "risk", title: "Holder concentration changed",
    message: "Provider-observed concentration moved to 52%", mint: riskMint, createdAt
  };
  const outcomeState = {
    mint: riskMint, provider: "dexscreener", pool: "Pool111", tokenSide: "base", dex: "raydium",
    sourceUrl: "https://dex.example/pools/Pool111",
    evidence: {
      outcome: {
        baseline: { observedAt: createdAt, nonempty: true },
        windows: { "5m": { returnPct: 12.5, maximumDrawdownPct: 4.25 } }
      }
    },
    status: "partial", missingReason: "missing-24h", errorCode: null, attemptCount: 2,
    lastAttemptAt: "2026-08-08T12:02:00.000Z", nextAttemptAt: "2026-08-08T12:10:00.000Z",
    lastSuccessAt: "2026-08-08T12:01:00.000Z", updatedAt: "2026-08-08T12:02:01.000Z"
  };
  const riskIdentityState = {
    mint: riskMint, provider: "geckoterminal",
    evidence: parseGeckoTerminalTokenInfo({ data: {
      id: `solana_${riskMint}`,
      type: "token",
      attributes: {
        address: riskMint, name: "Observed", symbol: "OBS",
        holders: { count: 42, distribution_percentage: { top_10: "52" }, last_updated: createdAt },
        developer_address: null, developer_holding_percentage: null,
        twitter_handle: null, telegram_handle: null, websites: []
      }
    } }, { mint: riskMint, fetchedAt: createdAt }),
    status: "available", missingReason: null, errorCode: null, attemptCount: 2,
    lastAttemptAt: createdAt, nextAttemptAt: null, lastSuccessAt: createdAt, updatedAt: createdAt
  };
  const risk = new DatabaseSync(riskPath);
  risk.exec(`
    CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    CREATE INDEX outcome_enrichment_provider_due ON outcome_enrichment(provider, next_attempt_at, mint);
    CREATE TABLE risk_identity_enrichment (
      mint TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL,
      evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
      status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 2), last_attempt_at TEXT,
      next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE INDEX risk_identity_provider_status_updated ON risk_identity_enrichment(provider, status, updated_at DESC, mint);
    CREATE INDEX risk_identity_provider_due ON risk_identity_enrichment(provider, next_attempt_at, mint);
    PRAGMA user_version = 700;
  `);
  risk.prepare("INSERT INTO tokens VALUES (?,?,?,?)")
    .run(riskMint, JSON.stringify({ mint: riskMint, source: "pumpportal" }), createdAt, createdAt);
  risk.prepare("INSERT INTO events (id,kind,mint,payload,created_at) VALUES (?,?,?,?,?)")
    .run(migrationEvent.id, migrationEvent.kind, migrationEvent.mint, JSON.stringify(migrationEvent.payload), migrationEvent.createdAt);
  risk.prepare("INSERT INTO alerts (id,level,title,message,mint,created_at) VALUES (?,?,?,?,?,?)")
    .run(migrationAlert.id, migrationAlert.level, migrationAlert.title, migrationAlert.message, migrationAlert.mint, migrationAlert.createdAt);
  risk.prepare(`INSERT INTO outcome_enrichment
    (mint,provider,pool,token_side,dex,source_url,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      outcomeState.mint, outcomeState.provider, outcomeState.pool, outcomeState.tokenSide, outcomeState.dex,
      outcomeState.sourceUrl, JSON.stringify(outcomeState.evidence), outcomeState.status, outcomeState.missingReason,
      outcomeState.errorCode, outcomeState.attemptCount, outcomeState.lastAttemptAt, outcomeState.nextAttemptAt,
      outcomeState.lastSuccessAt, outcomeState.updatedAt
    );
  risk.prepare(`INSERT INTO risk_identity_enrichment
    (mint,provider,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      riskIdentityState.mint, riskIdentityState.provider, JSON.stringify(riskIdentityState.evidence), riskIdentityState.status,
      riskIdentityState.missingReason, riskIdentityState.errorCode, riskIdentityState.attemptCount,
      riskIdentityState.lastAttemptAt, riskIdentityState.nextAttemptAt, riskIdentityState.lastSuccessAt,
      riskIdentityState.updatedAt
    );
  risk.close();
  const before = { hash: digest(riskPath), modifiedAt: statSync(riskPath).mtime.toISOString() };

  const report = verifyRestorableBackup(riskPath, { scratchRoot: scratchDirectory });

  assert.equal(report.artifact.userVersion, 700);
  assert.deepEqual(report.artifact.rowCounts, {
    tokens: 1, events: 1, alerts: 1, callouts: 0, outcome_enrichment: 1, risk_identity_enrichment: 1
  });
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 700);
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(report.disposableRestore.rowCounts, {
    tokens: 1, events: 1, alerts: 1, callouts: 0, brief_runs: 0, outcome_enrichment: 1, risk_identity_enrichment: 1,
    actor_installation: 1, actor_cohort: 0, actor_observations: 0, actor_summaries: 0
  });

  const disposableMigrationPath = path.join(directory, "v0.7-disposable-migration.db");
  copyFileSync(riskPath, disposableMigrationPath);
  assert.equal(digest(disposableMigrationPath), before.hash);
  const migrated = new Store(disposableMigrationPath);
  try {
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
    assert.equal(migrated.db.prepare("SELECT id FROM events WHERE mint=?").get(riskMint).id, migrationEvent.id);
    assert.deepEqual(migrated.eventsForMint(riskMint), [{
      kind: migrationEvent.kind, mint: migrationEvent.mint, payload: migrationEvent.payload,
      eventKey: null, evidenceClass: "unavailable", occurredAt: null, createdAt: migrationEvent.createdAt
    }]);
    assert.deepEqual(migrated.alertsForMint(riskMint).map((row) => ({ ...row })), [{
      ...migrationAlert, kind: "legacy", evidenceClass: "unavailable", evidenceAt: null, dedupeKey: null,
      telegramStatus: null, telegramAttemptedAt: null, telegramMessageId: null, telegramAttemptCount: 0,
      telegramNextAttemptAt: null, telegramLastErrorCode: null
    }]);
    assert.deepEqual(migrated.enrichmentState(riskMint), outcomeState);
    assert.deepEqual(migrated.riskIdentityState(riskMint), riskIdentityState);
  } finally {
    migrated.db.close();
  }

  assert.equal(digest(riskPath), before.hash);
  assert.equal(statSync(riskPath).mtime.toISOString(), before.modifiedAt);
  assert.equal(inspectDatabaseFile(riskPath, { allowLegacy: true }).userVersion, 700);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("verifies schema 800 and repairs a pending outbox row only in the disposable restore", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const actionPath = path.join(directory, "v0.8.0-backup.db");
  const actionStore = new Store(actionPath);
  actionStore.upsertToken({ mint: "LegacyActionMint", source: "pumpportal", createdAt });
  actionStore.db.exec(`
    DROP INDEX alerts_dedupe_key;
    DROP INDEX alerts_mint_created;
    ALTER TABLE alerts RENAME TO alerts_schema_801;
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT,
      kind TEXT NOT NULL DEFAULT 'legacy', evidence_class TEXT NOT NULL DEFAULT 'unavailable', evidence_at TEXT,
      dedupe_key TEXT, telegram_status TEXT, telegram_attempted_at TEXT, telegram_message_id INTEGER,
      telegram_attempt_count INTEGER NOT NULL DEFAULT 0, telegram_next_attempt_at TEXT, telegram_last_error_code TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO alerts
      (level,title,message,mint,kind,evidence_class,dedupe_key,telegram_status,created_at)
      VALUES ('signal','Legacy pending','Must become due','LegacyActionMint','score-rise','locally-derived',
        'legacy-pending','pending','${createdAt}');
    INSERT INTO alerts
      (level,title,message,mint,kind,evidence_class,dedupe_key,telegram_status,telegram_next_attempt_at,created_at)
      VALUES ('signal','Malformed pending','Must become due','LegacyActionMint','score-rise','locally-derived',
        'legacy-malformed-pending','pending','zzzz','${createdAt}');
    DROP TABLE alerts_schema_801;
    CREATE UNIQUE INDEX alerts_dedupe_key ON alerts(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX alerts_mint_created ON alerts(mint, created_at DESC);
    DROP TABLE actor_summaries;
    DROP TABLE actor_observations;
    DROP TABLE actor_cohort;
    DROP TABLE actor_installation;
    PRAGMA user_version = 800;
  `);
  actionStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  actionStore.db.close();
  const before = { hash: digest(actionPath), modifiedAt: statSync(actionPath).mtime.toISOString() };
  assert.equal(inspectDatabaseFile(actionPath, { allowLegacy: true }).userVersion, 800);

  const report = verifyRestorableBackup(actionPath, { scratchRoot: scratchDirectory });
  assert.equal(report.artifact.userVersion, 800);
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 800);
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(report.disposableRestore.applicationWriteProbe.telegramOutboxDue, true);

  const migratedPath = path.join(directory, "v0.8.0-disposable-migration.db");
  copyFileSync(actionPath, migratedPath);
  const migrated = new Store(migratedPath);
  try {
    const repaired = migrated.db.prepare(`SELECT dedupe_key AS dedupeKey,telegram_next_attempt_at AS nextAttemptAt
      FROM alerts ORDER BY dedupe_key`).all().map((row) => ({ ...row }));
    assert.deepEqual(repaired, [
      { dedupeKey: "legacy-malformed-pending", nextAttemptAt: createdAt },
      { dedupeKey: "legacy-pending", nextAttemptAt: createdAt }
    ]);
    assert.equal(migrated.dueTelegramAlerts({ now: createdAt }).length, 2);
    assert.throws(
      () => migrated.db.prepare("UPDATE alerts SET telegram_next_attempt_at=NULL WHERE dedupe_key='legacy-pending'").run(),
      /constraint/i
    );
    assert.throws(
      () => migrated.db.prepare("UPDATE alerts SET telegram_next_attempt_at='zzzz' WHERE dedupe_key='legacy-pending'").run(),
      /constraint/i
    );
  } finally {
    migrated.db.close();
  }

  assert.equal(digest(actionPath), before.hash);
  assert.equal(statSync(actionPath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("verifies an exact schema 801 artifact and adds actor storage only to the disposable restore", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const { store, databasePath } = seededStore(directory);
  store.db.exec(`
    DROP TABLE actor_summaries;
    DROP TABLE actor_observations;
    DROP TABLE actor_cohort;
    DROP TABLE actor_installation;
    PRAGMA user_version = 801;
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA journal_mode = DELETE;
  `);
  store.db.close();
  const before = { hash: digest(databasePath), modifiedAt: statSync(databasePath).mtime.toISOString() };

  const artifact = inspectDatabaseFile(databasePath, { allowLegacy: true });
  assert.equal(artifact.userVersion, 801);
  assert.equal(Object.hasOwn(artifact.rowCounts, "actor_installation"), false);

  const report = verifyRestorableBackup(databasePath, { scratchRoot: scratchDirectory });
  assert.equal(report.artifact.userVersion, 801);
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 801);
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(report.disposableRestore.rowCounts.actor_installation, 1);
  assert.equal(report.disposableRestore.rowCounts.actor_cohort, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_observations, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_summaries, 0);
  assert.equal(report.disposableRestore.actorInstallationSecretValid, true);
  assert.equal(report.disposableRestore.actorPrivacyViolations, 0);
  assert.equal(digest(databasePath), before.hash);
  assert.equal(statSync(databasePath).mtime.toISOString(), before.modifiedAt);
  assert.deepEqual(readdirSync(scratchDirectory), []);
});

test("migrates schema 900 by preserving the installation secret and clearing pre-revision actor evidence", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");
  const { store, databasePath } = seededStore(directory);
  const actorSecretBefore = store.actorPrivacySecret().toString("hex");
  store.db.exec(`
    ALTER TABLE actor_installation RENAME TO actor_installation_schema_901;
    CREATE TABLE actor_installation (
      id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
      secret BLOB NOT NULL CHECK(length(secret)=32),
      created_at TEXT NOT NULL
    );
    INSERT INTO actor_installation (id,secret,created_at)
      SELECT id,secret,created_at FROM actor_installation_schema_901;
    DROP TABLE actor_installation_schema_901;
    PRAGMA user_version = 900;
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA journal_mode = DELETE;
  `);
  store.db.close();
  const before = { hash: digest(databasePath), modifiedAt: statSync(databasePath).mtime.toISOString() };

  const artifact = inspectDatabaseFile(databasePath, { allowLegacy: true });
  assert.equal(artifact.userVersion, 900);
  assert.equal(artifact.actorMethodRevision, null);
  assert.equal(artifact.rowCounts.actor_cohort, 1);
  assert.equal(artifact.rowCounts.actor_observations, 1);
  assert.equal(artifact.rowCounts.actor_summaries, 1);

  const report = verifyRestorableBackup(databasePath, { scratchRoot: scratchDirectory });
  assert.equal(report.disposableRestore.migratedFromSchemaVersion, 900);
  assert.equal(report.disposableRestore.userVersion, STORE_SCHEMA_VERSION);
  assert.equal(report.disposableRestore.actorMethodRevision, SOLANA_ACTOR_PARSER_REVISION);
  assert.equal(report.disposableRestore.rowCounts.actor_cohort, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_observations, 0);
  assert.equal(report.disposableRestore.rowCounts.actor_summaries, 0);

  const migrationPath = path.join(directory, "schema-900-migration.db");
  copyFileSync(databasePath, migrationPath);
  let migrated = new Store(migrationPath);
  const prepared = migrated.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
  assert.equal(prepared.changed, true);
  assert.deepEqual(prepared.reset, { cohort: 1, observations: 1, summaries: 1 });
  assert.equal(migrated.actorPrivacySecret().toString("hex"), actorSecretBefore);
  assert.equal(migrated.actorStates().length, 0);
  assert.equal(migrated.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION).changed, false);
  migrated.admitActorMint({
    mint: actorMint,
    launchObservedAt: createdAt,
    admittedAt: createdAt,
    nextAttemptAt: createdAt
  });
  migrated.db.close();
  migrated = new Store(migrationPath);
  assert.equal(migrated.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION).changed, false);
  assert.equal(migrated.actorStates().length, 1);
  migrated.db.close();

  assert.equal(digest(databasePath), before.hash);
  assert.equal(statSync(databasePath).mtime.toISOString(), before.modifiedAt);
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

test("requires actor retention schema and rejects persisted raw actor identities", (t) => {
  const directory = temporaryWorkspace(t);
  const scratchDirectory = path.join(directory, "scratch");

  const missingIndexDirectory = path.join(directory, "missing-index");
  const { store: indexStore, databasePath: missingIndexPath } = seededStore(missingIndexDirectory);
  indexStore.db.exec("DROP INDEX actor_observations_retention");
  assert.throws(
    () => createVerifiedBackup(missingIndexPath, path.join(directory, "actor-index-missing.db"), {
      scratchRoot: scratchDirectory
    }),
    (error) => error instanceof DatabaseVerificationError && /schema objects do not exactly match/.test(error.message)
  );
  indexStore.db.close();
  assert.equal(readdirSync(directory).includes("actor-index-missing.db"), false);

  const leakedDirectory = path.join(directory, "identity-leak");
  const { store: leakedStore, databasePath: leakedPath } = seededStore(leakedDirectory);
  leakedStore.db.prepare("UPDATE actor_observations SET event=? WHERE event_key='seeded-actor-observation'")
    .run(JSON.stringify({ ...actorObservation(), actorAddress: "So11111111111111111111111111111111111111112" }));
  leakedStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  leakedStore.db.close();
  assert.throws(
    () => verifyRestorableBackup(leakedPath, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError && /raw identity or hidden mapping field/.test(error.message)
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);

  for (const [label, rawValue] of [
    ["wallet-scalar", "So11111111111111111111111111111111111111112"],
    ["signature-scalar", "3".repeat(64)],
    ["profile-scalar", "Contact https://x.com/private_profile"],
    ["nested-mint-scalar", "11111111111111111111111111111111"]
  ]) {
    const scalarDirectory = path.join(directory, label);
    const { store: scalarStore, databasePath: scalarPath } = seededStore(scalarDirectory);
    const summary = JSON.parse(scalarStore.db.prepare("SELECT summary FROM actor_summaries WHERE mint=?").get(actorMint).summary);
    if (label === "nested-mint-scalar") summary.coverage.mint = rawValue;
    else summary.coverage.state = rawValue;
    scalarStore.db.prepare("UPDATE actor_summaries SET summary=? WHERE mint=?").run(JSON.stringify(summary), actorMint);
    scalarStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    scalarStore.db.close();
    assert.throws(
      () => verifyRestorableBackup(scalarPath, { scratchRoot: scratchDirectory }),
      (error) => error instanceof DatabaseVerificationError
        && /raw identity or hidden mapping field/.test(error.message),
      `${label} must be rejected even under an allowlisted scalar key`
    );
    assert.deepEqual(readdirSync(scratchDirectory), []);
  }

  for (const [label, table, column, key] of [
    ["observation-mint-mismatch", "actor_observations", "event", "event_key='seeded-actor-observation'"],
    ["summary-mint-mismatch", "actor_summaries", "summary", `mint='${actorMint}'`]
  ]) {
    const mismatchDirectory = path.join(directory, label);
    const { store: mismatchStore, databasePath: mismatchPath } = seededStore(mismatchDirectory);
    const payload = JSON.parse(mismatchStore.db.prepare(`SELECT ${column} FROM ${table} WHERE ${key}`).get()[column]);
    payload.mint = "11111111111111111111111111111111";
    mismatchStore.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}`).run(JSON.stringify(payload));
    mismatchStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    mismatchStore.db.close();
    assert.throws(
      () => verifyRestorableBackup(mismatchPath, { scratchRoot: scratchDirectory }),
      (error) => error instanceof DatabaseVerificationError
        && /raw identity or hidden mapping field/.test(error.message),
      `${label} must reject a payload mint that differs from its actor table key`
    );
    assert.deepEqual(readdirSync(scratchDirectory), []);
  }

  const missingMintDirectory = path.join(directory, "summary-mint-missing");
  const { store: missingMintStore, databasePath: missingMintPath } = seededStore(missingMintDirectory);
  const summaryWithoutMint = JSON.parse(missingMintStore.db.prepare("SELECT summary FROM actor_summaries WHERE mint=?").get(actorMint).summary);
  delete summaryWithoutMint.mint;
  missingMintStore.db.prepare("UPDATE actor_summaries SET summary=? WHERE mint=?")
    .run(JSON.stringify(summaryWithoutMint), actorMint);
  missingMintStore.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  missingMintStore.db.close();
  assert.throws(
    () => verifyRestorableBackup(missingMintPath, { scratchRoot: scratchDirectory }),
    (error) => error instanceof DatabaseVerificationError
      && /raw identity or hidden mapping field/.test(error.message),
    "missing root mint must fail the actor backup privacy contract"
  );
  assert.deepEqual(readdirSync(scratchDirectory), []);
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
