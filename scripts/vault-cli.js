#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { isCanonicalSolanaAddress } from "../src/early-actors.js";
import { projectPublicToken } from "../src/privacy.js";
import { Store } from "../src/store.js";
import { exportCoin, exportMeasuredBrief } from "../src/vault.js";

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument: ${key || "missing"}`);
    options[key.slice(2)] = value;
    index++;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

export async function runVaultCli(argv) {
  const { command, options } = parseArguments(argv);
  const database = path.resolve(required(options, "database"));
  const vault = path.resolve(required(options, "vault"));
  if (!existsSync(database)) throw new Error(`Database does not exist: ${database}`);
  if (vault === path.parse(vault).root) throw new Error("Vault path must not be a filesystem root");
  const store = new Store(database);
  try {
    if (command === "coin") {
      const mint = required(options, "mint");
      if (!isCanonicalSolanaAddress(mint)) throw new Error("--mint must be a canonical Solana mint");
      const retained = store.token(mint);
      if (!retained || retained.mint !== mint || !isCanonicalSolanaAddress(retained.mint)) {
        throw new Error("Mint is not retained as a canonical exact-mint row in this database");
      }
      const token = projectPublicToken(retained);
      if (token?.mint !== mint) throw new Error("Mint is not retained as a public exact-mint row in this database");
      return { command, resource: "coin", mint, output: await exportCoin(vault, token) };
    }
    if (command === "brief") {
      const period = required(options, "period");
      if (!["daily", "weekly"].includes(period)) throw new Error("--period must be daily or weekly");
      const run = store.briefRun(period);
      if (!run?.model) throw new Error(`No persisted ${period} measured brief is available`);
      return { command, resource: "brief", period, output: await exportMeasuredBrief(vault, run.model) };
    }
    throw new Error("Command must be coin or brief");
  } finally {
    store.db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    process.stdout.write(`${JSON.stringify(await runVaultCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
