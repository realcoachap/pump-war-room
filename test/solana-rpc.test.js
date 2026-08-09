import test from "node:test";
import assert from "node:assert/strict";
import { extractFinalizedActorInputs, SOLANA_MAINNET_RPC, SolanaRpcClient, SolanaRpcError } from "../src/solana-rpc.js";

const MINT = "11111111111111111111111111111111";
const ACTOR = "So11111111111111111111111111111111111111112";
const OTHER = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const SIGNATURE = "3".repeat(64);
const BLOCK_TIME = 1_786_291_200;
const OBSERVED_AT = "2026-08-09T17:00:05.000Z";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("RPC client requests only bounded finalized exact-mint evidence", async () => {
  const requests = [];
  const client = new SolanaRpcClient({
    minimumIntervalMs: 0,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return body.method === "getSignaturesForAddress"
        ? response({ jsonrpc: "2.0", id: body.id, result: [{ signature: SIGNATURE, slot: 9, err: null, blockTime: BLOCK_TIME, confirmationStatus: "finalized" }] })
        : response({ jsonrpc: "2.0", id: body.id, result: null });
    }
  });

  const signatures = await client.signaturesForAddress(MINT, { limit: 3 });
  assert.equal(signatures.length, 1);
  assert.equal(await client.transaction(SIGNATURE), null);
  assert.equal(requests[0].url, SOLANA_MAINNET_RPC.endpoint);
  assert.deepEqual(requests[0].body.params, [MINT, { commitment: "finalized", limit: 3 }]);
  assert.deepEqual(requests[1].body.params, [SIGNATURE, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  assert.equal(JSON.stringify(requests).includes(ACTOR), false);
});

test("RPC client rejects credentials, unsafe bounds, malformed envelopes, and rate limits", async () => {
  assert.throws(() => new SolanaRpcClient({ endpoint: "https://user:secret@example.com/rpc" }), /credential-free/);
  const malformed = new SolanaRpcClient({ minimumIntervalMs: 0, fetchImpl: async () => response({ jsonrpc: "2.0", id: 999, result: [] }) });
  await assert.rejects(() => malformed.signaturesForAddress(MINT), (error) => error instanceof SolanaRpcError && error.code === "invalid-response");
  const limited = new SolanaRpcClient({ minimumIntervalMs: 0, fetchImpl: async () => response({}, { status: 429, headers: { "retry-after": "2" } }) });
  await assert.rejects(() => limited.signaturesForAddress(MINT), (error) => error instanceof SolanaRpcError && error.code === "rate-limited" && error.retryAfterMs === 2_000);
  assert.throws(() => limited.signaturesForAddress("not-a-mint"), /base58/);
  assert.throws(() => limited.signaturesForAddress(MINT, { limit: 33 }), /between 1 and 32/);
});

function transaction({ actorDelta = 250_000_000n, otherDelta = -250_000_000n, signature = SIGNATURE, blockTime = BLOCK_TIME, slot = 9, side = "buy" } = {}) {
  const balance = (owner, amount) => ({ owner, mint: MINT, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return {
    slot,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: ACTOR, signer: true, writable: true },
          { pubkey: OTHER, signer: false, writable: true },
          { pubkey: PUMP_PROGRAM, signer: false, writable: false }
        ],
        header: { numRequiredSignatures: 1 },
        instructions: [{
          programId: PUMP_PROGRAM,
          accounts: [OTHER, OTHER, MINT, OTHER, OTHER, OTHER, ACTOR],
          data: encodeBase58(side === "buy"
            ? [102, 6, 61, 18, 1, 218, 235, 234]
            : [51, 230, 133, 164, 1, 127, 131, 173])
        }]
      }
    },
    meta: {
      err: null,
      preTokenBalances: [balance(ACTOR, 100_000_000n), balance(OTHER, 900_000_000n)],
      postTokenBalances: [balance(ACTOR, 100_000_000n + actorDelta), balance(OTHER, 900_000_000n + otherDelta)]
    }
  };
}

test("extracts only signer-owned finalized buy and sell deltas with internal provenance", () => {
  const signatureInfo = { signature: SIGNATURE, slot: 9, blockTime: BLOCK_TIME, err: null, confirmationStatus: "finalized" };
  const buy = extractFinalizedActorInputs({ mint: MINT, signatureInfo, transaction: transaction(), observedAt: OBSERVED_AT });
  assert.equal(buy.status, "observed");
  assert.equal(buy.observations.length, 1);
  assert.deepEqual(buy.observations[0], {
    mint: MINT,
    actorAddress: ACTOR,
    side: "buy",
    tokenAmount: 250,
    nativeAmount: null,
    source: "solana-mainnet-rpc",
    evidenceClass: "on-chain-finalized",
    sourceTimestamp: new Date(BLOCK_TIME * 1_000).toISOString(),
    observedAt: OBSERVED_AT,
    transactionId: SIGNATURE,
    slot: 9,
    amountBasis: "net-finalized-token-balance-delta-matched-to-official-pump-instruction",
    instructionBasis: [{ programId: PUMP_PROGRAM, instruction: "buy" }],
    nativeAmountStatus: "unavailable-transaction-balance-delta-is-not-trade-consideration"
  });
  const sell = extractFinalizedActorInputs({ mint: MINT, signatureInfo, transaction: transaction({ actorDelta: -50_000_000n, otherDelta: 50_000_000n, side: "sell" }), observedAt: OBSERVED_AT });
  assert.equal(sell.observations[0].side, "sell");
  assert.equal(sell.observations[0].tokenAmount, 50);
});

test("fails closed on malformed, failed, mismatched, or non-attributable transactions", () => {
  const base = { signature: SIGNATURE, slot: 9, blockTime: BLOCK_TIME, err: null, confirmationStatus: "finalized" };
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: { ...base, confirmationStatus: "confirmed" }, transaction: transaction(), observedAt: OBSERVED_AT }).reason, "signature-not-finalized-success");
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: base, transaction: transaction({ signature: "4".repeat(64) }), observedAt: OBSERVED_AT }).reason, "transaction-signature-mismatch");
  const unsigned = transaction();
  unsigned.transaction.message.accountKeys[0].signer = false;
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: base, transaction: unsigned, observedAt: OBSERVED_AT }).reason, "token-balance-evidence-invalid");
  const malformed = transaction();
  malformed.meta.postTokenBalances[0].uiTokenAmount.amount = "Infinity";
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: base, transaction: malformed, observedAt: OBSERVED_AT }).status, "unavailable");
  const transferOnly = transaction();
  transferOnly.transaction.message.instructions = [];
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: base, transaction: transferOnly, observedAt: OBSERVED_AT }).reason, "no-unambiguous-official-pump-buy-or-sell-evidence");
  const contradictory = transaction({ actorDelta: -1n, otherDelta: 1n, side: "buy" });
  assert.equal(extractFinalizedActorInputs({ mint: MINT, signatureInfo: base, transaction: contradictory, observedAt: OBSERVED_AT }).status, "unavailable");
});
