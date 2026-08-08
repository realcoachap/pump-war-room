import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createDemoToken, tickDemoToken } from "./demo.js";
import { PumpPortalIngestor } from "./ingest.js";
import { BarkCalloutIngestor } from "./callouts.js";
import { exportCoin, exportDaily } from "./vault.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const port = Number(process.env.PORT || 4173);
const mode = process.env.PUMP_MODE === "live" ? "live" : "demo";
const dbPath = path.resolve(root, process.env.DB_PATH || "data/pump-war-room.db");
const vaultPath = path.resolve(root, process.env.VAULT_PATH || "vault");
const store = new Store(dbPath);
const cleanup = mode === "live" ? store.purgeDemoData() : { tokens: 0, events: 0, alerts: 0 };
const clients = new Set();
let feedStatus = mode === "demo" ? "simulated" : "connecting";
let calloutStatus = process.env.BARK_API_KEY ? "connecting" : "disabled";
let lastEventAt = new Date().toISOString();
let lastMintAt = null;
let reconnects = 0;
let feedMessages = 0;
let feedParseErrors = 0;

function feedHealth() {
  if (mode === "demo") return "simulated";
  if (!["live", "connected"].includes(feedStatus)) return feedStatus;
  if (!lastMintAt) return "awaiting-data";
  return Date.now() - new Date(lastMintAt).getTime() > 90_000 ? "stale" : "live";
}

const send = (kind, payload) => {
  lastEventAt = new Date().toISOString();
  const chunk = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(chunk);
};

function alertFor(token, previous) {
  let alert = null;
  if (token.status === "graduated" && previous?.status !== "graduated") {
    alert = { level: "hot", title: "Graduated", message: `${token.symbol} reached migration`, mint: token.mint };
  } else if (token.momentum >= 78 && (!previous || previous.momentum < 78)) {
    alert = { level: "signal", title: "Velocity spike", message: `${token.symbol} momentum crossed ${token.momentum}`, mint: token.mint };
  } else if (token.smartWallets >= 4 && (!previous || previous.smartWallets < 4)) {
    alert = { level: "signal", title: "Wallet convergence", message: `${token.smartWallets} tracked wallets entered ${token.symbol}`, mint: token.mint };
  } else if (Number.isFinite(token.risk) && token.risk >= 72 && (!previous || !Number.isFinite(previous.risk) || previous.risk < 72)) {
    alert = { level: "risk", title: "Risk escalation", message: `${token.symbol} risk reached ${token.risk}`, mint: token.mint };
  }
  if (alert) {
    const saved = store.addAlert(alert);
    send("alert", saved);
    maybeSendTelegram(saved).catch(() => {});
  }
}

