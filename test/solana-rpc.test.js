import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFinalizedActorInputs,
  SOLANA_ACTOR_PARSER_REVISION,
  SOLANA_MAINNET_RPC,
  SolanaRpcClient,
  SolanaRpcError
} from "../src/solana-rpc.js";

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

const key = (byte) => encodeBase58(Buffer.alloc(32, byte));
const MINT = key(1);
const ACTOR = key(2);
const OTHER = key(3);
const SECOND_USER_TOKEN = key(5);
const QUOTE_MINT = key(7);
const ABSENT_ACCOUNT = key(9);
const SIGNATURE = encodeBase58(Buffer.alloc(64, 10));
const OTHER_SIGNATURE = encodeBase58(Buffer.alloc(64, 11));
const BLOCK_TIME = 1_786_291_200;
const OBSERVED_AT = "2026-08-09T17:00:05.000Z";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEE_RECIPIENT = "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV";
const PUMP_ONLY_FEE_RECIPIENT = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";
const SWAP_ONLY_FEE_RECIPIENT = "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU";
const RESERVED_FEE_RECIPIENT = "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS";
const BUYBACK_FEE_RECIPIENT = "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD";
const PUMP_GLOBAL = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf";
const PUMP_BONDING_CURVE = "3KbZjpZ3okKkZjb46JDyix1GH1rKFqxb459cS67dpDhk";
const PUMP_ASSOCIATED_BONDING = "FWRW3ixTg7GvK5zE7eqC4wiMwCb4ZntnHnMyZByWSVpP";
const USER_TOKEN = "9SBAq6YVfq1ECthq7yBBLdGDoWnhwgDd7kSJ7eZREFDc";
const PUMP_CREATOR_VAULT = key(30);
const PUMP_EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
const PUMP_GLOBAL_VOLUME = "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y";
const PUMP_USER_VOLUME = "3EDC9QyxQ1edwGPimrBSGKBK2PXR3ewRxCxPXC2hyVi5";
const PUMP_FEE_CONFIG = "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt";
const PUMP_BONDING_V2 = "SndBXYGbK3iCATNdnTnZLuFimJCttV8nqtzNLK7ZyCs";
const SWAP_POOL = "2MNus2KCpxwXnp19iyXNpWSFtBD2UGjQBAL8AbtywfT9";
const SWAP_GLOBAL_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw";
const SWAP_USER_QUOTE = "DzBVNFnwkcA4MnjVx1DwjdjWuwqbFbLqdk1PjoeqaVYi";
const SWAP_POOL_BASE = "GJrovFM9YjRKTtQD4ixa156y1QJsCAx6oMfnV9Y2WbXS";
const SWAP_POOL_QUOTE = "BQchi8ikmWq1WrvtZBu2i7diEKV99wUsf9J2WRUrWZgW";
const SWAP_PROTOCOL_RECIPIENT = SWAP_ONLY_FEE_RECIPIENT;
const SWAP_PROTOCOL_ATA = "6dNzkgAfcd9unPAVvNRdWExcTQXyNEzbfGKSvnBTdCJg";
const PUMP_ONLY_SWAP_ATA = "GJvmQ79FNyvxfYstBabCfcZjuharrxwL6Qr24TyaMJpd";
const RESERVED_SWAP_ATA = "4t5T7g1uR1yd4DaDbAmBbTPjJhJCRNnEjLfg4RnfWpcp";
const SWAP_EVENT_AUTHORITY = "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR";
const SWAP_CREATOR_AUTHORITY = "2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z";
const SWAP_CREATOR_ATA = "AnkjATkxYnNjjE2xNECwfFbS8dCfcX3GgrVMAWaFQmiq";
const SWAP_GLOBAL_VOLUME = "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw";
const SWAP_USER_VOLUME = "HJPZuGB3AUXJPqFJt7b2Y9quuzgPjiid7bF8sHkugqz3";
const SWAP_FEE_CONFIG = "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx";
const SWAP_POOL_V2 = "DF9p16NDwPiMS47EgNV5oLkgHwEZCiYdPw4P9HAM85LH";
const SWAP_USER_VOLUME_ATA = "Gm6gNQsbDUgwLvAhL1b9NWxRDWQMpigKeCNDqEWuoxp3";
const SWAP_BUYBACK_ATA = "H7hMRrjP6a8Xwu1VyC4Aw8d9MafJC8K4eAT1FA2uFJvy";

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
  assert.equal(SOLANA_ACTOR_PARSER_REVISION, "official-pump-current-fee-layout-v4");
  assert.equal(SOLANA_MAINNET_RPC.parserRevision, SOLANA_ACTOR_PARSER_REVISION);
});

