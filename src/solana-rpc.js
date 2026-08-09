const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_TOKEN_AMOUNT = 1_000_000_000_000_000;
const MAX_ACTORS_PER_TRANSACTION = 16;
const PUMP_BONDING_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
const instructionKey = (value) => Buffer.from(value).toString("hex");
const PUMP_INSTRUCTIONS = Object.freeze({
  [PUMP_BONDING_PROGRAM]: Object.freeze({
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234])]: Object.freeze({ side: "buy", mintIndex: 2, actorIndex: 6, name: "buy" }),
    [instructionKey([56, 252, 116, 8, 158, 223, 205, 95])]: Object.freeze({ side: "buy", mintIndex: 2, actorIndex: 6, name: "buy_exact_sol_in" }),
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173])]: Object.freeze({ side: "sell", mintIndex: 2, actorIndex: 6, name: "sell" })
  }),
  [PUMP_SWAP_PROGRAM]: Object.freeze({
    [instructionKey([102, 6, 61, 18, 1, 218, 235, 234])]: Object.freeze({ side: "buy", mintIndex: 3, actorIndex: 1, name: "buy" }),
    [instructionKey([198, 46, 21, 82, 180, 217, 232, 112])]: Object.freeze({ side: "buy", mintIndex: 3, actorIndex: 1, name: "buy_exact_quote_in" }),
    [instructionKey([51, 230, 133, 164, 1, 127, 131, 173])]: Object.freeze({ side: "sell", mintIndex: 3, actorIndex: 1, name: "sell" })
  })
});

export const SOLANA_MAINNET_RPC = Object.freeze({
  id: "solana-mainnet-rpc",
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

function address(value, label = "address") {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SOLANA_ADDRESS.test(normalized)) throw new TypeError(`${label} must be a Solana base58 address`);
  return normalized;
}

function signature(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SOLANA_SIGNATURE.test(normalized)) throw new TypeError("signature must be bounded Solana base58 data");
  return normalized;
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
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Solana RPC endpoint must be credential-free HTTPS without query or fragment data");
  }
  return parsed.toString().replace(/\/$/, "");
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
            slot: Number(row?.slot),
            blockTime: Number(row?.blockTime),
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
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const required = Number(message?.header?.numRequiredSignatures);
  return keys.flatMap((entry, index) => {
    const raw = typeof entry === "string" ? entry : entry?.pubkey;
    try {
      return [{ address: address(raw), signer: typeof entry === "object" ? entry.signer === true : Number.isSafeInteger(required) && index < required }];
    } catch { return []; }
  });
}

