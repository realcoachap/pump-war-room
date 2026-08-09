import { createHash } from "node:crypto";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_TOKEN_AMOUNT = 1_000_000_000_000_000;
const MAX_ACTORS_PER_TRANSACTION = 16;
const PUMP_BONDING_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const RESERVED_FEE_RECIPIENTS = Object.freeze([
  "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
  "4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6",
  "8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR",
  "4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH",
  "8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6",
  "Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk",
  "463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq",
  "6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA"
]);
const SHARED_NORMAL_FEE_RECIPIENTS = Object.freeze([
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP"
]);
const PUMP_LEGACY_FEE_RECIPIENTS = new Set([
  ...SHARED_NORMAL_FEE_RECIPIENTS,
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  ...RESERVED_FEE_RECIPIENTS
]);
const PUMP_SWAP_LEGACY_FEE_RECIPIENTS = new Set([
  ...SHARED_NORMAL_FEE_RECIPIENTS,
  "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU",
  ...RESERVED_FEE_RECIPIENTS
]);
const PUMP_FEE_CONFIG_SEED = Buffer.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);
const PUMP_SWAP_FEE_CONFIG_SEED = Buffer.from([12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
export const SOLANA_ACTOR_PARSER_REVISION = "official-pump-account-bound-v3";
const instructionKey = (value) => Buffer.from(value).toString("hex");
const pumpBondingContract = (side, name, accountCount, accepted = true) => Object.freeze({
  side,
  name,
  accepted,
  accountCount,
  dataLength: side === "sell" ? 24 : 25,
  trackVolume: side !== "sell",
  tokenAmountOffset: accepted ? 8 : null,
  mintIndex: 2,
  actorIndex: 6,
  userTokenIndex: 5,
  writableIndices: Object.freeze(side === "sell" ? [1, 3, 4, 5, 6, 8] : [1, 3, 4, 5, 6, 9, 13]),
  fixedAccounts: Object.freeze(accountCount === 16
    ? [[7, SYSTEM_PROGRAM], [11, PUMP_BONDING_PROGRAM], [15, PUMP_FEE_PROGRAM]]
    : [[7, SYSTEM_PROGRAM], [11, PUMP_BONDING_PROGRAM], [13, PUMP_FEE_PROGRAM]])
});
const pumpSwapContract = (side, name, accountCount, accepted = true) => Object.freeze({
  side,
  name,
  accepted,
  accountCount,
  dataLength: side === "sell" ? 24 : 25,
  trackVolume: side !== "sell",
  tokenAmountOffset: accepted ? 8 : null,
  mintIndex: 3,
  actorIndex: 1,
  userTokenIndex: 5,
  writableIndices: Object.freeze(side === "sell" ? [0, 1, 5, 6, 7, 8, 10, 17] : [0, 1, 5, 6, 7, 8, 10, 17, 20]),
  fixedAccounts: Object.freeze(accountCount === 23
    ? [[13, SYSTEM_PROGRAM], [14, ASSOCIATED_TOKEN_PROGRAM], [16, PUMP_SWAP_PROGRAM], [22, PUMP_FEE_PROGRAM]]
    : [[13, SYSTEM_PROGRAM], [14, ASSOCIATED_TOKEN_PROGRAM], [16, PUMP_SWAP_PROGRAM], [20, PUMP_FEE_PROGRAM]])
});
const PUMP_INSTRUCTIONS = Object.freeze({
  [PUMP_BONDING_PROGRAM]: Object.freeze({
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234])]: pumpBondingContract("buy", "buy", 16),
    [instructionKey([56, 252, 116, 8, 158, 223, 205, 95])]: pumpBondingContract("buy", "buy_exact_sol_in", 16, false),
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173])]: pumpBondingContract("sell", "sell", 14)
  }),
  [PUMP_SWAP_PROGRAM]: Object.freeze({
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234])]: pumpSwapContract("buy", "buy", 23),
    [instructionKey([198, 46, 21, 82, 180, 217, 232, 112])]: pumpSwapContract("buy", "buy_exact_quote_in", 23, false),
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173])]: pumpSwapContract("sell", "sell", 21)
  })
});
const UNSUPPORTED_TRADE_INSTRUCTIONS = Object.freeze({
  [PUMP_BONDING_PROGRAM]: new Set([
    instructionKey([184, 23, 238, 97, 103, 197, 211, 61]),
    instructionKey([93, 246, 130, 60, 231, 233, 64, 178]),
    instructionKey([194, 171, 28, 70, 104, 77, 91, 47])
  ]),
  [PUMP_SWAP_PROGRAM]: new Set()
});