test("RPC client restricts the endpoint and canonical Solana encodings", async () => {
  assert.throws(() => new SolanaRpcClient({ endpoint: "https://user:secret@api.mainnet.solana.com" }), /credential-free/);
  assert.throws(() => new SolanaRpcClient({ endpoint: "https://example.com" }), /public Solana mainnet origin/);
  assert.throws(() => new SolanaRpcClient({ endpoint: "https://api.mainnet.solana.com/rpc" }), /root path/);
  assert.throws(() => new SolanaRpcClient({ endpoint: "https://api.mainnet.solana.com?key=secret" }), /query/);
  assert.throws(() => new SolanaRpcClient({ endpoint: "http://api.mainnet.solana.com" }), /credential-free HTTPS/);
  assert.equal(new SolanaRpcClient({ endpoint: "https://API.MAINNET.SOLANA.COM/" }).endpoint, SOLANA_MAINNET_RPC.endpoint);

  const malformed = new SolanaRpcClient({ minimumIntervalMs: 0, fetchImpl: async () => response({ jsonrpc: "2.0", id: 999, result: [] }) });
  await assert.rejects(() => malformed.signaturesForAddress(MINT), (error) => error instanceof SolanaRpcError && error.code === "invalid-response");
  const limited = new SolanaRpcClient({ minimumIntervalMs: 0, fetchImpl: async () => response({}, { status: 429, headers: { "retry-after": "2" } }) });
  await assert.rejects(() => limited.signaturesForAddress(MINT), (error) => error instanceof SolanaRpcError && error.code === "rate-limited" && error.retryAfterMs === 2_000);
  assert.throws(() => limited.signaturesForAddress(encodeBase58(Buffer.alloc(31, 1))), /32-byte/);
  assert.throws(() => limited.signaturesForAddress(` ${MINT}`), /canonical/);
  assert.throws(() => limited.transaction(encodeBase58(Buffer.alloc(63, 1))), /64-byte/);
  assert.throws(() => limited.signaturesForAddress(MINT, { limit: 33 }), /between 1 and 32/);
});

function pumpAccounts(side = "buy", userToken = USER_TOKEN, cashback = false) {
  const shared = [
    PUMP_GLOBAL,
    FEE_RECIPIENT,
    MINT,
    PUMP_BONDING_CURVE,
    PUMP_ASSOCIATED_BONDING,
    userToken,
    ACTOR,
    SYSTEM_PROGRAM
  ];
  return side === "sell"
    ? [...shared, PUMP_CREATOR_VAULT, TOKEN_PROGRAM, PUMP_EVENT_AUTHORITY, PUMP_PROGRAM, PUMP_FEE_CONFIG, FEE_PROGRAM,
      ...(cashback ? [PUMP_USER_VOLUME] : []), PUMP_BONDING_V2, BUYBACK_FEE_RECIPIENT]
    : [...shared, TOKEN_PROGRAM, PUMP_CREATOR_VAULT, PUMP_EVENT_AUTHORITY, PUMP_PROGRAM,
      PUMP_GLOBAL_VOLUME, PUMP_USER_VOLUME, PUMP_FEE_CONFIG, FEE_PROGRAM, PUMP_BONDING_V2, BUYBACK_FEE_RECIPIENT];
}

function swapAccounts(side = "buy", userToken = USER_TOKEN, cashback = false, withPoolV2 = true) {
  const shared = [
    SWAP_POOL,
    ACTOR,
    SWAP_GLOBAL_CONFIG,
    MINT,
    QUOTE_MINT,
    userToken,
    SWAP_USER_QUOTE,
    SWAP_POOL_BASE,
    SWAP_POOL_QUOTE,
    SWAP_PROTOCOL_RECIPIENT,
    SWAP_PROTOCOL_ATA,
    TOKEN_PROGRAM,
    TOKEN_PROGRAM,
    SYSTEM_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    SWAP_EVENT_AUTHORITY,
    PUMP_SWAP_PROGRAM,
    SWAP_CREATOR_ATA,
    SWAP_CREATOR_AUTHORITY
  ];
  const remaining = [
    ...(cashback ? side === "sell" ? [SWAP_USER_VOLUME_ATA, SWAP_USER_VOLUME] : [SWAP_USER_VOLUME_ATA] : []),
    ...(withPoolV2 ? [SWAP_POOL_V2] : []), BUYBACK_FEE_RECIPIENT, SWAP_BUYBACK_ATA
  ];
  return side === "sell"
    ? [...shared, SWAP_FEE_CONFIG, FEE_PROGRAM, ...remaining]
    : [...shared, SWAP_GLOBAL_VOLUME, SWAP_USER_VOLUME, SWAP_FEE_CONFIG, FEE_PROGRAM, ...remaining];
}

