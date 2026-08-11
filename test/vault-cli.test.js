import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runVaultCli } from "../scripts/vault-cli.js";
import { Store } from "../src/store.js";

const mint = "11111111111111111111111111111111";

test("local vault CLI exports only an explicitly retained projected mint", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-vault-cli-"));
  const database = path.join(directory, "war-room.db");
  const vault = path.join(directory, "vault");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(database);
  store.upsertToken({
    mint, name: "CLI coin", symbol: "CLI", narrative: "Other", source: "pumpportal",
    status: "bonding", createdAt: "2026-08-10T12:00:00.000Z", creator: "So11111111111111111111111111111111111111112"
  });
  store.db.close();

  const result = await runVaultCli(["coin", "--database", database, "--vault", vault, "--mint", mint]);
  assert.equal(result.resource, "coin");
  assert.equal(existsSync(result.output), true);
  const markdown = readFileSync(result.output, "utf8");
  assert.match(markdown, /CLI coin/);
  assert.doesNotMatch(markdown, /So11111111111111111111111111111111111111112/);
  await assert.rejects(runVaultCli(["coin", "--database", database, "--vault", vault, "--mint", "bad"]), /canonical Solana mint/);
});

test("local vault CLI rejects a quarantined row whose payload mint does not match its retained key", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-vault-cli-integrity-"));
  const database = path.join(directory, "war-room.db");
  const vault = path.join(directory, "vault");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(database);
  store.db.prepare("INSERT INTO tokens (mint,payload,created_at,updated_at) VALUES (?,?,?,?)")
    .run(mint, JSON.stringify({
      mint: "So11111111111111111111111111111111111111112",
      name: "Mismatched row",
      symbol: "BAD",
      narrative: "Other",
      source: "pumpportal",
      status: "bonding",
      createdAt: "2026-08-10T12:00:00.000Z"
    }), "2026-08-10T12:00:00.000Z", "2026-08-10T12:00:00.000Z");
  store.db.close();

  await assert.rejects(
    runVaultCli(["coin", "--database", database, "--vault", vault, "--mint", mint]),
    /not retained as a canonical exact-mint row/
  );
  assert.equal(existsSync(vault), false);
});
