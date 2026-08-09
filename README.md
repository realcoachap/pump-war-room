# Pump War Room

Current release: **v0.6.0**

A read-only Pump.fun intelligence radar for OpenCaesar. It indexes activated onchain launches, ranks momentum and risk with inspectable heuristics, surfaces narrative velocity and graduations, emits Telegram-ready alerts, and exports curated notes to an Obsidian-compatible vault.

## Deploy to Railway

This repository is configured for Railway with a health check and Railway-provided `PORT` binding.

1. Open the repository in Railway and choose **Deploy from GitHub repo**.
2. Keep `PUMP_MODE=demo` for the safe visual demo, or set `PUMP_MODE=live` to capture every new launch and migration observed on the public PumpPortal feed.
3. Generate a public domain in the service's **Networking** settings.

Optional variables are documented in `.env.example`. Railway's local filesystem is ephemeral; attach a volume at `/app/data` and set `DB_PATH=/app/data/pump-war-room.db` if you want SQLite history to survive redeploys. Attach another volume and set `VAULT_PATH` if you want server-side Obsidian exports to persist.

## Database backup and restore verification

Create a new, verified backup while the service is running (the output file must not already exist):

```bash
npm run db:backup -- --source /app/data/pump-war-room.db --output /app/data/backups/pump-war-room-2026-08-08.db
```

The command opens the live database read-only, uses SQLite's online `VACUUM INTO` snapshot so committed WAL data is included, runs integrity/exact-schema/application-write checks, copies the artifact to a disposable restore location, verifies that copy, and only then publishes the backup with mode `0600`. It refuses same-path and overwrite attempts and prints SHA-256, byte size, schema hash, row counts, and invalid-JSON payload counts as JSON.

Re-run the restore drill on an existing artifact without touching `DB_PATH`:

```bash
npm run db:restore:verify -- --backup /app/data/backups/pump-war-room-2026-08-08.db
```

The verifier accepts only a standalone artifact and refuses candidates with `-wal`, `-shm`, or `-journal` sidecars; create a backup first instead of pointing it at the live database. Exact v0.5.1/schema-501 artifacts remain drillable: the verifier proves the original copy, migrates only its disposable restore copy to schema 600, then runs the current application write probe without changing the artifact. Budget at least twice the expected backup size in temporary free space when staging and the disposable restore copy share a filesystem, with additional headroom so live SQLite writes cannot be starved. Use `--scratch-dir /path/on/a/suitable-volume` to choose that location; disposable copies are removed after the check. This project intentionally provides no in-place production restore command: stop the service and follow a separately reviewed recovery procedure before replacing a live database. Never copy only the `.db` file from a running WAL database. A backup on the same Railway volume is not disaster recovery, so retain verified copies on separate protected storage according to your recovery policy.

## Quick look

```bash
cd /home/andres/.openclaw/workspace/projects/pump-war-room
npm run demo
```

Open <http://localhost:4173>. Demo mode generates an evolving local tape, requires no credentials, and persists data in `data/pump-war-room.db`.

## Live mode

```bash
cp .env.example .env
set -a && source .env && set +a
npm run live
```

Live mode subscribes once to PumpPortal's documented `subscribeNewToken` and `subscribeMigration` streams and stores every observed mint. Keep `WATCH_TRADES=false` until you intentionally accept the provider's trade-event pricing. `SOL_USD` can be supplied for approximate SOL-to-USD conversion.

This MVP uses public onchain events. It does not scrape undocumented Pump.fun frontend endpoints.

### Provider-observed outcome engine

Live mode also uses the free, keyless GeckoTerminal Public API v2 to discover one provider-ranked Solana pool per admitted mint and calculate descriptive 5m, 15m, 1h, 6h, and 24h outcomes from completed one-minute pool candles. The integration pins API version `20230203`, conservatively limits one shared request stream to 10 calls per minute, fixes one eligible pool from the provider's contemporaneously ranked first page, and never averages or silently splices pools.

