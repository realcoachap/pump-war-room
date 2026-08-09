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
import { isCanonicalSolanaAddress } from "./early-actors.js";
import { SOLANA_ACTOR_PARSER_REVISION } from "./solana-rpc.js";
import { Store, STORE_SCHEMA_VERSION } from "./store.js";

const LEGACY_SCHEMA_VERSION = 501;
const OUTCOME_SCHEMA_VERSION = 600;
const RISK_SCHEMA_VERSION = 700;
const ACTION_SCHEMA_VERSION = 800;
const HARDENED_ACTION_SCHEMA_VERSION = 801;
const ACTOR_SCHEMA_VERSION = 900;

export const REQUIRED_DATABASE_SCHEMA = Object.freeze({
  tokens: Object.freeze(["mint", "payload", "created_at", "updated_at"]),
  events: Object.freeze(["id", "kind", "mint", "payload", "event_key", "evidence_class", "occurred_at", "created_at"]),
  alerts: Object.freeze([
    "id", "level", "title", "message", "mint", "kind", "evidence_class", "evidence_at", "dedupe_key",
    "telegram_status", "telegram_attempted_at", "telegram_message_id", "telegram_attempt_count",
    "telegram_next_attempt_at", "telegram_last_error_code", "created_at"
  ]),
  callouts: Object.freeze(["external_id", "mint", "payload", "created_at"]),
  brief_runs: Object.freeze([
    "brief_key", "kind", "period_start", "period_end", "timezone", "method_version", "provider",
    "data_cutoff", "model", "created_at"
  ]),
  outcome_enrichment: Object.freeze([
    "mint", "provider", "pool", "token_side", "dex", "source_url", "evidence", "status", "missing_reason", "error_code",
    "attempt_count", "last_attempt_at", "next_attempt_at", "last_success_at", "updated_at"
  ]),
  risk_identity_enrichment: Object.freeze([
    "mint", "provider", "evidence", "status", "missing_reason", "error_code", "attempt_count",
    "last_attempt_at", "next_attempt_at", "last_success_at", "updated_at"
  ]),
  actor_installation: Object.freeze(["id", "secret", "created_at", "method_revision"]),
  actor_cohort: Object.freeze([
    "mint", "launch_observed_at", "admitted_at", "status", "attempt_count", "last_attempt_at",
    "next_attempt_at", "last_success_at", "missing_reason", "error_code", "updated_at"
  ]),
  actor_observations: Object.freeze([
    "event_key", "mint", "event", "source_at", "observed_at", "retained_until", "created_at"
  ]),
  actor_summaries: Object.freeze(["mint", "summary", "updated_at"])
});

const REQUIRED_COLUMN_TYPES = Object.freeze({
  tokens: Object.freeze({ mint: "TEXT", payload: "TEXT", created_at: "TEXT", updated_at: "TEXT" }),
  events: Object.freeze({
    id: "INTEGER", kind: "TEXT", mint: "TEXT", payload: "TEXT", event_key: "TEXT",
    evidence_class: "TEXT", occurred_at: "TEXT", created_at: "TEXT"
  }),
  alerts: Object.freeze({
    id: "INTEGER", level: "TEXT", title: "TEXT", message: "TEXT", mint: "TEXT", kind: "TEXT",
    evidence_class: "TEXT", evidence_at: "TEXT", dedupe_key: "TEXT", telegram_status: "TEXT",
    telegram_attempted_at: "TEXT", telegram_message_id: "INTEGER", telegram_attempt_count: "INTEGER",
    telegram_next_attempt_at: "TEXT", telegram_last_error_code: "TEXT", created_at: "TEXT"
  }),
  callouts: Object.freeze({ external_id: "TEXT", mint: "TEXT", payload: "TEXT", created_at: "TEXT" }),
  brief_runs: Object.freeze({
    brief_key: "TEXT", kind: "TEXT", period_start: "TEXT", period_end: "TEXT", timezone: "TEXT",
    method_version: "TEXT", provider: "TEXT", data_cutoff: "TEXT", model: "TEXT", created_at: "TEXT"
  }),
  outcome_enrichment: Object.freeze({
    mint: "TEXT", provider: "TEXT", pool: "TEXT", token_side: "TEXT", dex: "TEXT", source_url: "TEXT",
    evidence: "TEXT", status: "TEXT", missing_reason: "TEXT", error_code: "TEXT", attempt_count: "INTEGER",
    last_attempt_at: "TEXT", next_attempt_at: "TEXT", last_success_at: "TEXT", updated_at: "TEXT"
  }),
  risk_identity_enrichment: Object.freeze({
    mint: "TEXT", provider: "TEXT", evidence: "TEXT", status: "TEXT", missing_reason: "TEXT", error_code: "TEXT",
    attempt_count: "INTEGER", last_attempt_at: "TEXT", next_attempt_at: "TEXT", last_success_at: "TEXT", updated_at: "TEXT"
  }),
  actor_installation: Object.freeze({ id: "INTEGER", secret: "BLOB", created_at: "TEXT", method_revision: "TEXT" }),
  actor_cohort: Object.freeze({
    mint: "TEXT", launch_observed_at: "TEXT", admitted_at: "TEXT", status: "TEXT", attempt_count: "INTEGER",
    last_attempt_at: "TEXT", next_attempt_at: "TEXT", last_success_at: "TEXT", missing_reason: "TEXT",
    error_code: "TEXT", updated_at: "TEXT"
  }),
  actor_observations: Object.freeze({
    event_key: "TEXT", mint: "TEXT", event: "TEXT", source_at: "TEXT", observed_at: "TEXT",
    retained_until: "TEXT", created_at: "TEXT"
  }),
  actor_summaries: Object.freeze({ mint: "TEXT", summary: "TEXT", updated_at: "TEXT" })
});

