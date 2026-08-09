import test from "node:test";
import assert from "node:assert/strict";
import {
  GeckoTerminalClient,
  GeckoTerminalError,
  parseGeckoTerminalOhlcv,
  selectGeckoTerminalPool
} from "../src/geckoterminal.js";
import { parseGeckoTerminalTokenInfo, RiskIdentityError } from "../src/risk-identity.js";

const mint = "11111111111111111111111111111111";
const quote = "So11111111111111111111111111111111111111112";
const pool = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

function poolRow({ address = pool, baseMint = mint, quoteMint = quote, price = "0.002", createdAt = "2026-08-08T10:02:00Z", reserve = "12000", volume = "3400" } = {}) {
  return {
    id: `solana_${address}`,
    type: "pool",
    attributes: {
      address,
      base_token_price_usd: price,
      quote_token_price_usd: "75",
      pool_created_at: createdAt,
      reserve_in_usd: reserve,
      volume_usd: { h24: volume }
    },
    relationships: {
      base_token: { data: { id: `solana_${baseMint}`, type: "token" } },
      quote_token: { data: { id: `solana_${quoteMint}`, type: "token" } },
      dex: { data: { id: "pumpswap", type: "dex" } }
    }
  };
}

test("selects the first prospectively provider-ranked eligible pool and records auditable evidence", () => {
  const stale = poolRow({ address: "7ZnPcXCAp4ri8m2agMjxethtHKpiCgF4AthoAqg8io9E", createdAt: "2026-08-07T00:00:00Z" });
  const selected = selectGeckoTerminalPool({ data: [stale, poolRow({ createdAt: "2026-08-08T10:00:30Z" })] }, mint, {
    tokenObservedAt: "2026-08-08T10:00:00Z",
    poolSelectedAt: "2026-08-08T10:01:00Z"
  });
  assert.deepEqual(selected, {
    provider: "geckoterminal",
    network: "solana",
    pool,
    tokenSide: "base",
    dex: "pumpswap",
    poolCreatedAt: "2026-08-08T10:00:30.000Z",
    poolSelectedAt: "2026-08-08T10:01:00.000Z",
    providerPage: 1,
    providerRank: 2,
    reserveUsd: 12000,
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${pool}`
  });
});

test("supports target tokens on the quote side without trusting unrelated pools", () => {
  const unrelated = poolRow({ baseMint: quote, quoteMint: "SysvarRent111111111111111111111111111111111" });
  const row = poolRow({ baseMint: quote, quoteMint: mint });
  row.attributes.quote_token_price_usd = "0.004";
  const selected = selectGeckoTerminalPool({ data: [unrelated, row] }, mint);
  assert.equal(selected.tokenSide, "quote");
  assert.equal(selected.providerRank, 2);
});

test("does not exclude a dead pool by current price but rejects post-launch migration pools", () => {
  const dead = selectGeckoTerminalPool({ data: [poolRow({ price: "0", createdAt: "2026-08-08T10:00:30Z" })] }, mint, {
    tokenObservedAt: "2026-08-08T10:00:00Z",
    poolSelectedAt: "2026-08-08T10:01:00Z"
  });
  assert.equal(dead.pool, pool);
  assert.throws(
    () => selectGeckoTerminalPool({ data: [poolRow({ createdAt: "2026-08-08T10:10:00Z" })] }, mint, {
      tokenObservedAt: "2026-08-08T10:00:00Z",
      poolSelectedAt: "2026-08-08T10:01:00Z"
    }),
    (error) => error instanceof GeckoTerminalError && error.code === "pool-unavailable"
  );
});

test("rejects a first pool selection made outside the two-minute prospective window", () => {
  assert.throws(
    () => selectGeckoTerminalPool({ data: [poolRow()] }, mint, {
      tokenObservedAt: "2026-08-08T10:00:00Z",
      poolSelectedAt: "2026-08-08T10:02:00.001Z"
    }),
    (error) => error instanceof GeckoTerminalError && error.code === "selection-window-missed"
  );
});

test("uses earliest pool creation identity instead of later volume rank", () => {
  const earlierPool = "7ZnPcXCAp4ri8m2agMjxethtHKpiCgF4AthoAqg8io9E";
  const selected = selectGeckoTerminalPool({ data: [
    poolRow({ createdAt: "2026-08-08T10:00:50Z" }),
    poolRow({ address: earlierPool, createdAt: "2026-08-08T10:00:20Z" })
  ] }, mint, { tokenObservedAt: "2026-08-08T10:00:00Z", poolSelectedAt: "2026-08-08T10:01:00Z" });
  assert.equal(selected.pool, earlierPool);
  assert.equal(selected.providerRank, 2);
});

test("parses only valid real-trade candles and sorts them by provider timestamp", () => {
  const payload = {
    data: { attributes: { ohlcv_list: [
      [1786224120, 2, 3, 1.5, 2.5, 10],
      [1786224060, 1, 2, 0.5, 2, 5],
      [1786224000, 1, 2, 0.5, 1, 0],
      [1786224000, 0, 1, 0, 1, 4],
      [1786223940, 1, 0.5, 0.8, 1, 2]
    ] } },
    meta: { base: { address: mint }, quote: { address: quote } }
  };
  const parsed = parseGeckoTerminalOhlcv(payload, { mint, pool, tokenSide: "base", fetchedAt: "2026-08-08T22:05:00Z" });
  assert.equal(parsed.received, 5);
  assert.equal(parsed.rejected, 3);
  assert.deepEqual(parsed.observations.map((row) => row.close), [2, 2.5]);
  assert.equal(parsed.observations[0].provider, "geckoterminal");
  assert.equal(parsed.observations[0].source, "geckoterminal");
  assert.equal(parsed.observations[0].intervalSeconds, 60);
  assert.equal(parsed.observations[0].candleStartAt, "2026-08-08T21:21:00.000Z");
  assert.equal(parsed.observations[0].candleEndAt, "2026-08-08T21:22:00.000Z");
  assert.equal(parsed.observations[0].observedAt, "2026-08-08T21:22:00.000Z");
  assert.equal(parsed.observations[0].sourceUrl, `https://www.geckoterminal.com/solana/pools/${pool}`);
});

test("withholds a candle close until the interval is complete", () => {
  const payload = {
    data: { attributes: { ohlcv_list: [[1786224120, 2, 3, 1.5, 2.5, 10]] } },
    meta: { base: { address: mint }, quote: { address: quote } }
  };
  const parsed = parseGeckoTerminalOhlcv(payload, { mint, pool, tokenSide: "base", fetchedAt: "2026-08-08T21:22:30Z" });
  assert.equal(parsed.observations.length, 0);
  assert.equal(parsed.incomplete, 1);
  assert.equal(parsed.rejected, 0);
});

test("rejects OHLCV whose metadata does not prove the requested token side", () => {
  assert.throws(
    () => parseGeckoTerminalOhlcv({ data: { attributes: { ohlcv_list: [] } }, meta: { base: { address: quote } } }, { mint, pool, tokenSide: "base" }),
    (error) => error instanceof GeckoTerminalError && error.code === "token-mismatch"
  );
});

test("validates exact-mint chart orientation when the token is the pool quote", () => {
  const payload = {
    data: { attributes: { ohlcv_list: [[1786224060, 1, 2, 0.5, 2, 5]] } },
    meta: { base: { address: mint }, quote: { address: quote } }
  };
  const parsed = parseGeckoTerminalOhlcv(payload, { mint, pool, tokenSide: "quote", fetchedAt: "2026-08-08T22:05:00Z" });
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.observations[0].tokenSide, "quote");
});

test("drops a conflicting timestamp while retaining other valid candles", () => {
  const payload = {
    data: { attributes: { ohlcv_list: [
      [1786224060, 1, 2, 0.5, 2, 5],
      [1786224060, 2, 3, 1, 2.5, 6],
      [1786224120, 2, 3, 1.5, 2.5, 10]
    ] } },
    meta: { base: { address: mint }, quote: { address: quote } }
  };
  const parsed = parseGeckoTerminalOhlcv(payload, { mint, pool, tokenSide: "base", fetchedAt: "2026-08-08T22:05:00Z" });
  assert.equal(parsed.received, 3);
  assert.equal(parsed.rejected, 2);
  assert.deepEqual(parsed.observations.map(({ candleStartAt }) => candleStartAt), ["2026-08-08T21:22:00.000Z"]);
});

test("client pins version, query, and provider rate-limit failures", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => name.toLowerCase() === "retry-after" ? "3" : null },
      json: async () => ({})
    };
  };
  const client = new GeckoTerminalClient({ fetchImpl, minIntervalMs: 0, timeoutMs: 500 });
  await assert.rejects(
    client.poolForToken(mint),
    (error) => error instanceof GeckoTerminalError && error.code === "rate-limited" && error.retryAfterMs === 3000
  );
  assert.match(requests[0].url, new RegExp(`/networks/solana/tokens/${mint}/pools\\?page=1&sort=h24_volume_usd_liquidity_desc$`));
  assert.equal(requests[0].options.headers.accept, "application/json;version=20230203");
});