function writableIndices(program, side, accounts) {
  const writable = new Set(program.startsWith("swap")
    ? side === "sell" ? [0, 1, 5, 6, 7, 8, 10, 17] : [0, 1, 5, 6, 7, 8, 10, 17, 20]
    : side === "sell" ? [1, 3, 4, 5, 6, 8] : [1, 3, 4, 5, 6, 9, 13]);
  accounts.forEach((address, index) => {
    if (program.startsWith("swap")
      ? [SWAP_USER_VOLUME_ATA, SWAP_USER_VOLUME, SWAP_BUYBACK_ATA].includes(address)
      : address === BUYBACK_FEE_RECIPIENT || (side === "sell" && index === 14 && address === PUMP_USER_VOLUME)) writable.add(index);
  });
  return [...writable];
}

function messageAccountKeys(accounts, program, side) {
  const writable = new Set(writableIndices(program, side, accounts));
  const actorIndex = program.startsWith("swap") ? 1 : 6;
  const roles = new Map();
  accounts.forEach((pubkey, index) => {
    const role = { pubkey, signer: index === actorIndex, writable: writable.has(index) };
    const existing = roles.get(pubkey);
    if (existing && (existing.signer !== role.signer || existing.writable !== role.writable)) throw new Error("fixture account role conflict");
    roles.set(pubkey, role);
  });
  roles.set(SECOND_USER_TOKEN, { pubkey: SECOND_USER_TOKEN, signer: false, writable: true });
  return [...roles.values()].sort((left, right) => Number(right.signer) - Number(left.signer)
    || Number(right.writable) - Number(left.writable));
}

function discriminator(side, program) {
  if (side === "sell") return [51, 230, 133, 164, 1, 127, 131, 173];
  if (program === "swap-exact") return [198, 46, 21, 82, 180, 217, 232, 112];
  if (program === "pump-exact") return [56, 252, 116, 8, 158, 223, 205, 95];
  return [102, 6, 61, 18, 1, 218, 235, 234];
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function instructionData(side, program, tokenAmount) {
  const exactInput = program.endsWith("exact");
  return encodeBase58([
    ...discriminator(side, program),
    ...u64(exactInput ? 1_000_000_000n : tokenAmount),
    ...u64(exactInput ? tokenAmount : 1n),
    ...(side === "sell" ? [] : [0])
  ]);
}

function transaction({
  actorDelta = 250_000_000n,
  otherDelta = -actorDelta,
  signature = SIGNATURE,
  blockTime = BLOCK_TIME,
  slot = 9,
  side = "buy",
  program = "pump",
  cashback = false,
  withPoolV2 = true,
  userToken = USER_TOKEN,
  instructionAmount = actorDelta < 0n ? -actorDelta : actorDelta
} = {}) {
  const isSwap = program.startsWith("swap");
  const accounts = isSwap ? swapAccounts(side, userToken, cashback, withPoolV2) : pumpAccounts(side, userToken, cashback);
  const accountKeys = messageAccountKeys(accounts, program, side);
  const addresses = accountKeys.map(({ pubkey }) => pubkey);
  const designatedUserToken = accounts[5];
  const poolToken = isSwap ? accounts[7] : accounts[4];
  const poolOwner = isSwap ? accounts[0] : accounts[3];
  const balance = (owner, tokenAccount, amount) => ({
    accountIndex: addresses.indexOf(tokenAccount),
    owner,
    mint: MINT,
    uiTokenAmount: { amount: String(amount), decimals: 6 }
  });
  return {
    slot,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: accountKeys.filter(({ signer, writable }) => !signer && !writable).length
        },
        instructions: [{
          programId: isSwap ? PUMP_SWAP_PROGRAM : PUMP_PROGRAM,
          accounts,
          data: instructionData(side, program, instructionAmount)
        }]
      }
    },
    meta: {
      err: null,
      preTokenBalances: [balance(ACTOR, designatedUserToken, 100_000_000n), balance(poolOwner, poolToken, 900_000_000n)],
      postTokenBalances: [balance(ACTOR, designatedUserToken, 100_000_000n + actorDelta), balance(poolOwner, poolToken, 900_000_000n + otherDelta)]
    }
  };
}

