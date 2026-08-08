#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVerifiedBackup, verifyRestorableBackup } from "../src/database-backup.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  npm run db:backup -- --output <new-backup.db> [--source <live.db>] [--scratch-dir <dir>]
  npm run db:restore:verify -- --backup <backup.db> [--scratch-dir <dir>]

The restore verification command only uses a disposable copy. It never replaces DB_PATH.`;
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!["source", "output", "backup", "scratch-dir"].includes(name)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (parsed[name]) throw new Error(`Option supplied more than once: ${argument}`);
    parsed[name] = value;
  }
  return parsed;
}

function resolved(value) {
  return value ? path.resolve(process.cwd(), value) : undefined;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const parsed = options(argv);
  if (parsed.help) {
    console.log(usage());
    return;
  }

  if (command === "backup") {
    if (!parsed.output) throw new Error("--output is required and must name a new file");
    if (parsed.backup) throw new Error("--backup is only valid for restore-verify");
    const source = parsed.source
      ? resolved(parsed.source)
      : path.resolve(projectRoot, process.env.DB_PATH || "data/pump-war-room.db");
    const report = createVerifiedBackup(source, resolved(parsed.output), { scratchRoot: resolved(parsed["scratch-dir"]) });
    console.log(JSON.stringify({ ok: true, action: "verified-backup-created", ...report }, null, 2));
    return;
  }

  if (command === "restore-verify") {
    if (!parsed.backup) throw new Error("--backup is required");
    if (parsed.source || parsed.output) throw new Error("--source and --output are only valid for backup");
    const report = verifyRestorableBackup(resolved(parsed.backup), { scratchRoot: resolved(parsed["scratch-dir"]) });
    console.log(JSON.stringify({
      ok: true,
      action: "disposable-restore-verified",
      ...report,
      liveDatabaseReplaced: false
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command || "(missing)"}`);
}

main().catch((error) => {
  console.error(`Database maintenance failed: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
});
