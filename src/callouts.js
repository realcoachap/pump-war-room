const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function normalizeBarkCallout(message) {
  const tags = message?.tags || {};
  if (tags.TYPE !== "PUMPFUN_CALLOUT" || !tags.CONTRACT_ADDRESS) return null;
  return {
    externalId: String(message._id || `${tags.CONTRACT_ADDRESS}:${message.time || Date.now()}`),
    mint: String(tags.CONTRACT_ADDRESS),
    caller: String(tags.CALLOUT_USER || "unknown"),
    name: String(tags.NAME || "Unknown"),
    symbol: String(tags.SYMBOL || "???"),
    calloutPrice: finite(tags.CALLOUT_PRICE),
    multiple: finite(tags.CALLOUT_MULTIPLE),
    maxPriceSol: finite(tags.CALLOUT_MAX_PRICE_SOL),
    marketCap: finite(tags.MARKET_CAP_USD),
    url: message.url || tags.PUMPFUN_URL || `https://pump.fun/coin/${tags.CONTRACT_ADDRESS}`,
    createdAt: new Date(Number(message.time) || Date.now()).toISOString(),
    source: "bark",
    confidence: "third-party"
  };
}

export class BarkCalloutIngestor {
  constructor({
    url = "wss://news.bark.gg/ws",
    apiKey,
    onCallout,
    onStatus,
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout
  }) {
    Object.assign(this, { url, apiKey, onCallout, onStatus });
    this.WebSocketImpl = WebSocketImpl;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.reconnectMs = 1_000;
    this.reconnectTimer = null;
    this.ws = null;
    this.closed = false;
  }
  connect() {
    if (this.closed || !this.apiKey || this.ws) return;
    this.onStatus?.("connecting");
    let socket;
    try {
      if (typeof this.WebSocketImpl !== "function") throw new TypeError("WebSocket is not available");
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.onStatus?.("degraded", { reason: "connection-failed", error });
      this._scheduleReconnect("connection-failed");
      return;
    }
    this.ws = socket;
    socket.addEventListener("open", () => {
      if (this.closed || socket !== this.ws) return;
      this.reconnectMs = 1_000;
      try {
        socket.send(`login ${this.apiKey}`);
        this.onStatus?.("live");
      } catch (error) {
        this.onStatus?.("degraded", { reason: "login-send-failed", error });
        this.ws = null;
        try { socket.close(); } catch {}
        this._scheduleReconnect("login-send-failed");
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.closed || socket !== this.ws) return;
      try {
        const callout = normalizeBarkCallout(JSON.parse(event.data));
        if (callout) this.onCallout?.(callout);
      } catch (error) { this.onStatus?.("degraded", { reason: "malformed-message", error }); }
    });
    socket.addEventListener("error", (event) => {
      if (this.closed || socket !== this.ws) return;
      this.onStatus?.("degraded", { reason: "socket-error", error: event?.error || new Error("Bark websocket error") });
    });
    socket.addEventListener("close", () => {
      if (this.closed || socket !== this.ws) return;
      this.ws = null;
      this._scheduleReconnect("socket-close");
    });
  }
  _scheduleReconnect(reason) {
    if (this.closed || this.reconnectTimer != null) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    this.onStatus?.("reconnecting", { reason, reconnectInMs: delay });
    const timer = this.setTimeoutFn(() => {
      if (this.reconnectTimer !== timer || this.closed) return;
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer = timer;
    timer?.unref?.();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer != null) this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    try { socket?.close(); } catch {}
  }
}