export const SOLANA_MAINNET_RPC = Object.freeze({
  id: "solana-mainnet-rpc",
  parserRevision: SOLANA_ACTOR_PARSER_REVISION,
  endpoint: "https://api.mainnet.solana.com",
  commitment: "finalized",
  attributionUrl: "https://solana.com/docs/references/clusters",
  scope: "bounded finalized transactions that reference exact prospectively admitted mints"
});

export class SolanaRpcError extends Error {
  constructor(code, message, { retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SolanaRpcError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function encodeBase58(value) {
  const bytes = Buffer.from(value);
  let number = bytes.length ? BigInt(`0x${bytes.toString("hex")}`) : 0n;
  let encoded = "";
  while (number > 0n) {
    encoded = BASE58_ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + encoded;
}

function canonicalBase58(value, byteLength, label) {
  if (typeof value !== "string" || value !== value.trim()) throw new TypeError(`${label} must be canonical base58 data`);
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== byteLength || encodeBase58(decoded) !== value) {
    throw new TypeError(`${label} must be canonical ${byteLength}-byte Solana base58 data`);
  }
  return value;
}

function address(value, label = "address") {
  return canonicalBase58(value, 32, label);
}

function signature(value) {
  return canonicalBase58(value, 64, "signature");
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an RFC 3339 timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

function retryAfterMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(300_000, Math.max(0, date - Date.now())) : null;
}

function publicEndpoint(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new TypeError("Solana RPC endpoint must be the documented public mainnet endpoint"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Solana RPC endpoint must be credential-free HTTPS without query or fragment data");
  }
  const documented = new URL(SOLANA_MAINNET_RPC.endpoint);
  if (parsed.origin !== documented.origin || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new TypeError("Solana RPC endpoint must be the documented public Solana mainnet origin and root path");
  }
  return SOLANA_MAINNET_RPC.endpoint;
}

function safeRpcId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export class SolanaRpcClient {
  constructor({
    endpoint = SOLANA_MAINNET_RPC.endpoint,
    fetchImpl = fetch,
    timeoutMs = 8_000,
    minimumIntervalMs = 1_000,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    now = () => Date.now(),
    setTimeoutFn = setTimeout
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new RangeError("timeoutMs must be between 1000 and 30000");
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > 60_000) throw new RangeError("minimumIntervalMs must be between 0 and 60000");
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > MAX_RESPONSE_BYTES) throw new RangeError("maxResponseBytes is outside the safe bound");
    this.endpoint = publicEndpoint(endpoint);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.minimumIntervalMs = minimumIntervalMs;
    this.maxResponseBytes = maxResponseBytes;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.nextRequestAt = 0;
    this.nextId = 1;
    this.tail = Promise.resolve();
  }

  signaturesForAddress(mint, { limit = 12 } = {}) {
    const normalizedMint = address(mint, "mint");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RangeError("signature limit must be between 1 and 32");
    return this.#enqueue(() => this.#rpc("getSignaturesForAddress", [normalizedMint, {
      commitment: SOLANA_MAINNET_RPC.commitment,
      limit
    }], (result) => {
      if (!Array.isArray(result) || result.length > limit) throw new SolanaRpcError("invalid-response", "signature result was not a bounded array");
      return result.flatMap((row) => {
        try {
          const normalized = {
            signature: signature(row?.signature),
            slot: row?.slot,
            blockTime: row?.blockTime,
            confirmationStatus: row?.confirmationStatus,
            err: row?.err
          };
          if (!Number.isSafeInteger(normalized.slot) || normalized.slot < 1 || !Number.isSafeInteger(normalized.blockTime)
            || normalized.blockTime < 1 || normalized.confirmationStatus !== "finalized" || normalized.err !== null) return [];
          return [normalized];
        } catch {
          return [];
        }
      });
    }));
  }

  transaction(transactionSignature) {
    const normalizedSignature = signature(transactionSignature);
    return this.#enqueue(() => this.#rpc("getTransaction", [normalizedSignature, {
      commitment: SOLANA_MAINNET_RPC.commitment,
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0
    }], (result) => {
      if (result === null) return null;
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new SolanaRpcError("invalid-response", "transaction result was not an object or null");
      return result;
    }));
  }

  #enqueue(operation) {
    const task = this.tail.then(async () => {
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay) await new Promise((resolve) => this.setTimeoutFn(resolve, delay));
      try { return await operation(); }
      finally { this.nextRequestAt = Math.max(this.nextRequestAt, this.now()) + this.minimumIntervalMs; }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  async #rpc(method, params, validate) {
    const id = safeRpcId(this.nextId++);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const code = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network-error";
      throw new SolanaRpcError(code, `Solana RPC ${method} request failed`, { cause: error });
    }
    const retry = retryAfterMs(response.headers?.get?.("retry-after"));
    if (response.status === 429) throw new SolanaRpcError("rate-limited", "Solana RPC rate limit was reached", { retryAfterMs: retry });
    if (!response.ok) throw new SolanaRpcError("provider-http-error", `Solana RPC returned HTTP ${response.status}`, { retryAfterMs: retry });
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) throw new SolanaRpcError("response-too-large", "Solana RPC response exceeded the byte limit");
    const body = await response.text();
    if (Buffer.byteLength(body) > this.maxResponseBytes) throw new SolanaRpcError("response-too-large", "Solana RPC response exceeded the byte limit");
    let envelope;
    try { envelope = JSON.parse(body); }
    catch (error) { throw new SolanaRpcError("invalid-json", "Solana RPC returned invalid JSON", { cause: error }); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id) {
      throw new SolanaRpcError("invalid-response", "Solana RPC envelope did not match the request");
    }
    if (envelope.error) {
      const rpcCode = Number(envelope.error?.code);
      throw new SolanaRpcError(rpcCode === 429 || rpcCode === -32005 ? "rate-limited" : "provider-rpc-error", "Solana RPC returned an error envelope", { retryAfterMs: retry });
    }
    if (!("result" in envelope)) throw new SolanaRpcError("invalid-response", "Solana RPC result was missing");
    return validate(envelope.result);
  }
}