test("client validates bounds before contacting the provider", async () => {
  let calls = 0;
  const client = new GeckoTerminalClient({ fetchImpl: async () => { calls++; }, minIntervalMs: 0, timeoutMs: 500 });
  await assert.rejects(client.ohlcv({ mint, pool, tokenSide: "base", limit: 1001 }), /between 1 and 1000/);
  await assert.rejects(client.ohlcv({ mint, pool, tokenSide: "wrong", limit: 1 }), /base or quote/);
  assert.equal(calls, 0);
});

test("client requests documented token-info through the shared pinned-version queue", async () => {
  const requests = [];
  const payload = { data: { id: `solana_${mint}`, type: "token", attributes: { address: mint } } };
  const client = new GeckoTerminalClient({
    minIntervalMs: 0,
    timeoutMs: 500,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
    }
  });
  assert.deepEqual(await client.tokenInfo(mint), payload);
  assert.match(requests[0].url, new RegExp(`/networks/solana/tokens/${mint}/info$`));
  assert.equal(requests[0].options.headers.accept, "application/json;version=20230203");
});

test("token-info preserves quoted and unquoted percentage decimals before validation", async () => {
  const overLimit = `100.${"0".repeat(39)}1`;
  const cases = [
    { label: "quoted developer holding", field: `"developer_holding_percentage":${JSON.stringify(overLimit)}` },
    { label: "unquoted developer holding", field: `"developer_holding_percentage":${overLimit}` },
    { label: "quoted top-10 holding", field: `"holders":{"distribution_percentage":{"top_10":${JSON.stringify(overLimit)}}}` },
    { label: "unquoted top-10 holding", field: `"holders":{"distribution_percentage":{"top_10":${overLimit}}}` }
  ];

  for (const { label, field } of cases) {
    const body = `{"data":{"id":"solana_${mint}","type":"token","attributes":{"address":"${mint}",${field}}}}`;
    const client = new GeckoTerminalClient({
      minIntervalMs: 0,
      timeoutMs: 500,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => body
      })
    });
    const payload = await client.tokenInfo(mint);
    const exactValue = payload.data.attributes.developer_holding_percentage
      ?? payload.data.attributes.holders.distribution_percentage.top_10;
    assert.equal(exactValue, overLimit, `${label} lost its exact decimal representation`);
    assert.throws(
      () => parseGeckoTerminalTokenInfo(payload, { mint, fetchedAt: "2026-08-09T12:00:00Z" }),
      (error) => error instanceof RiskIdentityError && error.code === "invalid-response",
      `${label} should be rejected instead of rounding to 100`
    );
  }
});

