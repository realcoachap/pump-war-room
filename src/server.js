import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createDemoToken, tickDemoToken } from "./demo.js";
import { PumpPortalIngestor } from "./ingest.js";
import { exportCoin, exportDaily } from "./vault.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4173);
const mode = process.env.PUMP_MODE === "live" ? "live" : "demo";
const dbPath = path.resolve(root, process.env.DB_PATH || "data/pump-war-room.db");
const vaultPath = path.resolve(root, process.env.VAULT_PATH || "vault");
const store = new Store(dbPath);
const clients = new Set();
let feedStatus = mode === "demo" ? "simulated" : "connecting";
let lastEventAt = new Date().toISOString();

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
  } else if (token.risk >= 72 && (!previous || previous.risk < 72)) {
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

function snapshot() {
  const tokens = store.tokens(120).sort((a, b) => b.momentum - a.momentum);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const fifteen = new Date(Date.now() - 900_000).toISOString();
  const narratives = Object.values(tokens.reduce((acc, token) => {
    const row = acc[token.narrative] ||= { name: token.narrative, coins: 0, volume: 0, momentum: 0 };
    row.coins++; row.volume += token.volume5m || 0; row.momentum += token.momentum || 0;
    return acc;
  }, {})).map((row) => ({ ...row, momentum: Math.round(row.momentum / row.coins) })).sort((a, b) => b.volume - a.volume);
  return {
    mode, feedStatus, lastEventAt,
    stats: { indexed: store.count(), mintedToday: store.countSince(start.toISOString()), lastHour: store.countSince(hour), last15m: store.countSince(fifteen), graduations: tokens.filter((t) => t.status === "graduated").length },
    tokens, narratives, alerts: store.alerts(40)
  };
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
    onToken: upsert,
    onMigration: ({ mint }) => { const token = store.token(mint); if (token) upsert({ ...token, status: "graduated", bondingProgress: 100 }); },
    onStatus: (status) => { feedStatus = status; send("status", { feedStatus }); }
  });
  ingestor.connect();
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, mode, feedStatus, lastEventAt, indexed: store.count() });
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
server.listen(port, "0.0.0.0", () => console.log(`Pump War Room (${mode}) listening on http://localhost:${port}`));
