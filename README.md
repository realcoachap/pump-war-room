# Pump War Room

Current release: **v0.10.4**

A read-only Pump.fun intelligence radar for OpenCaesar. It indexes observed launches, orders them by supported evidence or observation recency, measures provider-observed outcomes, exposes risk-factor evidence, reports bounded anonymous early-actor observations, and resolves exact mints through a review-gated canonical identity graph without presenting an uncalibrated probability or trade signal.

The additive [v0.10 Canonical Identity Graph roadmap](V0.10_CANONICAL_IDENTITY_ROADMAP.md) ships the persistent review ledger, deterministic proposal engine, local curator workflow, public read-only resolver, and dossier/coverage UI. It keeps every exact mint distinct until reviewed evidence explicitly groups variants. This release does not satisfy or weaken the separate v1.0 evidence gate.

## Deploy to Railway

This repository is configured for Railway with a health check and Railway-provided `PORT` binding.

1. Open the repository in Railway and choose **Deploy from GitHub repo**.
2. Keep `PUMP_MODE=demo` for the safe visual demo, or set `PUMP_MODE=live` to capture every new launch and migration observed on the public PumpPortal feed.
3. Generate a public domain in the service's **Networking** settings.

Optional variables are documented in `.env.example`. Railway's local filesystem is ephemeral; attach a volume at `/app/data` and set `DB_PATH=/app/data/pump-war-room.db` if you want SQLite history to survive redeploys. Filesystem-writing HTTP vault exports are disabled in every mode.

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

The verifier accepts only a standalone artifact and refuses candidates with `-wal`, `-shm`, or `-journal` sidecars; create a backup first instead of pointing it at the live database. Exact v0.5.1/schema-501, v0.6/schema-600, v0.7/schema-700, v0.8.0/schema-800, v0.8.1/schema-801, initial v0.9/schema-900, and v0.9.1–v0.9.5/schema-901 artifacts remain drillable: the verifier proves the original copy, migrates only its disposable restore copy to schema 902, then runs the current application write probe without changing the artifact. The current probe verifies actor privacy and retention plus identity entities, variants, relationships, proposals, append-only decisions, and allowlisted evidence. Budget at least twice the expected backup size in temporary free space when staging and the disposable restore copy share a filesystem, with additional headroom so live SQLite writes cannot be starved. Use `--scratch-dir /path/on/a/suitable-volume` to choose that location; disposable copies are removed after the check. This project intentionally provides no in-place production restore command: stop the service and follow a separately reviewed recovery procedure before replacing a live database. Never copy only the `.db` file from a running WAL database. A backup on the same Railway volume is not disaster recovery, so retain verified copies on separate protected storage according to your recovery policy.

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

Live mode subscribes once to PumpPortal's documented free `subscribeNewToken` and `subscribeMigration` streams and stores every observed mint. It does not subscribe to PumpPortal's metered token-trade stream, create or fund a linked wallet, or spend SOL. Pump's declared creator and transaction user/deployer remain private evidence; every public API, SSE event, UI, analyst response, and export replaces those values with installation-scoped opaque Actor numbers. The feed's `vSolInBondingCurve` is labeled virtual SOL reserve and `solAmount` is labeled create-transaction SOL amount; neither is relabeled as five-minute volume, curve progress, or migration proof.

`SOL_USD` is optional. When absent, the app withholds a USD market-cap conversion instead of using a guessed exchange rate; when present, it labels the conversion as locally derived from the feed's SOL-denominated market cap and the operator-supplied rate.

This MVP uses public onchain events. It does not scrape undocumented Pump.fun frontend endpoints.

### Provider-observed outcome engine

Live mode also uses the free, keyless GeckoTerminal Public API v2 to discover one provider-ranked Solana pool per admitted mint and calculate descriptive 5m, 15m, 1h, 6h, and 24h outcomes from completed one-minute pool candles. The integration pins API version `20230203`, conservatively limits one shared request stream to 10 calls per minute, fixes one eligible pool from the provider's contemporaneously ranked first page, and never averages or silently splices pools.

Outcome measurement is prospective. v0.6.0 admits a fixed cohort of at most 120 PumpPortal launches observed while the engine is active, in observation order, with an eight-item work queue sized to the provider pace. Admission is persisted before provider work begins, so a crash or a full in-memory queue cannot silently remove an admitted launch from the denominator. Within GeckoTerminal's contemporaneously volume/liquidity-ranked first page (`page=1`, up to the provider's page size), the earliest-created eligible pool identity must be selected within two minutes of launch observation and must have been created from five minutes before through one minute after that observation; page and provider rank are retained as scope evidence. This is not a claim that later provider pages were searched. Current token price is not an eligibility test, so dead pools are not preferentially removed. The queue prioritizes one-call prospective pool selection before any selected pool consumes candle calls; the first candle request waits for the 5m horizon to mature. At the enforced provider pace this supports roughly ten selection attempts per minute, while excess demand remains explicit missing coverage rather than biased performance. Admitted unindexed, invalid, and queue-deferred candidates remain explicit missing evidence; late and fixed-cohort excess arrivals are exposed in admission-drop counters. The engine does not backfill older launches or use a later migration pool to manufacture historical performance.

