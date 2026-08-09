#!/usr/bin/env node
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, STORE_SCHEMA_VERSION } from "../src/store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  npm run outcomes:purge -- --provider <provider> --confirm DELETE-<provider> [--database <database.db>]

Secure-deletes derived enrichment for one provider with exclusive access, truncates SQLite WAL, and vacuums the selected existing database.
Stop the service first and separately securely delete provider-derived backup artifacts.`;
}

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!["--provider", "--confirm", "--database"].includes(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    result[option.slice(2)] = value;
  }
  return result;
}

function verifyExistingDatabase(databasePath) {
  let stats;
  try { stats = lstatSync(databasePath); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Database does not exist: ${databasePath}`);
    throw error;
  }
  if (!stats.isFile()) throw new Error(`Database path must be an existing regular file: ${databasePath}`);
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = probe.prepare("PRAGMA integrity_check").get().integrity_check;
    const schemaVersion = Number(probe.prepare("PRAGMA user_version").get().user_version);
    const enrichmentTable = Number(probe.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type='table' AND name='outcome_enrichment'`).get().count);
    if (integrity !== "ok") throw new Error("Database integrity check failed");
    if (schemaVersion !== STORE_SCHEMA_VERSION || enrichmentTable !== 1) {
      throw new Error(`Database is not a supported Pump War Room schema ${STORE_SCHEMA_VERSION} enrichment database`);
    }
  } finally {
    probe.close();
  }
}

function main() {
  const options = parse(process.argv.slice(2));
  if (!options.provider || options.confirm !== `DELETE-${options.provider}`) {
    throw new Error(`Provider and exact confirmation are required.\n${usage()}`);
  }
  const databasePath = path.resolve(process.cwd(), options.database || process.env.DB_PATH || path.join(projectRoot, "data/pump-war-room.db"));
  verifyExistingDatabase(databasePath);
  const store = new Store(databasePath);
  try {
    const result = store.deleteEnrichmentByProvider(options.provider);
    console.log(JSON.stringify({ ok: true, action: "provider-enrichment-securely-purged", databasePath, ...result }, null, 2));
  } finally {
    store.db.close();
  }
}

try { main(); }
catch (error) {
  console.error(`Outcome data purge failed: ${error.message}`);
  process.exitCode = 1;
}