function accountKeys(message) {
  const rawKeys = message?.accountKeys;
  const header = message?.header;
  const hasHeader = header !== undefined;
  if (!Array.isArray(rawKeys) || rawKeys.length < 1 || rawKeys.length > 256
    || (hasHeader && (!header || typeof header !== "object" || Array.isArray(header)))) return null;
  const firstLookupIndex = rawKeys.findIndex((entry) => entry?.source === "lookupTable");
  const staticCount = firstLookupIndex === -1 ? rawKeys.length : firstLookupIndex;
  if (rawKeys.some((entry, index) => {
    const expectedSource = index < staticCount ? "transaction" : "lookupTable";
    return hasHeader
      ? entry?.source !== undefined && entry.source !== expectedSource
      : entry?.source !== expectedSource;
  })) return null;
  const entries = [];
  const known = new Set();
  for (const [index, entry] of rawKeys.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.signer !== "boolean" || typeof entry.writable !== "boolean") return null;
    const raw = entry.pubkey;
    let normalized;
    try { normalized = address(raw); }
    catch { return null; }
    if (known.has(normalized)) return null;
    known.add(normalized);
    entries.push({ address: normalized, signer: entry.signer, writable: entry.writable, index });
  }
  if (!hasHeader) {
    const requiredSignatures = entries.filter((entry) => entry.signer).length;
    if (requiredSignatures < 1 || requiredSignatures > staticCount
      || entries.some((entry, index) => entry.signer !== (index < requiredSignatures))) return null;
    return { entries, requiredSignatures };
  }
  const requiredSignatures = header.numRequiredSignatures;
  const readonlySigned = header.numReadonlySignedAccounts;
  const readonlyUnsigned = header.numReadonlyUnsignedAccounts;
  if (!Number.isSafeInteger(requiredSignatures) || requiredSignatures < 1 || requiredSignatures > staticCount
    || !Number.isSafeInteger(readonlySigned) || readonlySigned < 0 || readonlySigned > requiredSignatures
    || !Number.isSafeInteger(readonlyUnsigned) || readonlyUnsigned < 0 || readonlyUnsigned > staticCount - requiredSignatures) return null;
  for (const [index, entry] of entries.entries()) {
    const signer = index < requiredSignatures;
    const writable = index < requiredSignatures
      ? index < requiredSignatures - readonlySigned
      : index < staticCount
        ? index < staticCount - readonlyUnsigned
        : entry.writable;
    if (entry.signer !== signer || entry.writable !== writable) return null;
  }
  return { entries, requiredSignatures };
}