function setMessageWritable(tx, address, writable) {
  const message = tx.transaction.message;
  const previousAddresses = message.accountKeys.map(({ pubkey }) => pubkey);
  const balanceAddresses = [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]
    .map(({ accountIndex }) => previousAddresses[accountIndex]);
  const target = message.accountKeys.find((entry) => entry.pubkey === address);
  if (!target || target.signer) throw new Error("fixture writable target missing or signer-owned");
  target.writable = writable;
  message.accountKeys.sort((left, right) => Number(right.signer) - Number(left.signer)
    || Number(right.writable) - Number(left.writable));
  message.header.numReadonlyUnsignedAccounts = message.accountKeys.filter(({ signer, writable: value }) => !signer && !value).length;
  [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances].forEach((row, index) => {
    row.accountIndex = message.accountKeys.findIndex(({ pubkey }) => pubkey === balanceAddresses[index]);
  });
}

function addMessageAccount(tx, address, writable = false) {
  const message = tx.transaction.message;
  if (message.accountKeys.some(({ pubkey }) => pubkey === address)) return;
  const previousAddresses = message.accountKeys.map(({ pubkey }) => pubkey);
  const balanceAddresses = [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]
    .map(({ accountIndex }) => previousAddresses[accountIndex]);
  message.accountKeys.push({ pubkey: address, signer: false, writable });
  message.accountKeys.sort((left, right) => Number(right.signer) - Number(left.signer)
    || Number(right.writable) - Number(left.writable));
  message.header.numReadonlyUnsignedAccounts = message.accountKeys.filter(({ signer, writable: value }) => !signer && !value).length;
  [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances].forEach((row, index) => {
    row.accountIndex = message.accountKeys.findIndex(({ pubkey }) => pubkey === balanceAddresses[index]);
  });
}

function setPumpFeeRecipient(tx, recipient) {
  addMessageAccount(tx, recipient, true);
  tx.transaction.message.instructions[0].accounts[1] = recipient;
}

function setSwapFeeRecipient(tx, recipient, tokenAccount) {
  addMessageAccount(tx, recipient);
  addMessageAccount(tx, tokenAccount, true);
  tx.transaction.message.instructions[0].accounts[9] = recipient;
  tx.transaction.message.instructions[0].accounts[10] = tokenAccount;
}

const signatureInfo = () => ({ signature: SIGNATURE, slot: 9, blockTime: BLOCK_TIME, err: null, confirmationStatus: "finalized" });
const extract = (tx, info = signatureInfo()) => extractFinalizedActorInputs({ mint: MINT, signatureInfo: info, transaction: tx, observedAt: OBSERVED_AT });

test("extracts only instruction-designated signer token deltas with internal provenance", () => {
  const buy = extract(transaction());
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
    amountBasis: "instruction-token-amount-reconciled-to-designated-user-token-account-delta",
    instructionBasis: [{ programId: PUMP_PROGRAM, instruction: "buy" }],
    nativeAmountStatus: "unavailable-transaction-balance-delta-is-not-trade-consideration"
  });
  const sell = extract(transaction({ actorDelta: -50_000_000n, otherDelta: 50_000_000n, side: "sell" }));
  assert.equal(sell.observations[0].side, "sell");
  assert.equal(sell.observations[0].tokenAmount, 50);
});

test("accepts the exact official PumpSwap buy and sell account contracts", () => {
  const buy = extract(transaction({ program: "swap" }));
  assert.equal(buy.status, "observed");
  assert.deepEqual(buy.observations[0].instructionBasis, [{ programId: PUMP_SWAP_PROGRAM, instruction: "buy" }]);
  const sell = extract(transaction({ actorDelta: -25_000_000n, otherDelta: 25_000_000n, side: "sell", program: "swap" }));
  assert.equal(sell.status, "observed");
  assert.deepEqual(sell.observations[0].instructionBasis, [{ programId: PUMP_SWAP_PROGRAM, instruction: "sell" }]);
});

