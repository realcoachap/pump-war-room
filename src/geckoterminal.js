const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_INTERVAL_MS = 6_500;
const PROVIDER_VERSION = "20230203";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REQUEST_PRIORITY = Object.freeze({ poolSelection: 0, outcome: 1, tokenInfo: 2 });

export const GECKOTERMINAL_PROVIDER = Object.freeze({
  id: "geckoterminal",
  label: "GeckoTerminal",
  network: "solana",
  intervalSeconds: 60,
  apiVersion: PROVIDER_VERSION,
  attributionUrl: "https://www.geckoterminal.com/",
  documentationUrl: "https://apiguide.geckoterminal.com/"
});

export class GeckoTerminalError extends Error {
  constructor(code, message, { status = null, retryAfterMs = null, cause } = {}) {
    super(message, { cause });
    this.name = "GeckoTerminalError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function requireMint(value) {
  const mint = typeof value === "string" ? value.trim() : "";
  if (!MINT_PATTERN.test(mint)) throw new GeckoTerminalError("invalid-mint", "Solana mint must be a base58 address");
  return mint;
}

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function poolAddress(row) {
  const address = typeof row?.attributes?.address === "string" ? row.attributes.address.trim() : "";
  return MINT_PATTERN.test(address) ? address : null;
}

function relationshipMint(row, side) {
  const id = row?.relationships?.[`${side}_token`]?.data?.id;
  if (typeof id !== "string" || !id.startsWith("solana_")) return null;
  return id.slice("solana_".length);
}

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

export function selectGeckoTerminalPool(payload, mintValue, {
  tokenObservedAt = null,
  poolSelectedAt = null,
  clockSkewMs = 5 * 60_000,
  maxPoolCreationDelayMs = 60_000,
  maxSelectionDelayMs = 120_000
} = {}) {
  const mint = requireMint(mintValue);
  const observedTimestamp = tokenObservedAt === null ? null : Date.parse(tokenObservedAt);
  const selectedTimestamp = poolSelectedAt === null ? null : Date.parse(poolSelectedAt);
  if (tokenObservedAt !== null && !Number.isFinite(observedTimestamp)) {
    throw new GeckoTerminalError("invalid-token-timestamp", "Token observation timestamp is invalid");
  }
  if (poolSelectedAt !== null && !Number.isFinite(selectedTimestamp)) {
    throw new GeckoTerminalError("invalid-selection-timestamp", "Pool selection timestamp is invalid");
  }
  for (const [label, value] of [["clockSkewMs", clockSkewMs], ["maxPoolCreationDelayMs", maxPoolCreationDelayMs], ["maxSelectionDelayMs", maxSelectionDelayMs]]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  }
  if (Number.isFinite(observedTimestamp) && Number.isFinite(selectedTimestamp)
    && selectedTimestamp > observedTimestamp + maxSelectionDelayMs) {
    throw new GeckoTerminalError("selection-window-missed", "Pool was not selected prospectively within two minutes of launch observation");
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const candidates = rows.flatMap((row, rank) => {
    if (!row || row.type !== "pool") return [];
    const address = poolAddress(row);
    if (!address) return [];
    const baseMint = relationshipMint(row, "base");
    const quoteMint = relationshipMint(row, "quote");
    const tokenSide = baseMint === mint ? "base" : quoteMint === mint ? "quote" : null;
    if (!tokenSide) return [];
    const poolCreatedAt = isoTimestamp(row.attributes?.pool_created_at);
    if (!poolCreatedAt) return [];
    if (Number.isFinite(observedTimestamp)) {
      const createdTimestamp = Date.parse(poolCreatedAt);
      if (createdTimestamp < observedTimestamp - clockSkewMs || createdTimestamp > observedTimestamp + maxPoolCreationDelayMs) return [];
    }
    const reserveUsd = finite(row.attributes?.reserve_in_usd);
    return [{
      provider: GECKOTERMINAL_PROVIDER.id,
      network: GECKOTERMINAL_PROVIDER.network,
      pool: address,
      tokenSide,
      dex: typeof row.relationships?.dex?.data?.id === "string" ? row.relationships.dex.data.id : null,
      poolCreatedAt,
      poolSelectedAt: Number.isFinite(selectedTimestamp) ? new Date(selectedTimestamp).toISOString() : null,
      providerPage: 1,
      providerRank: rank + 1,
      reserveUsd: reserveUsd !== null && reserveUsd >= 0 ? reserveUsd : null,
      sourceUrl: `https://www.geckoterminal.com/solana/pools/${address}`
    }];
  });
  if (!candidates.length) {
    throw new GeckoTerminalError("pool-unavailable", "No eligible GeckoTerminal pool was available for the observed mint");
  }
  // Within the provider's contemporaneously ranked first page, select by
  // creation identity rather than later volume/liquidity success. Page and
  // rank remain explicit scope evidence and never change the fixed series.
  return candidates.sort((left, right) => left.poolCreatedAt.localeCompare(right.poolCreatedAt)
    || left.pool.localeCompare(right.pool))[0];
}

export function parseGeckoTerminalOhlcv(payload, { mint: mintValue, pool, tokenSide, fetchedAt = new Date().toISOString() } = {}) {
  const mint = requireMint(mintValue);
  if (!MINT_PATTERN.test(String(pool || ""))) throw new GeckoTerminalError("invalid-pool", "Pool address is invalid");
  if (!["base", "quote"].includes(tokenSide)) throw new GeckoTerminalError("invalid-token-side", "Token side must be base or quote");
  const fetchedIso = isoTimestamp(fetchedAt);
  if (!fetchedIso) throw new GeckoTerminalError("invalid-fetch-timestamp", "Fetch timestamp is invalid");
  const fetchedMs = Date.parse(fetchedIso);
  // token=<exact mint> orients the requested asset as the chart base, even
  // when it is the pool's original quote side.
  const metaAddress = payload?.meta?.base?.address;
  if (metaAddress !== mint) {
    throw new GeckoTerminalError("token-mismatch", "OHLCV metadata did not match the requested mint");
  }
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new GeckoTerminalError("invalid-response", "OHLCV response did not contain a candle list");
  const byTimestamp = new Map();
  const conflictingTimestamps = new Set();
  let rejected = 0;
  let incomplete = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) { rejected++; continue; }
    const [epochSeconds, open, high, low, close, volume] = row.map(finite);
    if (!Number.isInteger(epochSeconds) || epochSeconds <= 0 || [open, high, low, close].some((value) => value === null || value <= 0) || volume === null || volume <= 0) {
      rejected++;
      continue;
    }
    if (high < low || high < open || high < close || low > open || low > close) { rejected++; continue; }
    const candleStartMs = epochSeconds * 1_000;
    const candleEndMs = candleStartMs + GECKOTERMINAL_PROVIDER.intervalSeconds * 1_000;
    if (candleEndMs > fetchedMs) { incomplete++; continue; }
    const minuteAt = new Date(candleStartMs).toISOString();
    const observedAt = new Date(candleEndMs).toISOString();
    const observation = {
      mint,
      provider: GECKOTERMINAL_PROVIDER.id,
      source: GECKOTERMINAL_PROVIDER.id,
      pool,
      tokenSide,
      intervalSeconds: GECKOTERMINAL_PROVIDER.intervalSeconds,
      minuteAt,
      candleStartAt: minuteAt,
      candleEndAt: observedAt,
      observedAt,
      fetchedAt: fetchedIso,
      open,
      high,
      low,
      close,
      volume,
      sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
    };
    if (conflictingTimestamps.has(minuteAt)) { rejected++; continue; }
    const existing = byTimestamp.get(minuteAt);
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      byTimestamp.delete(minuteAt);
      conflictingTimestamps.add(minuteAt);
      rejected += 2;
      continue;
    }
    byTimestamp.set(minuteAt, observation);
  }
  const observations = [...byTimestamp.values()].sort((a, b) => a.minuteAt.localeCompare(b.minuteAt));
  return { observations, rejected, incomplete, received: rows.length };
}