function transactionAccountKeys(transaction) {
  const entries = accountKeys(transaction?.transaction?.message);
  const known = new Set(entries.map((entry) => entry.address));
  for (const raw of [
    ...(Array.isArray(transaction?.meta?.loadedAddresses?.writable) ? transaction.meta.loadedAddresses.writable : []),
    ...(Array.isArray(transaction?.meta?.loadedAddresses?.readonly) ? transaction.meta.loadedAddresses.readonly : [])
  ]) {
    try {
      const normalized = address(raw);
      if (!known.has(normalized)) entries.push({ address: normalized, signer: false });
    } catch {}
  }
  return entries;
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

function instructionAddress(value, keys) {
  if (typeof value === "string") {
    try { return address(value); } catch { return null; }
  }
  return Number.isSafeInteger(value) && value >= 0 && value < keys.length ? keys[value]?.address || null : null;
}

function pumpInstructionSides(transaction, mint, actor) {
  const keys = transactionAccountKeys(transaction);
  const instructions = [
    ...(Array.isArray(transaction?.transaction?.message?.instructions) ? transaction.transaction.message.instructions : []),
    ...(Array.isArray(transaction?.meta?.innerInstructions)
      ? transaction.meta.innerInstructions.flatMap((entry) => Array.isArray(entry?.instructions) ? entry.instructions : [])
      : [])
  ].slice(0, 256);
  const matches = [];
  for (const instruction of instructions) {
    const programId = typeof instruction?.programId === "string"
      ? instructionAddress(instruction.programId, keys)
      : instructionAddress(instruction?.programIdIndex, keys);
    const program = PUMP_INSTRUCTIONS[programId];
    if (!program) continue;
    const data = decodeBase58(instruction?.data);
    if (!data || data.length < 8) continue;
    const contract = program[data.subarray(0, 8).toString("hex")];
    if (!contract || !Array.isArray(instruction.accounts)) continue;
    const instructionMint = instructionAddress(instruction.accounts[contract.mintIndex], keys);
    const instructionActor = instructionAddress(instruction.accounts[contract.actorIndex], keys);
    if (instructionMint === mint && instructionActor === actor) {
      matches.push({ side: contract.side, programId, instruction: contract.name });
    }
  }
  const sides = new Set(matches.map(({ side }) => side));
  return sides.size === 1 ? { side: [...sides][0], matches } : null;
}

function amountRecord(entry, mint) {
  if (!entry || entry.mint !== mint) return null;
  let owner;
  try { owner = address(entry.owner, "token balance owner"); }
  catch { return null; }
  const amount = entry.uiTokenAmount?.amount;
  const decimals = Number(entry.uiTokenAmount?.decimals);
  if (typeof amount !== "string" || !/^\d{1,40}$/.test(amount) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return null;
  return { owner, amount: BigInt(amount), decimals };
}

function aggregateBalances(rows, mint) {
  const balances = new Map();
  for (const row of Array.isArray(rows) ? rows.slice(0, 256) : []) {
    const parsed = amountRecord(row, mint);
    if (!parsed) continue;
    const current = balances.get(parsed.owner);
    if (current && current.decimals !== parsed.decimals) return null;
    balances.set(parsed.owner, { decimals: parsed.decimals, amount: (current?.amount || 0n) + parsed.amount });
  }
  return balances;
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
  const slot = Number(signatureInfo?.slot);
  const blockTime = Number(signatureInfo?.blockTime ?? transaction?.blockTime);
  if (!Number.isSafeInteger(slot) || slot < 1 || !Number.isSafeInteger(blockTime) || blockTime < 1) {
    return { status: "rejected", reason: "missing-finalized-time-or-slot", observations: [] };
  }
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) || transaction.meta?.err != null) {
    return { status: "rejected", reason: "transaction-missing-or-failed", observations: [] };
  }
  const returnedSignature = transaction.transaction?.signatures?.[0];
  if (returnedSignature !== normalizedSignature) return { status: "rejected", reason: "transaction-signature-mismatch", observations: [] };
  if (Number(transaction.slot) !== slot || Number(transaction.blockTime) !== blockTime) {
    return { status: "rejected", reason: "transaction-provenance-mismatch", observations: [] };
  }
  const signers = new Set(accountKeys(transaction.transaction?.message).filter((entry) => entry.signer).map((entry) => entry.address));
  const pre = aggregateBalances(transaction.meta?.preTokenBalances, normalizedMint);
  const post = aggregateBalances(transaction.meta?.postTokenBalances, normalizedMint);
  if (!pre || !post || !signers.size) return { status: "rejected", reason: "token-balance-evidence-invalid", observations: [] };
  const owners = [...new Set([...pre.keys(), ...post.keys()])].sort();
  const sourceTimestamp = new Date(blockTime * 1_000).toISOString();
  const observations = owners.flatMap((owner) => {
    if (!signers.has(owner)) return [];
    const pumpEvidence = pumpInstructionSides(transaction, normalizedMint, owner);
    if (!pumpEvidence) return [];
    const before = pre.get(owner);
    const after = post.get(owner);
    const decimals = before?.decimals ?? after?.decimals;
    if (!Number.isSafeInteger(decimals) || (before && after && before.decimals !== after.decimals)) return [];
    const delta = (after?.amount || 0n) - (before?.amount || 0n);
    const tokenAmount = decimalAmount(delta, decimals);
    if (tokenAmount === null) return [];
    const side = pumpEvidence.side;
    if ((side === "buy" && tokenAmount < 0) || (side === "sell" && tokenAmount > 0)) return [];
    return [{
      mint: normalizedMint,
      actorAddress: owner,
      side,
      tokenAmount: Math.abs(tokenAmount),
      nativeAmount: null,
      source: SOLANA_MAINNET_RPC.id,
      evidenceClass: "on-chain-finalized",
      sourceTimestamp,
      observedAt: normalizedObservedAt,
      transactionId: normalizedSignature,
      slot,
      amountBasis: "net-finalized-token-balance-delta-matched-to-official-pump-instruction",
      instructionBasis: pumpEvidence.matches.map(({ programId, instruction }) => ({ programId, instruction })),
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
