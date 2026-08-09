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

test("public token projection replaces raw wallet identities without mutating private storage", () => {
  const token = { mint: "11111111111111111111111111111111", creator: wallet, deployer: wallet, smartWallets: 9, symbol: "SAFE" };
  const projected = projectPublicToken(token, { installationSecret: secret });
  assert.equal(projected.creator, undefined);
  assert.equal(projected.deployer, undefined);
  assert.equal(projected.smartWallets, undefined);
  assert.equal(projected.creatorActor, projected.deployerActor);
  assert.equal(token.creator, wallet);
  assert.equal(containsRawIdentityKey(projected), false);
  const malformed = projectPublicToken({ mint: token.mint, creator: "not-an-address", deployer: "also-invalid" }, { installationSecret: secret });
  assert.equal(malformed.creator, undefined);
  assert.equal(malformed.deployer, undefined);
  assert.equal(malformed.creatorActor, undefined);
  assert.equal(malformed.deployerActor, undefined);
});

test("public callout projection replaces profile identity and omits internal event IDs", () => {
  const callout = { externalId: "private-event", mint: "11111111111111111111111111111111", caller: "@alpha", source: "bark" };
  const projected = projectPublicCallout(callout, { installationSecret: secret });
  assert.match(projected.sourceActor, /^Actor /);
  assert.equal(projected.caller, undefined);
  assert.equal(projected.externalId, undefined);
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
