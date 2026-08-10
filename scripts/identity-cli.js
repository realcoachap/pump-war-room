#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

function existingDatabase(options) {
  const databasePath = path.resolve(required(options, "database"));
  if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
  return databasePath;
}

function importDocument(filePath) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) throw new Error(`Import file does not exist: ${resolved}`);
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Import document must be an object");
  const allowed = new Set(["entities", "relationships"]);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error(`Import document key is not allowed: ${key}`);
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
    throw new Error("Import document requires entities and relationships arrays");
  }
  if (parsed.entities.length > 100 || parsed.relationships.length > 500) throw new Error("Import document exceeds bounded entry limits");
  return parsed;
}

export function runIdentityCli(argv) {
  const { command, options } = parseArguments(argv);
  const databasePath = existingDatabase(options);
  const store = new Store(databasePath);
  try {
    if (command === "status") {
      return { command, database: databasePath, coverage: store.identityRegistryCoverage() };
    }
    if (command === "proposals") {
      const status = options.status || "pending";
      const limit = options.limit === undefined ? 100 : Number(options.limit);
      return { command, database: databasePath, status, proposals: store.identityProposals({ status, limit }) };
    }
    if (command === "decide") {
      const proposalKey = required(options, "proposal");
      const value = required(options, "decision");
      if (!["accept", "reject", "supersede"].includes(value)) throw new Error("--decision must be accept, reject, or supersede");
      const decidedAt = options["decided-at"] || new Date().toISOString();
      const proposal = store.decideIdentityProposal({
        proposalKey,
        decision: {
          decisionId: required(options, "decision-id"),
          subjectType: "proposal",
          subjectId: proposalKey,
          decision: value,
          reasonCode: required(options, "reason-code"),
          decidedAt,
          ...(options.supersedes ? { supersedesDecisionId: options.supersedes } : {})
        }
      });
      return { command, database: databasePath, proposal };
    }
    if (command === "import") {
      const document = importDocument(required(options, "file"));
      const entities = document.entities.map((entry) => store.saveIdentityEntity(entry));
      const relationships = document.relationships.map((entry) => store.saveIdentityRelationship(entry));
      return { command, database: databasePath, imported: { entities: entities.length, relationships: relationships.length }, coverage: store.identityRegistryCoverage() };
    }
    throw new Error("Command must be status, proposals, decide, or import");
  } finally {
    store.db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    process.stdout.write(`${JSON.stringify(runIdentityCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

