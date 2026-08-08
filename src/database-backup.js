import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STORE_SCHEMA_VERSION } from "./store.js";

export const REQUIRED_DATABASE_SCHEMA = Object.freeze({
  tokens: Object.freeze(["mint", "payload", "created_at", "updated_at"]),
  events: Object.freeze(["id", "kind", "mint", "payload", "created_at"]),
  alerts: Object.freeze(["id", "level", "title", "message", "mint", "created_at"]),
  callouts: Object.freeze(["external_id", "mint", "payload", "created_at"])
});

const REQUIRED_COLUMN_TYPES = Object.freeze({
  tokens: Object.freeze({ mint: "TEXT", payload: "TEXT", created_at: "TEXT", updated_at: "TEXT" }),
  events: Object.freeze({ id: "INTEGER", kind: "TEXT", mint: "TEXT", payload: "TEXT", created_at: "TEXT" }),
  alerts: Object.freeze({ id: "INTEGER", level: "TEXT", title: "TEXT", message: "TEXT", mint: "TEXT", created_at: "TEXT" }),
  callouts: Object.freeze({ external_id: "TEXT", mint: "TEXT", payload: "TEXT", created_at: "TEXT" })
});

const REQUIRED_PRIMARY_KEYS = Object.freeze({
  tokens: Object.freeze(["mint"]),
  events: Object.freeze(["id"]),
  alerts: Object.freeze(["id"]),
  callouts: Object.freeze(["external_id"])
});

const REQUIRED_NOT_NULL = Object.freeze({
  tokens: Object.freeze(["payload", "created_at", "updated_at"]),
  events: Object.freeze(["kind", "payload", "created_at"]),
  alerts: Object.freeze(["level", "title", "message", "created_at"]),
  callouts: Object.freeze(["mint", "payload", "created_at"])
});

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({
    type: "index",
    name: "callouts_mint_created",
    tableName: "callouts",
    sql: "CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC)"
  }),
  Object.freeze({
    type: "table",
    name: "alerts",
    tableName: "alerts",
    sql: "CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL)"
  }),
  Object.freeze({
    type: "table",
    name: "callouts",
    tableName: "callouts",
    sql: "CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
  }),
  Object.freeze({
    type: "table",
    name: "events",
    tableName: "events",
    sql: "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
  }),
  Object.freeze({
    type: "table",
    name: "tokens",
    tableName: "tokens",
    sql: "CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  })
]);

export class DatabaseVerificationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DatabaseVerificationError";
  }
}

function fail(message, cause) {
  throw new DatabaseVerificationError(message, cause ? { cause } : undefined);
}

function regularFile(filePath, label) {
  const resolved = path.resolve(filePath);
  let metadata;
  try {
    metadata = lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist: ${resolved}`);
    fail(`Cannot inspect ${label.toLowerCase()}: ${resolved}`, error);
  }
  if (metadata.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${resolved}`);
  if (!metadata.isFile()) fail(`${label} must be a regular file: ${resolved}`);
  return { path: resolved, realPath: realpathSync(resolved), metadata };
}

function destinationPath(sourceRealPath, requestedPath) {
  const resolved = path.resolve(requestedPath);
  const directory = path.dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = path.join(realpathSync(directory), path.basename(resolved));
  if (canonical === sourceRealPath) fail("Backup destination must be different from the live database");
  try {
    const existing = lstatSync(canonical);
    if (existing.isSymbolicLink() && realpathSync(canonical) === sourceRealPath) {
      fail("Backup destination must not point to the live database");
    }
    fail(`Backup destination already exists; refusing to overwrite it: ${canonical}`);
  } catch (error) {
    if (error instanceof DatabaseVerificationError) throw error;
    if (error?.code !== "ENOENT") fail(`Cannot inspect backup destination: ${canonical}`, error);
  }
  return canonical;
}

function assertStandaloneArtifact(databasePath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      lstatSync(sidecarPath);
      fail(`Backup is not a standalone artifact; SQLite sidecar exists: ${sidecarPath}`);
    } catch (error) {
      if (error instanceof DatabaseVerificationError) throw error;
      if (error?.code !== "ENOENT") fail(`Cannot inspect SQLite sidecar: ${sidecarPath}`, error);
    }
  }
}

function pragmaValues(database, sql) {
  return database.prepare(sql).all().map((row) => String(Object.values(row)[0]));
}