test("client exposes a timestamped current pool snapshot without a launch-time selection claim", async () => {
  const requests = [];
  const now = Date.parse("2026-08-09T12:15:00Z");
  const client = new GeckoTerminalClient({
    now: () => now,
    minIntervalMs: 0,
    timeoutMs: 500,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [poolRow({ createdAt: "2026-08-08T10:00:30Z" })] }) };
    }
  });
  const selection = await client.currentPoolForToken(mint);
  assert.equal(selection.reserveUsd, 12_000);
  assert.equal(selection.poolSelectedAt, "2026-08-09T12:15:00.000Z");
  assert.match(requests[0], new RegExp(`/networks/solana/tokens/${mint}/pools\\?page=1&sort=h24_volume_usd_liquidity_desc$`));
});

test("shared pacing prioritizes prospective pool selection ahead of queued token info", async () => {
  let now = 1_000;
  let releaseFirst;
  let calls = 0;
  const paths = [];
  const client = new GeckoTerminalClient({
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    minIntervalMs: 6_500,
    timeoutMs: 500,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      calls++;
      if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      const isPool = new URL(url).pathname.endsWith("/pools");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        ...(isPool
          ? { json: async () => ({ data: [poolRow()] }) }
          : { text: async () => JSON.stringify({ data: { id: `solana_${mint}`, type: "token", attributes: { address: mint } } }) })
      };
    }
  });
  const firstInfo = client.tokenInfo(mint);
  await new Promise((resolve) => setImmediate(resolve));
  const queuedInfo = client.tokenInfo(mint);
  const urgentSelection = client.poolForToken(mint);
  releaseFirst();
  await Promise.all([firstInfo, queuedInfo, urgentSelection]);
  assert.match(paths[0], /\/info$/);
  assert.match(paths[1], /\/pools$/);
  assert.match(paths[2], /\/info$/);
});

test("a provider Retry-After pauses the shared request stream, not only one token", async () => {
  let now = 1_000;
  const delays = [];
  let calls = 0;
  const client = new GeckoTerminalClient({
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
    minIntervalMs: 0,
    timeoutMs: 500,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return {
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === "retry-after" ? "60" : null },
        json: async () => ({})
      };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [poolRow()] }) };
    }
  });
  await assert.rejects(client.poolForToken(mint), (error) => error.code === "rate-limited" && error.retryAfterMs === 60_000);
  const selected = await client.poolForToken(mint);
  assert.equal(selected.pool, pool);
  assert.deepEqual(delays, [60_000]);
});

test("HTTP 503 Retry-After also pauses the shared request stream", async () => {
  let now = 1_000;
  const delays = [];
  let calls = 0;
  const client = new GeckoTerminalClient({
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
    minIntervalMs: 6_500,
    timeoutMs: 500,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, headers: { get: () => "60" }, json: async () => ({}) };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [poolRow()] }) };
    }
  });
  await assert.rejects(client.poolForToken(mint), (error) => error.code === "provider-unavailable" && error.retryAfterMs === 60_000);
  await client.poolForToken(mint);
  assert.deepEqual(delays, [60_000]);
});