function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return null;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return null;
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const ED25519_FIELD = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modPow(121666n, ED25519_FIELD - 2n));
const ED25519_SQRT_M1 = modPow(2n, (ED25519_FIELD - 1n) / 4n);

function mod(value) {
  const remainder = value % ED25519_FIELD;
  return remainder >= 0n ? remainder : remainder + ED25519_FIELD;
}

function modPow(value, exponent) {
  let base = mod(value);
  let power = exponent;
  let result = 1n;
  while (power > 0n) {
    if (power & 1n) result = mod(result * base);
    base = mod(base * base);
    power >>= 1n;
  }
  return result;
}

function littleEndianInteger(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) + BigInt(bytes[index]);
  return value;
}

function isEd25519CurvePoint(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) return false;
  const bytes = Buffer.from(value);
  const sign = bytes[31] >> 7;
  bytes[31] &= 0x7f;
  const y = littleEndianInteger(bytes);
  if (y >= ED25519_FIELD) return false;
  const ySquared = mod(y * y);
  const numerator = mod(ySquared - 1n);
  const denominator = mod(ED25519_D * ySquared + 1n);
  if (denominator === 0n) return false;
  const xSquared = mod(numerator * modPow(denominator, ED25519_FIELD - 2n));
  let x = modPow(xSquared, (ED25519_FIELD + 3n) / 8n);
  if (mod(x * x - xSquared) !== 0n) x = mod(x * ED25519_SQRT_M1);
  if (mod(x * x - xSquared) !== 0n || (x === 0n && sign === 1)) return false;
  return true;
}

function findProgramAddress(seeds, programId) {
  const normalizedSeeds = seeds.map((seed) => Buffer.from(seed));
  if (normalizedSeeds.length > 15 || normalizedSeeds.some((seed) => seed.length > 32)) return null;
  const program = decodeBase58(programId);
  if (!program || program.length !== 32) return null;
  for (let bump = 255; bump >= 1; bump -= 1) {
    const digest = createHash("sha256")
      .update(Buffer.concat([...normalizedSeeds, Buffer.from([bump]), program, Buffer.from("ProgramDerivedAddress")]))
      .digest();
    if (!isEd25519CurvePoint(digest)) return encodeBase58(digest);
  }
  return null;
}

function addressSeed(value) {
  const decoded = decodeBase58(value);
  return decoded?.length === 32 ? decoded : null;
}

function associatedTokenAddress(owner, tokenProgram, mint) {
  const seeds = [addressSeed(owner), addressSeed(tokenProgram), addressSeed(mint)];
  return seeds.some((seed) => !seed) ? null : findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM);
}

function instructionAccount(value, keys) {
  if (Number.isSafeInteger(value) && value >= 0 && value < keys.length) return keys[value];
  if (typeof value !== "string") return null;
  let normalized;
  try { normalized = address(value); }
  catch { return null; }
  return keys.find((entry) => entry.address === normalized) || null;
}

function hasExactAccountRoles(accounts, contract) {
  const writable = new Set(contract.writableIndices);
  return accounts.every((account, index) => account.signer === (index === contract.actorIndex)
    && account.writable === writable.has(index));
}

function hasOnlyAllowedDuplicateAccounts(accounts, programId) {
  const occurrences = new Map();
  accounts.forEach((account, index) => {
    const indices = occurrences.get(account.address) || [];
    indices.push(index);
    occurrences.set(account.address, indices);
  });
  return [...occurrences.values()].every((indices) => indices.length === 1
    || (programId === PUMP_SWAP_PROGRAM && indices.length === 2 && indices[0] === 11 && indices[1] === 12));
}

