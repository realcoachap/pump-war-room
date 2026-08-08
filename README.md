# Pump War Room

Current release: **v0.4.0**

A read-only Pump.fun intelligence radar for OpenCaesar. It indexes activated onchain launches, ranks momentum and risk with inspectable heuristics, surfaces narrative velocity and graduations, emits Telegram-ready alerts, and exports curated notes to an Obsidian-compatible vault.

## Deploy to Railway

This repository is configured for Railway with a health check and Railway-provided `PORT` binding.

1. Open the repository in Railway and choose **Deploy from GitHub repo**.
2. Keep `PUMP_MODE=demo` for the safe visual demo, or set `PUMP_MODE=live` to capture every new launch and migration observed on the public PumpPortal feed.
3. Generate a public domain in the service's **Networking** settings.

Optional variables are documented in `.env.example`. Railway's local filesystem is ephemeral; attach a volume at `/app/data` and set `DB_PATH=/app/data/pump-war-room.db` if you want SQLite history to survive redeploys. Attach another volume and set `VAULT_PATH` if you want server-side Obsidian exports to persist.

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

## Pump.fun Callouts

Set `BARK_API_KEY` to enable the optional read-only callout stream. The adapter connects to Bark's documented `wss://news.bark.gg/ws`, accepts only `PUMPFUN_CALLOUT` events, persists them by external event ID, and surfaces third-party provenance in the dashboard. Without a key, the rest of the War Room continues normally and the panel remains explicitly disabled. No Pump.fun JWT, wallet connection, or undocumented frontend scraping is used.

## Features

- Live/demo launch stream with local SQLite persistence
- Live-mode startup cleanup that removes legacy synthetic demo rows without touching verified live records or callouts
- Feed telemetry that distinguishes an open socket from verified mint activity and reports stale or malformed upstream data
- Caesar Intel, a zero-cost in-app analyst grounded only in the current War Room snapshot, with evidence links and no execution capabilities
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
- `GET /api/stream` (server-sent events)
- `POST /api/agent/chat` with JSON `{ "question": "What is moving?" }`
- `POST /api/export/daily`
- `POST /api/export/coin/:mint`

## Verify

```bash
npm test
npm run screenshot
```

## Safety boundary

There is no wallet connection, private-key handling, trade execution, token creation, funding, liquidity, or automated promotion code. Caesar Intel has no tools or external model access and can only summarize the bounded snapshot supplied by the server. Scores and analyst responses are research heuristics—not financial advice or a recommendation to trade.

## Known MVP limits

- “Total indexed” means the count this local database has observed; exact all-time Pump.fun totals require a historical index/backfill provider.
- Demo data is synthetic and labeled. Live trade acceleration requires `WATCH_TRADES=true` or a separate documented market-data feed.
- Holder concentration, creator history, and smart-wallet labels need Helius/Bitquery or another verified enrichment source before they are production signals.