export class GeckoTerminalClient {
  constructor({
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    userAgent = "PumpWarRoom (+https://pump-war-room-production.up.railway.app)"
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw new RangeError("timeoutMs must be at least 100");
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new RangeError("minIntervalMs must be non-negative");
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleep;
    this.userAgent = userAgent;
    this.nextRequestAt = 0;
    this.pendingRequests = [];
    this.requestSequence = 0;
    this.drainingRequests = false;
  }

  #request(pathname, parameters = {}, priority = REQUEST_PRIORITY.outcome) {
    return new Promise((resolve, reject) => {
      this.pendingRequests.push({ pathname, parameters, priority, sequence: this.requestSequence++, resolve, reject });
      this.#drainRequests();
    });
  }

  async #drainRequests() {
    if (this.drainingRequests) return;
    this.drainingRequests = true;
    try {
      while (this.pendingRequests.length) {
        const delay = Math.max(0, this.nextRequestAt - this.now());
        if (delay) await this.sleep(delay);
        this.pendingRequests.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
        const request = this.pendingRequests.shift();
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now()) + this.minIntervalMs;
        try { request.resolve(await this.#executeRequest(request.pathname, request.parameters)); }
        catch (error) { request.reject(error); }
      }
    } finally {
      this.drainingRequests = false;
      if (this.pendingRequests.length) this.#drainRequests();
    }
  }

