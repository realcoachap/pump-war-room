import path from "node:path";

const DEFAULT_STALE_AFTER_MS = 90_000;
const MAX_LOG_STRING = 512;
const SENSITIVE_FIELD_NAME = /(?:api.?key|access.?token|refresh.?token|client.?secret|private.?key|authorization|password|secret|token|credential|cookie|session.?id)/i;

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function ageSeconds(value, nowMs) {
  const parsed = timestamp(value);
  if (parsed === null || parsed > nowMs) return null;
  return Math.floor((nowMs - parsed) / 1_000);
}

function normalizeConnectionStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "unknown";
  return status || "unknown";
}

export function observeFeed({
  mode = "demo",
  feedStatus = "unknown",
  lastMintAt = null,
  lastActivityAt = null,
  lastMessageAt = null,
  lastEventAt = null,
  observedSince = null,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = Date.now()
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid timestamp");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000) throw new RangeError("staleAfterMs must be at least 1000");

  const connectionStatus = normalizeConnectionStatus(feedStatus);
  const mintTimestamp = timestamp(lastMintAt);
  const activityTimestamp = timestamp(lastActivityAt);
  const observedSinceTimestamp = timestamp(observedSince);
  const mintTimestampState = lastMintAt == null
    ? "missing"
    : mintTimestamp === null
      ? "invalid"
      : mintTimestamp > nowMs
        ? "future"
        : "valid";
  const activityTimestampState = lastActivityAt == null
    ? "missing"
    : activityTimestamp === null
      ? "invalid"
      : activityTimestamp > nowMs
        ? "future"
        : "valid";
  const lastMintAgeSeconds = ageSeconds(lastMintAt, nowMs);
  const lastActivityAgeSeconds = ageSeconds(lastActivityAt, nowMs);
  const effectiveTimestamp = activityTimestampState === "valid"
    ? activityTimestamp
    : mintTimestampState === "valid"
      ? mintTimestamp
      : null;
  const freshnessSource = activityTimestampState === "valid"
    ? "lastActivityAt"
    : mintTimestampState === "valid"
      ? "lastMintAt"
      : observedSinceTimestamp !== null && observedSinceTimestamp <= nowMs
        ? "observationWindow"
        : null;
  const lastEventAgeSeconds = ageSeconds(lastEventAt, nowMs);
  const lastMessageAgeSeconds = ageSeconds(lastMessageAt, nowMs);
  const connected = new Set(["connected", "live"]).has(connectionStatus);
  const observationWindowExpired = connected
    && effectiveTimestamp === null
    && observedSinceTimestamp !== null
    && observedSinceTimestamp <= nowMs
    && nowMs - observedSinceTimestamp > staleAfterMs;
  const isStale = effectiveTimestamp !== null ? nowMs - effectiveTimestamp > staleAfterMs : observationWindowExpired ? true : null;

  let state;
  if (mode !== "live") state = "simulated";
  else if (!connected) state = connectionStatus;
  else if (effectiveTimestamp !== null) state = isStale ? "stale" : "live";
  else if ([mintTimestampState, activityTimestampState].includes("future")) state = "clock-skew";
  else if (observationWindowExpired) state = "stale";
  else if (mintTimestampState === "invalid" || activityTimestampState === "invalid") state = "clock-skew";
  else state = "awaiting-data";

  return {
    schemaVersion: 1,
    state,
    connectionStatus,
    freshnessBasis: "verified-feed-activity",
    freshnessSource,
    staleAfterSeconds: Math.floor(staleAfterMs / 1_000),
    isStale,
    lastMintAt: iso(lastMintAt),
    lastMintAgeSeconds,
    lastMintTimestampState: mintTimestampState,
    lastActivityAt: iso(lastActivityAt),
    lastActivityAgeSeconds,
    lastActivityTimestampState: activityTimestampState,
    lastMessageAt: iso(lastMessageAt),
    lastMessageAgeSeconds,
    observedSince: iso(observedSince),
    staleAt: freshnessSource === "lastActivityAt"
      ? new Date(activityTimestamp + staleAfterMs).toISOString()
      : freshnessSource === "lastMintAt"
        ? new Date(mintTimestamp + staleAfterMs).toISOString()
        : freshnessSource === "observationWindow"
          ? new Date(observedSinceTimestamp + staleAfterMs).toISOString()
          : null,
    lastEventAt: iso(lastEventAt),
    lastEventAgeSeconds
  };
}

export function observeService(startedAt, now = Date.now()) {
  const startedAtMs = timestamp(startedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (startedAtMs === null) throw new TypeError("startedAt must be a valid timestamp");
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid timestamp");
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000))
  };
}

