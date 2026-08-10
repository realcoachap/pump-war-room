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
  if (!contentType.includes("application/json")) throw new HttpError(415, "Content-Type must be application/json");

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
  const windows = new Map();
  return (key) => {
    const timestamp = now();
    let window = windows.get(key);
    if (!window || timestamp - window.startedAt >= windowMs) window = { startedAt: timestamp, count: 0 };
    window.count++;
    windows.set(key, window);

    if (windows.size > maxKeys) {
      for (const [candidate, value] of windows) {
        if (timestamp - value.startedAt >= windowMs) windows.delete(candidate);
      }
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
    }

    const retryAfter = Math.max(1, Math.ceil((window.startedAt + windowMs - timestamp) / 1_000));
    return { allowed: window.count <= limit, remaining: Math.max(0, limit - window.count), retryAfter };
  };
}