function schemaHash(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function normalizeSchemaSql(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function inspectOpenDatabase(database) {
  const integrity = pragmaValues(database, "PRAGMA integrity_check");
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    fail(`SQLite integrity check failed: ${integrity.join("; ") || "no result"}`);
  }

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    fail(`SQLite foreign-key check found ${foreignKeyViolations.length} violation(s)`);
  }

  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(({ name }) => name);
  const rowCounts = {};
  for (const [table, requiredColumns] of Object.entries(REQUIRED_DATABASE_SCHEMA)) {
    if (!tables.includes(table)) fail(`Database is not a Pump War Room backup: missing table ${table}`);
    const tableInfo = database.prepare(`SELECT name,type,"notnull",pk
      FROM pragma_table_info(?) ORDER BY cid`).all(table);
    const columns = tableInfo.map(({ name }) => name);
    const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
    if (missingColumns.length) {
      fail(`Database table ${table} is missing required column(s): ${missingColumns.join(", ")}`);
    }
    const incompatibleTypes = requiredColumns.filter((columnName) => {
      const column = tableInfo.find(({ name }) => name === columnName);
      return String(column?.type || "").trim().toUpperCase() !== REQUIRED_COLUMN_TYPES[table][columnName];
    });
    if (incompatibleTypes.length) {
      fail(`Database table ${table} has incompatible declared type(s): ${incompatibleTypes.join(", ")}`);
    }
    const primaryKey = tableInfo.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name);
    if (JSON.stringify(primaryKey) !== JSON.stringify(REQUIRED_PRIMARY_KEYS[table])) {
      fail(`Database table ${table} has an incompatible primary key`);
    }
    const nullableColumns = REQUIRED_NOT_NULL[table].filter((required) => {
      const column = tableInfo.find(({ name }) => name === required);
      return !column?.notnull;
    });
    if (nullableColumns.length) {
      fail(`Database table ${table} must require value(s) for: ${nullableColumns.join(", ")}`);
    }
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    rowCounts[table] = Number(database.prepare(`SELECT count(*) AS count FROM ${quotedTable}`).get().count);
  }

  const schema = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const unsupportedTriggers = schema.filter(({ type }) => type === "trigger");
  if (unsupportedTriggers.length) {
    fail(`Database contains unsupported trigger(s): ${unsupportedTriggers.map(({ name }) => name).join(", ")}`);
  }
  const normalizedSchema = schema.map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }));
  const normalizedExpectedSchema = EXPECTED_SCHEMA_OBJECTS.map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }));
  if (JSON.stringify(normalizedSchema) !== JSON.stringify(normalizedExpectedSchema)) {
    fail("Database schema objects do not exactly match the supported Pump War Room schema");
  }
  const userVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
  if (userVersion !== STORE_SCHEMA_VERSION) {
    fail(`Database schema version ${userVersion} does not match required version ${STORE_SCHEMA_VERSION}`);
  }
  const invalidJsonPayloads = Object.fromEntries(["tokens", "events", "callouts"].map((table) => [
    table,
    Number(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE NOT json_valid(payload)`).get().count)
  ]));
  return {
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    pageCount: Number(database.prepare("PRAGMA page_count").get().page_count),
    pageSize: Number(database.prepare("PRAGMA page_size").get().page_size),
    userVersion,
    schemaSha256: schemaHash(normalizedSchema),
    rowCounts,
    invalidJsonPayloads
  };
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function syncFile(filePath) {
  const descriptor = openSync(filePath, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncDirectory(directoryPath) {
  const descriptor = openSync(directoryPath, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function verifyApplicationWrites(databasePath) {
  let database;
  let transactionStarted = false;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const suffix = randomUUID();
    const mint = `restore-probe-${suffix}`;
    const externalId = `restore-callout-${suffix}`;
    const createdAt = "2000-01-01T00:00:00.000Z";
    const payload = JSON.stringify({ mint, source: "restore-verification" });
    database.prepare(`INSERT INTO tokens (mint,payload,created_at,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(mint, payload, createdAt, createdAt);
    database.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)")
      .run("restore-verification", mint, payload, createdAt);
    database.prepare("INSERT INTO alerts (level,title,message,mint,created_at) VALUES (?,?,?,?,?)")
      .run("verification", "Restore probe", "Disposable write check", mint, createdAt);
    database.prepare(`INSERT INTO callouts (external_id,mint,payload,created_at)
      VALUES (?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload`)
      .run(externalId, mint, payload, createdAt);
    const inserted = Number(database.prepare("SELECT count(*) AS count FROM tokens WHERE mint=?").get(mint).count);
    if (inserted !== 1) fail("Database application write probe could not read its disposable token row");
    database.exec("ROLLBACK");
    transactionStarted = false;
    return { verified: true, rolledBack: true };
  } catch (error) {
    if (transactionStarted) {
      try { database?.exec("ROLLBACK"); } catch {}
    }
    if (error instanceof DatabaseVerificationError) throw error;
    fail(`Database application write probe failed: ${error.message}`, error);
  } finally {
    try { database?.close(); } catch {}
  }
}

export function inspectDatabaseFile(databasePath) {
  const candidate = regularFile(databasePath, "Database file");
  let database;
  try {
    database = new DatabaseSync(candidate.realPath, { readOnly: true });
    const sqlite = inspectOpenDatabase(database);
    database.close();
    database = undefined;
    const metadata = statSync(candidate.realPath);
    return {
      path: candidate.realPath,
      bytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      sha256: sha256File(candidate.realPath),
      ...sqlite
    };
  } catch (error) {
    if (error instanceof DatabaseVerificationError) throw error;
    fail(`Database verification failed for ${candidate.realPath}: ${error.message}`, error);
  } finally {
    try { database?.close(); } catch {}
  }
}

function assertSameRestore(original, restored) {
  if (original.sha256 !== restored.sha256 || original.bytes !== restored.bytes) {
    fail("Disposable restore does not match the backup artifact byte-for-byte");
  }
  if (original.schemaSha256 !== restored.schemaSha256 ||
      JSON.stringify(original.rowCounts) !== JSON.stringify(restored.rowCounts) ||
      JSON.stringify(original.invalidJsonPayloads) !== JSON.stringify(restored.invalidJsonPayloads)) {
    fail("Disposable restore does not match the backup schema and row counts");
  }
}

export function verifyRestorableBackup(backupPath, { scratchRoot = tmpdir() } = {}) {
  const backup = regularFile(backupPath, "Backup file");
  assertStandaloneArtifact(backup.realPath);
  const root = path.resolve(scratchRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const scratchDirectory = mkdtempSync(path.join(root, "pump-war-room-restore-verify-"));
  const restoredPath = path.join(scratchDirectory, "restored.db");
  let operationError = null;

  try {
    const artifact = inspectDatabaseFile(backup.realPath);
    copyFileSync(backup.realPath, restoredPath, constants.COPYFILE_EXCL);
    chmodSync(restoredPath, 0o600);
    const restored = inspectDatabaseFile(restoredPath);
    assertSameRestore(artifact, restored);
    const applicationWriteProbe = verifyApplicationWrites(restoredPath);
    const afterProbe = inspectDatabaseFile(restoredPath);
    if (afterProbe.schemaSha256 !== restored.schemaSha256 ||
        JSON.stringify(afterProbe.rowCounts) !== JSON.stringify(restored.rowCounts) ||
        JSON.stringify(afterProbe.invalidJsonPayloads) !== JSON.stringify(restored.invalidJsonPayloads)) {
      fail("Disposable application write probe did not roll back cleanly");
    }
    assertStandaloneArtifact(backup.realPath);

    const afterHash = sha256File(backup.realPath);
    const afterMetadata = statSync(backup.realPath);
    if (afterHash !== artifact.sha256 || afterMetadata.size !== artifact.bytes ||
        afterMetadata.mtime.toISOString() !== artifact.modifiedAt) {
      fail("Backup artifact changed during restore verification");
    }

    return {
      artifact,
      disposableRestore: {
        verified: true,
        integrityCheck: restored.integrityCheck,
        applicationWriteProbe,
        sha256: restored.sha256,
        bytes: restored.bytes,
        schemaSha256: restored.schemaSha256,
        rowCounts: restored.rowCounts,
        invalidJsonPayloads: restored.invalidJsonPayloads
      }
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      rmSync(scratchDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (operationError) operationError.cleanupError = cleanupError;
      else fail(`Disposable restore cleanup failed: ${cleanupError.message}`, cleanupError);
    }
  }
}

export function createVerifiedBackup(sourcePath, requestedDestination, { scratchRoot } = {}) {
  const source = regularFile(sourcePath, "Live database");
  const destination = destinationPath(source.realPath, requestedDestination);
  const stagingDirectory = mkdtempSync(path.join(path.dirname(destination), `.${path.basename(destination)}.staging-`));
  chmodSync(stagingDirectory, 0o700);
  const stagingPath = path.join(stagingDirectory, "backup.partial");
  let sourceDatabase;
  let operationError = null;
  let published = false;

  try {
    sourceDatabase = new DatabaseSync(source.realPath, { readOnly: true });
    const sourcePreflight = inspectOpenDatabase(sourceDatabase);
    sourceDatabase.prepare("VACUUM INTO ?").run(stagingPath);
    sourceDatabase.close();
    sourceDatabase = undefined;

    chmodSync(stagingPath, 0o600);
    syncFile(stagingPath);
    const verification = verifyRestorableBackup(stagingPath, { scratchRoot });

    try {
      linkSync(stagingPath, destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`Backup destination appeared during creation; refusing to overwrite it: ${destination}`);
      }
      fail(`Could not publish verified backup: ${destination}`, error);
    }
    published = true;
    syncDirectory(path.dirname(destination));

    return {
      source: { path: source.realPath, preflight: sourcePreflight },
      backup: { ...verification.artifact, path: destination, mode: "0600" },
      disposableRestore: verification.disposableRestore,
      liveDatabaseReplaced: false
    };
  } catch (error) {
    operationError = error instanceof DatabaseVerificationError
      ? error
      : new DatabaseVerificationError(`Backup creation failed for ${source.realPath}: ${error.message}`, { cause: error });
    throw operationError;
  } finally {
    try { sourceDatabase?.close(); } catch {}
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
      syncDirectory(path.dirname(destination));
    } catch (cleanupError) {
      if (operationError) operationError.cleanupError = cleanupError;
      else fail(`Backup ${published ? "was published but" : "failed and"} staging cleanup failed: ${cleanupError.message}`, cleanupError);
    }
  }
}