const REQUIRED_PRIMARY_KEYS = Object.freeze({
  tokens: Object.freeze(["mint"]),
  events: Object.freeze(["id"]),
  alerts: Object.freeze(["id"]),
  callouts: Object.freeze(["external_id"]),
  brief_runs: Object.freeze(["brief_key"]),
  outcome_enrichment: Object.freeze(["mint"]),
  risk_identity_enrichment: Object.freeze(["mint"]),
  actor_installation: Object.freeze(["id"]),
  actor_cohort: Object.freeze(["mint"]),
  actor_observations: Object.freeze(["event_key"]),
  actor_summaries: Object.freeze(["mint"])
});

const REQUIRED_NOT_NULL = Object.freeze({
  tokens: Object.freeze(["payload", "created_at", "updated_at"]),
  events: Object.freeze(["kind", "payload", "evidence_class", "created_at"]),
  alerts: Object.freeze(["level", "title", "message", "kind", "evidence_class", "telegram_attempt_count", "created_at"]),
  callouts: Object.freeze(["mint", "payload", "created_at"]),
  brief_runs: Object.freeze([
    "brief_key", "kind", "period_start", "period_end", "timezone", "method_version", "provider",
    "data_cutoff", "model", "created_at"
  ]),
  outcome_enrichment: Object.freeze(["mint", "evidence", "status", "attempt_count", "updated_at"]),
  risk_identity_enrichment: Object.freeze(["mint", "provider", "evidence", "status", "attempt_count", "updated_at"]),
  actor_installation: Object.freeze(["id", "secret", "created_at", "method_revision"]),
  actor_cohort: Object.freeze(["mint", "launch_observed_at", "admitted_at", "status", "attempt_count", "updated_at"]),
  actor_observations: Object.freeze(["event_key", "mint", "event", "observed_at", "retained_until", "created_at"]),
  actor_summaries: Object.freeze(["mint", "summary", "updated_at"])
});

const EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({
    type: "index",
    name: "alerts_dedupe_key",
    tableName: "alerts",
    sql: "CREATE UNIQUE INDEX alerts_dedupe_key ON alerts(dedupe_key) WHERE dedupe_key IS NOT NULL"
  }),
  Object.freeze({
    type: "index",
    name: "alerts_mint_created",
    tableName: "alerts",
    sql: "CREATE INDEX alerts_mint_created ON alerts(mint, created_at DESC)"
  }),
  Object.freeze({
    type: "index",
    name: "actor_cohort_due",
    tableName: "actor_cohort",
    sql: "CREATE INDEX actor_cohort_due ON actor_cohort(next_attempt_at,mint)"
  }),
  Object.freeze({
    type: "index",
    name: "actor_cohort_status_updated",
    tableName: "actor_cohort",
    sql: "CREATE INDEX actor_cohort_status_updated ON actor_cohort(status,updated_at DESC,mint)"
  }),
  Object.freeze({
    type: "index",
    name: "actor_observations_mint_observed",
    tableName: "actor_observations",
    sql: "CREATE INDEX actor_observations_mint_observed ON actor_observations(mint,observed_at,event_key)"
  }),
  Object.freeze({
    type: "index",
    name: "actor_observations_retention",
    tableName: "actor_observations",
    sql: "CREATE INDEX actor_observations_retention ON actor_observations(retained_until,event_key)"
  }),
  Object.freeze({
    type: "index",
    name: "brief_runs_kind_period_end",
    tableName: "brief_runs",
    sql: "CREATE INDEX brief_runs_kind_period_end ON brief_runs(kind, period_end DESC)"
  }),
  Object.freeze({
    type: "index",
    name: "callouts_mint_created",
    tableName: "callouts",
    sql: "CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC)"
  }),
  Object.freeze({
    type: "index",
    name: "events_event_key",
    tableName: "events",
    sql: "CREATE UNIQUE INDEX events_event_key ON events(event_key) WHERE event_key IS NOT NULL"
  }),
  Object.freeze({
    type: "index",
    name: "events_mint_created",
    tableName: "events",
    sql: "CREATE INDEX events_mint_created ON events(mint, created_at DESC)"
  }),
  Object.freeze({
    type: "index",
    name: "outcome_enrichment_provider_due",
    tableName: "outcome_enrichment",
    sql: "CREATE INDEX outcome_enrichment_provider_due ON outcome_enrichment(provider, next_attempt_at, mint)"
  }),
  Object.freeze({
    type: "index",
    name: "outcome_enrichment_provider_status_updated",
    tableName: "outcome_enrichment",
    sql: "CREATE INDEX outcome_enrichment_provider_status_updated ON outcome_enrichment(provider, status, updated_at DESC, mint)"
  }),
  Object.freeze({
    type: "index",
    name: "risk_identity_provider_due",
    tableName: "risk_identity_enrichment",
    sql: "CREATE INDEX risk_identity_provider_due ON risk_identity_enrichment(provider, next_attempt_at, mint)"
  }),
  Object.freeze({
    type: "index",
    name: "risk_identity_provider_status_updated",
    tableName: "risk_identity_enrichment",
    sql: "CREATE INDEX risk_identity_provider_status_updated ON risk_identity_enrichment(provider, status, updated_at DESC, mint)"
  }),
  Object.freeze({
    type: "table",
    name: "alerts",
    tableName: "alerts",
    sql: `CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT,
      kind TEXT NOT NULL DEFAULT 'legacy', evidence_class TEXT NOT NULL DEFAULT 'unavailable', evidence_at TEXT,
      dedupe_key TEXT, telegram_status TEXT, telegram_attempted_at TEXT, telegram_message_id INTEGER,
      telegram_attempt_count INTEGER NOT NULL DEFAULT 0, telegram_next_attempt_at TEXT, telegram_last_error_code TEXT,
      created_at TEXT NOT NULL,
      CHECK (
        (telegram_status IS NULL AND telegram_attempted_at IS NULL AND telegram_message_id IS NULL
          AND telegram_attempt_count=0 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NULL)
        OR (telegram_status='pending' AND telegram_attempted_at IS NULL AND telegram_message_id IS NULL
          AND telegram_attempt_count=0 AND coalesce((telegram_next_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ',telegram_next_attempt_at)=telegram_next_attempt_at),0)=1 AND telegram_last_error_code IS NULL)
        OR (telegram_status='retrying' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NULL
          AND telegram_attempt_count>=1 AND coalesce((telegram_next_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ',telegram_next_attempt_at)=telegram_next_attempt_at),0)=1 AND telegram_last_error_code IS NOT NULL)
        OR (telegram_status='sent' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NOT NULL
          AND telegram_attempt_count>=1 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NULL)
        OR (telegram_status='dead-letter' AND telegram_attempted_at IS NOT NULL AND telegram_message_id IS NULL
          AND telegram_attempt_count>=1 AND telegram_next_attempt_at IS NULL AND telegram_last_error_code IS NOT NULL)
      )
    )`
  }),
  Object.freeze({
    type: "table",
    name: "actor_cohort",
    tableName: "actor_cohort",
    sql: `CREATE TABLE actor_cohort (
      mint TEXT PRIMARY KEY NOT NULL,
      launch_observed_at TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','observing','available','unavailable','rate-limited','degraded','invalid-response','complete')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count>=0 AND attempt_count<=3),
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      last_success_at TEXT,
      missing_reason TEXT,
      error_code TEXT,
      updated_at TEXT NOT NULL
    )`
  }),
  Object.freeze({
    type: "table",
    name: "actor_installation",
    tableName: "actor_installation",
    sql: `CREATE TABLE actor_installation (
      id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
      secret BLOB NOT NULL CHECK(length(secret)=32),
      created_at TEXT NOT NULL,
      method_revision TEXT NOT NULL DEFAULT 'uninitialized'
    )`
  }),
  Object.freeze({
    type: "table",
    name: "actor_observations",
    tableName: "actor_observations",
    sql: `CREATE TABLE actor_observations (
      event_key TEXT PRIMARY KEY NOT NULL,
      mint TEXT NOT NULL,
      event TEXT NOT NULL CHECK(json_valid(event) AND json_type(event)='object'),
      source_at TEXT,
      observed_at TEXT NOT NULL,
      retained_until TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  }),
  Object.freeze({
    type: "table",
    name: "actor_summaries",
    tableName: "actor_summaries",
    sql: `CREATE TABLE actor_summaries (
      mint TEXT PRIMARY KEY NOT NULL,
      summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
      updated_at TEXT NOT NULL
    )`
  }),
  Object.freeze({
    type: "table",
    name: "brief_runs",
    tableName: "brief_runs",
    sql: `CREATE TABLE brief_runs (
      brief_key TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      timezone TEXT NOT NULL, method_version TEXT NOT NULL, provider TEXT NOT NULL, data_cutoff TEXT NOT NULL,
      model TEXT NOT NULL CHECK(json_valid(model) AND json_type(model) = 'object'), created_at TEXT NOT NULL
    )`
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
    sql: `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL,
      event_key TEXT, evidence_class TEXT NOT NULL DEFAULT 'unavailable', occurred_at TEXT, created_at TEXT NOT NULL
    )`
  }),
  Object.freeze({
    type: "table",
    name: "outcome_enrichment",
    tableName: "outcome_enrichment",
    sql: `CREATE TABLE outcome_enrichment (
      mint TEXT PRIMARY KEY NOT NULL, provider TEXT, pool TEXT, token_side TEXT, dex TEXT, source_url TEXT,
      evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
      status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), last_attempt_at TEXT,
      next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL,
      CHECK(token_side IS NULL OR token_side IN ('base','quote'))
    )`
  }),
  Object.freeze({
    type: "table",
    name: "risk_identity_enrichment",
    tableName: "risk_identity_enrichment",
    sql: `CREATE TABLE risk_identity_enrichment (
      mint TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL,
      evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'object'),
      status TEXT NOT NULL, missing_reason TEXT, error_code TEXT,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0 AND attempt_count <= 2), last_attempt_at TEXT,
      next_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
    )`
  }),
  Object.freeze({
    type: "table",
    name: "tokens",
    tableName: "tokens",
    sql: "CREATE TABLE tokens (mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  })
]);

const ACTION_SCHEMA_ALERT_OBJECT = Object.freeze({
  type: "table",
  name: "alerts",
  tableName: "alerts",
  sql: `CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT,
    kind TEXT NOT NULL DEFAULT 'legacy', evidence_class TEXT NOT NULL DEFAULT 'unavailable', evidence_at TEXT,
    dedupe_key TEXT, telegram_status TEXT, telegram_attempted_at TEXT, telegram_message_id INTEGER,
    telegram_attempt_count INTEGER NOT NULL DEFAULT 0, telegram_next_attempt_at TEXT, telegram_last_error_code TEXT,
    created_at TEXT NOT NULL
  )`
});
const ACTOR_TABLES = Object.freeze(new Set([
  "actor_installation", "actor_cohort", "actor_observations", "actor_summaries"
]));
const LEGACY_ACTOR_INSTALLATION_OBJECT = Object.freeze({
  type: "table",
  name: "actor_installation",
  tableName: "actor_installation",
  sql: `CREATE TABLE actor_installation (
    id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
    secret BLOB NOT NULL CHECK(length(secret)=32),
    created_at TEXT NOT NULL
  )`
});
const ACTOR_DATABASE_SCHEMA = Object.freeze({
  ...REQUIRED_DATABASE_SCHEMA,
  actor_installation: Object.freeze(["id", "secret", "created_at"])
});
const ACTOR_SCHEMA_OBJECTS = Object.freeze(EXPECTED_SCHEMA_OBJECTS.map((entry) => (
  entry.type === "table" && entry.name === "actor_installation" ? LEGACY_ACTOR_INSTALLATION_OBJECT : entry
)));
const HARDENED_ACTION_DATABASE_SCHEMA = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_DATABASE_SCHEMA).filter(([table]) => !ACTOR_TABLES.has(table))
));
const HARDENED_ACTION_SCHEMA_OBJECTS = Object.freeze(
  EXPECTED_SCHEMA_OBJECTS.filter(({ tableName }) => !ACTOR_TABLES.has(tableName))
);
const ACTION_SCHEMA_OBJECTS = Object.freeze(HARDENED_ACTION_SCHEMA_OBJECTS.map((entry) => (
  entry.type === "table" && entry.name === "alerts" ? ACTION_SCHEMA_ALERT_OBJECT : entry
)));

const RISK_DATABASE_SCHEMA = Object.freeze({
  tokens: Object.freeze(["mint", "payload", "created_at", "updated_at"]),
  events: Object.freeze(["id", "kind", "mint", "payload", "created_at"]),
  alerts: Object.freeze(["id", "level", "title", "message", "mint", "created_at"]),
  callouts: Object.freeze(["external_id", "mint", "payload", "created_at"]),
  outcome_enrichment: REQUIRED_DATABASE_SCHEMA.outcome_enrichment,
  risk_identity_enrichment: REQUIRED_DATABASE_SCHEMA.risk_identity_enrichment
});
const RISK_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: "index", name: "callouts_mint_created", tableName: "callouts", sql: "CREATE INDEX callouts_mint_created ON callouts(mint, created_at DESC)" }),
  Object.freeze({ type: "index", name: "outcome_enrichment_provider_due", tableName: "outcome_enrichment", sql: "CREATE INDEX outcome_enrichment_provider_due ON outcome_enrichment(provider, next_attempt_at, mint)" }),
  Object.freeze({ type: "index", name: "outcome_enrichment_provider_status_updated", tableName: "outcome_enrichment", sql: "CREATE INDEX outcome_enrichment_provider_status_updated ON outcome_enrichment(provider, status, updated_at DESC, mint)" }),
  Object.freeze({ type: "index", name: "risk_identity_provider_due", tableName: "risk_identity_enrichment", sql: "CREATE INDEX risk_identity_provider_due ON risk_identity_enrichment(provider, next_attempt_at, mint)" }),
  Object.freeze({ type: "index", name: "risk_identity_provider_status_updated", tableName: "risk_identity_enrichment", sql: "CREATE INDEX risk_identity_provider_status_updated ON risk_identity_enrichment(provider, status, updated_at DESC, mint)" }),
  Object.freeze({ type: "table", name: "alerts", tableName: "alerts", sql: "CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL)" }),
  Object.freeze({ type: "table", name: "callouts", tableName: "callouts", sql: "CREATE TABLE callouts (external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)" }),
  Object.freeze({ type: "table", name: "events", tableName: "events", sql: "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL)" }),
  ...EXPECTED_SCHEMA_OBJECTS.filter(({ type, tableName }) => type === "table" && ["outcome_enrichment", "risk_identity_enrichment", "tokens"].includes(tableName))
]);
const OUTCOME_DATABASE_SCHEMA = Object.freeze(Object.fromEntries(
  Object.entries(RISK_DATABASE_SCHEMA).filter(([table]) => table !== "risk_identity_enrichment")
));
const OUTCOME_SCHEMA_OBJECTS = Object.freeze(RISK_SCHEMA_OBJECTS.filter(({ tableName }) => tableName !== "risk_identity_enrichment"));
const LEGACY_DATABASE_SCHEMA = Object.freeze(Object.fromEntries(
  Object.entries(OUTCOME_DATABASE_SCHEMA).filter(([table]) => table !== "outcome_enrichment")
));
const LEGACY_SCHEMA_OBJECTS = Object.freeze(OUTCOME_SCHEMA_OBJECTS.filter(({ tableName }) => tableName !== "outcome_enrichment"));

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

const FORBIDDEN_ACTOR_IDENTITY_KEY = /^(?:actorAddress|traderPublicKey|wallet|walletAddress|owner|signer|user|participant|address|account|accountKey|accountAddress|publicKey|creator|deployer|caller|username|handle|profile|profileId|profileUrl|signature|transactionId|txid|rawAddress|identity|identityLookup|lookupMapping|mapping|dedupeKey|integrityKey|secret|digest)$/i;
const RAW_ACTOR_SOCIAL_VALUE = /(?:^|[\s(])(?:@[A-Za-z0-9_]{1,32}\b|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/[^\s)]+)/i;
const RAW_ACTOR_SOLANA_VALUE = /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:[1-9A-HJ-NP-Za-km-z]{64,88}|[1-9A-HJ-NP-Za-km-z]{32,44})(?=$|[^1-9A-HJ-NP-Za-km-z])/;

function actorIdentityViolation(value, expectedMint, pathParts = [], depth = 0) {
  if (depth > 32) return `${pathParts.join(".") || "root"} exceeds the supported nesting depth`;
  if (depth === 0 && (!value || typeof value !== "object" || Array.isArray(value)
    || !isCanonicalSolanaAddress(expectedMint) || value.mint !== expectedMint)) {
    return "mint does not match its canonical actor table key";
  }
  if (typeof value === "string") {
    const key = pathParts.at(-1) || "";
    // The actor schema intentionally exposes the cohort mint and an opaque
    // Actor number. No other scalar may carry a wallet, transaction, or raw
    // social-profile identity, even when its field name is otherwise allowed.
    if (pathParts.length === 1 && key === "mint") {
      return null;
    }
    if (key === "actor" && /^Actor [1-9][0-9]{0,19}$/.test(value)) return null;
    if (RAW_ACTOR_SOCIAL_VALUE.test(value) || RAW_ACTOR_SOLANA_VALUE.test(value)) {
      return `${pathParts.join(".") || "root"} contains raw identity or transaction material`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = actorIdentityViolation(value[index], expectedMint, [...pathParts, String(index)], depth + 1);
      if (violation) return violation;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (FORBIDDEN_ACTOR_IDENTITY_KEY.test(key)) return childPath.join(".");
    if (key === "actor" && (typeof child !== "string" || !/^Actor [1-9][0-9]{0,19}$/.test(child))) {
      return `${childPath.join(".")} is not an opaque actor label`;
    }
    const violation = actorIdentityViolation(child, expectedMint, childPath, depth + 1);
    if (violation) return violation;
  }
  return null;
}

function verifyActorPrivacyRows(database) {
  for (const [table, column] of [["actor_observations", "event"], ["actor_summaries", "summary"]]) {
    const rows = database.prepare(`SELECT mint,${column} AS payload FROM ${table}`).all();
    for (const { mint, payload } of rows) {
      let value;
      try { value = JSON.parse(payload); }
      catch { continue; }
      const violation = actorIdentityViolation(value, mint);
      if (violation) fail(`Database ${table}.${column} persists a raw identity or hidden mapping field: ${violation}`);
    }
  }
  return 0;
}

function inspectOpenDatabase(database, { allowLegacy = false } = {}) {
  const integrity = pragmaValues(database, "PRAGMA integrity_check");
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    fail(`SQLite integrity check failed: ${integrity.join("; ") || "no result"}`);
  }

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    fail(`SQLite foreign-key check found ${foreignKeyViolations.length} violation(s)`);
  }

  const userVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
  const legacy = allowLegacy && userVersion === LEGACY_SCHEMA_VERSION;
  const outcomeOnly = allowLegacy && userVersion === OUTCOME_SCHEMA_VERSION;
  const riskOnly = allowLegacy && userVersion === RISK_SCHEMA_VERSION;
  const actionOnly = allowLegacy && userVersion === ACTION_SCHEMA_VERSION;
  const hardenedActionOnly = allowLegacy && userVersion === HARDENED_ACTION_SCHEMA_VERSION;
  const actorOnly = allowLegacy && userVersion === ACTOR_SCHEMA_VERSION;
  const requiredSchema = legacy ? LEGACY_DATABASE_SCHEMA
    : outcomeOnly ? OUTCOME_DATABASE_SCHEMA
      : riskOnly ? RISK_DATABASE_SCHEMA
        : actionOnly || hardenedActionOnly ? HARDENED_ACTION_DATABASE_SCHEMA
          : actorOnly ? ACTOR_DATABASE_SCHEMA
            : REQUIRED_DATABASE_SCHEMA;
  const expectedSchemaObjects = legacy ? LEGACY_SCHEMA_OBJECTS
    : outcomeOnly ? OUTCOME_SCHEMA_OBJECTS
      : riskOnly ? RISK_SCHEMA_OBJECTS
        : actionOnly ? ACTION_SCHEMA_OBJECTS
          : hardenedActionOnly ? HARDENED_ACTION_SCHEMA_OBJECTS
            : actorOnly ? ACTOR_SCHEMA_OBJECTS
              : EXPECTED_SCHEMA_OBJECTS;
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(({ name }) => name);
  const rowCounts = {};
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
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
    const nullableColumns = REQUIRED_NOT_NULL[table].filter((required) => requiredColumns.includes(required)).filter((required) => {
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
  const normalizedExpectedSchema = expectedSchemaObjects
    .map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }))
    .sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1
      : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (JSON.stringify(normalizedSchema) !== JSON.stringify(normalizedExpectedSchema)) {
    const mismatchAt = Math.max(0, normalizedSchema.findIndex((row, index) => (
      JSON.stringify(row) !== JSON.stringify(normalizedExpectedSchema[index])
    )));
    const actual = normalizedSchema[mismatchAt];
    const expected = normalizedExpectedSchema[mismatchAt];
    fail(`Database schema objects do not exactly match the supported Pump War Room schema near ${actual?.name || "end-of-schema"}; expected ${expected?.name || "end-of-schema"}`);
  }
  if (userVersion !== STORE_SCHEMA_VERSION && !(allowLegacy
    && [LEGACY_SCHEMA_VERSION, OUTCOME_SCHEMA_VERSION, RISK_SCHEMA_VERSION, ACTION_SCHEMA_VERSION,
      HARDENED_ACTION_SCHEMA_VERSION, ACTOR_SCHEMA_VERSION].includes(userVersion))) {
    fail(`Database schema version ${userVersion} does not match required version ${STORE_SCHEMA_VERSION}`);
  }
  const actorSchema = [ACTOR_SCHEMA_VERSION, STORE_SCHEMA_VERSION].includes(userVersion);
  const jsonColumns = {
    tokens: "payload", events: "payload", callouts: "payload",
    ...(legacy ? {} : { outcome_enrichment: "evidence" }),
    ...(legacy || outcomeOnly ? {} : { risk_identity_enrichment: "evidence" }),
    ...(legacy || outcomeOnly || riskOnly ? {} : { brief_runs: "model" }),
    ...(actorSchema ? { actor_observations: "event", actor_summaries: "summary" } : {})
  };
  const invalidJsonPayloads = Object.fromEntries(Object.entries(jsonColumns).map(([table, column]) => [
    table,
    Number(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE NOT json_valid(${column})`).get().count)
  ]));
  let actorPrivacyViolations = null;
  let actorInstallationSecretValid = null;
  let actorMethodRevision = null;
  if (actorSchema) {
    const installation = database.prepare(actorOnly
      ? "SELECT id,secret FROM actor_installation"
      : "SELECT id,secret,method_revision AS methodRevision FROM actor_installation").all();
    actorInstallationSecretValid = installation.length === 1 && installation[0].id === 1
      && (Buffer.isBuffer(installation[0].secret) || installation[0].secret instanceof Uint8Array)
      && installation[0].secret.length === 32;
    if (!actorInstallationSecretValid) fail("Database actor installation secret is missing or malformed");
    if (!actorOnly) {
      actorMethodRevision = installation[0].methodRevision;
      if (actorMethodRevision !== SOLANA_ACTOR_PARSER_REVISION) {
        fail(`Database actor method revision ${actorMethodRevision || "missing"} does not match ${SOLANA_ACTOR_PARSER_REVISION}`);
      }
    }
    actorPrivacyViolations = verifyActorPrivacyRows(database);
  }
  return {
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    pageCount: Number(database.prepare("PRAGMA page_count").get().page_count),
    pageSize: Number(database.prepare("PRAGMA page_size").get().page_size),
    userVersion,
    schemaSha256: schemaHash(normalizedSchema),
    rowCounts,
    invalidJsonPayloads,
    actorInstallationSecretValid,
    actorMethodRevision,
    actorPrivacyViolations
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
  let store;
  let database;
  let transactionStarted = false;
  try {
    const beforeRestartDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const beforeRestartRow = beforeRestartDatabase.prepare("SELECT secret FROM actor_installation WHERE id=1").get();
    beforeRestartDatabase.close();
    const actorSecretBeforeRestart = Buffer.from(beforeRestartRow.secret);
    store = new Store(databasePath);
    database = store.db;
    const revisionPreparation = store.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
    if (revisionPreparation.changed) fail("Database application write probe found an unprepared actor method revision");
    const actorSecretBefore = store.actorPrivacySecret();
    const actorSecretRestartStable = actorSecretBeforeRestart.equals(actorSecretBefore);
    actorSecretBeforeRestart.fill(0);
    if (!actorSecretRestartStable) fail("Database application write probe changed the actor installation secret on reopen");
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
    database.prepare(`INSERT INTO events
      (kind,mint,payload,event_key,evidence_class,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run("restore-verification", mint, payload, `restore-event-${suffix}`, "unavailable", createdAt, createdAt);
    const restoreAlertKey = `restore-alert-${suffix}`;
    database.prepare(`INSERT INTO alerts
      (level,title,message,mint,kind,evidence_class,evidence_at,dedupe_key,telegram_status,telegram_next_attempt_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run("verification", "Restore probe", "Disposable write check", mint, "restore-verification", "unavailable",
        createdAt, restoreAlertKey, "pending", createdAt, createdAt);
    const dueAlertCount = Number(database.prepare(`SELECT count(*) AS count FROM alerts
      WHERE dedupe_key=? AND telegram_status='pending' AND telegram_next_attempt_at<=?`).get(restoreAlertKey, createdAt).count);
    if (dueAlertCount !== 1) fail("Database application write probe could not recover its pending Telegram outbox row");
    try {
      database.prepare(`INSERT INTO alerts
        (level,title,message,mint,kind,evidence_class,dedupe_key,telegram_status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run("verification", "Invalid outbox probe", "Must be rejected", mint, "restore-verification", "unavailable",
          `restore-invalid-alert-${suffix}`, "pending", createdAt);
      fail("Database application write probe accepted an undeliverable pending Telegram outbox row");
    } catch (error) {
      if (error instanceof DatabaseVerificationError) throw error;
    }
    try {
      database.prepare(`INSERT INTO alerts
        (level,title,message,mint,kind,evidence_class,dedupe_key,telegram_status,telegram_next_attempt_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run("verification", "Malformed outbox probe", "Must be rejected", mint, "restore-verification", "unavailable",
          `restore-malformed-alert-${suffix}`, "pending", "zzzz", createdAt);
      fail("Database application write probe accepted a malformed pending Telegram due time");
    } catch (error) {
      if (error instanceof DatabaseVerificationError) throw error;
    }
    database.prepare(`INSERT INTO callouts (external_id,mint,payload,created_at)
      VALUES (?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload`)
      .run(externalId, mint, payload, createdAt);
    database.prepare(`INSERT INTO outcome_enrichment
      (mint,provider,pool,token_side,dex,source_url,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mint, "restore-probe", `restore-pool-${suffix}`, "base", "probe-dex", null,
        JSON.stringify({ source: "restore-verification" }), "complete", null, null, 1, createdAt, null, createdAt, createdAt);
    database.prepare(`INSERT INTO risk_identity_enrichment
      (mint,provider,evidence,status,missing_reason,error_code,attempt_count,last_attempt_at,next_attempt_at,last_success_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mint, "restore-probe", JSON.stringify({ source: "restore-verification" }), "available", null, null, 1, createdAt, null, createdAt, createdAt);
    database.prepare(`INSERT INTO brief_runs
      (brief_key,kind,period_start,period_end,timezone,method_version,provider,data_cutoff,model,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`restore-brief-${suffix}`, "daily", "1999-12-31T00:00:00.000Z", createdAt, "UTC",
        "restore-verification-v1", "deployment-local", createdAt,
        JSON.stringify({ source: "restore-verification", feedCoverage: "unmeasured" }), createdAt);

    database.exec("DELETE FROM actor_summaries; DELETE FROM actor_observations; DELETE FROM actor_cohort");
    const actorMint = "So11111111111111111111111111111111111111112";
    const actorEvent = {
      schemaVersion: 1,
      mint: actorMint,
      actor: "Actor 1",
      side: "buy",
      amounts: { native: null, token: 1 },
      source: { name: "solana-mainnet-rpc", evidenceClass: "on-chain-finalized" },
      timestamps: { source: { state: "missing", value: null }, observedAt: createdAt },
      transactionProvenance: {
        state: "internal-only", evidenceClass: "locally-derived", slot: { state: "available", value: 1 }
      }
    };
    const actorEventKey = `restore-actor-${suffix}`;
    const admitted = store.admitActorMint({
      mint: actorMint,
      launchObservedAt: createdAt,
      admittedAt: createdAt,
      nextAttemptAt: createdAt,
      limit: 64
    });
    if (!admitted.admitted) fail("Database application write probe could not admit its disposable actor mint");
    const observation = store.saveActorObservation({
      eventKey: actorEventKey,
      mint: actorMint,
      event: actorEvent,
      observedAt: createdAt,
      retainedUntil: "2000-01-03T00:00:00.000Z"
    });
    if (!observation.written) fail("Database application write probe could not persist its actor observation");
    const duplicate = store.saveActorObservation({
      eventKey: actorEventKey,
      mint: actorMint,
      event: actorEvent,
      observedAt: createdAt,
      retainedUntil: "2000-01-03T00:00:00.000Z"
    });
    if (duplicate.written) fail("Database application write probe did not deduplicate its actor observation");
    let actorConflictRejected = false;
    try {
      store.saveActorObservation({
        eventKey: actorEventKey,
        mint: actorMint,
        event: { ...actorEvent, side: "sell" },
        observedAt: createdAt,
        retainedUntil: "2000-01-03T00:00:00.000Z"
      });
    } catch (error) {
      if (!/dedupe key conflicts/.test(error?.message || "")) throw error;
      actorConflictRejected = true;
    }
    if (!actorConflictRejected) fail("Database application write probe accepted conflicting actor evidence");
    let rawIdentityRejected = false;
    try {
      store.saveActorObservation({
        eventKey: `restore-raw-actor-${suffix}`,
        mint: actorMint,
        event: { ...actorEvent, actorAddress: "So11111111111111111111111111111111111111112" },
        observedAt: createdAt,
        retainedUntil: "2000-01-03T00:00:00.000Z"
      });
    } catch (error) {
      if (!/raw identity/.test(error?.message || "")) throw error;
      rawIdentityRejected = true;
    }
    if (!rawIdentityRejected) fail("Database application write probe persisted a raw actor identity");
    const expiredEvent = {
      ...actorEvent,
      timestamps: { ...actorEvent.timestamps, observedAt: "1999-12-30T00:00:00.000Z" }
    };
    store.saveActorObservation({
      eventKey: `restore-expired-actor-${suffix}`,
      mint: actorMint,
      event: expiredEvent,
      observedAt: "1999-12-30T00:00:00.000Z",
      retainedUntil: "1999-12-31T00:00:00.000Z"
    });
    const retention = store.pruneActorObservations({ now: createdAt, maximum: 1 });
    if (retention.expired !== 1 || retention.excess !== 0 || retention.retained !== 1) {
      fail("Database application write probe could not enforce actor-observation retention");
    }
    const actorSummary = store.saveActorSummary(actorMint, {
      schemaVersion: 1,
      mint: actorMint,
      coverage: { state: "insufficient-sample", eventCount: 1, uniqueActorCount: 1 },
      metrics: null
    });
    if (actorSummary.mint !== actorMint || !store.actorSummary(actorMint)) {
      fail("Database application write probe could not persist its actor summary");
    }
    const actorSecretAfter = store.actorPrivacySecret();
    const actorSecretStable = actorSecretBefore.equals(actorSecretAfter);
    actorSecretBefore.fill(0);
    actorSecretAfter.fill(0);
    if (!actorSecretStable) fail("Database application write probe changed the actor installation secret");
    const actorPrivacyViolations = verifyActorPrivacyRows(database);
    const inserted = Number(database.prepare("SELECT count(*) AS count FROM tokens WHERE mint=?").get(mint).count);
    if (inserted !== 1) fail("Database application write probe could not read its disposable token row");
    database.exec("ROLLBACK");
    transactionStarted = false;
    return {
      verified: true,
      rolledBack: true,
      telegramOutboxDue: true,
      invalidPendingRejected: true,
      actor: {
        installationSecretStable: true,
        admissionWritten: true,
        observationWritten: true,
        duplicateSuppressed: true,
        conflictRejected: actorConflictRejected,
        summaryWritten: true,
        retentionEnforced: true,
        rawIdentityRejected,
        rawIdentityViolations: actorPrivacyViolations
      }
    };
  } catch (error) {
    if (transactionStarted) {
      try { database?.exec("ROLLBACK"); } catch {}
    }
    if (error instanceof DatabaseVerificationError) throw error;
    fail(`Database application write probe failed: ${error.message}`, error);
  } finally {
    try { store?.db.close(); } catch {}
  }
}

export function inspectDatabaseFile(databasePath, { allowLegacy = false } = {}) {
  const candidate = regularFile(databasePath, "Database file");
  let database;
  try {
    database = new DatabaseSync(candidate.realPath, { readOnly: true });
    const sqlite = inspectOpenDatabase(database, { allowLegacy });
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
      JSON.stringify(original.invalidJsonPayloads) !== JSON.stringify(restored.invalidJsonPayloads) ||
      original.actorInstallationSecretValid !== restored.actorInstallationSecretValid ||
      original.actorMethodRevision !== restored.actorMethodRevision ||
      original.actorPrivacyViolations !== restored.actorPrivacyViolations) {
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
    const artifact = inspectDatabaseFile(backup.realPath, { allowLegacy: true });
    copyFileSync(backup.realPath, restoredPath, constants.COPYFILE_EXCL);
    chmodSync(restoredPath, 0o600);
    let restored = inspectDatabaseFile(restoredPath, { allowLegacy: true });
    assertSameRestore(artifact, restored);
    const migratedFromSchemaVersion = [LEGACY_SCHEMA_VERSION, OUTCOME_SCHEMA_VERSION, RISK_SCHEMA_VERSION,
      ACTION_SCHEMA_VERSION, HARDENED_ACTION_SCHEMA_VERSION, ACTOR_SCHEMA_VERSION].includes(restored.userVersion)
      ? restored.userVersion
      : null;
    if (migratedFromSchemaVersion !== null) {
      const migratedStore = new Store(restoredPath);
      migratedStore.prepareActorMethodRevision(SOLANA_ACTOR_PARSER_REVISION);
      migratedStore.db.close();
      restored = inspectDatabaseFile(restoredPath);
    }
    const applicationWriteProbe = verifyApplicationWrites(restoredPath);
    const afterProbe = inspectDatabaseFile(restoredPath);
    if (afterProbe.schemaSha256 !== restored.schemaSha256 ||
        JSON.stringify(afterProbe.rowCounts) !== JSON.stringify(restored.rowCounts) ||
        JSON.stringify(afterProbe.invalidJsonPayloads) !== JSON.stringify(restored.invalidJsonPayloads) ||
        afterProbe.actorInstallationSecretValid !== restored.actorInstallationSecretValid ||
        afterProbe.actorMethodRevision !== restored.actorMethodRevision ||
        afterProbe.actorPrivacyViolations !== restored.actorPrivacyViolations) {
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
        userVersion: restored.userVersion,
        migratedFromSchemaVersion,
        applicationWriteProbe,
        sha256: restored.sha256,
        bytes: restored.bytes,
        schemaSha256: restored.schemaSha256,
        rowCounts: restored.rowCounts,
        invalidJsonPayloads: restored.invalidJsonPayloads,
        actorInstallationSecretValid: restored.actorInstallationSecretValid,
        actorMethodRevision: restored.actorMethodRevision,
        actorPrivacyViolations: restored.actorPrivacyViolations
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