The baseline is the first completed, nonempty candle starting at or after launch, with no more than 120 seconds of lag. Each horizon uses the last completed close at or before its target, with no more than 90 seconds of staleness. Each horizon freezes its first derived result from a baseline and target returned together in the same refresh and records that calculation timestamp. This explicit per-window provider-revision policy avoids pretending independently observed 5m/15m/1h/6h/24h windows share one immutable provider revision; prior derived results are never silently rewritten. Missing, stale, incomplete, zero-volume, mismatched-token, or unavailable data remains explicitly unavailable; it is never interpolated, forward-filled, or replaced with a current-price field. Public missing windows distinguish admission pending, immature windows, unavailable pools, expired selection, invalid responses, rate limits, provider outages, and a terminal missing baseline instead of relabeling every failure as a missing candle. Pool discovery ends when the two-minute prospective window closes, and a still-missing baseline becomes terminal after five minutes, preventing dead candidates from consuming provider capacity forever. A fixed pool that later becomes unavailable is retained and audited on the bounded six-hour cadence rather than rediscovered or retried every minute. Aggregate hit rate, median return, and maximum observed-close drawdown remain hidden until a horizon has at least three observations and 50% cohort coverage.

The database retains only derived returns/drawdown plus the minimum pool, source, timestamp, retrieval, algorithm, selection, revision, and missing-data provenance needed to explain them. GeckoTerminal evidence uses a nested, typed allowlist; provider OHLC prices, volumes, raw responses, bulk candle series, JSON/CSV-encoded substitutes, and unrecognized fields are rejected from persistence and are not proxied. The immutable token launch timestamp is retained across repeated feed updates and is overlaid onto restart work, preventing a replay from shifting an outcome denominator. Persisted due times—not the latest-token list—drive one-minute scheduling, so 6h/24h work remains reachable and completed cohorts are refreshed at least every six hours while access continues. Provider health distinguishes process-local counters from persisted attempt/success evidence, allowing a routine restart to prove a prior refresh without manufacturing a new request. Success-age staleness is demand-aware: a quiet interval before the next persisted horizon is due remains healthy, while evidence older than 6h15m fails the deployment smoke check once scheduled provider work is due. Set `OUTCOME_ENRICHMENT=false` only when you intentionally need to disable this read-only enrichment worker.

