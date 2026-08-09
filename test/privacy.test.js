import test from "node:test";
import assert from "node:assert/strict";
import { containsRawIdentityKey, opaqueActorLabel, projectPublicCallout, projectPublicToken } from "../src/privacy.js";
import { Store } from "../src/store.js";

const secret = Buffer.alloc(32, 7);
const otherSecret = Buffer.alloc(32, 8);
const wallet = "So11111111111111111111111111111111111111112";

test("installation-scoped actor labels are stable, opaque, and namespace-separated", () => {
  const first = opaqueActorLabel(wallet, { installationSecret: secret, namespace: "wallet" });
  assert.equal(first, opaqueActorLabel(wallet, { installationSecret: secret, namespace: "wallet" }));
  assert.match(first, /^Actor [1-9][0-9]{0,19}$/);
  assert.equal(first.includes(wallet), false);
  assert.notEqual(first, opaqueActorLabel(wallet, { installationSecret: otherSecret, namespace: "wallet" }));
  assert.notEqual(first, opaqueActorLabel(wallet, { installationSecret: secret, namespace: "profile" }));
});

test("public token projection uses a strict nested allowlist and freshly derived actor labels", () => {
  const token = {
    ingestSchemaVersion: 2,
    mint: "11111111111111111111111111111111",
    creator: wallet,
    deployer: wallet,
    creatorActor: "Actor 1",
    deployerActor: "Actor 2",
    smartWallets: 9,
    name: "Contact https://x.com/private_profile",
    symbol: wallet,
    description: `Contact https://x.com/private_profile or ${wallet}`,
    signature: "3".repeat(64),
    unknownNested: { walletAddress: wallet, profileUrl: "https://x.com/private_profile" },
    marketCapEvidence: {
      evidenceClass: "locally-derived",
      basis: "feed-market-cap-sol-times-operator-sol-usd",
      solUsd: 150,
      raw: { signer: wallet }
    },
    migrationEvidence: {
      evidenceClass: "feed-observed-processed",
      source: "pumpportal",
      observedAt: "2026-08-09T12:00:00.000Z",
      pool: "pump",
      limitation: "Processed observation.",
      wallet: wallet
    },
    riskIdentity: {
      schemaVersion: 1,
      methodVersion: "risk-identity-exact-match-v1",
      overallEvidence: "locally-derived",
      rankingImpact: "none-uncalibrated",
      factors: {
        concentration: {
          evidenceClass: "provider-observed",
          holderCount: 42,
          sourceFields: ["data.attributes.holders.count"],
          raw: { ownerAddress: wallet }
        },
        identity: {
          evidenceClass: "locally-derived",
          exactDuplicateCount: 1,
          exactDuplicateCounts: { xHandle: 1, nameSymbol: 0, wallet: wallet },
          profileUrl: "https://x.com/private_profile"
        }
      },
      duplicateEvidence: {
        exactDeclaredIdentifierReuse: { value: true, evidenceClass: "locally-derived", signer: wallet }
      },
      providerObservation: {
        sourceStatus: "available",
        missingReasonCode: null,
        lastAttemptAt: "2026-08-09T12:00:00.000Z",
        nextAttemptAt: null,
        account: wallet
      },
      missing: ["developer"],
      profile: "@private_profile"
    }
  };
  const projected = projectPublicToken(token, { installationSecret: secret });
  assert.equal(projected.creator, undefined);
  assert.equal(projected.deployer, undefined);
  assert.equal(projected.smartWallets, undefined);
  assert.equal(projected.name, undefined);
  assert.equal(projected.symbol, undefined);
  assert.equal(projected.description, undefined);
  assert.equal(projected.signature, undefined);
  assert.equal(projected.unknownNested, undefined);
  assert.equal(projected.creatorActor, projected.deployerActor);
  assert.notEqual(projected.creatorActor, "Actor 1");
  assert.notEqual(projected.deployerActor, "Actor 2");
  assert.deepEqual(projected.marketCapEvidence, {
    evidenceClass: "locally-derived",
    basis: "feed-market-cap-sol-times-operator-sol-usd",
    solUsd: 150
  });
  assert.deepEqual(projected.migrationEvidence, {
    evidenceClass: "feed-observed-processed",
    source: "pumpportal",
    observedAt: "2026-08-09T12:00:00.000Z",
    pool: "pump",
    limitation: "Processed observation."
  });
  assert.deepEqual(projected.riskIdentity.factors.concentration, {
    evidenceClass: "provider-observed",
    holderCount: 42,
    sourceFields: ["data.attributes.holders.count"]
  });
  assert.deepEqual(projected.riskIdentity.factors.identity.exactDuplicateCounts, { xHandle: 1, nameSymbol: 0 });
  assert.deepEqual(projected.riskIdentity.duplicateEvidence.exactDeclaredIdentifierReuse, {
    value: true,
    evidenceClass: "locally-derived"
  });
  assert.equal(projected.riskIdentity.profile, undefined);
  assert.equal(projected.riskIdentity.providerObservation.account, undefined);
  assert.equal(token.creator, wallet);
  assert.equal(token.description.includes(wallet), true);
  projected.riskIdentity.missing.push("liquidity");
  assert.deepEqual(token.riskIdentity.missing, ["developer"]);
  assert.equal(containsRawIdentityKey(projected), false);
  assert.doesNotMatch(JSON.stringify(projected), /private_profile|walletAddress|ownerAddress/);
  const malformed = projectPublicToken({
    mint: token.mint,
    creator: "not-an-address",
    deployer: "also-invalid",
    creatorActor: "Actor 1",
    deployerActor: "Actor 2"
  }, { installationSecret: secret });
  assert.equal(malformed.creator, undefined);
  assert.equal(malformed.deployer, undefined);
  assert.equal(malformed.creatorActor, undefined);
  assert.equal(malformed.deployerActor, undefined);
  assert.equal(projectPublicToken([{ creator: wallet }], { installationSecret: secret }), null);
  assert.equal(projectPublicToken(Object.assign(new Date(), { creator: wallet }), { installationSecret: secret }), null);
});