function matchesAddress(account, expected) {
  return Boolean(expected) && account?.address === expected;
}

function validatePumpBondingAccounts(accounts, contract) {
  const mint = accounts[contract.mintIndex].address;
  const actor = accounts[contract.actorIndex].address;
  const tokenProgramIndex = contract.side === "sell" ? 9 : 8;
  const tokenProgram = accounts[tokenProgramIndex].address;
  if (!TOKEN_PROGRAMS.has(tokenProgram) || !PUMP_LEGACY_FEE_RECIPIENTS.has(accounts[1].address)) return false;
  const bondingCurve = findProgramAddress([Buffer.from("bonding-curve"), addressSeed(mint)], PUMP_BONDING_PROGRAM);
  const expected = [
    [0, findProgramAddress([Buffer.from("global")], PUMP_BONDING_PROGRAM)],
    [3, bondingCurve],
    [4, associatedTokenAddress(bondingCurve, tokenProgram, mint)],
    [5, associatedTokenAddress(actor, tokenProgram, mint)],
    [10, findProgramAddress([Buffer.from("__event_authority")], PUMP_BONDING_PROGRAM)],
    [contract.accountCount - 2, findProgramAddress([Buffer.from("fee_config"), PUMP_FEE_CONFIG_SEED], PUMP_FEE_PROGRAM)]
  ];
  if (contract.side !== "sell") {
    expected.push(
      [12, findProgramAddress([Buffer.from("global_volume_accumulator")], PUMP_BONDING_PROGRAM)],
      [13, findProgramAddress([Buffer.from("user_volume_accumulator"), addressSeed(actor)], PUMP_BONDING_PROGRAM)]
    );
  }
  // creator_vault depends on bonding_curve.creator account data, which getTransaction does not include.
  // Its exact role and distinctness are still enforced above; only directly reproducible PDAs are compared here.
  return expected.every(([index, value]) => matchesAddress(accounts[index], value));
}

function validatePumpSwapAccounts(accounts, contract) {
  const actor = accounts[contract.actorIndex].address;
  const pool = accounts[0].address;
  const baseMint = accounts[3].address;
  const quoteMint = accounts[4].address;
  const baseTokenProgram = accounts[11].address;
  const quoteTokenProgram = accounts[12].address;
  if (!TOKEN_PROGRAMS.has(baseTokenProgram) || !TOKEN_PROGRAMS.has(quoteTokenProgram)
    || !PUMP_SWAP_LEGACY_FEE_RECIPIENTS.has(accounts[9].address)) return false;
  const expected = [
    [2, findProgramAddress([Buffer.from("global_config")], PUMP_SWAP_PROGRAM)],
    [5, associatedTokenAddress(actor, baseTokenProgram, baseMint)],
    [6, associatedTokenAddress(actor, quoteTokenProgram, quoteMint)],
    [7, associatedTokenAddress(pool, baseTokenProgram, baseMint)],
    [8, associatedTokenAddress(pool, quoteTokenProgram, quoteMint)],
    [10, associatedTokenAddress(accounts[9].address, quoteTokenProgram, quoteMint)],
    [15, findProgramAddress([Buffer.from("__event_authority")], PUMP_SWAP_PROGRAM)],
    [17, associatedTokenAddress(accounts[18].address, quoteTokenProgram, quoteMint)],
    [contract.accountCount - 2, findProgramAddress([Buffer.from("fee_config"), PUMP_SWAP_FEE_CONFIG_SEED], PUMP_FEE_PROGRAM)]
  ];
  if (contract.side !== "sell") {
    expected.push(
      [19, findProgramAddress([Buffer.from("global_volume_accumulator")], PUMP_SWAP_PROGRAM)],
      [20, findProgramAddress([Buffer.from("user_volume_accumulator"), addressSeed(actor)], PUMP_SWAP_PROGRAM)]
    );
  }
  // pool relations and coin_creator_vault_authority depend on Pool account fields absent from getTransaction.
  // Their derived token accounts, exact roles, and distinctness remain verifiable and are enforced here.
  return expected.every(([index, value]) => matchesAddress(accounts[index], value));
}

