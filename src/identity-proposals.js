import { createHash } from "node:crypto";
import { isCanonicalSolanaAddress } from "./early-actors.js";

export const IDENTITY_PROPOSAL_METHOD_VERSION = "metadata-collision-proposals-v1";

function normalizedLabel(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function proposalKey(kind, firstMint, secondMint, basis) {
  return `identity-proposal:${createHash("sha256")
    .update([IDENTITY_PROPOSAL_METHOD_VERSION, kind, firstMint, secondMint, basis].join("\u0000"))
    .digest("hex")}`;
}

function pairwise(groups, kind, basis) {
  const proposals = [];
  for (const entries of groups.values()) {
    const sorted = [...entries].sort((left, right) => left.mint.localeCompare(right.mint));
    for (let left = 0; left < sorted.length; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        const fromMint = sorted[left].mint;
        const toMint = sorted[right].mint;
        proposals.push({
          proposalKey: proposalKey(kind, fromMint, toMint, basis),
          fromMint,
          toMint,
          kind,
          evidenceClass: "locally-derived",
          methodVersion: IDENTITY_PROPOSAL_METHOD_VERSION,
          evidence: { basis, match: "exact-normalized", source: "retained-public-token-metadata" },
          status: "pending"
        });
      }
    }
  }
  return proposals;
}

function group(tokens, keyFor) {
  const groups = new Map();
  for (const token of tokens) {
    const key = keyFor(token);
    if (!key) continue;
    const entries = groups.get(key) || [];
    entries.push(token);
    groups.set(key, entries);
  }
  for (const [key, entries] of groups) if (entries.length < 2) groups.delete(key);
  return groups;
}

export function proposeIdentityCandidates(tokens, { maximumTokens = 100, maximumProposals = 500 } = {}) {
  if (!Array.isArray(tokens)) throw new TypeError("identity proposal tokens must be an array");
  if (!Number.isSafeInteger(maximumTokens) || maximumTokens < 2 || maximumTokens > 500) throw new RangeError("maximumTokens must be between 2 and 500");
  if (!Number.isSafeInteger(maximumProposals) || maximumProposals < 1 || maximumProposals > 2_000) throw new RangeError("maximumProposals must be between 1 and 2000");

  const eligible = tokens.slice(0, maximumTokens).flatMap((token) => {
    if (!token || typeof token !== "object" || !isCanonicalSolanaAddress(token.mint)) return [];
    return [{
      mint: token.mint,
      name: normalizedLabel(token.name, 120),
      symbol: normalizedLabel(token.symbol, 24),
      narrative: normalizedLabel(token.narrative, 120)
    }];
  });

  const nameAndSymbol = group(eligible, (token) => token.name && token.symbol ? `${token.name}\u0000${token.symbol}` : null);
  const narratives = group(eligible, (token) => token.narrative);
  const proposals = [
    ...pairwise(nameAndSymbol, "name-collision", "name-and-symbol"),
    ...pairwise(narratives, "same-narrative", "narrative")
  ];
  const byKey = new Map(proposals.map((proposal) => [proposal.proposalKey, proposal]));
  return [...byKey.values()].sort((left, right) => left.proposalKey.localeCompare(right.proposalKey)).slice(0, maximumProposals);
}
