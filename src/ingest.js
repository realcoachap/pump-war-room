import { classifyNarrative, momentumScore, riskScore } from "./signals.js";

export class PumpPortalIngestor {
  constructor({ url, watchTrades = false, onToken, onMigration, onStatus }) {
    Object.assign(this, { url, watchTrades, onToken, onMigration, onStatus });
    this.reconnectMs = 1_000;
    this.closed = false;
  }
  connect() {
    if (this.closed) return;
    this.onStatus?.("connecting");
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("open", () => {
      this.reconnectMs = 1_000;
      this.onStatus?.("live");
      this.ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    this.ws.addEventListener("message", (event) => this.handle(JSON.parse(event.data)));
    this.ws.addEventListener("error", () => this.onStatus?.("degraded"));
    this.ws.addEventListener("close", () => {
      this.onStatus?.("reconnecting");
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    });
  }
  handle(raw) {
    const mint = raw.mint || raw.tokenAddress;
    if (!mint) return;
    if (raw.txType === "migration" || raw.pool) return this.onMigration?.({ mint, raw });
    const token = {
      mint, name: raw.name || "Unknown", symbol: raw.symbol || "???", creator: raw.traderPublicKey || raw.creator || "unknown",
      description: raw.description || "", createdAt: new Date().toISOString(), status: "bonding",
      narrative: classifyNarrative(`${raw.name || ""} ${raw.symbol || ""} ${raw.description || ""}`),
      marketCap: Number(raw.marketCapSol || raw.marketCap || 0) * (Number(process.env.SOL_USD) || 160),
      volume5m: Number(raw.vSolInBondingCurve || raw.solAmount || 0) * (Number(process.env.SOL_USD) || 160),
      priceChange5m: 0, uniqueBuyers: 1, buyRatio: null, bondingProgress: 0,
      devHoldingPct: null, top10Pct: null, creatorRisk: null, smartWallets: 0, source: "pumpportal",
      riskConfidence: "unverified"
    };
    token.momentum = momentumScore(token); token.risk = null;
    this.onToken?.(token);
    if (this.watchTrades) this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
  }
  close() { this.closed = true; this.ws?.close(); }
}
