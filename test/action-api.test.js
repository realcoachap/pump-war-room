import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

const expectedVersion = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).version;
const rawDeployer = "So11111111111111111111111111111111111111112";
const rawCaller = "@privacy-contract-caller";
const rawSignature = "3".repeat(64);
const privacyMarker = "RAW_PRIVATE_TOKEN_MARKER";
const staleActorLabel = "Actor 1";
const forbiddenIdentityKeys = new Set([
  "creator", "deployer", "caller", "trader", "traderaddress", "traderwallet", "traderpublickey",
  "actoraddress", "signature", "transactionid", "txid", "wallet", "walletaddress", "walletid",
  "walletpublickey", "owner", "owneraddress", "ownerwallet", "ownerpublickey", "signer",
  "signeraddress", "signerwallet", "signerpublickey", "user", "useraddress", "userwallet",
  "userpublickey", "participant", "participantaddress", "participantwallet", "participantpublickey",
  "authority", "authorityaddress", "payer", "payeraddress", "feepayer", "sender", "recipient",
  "address", "account", "accountaddress", "accountkey", "accountpublickey", "publickey",
  "profile", "profileid", "profileurl", "profilehandle", "username", "handle"
]);

const normalizedIdentityKey = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

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
  const dbPath = path.join(directory, "war-room.db");
  const child = spawn(process.execPath, [path.resolve("src/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      PUMP_MODE: "demo",
      DB_PATH: dbPath,
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
      if (response.ok) return { baseUrl, dbPath };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`demo server did not become ready: ${diagnostics}`);
}

function assertNoRawIdentityKeys(value, label) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoRawIdentityKeys(entry, label);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedIdentityKey(key);
    const forbidden = forbiddenIdentityKeys.has(normalized)
      || /^(?:creator|deployer|caller)(?:address|wallet|publickey|profile|handle|id)$/.test(normalized)
      || normalized.endsWith("signature");
    assert.equal(forbidden, false, `${label} exposed forbidden identity key ${key}`);
    assertNoRawIdentityKeys(entry, label);
  }
}

