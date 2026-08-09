import { createHmac } from "node:crypto";
import { createActorLabel } from "./early-actors.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const RAW_IDENTITY_KEYS = new Set(["creator", "deployer", "caller", "traderPublicKey", "actorAddress"]);

function keyMaterial(value) {
  const secret = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!secret || secret.length !== 32) throw new TypeError("installation secret must contain exactly 32 private bytes");
  return secret;
}

function identity(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 256 || CONTROL.test(normalized)) throw new TypeError(`${label} must be bounded identity text`);
  return normalized;
}

export function opaqueActorLabel(value, { installationSecret, namespace = "identity" } = {}) {
  const secret = keyMaterial(installationSecret);
  const normalized = identity(value, "identity");
  const domain = identity(namespace, "identity namespace").toLowerCase();
  const digest = createHmac("sha256", secret)
    .update("pump-war-room/public-actor-v1\0")
    .update(domain)
    .update("\0")
    .update(normalized)
    .digest();
  secret.fill(0);
  const number = (digest.readBigUInt64BE(0) & 0x7fffffffffffffffn) + 1n;
  digest.fill(0);
  return `Actor ${number}`;
}

export function projectPublicToken(token, { installationSecret } = {}) {
  if (!token || typeof token !== "object" || Array.isArray(token)) return token;
  const projected = { ...token };
  if (typeof token.creator === "string" && token.creator.trim()) {
    try { projected.creatorActor = createActorLabel(token.creator, { installationSecret }); }
    catch { delete projected.creatorActor; }
  }
  if (typeof token.deployer === "string" && token.deployer.trim()) {
    try { projected.deployerActor = createActorLabel(token.deployer, { installationSecret }); }
    catch { delete projected.deployerActor; }
  }
  delete projected.creator;
  delete projected.deployer;
  delete projected.smartWallets;
  return projected;
}

export function projectPublicCallout(callout, { installationSecret } = {}) {
  if (!callout || typeof callout !== "object" || Array.isArray(callout)) return callout;
  const projected = { ...callout };
  if (typeof callout.caller === "string" && callout.caller.trim() && callout.caller.trim().toLowerCase() !== "unknown") {
    try { projected.sourceActor = opaqueActorLabel(callout.caller, { installationSecret, namespace: "bark-profile" }); }
    catch { projected.sourceActor = null; }
  } else if (typeof callout.sourceActor !== "string" || !/^Actor [1-9][0-9]{0,19}$/.test(callout.sourceActor)) {
    projected.sourceActor = null;
  }
  if (typeof callout.mint === "string" && callout.mint.trim()) {
    projected.url = `https://pump.fun/coin/${encodeURIComponent(callout.mint.trim())}`;
  } else {
    delete projected.url;
  }
  delete projected.caller;
  delete projected.externalId;
  return projected;
}

export function containsRawIdentityKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRawIdentityKey);
  return Object.entries(value).some(([key, entry]) => RAW_IDENTITY_KEYS.has(key) || containsRawIdentityKey(entry));
}