test("accepts documented current fee layouts and binds every appended account", () => {
  assert.equal(extract(transaction({ side: "sell", actorDelta: -25_000_000n, otherDelta: 25_000_000n, cashback: true })).status, "observed");
  assert.equal(extract(transaction({ program: "swap", cashback: true })).status, "observed");
  assert.equal(extract(transaction({ side: "sell", program: "swap", actorDelta: -25_000_000n, otherDelta: 25_000_000n, cashback: true })).status, "observed");
  assert.equal(extract(transaction({ program: "swap", withPoolV2: false })).status, "observed");
  assert.equal(extract(transaction({ side: "sell", program: "swap", actorDelta: -25_000_000n, otherDelta: 25_000_000n, withPoolV2: false })).status, "observed");

  for (const mutate of [
    (tx) => { const accounts = tx.transaction.message.instructions[0].accounts; accounts[accounts.length - 1] = ABSENT_ACCOUNT; },
    (tx) => { const accounts = tx.transaction.message.instructions[0].accounts; accounts[accounts.length - 2] = ABSENT_ACCOUNT; },
    (tx) => { tx.transaction.message.instructions[0].accounts[16] = ABSENT_ACCOUNT; }
  ]) {
    const tx = transaction();
    addMessageAccount(tx, ABSENT_ACCOUNT, true);
    mutate(tx);
    assert.equal(extract(tx).reason, "official-pump-instruction-invalid");
  }

  const wrongSwapPoolV2 = transaction({ program: "swap" });
  addMessageAccount(wrongSwapPoolV2, ABSENT_ACCOUNT);
  wrongSwapPoolV2.transaction.message.instructions[0].accounts[23] = ABSENT_ACCOUNT;
  assert.equal(extract(wrongSwapPoolV2).reason, "official-pump-instruction-invalid");
});

test("accepts audited 24-byte and current 25-byte standard-buy encodings", () => {
  for (const program of ["pump", "swap"]) {
    const current = transaction({ program });
    assert.equal(extract(current).status, "observed");
    const compatible = transaction({ program });
    compatible.transaction.message.instructions[0].data = encodeBase58([
      ...discriminator("buy", program), ...u64(250_000_000n), ...u64(1n)
    ]);
    assert.equal(extract(compatible).status, "observed");
    const oversized = transaction({ program });
    oversized.transaction.message.instructions[0].data = encodeBase58([
      ...discriminator("buy", program), ...u64(250_000_000n), ...u64(1n), 0, 0
    ]);
    assert.equal(extract(oversized).reason, "official-pump-instruction-invalid");
  }
});

test("accepts instruction-designated actor-owned token accounts and composite privilege elevation", () => {
  for (const program of ["pump", "swap"]) {
    const alternateTokenAccount = transaction({ program, userToken: SECOND_USER_TOKEN });
    assert.equal(extract(alternateTokenAccount).status, "observed");

    const composite = transaction({ program });
    setMessageWritable(composite, program === "pump" ? PUMP_EVENT_AUTHORITY : SWAP_GLOBAL_CONFIG, true);
    assert.equal(extract(composite).status, "observed");
  }
});

test("uses exact program-specific legacy fee-recipient allowlists", () => {
  const pumpOnly = transaction();
  setPumpFeeRecipient(pumpOnly, PUMP_ONLY_FEE_RECIPIENT);
  assert.equal(extract(pumpOnly).status, "observed");

  const pumpRejectsSwapOnly = transaction();
  setPumpFeeRecipient(pumpRejectsSwapOnly, SWAP_ONLY_FEE_RECIPIENT);
  assert.equal(extract(pumpRejectsSwapOnly).reason, "official-pump-instruction-invalid");

  assert.equal(extract(transaction({ program: "swap" })).status, "observed");
  const swapRejectsPumpOnly = transaction({ program: "swap" });
  setSwapFeeRecipient(swapRejectsPumpOnly, PUMP_ONLY_FEE_RECIPIENT, PUMP_ONLY_SWAP_ATA);
  assert.equal(extract(swapRejectsPumpOnly).reason, "official-pump-instruction-invalid");

  const reservedPump = transaction();
  setPumpFeeRecipient(reservedPump, RESERVED_FEE_RECIPIENT);
  assert.equal(extract(reservedPump).status, "observed");
  const reservedSwap = transaction({ program: "swap" });
  setSwapFeeRecipient(reservedSwap, RESERVED_FEE_RECIPIENT, RESERVED_SWAP_ATA);
  assert.equal(extract(reservedSwap).status, "observed");
});

test("withholds exact-input variants whose minimum output cannot exclude same-account transfer inflation", () => {
  assert.equal(extract(transaction({ program: "pump-exact" })).reason, "unsupported-official-pump-trade-variant");
  assert.equal(extract(transaction({ program: "swap-exact" })).reason, "unsupported-official-pump-trade-variant");
});

test("keeps unsupported official v2 variants explicitly unavailable", () => {
  for (const [side, discriminatorBytes] of [
    ["buy", [184, 23, 238, 97, 103, 197, 211, 61]],
    ["sell", [93, 246, 130, 60, 231, 233, 64, 178]],
    ["buy", [194, 171, 28, 70, 104, 77, 91, 47]]
  ]) {
    const tx = transaction({ side });
    tx.transaction.message.instructions[0].data = encodeBase58([
      ...discriminatorBytes,
      ...Buffer.alloc(side === "sell" ? 16 : 17)
    ]);
    assert.equal(extract(tx).reason, "unsupported-official-pump-trade-variant");
  }
});