  async #executeRequest(pathname, parameters) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: `application/json;version=${PROVIDER_VERSION}`,
          "user-agent": this.userAgent
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new GeckoTerminalError(timedOut ? "timeout" : "network-error", timedOut ? "GeckoTerminal request timed out" : "GeckoTerminal request failed", { cause: error });
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : null;
      const retryAfterMs = retryAfterMilliseconds(response) ?? (status === 429 ? 60_000 : null);
      if (retryAfterMs !== null && (status === 429 || status === 503)) {
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + retryAfterMs);
      }
      const code = status === 429 ? "rate-limited"
        : status === 404 ? "not-found"
          : status === 408 || (status !== null && status >= 500) ? "provider-unavailable"
            : [400, 401, 403, 422].includes(status) ? "provider-request-rejected"
              : "provider-http-error";
      throw new GeckoTerminalError(code, `GeckoTerminal returned HTTP ${status ?? "unknown"}`, { status, retryAfterMs });
    }
    try {
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("response was not an object");
      return payload;
    } catch (error) {
      throw new GeckoTerminalError("invalid-json", "GeckoTerminal returned invalid JSON", { status: response.status, cause: error });
    }
  }

  async poolForToken(mintValue, options = {}) {
    const mint = requireMint(mintValue);
    const payload = await this.#request(`/networks/solana/tokens/${encodeURIComponent(mint)}/pools`, {
      page: 1,
      sort: "h24_volume_usd_liquidity_desc"
    }, REQUEST_PRIORITY.poolSelection);
    return selectGeckoTerminalPool(payload, mint, {
      ...options,
      poolSelectedAt: options.poolSelectedAt ?? new Date(this.now()).toISOString()
    });
  }

  async tokenInfo(mintValue) {
    const mint = requireMint(mintValue);
    return this.#request(`/networks/solana/tokens/${encodeURIComponent(mint)}/info`, {}, REQUEST_PRIORITY.tokenInfo);
  }

  async currentPoolForToken(mintValue) {
    const mint = requireMint(mintValue);
    const payload = await this.#request(`/networks/solana/tokens/${encodeURIComponent(mint)}/pools`, {
      page: 1,
      sort: "h24_volume_usd_liquidity_desc"
    }, REQUEST_PRIORITY.tokenInfo);
    return selectGeckoTerminalPool(payload, mint, {
      poolSelectedAt: new Date(this.now()).toISOString()
    });
  }

  async ohlcv({ mint: mintValue, pool, tokenSide, beforeTimestamp = null, limit = 1000 } = {}) {
    const mint = requireMint(mintValue);
    if (!MINT_PATTERN.test(String(pool || ""))) throw new GeckoTerminalError("invalid-pool", "Pool address is invalid");
    if (!["base", "quote"].includes(tokenSide)) throw new GeckoTerminalError("invalid-token-side", "Token side must be base or quote");
    if (beforeTimestamp !== null && (!Number.isInteger(beforeTimestamp) || beforeTimestamp <= 0)) throw new GeckoTerminalError("invalid-before-timestamp", "beforeTimestamp must be positive epoch seconds");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new GeckoTerminalError("invalid-limit", "OHLCV limit must be between 1 and 1000");
    const payload = await this.#request(`/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute`, {
      aggregate: 1,
      before_timestamp: beforeTimestamp,
      limit,
      currency: "usd",
      token: mint,
      include_empty_intervals: false
    }, REQUEST_PRIORITY.outcome);
    return parseGeckoTerminalOhlcv(payload, { mint, pool, tokenSide, fetchedAt: new Date(this.now()).toISOString() });
  }
}
