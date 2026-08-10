import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

const liveMint = "11111111111111111111111111111111";

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, mode) {
  const directory = mkdtempSync(path.join(tmpdir(), `pump-war-room-export-${mode}-`));
  const port = await availablePort();
  const dbPath = path.join(directory, "war-room.db");
  const vaultPath = path.join(directory, "vault");
  if (mode === "live") {
    const store = new Store(dbPath);
    store.upsertToken({
      ingestSchemaVersion: 2,
      mint: liveMint,
      name: "Live export boundary fixture",
      symbol: "LIVE",
      narrative: "Other",
      source: "pumpportal",
      status: "bonding",
      createdAt: new Date().toISOString()
    });
    store.db.close();
  }
  const child = spawn(process.execPath, [path.resolve("src/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      PUMP_MODE: mode,
      DB_PATH: dbPath,
      VAULT_PATH: vaultPath,
      PUMPPORTAL_URL: "ws://127.0.0.1:1",
      OUTCOME_ENRICHMENT: "false",
      RISK_IDENTITY_ENRICHMENT: "false",
      EARLY_ACTOR_ENRICHMENT: "false",
      BARK_API_KEY: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`${mode} server exited before readiness: ${diagnostics}`);
    try {
      const response = await fetch(`${baseUrl}/api/snapshot`);
      if (response.ok) return { baseUrl, vaultPath };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${mode} server did not become ready: ${diagnostics}`);
}

async function postJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST" });
  return { response, body: await response.json() };
}

function assertLiveDisabled(result) {
  assert.equal(result.response.status, 403);
  assert.deepEqual(Object.keys(result.body).sort(), ["code", "error", "mode", "ok", "requestId"]);
  assert.deepEqual({
    ok: result.body.ok,
    code: result.body.code,
    error: result.body.error,
    mode: result.body.mode
  }, {
    ok: false,
    code: "vault-export-disabled",
    error: "Vault export is disabled in live mode",
    mode: "live"
  });
  assert.match(result.body.requestId, /^[0-9a-f-]{36}$/);
}

test("live export routes fail closed before creating or overwriting vault files", async (t) => {
  const { baseUrl, vaultPath } = await startServer(t, "live");
  const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(snapshot.publicDelivery.vaultExports, "disabled");
  assert.equal(snapshot.publicDelivery.snapshotEncoding, "gzip-when-accepted");
  assert.equal(snapshot.publicDelivery.browserRefresh, "coalesced-with-15-second-post-completion-cooldown");
  assert.deepEqual(health.publicDelivery, snapshot.publicDelivery);
  assert.equal(health.readinessScope.releaseEligibility, "separate-smoke-data-calibration-backup-and-recovery-gates");
  assert.equal(health.readinessScope.statusBasis, "verified-feed-freshness-and-mounted-storage");
  assert.equal(health.readinessScope.mountEvidenceRequired, true);
  assert.equal(health.readinessScope.cohortCoverageIncluded, false);
  const routes = [
    "/api/export/daily",
    "/api/export/weekly",
    `/api/export/coin/${liveMint}`,
    "/api/export/coin/%ZZ"
  ];

  for (const route of routes) assertLiveDisabled(await postJson(baseUrl, route));
  assert.equal(existsSync(vaultPath), false, "live export requests must not create the configured vault root");

  const daily = await (await fetch(`${baseUrl}/api/briefs/daily`)).json();
  const weekly = await (await fetch(`${baseUrl}/api/briefs/weekly`)).json();
  const targets = [
    path.join(vaultPath, "Daily Briefs", `${daily.windowStart.slice(0, 10)} Pump Daily Brief.md`),
    path.join(vaultPath, "Weekly Briefs", `${weekly.windowStart.slice(0, 10)} Pump Weekly Brief.md`),
    path.join(vaultPath, "Coins", `LIVE - ${liveMint.slice(0, 8)}.md`),
    path.join(vaultPath, "Narratives", "Other.md")
  ];
  for (const [index, target] of targets.entries()) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `sentinel-${index}`, "utf8");
  }

  for (const route of routes) assertLiveDisabled(await postJson(baseUrl, route));
  for (const [index, target] of targets.entries()) {
    assert.equal(readFileSync(target, "utf8"), `sentinel-${index}`, `${path.basename(target)} must not be overwritten`);
  }
  assert.deepEqual(readdirSync(path.join(vaultPath, "Daily Briefs")), [path.basename(targets[0])]);
  assert.deepEqual(readdirSync(path.join(vaultPath, "Weekly Briefs")), [path.basename(targets[1])]);
  assert.deepEqual(readdirSync(path.join(vaultPath, "Coins")), [`LIVE - ${liveMint.slice(0, 8)}.md`]);
  assert.deepEqual(readdirSync(path.join(vaultPath, "Narratives")), ["Other.md"]);
});

test("demo mode keeps explicit local operator vault exports", async (t) => {
  const { baseUrl, vaultPath } = await startServer(t, "demo");
  const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
  const mint = snapshot.tokens[0].mint;

  for (const [route, expected] of [
    ["/api/export/daily", { period: "daily" }],
    ["/api/export/weekly", { period: "weekly" }],
    [`/api/export/coin/${mint}`, { resource: "coin" }]
  ]) {
    const { response, body } = await postJson(baseUrl, route);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "demo");
    assert.equal(body.scope, "local-demo-operator-vault");
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, body[key]])), expected);
  }

  assert.ok(readdirSync(path.join(vaultPath, "Daily Briefs")).some((file) => file.endsWith("Pump Daily Brief.md")));
  assert.ok(readdirSync(path.join(vaultPath, "Weekly Briefs")).some((file) => file.endsWith("Pump Weekly Brief.md")));
  assert.ok(readdirSync(path.join(vaultPath, "Coins")).some((file) => file.endsWith(".md")));
  assert.ok(readdirSync(path.join(vaultPath, "Narratives")).some((file) => file.endsWith(".md")));
});