function decodeMountPath(value) {
  return String(value || "")
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

function pathIsWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(parent === path.parse(parent).root ? parent : `${parent}${path.sep}`);
}

function parseMountInfo(mountInfo) {
  return mountInfo.split("\n").flatMap((line) => {
    const [beforeSeparator, afterSeparator] = line.trim().split(" - ");
    if (!beforeSeparator || !afterSeparator) return [];
    const mountFields = beforeSeparator.split(/\s+/);
    const filesystemFields = afterSeparator.split(/\s+/);
    if (!mountFields[4] || !filesystemFields[0]) return [];
    return [{
      mountPoint: path.resolve(decodeMountPath(mountFields[4])),
      filesystemType: filesystemFields[0].toLowerCase()
    }];
  });
}

const EPHEMERAL_FILESYSTEMS = new Set([
  "devtmpfs", "overlay", "proc", "ramfs", "rootfs", "squashfs", "sysfs", "tmpfs"
]);

export function observeStorage({
  databasePath,
  canonicalDatabasePath = databasePath,
  mountInfo = null,
  platform = process.platform,
  requiredMountPath = "/app/data"
} = {}) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") throw new TypeError("databasePath must be a non-empty string");
  if (typeof canonicalDatabasePath !== "string" || canonicalDatabasePath.trim() === "") throw new TypeError("canonicalDatabasePath must be a non-empty string");
  if (typeof requiredMountPath !== "string" || !path.isAbsolute(requiredMountPath)) throw new TypeError("requiredMountPath must be absolute");
  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedCanonicalDatabasePath = path.resolve(canonicalDatabasePath);
  const resolvedMountPath = path.resolve(requiredMountPath);
  const configuredForPersistence = pathIsWithin(resolvedDatabasePath, resolvedMountPath) && resolvedDatabasePath !== resolvedMountPath;
  const canonicalPathWithinRequiredMount = pathIsWithin(resolvedCanonicalDatabasePath, resolvedMountPath) && resolvedCanonicalDatabasePath !== resolvedMountPath;
  const mountInfoAvailable = platform === "linux" && typeof mountInfo === "string";
  const databaseMount = (mountInfoAvailable ? parseMountInfo(mountInfo) : [])
    .filter(({ mountPoint }) => pathIsWithin(resolvedCanonicalDatabasePath, mountPoint))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0] || null;
  const mountPointVerified = configuredForPersistence
    && canonicalPathWithinRequiredMount
    && databaseMount?.mountPoint === resolvedMountPath
    && !EPHEMERAL_FILESYSTEMS.has(databaseMount.filesystemType);
  return {
    schemaVersion: 1,
    database: "sqlite",
    requiredMountPath: resolvedMountPath,
    configuredForPersistence,
    canonicalPathWithinRequiredMount,
    mountInfoAvailable,
    mountPointVerified,
    filesystemType: databaseMount?.filesystemType || null,
    state: mountPointVerified ? "mounted" : configuredForPersistence ? "unverified" : "ephemeral-path"
  };
}