Outcome measurement is prospective. v0.6.0 admits a fixed cohort of at most 120 PumpPortal launches observed while the engine is active, in observation order, with an eight-item work queue sized to the provider pace. Admission is persisted before provider work begins, so a crash or a full in-memory queue cannot silently remove an admitted launch from the denominator. Within GeckoTerminal's contemporaneously volume/liquidity-ranked first page (`page=1`, up to the provider's page size), the earliest-created eligible pool identity must be selected within two minutes of launch observation and must have been created from five minutes before through one minute after that observation; page and provider rank are retained as scope evidence. This is not a claim that later provider pages were searched. Current token price is not an eligibility test, so dead pools are not preferentially removed. The queue prioritizes one-call prospective pool selection before any selected pool consumes candle calls; the first candle request waits for the 5m horizon to mature. At the enforced provider pace this supports roughly ten selection attempts per minute, while excess demand remains explicit missing coverage rather than biased performance. Admitted unindexed, invalid, and queue-deferred candidates remain explicit missing evidence; late and fixed-cohort excess arrivals are exposed in admission-drop counters. The engine does not backfill older launches or use a later migration pool to manufacture historical performance.

The baseline is the first completed, nonempty candle starting at or after launch, with no more than 120 seconds of lag. Each horizon uses the last completed close at or before its target, with no more than 90 seconds of staleness. Each horizon freezes its first derived result from a baseline and target returned together in the same refresh and records that calculation timestamp. This explicit per-window provider-revision policy avoids pretending independently observed 5m/15m/1h/6h/24h windows share one immutable provider revision; prior derived results are never silently rewritten. Missing, stale, incomplete, zero-volume, mismatched-token, or unavailable data remains explicitly unavailable; it is never interpolated, forward-filled, or replaced with a current-price field. Public missing windows distinguish admission pending, immature windows, unavailable pools, expired selection, invalid responses, rate limits, provider outages, and a terminal missing baseline instead of relabeling every failure as a missing candle. Pool discovery ends when the two-minute prospective window closes, and a still-missing baseline becomes terminal after five minutes, preventing dead candidates from consuming provider capacity forever. A fixed pool that later becomes unavailable is retained and audited on the bounded six-hour cadence rather than rediscovered or retried every minute. Aggregate hit rate, median return, and maximum observed-close drawdown remain hidden until a horizon has at least three observations and 50% cohort coverage.

The database retains only derived returns/drawdown plus the minimum pool, source, timestamp, retrieval, algorithm, selection, revision, and missing-data provenance needed to explain them. GeckoTerminal evidence uses a nested, typed allowlist; provider OHLC prices, volumes, raw responses, bulk candle series, JSON/CSV-encoded substitutes, and unrecognized fields are rejected from persistence and are not proxied. The immutable token launch timestamp is retained across repeated feed updates and is overlaid onto restart work, preventing a replay from shifting an outcome denominator. Persisted due times—not the latest-token list—drive one-minute scheduling, so 6h/24h work remains reachable and completed cohorts are refreshed at least every six hours while access continues. Provider health distinguishes process-local counters from persisted attempt/success evidence, allowing a routine restart to prove a fresh prior refresh without manufacturing a new request; evidence older than 6h15m fails the deployment smoke check. Set `OUTCOME_ENRICHMENT=false` only when you intentionally need to disable this read-only enrichment worker.