function validateInstructionAccountContract(accounts, contract, programId) {
  if (!hasExactAccountRoles(accounts, contract) || !hasOnlyAllowedDuplicateAccounts(accounts, programId)) return false;
  return programId === PUMP_BONDING_PROGRAM
    ? validatePumpBondingAccounts(accounts, contract)
    : validatePumpSwapAccounts(accounts, contract);
}

function instructionTokenAmount(data, contract) {
  if (!contract.accepted || !Number.isSafeInteger(contract.tokenAmountOffset)
    || data.length < contract.tokenAmountOffset + 8) return null;
  const amount = data.readBigUInt64LE(contract.tokenAmountOffset);
  return amount > 0n ? amount : null;
}

function pumpInstructionEvidence(transaction, mint, keys, signers) {
  const instructions = [
    ...(Array.isArray(transaction?.transaction?.message?.instructions) ? transaction.transaction.message.instructions : []),
    ...(Array.isArray(transaction?.meta?.innerInstructions)
      ? transaction.meta.innerInstructions.flatMap((entry) => Array.isArray(entry?.instructions) ? entry.instructions : [])
      : [])
  ];
  if (instructions.length > 256) return { valid: false, matches: [] };
  const matches = [];
  let unsupportedTrade = false;
  for (const instruction of instructions) {
    const rawProgram = instruction?.programId ?? instruction?.programIdIndex;
    const programAccount = instructionAccount(rawProgram, keys);
    let recognizableProgram = null;
    if (typeof rawProgram === "string") {
      try { recognizableProgram = address(rawProgram); }
      catch {}
    }
    if (!programAccount) {
      if (recognizableProgram && PUMP_INSTRUCTIONS[recognizableProgram]) return { valid: false, matches: [] };
      continue;
    }
    const programId = programAccount.address;
    const program = PUMP_INSTRUCTIONS[programId];
    if (!program) continue;
    const data = decodeBase58(instruction?.data);
    if (!data || data.length < 8 || encodeBase58(data) !== instruction.data) return { valid: false, matches: [] };
    const discriminator = data.subarray(0, 8).toString("hex");
    const contract = program[discriminator];
    if (!contract) {
      if (UNSUPPORTED_TRADE_INSTRUCTIONS[programId]?.has(discriminator)) unsupportedTrade = true;
      continue;
    }
    if (data.length !== contract.dataLength || (contract.trackVolume && data.at(-1) > 1)) {
      return { valid: false, matches: [] };
    }
    if (!Array.isArray(instruction.accounts) || instruction.accounts.length !== contract.accountCount) return { valid: false, matches: [] };
    const accounts = instruction.accounts.map((entry) => instructionAccount(entry, keys));
    if (accounts.some((entry) => !entry)) return { valid: false, matches: [] };
    if (contract.fixedAccounts.some(([index, expected]) => accounts[index]?.address !== expected || accounts[index]?.writable)) {
      return { valid: false, matches: [] };
    }
    if (!validateInstructionAccountContract(accounts, contract, programId)) return { valid: false, matches: [] };
    const instructionMint = accounts[contract.mintIndex];
    if (instructionMint.address !== mint) continue;
    if (!contract.accepted) {
      unsupportedTrade = true;
      continue;
    }
    const instructionActor = accounts[contract.actorIndex];
    const userTokenAccount = accounts[contract.userTokenIndex];
    const expectedRawTokenAmount = instructionTokenAmount(data, contract);
    if (!signers.has(instructionActor.address) || instructionActor.address === mint
      || userTokenAccount.address === mint || userTokenAccount.address === instructionActor.address
      || expectedRawTokenAmount === null) return { valid: false, matches: [] };
    matches.push({
      actor: instructionActor.address,
      side: contract.side,
      expectedRawTokenAmount,
      userTokenAccount: userTokenAccount.address,
      userTokenIndex: userTokenAccount.index,
      programId,
      instruction: contract.name
    });
  }
  return { valid: true, matches, unsupportedTrade };
}

