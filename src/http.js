import { gzipSync } from "node:zlib";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function acceptsGzip(value) {
  let wildcardWeight = null;
  for (const entry of String(value || "").split(",")) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";").map((part) => part.trim());
    if (coding !== "gzip" && coding !== "*") continue;
    const quality = parameters.find((parameter) => /^q\s*=/.test(parameter));
    const weight = quality ? Number(quality.replace(/^q\s*=\s*/, "")) : 1;
    const acceptedWeight = Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
    if (coding === "gzip") return acceptedWeight > 0;
    wildcardWeight = acceptedWeight;
  }
  return wildcardWeight !== null && wildcardWeight > 0;
}

export function encodeJsonResponse(value, { acceptEncoding, compressionThreshold = 1_024 } = {}) {
  if (!Number.isSafeInteger(compressionThreshold) || compressionThreshold < 0) {
    throw new TypeError("compressionThreshold must be a non-negative safe integer");
  }
  const uncompressed = Buffer.from(JSON.stringify(value));
  const headers = { "content-length": String(uncompressed.length) };
  if (uncompressed.length < compressionThreshold) return { body: uncompressed, headers, compressed: false };

  headers.vary = "Accept-Encoding";
  if (!acceptsGzip(acceptEncoding)) return { body: uncompressed, headers, compressed: false };
  const body = gzipSync(uncompressed, { level: 6 });
  return {
    body,
    headers: { ...headers, "content-encoding": "gzip", "content-length": String(body.length) },
    compressed: true
  };
}

export async function readJsonBody(req, { maxBytes = 2_048 } = {}) {
  const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
  const mediaType = contentType.split(";", 1)[0].trim();
  if (mediaType !== "application/json") throw new HttpError(415, "Content-Type must be application/json");

  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new HttpError(413, "Request body is too large");

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "Request body is required");

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
    return value;
  } catch {
    throw new HttpError(400, "Request body must be a valid JSON object");
  }
}

export function createRateLimiter({ limit = 20, windowMs = 60_000, maxKeys = 1_000, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("rate limit must be a positive safe integer");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new TypeError("rate windowMs must be a safe integer of at least 1000");
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError("rate maxKeys must be a positive safe integer");
  if (typeof now !== "function") throw new TypeError("rate now must be a function");
  const windows = new Map();
  const counters = { requests: 0, allowed: 0, rejected: 0, evictedKeys: 0 };
  const pruneExpired = (timestamp) => {
    for (const [candidate, value] of windows) {
      if (timestamp - value.startedAt >= windowMs && windows.delete(candidate)) counters.evictedKeys++;
    }
  };
  const check = (key) => {
    const timestamp = now();
    pruneExpired(timestamp);
    let window = windows.get(key);
    if (!window) window = { startedAt: timestamp, count: 0 };
    window.count++;
    windows.set(key, window);
    counters.requests++;

    if (windows.size > maxKeys) {
      while (windows.size > maxKeys) {
        if (windows.delete(windows.keys().next().value)) counters.evictedKeys++;
      }
    }

    const retryAfter = Math.max(1, Math.ceil((window.startedAt + windowMs - timestamp) / 1_000));
    const resetAtUnix = Math.ceil((window.startedAt + windowMs) / 1_000);
    const allowed = window.count <= limit;
    counters[allowed ? "allowed" : "rejected"]++;
    return { allowed, limit, remaining: Math.max(0, limit - window.count), retryAfter, resetAtUnix };
  };
  check.snapshot = () => {
    pruneExpired(now());
    return Object.freeze({
      schemaVersion: 1,
      policy: "process-local-fixed-window-v1",
      limit,
      windowSeconds: windowMs / 1_000,
      maxKeys,
      activeKeys: windows.size,
      ...counters
    });
  };
  return check;
}

export function createConcurrencyGuard({ limit = 64 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("concurrency limit must be a positive safe integer");
  let activeConnections = 0;
  let acceptedConnections = 0;
  let rejectedConnections = 0;
  const acquire = () => {
    if (activeConnections >= limit) {
      rejectedConnections++;
      return null;
    }
    activeConnections++;
    acceptedConnections++;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      activeConnections--;
      return true;
    };
  };
  acquire.snapshot = () => Object.freeze({
    schemaVersion: 1,
    policy: "process-local-concurrent-connection-cap-v1",
    limit,
    activeConnections,
    acceptedConnections,
    rejectedConnections
  });
  return acquire;
}

export function broadcastBoundedSse(clients, chunk, { maxBufferedBytes = 65_536 } = {}) {
  if (!(clients instanceof Map)) throw new TypeError("SSE clients must be a Map");
  if (typeof chunk !== "string" || !chunk) throw new TypeError("SSE chunk must be a non-empty string");
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1_024) {
    throw new TypeError("SSE maxBufferedBytes must be a safe integer of at least 1024");
  }
  let delivered = 0;
  let dropped = 0;
  for (const [client, release] of clients) {
    let accepted = false;
    try { accepted = client.write(chunk) !== false && Number(client.writableLength || 0) <= maxBufferedBytes; }
    catch {}
    if (accepted) {
      delivered++;
      continue;
    }
    clients.delete(client);
    if (typeof release === "function") release();
    try { client.destroy?.(); } catch {}
    dropped++;
  }
  return { delivered, dropped };
}
