import { classifyNarrative, momentumScore } from "./signals.js";

const NEW_TOKEN_TYPES = new Set(["create", "creation", "new-token", "new_token", "newtoken"]);
const MIGRATION_TYPES = new Set(["migrate", "migrated", "migration"]);
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const eventType = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const publicKey = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return SOLANA_ADDRESS_PATTERN.test(normalized) ? normalized : null;
};
const nonNegativeNumber = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Classify only event types that PumpPortal identifies or that contain legacy
 * creation metadata. A `pool` field is deliberately not a migration signal:
 * current `create` frames also include `pool: "pump"`.
 */
export function classifyPumpPortalEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const transactionType = eventType(raw.txType);
  if (NEW_TOKEN_TYPES.has(transactionType)) return "new-token";
  if (MIGRATION_TYPES.has(transactionType)) return "migration";
  if (transactionType) return null; // buy/sell and other transaction events

  const explicitType = eventType(raw.eventType || raw.event || raw.type || raw.method || raw.status);
  if (NEW_TOKEN_TYPES.has(explicitType)) return "new-token";
  if (MIGRATION_TYPES.has(explicitType) || raw.isMigration === true || raw.migrated === true) return "migration";
  if (explicitType) return null;

  // Backwards compatibility for callers that pass a creation payload without
  // txType (including the original public handle() contract).
  if (raw.mint || raw.tokenAddress) {
    if (raw.name != null || raw.symbol != null || raw.uri != null || raw.bondingCurveKey != null) return "new-token";
  }
  return null;
}

export class PumpPortalIngestor {
  constructor({
    url,
    watchTrades = false,
    onToken,
    onMigration,
    onStatus,
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
    connectTimeoutMs = 15_000,
    now = () => Date.now()
  }) {
    if (watchTrades) throw new RangeError("PumpPortal trade subscriptions are disabled: this service has no approved metered trade-data contract");
    Object.assign(this, { url, watchTrades: false, onToken, onMigration, onStatus });
    this.WebSocketImpl = WebSocketImpl;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1_000) throw new RangeError("connectTimeoutMs must be at least 1000");
    this.connectTimeoutMs = connectTimeoutMs;
    this.now = now;
    this.reconnectMs = 1_000;
    this.reconnectTimer = null;
    this.reconnectToken = null;
    this.connectTimer = null;
    this.ws = null;
    this.closed = false;

