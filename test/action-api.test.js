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
const actorFixtureMint = "11111111111111111111111111111111";
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

async function startDemoServer(t, { setup = null } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-action-api-"));
  const port = await availablePort();
  const dbPath = path.join(directory, "war-room.db");
  if (setup) {
    const bootstrapStore = new Store(dbPath);
    try { await setup(bootstrapStore); }
    finally { bootstrapStore.db.close(); }
  }
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

function generatedMint(index) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index + 1, 28);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
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

async function rawHostRequest(baseUrl, pathname, host) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: "GET",
      headers: { host }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("action intelligence API enforces strict methods, bounds, and public contracts", async (t) => {
  const { baseUrl, dbPath } = await startDemoServer(t);
  const privateStore = new Store(dbPath);
  const retainedTokens = privateStore.tokens(50);
  const privateToken = retainedTokens[0];
  const relatedToken = retainedTokens[1];
  const proposedToken = retainedTokens[2];
  assert.ok(privateToken?.creator, "demo fixture must retain a private creator for projection coverage");
  assert.ok(relatedToken?.mint, "demo fixture must retain a second mint for entity coverage");
  const reviewedAt = new Date().toISOString();
  privateStore.saveIdentityEntity({
    entity: {
      entityId: "action-api-reviewed-entity",
      displayName: `x:@private_profile xx${rawDeployer}`,
      symbol: "ARE",
      reviewState: "verified",
      primaryMint: privateToken.mint,
      variants: [
        { mint: privateToken.mint, kind: "official", reviewState: "verified", evidenceClass: "on-chain-finalized", observedAt: reviewedAt },
        { mint: relatedToken.mint, kind: "relaunch", reviewState: "verified", evidenceClass: "provider-observed", observedAt: reviewedAt }
      ]
    },
    decision: {
      decisionId: "decision:action-api-reviewed-entity",
      subjectType: "entity",
      subjectId: "action-api-reviewed-entity",
      decision: "accept",
      reasonCode: "operator-reviewed-evidence",
      decidedAt: reviewedAt
    }
  });
  privateStore.db.prepare(`INSERT INTO identity_entities
    (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run("action-api-proposed-entity", "Action API Proposed Entity", "APE", "proposed", proposedToken.mint, reviewedAt, reviewedAt);
  privateStore.db.prepare(`INSERT INTO identity_variants
    (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(proposedToken.mint, "action-api-proposed-entity", "official", "verified", "locally-derived", reviewedAt, reviewedAt, reviewedAt);
  privateStore.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id) VALUES (?,?,?,?,?,?,?,NULL)`)
    .run("decision:action-api-proposed-entity", "entity", "action-api-proposed-entity", "supersede", "awaiting-verified-evidence", "{}", reviewedAt);
  privateStore.db.prepare(`INSERT INTO identity_relationships
    (relationship_id,from_mint,to_mint,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("action-api-inactive-parent-edge", privateToken.mint, proposedToken.mint, "same-narrative", "verified", "locally-derived", reviewedAt, reviewedAt, reviewedAt);
  privateStore.db.prepare(`INSERT INTO identity_decisions
    (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id) VALUES (?,?,?,?,?,?,?,NULL)`)
    .run("decision:action-api-inactive-parent-edge", "relationship", "action-api-inactive-parent-edge", "supersede", "awaiting-verified-parent", "{}", reviewedAt);
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
      narrative: token.mint === relatedToken.mint ? "__proto__" : `Narrative ${rawDeployer}`
    });
  }
  privateStore.admitActorMint({
    mint: actorFixtureMint,
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

  const { response: snapshotResponse, body: snapshot } = await json(baseUrl, "/api/snapshot", {
    headers: { "accept-encoding": "gzip" }
  });
  assert.equal(snapshotResponse.headers.get("content-encoding"), "gzip");
  assert.equal(snapshotResponse.headers.get("vary"), "Accept-Encoding");
  assert.equal(snapshotResponse.headers.get("x-ratelimit-limit"), "120");
  assert.match(snapshotResponse.headers.get("x-ratelimit-remaining"), /^\d+$/);
  assert.ok(Number(snapshotResponse.headers.get("content-length")) < Buffer.byteLength(JSON.stringify(snapshot)) / 4);
  assert.equal(snapshot.version, expectedVersion);
  assert.deepEqual(snapshot.publicDelivery, {
    schemaVersion: 1,
    snapshotEncoding: "gzip-when-accepted",
    browserRefresh: "coalesced-with-15-second-post-completion-cooldown",
    vaultExports: "disabled"
  });
  assert.equal(snapshot.readinessScope.statusBasis, "simulated-feed-state");
  assert.equal(snapshot.readinessScope.mountEvidenceRequired, false);
  assert.equal(snapshot.readinessScope.calibrationIncluded, false);
  assert.equal(snapshot.readinessScope.backupRecoveryIncluded, false);
  assert.equal(snapshot.tokenIntegrity.quarantinedCount, 0);
  assert.equal(snapshot.tokenIntegrity.complete, true);
  assert.equal(snapshot.apiLimits.snapshot.limit, 120);
  assert.ok(snapshot.apiLimits.snapshot.requests >= 1);
  assert.equal(snapshot.entityIntelligence.registryProjection.truncated, false);
  assert.deepEqual(snapshot.entityIntelligence.registryProjection.integrityOmittedCounts, { entities: 0, variants: 0, relationships: 0 });
  assertNoRawIdentityKeys(snapshot, "snapshot");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(JSON.stringify(snapshot).includes(privacyMarker), false);
  assert.equal(JSON.stringify(snapshot).includes("privacy_contract"), false);
  assert.ok(snapshot.narratives.some(({ name, coins }) => name === "__proto__" && coins >= 1));
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
  const actorCohortToken = snapshot.earlyActorIntelligence.cohort.observations.find(({ mint }) => mint === actorFixtureMint);
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
  assert.equal(snapshot.earlyActorIntelligence.engine.cohort.admittedCount, 1);
  assert.equal(snapshot.earlyActorIntelligence.engine.cohort.pendingAttemptCount, 1);
  assert.equal(snapshot.earlyActorIntelligence.engine.cohort.statusCounts.queued, 1);
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
  assert.equal(snapshot.entityIntelligence.methodVersion, "reviewed-entity-intelligence-v1");
  assert.equal(snapshot.entityIntelligence.rankingBoundary.unreviewedProposalImpact, "none");
  assert.equal(snapshot.entityIntelligence.rankingBoundary.rankingImpact, "none");
  const reviewedEntity = snapshot.entityIntelligence.entities.find(({ entityId }) => entityId === "action-api-reviewed-entity");
  assert.equal(reviewedEntity.variants.registeredMintCount, 2);
  assert.equal(reviewedEntity.variants.observedMintCount, 2);
  assert.equal(reviewedEntity.trend.contributingMint, privateToken.mint);
  assert.equal(reviewedEntity.trend.selectionReason, "explicit-reviewed-primary");
  assert.equal(reviewedEntity.trend.summedAcrossVariants, false);
  assert.equal(reviewedEntity.volume.availableMintCount + reviewedEntity.volume.missingMintCount, reviewedEntity.variants.registeredMintCount);
  assert.ok(reviewedEntity.variants.included.every(({ registryObservedAt, tokenObservedAt }) => registryObservedAt === reviewedAt && typeof tokenObservedAt === "string"));
  assert.equal(snapshot.entityIntelligence.entities.some(({ entityId }) => entityId === "action-api-proposed-entity"), false);
  assert.ok(snapshot.entityIntelligence.entities.some(({ entityId }) => entityId === `~mint:${proposedToken.mint}`));
  assertNoRawIdentityKeys(snapshot.entityIntelligence, "entity intelligence");
  const { body: health } = await json(baseUrl, "/api/health");
  assert.deepEqual(health.publicDelivery, snapshot.publicDelivery);
  assert.deepEqual(health.readinessScope, snapshot.readinessScope);
  assert.equal(health.earlyActors.status, "simulation-disabled");
  assert.equal(health.identityRegistry.entityCount, 2);
  assert.equal(health.identityRegistry.variantCount, 3);
  assert.equal(health.identityRegistry.relationshipCount, 1);
  assert.equal(health.identityRegistry.verifiedEntityCount, 1);
  assert.equal(health.identityRegistry.verifiedVariantCount, 2);
  assert.equal(health.identityRegistry.verifiedRelationshipCount, 0);
  assert.equal(health.earlyActors.cohort.admittedCount, 1);
  assert.equal(health.earlyActors.cohort.pendingAttemptCount, 1);
  const mints = snapshot.tokens.slice(0, 2).map(({ mint }) => mint);
  assert.equal(mints.length, 2);

  const dossier = await json(baseUrl, `/api/coins/${privateToken.mint}`);
  assert.equal(dossier.response.status, 200);
  assert.equal(dossier.body.token.mint, privateToken.mint);
  assert.deepEqual(Object.keys(dossier.body).sort(), ["disclaimer", "earlyActor", "generatedAt", "identity", "outcome", "radar", "schemaVersion", "scope", "timeline", "token"]);
  assert.equal(dossier.body.earlyActor, null);
  assert.equal(dossier.body.identity.resolvedBy, "reviewed-registry-variant");
  assert.equal(dossier.body.identity.mint, privateToken.mint);
  assert.equal(dossier.body.identity.primary.mint, privateToken.mint);
  assert.equal(dossier.body.identity.relationships.length, 0);
  assertNoRawIdentityKeys(dossier.body, "dossier");
  assert.doesNotMatch(JSON.stringify(dossier.body), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(JSON.stringify(dossier.body).includes(privacyMarker), false);
  assert.equal(dossier.body.token.description, undefined);
  assert.equal(dossier.body.token.unknownNested, undefined);
  assert.equal(dossier.body.token.name, undefined);
  assert.equal(dossier.body.token.symbol, undefined);

  const identity = await json(baseUrl, `/api/v1/entities/resolve?mint=${privateToken.mint}`);
  assert.equal(identity.response.status, 200);
  assert.equal(identity.response.headers.get("x-ratelimit-limit"), "120");
  assert.match(identity.response.headers.get("x-ratelimit-remaining"), /^\d+$/);
  assert.match(identity.response.headers.get("x-ratelimit-reset"), /^\d+$/);
  assert.equal(identity.body.resolvedBy, "reviewed-registry-variant");
  assert.equal(identity.body.entity.entityId, "action-api-reviewed-entity");
  assert.equal(identity.body.entity.displayName, "Unnamed reviewed entity");
  assert.equal(JSON.stringify(identity.body).includes(rawDeployer), false);
  assert.equal(JSON.stringify(identity.body).includes("private_profile"), false);
  assert.equal(identity.body.primary.selectionReason, "explicit-reviewed-primary");
  assert.deepEqual(identity.body.relationshipCoverage, {
    eligibleCount: 0, publishableEligibleCount: 0, includedCount: 0, limitOmittedCount: 0,
    projectionOmittedCount: 0, integrityOmittedCount: 0, truncated: false, limit: 100
  });
  assert.deepEqual(identity.body.proposalCoverage, { eligibleCount: 0, includedCount: 0, omittedInvalidCount: 0 });
  assertNoRawIdentityKeys(identity.body, "canonical identity");
  const proposedIdentity = await json(baseUrl, `/api/v1/entities/resolve?mint=${proposedToken.mint}`);
  assert.equal(proposedIdentity.response.status, 200);
  assert.equal(proposedIdentity.body.resolvedBy, "singleton-exact-mint");
  assert.equal(proposedIdentity.body.entity.entityId, `~mint:${proposedToken.mint}`);
  assert.equal(proposedIdentity.body.entity.reviewState, "singleton-unreviewed");
  assert.equal(proposedIdentity.body.variant.reviewState, "unreviewed");
  assert.deepEqual(proposedIdentity.body.relationshipCoverage, {
    eligibleCount: 0, publishableEligibleCount: 0, includedCount: 0, limitOmittedCount: 0,
    projectionOmittedCount: 0, integrityOmittedCount: 0, truncated: false, limit: 100
  });
  assert.deepEqual(proposedIdentity.body.proposalCoverage, { eligibleCount: 0, includedCount: 0, omittedInvalidCount: 0 });

  const entityPage = await json(baseUrl, "/api/v1/entities?limit=1");
  assert.equal(entityPage.response.status, 200);
  assert.equal(entityPage.response.headers.get("x-ratelimit-limit"), "120");
  assert.equal(entityPage.body.methodVersion, "reviewed-entity-intelligence-v1");
  assert.equal(entityPage.body.page.order, "entity-id-ascending");
  assert.equal(entityPage.body.page.limit, 1);
  assert.equal(entityPage.body.page.count, 1);
  assert.match(entityPage.body.page.nextCursor, /^[A-Za-z0-9_-]+$/);
  const secondEntityPage = await json(baseUrl, `/api/v1/entities?limit=1&cursor=${encodeURIComponent(entityPage.body.page.nextCursor)}`);
  assert.equal(secondEntityPage.response.status, 200);
  assert.notEqual(secondEntityPage.body.entities[0].entityId, entityPage.body.entities[0].entityId);
  assertNoRawIdentityKeys(entityPage.body, "entity page");

  const openapi = await json(baseUrl, "/api/v1/openapi.json");
  assert.equal(openapi.response.status, 200);
  assert.equal(openapi.body.openapi, "3.1.0");
  assert.equal(openapi.body.info.version, expectedVersion);
  assert.equal(openapi.body.security.length, 0);
  assert.equal(openapi.body.components.securitySchemes, undefined);

  const firstPage = await json(baseUrl, `/api/coins/${privateToken.mint}/timeline?limit=1`);
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.limit, 1);
  assert.equal(firstPage.body.entries.length, 1);
  assert.equal(firstPage.body.rawProviderPayloadsIncluded, false);
  assertNoRawIdentityKeys(firstPage.body, "timeline");
  assert.doesNotMatch(JSON.stringify(firstPage.body), new RegExp([privateToken.creator, rawDeployer, rawCaller].join("|")));
  const defaultPage = await json(baseUrl, `/api/coins/${privateToken.mint}/timeline`);
  assert.equal(defaultPage.response.status, 200);
  assert.equal(defaultPage.body.limit, 50);
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
    "/api/compare?mints=bad,also-bad",
    "/api/v1/entities?limit=0",
    "/api/v1/entities?limit=101",
    "/api/v1/entities?cursor=invalid",
    "/api/v1/entities?unknown=1",
    "/api/v1/entities/resolve",
    "/api/v1/entities/resolve?mint=bad",
    `/api/v1/entities/resolve?mint=${"z".repeat(44)}`,
    `/api/coins/${"z".repeat(44)}`,
    `/api/coins/${"z".repeat(44)}/timeline`,
    `/api/v1/entities/resolve?mint=${mints[0]}&extra=1`
  ]) {
    assert.equal((await fetch(`${baseUrl}${pathname}`)).status, 400, pathname);
  }
  assert.equal((await fetch(`${baseUrl}/api/coins/${mints[0]}//timeline`)).status, 404);
  for (const pathname of [
    "/api/health", "/api/snapshot", `/api/coins/${mints[0]}`, `/api/coins/${mints[0]}/timeline`,
    `/api/compare?mints=${mints.join(",")}`, "/api/v1/entities", `/api/v1/entities/resolve?mint=${mints[0]}`,
    "/api/v1/openapi.json", "/api/briefs/daily"
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, { method: "POST" });
    assert.equal(response.status, 405, pathname);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal((await fetch(`${baseUrl}/api/export/weekly`)).status, 405);
  assert.equal(await rawHostRequest(baseUrl, "/api/health", "["), 200);
  assert.equal(await rawHostRequest(baseUrl, "/api/health", "bad host"), 200);

  const { body: healthAfterIdentityReads } = await json(baseUrl, "/api/health");
  assert.equal(healthAfterIdentityReads.identityRegistry.api.externalApiKeys, "not-offered");
  const identityLimiter = healthAfterIdentityReads.identityRegistry.api.limiter;
  assert.equal(identityLimiter.scope, "process-global-per-instance");
  assert.equal(identityLimiter.list.policy, "process-local-fixed-window-v1");
  assert.equal(identityLimiter.resolver.policy, "process-local-fixed-window-v1");
  assert.ok(identityLimiter.list.requests >= 2);
  assert.ok(identityLimiter.resolver.requests >= 2);
  assert.equal(identityLimiter.list.rejected + identityLimiter.resolver.rejected, 0);
  assert.equal(healthAfterIdentityReads.telemetry.responses5xx, 0);

  const streamed = await nextTokenStreamEvent(baseUrl, { retainedMints: new Set(retainedTokens.map(({ mint }) => mint)) });
  assert.ok(["new-token", "token-update"].includes(streamed.event));
  assertNoRawIdentityKeys(streamed.data, "SSE token event");
  assert.doesNotMatch(JSON.stringify(streamed.data), new RegExp([privateToken.creator, rawDeployer, rawCaller, rawSignature].join("|")));
  assert.equal(streamed.data.description, undefined);
  assert.equal(streamed.data.signature, undefined);
  assert.equal(streamed.data.unknownNested, undefined);
  assert.equal(streamed.data.name, undefined);
  assert.equal(streamed.data.symbol, undefined);
  assert.equal(streamed.data.narrative, streamed.data.mint === relatedToken.mint ? "__proto__" : undefined);
});