SQLite database, WAL, and shared-memory files are restricted to owner-only mode `0600`. The linked production deployment uses a Railway persistent volume; [Railway's security statement](https://railway.com/security) says all data at rest in its systems is encrypted with AES-256. Encryption at rest is a deployment requirement for any environment that enables live outcome enrichment—do not move this data plane to storage without equivalent protection.

Provider data is public beta data that can be delayed, incomplete, revised, or manipulated. The product labels it **GeckoTerminal-observed pool OHLCV**, not a verified or guaranteed price. Public attribution is shown as “On-chain data provided by GeckoTerminal · Powered by CoinGecko.” The integration was reviewed against the [GeckoTerminal API guide](https://apiguide.geckoterminal.com/introduction.md), [current API schema](https://api.geckoterminal.com/docs/v2/swagger.json), [CoinGecko API Terms](https://www.coingecko.com/en/api_terms), and [attribution guide](https://brand.coingecko.com/resources/attribution-guide). If immutable raw-market-data retention becomes a requirement, obtain written provider permission or operate a separately reviewed self-indexer first.

The public [Terms of Use](/terms.html) and [Privacy Notice](/privacy.html) identify provider ownership, limitations, infrastructure processing, and data risk. If provider access or retention rights terminate, stop the service, secure-delete the selected provider from the live database with the exact confirmation guard below, and separately securely delete provider-derived backup artifacts. The command requires an existing current-schema database and exclusive access before deleting anything; a missing/typo path, active reader, failed checkpoint, or incomplete cleanup fails closed. It enables SQLite secure deletion, vacuums, verifies an empty freelist, restores WAL mode, verifies WAL truncation, and reports each scrub step. It does not claim to erase separate copies:

```bash
npm run outcomes:purge -- --provider geckoterminal --confirm DELETE-geckoterminal --database /app/data/pump-war-room.db
```

## Pump.fun Callouts

Set `BARK_API_KEY` to enable the optional read-only callout stream. The adapter connects to Bark's documented `wss://news.bark.gg/ws`, accepts only `PUMPFUN_CALLOUT` events, persists them by external event ID, and surfaces third-party provenance in the dashboard. Without a key, the rest of the War Room continues normally and the panel remains explicitly disabled. No Pump.fun JWT, wallet connection, or undocumented frontend scraping is used.

## Features

- Live/demo launch stream with local SQLite persistence
- Production uptime, verified-feed staleness, source-scoped counters, structured redacted error telemetry, and runtime mount evidence
- Railway readiness gating plus deterministic smoke checks run by release automation; both fail closed on stale/degraded feeds, version or mode disagreement, missing mount evidence, unexpected HTTP 5xx telemetry, and unsafe response headers
- Online-consistent SQLite backups plus a non-destructive disposable restore-verification drill
- Live-mode startup cleanup that removes legacy synthetic demo rows without touching verified live records or callouts
- Feed telemetry that distinguishes an open socket from verified mint activity and reports stale or malformed upstream data
- Provider-observed outcome evidence for 5m/15m/1h/6h/24h, with fixed-pool provenance, completed-candle timestamps, explicit missing reasons, hit rate, median return, observed-close drawdown, and narrative/lifecycle cohorts
- Conservative GeckoTerminal rate pacing, pinned API contract, visible GeckoTerminal/CoinGecko attribution, and derived-only persistence with raw candle retention disabled
- Caesar Intel, a zero-cost in-app analyst grounded only in the current War Room snapshot, with evidence links and no execution capabilities
- Top 100 Radar, scoped to coins observed by this War Room, with searchable ranking lenses, explicit freshness and risk confidence, and honest 5m/15m/1h/6h/24h outcome states
- Mint counters for today, 60 minutes, and 15 minutes
- Transparent momentum and risk scores—open `src/signals.js` to inspect the formula
- Mint fingerprints on every row so same-name launches cannot be mistaken for the same contract
- Risk provenance labels: synthetic demo scores are marked, and unenriched live scores remain unverified instead of implying false precision
- Optional real-time Pump.fun Callouts stream with caller, mint, callout price, multiple, max price, and market cap
- Graduation, velocity, wallet-convergence, and risk alerts
- Optional Telegram delivery with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- Coin dossiers, narrative pages, and daily briefs exported under `vault/`
- Mobile and desktop command-center UI
- Read-only deep links from every token dossier to Pump.fun, Dex Screener, and Fomo
- SSE browser updates and JSON health/snapshot APIs

## API

- `GET /api/health`
- `GET /api/snapshot`

The snapshot includes versioned `leaderboard` and `outcomes` envelopes. In live mode the leaderboard admits only validated PumpPortal mints and caps results at 100. Outcome records expose provider, fixed pool, baseline/target timestamps, staleness, returns, missing reasons, aggregate evidence thresholds, cohort summaries, retention policy, and the data-quality disclaimer. Returns remain `unavailable` until timely completed provider observations exist; the service never substitutes missing prices or inferred returns.
- `GET /api/stream` (server-sent events)
- `POST /api/agent/chat` with JSON `{ "question": "What is moving?" }`
- `POST /api/export/daily`
- `POST /api/export/coin/:mint`

## Verify

```bash
npm test
npm run screenshot
npm run smoke -- --url https://pump-war-room-production.up.railway.app --version 0.6.0 --mode live
```

Supply the expected release version explicitly for production smoke checks so a stale deployment cannot validate itself from its own package metadata.

## Safety boundary

There is no wallet connection, private-key handling, trade execution, token creation, funding, liquidity, or automated promotion code. Caesar Intel has no tools or external model access and can only summarize the bounded snapshot supplied by the server. Scores and analyst responses are research heuristics—not financial advice or a recommendation to trade.

## Known MVP limits

- “Total indexed” means the count this local database has observed; exact all-time Pump.fun totals require a historical index/backfill provider.
- Demo data is synthetic and labeled. Live trade acceleration requires `WATCH_TRADES=true` or a separate documented market-data feed.
- GeckoTerminal indexing and candles are provider-observed public-beta evidence, not an immutable archive or price guarantee. A missing pool or candle stays missing.
- Holder concentration, creator history, and smart-wallet labels need Helius/Bitquery or another verified enrichment source before they are production signals.