async function maybeSendTelegram(alert) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = `🏛️ Pump War Room — ${alert.title}\n${alert.message}\nhttps://pump.fun/coin/${alert.mint}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
}

function upsert(token) {
  const previous = store.token(token.mint);
  store.upsertToken(token); store.addEvent(previous ? "update" : "mint", token);
  alertFor(token, previous); send(previous ? "token-update" : "new-token", token);
}

function addCallout(callout) {
  store.upsertCallout(callout);
  store.addEvent("callout", callout);
  send("callout", callout);
}

function snapshot() {
  const callouts = store.callouts(200);
  const calloutCounts = callouts.reduce((counts, callout) => counts.set(callout.mint, (counts.get(callout.mint) || 0) + 1), new Map());
  const tokens = store.tokens(120).map((token) => ({ ...token, calloutCount: calloutCounts.get(token.mint) || 0 })).sort((a, b) => b.momentum - a.momentum);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const fifteen = new Date(Date.now() - 900_000).toISOString();
  const narratives = Object.values(tokens.reduce((acc, token) => {
    const row = acc[token.narrative] ||= { name: token.narrative, coins: 0, volume: 0, momentum: 0 };
    row.coins++; row.volume += token.volume5m || 0; row.momentum += token.momentum || 0;
    return acc;
  }, {})).map((row) => ({ ...row, momentum: Math.round(row.momentum / row.coins) })).sort((a, b) => b.volume - a.volume);
  return {
    version: appVersion, mode, feedStatus, feedHealth: feedHealth(), calloutStatus, lastEventAt, lastMintAt,
    liveMintCount: mode === "live" ? store.countBySource("pumpportal").tokens : 0,
    demoPurged: mode === "live", demoPurgedCount: cleanup.tokens, reconnects, feedMessages, feedParseErrors,
    stats: { indexed: store.count(), mintedToday: store.countSince(start.toISOString()), lastHour: store.countSince(hour), last15m: store.countSince(fifteen), graduations: tokens.filter((t) => t.status === "graduated").length, calloutsLastHour: store.calloutCountSince(hour) },
    tokens, narratives, callouts: callouts.slice(0, 30), alerts: store.alerts(40)
  };
}

if (process.env.BARK_API_KEY) {
  const calloutIngestor = new BarkCalloutIngestor({
    url: process.env.BARK_URL || "wss://news.bark.gg/ws",
    apiKey: process.env.BARK_API_KEY,
    onCallout: addCallout,
    onStatus: (status) => { calloutStatus = status; send("status", { calloutStatus }); }
  });
  calloutIngestor.connect();
}

if (mode === "demo") {
  if (store.count() === 0) Array.from({ length: 12 }, (_, i) => upsert(createDemoToken(i, i * 3)));
  setInterval(() => {
    const tokens = store.tokens(50);
    if (Math.random() > 0.55) upsert(createDemoToken(Math.floor(Math.random() * 12)));
    for (const token of tokens.sort(() => Math.random() - 0.5).slice(0, 4)) upsert(tickDemoToken(token));
  }, 2_500).unref();
} else {
  const ingestor = new PumpPortalIngestor({
    url: process.env.PUMPPORTAL_URL || "wss://pumpportal.fun/api/data",
    watchTrades: process.env.WATCH_TRADES === "true",
    onToken: (token) => { lastMintAt = new Date().toISOString(); upsert(token); },
    onMigration: ({ mint }) => { const token = store.token(mint); if (token) upsert({ ...token, status: "graduated", bondingProgress: 100 }); },
    onStatus: (status, telemetry = {}) => {
      feedStatus = status;
      reconnects = telemetry.counters?.reconnectsScheduled ?? telemetry.reconnects ?? reconnects;
      feedMessages = telemetry.counters?.messagesReceived ?? telemetry.messages ?? feedMessages;
      feedParseErrors = telemetry.counters?.malformedMessages ?? telemetry.parseErrors ?? feedParseErrors;
      send("status", { feedStatus, feedHealth: feedHealth(), reconnects, feedMessages, feedParseErrors });
    }
  });
  ingestor.connect();
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") return json(res, 200, {
      ok: true, version: appVersion, mode, feedStatus, feedHealth: feedHealth(), calloutStatus,
      lastEventAt, lastMintAt, indexed: store.count(), liveMintCount: mode === "live" ? store.countBySource("pumpportal").tokens : 0,
      demoPurged: mode === "live", demoPurgedCount: cleanup.tokens, reconnects, feedMessages, feedParseErrors
    });
    if (url.pathname === "/api/snapshot") return json(res, 200, snapshot());
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: ready\ndata: ${JSON.stringify({ mode, feedStatus })}\n\n`); clients.add(res);
      req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "POST" && url.pathname === "/api/export/daily") return json(res, 200, { ok: true, path: await exportDaily(vaultPath, snapshot()) });
    if (req.method === "POST" && url.pathname.startsWith("/api/export/coin/")) {
      const mint = decodeURIComponent(url.pathname.split("/").pop()); const token = store.token(mint);
      if (!token) return json(res, 404, { error: "Token not found" });
      return json(res, 200, { ok: true, path: await exportCoin(vaultPath, token) });
    }
    let target = url.pathname === "/" ? "/index.html" : url.pathname;
    target = path.normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = path.join(root, "public", target);
    if (!file.startsWith(path.join(root, "public"))) return json(res, 403, { error: "Forbidden" });
    const body = await readFile(file); res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }); res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    console.error(error); json(res, 500, { error: "Internal error" });
  }
});

function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
server.listen(port, "0.0.0.0", () => {
  console.log(`Pump War Room v${appVersion} (${mode}) listening on http://localhost:${port}`);
  if (cleanup.tokens) console.log(`Removed ${cleanup.tokens} legacy demo tokens, ${cleanup.events} events, and ${cleanup.alerts} alerts from the live database`);
});