    this.statusName = "idle";
    this.connectionStatus = "idle";
    this.activityStatus = "unverified";
    this.statusReason = "not-started";
    this.reconnectInMs = null;
    this.statusChangedAt = null;
    this.lastConnectedAt = null;
    this.lastMessageAt = null;
    this.lastActivityAt = null;
    this.lastTokenAt = null;
    this.lastMigrationAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.counters = {
      connectionAttempts: 0,
      connectionsOpened: 0,
      connectionTimeouts: 0,
      reconnectsScheduled: 0,
      socketErrors: 0,
      sendErrors: 0,
      messagesReceived: 0,
      malformedMessages: 0,
      ignoredMessages: 0,
      newTokens: 0,
      migrations: 0
    };
  }

  connect() {
    if (this.closed || ["connecting", "connected", "degraded"].includes(this.connectionStatus)) return;
    this._cancelReconnect();
    this.connectionStatus = "connecting";
    this.activityStatus = "waiting";
    this.counters.connectionAttempts++;
    this._emitStatus("connecting", { reason: "connection-attempt" });

    let socket;
    try {
      if (typeof this.WebSocketImpl !== "function") throw new TypeError("WebSocket is not available");
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this._recordError(error);
      this.connectionStatus = "degraded";
      this._emitStatus("degraded", { reason: "connection-failed" });
      this._scheduleReconnect("connection-failed");
      return;
    }

    this.ws = socket;
    socket.addEventListener("open", () => this._onOpen(socket));
    socket.addEventListener("message", (event) => this._onMessage(socket, event));
    socket.addEventListener("error", (event) => this._onError(socket, event));
    socket.addEventListener("close", (event) => this._onClose(socket, event));
    this._scheduleConnectTimeout(socket);
  }

  handle(raw) {
    return this._handle(raw, this._timestamp());
  }

  _handle(raw, observedAt) {
    const kind = classifyPumpPortalEvent(raw);
    const mint = raw && typeof raw === "object" ? publicKey(raw.mint || raw.tokenAddress) : null;
    if (!kind || !mint) {
      this.counters.ignoredMessages++;
      return;
    }

    if (kind === "migration") {
      this.counters.migrations++;
      this.lastMigrationAt = observedAt;
      const result = this.onMigration?.({ mint, raw, observedAt });
      this._recordActivity(observedAt, "migration");
      return result;
    }

    const solUsd = Number(process.env.SOL_USD);
    const marketCapSol = nonNegativeNumber(raw.marketCapSol ?? raw.marketCap);
    const curveSol = nonNegativeNumber(raw.vSolInBondingCurve);
    const launchSolAmount = nonNegativeNumber(raw.solAmount);
    const token = {
      ingestSchemaVersion: 2,
      mint,
      name: raw.name || "Unknown",
      symbol: raw.symbol || "???",
      // Pump's declared creator and the transaction user/deployer are distinct
      // identities.  The declared creator need not sign, so never substitute
      // the traderPublicKey when creator is absent.
      creator: publicKey(raw.creator),
      deployer: publicKey(raw.user ?? raw.traderPublicKey),
      createdAt: observedAt,
      status: "bonding",
      narrative: classifyNarrative(`${raw.name || ""} ${raw.symbol || ""} ${raw.description || ""}`),
      marketCap: marketCapSol !== null && Number.isFinite(solUsd) && solUsd > 0
        ? marketCapSol * solUsd
        : null,
      marketCapSol,
      marketCapEvidence: Number.isFinite(solUsd) && solUsd > 0
        ? { evidenceClass: "locally-derived", basis: "feed-market-cap-sol-times-operator-sol-usd", solUsd }
        : { evidenceClass: "unavailable", basis: "operator-sol-usd-not-configured", solUsd: null },
      // Create frames do not contain a five-minute traded-volume window.
      // vSolInBondingCurve is curve inventory and solAmount is the creation
      // transaction amount; neither is labelled as volume.
      volume5m: null,
      curveSol,
      launchSolAmount,
      priceChange5m: null,
      uniqueBuyers: null,
      buyRatio: null,
      bondingProgress: null,
      devHoldingPct: null,
      top10Pct: null,
      creatorRisk: null,
      smartWallets: null,
      source: "pumpportal",
      riskConfidence: "unavailable"
    };
    token.momentum = momentumScore(token);
    token.risk = null;

    this.counters.newTokens++;
    this.lastTokenAt = observedAt;
    this.onToken?.(token);
    this._recordActivity(observedAt, "new-token");

  }

  getStatus() {
    return {
      status: this.statusName,
      connectionStatus: this.connectionStatus,
      activityStatus: this.activityStatus,
      verifiedActivity: this.activityStatus === "verified",
      reason: this.statusReason,
      reconnectInMs: this.reconnectInMs,
      statusChangedAt: this.statusChangedAt,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastActivityAt: this.lastActivityAt,
      lastTokenAt: this.lastTokenAt,
      lastMigrationAt: this.lastMigrationAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      counters: { ...this.counters }
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._cancelConnectTimeout();
    this._cancelReconnect();
    const socket = this.ws;
    this.ws = null;
    this.connectionStatus = "closed";
    this.activityStatus = "stopped";
    this._emitStatus("closed", { reason: "explicit-close" });
    try { socket?.close(); } catch (error) { this._recordError(error); }
  }

  _onOpen(socket) {
    if (this.closed || socket !== this.ws) return;
    this._cancelConnectTimeout();
    this.reconnectMs = 1_000;
    this.connectionStatus = "connected";
    this.activityStatus = "waiting";
    this.lastConnectedAt = this._timestamp();
    this.counters.connectionsOpened++;
    this._emitStatus("connected", { reason: "socket-open" });
    this._send({ method: "subscribeNewToken" }, socket);
    this._send({ method: "subscribeMigration" }, socket);

  }

  _onMessage(socket, event) {
    if (this.closed || socket !== this.ws) return;
    const observedAt = this._timestamp();
    this.counters.messagesReceived++;
    this.lastMessageAt = observedAt;
    let raw;
    try {
      raw = this._parseMessage(event?.data);
    } catch (error) {
      this.counters.malformedMessages++;
      this._recordError(error, observedAt);
      this._emitStatus("degraded", { reason: "malformed-message" });
      return;
    }
    this._handle(raw, observedAt);
  }

  _onError(socket, event) {
    if (this.closed || socket !== this.ws) return;
    this._cancelConnectTimeout();
    this.counters.socketErrors++;
    this.connectionStatus = "degraded";
    this._recordError(event?.error || new Error("PumpPortal websocket error"));
    this._emitStatus("degraded", { reason: "socket-error" });
    this.ws = null;
    try { socket.close(); } catch {}
    this._scheduleReconnect("socket-error");
  }

  _onClose(socket, event) {
    if (this.closed || socket !== this.ws) return;
    this._cancelConnectTimeout();
    this.ws = null;
    const reason = event?.code ? `socket-close-${event.code}` : "socket-close";
    this._scheduleReconnect(reason);
  }

  _recordActivity(observedAt, kind) {
    this.lastActivityAt = observedAt;
    this.activityStatus = "verified";
    if (["connected", "degraded"].includes(this.connectionStatus)) {
      this.connectionStatus = "connected";
      if (this.statusName !== "live") this._emitStatus("live", { reason: `${kind}-activity` });
    }
  }

  _parseMessage(data) {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
    if (ArrayBuffer.isView(data)) return JSON.parse(new TextDecoder().decode(data));
    if (data && typeof data === "object") return data;
    return JSON.parse(String(data));
  }

  _send(payload, socket = this.ws) {
    if (this.closed || !socket || socket !== this.ws) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.counters.sendErrors++;
      this._recordError(error);
      this._emitStatus("degraded", { reason: "subscription-send-failed" });
      return false;
    }
  }

  _scheduleReconnect(reason) {
    if (this.closed || this.reconnectTimer != null) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    this.connectionStatus = "reconnecting";
    this.activityStatus = "waiting";
    this.counters.reconnectsScheduled++;
    this._emitStatus("reconnecting", { reason, reconnectInMs: delay });

    const reconnectToken = Symbol("pumpportal-reconnect");
    this.reconnectToken = reconnectToken;
    const timer = this.setTimeoutFn(() => {
      if (this.closed || this.reconnectToken !== reconnectToken) return;
      this.reconnectTimer = null;
      this.reconnectToken = null;
      this.connect();
    }, delay);
    this.reconnectTimer = timer;
    timer?.unref?.();
  }

  _scheduleConnectTimeout(socket) {
    this._cancelConnectTimeout();
    const timer = this.setTimeoutFn(() => {
      if (this.connectTimer !== timer) return;
      this.connectTimer = null;
      if (this.closed || socket !== this.ws || this.connectionStatus !== "connecting") return;
      this.ws = null;
      this.connectionStatus = "degraded";
      this.counters.connectionTimeouts++;
      this._recordError(new Error("PumpPortal websocket open timed out"));
      this._emitStatus("degraded", { reason: "connection-timeout" });
      try { socket.close(); } catch {}
      this._scheduleReconnect("connection-timeout");
    }, this.connectTimeoutMs);
    this.connectTimer = timer;
    timer?.unref?.();
  }

  _cancelConnectTimeout() {
    if (this.connectTimer != null) this.clearTimeoutFn(this.connectTimer);
    this.connectTimer = null;
  }

  _cancelReconnect() {
    this.reconnectToken = null;
    if (this.reconnectTimer != null) this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  _recordError(error, observedAt = this._timestamp()) {
    this.lastErrorAt = observedAt;
    this.lastError = error instanceof Error ? error.message : String(error || "Unknown error");
  }

  _emitStatus(status, { reason = null, reconnectInMs = null } = {}) {
    this.statusName = status;
    this.statusReason = reason;
    this.reconnectInMs = reconnectInMs;
    this.statusChangedAt = this._timestamp();
    this.onStatus?.(status, this.getStatus());
  }

  _timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
}