test("fails closed when success or exact-mint balance fields are missing or malformed", () => {
  for (const mutate of [
    (tx) => { delete tx.meta.err; },
    (tx) => { delete tx.meta.preTokenBalances; },
    (tx) => { delete tx.meta.postTokenBalances; }
  ]) {
    const tx = transaction();
    mutate(tx);
    assert.equal(extract(tx).status, "rejected");
  }

  for (const mutate of [
    (row) => { row.accountIndex = 999; },
    (row) => { row.accountIndex = String(row.accountIndex); },
    (row) => { row.owner = encodeBase58(Buffer.alloc(31, 1)); },
    (row) => { row.uiTokenAmount.amount = "Infinity"; },
    (row) => { delete row.uiTokenAmount.decimals; },
    (row) => { row.uiTokenAmount.decimals = "6"; }
  ]) {
    const tx = transaction();
    mutate(tx.meta.postTokenBalances[0]);
    assert.deepEqual(extract(tx), { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] });
  }

  const duplicate = transaction();
  duplicate.meta.postTokenBalances.push(structuredClone(duplicate.meta.postTokenBalances[0]));
  assert.equal(extract(duplicate).reason, "token-balance-evidence-invalid");
  const unrelatedMalformed = transaction();
  unrelatedMalformed.meta.postTokenBalances.push({ mint: QUOTE_MINT, owner: "bad" });
  assert.equal(extract(unrelatedMalformed).status, "observed");
});

test("accepts canonical headerless metadata, required roles, and transaction-wide privilege elevation", () => {
  const headerless = transaction();
  delete headerless.transaction.message.header;
  for (const entry of headerless.transaction.message.accountKeys) entry.source = "transaction";
  assert.equal(extract(headerless).status, "observed");

  const malformedRole = structuredClone(headerless);
  delete malformedRole.transaction.message.accountKeys[1].writable;
  assert.equal(extract(malformedRole).reason, "token-balance-evidence-invalid");

  const missingSource = structuredClone(headerless);
  delete missingSource.transaction.message.accountKeys[0].source;
  assert.equal(extract(missingSource).reason, "token-balance-evidence-invalid");

  const signerGap = structuredClone(headerless);
  signerGap.transaction.message.accountKeys[0].signer = false;
  signerGap.transaction.message.accountKeys[1].signer = true;
  assert.equal(extract(signerGap).reason, "token-balance-evidence-invalid");

  const extraSigner = structuredClone(headerless);
  extraSigner.transaction.message.accountKeys[1].signer = true;
  extraSigner.transaction.signatures.push(OTHER_SIGNATURE);
  assert.equal(extract(extraSigner).status, "observed");

  const writableSpoof = structuredClone(headerless);
  writableSpoof.transaction.message.accountKeys.find(({ pubkey }) => pubkey === PUMP_EVENT_AUTHORITY).writable = true;
  assert.equal(extract(writableSpoof).status, "observed");

  const staticAfterLookup = structuredClone(headerless);
  staticAfterLookup.transaction.message.accountKeys.at(-2).source = "lookupTable";
  assert.equal(extract(staticAfterLookup).reason, "token-balance-evidence-invalid");

  const partialLookupMetadata = structuredClone(headerless);
  partialLookupMetadata.transaction.message.accountKeys.at(-2).source = "lookupTable";
  delete partialLookupMetadata.transaction.message.accountKeys.at(-1).source;
  assert.equal(extract(partialLookupMetadata).reason, "token-balance-evidence-invalid");
});

test("derives signers from the message header and rejects signer metadata spoofing", () => {
  const actorSpoof = transaction();
  actorSpoof.transaction.message.accountKeys[0].signer = false;
  assert.equal(extract(actorSpoof).reason, "token-balance-evidence-invalid");

  const nonSignerSpoof = transaction();
  nonSignerSpoof.transaction.message.accountKeys[1].signer = true;
  assert.equal(extract(nonSignerSpoof).reason, "token-balance-evidence-invalid");

  const malformedHeader = transaction();
  delete malformedHeader.transaction.message.header.numReadonlyUnsignedAccounts;
  assert.equal(extract(malformedHeader).reason, "token-balance-evidence-invalid");

  const coercedHeader = transaction();
  coercedHeader.transaction.message.header.numRequiredSignatures = "1";
  assert.equal(extract(coercedHeader).reason, "token-balance-evidence-invalid");

  const malformedKey = transaction();
  malformedKey.transaction.message.accountKeys[3].pubkey = encodeBase58(Buffer.alloc(31, 2));
  assert.equal(extract(malformedKey).reason, "token-balance-evidence-invalid");
});