function amountRecord(entry, mint, keys) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.mint !== mint) return null;
  const accountIndex = entry.accountIndex;
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex >= keys.length) return null;
  let owner;
  try { owner = address(entry.owner, "token balance owner"); }
  catch { return null; }
  const amount = entry.uiTokenAmount?.amount;
  const decimals = entry.uiTokenAmount?.decimals;
  if (typeof amount !== "string" || !/^\d{1,40}$/.test(amount) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return null;
  return { accountIndex, tokenAccount: keys[accountIndex].address, owner, amount: BigInt(amount), decimals };
}

function aggregateBalances(rows, mint, keys) {
  if (!Array.isArray(rows) || rows.length > 256) return null;
  const balances = new Map();
  for (const row of rows) {
    if (row?.mint !== mint) continue;
    const parsed = amountRecord(row, mint, keys);
    if (!parsed || balances.has(parsed.accountIndex)) return null;
    balances.set(parsed.accountIndex, parsed);
  }
  return balances;
}

function balanceDelta(pre, post, accountIndex) {
  const before = pre.get(accountIndex);
  const after = post.get(accountIndex);
  if (!before && !after) return null;
  if (before && after && (before.owner !== after.owner || before.decimals !== after.decimals || before.tokenAccount !== after.tokenAccount)) return null;
  const evidence = before || after;
  return {
    owner: evidence.owner,
    tokenAccount: evidence.tokenAccount,
    decimals: evidence.decimals,
    amount: (after?.amount || 0n) - (before?.amount || 0n)
  };
}

function decimalAmount(amount, decimals) {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const digits = absolute.toString().padStart(decimals + 1, "0");
  const text = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  const value = Number(negative ? `-${text}` : text);
  return Number.isFinite(value) && Math.abs(value) > 0 && Math.abs(value) <= MAX_TOKEN_AMOUNT ? value : null;
}

