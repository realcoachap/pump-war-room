import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startDemoServer(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-action-api-"));
  const port = await availablePort();
  const child = spawn(process.execPath, [path.resolve("src/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      PUMP_MODE: "demo",
      DB_PATH: path.join(directory, "war-room.db"),
      VAULT_PATH: path.join(directory, "vault"),
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
    if (child.exitCode !== null) throw new Error(`demo server exited before readiness: ${diagnostics}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return baseUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`demo server did not become ready: ${diagnostics}`);
}

async function json(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

test("action intelligence API enforces strict methods, bounds, and public contracts", async (t) => {
  const baseUrl = await startDemoServer(t);
  const { body: snapshot } = await json(baseUrl, "/api/snapshot");
  assert.equal(snapshot.version, "0.8.1");
  assert.equal(snapshot.actionIntelligence.watchlists.persistence, "browser-local");
  assert.equal(snapshot.actionIntelligence.alerts.telegram.status, "not-configured");
  assert.equal(snapshot.actionIntelligence.alerts.persistence, "atomic-event-alert-outbox-with-durable-baseline");
  assert.equal(snapshot.actionIntelligence.alerts.publicDeliveryMetadata, "aggregate-only");
  assert.doesNotMatch(JSON.stringify(snapshot.actionIntelligence), /TELEGRAM_(?:BOT_TOKEN|CHAT_ID)|bot\d*:/i);
  assert.doesNotMatch(JSON.stringify(snapshot.alerts || []), /telegram|dedupeKey/i,
    "public alerts must not expose per-delivery or dedupe metadata");
  const mints = snapshot.tokens.slice(0, 2).map(({ mint }) => mint);
  assert.equal(mints.length, 2);

  const dossier = await json(baseUrl, `/api/coins/${mints[0]}`);
  assert.equal(dossier.response.status, 200);
  assert.equal(dossier.body.token.mint, mints[0]);
  assert.deepEqual(Object.keys(dossier.body).sort(), ["disclaimer", "generatedAt", "outcome", "radar", "schemaVersion", "scope", "timeline", "token"]);

  const firstPage = await json(baseUrl, `/api/coins/${mints[0]}/timeline?limit=1`);
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.limit, 1);
  assert.equal(firstPage.body.entries.length, 1);
  assert.equal(firstPage.body.rawProviderPayloadsIncluded, false);
  if (firstPage.body.nextBefore) {
    const secondPage = await json(baseUrl, `/api/coins/${mints[0]}/timeline?limit=1&before=${encodeURIComponent(firstPage.body.nextBefore)}`);
    assert.equal(secondPage.response.status, 200);
    assert.notDeepEqual(secondPage.body.entries, firstPage.body.entries);
  }

  const comparison = await json(baseUrl, `/api/compare?mints=${encodeURIComponent(mints.join(","))}`);
  assert.equal(comparison.response.status, 200);
  assert.deepEqual(comparison.body.requestedMints, mints);
  assert.equal(comparison.body.coins.length, 2);
  assert.equal(comparison.body.rankingBoundary, "uncalibrated risk factors do not affect radar rank");

  for (const period of ["daily", "weekly"]) {
    const brief = await json(baseUrl, `/api/briefs/${period}`);
    assert.equal(brief.response.status, 200);
    assert.equal(brief.body.period, period);
    assert.equal(brief.body.methodVersion, "measured-closed-brief-v2");
    assert.equal(brief.body.feedCoverage, "unmeasured");
    assert.equal(brief.body.priorPeriod.windowEnd, brief.body.windowStart);
  }

  for (const pathname of [
    `/api/coins/${mints[0]}/timeline?limit=0`,
    `/api/coins/${mints[0]}/timeline?limit=201`,
    `/api/coins/${mints[0]}/timeline?limit=2.5`,
    `/api/coins/${mints[0]}/timeline?unknown=1`,
    `/api/coins/${mints[0]}/timeline?before=invalid`,
    `/api/compare?mints=${mints[0]},${mints[0]}`,
    "/api/compare?mints=bad,also-bad"
  ]) {
    assert.equal((await fetch(`${baseUrl}${pathname}`)).status, 400, pathname);
  }
  for (const pathname of [
    "/api/health", "/api/snapshot", `/api/coins/${mints[0]}`, `/api/coins/${mints[0]}/timeline`,
    `/api/compare?mints=${mints.join(",")}`, "/api/briefs/daily"
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, { method: "POST" });
    assert.equal(response.status, 405, pathname);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal((await fetch(`${baseUrl}/api/export/weekly`)).status, 405);
});