function redactString(value) {
  let redacted = String(value)
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@]+@/gi, "$1[REDACTED]@")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/((?:\\?["'])(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|password|secret|token|credential|cookie|session[_-]?id)(?:\\?["'])\s*:\s*(?:\\?["']))[^\r\n]*?((?:\\?["']))/gi, "$1[REDACTED]$2")
    .replace(/([?&](?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|password|secret|token|credential|cookie|session[_-]?id)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|password|secret|token|credential|cookie|session[_-]?id)\s*[=:]\s*)(?:bearer\s+|basic\s+)?[^\s,;}\]]+/gi, "$1[REDACTED]");
  for (const [key, secret] of Object.entries(process.env)) {
    if (!SENSITIVE_FIELD_NAME.test(key) || typeof secret !== "string" || secret.length < 8) continue;
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, MAX_LOG_STRING);
}

function safeValue(value, depth = 0) {
  if (depth > 2) return "[TRUNCATED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value ?? null;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      key,
      SENSITIVE_FIELD_NAME.test(key) ? "[REDACTED]" : safeValue(item, depth + 1)
    ]));
  }
  return redactString(value);
}

function safeError(error) {
  const value = error instanceof Error ? error : new Error(String(error || "Unknown error"));
  return {
    name: redactString(value.name || "Error"),
    message: redactString(value.message || "Unknown error"),
    ...(typeof value.code === "string" || typeof value.code === "number" ? { code: safeValue(value.code) } : {})
  };
}

export function createRuntimeTelemetry({ version, mode, startedAt = Date.now(), now = () => Date.now(), uptime = () => process.uptime(), output = console } = {}) {
  const serviceStartedAt = iso(startedAt);
  if (!serviceStartedAt) throw new TypeError("startedAt must be a valid timestamp");
  const errorsByEvent = new Map();
  let errorsTotal = 0;
  let lastErrorAt = null;
  let responsesTotal = 0;
  let responses5xx = 0;
  let last5xxAt = null;
  let readinessFailures = 0;
  let lastReadinessFailureAt = null;

  const currentIso = () => {
    const value = now();
    const parsed = value instanceof Date ? value.getTime() : Number(value);
    return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
  };

  function emit(level, event, fields = {}) {
    const record = {
      timestamp: currentIso(),
      level,
      event: redactString(event || "runtime.event"),
      message: redactString(event || "runtime.event"),
      service: "pump-war-room",
      version: safeValue(version),
      mode: safeValue(mode),
      ...safeValue(fields)
    };
    const writer = level === "error" ? output.error : level === "warn" ? output.warn : output.log;
    writer.call(output, JSON.stringify(record));
    return record;
  }

  return {
    info(event, fields) { return emit("info", event, fields); },
    warn(event, fields) { return emit("warn", event, fields); },
    error(event, error, fields = {}) {
      const recordedAt = currentIso();
      errorsTotal++;
      lastErrorAt = recordedAt;
      const eventName = redactString(event || "runtime.error");
      errorsByEvent.set(eventName, (errorsByEvent.get(eventName) || 0) + 1);
      return emit("error", eventName, { ...fields, error: safeError(error) });
    },
    recordResponse(status, { readiness = false } = {}) {
      const value = Number(status);
      responsesTotal++;
      if (Number.isFinite(value) && value >= 500) {
        if (readiness) {
          readinessFailures++;
          lastReadinessFailureAt = currentIso();
        } else {
          responses5xx++;
          last5xxAt = currentIso();
        }
      }
    },
    snapshot() {
      return {
        schemaVersion: 1,
        format: "json-lines",
        errorsTotal,
        lastErrorAt,
        errorsByEvent: Object.fromEntries([...errorsByEvent].sort(([left], [right]) => left.localeCompare(right))),
        responsesTotal,
        responses5xx,
        last5xxAt,
        readinessFailures,
        lastReadinessFailureAt
      };
    },
    service() {
      const uptimeValue = Number(uptime());
      return {
        startedAt: serviceStartedAt,
        uptimeSeconds: Number.isFinite(uptimeValue) ? Math.max(0, Math.floor(uptimeValue)) : observeService(serviceStartedAt, now()).uptimeSeconds
      };
    }
  };
}

export const FEED_STALE_AFTER_MS = DEFAULT_STALE_AFTER_MS;
