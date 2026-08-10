import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_PROPOSAL_METHOD_VERSION, proposeIdentityCandidates } from "../src/identity-proposals.js";

const mintA = "11111111111111111111111111111111";
const mintB = "So11111111111111111111111111111111111111112";
const mintC = "SysvarRent111111111111111111111111111111111";

test("proposes deterministic name collisions and narrative relations without verification", () => {
  const tokens = [
    { mint: mintB, name: "  Same  Meme ", symbol: "SAME", narrative: "AI Agents" },
    { mint: mintA, name: "Same Meme", symbol: "same", narrative: "ai agents" },
    { mint: mintC, name: "Different", symbol: "DIFF", narrative: "AI Agents" }
  ];
  const first = proposeIdentityCandidates(tokens);
  const second = proposeIdentityCandidates([...tokens].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.filter(({ kind }) => kind === "name-collision").length, 1);
  assert.equal(first.filter(({ kind }) => kind === "same-narrative").length, 3);
  for (const proposal of first) {
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.evidenceClass, "locally-derived");
    assert.equal(proposal.methodVersion, IDENTITY_PROPOSAL_METHOD_VERSION);
    assert.equal(JSON.stringify(proposal).includes("Same Meme"), false);
    assert.equal(JSON.stringify(proposal).includes("AI Agents"), false);
  }
});

test("does not propose from symbol-only matches or invalid mints", () => {
  assert.deepEqual(proposeIdentityCandidates([
    { mint: mintA, symbol: "SAME" },
    { mint: mintB, symbol: "same" },
    { mint: "bad", name: "Same", symbol: "SAME" }
  ]), []);
});

test("ignores regex-shaped values that are not canonical 32-byte Solana addresses", () => {
  assert.deepEqual(proposeIdentityCandidates([
    { mint: "22222222222222222222222222222222", name: "Same", symbol: "SAME" },
    { mint: mintA, name: "Same", symbol: "SAME" }
  ]), []);
});

test("bounds token and proposal inputs", () => {
  assert.throws(() => proposeIdentityCandidates({}, {}), /must be an array/);
  assert.throws(() => proposeIdentityCandidates([], { maximumTokens: 1 }), /maximumTokens/);
  assert.throws(() => proposeIdentityCandidates([], { maximumProposals: 0 }), /maximumProposals/);
});