test("legacy malformed token rows and over-cap reviewed entities cannot brick or falsify public resolution", async (t) => {
  const primaryMint = "11111111111111111111111111111111";
  const invalidPrimaryVariantMint = generatedMint(39_999);
  const { baseUrl } = await startDemoServer(t, { setup(store) {
    const createdAt = "2026-08-10T12:00:00.000Z";
    store.upsertToken({ mint: primaryMint, source: "demo", name: "Legacy reviewed", symbol: "LEG", createdAt });
    store.upsertToken({ mint: invalidPrimaryVariantMint, source: "demo", name: "Legacy invalid primary", symbol: "LIP", createdAt });
    const insertToken = store.db.prepare("INSERT INTO tokens (mint,payload,created_at,updated_at) VALUES (?,?,?,?)");
    insertToken.run("legacy-invalid-key-a", JSON.stringify({ mint: primaryMint, source: "demo", createdAt }), createdAt, createdAt);
    insertToken.run("legacy-invalid-key-b", JSON.stringify({ mint: primaryMint, source: "demo", createdAt }), createdAt, createdAt);
    store.db.prepare(`INSERT INTO identity_entities
      (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("legacy-over-cap-entity", "Legacy over cap entity", "LEG", "verified", primaryMint, createdAt, createdAt);
    const insertVariant = store.db.prepare(`INSERT INTO identity_variants
      (mint,entity_id,kind,review_state,evidence_class,observed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
    const mints = [primaryMint, ...Array.from({ length: 100 }, (_, index) => generatedMint(index + 40_000))];
    for (const [index, mint] of mints.entries()) {
      insertVariant.run(mint, "legacy-over-cap-entity", index === 0 ? "official" : "relaunch", "verified",
        index === 0 ? "on-chain-finalized" : "provider-observed", createdAt, createdAt, createdAt);
    }
    store.db.prepare(`INSERT INTO identity_decisions
      (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
      VALUES (?,?,?,?,?,?,?,NULL)`).run("decision:legacy-over-cap-entity", "entity", "legacy-over-cap-entity",
      "accept", "legacy-reviewed-import", "{}", createdAt);
    store.db.prepare(`INSERT INTO identity_proposals
      (proposal_key,from_mint,to_mint,kind,evidence_class,method_version,evidence,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("legacy-invalid-proposal", primaryMint, mints[1], "same-narrative",
      "locally-derived", "x:@private_profile", "{}", "pending", createdAt, createdAt);
    store.db.prepare(`INSERT INTO identity_entities
      (entity_id,display_name,symbol,review_state,primary_mint,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run("legacy-invalid-primary", "Legacy invalid primary", "LIP", "verified", "z".repeat(44), createdAt, createdAt);
    insertVariant.run(invalidPrimaryVariantMint, "legacy-invalid-primary", "official", "verified",
      "on-chain-finalized", createdAt, createdAt, createdAt);
    store.db.prepare(`INSERT INTO identity_decisions
      (decision_id,subject_type,subject_id,decision,reason_code,evidence,decided_at,supersedes_decision_id)
      VALUES (?,?,?,?,?,?,?,NULL)`).run("decision:legacy-invalid-primary", "entity", "legacy-invalid-primary",
      "accept", "legacy-reviewed-import", "{}", createdAt);
  } });
  const snapshot = await json(baseUrl, "/api/snapshot");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.body.tokenIntegrity.quarantinedCount, 2);
  assert.equal(snapshot.body.tokens.filter(({ mint }) => mint === primaryMint).length, 1);
  assert.equal(snapshot.body.entityIntelligence.entities.some(({ entityId }) => entityId === `~mint:${primaryMint}`), false);
  assert.equal(snapshot.body.entityIntelligence.projectionOmittedReviewed
    .find(({ mint }) => mint === primaryMint).reason, "legacy-entity-variant-cap-exceeded");
  assert.equal(snapshot.body.entityIntelligence.projectionOmittedReviewed
    .find(({ mint }) => mint === invalidPrimaryVariantMint).reason, "legacy-invalid-primary");
  const resolution = await json(baseUrl, `/api/v1/entities/resolve?mint=${primaryMint}`);
  assert.equal(resolution.response.status, 200);
  assert.equal(resolution.body.resolvedBy, "reviewed-registry-capacity-omitted");
  assert.equal(resolution.body.entity.entityId, "legacy-over-cap-entity");
  assert.equal(resolution.body.variant.kind, "official");
  assert.equal(resolution.body.variant.evidenceClass, "on-chain-finalized");
  assert.equal(resolution.body.primary.mint, primaryMint);
  assert.equal(resolution.body.primary.selectionReason, "explicit-reviewed-primary");
  assert.deepEqual(resolution.body.proposalCoverage, { eligibleCount: 1, includedCount: 0, omittedInvalidCount: 1 });
  assert.equal(JSON.stringify(resolution.body).includes("private_profile"), false);
  const invalidPrimaryResolution = await json(baseUrl, `/api/v1/entities/resolve?mint=${invalidPrimaryVariantMint}`);
  assert.equal(invalidPrimaryResolution.response.status, 200);
  assert.equal(invalidPrimaryResolution.body.resolvedBy, "reviewed-registry-integrity-omitted");
  assert.equal(invalidPrimaryResolution.body.entity.entityId, "legacy-invalid-primary");
  assert.equal(invalidPrimaryResolution.body.variant.mint, invalidPrimaryVariantMint);
  assert.equal(invalidPrimaryResolution.body.primary.mint, null);
  assert.equal(invalidPrimaryResolution.body.primary.selectionReason, "withheld-ambiguous");
  assert.equal(JSON.stringify(invalidPrimaryResolution.body).includes("z".repeat(44)), false);
  assert.equal((await fetch(`${baseUrl}/api/v1/entities?limit=20`)).status, 200);
});
