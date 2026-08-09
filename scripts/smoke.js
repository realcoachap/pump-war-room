#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class SmokeCheckError extends Error {
  constructor(check, message) {
    super(`${check}: ${message}`);
    this.name = "SmokeCheckError";
    this.check = check;
  }
}

function requireValue(condition, check, message) {
  if (!condition) throw new SmokeCheckError(check, message);
}

async function request(baseUrl, pathname, { timeoutMs, fetchImpl }) {
  const url = new URL(pathname, `${baseUrl}/`);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json,text/html,text/javascript" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SmokeCheckError(pathname, `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  requireValue(response.status === 200, pathname, `expected HTTP 200, received ${response.status}`);
  return {
    body,
    contentType: response.headers.get("content-type") || "",
    nosniff: response.headers.get("x-content-type-options") || "",
    status: response.status,
    url: url.toString()
  };
}

function parseJson(result, check) {
  try { return JSON.parse(result.body); }
  catch { throw new SmokeCheckError(check, "response was not valid JSON"); }
}

export async function runSmokeChecks({ baseUrl, expectedVersion, expectedMode, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  requireValue(typeof baseUrl === "string" && /^https?:\/\//.test(baseUrl), "configuration", "baseUrl must use http or https");
  requireValue(typeof expectedVersion === "string" && /^\d+\.\d+\.\d+$/.test(expectedVersion), "configuration", "expectedVersion must be semantic x.y.z");
  requireValue(["live", "demo"].includes(expectedMode), "configuration", "expectedMode must be live or demo");

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const [healthResult, snapshotResult, htmlResult, scriptResult, stylesResult, termsResult, privacyResult] = await Promise.all([
    request(normalizedBaseUrl, "/api/health", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/snapshot", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/app.js", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/styles.css", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/terms.html", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/privacy.html", { timeoutMs, fetchImpl })
  ]);
  const health = parseJson(healthResult, "health");
  const snapshot = parseJson(snapshotResult, "snapshot");
  const expectedFeedState = expectedMode === "live" ? "live" : "simulated";

  for (const [check, result, expectedType] of [
    ["health", healthResult, "application/json"],
    ["snapshot", snapshotResult, "application/json"],
    ["html", htmlResult, "text/html"],
    ["app.js", scriptResult, "text/javascript"],
    ["styles.css", stylesResult, "text/css"],
    ["terms", termsResult, "text/html"],
    ["privacy", privacyResult, "text/html"]
  ]) {
    requireValue(result.contentType.toLowerCase().includes(expectedType), check, `content-type ${result.contentType || "missing"} did not include ${expectedType}`);
    requireValue(result.nosniff.toLowerCase() === "nosniff", check, "x-content-type-options nosniff was missing");
  }

  requireValue(health.ok === true, "health", "ok was not true");
  requireValue(health.status === "healthy", "health", `status ${health.status ?? "missing"} was not healthy`);
  requireValue(health.version === expectedVersion, "health", `version ${health.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(health.mode === expectedMode, "health", `mode ${health.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(Number.isFinite(health.service?.uptimeSeconds) && health.service.uptimeSeconds >= 0, "health", "service uptime telemetry was missing");
  requireValue(Number.isFinite(health.feed?.staleAfterSeconds) && health.feed.staleAfterSeconds > 0, "health", "feed staleness threshold was missing");
  requireValue(health.feed?.state === expectedFeedState, "health", `feed state ${health.feed?.state ?? "missing"} did not match ${expectedFeedState}`);
  if (expectedMode === "live") requireValue(health.feed?.isStale === false, "health", "live feed was not explicitly fresh");
  if (expectedMode === "live") requireValue(health.storage?.mountPointVerified === true, "health", "database mount point was not verified");
  requireValue(health.telemetry?.format === "json-lines" && Number.isFinite(health.telemetry?.errorsTotal), "health", "structured error telemetry was missing");
  requireValue(health.telemetry?.responses5xx === 0, "health", `runtime recorded ${health.telemetry?.responses5xx ?? "missing"} HTTP 5xx responses`);
  requireValue(health.outcomes?.source === "geckoterminal", "health", "outcome provider identity was missing");
  const allowedOutcomeStates = expectedMode === "live"
    ? ["idle", "enriching", "pool-selected", "observing", "awaiting-data", "awaiting-pool", "awaiting-price", "baseline-unavailable", "rate-limited", "degraded", "invalid-response", "complete"]
    : ["simulation-disabled"];
  requireValue(allowedOutcomeStates.includes(health.outcomes?.status), "health", `outcome engine state ${health.outcomes?.status ?? "missing"} was not explicit`);
  requireValue(Number.isFinite(health.outcomes?.queueDepth) && health.outcomes.queueDepth >= 0, "health", "outcome queue telemetry was missing");
  if (expectedMode === "live") {
    const attemptedInRuntime = Number.isFinite(health.outcomes?.counters?.attempts) && health.outcomes.counters.attempts >= 1;
    const attemptedPersistently = Number.isFinite(health.outcomes?.persistence?.attemptCount) && health.outcomes.persistence.attemptCount >= 1;
    const succeededInRuntime = Number.isFinite(health.outcomes?.counters?.successes) && health.outcomes.counters.successes >= 1;
    const succeededPersistently = Number.isFinite(health.outcomes?.persistence?.successfulStateCount) && health.outcomes.persistence.successfulStateCount >= 1;
    requireValue(attemptedInRuntime || attemptedPersistently, "health", "outcome provider was never attempted in runtime or persisted state");
    requireValue(succeededInRuntime || succeededPersistently, "health", "outcome provider has no successful runtime or persisted refresh");
    requireValue(typeof health.outcomes?.lastSuccessAt === "string", "health", "outcome provider has no successful timestamp");
    requireValue(Number.isFinite(health.outcomes?.lastSuccessAgeSeconds) && Number.isFinite(health.outcomes?.successStaleAfterSeconds)
      && health.outcomes.lastSuccessIsStale === false, "health", "outcome provider success evidence is stale or missing");
    requireValue(Number(health.outcomes?.counters?.consecutiveFailures) <= 3, "health", "outcome provider has repeated consecutive failures");
  }

  requireValue(snapshot.version === expectedVersion, "snapshot", `version ${snapshot.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(snapshot.mode === expectedMode, "snapshot", `mode ${snapshot.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(snapshot.status === "healthy", "snapshot", `status ${snapshot.status ?? "missing"} was not healthy`);
  requireValue(snapshot.feed?.freshnessBasis === "verified-feed-activity", "snapshot", "verified feed freshness evidence was missing");
  requireValue(snapshot.feed?.state === expectedFeedState, "snapshot", `feed state ${snapshot.feed?.state ?? "missing"} did not match ${expectedFeedState}`);
  if (expectedMode === "live") requireValue(snapshot.feed?.isStale === false, "snapshot", "live feed was not explicitly fresh");
  if (expectedMode === "live") requireValue(snapshot.storage?.mountPointVerified === true, "snapshot", "database mount point was not verified");
  requireValue(Number.isFinite(snapshot.service?.uptimeSeconds), "snapshot", "service uptime was missing");
  requireValue(snapshot.outcomes?.schemaVersion === 1, "snapshot", "outcome engine schema was missing");
  requireValue(snapshot.outcomes?.revisionPolicy === "first-observed-derived-value-per-window-provider-revision", "snapshot", "per-window provider revision policy was missing");
  requireValue(snapshot.outcomes?.source?.id === "geckoterminal" && snapshot.outcomes.source.apiVersion === "20230203", "snapshot", "pinned GeckoTerminal source evidence was missing");
  requireValue(snapshot.outcomes?.source?.rawResponsesPersisted === false && snapshot.outcomes?.source?.rawCandlesPersisted === false
    && snapshot.outcomes?.source?.providerOhlcvValuesPersisted === false, "snapshot", "provider retention boundary was missing");
  requireValue(snapshot.outcomes?.sampling?.policy === "prospective-fixed-admission-v1"
    && snapshot.outcomes.sampling.cohortLimit === 120 && snapshot.outcomes.sampling.selectionDeadlineSeconds === 120
    && snapshot.outcomes.sampling.poolDiscoveryScope?.includes("page=1")
    && snapshot.outcomes.sampling.selectionPriority === "unselected launches before candle retrieval",
  "snapshot", "prospective outcome sampling policy was missing");
  requireValue(!/"(?:open|high|low|close|volume)":/.test(JSON.stringify(snapshot.outcomes)), "snapshot", "persisted provider OHLCV values leaked into the public outcome contract");
  for (const window of ["5m", "15m", "1h", "6h", "24h"]) {
    const metric = snapshot.outcomes?.summary?.windows?.[window];
    requireValue(metric && ["sufficient-evidence", "insufficient-evidence"].includes(metric.status), "snapshot", `${window} outcome summary status was missing`);
    requireValue(Number.isFinite(metric.evidenceCount) && Number.isFinite(metric.missingCount), "snapshot", `${window} outcome coverage counts were missing`);
    if (metric.status === "sufficient-evidence") {
      requireValue(Number.isFinite(metric.hitRatePct) && Number.isFinite(metric.medianReturnPct) && Number.isFinite(metric.maximumDrawdownPct), "snapshot", `${window} measured outcome metrics were invalid`);
    } else {
      requireValue(metric.hitRatePct === null && metric.medianReturnPct === null && metric.maximumDrawdownPct === null, "snapshot", `${window} insufficient evidence was presented as performance`);
    }
  }
  requireValue(Array.isArray(snapshot.outcomes?.cohorts?.narrative?.cohorts) && Array.isArray(snapshot.outcomes?.cohorts?.lifecycle?.cohorts), "snapshot", "outcome cohort contracts were missing");
  for (const entry of snapshot.leaderboard?.top100 || []) {
    for (const window of ["5m", "15m", "1h", "6h", "24h"]) {
      const outcome = entry?.outcome?.windows?.[window];
      requireValue(outcome && ["observed", "unavailable"].includes(outcome.status), "snapshot", `${window} leaderboard outcome status was invalid`);
      if (outcome.status === "observed") requireValue(Number.isFinite(outcome.returnPct) && outcome.source === "geckoterminal"
        && typeof outcome.observedAt === "string" && typeof outcome.calculatedAt === "string", "snapshot", `${window} observed outcome evidence was incomplete`);
      else requireValue(typeof outcome.reason === "string" && outcome.reason.length > 0, "snapshot", `${window} missing-data reason was absent`);
    }
  }

  requireValue(htmlResult.body.includes(`<meta name="application-version" content="${expectedVersion}">`), "html", "release version marker was missing");
  requireValue(htmlResult.body.includes("NO WALLET · NO EXECUTION"), "html", "read-only safety marker was missing");
  requireValue(htmlResult.body.includes('data-release-marker="provider-observed-outcome-engine"') && htmlResult.body.includes("On-chain data provided by GeckoTerminal") && htmlResult.body.includes("Powered by CoinGecko"), "html", "outcome engine attribution marker was missing");
  requireValue(scriptResult.body.includes("renderFeedObservability"), "app.js", "feed observability UI marker was missing");
  requireValue(scriptResult.body.includes("renderOutcomes") && scriptResult.body.includes("raw candle retention off"), "app.js", "outcome engine UI marker was missing");
  requireValue(stylesResult.body.includes(".outcome-source,footer{font-size:10px}"), "styles.css", "minimum-size provider attribution style was missing");
  requireValue(termsResult.body.includes("CoinGecko API Terms") && termsResult.body.includes("not verified prices"), "terms", "provider ownership or data-risk terms were missing");
  requireValue(privacyResult.body.includes("Minimal data by design") && privacyResult.body.includes("does not persist or expose bulk GeckoTerminal responses"), "privacy", "privacy and retention notice was missing");

  return {
    ok: true,
    baseUrl: normalizedBaseUrl,
    version: expectedVersion,
    mode: expectedMode,
    health: {
      status: health.status,
      feedState: health.feed.state,
      uptimeSeconds: health.service.uptimeSeconds,
      errorsTotal: health.telemetry.errorsTotal,
      responses5xx: health.telemetry.responses5xx,
      outcomeState: health.outcomes.status
    },
    http: { health: 200, snapshot: 200, html: 200, appJs: 200, styles: 200, terms: 200, privacy: 200 },
    markers: { version: true, readOnly: true, observability: true, outcomeEngine: true, legalNotices: true }
  };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!["--url", "--version", "--mode", "--timeout-ms"].includes(argument)) throw new SmokeCheckError("configuration", `unknown argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new SmokeCheckError("configuration", `${argument} requires a value`);
    values[argument.slice(2)] = value;
  }
  return values;
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const args = parseArgs(process.argv.slice(2));
  const result = await runSmokeChecks({
    baseUrl: args.url || process.env.SMOKE_BASE_URL || "http://127.0.0.1:4173",
    expectedVersion: args.version || process.env.EXPECTED_VERSION || packageJson.version,
    expectedMode: args.mode || process.env.EXPECTED_MODE || "demo",
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 10_000
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const result = { ok: false, check: error?.check || "smoke", error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
}