export function extractFinalizedActorInputs({ mint, signatureInfo, transaction, observedAt } = {}) {
  const normalizedMint = address(mint, "mint");
  const normalizedObservedAt = timestamp(observedAt, "observedAt");
  const normalizedSignature = signature(signatureInfo?.signature);
  if (signatureInfo?.err !== null || signatureInfo?.confirmationStatus !== "finalized") return { status: "rejected", reason: "signature-not-finalized-success", observations: [] };
  const slot = signatureInfo?.slot;
  const blockTime = signatureInfo?.blockTime;
  if (!Number.isSafeInteger(slot) || slot < 1 || !Number.isSafeInteger(blockTime) || blockTime < 1) {
    return { status: "rejected", reason: "missing-finalized-time-or-slot", observations: [] };
  }
  const meta = transaction?.meta;
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)
    || !meta || typeof meta !== "object" || Array.isArray(meta)
    || !Object.hasOwn(meta, "err") || meta.err !== null) {
    return { status: "rejected", reason: "transaction-missing-or-failed", observations: [] };
  }
  if (transaction.slot !== slot || transaction.blockTime !== blockTime) {
    return { status: "rejected", reason: "transaction-provenance-mismatch", observations: [] };
  }
  const keyContext = accountKeys(transaction.transaction?.message);
  if (!keyContext) return { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] };
  const returnedSignatures = transaction.transaction?.signatures;
  if (!Array.isArray(returnedSignatures) || returnedSignatures.length !== keyContext.requiredSignatures) {
    return { status: "rejected", reason: "transaction-signature-mismatch", observations: [] };
  }
  try {
    if (returnedSignatures.map((entry) => signature(entry))[0] !== normalizedSignature) {
      return { status: "rejected", reason: "transaction-signature-mismatch", observations: [] };
    }
  } catch {
    return { status: "rejected", reason: "transaction-signature-mismatch", observations: [] };
  }
  const keys = keyContext.entries;
  const signers = new Set(keys.filter((entry) => entry.signer).map((entry) => entry.address));
  const pre = aggregateBalances(meta.preTokenBalances, normalizedMint, keys);
  const post = aggregateBalances(meta.postTokenBalances, normalizedMint, keys);
  if (!pre || !post || !signers.size) return { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] };
  const pumpEvidence = pumpInstructionEvidence(transaction, normalizedMint, keys, signers);
  if (!pumpEvidence.valid) return { status: "rejected", reason: "official-pump-instruction-invalid", observations: [] };
  if (pumpEvidence.unsupportedTrade) {
    return { status: "unavailable", reason: "unsupported-official-pump-trade-variant", observations: [] };
  }
  if (!pumpEvidence.matches.length) {
    return { status: "unavailable", reason: "no-unambiguous-official-pump-buy-or-sell-evidence", observations: [] };
  }
  const evidenceByActor = new Map();
  const tokenAccountActors = new Map();
  for (const evidence of pumpEvidence.matches) {
    const existing = evidenceByActor.get(evidence.actor);
    if (existing && (existing.side !== evidence.side || existing.userTokenIndex !== evidence.userTokenIndex)) {
      return { status: "rejected", reason: "mixed-or-ambiguous-official-pump-activity", observations: [] };
    }
    const claimedActor = tokenAccountActors.get(evidence.userTokenIndex);
    if (claimedActor && claimedActor !== evidence.actor) {
      return { status: "rejected", reason: "mixed-or-ambiguous-official-pump-activity", observations: [] };
    }
    tokenAccountActors.set(evidence.userTokenIndex, evidence.actor);
    if (existing) {
      existing.expectedRawTokenAmount += evidence.expectedRawTokenAmount;
      existing.matches.push(evidence);
    }
    else evidenceByActor.set(evidence.actor, { ...evidence, matches: [evidence] });
  }

  const designatedByActor = new Map([...evidenceByActor].map(([actor, evidence]) => [actor, evidence.userTokenIndex]));
  const changedIndices = new Set([...pre.keys(), ...post.keys()]);
  for (const accountIndex of changedIndices) {
    const delta = balanceDelta(pre, post, accountIndex);
    if (!delta) return { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] };
    if (delta.amount !== 0n && signers.has(delta.owner) && designatedByActor.get(delta.owner) !== accountIndex) {
      return { status: "rejected", reason: "mixed-or-ambiguous-signer-token-activity", observations: [] };
    }
  }

  for (const [actor, evidence] of evidenceByActor) {
    const delta = balanceDelta(pre, post, evidence.userTokenIndex);
    if (!delta || delta.owner !== actor || delta.tokenAccount !== evidence.userTokenAccount) {
      return { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] };
    }
    const expectedDelta = evidence.side === "buy" ? evidence.expectedRawTokenAmount : -evidence.expectedRawTokenAmount;
    if (delta.amount !== expectedDelta) {
      return { status: "rejected", reason: "instruction-token-amount-mismatch", observations: [] };
    }
  }

  const sourceTimestamp = new Date(blockTime * 1_000).toISOString();
  const observations = [...evidenceByActor.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(([actor, evidence]) => {
    const delta = balanceDelta(pre, post, evidence.userTokenIndex);
    if (!delta || delta.owner !== actor || delta.tokenAccount !== evidence.userTokenAccount) return [];
    const tokenAmount = decimalAmount(delta.amount, delta.decimals);
    if (tokenAmount === null) return [];
    const side = evidence.side;
    if ((side === "buy" && tokenAmount < 0) || (side === "sell" && tokenAmount > 0)) return [];
    return [{
      mint: normalizedMint,
      actorAddress: actor,
      side,
      tokenAmount: Math.abs(tokenAmount),
      nativeAmount: null,
      source: SOLANA_MAINNET_RPC.id,
      evidenceClass: "on-chain-finalized",
      sourceTimestamp,
      observedAt: normalizedObservedAt,
      transactionId: normalizedSignature,
      slot,
      amountBasis: "instruction-token-amount-reconciled-to-designated-user-token-account-delta",
      instructionBasis: [...new Map(evidence.matches.map(({ programId, instruction }) => [
        `${programId}:${instruction}`,
        { programId, instruction }
      ])).values()],
      nativeAmountStatus: "unavailable-transaction-balance-delta-is-not-trade-consideration"
    }];
  });
  if (observations.length > MAX_ACTORS_PER_TRANSACTION) {
    return { status: "rejected", reason: "actor-observation-limit-exceeded", observations: [] };
  }
  return observations.length
    ? { status: "observed", reason: null, observations }
    : { status: "unavailable", reason: "no-unambiguous-official-pump-buy-or-sell-evidence", observations: [] };
}
