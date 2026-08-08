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
  const [healthResult, snapshotResult, htmlResult, scriptResult] = await Promise.all([
    request(normalizedBaseUrl, "/api/health", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/api/snapshot", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/", { timeoutMs, fetchImpl }),
    request(normalizedBaseUrl, "/app.js", { timeoutMs, fetchImpl })
  ]);
  const health = parseJson(healthResult, "health");
  const snapshot = parseJson(snapshotResult, "snapshot");
  const expectedFeedState = expectedMode === "live" ? "live" : "simulated";

  for (const [check, result, expectedType] of [
    ["health", healthResult, "application/json"],
    ["snapshot", snapshotResult, "application/json"],
    ["html", htmlResult, "text/html"],
    ["app.js", scriptResult, "text/javascript"]
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

  requireValue(snapshot.version === expectedVersion, "snapshot", `version ${snapshot.version ?? "missing"} did not match ${expectedVersion}`);
  requireValue(snapshot.mode === expectedMode, "snapshot", `mode ${snapshot.mode ?? "missing"} did not match ${expectedMode}`);
  requireValue(snapshot.status === "healthy", "snapshot", `status ${snapshot.status ?? "missing"} was not healthy`);
  requireValue(snapshot.feed?.freshnessBasis === "verified-feed-activity", "snapshot", "verified feed freshness evidence was missing");
  requireValue(snapshot.feed?.state === expectedFeedState, "snapshot", `feed state ${snapshot.feed?.state ?? "missing"} did not match ${expectedFeedState}`);
  if (expectedMode === "live") requireValue(snapshot.feed?.isStale === false, "snapshot", "live feed was not explicitly fresh");
  if (expectedMode === "live") requireValue(snapshot.storage?.mountPointVerified === true, "snapshot", "database mount point was not verified");
  requireValue(Number.isFinite(snapshot.service?.uptimeSeconds), "snapshot", "service uptime was missing");

  requireValue(htmlResult.body.includes(`<meta name="application-version" content="${expectedVersion}">`), "html", "release version marker was missing");
  requireValue(htmlResult.body.includes("NO WALLET · NO EXECUTION"), "html", "read-only safety marker was missing");
  requireValue(scriptResult.body.includes("renderFeedObservability"), "app.js", "feed observability UI marker was missing");

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
      responses5xx: health.telemetry.responses5xx
    },
    http: { health: 200, snapshot: 200, html: 200, appJs: 200 },
    markers: { version: true, readOnly: true, observability: true }
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