test("requires exact official instruction account counts, fixed programs, and indexed user token binding", () => {
  const shortPump = transaction();
  shortPump.transaction.message.instructions[0].accounts.pop();
  assert.equal(extract(shortPump).reason, "official-pump-instruction-invalid");

  const truncatedArguments = transaction();
  truncatedArguments.transaction.message.instructions[0].data = encodeBase58(discriminator("buy", "pump"));
  assert.equal(extract(truncatedArguments).reason, "official-pump-instruction-invalid");

  const oversizedArguments = transaction({ side: "sell" });
  oversizedArguments.transaction.message.instructions[0].data = encodeBase58([
    ...discriminator("sell", "pump"), ...Buffer.alloc(17)
  ]);
  assert.equal(extract(oversizedArguments).reason, "official-pump-instruction-invalid");

  const invalidTrackVolume = transaction();
  invalidTrackVolume.transaction.message.instructions[0].data = encodeBase58([
    ...discriminator("buy", "pump"), ...Buffer.alloc(16), 2
  ]);
  assert.equal(extract(invalidTrackVolume).reason, "official-pump-instruction-invalid");

  const wrongSystem = transaction();
  wrongSystem.transaction.message.instructions[0].accounts[7] = OTHER;
  assert.equal(extract(wrongSystem).reason, "official-pump-instruction-invalid");

  const missingGlobalAccount = transaction();
  missingGlobalAccount.transaction.message.instructions[0].accounts[0] = ABSENT_ACCOUNT;
  assert.equal(extract(missingGlobalAccount).reason, "official-pump-instruction-invalid");

  const wrongGlobalPda = transaction();
  addMessageAccount(wrongGlobalPda, ABSENT_ACCOUNT);
  wrongGlobalPda.transaction.message.instructions[0].accounts[0] = ABSENT_ACCOUNT;
  assert.equal(extract(wrongGlobalPda).reason, "official-pump-instruction-invalid");

  const wrongTokenAccount = transaction();
  wrongTokenAccount.transaction.message.instructions[0].accounts[5] = SECOND_USER_TOKEN;
  assert.equal(extract(wrongTokenAccount).reason, "mixed-or-ambiguous-signer-token-activity");

  const readonlyUserToken = transaction();
  setMessageWritable(readonlyUserToken, USER_TOKEN, false);
  assert.equal(extract(readonlyUserToken).reason, "official-pump-instruction-invalid");

  const repeatedWritablePlaceholder = transaction();
  repeatedWritablePlaceholder.transaction.message.instructions[0].accounts[1] = PUMP_BONDING_CURVE;
  assert.equal(extract(repeatedWritablePlaceholder).reason, "official-pump-instruction-invalid");

  const unsupportedTokenProgram = transaction();
  addMessageAccount(unsupportedTokenProgram, ABSENT_ACCOUNT);
  unsupportedTokenProgram.transaction.message.instructions[0].accounts[8] = ABSENT_ACCOUNT;
  assert.equal(extract(unsupportedTokenProgram).reason, "official-pump-instruction-invalid");

  const unknownPumpFeeRecipient = transaction();
  addMessageAccount(unknownPumpFeeRecipient, ABSENT_ACCOUNT, true);
  unknownPumpFeeRecipient.transaction.message.instructions[0].accounts[1] = ABSENT_ACCOUNT;
  assert.equal(extract(unknownPumpFeeRecipient).reason, "official-pump-instruction-invalid");

  const shortSwap = transaction({ program: "swap" });
  shortSwap.transaction.message.instructions[0].accounts.pop();
  assert.equal(extract(shortSwap).reason, "official-pump-instruction-invalid");

  const wrongSwapProgramContract = transaction({ program: "swap" });
  wrongSwapProgramContract.transaction.message.instructions[0].accounts[16] = PUMP_PROGRAM;
  assert.equal(extract(wrongSwapProgramContract).reason, "official-pump-instruction-invalid");

  const wrongSwapProtocolAta = transaction({ program: "swap" });
  wrongSwapProtocolAta.transaction.message.instructions[0].accounts[10] = SECOND_USER_TOKEN;
  assert.equal(extract(wrongSwapProtocolAta).reason, "official-pump-instruction-invalid");

  const wrongSwapEventPda = transaction({ program: "swap" });
  addMessageAccount(wrongSwapEventPda, ABSENT_ACCOUNT);
  wrongSwapEventPda.transaction.message.instructions[0].accounts[15] = ABSENT_ACCOUNT;
  assert.equal(extract(wrongSwapEventPda).reason, "official-pump-instruction-invalid");

  const wrongSwapGlobalPda = transaction({ program: "swap" });
  addMessageAccount(wrongSwapGlobalPda, ABSENT_ACCOUNT);
  wrongSwapGlobalPda.transaction.message.instructions[0].accounts[2] = ABSENT_ACCOUNT;
  assert.equal(extract(wrongSwapGlobalPda).reason, "official-pump-instruction-invalid");

  const repeatedReadonlySwapPlaceholder = transaction({ program: "swap" });
  repeatedReadonlySwapPlaceholder.transaction.message.instructions[0].accounts[2] = QUOTE_MINT;
  assert.equal(extract(repeatedReadonlySwapPlaceholder).reason, "official-pump-instruction-invalid");

  const unknownSwapFeeRecipient = transaction({ program: "swap" });
  addMessageAccount(unknownSwapFeeRecipient, ABSENT_ACCOUNT);
  unknownSwapFeeRecipient.transaction.message.instructions[0].accounts[9] = ABSENT_ACCOUNT;
  assert.equal(extract(unknownSwapFeeRecipient).reason, "official-pump-instruction-invalid");
});