async function nextTokenStreamEvent(baseUrl, { retainedMints } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream closed before a token event");
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (["new-token", "token-update"].includes(event) && data) {
          const parsed = JSON.parse(data);
          if (retainedMints && !retainedMints.has(parsed.mint)) continue;
          await reader.cancel();
          return { event, data: parsed };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function json(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

test("action intelligence API enforces strict methods, bounds, and public contracts", async (t) => {
  const { baseUrl, dbPath } = await startDemoServer(t);
  const privateStore = new Store(dbPath);
  const retainedTokens = privateStore.tokens(50);
  const privateToken = retainedTokens[0];
  assert.ok(privateToken?.creator, "demo fixture must retain a private creator for projection coverage");
  for (const token of retainedTokens) {
    privateStore.upsertToken({
      ...token,
      ...(token.mint === privateToken.mint ? {
        deployer: rawDeployer,
        creatorActor: staleActorLabel,
        deployerActor: staleActorLabel,
        description: `${privacyMarker} https://x.com/privacy_contract ${rawDeployer}`,
        signature: rawSignature,
        unknownNested: { walletAddress: rawDeployer, profileUrl: "https://x.com/privacy_contract" }
      } : {}),
      name: token.mint === privateToken.mint ? rawDeployer : "https://x.com/privacy_contract",
      symbol: rawSignature,
      narrative: `Narrative ${rawDeployer}`
    });
  }
  privateStore.admitActorMint({
    mint: privateToken.mint,
    launchObservedAt: privateToken.createdAt,
    admittedAt: privateToken.createdAt,
    nextAttemptAt: new Date(Date.parse(privateToken.createdAt) + 120_000).toISOString(),
    limit: 32
  });
  const privateCallout = {
    externalId: "privacy-contract-event",
    mint: privateToken.mint,
    symbol: privateToken.symbol,
    source: "bark",
    caller: rawCaller,
    multiple: 2,
    createdAt: new Date().toISOString()
  };
  privateStore.upsertCallout(privateCallout);
  privateStore.addEvent("callout", privateCallout);
  privateStore.db.close();

  const { body: snapshot } = await json(baseUrl, "/api/snapshot");
  assert.equal(snapshot.version, expectedVersion);
  assertNoRawIdentityKeys(snapshot, "snapshot");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(JSON.stringify(snapshot).includes(privacyMarker), false);
  assert.equal(JSON.stringify(snapshot).includes("privacy_contract"), false);
  const projectedToken = snapshot.tokens.find(({ mint }) => mint === privateToken.mint);
  assert.match(projectedToken.creatorActor, /^Actor [1-9]\d*$/);
  assert.match(projectedToken.deployerActor, /^Actor [1-9]\d*$/);
  assert.notEqual(projectedToken.creatorActor, staleActorLabel);
  assert.notEqual(projectedToken.deployerActor, staleActorLabel);
  assert.equal(projectedToken.description, undefined);
  assert.equal(projectedToken.signature, undefined);
  assert.equal(projectedToken.unknownNested, undefined);
  assert.equal(projectedToken.name, undefined);
  assert.equal(projectedToken.symbol, undefined);
  assert.equal(projectedToken.narrative, undefined);
  const riskCohortToken = snapshot.riskIntelligence.cohort.observations.find(({ mint }) => mint === privateToken.mint);
  assert.equal(riskCohortToken.name, "Unnamed mint");
  assert.equal(riskCohortToken.symbol, "???");
  const actorCohortToken = snapshot.earlyActorIntelligence.cohort.observations.find(({ mint }) => mint === privateToken.mint);
  assert.equal(actorCohortToken.name, "Unnamed mint");
  assert.equal(actorCohortToken.symbol, "???");
  const projectedCallout = snapshot.callouts.find(({ mint }) => mint === privateToken.mint);
  assert.match(projectedCallout.sourceActor, /^Actor [1-9]\d*$/);
  assert.equal(snapshot.actionIntelligence.watchlists.persistence, "browser-local");
  assert.equal(snapshot.actionIntelligence.alerts.telegram.status, "not-configured");
  assert.equal(snapshot.actionIntelligence.alerts.persistence, "atomic-event-alert-outbox-with-durable-baseline");
  assert.equal(snapshot.actionIntelligence.alerts.publicDeliveryMetadata, "aggregate-only");
  assert.doesNotMatch(JSON.stringify(snapshot.actionIntelligence), /TELEGRAM_(?:BOT_TOKEN|CHAT_ID)|bot\d*:/i);
  assert.doesNotMatch(JSON.stringify(snapshot.alerts || []), /telegram|dedupeKey/i,
    "public alerts must not expose per-delivery or dedupe metadata");
  assert.equal(snapshot.earlyActorIntelligence.engine.status, "simulation-disabled");
  assert.equal(snapshot.earlyActorIntelligence.cohort.admittedCount, 1);
  assert.equal(snapshot.earlyActorIntelligence.privacy.rawWalletsPublic, false);
  assert.equal(snapshot.earlyActorIntelligence.privacy.rawProfilesPublic, false);
  assert.equal(snapshot.earlyActorIntelligence.privacy.actorLookupEndpoint, false);
  assert.equal(snapshot.earlyActorIntelligence.downstream.status, "withheld");
  assert.equal(snapshot.earlyActorIntelligence.downstream.labeledHoldoutCalibrationPassed, false);
  assert.deepEqual({
    ranking: snapshot.earlyActorIntelligence.downstream.rankingImpact,
    risk: snapshot.earlyActorIntelligence.downstream.riskProbabilityImpact,
    telegram: snapshot.earlyActorIntelligence.downstream.telegramAlertImpact,
    recommendation: snapshot.earlyActorIntelligence.downstream.recommendationImpact
  }, { ranking: "none", risk: "none", telegram: "none", recommendation: "none" });
  const mints = snapshot.tokens.slice(0, 2).map(({ mint }) => mint);
  assert.equal(mints.length, 2);

  const dossier = await json(baseUrl, `/api/coins/${privateToken.mint}`);
  assert.equal(dossier.response.status, 200);
  assert.equal(dossier.body.token.mint, privateToken.mint);
  assert.deepEqual(Object.keys(dossier.body).sort(), ["disclaimer", "earlyActor", "generatedAt", "outcome", "radar", "schemaVersion", "scope", "timeline", "token"]);
  assert.equal(dossier.body.earlyActor, null);
  assertNoRawIdentityKeys(dossier.body, "dossier");
  assert.doesNotMatch(JSON.stringify(dossier.body), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(JSON.stringify(dossier.body).includes(privacyMarker), false);
  assert.equal(dossier.body.token.description, undefined);
  assert.equal(dossier.body.token.unknownNested, undefined);
  assert.equal(dossier.body.token.name, undefined);
  assert.equal(dossier.body.token.symbol, undefined);

  const firstPage = await json(baseUrl, `/api/coins/${privateToken.mint}/timeline?limit=1`);
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.limit, 1);
  assert.equal(firstPage.body.entries.length, 1);
  assert.equal(firstPage.body.rawProviderPayloadsIncluded, false);
  assertNoRawIdentityKeys(firstPage.body, "timeline");
  assert.doesNotMatch(JSON.stringify(firstPage.body), new RegExp([privateToken.creator, rawDeployer, rawCaller].join("|")));
  if (firstPage.body.nextBefore) {
    const secondPage = await json(baseUrl, `/api/coins/${privateToken.mint}/timeline?limit=1&before=${encodeURIComponent(firstPage.body.nextBefore)}`);
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

  const streamed = await nextTokenStreamEvent(baseUrl, { retainedMints: new Set(retainedTokens.map(({ mint }) => mint)) });
  assert.ok(["new-token", "token-update"].includes(streamed.event));
  assertNoRawIdentityKeys(streamed.data, "SSE token event");
  assert.doesNotMatch(JSON.stringify(streamed.data), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(streamed.data.description, undefined);
  assert.equal(streamed.data.signature, undefined);
  assert.equal(streamed.data.unknownNested, undefined);
  assert.equal(streamed.data.name, undefined);
  assert.equal(streamed.data.symbol, undefined);
  assert.equal(streamed.data.narrative, undefined);
});
