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
  constructor({ url = "wss://news.bark.gg/ws", apiKey, onCallout, onStatus }) {
    Object.assign(this, { url, apiKey, onCallout, onStatus });
    this.reconnectMs = 1_000;
    this.closed = false;
  }
  connect() {
    if (this.closed || !this.apiKey) return;
    this.onStatus?.("connecting");
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("open", () => {
      this.reconnectMs = 1_000;
      this.ws.send(`login ${this.apiKey}`);
      this.onStatus?.("live");
    });
    this.ws.addEventListener("message", (event) => {
      try {
        const callout = normalizeBarkCallout(JSON.parse(event.data));
        if (callout) this.onCallout?.(callout);
      } catch { this.onStatus?.("degraded"); }
    });
    this.ws.addEventListener("error", () => this.onStatus?.("degraded"));
    this.ws.addEventListener("close", () => {
      if (this.closed) return;
      this.onStatus?.("reconnecting");
      setTimeout(() => this.connect(), this.reconnectMs).unref?.();
      this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    });
  }
  close() { this.closed = true; this.ws?.close(); }
}