SQLite database, WAL, and shared-memory files are restricted to owner-only mode `0600`. The linked production deployment uses a Railway persistent volume; [Railway's security statement](https://railway.com/security) says all data at rest in its systems is encrypted with AES-256. Encryption at rest is a deployment requirement for any environment that enables live outcome enrichment—do not move this data plane to storage without equivalent protection.

Provider data is public beta data that can be delayed, incomplete, revised, or manipulated. The product labels it **GeckoTerminal-observed pool OHLCV**, not a verified or guaranteed price. Public attribution is shown as “On-chain data provided by GeckoTerminal · Powered by CoinGecko.” The integration was reviewed against the [GeckoTerminal API guide](https://apiguide.geckoterminal.com/introduction.md), [current API schema](https://api.geckoterminal.com/docs/v2/swagger.json), [CoinGecko API Terms](https://www.coingecko.com/en/api_terms), and [attribution guide](https://brand.coingecko.com/resources/attribution-guide). If immutable raw-market-data retention becomes a requirement, obtain written provider permission or operate a separately reviewed self-indexer first.

The public [Terms of Use](/terms.html) and [Privacy Notice](/privacy.html) identify provider ownership, limitations, infrastructure processing, and data risk. If provider access or retention rights terminate, stop the service, secure-delete the selected provider from the live database with the exact confirmation guard below, and separately securely delete provider-derived backup artifacts. The command requires an existing current-schema database and exclusive access before deleting anything; a missing/typo path, active reader, failed checkpoint, or incomplete cleanup fails closed. It enables SQLite secure deletion, vacuums, verifies an empty freelist, restores WAL mode, verifies WAL truncation, and reports each scrub step. It does not claim to erase separate copies:

```bash
npm run outcomes:purge -- --provider geckoterminal --confirm DELETE-geckoterminal --database /app/data/pump-war-room.db
```

### Risk and identity evidence

v0.7.0 reuses the same singleton, conservatively paced GeckoTerminal client but maintains an independent fixed prospective risk cohort of at most 120 launches. It does not reuse or backfill the already-full v0.6 outcome cohort: new PumpPortal observations are durably admitted while the v0.7 worker is active, with a 20-minute replay-age ceiling, and the dashboard keeps those cohort rows inspectable after they leave the latest-token tape. Token info is attempted no earlier than 15 minutes after launch. Missing or stale evidence gets at most one retry about one hour later; a weaker retry cannot erase stronger earlier factors. This is bounded one-time acquisition, not an ongoing freshness promise, so each factor's fetch/observation timestamp is authoritative. The provider contract is pinned to API version `20230203`. GeckoTerminal describes this public-beta data as not vetted by CoinGecko, so the UI says **provider observed**, never on-chain verified.

v0.7.1 accepts bounded provider-observed representation drift without broadening the retained data contract: decimal-string percentages and exact official X/Telegram profile or X-post paths normalize into the same private exact-match domain as their direct forms.

v0.7.2 separates parser revision provenance from the unchanged fingerprint method/hash domain. Token-info transport preserves the exact JSON source decimal for the two percentage fields; quoted and unquoted decimals are bounded before numeric conversion and rejected when their exact mathematical value exceeds 100. A tested, explicitly non-exhaustive platform-navigation policy rejects known non-profile routes in direct, URL, and X-post forms; known route digests already retained by v0.7.1 are excluded from duplicate aggregation without exposing the normalized identifiers. The first 16 mints in the fixed cohort form the deterministic current-parser audit sample. Successful and failed audit dispositions are persisted separately from the ordinary two-attempt schedule, so restarts neither rotate through the remainder of the cohort nor repeatedly select the same failures. Stronger earlier factors remain authoritative, with separate successful-audit provenance when a weaker current parse succeeds and explicit attempt provenance when an audit fails.

Production smoke requires all 120 fixed-cohort states and 120 unique inspectable observations, reconciled persisted/public coverage, at least 50% successful acquisition coverage, and no more than 25% latest parser-invalid acquisitions. It also requires the 16-row parser sample to have a complete current-revision disposition and at least one successful current-parser acquisition. A fresh process-local success proves the initial rollout; after a routine restart, the same gate accepts the complete persisted sample rather than manufacturing an otherwise impossible request.

The separate `risk_identity_enrichment` table retains only allowlisted scalars, minimal pool provenance, and domain-separated SHA-256 digests: holder count, GeckoTerminal-reported top-10 distribution, provider-reported developer holding, provider update/fetch times, a current provider-ranked page-1 pool reserve snapshot, and digests derived from normalized declared X, Telegram, registrable website-domain, and name/symbol values. The reserve is timestamped when fetched—never presented as launch-time liquidity—and is not locked-liquidity evidence. The normalized identifiers themselves are not retained. The ingestion parser rejects raw responses, descriptions, images, provider prices/volumes, opaque provider scores, honeypot labels, and unrecognized fields. Public snapshot rows expose factor values, bounded acquisition failure states, and duplicate counts, not stored digests, raw errors, or raw provider profiles. Provider purge removes matching outcome/risk rows and provider-derived material events, alerts, and frozen briefs before verified secure deletion and vacuuming.

Exact matching is deliberately narrow: X and Telegram handles are case-folded; URLs use the WHATWG parser, IDNA normalization, and the open-source `tldts` public/private suffix list (`allowPrivateDomains: true`) to compare registrable domains; names and symbols use NFKC/case-fold normalization. The headline identity-reuse count includes only exact declared X, Telegram, or registrable-domain matches. Name/symbol collisions are disclosed separately as low-confidence content warnings. Equality proves identifier or registrable-domain reuse only, not duplicate content. It does **not** establish a shared controller, fraud, maliciousness, or safety. Creator/deployer-user history counts only launches observed prospectively in the fixed cohort by this deployment and identifies which role was counted; it is not an all-time chain history. A provider developer address contributes only when it exactly matches an observed creator/deployer identity. Provider-reported developer holding is not verified creator identity. Top-10 methodology and custody exclusions are unpublished and may include curve or liquidity custody. GeckoTerminal pool reserve is shown as provider-observed reserve, not locked liquidity.

Evidence classes are explicit: `on-chain-finalized`, `provider-observed`, `feed-observed-processed`, `locally-derived`, and `unavailable`. A PumpPortal migration frame is labeled processed-feed evidence and no longer forces 100% curve progress or a finalized graduation claim. Missing factors stay unknown. v0.7.0 publishes no probability-like composite risk score and makes no risk-based leaderboard adjustment because no labeled holdout calibration exists.

### Canonical Identity Graph

v0.10.4 includes the schema 902 reviewed-identity release and its v0.10.1 durability cap. It also retains the v0.10.2 dashboard layout, persistent section navigation, collapsible method disclosures, and dedicated `/help.html` tutorial and FAQ. Every valid mint resolves immediately through `GET /api/v1/entities/resolve?mint=...`; an unreviewed mint remains its own singleton. Reviewed entities can name `official`, `migration`, or `relaunch` variants, while reviewed relationships are limited to `same-creator`, `same-narrative`, `probable-copycat`, or `name-collision`. A primary mint can be explicitly reviewed or withheld when ambiguous. It always means identity resolution only—not authenticity, safety, quality, or a recommendation.

v0.10.4 is a release-verification patch. Strict smoke checks measure cached token-integrity calculations and rate-limit reset windows against the time each HTTP response was received, so later endpoint traversal cannot make earlier valid evidence appear stale or expired. Regression tests advance the verifier clock between paginated and post-call responses, and smoke fixtures now derive their expected version from the canonical package metadata instead of a duplicate release literal. This changes no provider, dependency, schema, intelligence, ranking, alert, connector, execution, promotion, wallet, or retention scope.

Entity intelligence is additive and denominator-preserving. Only reviewed variants can group, while every pending or unreviewed proposal remains an exact-mint singleton with no ranking impact. Each entity trend has at most one exact-mint contributor: a grouped entity requires the explicitly reviewed primary when observed or the sole reviewed registered variant when observed; an unreviewed singleton contributes only its own exact mint and remains separate. Ambiguous multi-variant entities with no primary withhold trend metrics; variant volume is never summed and a high-volume clone is never selected merely because it is high volume. Each envelope publishes included and excluded exact mints, missing narrative/lifecycle/volume counts, the representative-selection reason, and explicit proposal/ranking boundaries. The dashboard and analyst use these entity envelopes while legacy mint-level leaderboard, outcome, and snapshot records remain intact.

The unauthenticated read-only identity API now has stable entity-ID cursor pages, strict decoded-32-byte mint validation, process-global per-instance fixed-window limits, standard limit headers, aggregate health counters, and no external API keys. See `/api.html` or the same-origin OpenAPI 3.1 document at `/api/v1/openapi.json`. Snapshot, list, resolver, and local-analyst attempts use separate shared buckets. Limits reset on process restart and do not coordinate across replicas; they are service abuse bounds rather than authentication or per-user quotas.

The reviewed projection publishes at most 500 whole entities, 2,000 variants, and 5,000 semantic-distinct relationships. It never splits an entity to fit a cap, never relabels a known reviewed mint as an unreviewed singleton, and exposes eligible, published, omitted, integrity-omission, and observed-mint omission counts. Current observed reviewed owners are prioritized. The resolver independently caps semantic-distinct incident relationships at 100 and reports included/eligible coverage. Legacy malformed identity or token rows are quarantined from public projections and surfaced as integrity counters; new writes reject them transactionally.

The bounded proposal worker compares metadata already present in the authorized local feed. Exact normalized name/symbol or narrative matches become deterministic, locally derived proposals; they never mutate reviewed facts, select a primary mint, affect ranking, or appear as verified edges. Each refresh and the persisted pending backlog are capped at 500; stale pending rows are pruned while accepted, rejected, and superseded review records remain retained. Public surfaces are read-only. Operator review requires direct local access to an existing SQLite database:

```bash
npm run identity:status -- --database /app/data/pump-war-room.db
npm run identity:proposals -- --database /app/data/pump-war-room.db --status pending --limit 100
npm run identity:decide -- --database /app/data/pump-war-room.db --proposal identity-proposal:... --decision reject --decision-id decision:... --reason-code reviewed-not-related
npm run identity:import -- --database /app/data/pump-war-room.db --file reviewed-identity.json
```

An import document contains bounded `entities` and `relationships` arrays. Each entry wraps the validated `entity` or `relationship` plus its append-only `decision`; malformed, duplicate, unregistered, or credential-bearing evidence fails closed. Back up the database before importing reviewed facts.

### Actionable intelligence

v0.8.0 adds a read-only action layer over retained evidence. URL parameters encode the active leaderboard search and filters. Up to 50 watched mints and 12 named filter lenses are stored in versioned browser `localStorage`, with bounded JSON export/import and failure-safe fallback when storage is blocked or corrupt. These preferences are origin-local, unauthenticated, clearable, and not cross-device. They never become a server-side account and do not control Telegram delivery.

v0.8.1 corrects the v0.8 release gates. Outcome-provider freshness is demand-aware, so a legitimate quiet interval before the next persisted horizon is due stays healthy while overdue work still fails closed. Measured closed briefs use method v2, exclude migrated legacy and non-source alerts from their material and Telegram denominators, and supersede rather than rewrite frozen v1 rows. Exact score occurrences replace hourly recurrence suppression. Telegram delivery consistently accepts numeric chat IDs or official `@channelusername` destinations, and schema 801 plus the restore probe enforce a due time for every pending/retrying outbox row.

Coin dossiers now work for older retained mints outside the latest tape. Each dossier can load a cursor-paginated, allowlisted discrete timeline of launch/update observations, sanitized factor evidence, material changes, third-party callouts, and newly measured outcome windows. Timelines are not continuous prices and contain no interpolation or raw provider payloads. The compare endpoint accepts two to four unique exact Solana mints, returns explicit missing rows and unavailable cells, and keeps uncalibrated risk factors out of rank.

Materiality policy v1 emits every simultaneous supported change: comparable numeric radar-score changes of at least 15 points; first/crossing 50% top-10 concentration or a change of at least 10 percentage points; first/crossing 12% developer holding or a change of at least 5 percentage points; first exact declared-identifier reuse; the prospective creator/deployer count crossing from one to at least two; and the first processed-feed migration observation. `null → number` is evidence becoming available, never a score increase. Risk factors are named observations, not a composite or calibrated probability. Migration wording remains “processed-feed observation; finalization unverified.” Versioned event keys include the full evidence occurrence timestamp, so an exact replay is deduplicated without suppressing a legitimate later recurrence. Existing v0.7 evidence and a durable initialization marker are committed together during upgrade instead of manufacturing historical alerts. Thereafter factor events, alerts, and any Telegram outbox row commit atomically; if risk acquisition commits immediately before a crash, the retained prior material baseline makes startup evaluation recover the pending change.

Telegram delivery is an explicit operator opt-in using the already-supported `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; the destination may be a numeric chat ID or an official `@channelusername`, matching the Bot API `sendMessage` contract. Production remains fully functional when either value is absent or malformed. Alerts are inserted atomically into a durable SQLite outbox, serialized at no more than one send per second per configured chat, resume after restart, and honor Bot API `retry_after` (with a 60-second fallback for a malformed 429). Ambiguous network, malformed-success, and HTTP 5xx results receive four bounded exponential retries before the fifth attempt dead-letters; ordinary permanent HTTP 4xx failures dead-letter immediately. Bot API sends are at-least-once because Telegram provides no client idempotency key, so each message includes a short event ID for duplicate recognition. Messages are bounded below 4096 characters, disable link previews with the current `link_preview_options` contract, attribute provider evidence, and link back to the read-only public dossier. Credentials, destination identifiers, dedupe keys, per-message identifiers, and per-alert delivery attempts are not exposed; public health reports aggregate delivery state only. Browser watchlists do not subscribe or target this operator-wide channel. Configure the bot privacy-policy link through BotFather before enabling public recipients, offer the documented opt out/deletion path, and do not use alerts for unsolicited promotion. No Telegram Mini App or blockchain action is used.

Daily briefs cover the last closed UTC day `[00:00Z, next 00:00Z)`; weekly briefs cover Monday-to-Monday UTC. The first schema/method-keyed model for each period is frozen in SQLite with its data cutoff, and reruns return that retained model rather than overwriting history. Closed-brief method v2 excludes pre-policy `legacy` rows and alerts outside the requested PumpPortal source from both material counts and Telegram delivery counts; any frozen v1 row is retained as an artifact but superseded by a new v2 key. Briefs expose launches, migration observations, material events by kind, factor events by evidence class, Telegram status counts, cohort admissions, all five outcome `n/N` denominators and missing reasons, suppression gates, and the prior period with both denominators. A literal zero is distinct from `null`/unavailable. Feed coverage is explicitly `unmeasured`, so briefs make no period-completeness or market-wide rate claim. Daily and weekly measured models can be rendered to Markdown under `vault/`; provider attribution and fixed-cohort scope remain attached.

No new SaaS, charting package, ORM, bot framework, account system, or paid provider was introduced. The implementation uses URL state, browser storage, native SQLite, the existing direct Bot API transport, and existing GeckoTerminal/PumpPortal evidence. Provider permission must be re-reviewed before persisting or redistributing any broader history than these bounded derived observations.

### Anonymous early-actor intelligence

v0.9.0 adds an isolated, prospective cohort of at most 32 exact PumpPortal mints. At 2, 10, and 30 minutes after each admitted launch, a conservatively paced reader asks Solana's documented public mainnet RPC for at most 16 finalized signatures referencing that mint and inspects at most eight in-window transactions per attempt. A buy or sell is accepted only when the transaction succeeded, the exact mint changed in the instruction-designated signed user token account, and the instruction matches the reviewed official Pump or PumpSwap discriminator, complete account-role contract, fixed programs, and derivable PDA/ATA addresses. The decoded instruction token amount must exactly equal the designated account's balance delta in the required direction. Exact-input and newer v2 variants whose arguments do not provide that auditable output amount remain explicitly unavailable. A generic or transaction-wide token-balance delta, transfer, mint, burn, liquidity action, unsupported variant or program, malformed transaction, missing signer, or contradictory delta is rejected rather than inferred as a trade.

v0.9.1 hardens that evidence and privacy boundary. Actor evidence is pinned to account-bound parser revision `official-pump-account-bound-v3`; upgrading preserves the installation secret and stable Actor labels while clearing evidence collected under an earlier parser revision. The RPC parser accepts canonical headerless `jsonParsed` account-role metadata while enforcing signer and lookup-source ordering, and repeated acquisition of the same finalized evidence deduplicates without rewriting its original observation time. Explicit public-response allowlists and recursive release smoke checks reject raw wallet, signer, account, profile, signature, and hidden provenance material; backup verification also binds each actor payload mint to its canonical table key. Retention cleanup is time-driven, and attempted, pending, terminal, and disabled-worker telemetry must reconcile so untouched future admissions cannot dilute the 25% attempted-mint failure cap. This patch adds no scoring, alerts, execution, promotion, wallet, connector, provider, or dependency scope.

v0.9.2 repairs the prospective actor source contract after Pump's documented April 28 fee-recipient upgrade changed the live remaining-account layouts. Parser revision `official-pump-current-fee-layout-v4` strictly binds the current Pump buy 18-account and sell 16/17-account forms plus the PumpSwap buy 25–27-account and sell 23–26-account forms: bonding-curve-v2 or pool-v2 PDAs, optional cashback accumulators, the official buyback-recipient allowlist, and the exact quote-token ATA must all reconcile. Audited standard buys may use the observed 24-byte compatibility form or the current 25-byte form; exact-input and v2 variants that cannot meet the existing amount-integrity proof remain explicitly unavailable. Instruction-designated token deltas must still reconcile to the actor owner, while transaction-wide privilege elevation in composite transactions is not misreported as an instruction-role mismatch. A revision change preserves the installation secret and Actor labels while clearing the exhausted v3 cohort, and bounded rejection-reason counters now distinguish parser-invalid evidence from legitimate missing evidence. These counters describe bounded inspections and can include repeated finalized transactions across scheduled attempts; they do not claim a unique-transaction denominator. An attempt with bounded transactions but no validated observation and at least one invalid transaction is recorded as `invalid-response` instead of a false successful completion. Live release smoke now requires at least one accepted observation under the current parser revision, so a fresh or explicitly disabled worker cannot validate this parser release before exercising it. The patch adds no dependency, connector, ranking, alert, execution, promotion, or wallet scope.

v0.9.3 repairs restart-safe outcome refreshes when a current GeckoTerminal candle response no longer contains the originally retained baseline minute. The merge keeps the first observed durable baseline, preserves every first-observed outcome window, and recomputes the record status from the merged baseline and windows for the zero, partial, and complete cases. This prevents a valid sparse provider revision from entering an endless degraded retry loop while continuing to withhold missing returns and provider values. The patch changes no provider, cohort, ranking, alert, connector, execution, promotion, wallet, or retention scope.

v0.9.4 hardens public delivery without changing intelligence, provider, cohort, ranking, alert, connector, execution, promotion, wallet, or retention scope. Live mode now rejects every filesystem-writing vault export before snapshot or path lookup, and the live UI does not present those local operator controls. Browser snapshot fetches use one abortable scheduler with a 15-second post-completion cooldown, a bounded trailing refresh, a 10-second fetch deadline, and one EventSource lifecycle instead of downloading a full snapshot for every event; if EventSource construction fails, the periodic snapshot fallback remains active. Large JSON responses use standards-compatible gzip when accepted; the current production-shaped snapshot compresses by more than 95%. Live health and snapshot responses explicitly disclose that readiness covers verified feed freshness plus mounted storage—not release eligibility, calibration, backup, or recovery—while demo mode identifies its simulated feed basis and does not claim mount verification.

v0.9.5 repairs the optional Bark callout connector when its WebSocket emits an error without a matching close event. The connector invalidates and closes only the current failed socket, schedules one bounded exponential-backoff reconnect, ignores stale follow-up events, and still cancels pending retries during shutdown. The patch adds no provider, callout-data, ranking, alert, execution, promotion, wallet, retention, or dependency scope.

v1.0.0 remains gated until at least 30 days of trustworthy live data after the repaired and hardened path, calibrated outcomes, monitoring, verified backups, and documented recovery. Deployment age alone does not satisfy that gate.

The default public mainnet RPC is keyless, rate-limited, and explicitly not production-grade. Acquisition is therefore best-effort, partial, and unmeasured; rate limits, gaps, missing transactions, and invalid responses remain visible. The worker never backfills launches from before it became active. PumpPortal's metered token-trade stream stays disabled because it requires a funded linked wallet and spend, and its response-frame fields are not documented in the official material reviewed for this release. The worker pins the reviewed `https://api.mainnet.solana.com` origin; changing providers requires a separately reviewed code change rather than an arbitrary environment URL. Set `EARLY_ACTOR_ENRICHMENT=false` to disable the worker without affecting the rest of the War Room.

An installation-random 32-byte secret maps each observed wallet through a domain-separated keyed digest to a stable `Actor N` label. Raw wallet addresses, transaction signatures, source payloads, and reversible lookup mappings are not persisted in actor tables or exposed publicly. Each minimized observation stores a domain-separated keyed dedupe digest derived from internal transaction provenance; it cannot be used for public lookup, is never returned by an endpoint, and expires with that observation. Minimized normalized observations are retained for at most 72 hours, with independent time-driven cleanup and a global 4,096-row prune bound; aggregate per-mint summaries remain auditable after observation expiry. Backup/restore verification proves that the installation secret—and therefore Actor labels—survives a recovery drill without exposing the secret.

Per-coin metrics remain unavailable until at least five validated events from at least three opaque actors have complete source timestamps. Eligible summaries show launch-relative timing, unique actor count, repeat buys/sells, defensible observed buy-to-later-sell duration pairs, sampled token-amount concentration, and one-minute activity bursts. Amount concentration is not holder concentration or current holdings. Correlations remain withheld until at least 20 eligible mints and 60% acquisition coverage, and even then require a separately reviewed labeled holdout calibration. Actor evidence is byte-invariant to leaderboard rank, risk factors, material alerts, Telegram text, analyst recommendations, and trade guidance.

The public wording is deliberately neutral: **early actor**, **activity evidence**, and **activity burst**. The release makes no claim of real-world identity, smart money, insider status, bot behavior, coordination, intent, skill, safety, risk probability, recommendation, or trade signal. Pump.fun and Fomo live platform connectors remain disabled unless an official API, authorized export, user-supplied lawful export, or written permission defines fields, rates, retention, attribution, and display rights.

## Third-party Bark observations

Set `BARK_API_KEY` to enable the optional read-only callout stream. The adapter connects to Bark's documented `wss://news.bark.gg/ws`, accepts only `PUMPFUN_CALLOUT` events, deduplicates them by an internal external-event key, replaces the source profile with an opaque installation-scoped Actor number, and surfaces neutral third-party provenance in the dashboard. New v0.9 records do not persist the raw source profile, and startup sanitizes legacy Bark callout/event payloads. Without a key, the rest of the War Room continues normally and the panel remains explicitly disabled. No Pump.fun JWT, wallet connection, or undocumented frontend scraping is used.

## v0.9 connector authorization

The [v0.9 connector plan](V0.9_CONNECTOR_PLAN.md) records each source's permission gate. Fomo denied authorized API, webhook, export, and external-integration access under support ticket `#123208746`, so Fomo feed ingestion is closed and disabled. The Pump.fun request remains pending. Ordinary outbound token-page links do not ingest source data.

## Features

- Live/demo launch stream with local SQLite persistence
- Production uptime, verified-feed staleness, source-scoped counters, structured redacted error telemetry, and runtime mount evidence
- Railway readiness fails closed on stale/degraded feeds or missing mount evidence and explicitly limits its status basis to feed freshness plus mounted storage. It does not claim release eligibility, calibration, backup, or recovery verification. Deterministic release smoke separately enforces version/mode agreement, zero observed HTTP 5xx responses, safe response headers, complete fixed-cohort risk coverage, bounded parser-invalid acquisitions, current-parser audit evidence, at least one accepted current-parser early-actor observation, and no more than 25% failed early-actor acquisition among mints whose attempts have actually begun; untouched future admissions cannot hide attempted failures
- Online-consistent SQLite backups plus a non-destructive disposable restore-verification drill
- Live-mode startup cleanup that removes legacy synthetic demo rows without touching verified live records or callouts
- Feed telemetry that distinguishes an open socket from verified mint activity and reports stale or malformed upstream data
- Provider-observed outcome evidence for 5m/15m/1h/6h/24h, with fixed-pool provenance, completed-candle timestamps, explicit missing reasons, hit rate, median return, observed-close drawdown, and narrative/lifecycle cohorts
- Conservative GeckoTerminal rate pacing, pinned API contract, visible GeckoTerminal/CoinGecko attribution, and derived-only persistence with raw candle retention disabled
- Caesar Intel, a zero-cost in-app analyst grounded only in the current War Room snapshot, with evidence links and no execution capabilities
- Top 100 Radar, scoped to coins observed by this War Room, with searchable ranking lenses, explicit freshness and evidence classes, and honest 5m/15m/1h/6h/24h outcome states
- Mint counters for today, 60 minutes, and 15 minutes
- Evidence scores are withheld when momentum and buyer breadth are unavailable; those rows are explicitly ordered by observation recency, while uncalibrated risk factors remain excluded from score and order
- Mint fingerprints on every row so same-name launches cannot be mistaken for the same contract
- Provider-observed holder/developer evidence, locally derived exact-identity duplicate counts, prospective creator/deployer history, pool-reserve and feed-observed virtual-SOL evidence, and explicit unknowns
- Anonymous early-actor panels backed by bounded finalized official-program instruction evidence, explicit source/coverage/missing states, keyed Actor labels, short raw-observation retention, and no downstream score or alert impact
- Optional real-time third-party Bark observations with opaque source-actor labels, mint, callout price, multiple, max price, and market cap
- Versioned material score/factor/identity/creator-history and processed-migration alerts with explicit null semantics, replay dedupe, and recurrence-safe evidence keys
- Optional restart-safe, rate-limited Telegram Bot API delivery with aggregate-only public health; no bot credentials or destination identifiers are persisted
- Browser-local watchlists and saved URL filter lenses with bounded JSON portability; no anonymous server-side or cross-device account claim
- Deep-linkable retained coin dossiers, typed cursor timelines, and explicit 2–4 mint evidence comparison
- Frozen closed-UTC daily and weekly measured briefs with current/prior denominators, suppression gates, and unmeasured feed coverage
- Mobile and desktop command-center UI
- Read-only deep links from every token dossier to Pump.fun, Dex Screener, and Fomo
- SSE browser updates and JSON health/snapshot APIs
- Coalesced browser refreshes plus a process-local immutable five-second computed-snapshot cache and gzip negotiation for large JSON responses; filesystem-writing HTTP vault routes and controls are disabled in every mode

## API

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/v1/entities?limit=20&cursor=<opaque-cursor>` (`limit` 1–100)
- `GET /api/v1/entities/resolve?mint=<mint>`
- `GET /api/v1/openapi.json` and human-readable `/api.html`

The snapshot includes versioned `leaderboard`, `outcomes`, `riskIntelligence`, `actionIntelligence`, `earlyActorIntelligence`, aggregate `identityRegistry`, and additive `entityIntelligence` envelopes. In live mode the leaderboard admits only validated PumpPortal mints and caps results at 100. Its numeric score is `null` when a row has no substantive momentum or buyer-breadth input, with `orderingBasis` disclosing recency fallback. Outcome records expose provider, fixed pool, baseline/target timestamps, staleness, returns, missing reasons, aggregate evidence thresholds, cohort summaries, retention policy, and the data-quality disclaimer. Returns remain `unavailable` until timely completed provider observations exist; the service never substitutes missing prices or inferred returns. Risk/identity rows expose normalized factor values, evidence classes, source fields, bounded failure states, duplicate counts, scope, and limitations without public fingerprints or a composite probability. Canonical resolution returns the exact mint, entity/variant, primary-selection reason, reviewed relationships, separate pending proposals, and explicit limitations. Entity intelligence discloses exact-mint denominators and a no-sum contributor policy without changing mint ranking. Action intelligence exposes browser-local preference limits, materiality rules, aggregate outbox health, timeline/compare contracts, and the frozen daily/weekly models without secrets or raw provider histories. Early-actor intelligence exposes only aggregate prospective-cohort acquisition state and gated per-mint summaries; there is no actor lookup endpoint.
- `GET /api/stream` (server-sent events)
- `GET /api/coins/:mint`
- `GET /api/coins/:mint/timeline?limit=50&before=<cursor>` (`limit` 1–200)
- `GET /api/compare?mints=<mint>,<mint>` (2–4 unique exact mints)
- `GET /api/briefs/daily`
- `GET /api/briefs/weekly`
- `POST /api/agent/chat` with JSON `{ "question": "What is moving?" }`
Legacy `POST /api/export/daily`, `/api/export/weekly`, and `/api/export/coin` requests fail closed with HTTP `403` and the bounded JSON code `vault-export-disabled` before snapshot lookup or vault access in every mode. They are deliberately excluded from the public OpenAPI contract.

Trusted local operators can still render retained public coin data or a frozen measured brief without an HTTP write surface:

```bash
npm run vault:export -- coin --database ./data/pump-war-room.db --vault ./vault --mint SOLANA_MINT
npm run vault:export -- brief --database ./data/pump-war-room.db --vault ./vault --period daily
```

## Verify

```bash
npm test
npm run screenshot
npm run smoke -- --url https://pump-war-room-production.up.railway.app --version 0.10.4 --mode live
```

Supply the expected release version explicitly for production smoke checks so a stale deployment cannot validate itself from its own package metadata.

## Safety boundary

There is no wallet connection, private-key handling, trade execution, token creation, funding, liquidity action, or automated promotion code. Caesar Intel has no tools or external model access and can only summarize the bounded snapshot supplied by the server. Rankings, factors, outcomes, and analyst responses are observational research—not financial advice, safety claims, or a recommendation to trade.

## Known MVP limits

- “Total indexed” means the count this local database has observed; exact all-time Pump.fun totals require a historical index/backfill provider.
- Demo data is synthetic and labeled. Live trade acceleration requires a separately reviewed documented market-data feed; creation frames do not contain a five-minute traded-volume window.
- GeckoTerminal indexing and candles are provider-observed public-beta evidence, not an immutable archive or price guarantee. A missing pool or candle stays missing.
- GeckoTerminal holder/developer fields are provider observations with unpublished methodology, not finalized on-chain proofs. Exact full holder aggregation, creator-event history, and finalized migration validation require an approved production Solana RPC/indexer and pinned program decoders.
- Live PumpPortal create/migration rows normally lack comparable numeric radar inputs, so score-change alerts often remain unavailable. This is disclosed rather than replaced with guessed momentum.
- Browser-local watchlists are intentionally not authenticated or cross-device. Operator Telegram delivery is intentionally independent, best-effort, and at-least-once.
- Closed-period briefs cover this deployment and fixed cohorts only. Feed coverage is unmeasured, and historical cohort removals/deduplicated suppression counts remain unavailable rather than being presented as zero.
- Public Solana RPC early-actor reads are prospective, bounded, rate-limited, and incomplete. Missing or rejected transactions stay unavailable, and sampled activity never implies complete wallet history, coordination, current holdings, or identity.