test("public callout projection replaces profile identity and omits internal event IDs", () => {
  const callout = {
    externalId: "private-event", mint: "11111111111111111111111111111111", caller: "@alpha", source: "bark",
    name: "Contact https://x.com/raw_profile", walletAddress: wallet,
    unknownNested: { transactionId: "3".repeat(64), profile: "@raw_profile" }
  };
  const projected = projectPublicCallout(callout, { installationSecret: secret });
  assert.match(projected.sourceActor, /^Actor /);
  assert.equal(projected.caller, undefined);
  assert.equal(projected.externalId, undefined);
  assert.equal(projected.name, undefined);
  assert.equal(projected.walletAddress, undefined);
  assert.equal(projected.unknownNested, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /raw_profile|walletAddress|transactionId/);
  assert.equal(JSON.stringify(projected).includes("alpha"), false);
  assert.equal(callout.caller, "@alpha");
  assert.equal(projectPublicCallout({ mint: callout.mint, caller: "x".repeat(300) }, { installationSecret: secret }).sourceActor, null);
});

test("legacy callout cleanup removes raw profiles from persisted callout and event payloads", () => {
  const store = new Store(":memory:");
  const callout = {
    externalId: "legacy-event",
    mint: "11111111111111111111111111111111",
    caller: "@legacy-profile",
    url: "https://example.invalid/profile/legacy-profile",
    createdAt: "2026-08-09T12:00:00.000Z"
  };
  store.upsertCallout(callout);
  store.addEvent("callout", callout);
  const cleanup = store.sanitizeLegacyCalloutProfiles((value) => projectPublicCallout(value, { installationSecret: secret }));
  assert.deepEqual(cleanup, { callouts: 1, events: 1 });
  const serialized = JSON.stringify({ callouts: store.callouts(), events: store.eventsForMint(callout.mint) });
  assert.doesNotMatch(serialized, /legacy-profile|example\.invalid|caller|externalId/);
  assert.match(serialized, /Actor [1-9][0-9]*/);
  assert.match(serialized, /https:\/\/pump\.fun\/coin\/11111111111111111111111111111111/);
  store.db.close();
});