test("rejects mixed sides, invalid alternate designated accounts, and extra signer-owned mint activity", () => {
  const mixedSides = transaction();
  mixedSides.transaction.message.instructions.push({
    programId: PUMP_PROGRAM,
    accounts: pumpAccounts("sell"),
    data: instructionData("sell", "pump", 1n)
  });
  assert.equal(extract(mixedSides).reason, "mixed-or-ambiguous-official-pump-activity");

  const multipleAccounts = transaction();
  multipleAccounts.transaction.message.instructions.push({
    programId: PUMP_PROGRAM,
    accounts: pumpAccounts("buy", SECOND_USER_TOKEN),
    data: instructionData("buy", "pump", 1n)
  });
  assert.equal(extract(multipleAccounts).reason, "mixed-or-ambiguous-official-pump-activity");

  const extraSignerActivity = transaction();
  const secondIndex = extraSignerActivity.transaction.message.accountKeys.findIndex(({ pubkey }) => pubkey === SECOND_USER_TOKEN);
  extraSignerActivity.meta.preTokenBalances.push({ accountIndex: secondIndex, owner: ACTOR, mint: MINT, uiTokenAmount: { amount: "1", decimals: 6 } });
  extraSignerActivity.meta.postTokenBalances.push({ accountIndex: secondIndex, owner: ACTOR, mint: MINT, uiTokenAmount: { amount: "2", decimals: 6 } });
  assert.equal(extract(extraSignerActivity).reason, "mixed-or-ambiguous-signer-token-activity");
});

test("reconciles exact instruction token amounts and rejects same-account transfer inflation", () => {
  const inflated = transaction({ actorDelta: 250_000_001n, otherDelta: -250_000_001n, instructionAmount: 250_000_000n });
  assert.equal(extract(inflated).reason, "instruction-token-amount-mismatch");

  const deflated = transaction({ actorDelta: 249_999_999n, otherDelta: -249_999_999n, instructionAmount: 250_000_000n });
  assert.equal(extract(deflated).reason, "instruction-token-amount-mismatch");

  const inflatedSell = transaction({ side: "sell", actorDelta: -50_000_001n, otherDelta: 50_000_001n, instructionAmount: 50_000_000n });
  assert.equal(extract(inflatedSell).reason, "instruction-token-amount-mismatch");
});

test("fails closed on failed, mismatched, noncanonical, or non-attributable transactions", () => {
  const base = signatureInfo();
  assert.equal(extract(transaction(), { ...base, confirmationStatus: "confirmed" }).reason, "signature-not-finalized-success");
  assert.equal(extract(transaction({ signature: OTHER_SIGNATURE })).reason, "transaction-signature-mismatch");

  const noncanonicalSignature = transaction();
  noncanonicalSignature.transaction.signatures[0] = encodeBase58(Buffer.alloc(63, 4));
  assert.equal(extract(noncanonicalSignature).reason, "transaction-signature-mismatch");

  const transferOnly = transaction();
  transferOnly.transaction.message.instructions = [];
  assert.equal(extract(transferOnly).reason, "no-unambiguous-official-pump-buy-or-sell-evidence");

  const contradictory = transaction({ actorDelta: -1n, otherDelta: 1n, side: "buy" });
  assert.equal(extract(contradictory).reason, "instruction-token-amount-mismatch");

  const failed = transaction();
  failed.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(extract(failed).reason, "transaction-missing-or-failed");
});
