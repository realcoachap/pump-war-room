let state = { tokens: [], alerts: [], callouts: [], narratives: [], stats: {}, mode: "live", feedStatus: "connecting" };
let dashboardStreamState = "connecting";
let snapshotFailed = false;
let refreshInFlight = false;

const STALE_AFTER_MS = 120_000;
const $ = (selector) => document.querySelector(selector);
const nf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, fallback = 0) => hasNumber(value) ? Number(value) : fallback;
const money = (value) => `$${nf.format(number(value))}`;
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const parseTime = (value) => { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? timestamp : null; };
const ago = (iso) => {
  const timestamp = parseTime(iso);
  if (!timestamp) return "—";
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  return seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
};
const ageLabel = (iso) => {
  const timestamp = parseTime(iso);
  if (!timestamp) return "WAITING";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "JUST NOW";
  if (seconds < 60) return `${seconds}s AGO`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m AGO`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h AGO`;
  return `${Math.floor(seconds / 86_400)}d AGO`;
};
const exactTime = (iso) => {
  const timestamp = parseTime(iso);
  return timestamp ? new Date(timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " ET" : "No real mint observed";
};
const riskClass = (risk) => !hasNumber(risk) ? "risk-unverified" : number(risk) >= 70 ? "risk-high" : number(risk) >= 45 ? "risk-mid" : "risk-low";
const shortMint = (mint = "") => String(mint).length > 12 ? `${String(mint).slice(0, 6)}…${String(mint).slice(-4)}` : String(mint);
const riskConfidence = (token = {}) => token.riskConfidence || (token.source === "demo" ? "synthetic" : "unverified");
const riskLabel = (token) => riskConfidence(token) === "unverified" || !hasNumber(token.risk) ? "—" : number(token.risk);
const fomoUrl = (mint) => `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}`;

function feedTelemetry() {
  const feedHealth = state.feedHealth;
  const nested = feedHealth && typeof feedHealth === "object" ? feedHealth : {};
  return {
    rawHealth: typeof feedHealth === "string" ? feedHealth : nested.state || nested.status || nested.health || state.feedStatus || "connecting",
    lastMintAt: state.lastMintAt || nested.lastMintAt || null,
    liveMintCount: hasNumber(state.liveMintCount ?? nested.liveMintCount) ? Number(state.liveMintCount ?? nested.liveMintCount) : null,
    demoPurged: typeof (state.demoPurged ?? nested.demoPurged) === "boolean" ? state.demoPurged ?? nested.demoPurged : null,
    demoPurgedCount: hasNumber(state.demoPurgedCount ?? nested.demoPurgedCount) ? Number(state.demoPurgedCount ?? nested.demoPurgedCount) : 0,
    reconnects: hasNumber(state.reconnects ?? nested.reconnects) ? Number(state.reconnects ?? nested.reconnects) : 0
  };
}

function isSyntheticToken(token = {}) {
  const source = String(token.source || "").toLowerCase();
  return ["demo", "synthetic", "simulation", "simulated"].includes(source) || riskConfidence(token) === "synthetic";
}

function allTokens() { return Array.isArray(state.tokens) ? state.tokens : []; }
function hiddenSyntheticTokens() { return state.mode === "live" ? allTokens().filter(isSyntheticToken) : []; }
function rankedTokens() { return state.mode === "live" ? allTokens().filter((token) => !isSyntheticToken(token)) : allTokens(); }

function healthView() {
  const telemetry = feedTelemetry();
  const raw = String(telemetry.rawHealth || "").toLowerCase();
  const mintTimestamp = parseTime(telemetry.lastMintAt);
  const mintAge = mintTimestamp ? Date.now() - mintTimestamp : null;
  let label = "CONNECTING";

  if (snapshotFailed) label = "STALE";
  else if (["stale", "degraded", "offline", "error", "failed", "disconnected"].some((value) => raw.includes(value))) label = "STALE";
  else if (["live", "healthy", "streaming", "active"].some((value) => raw.includes(value))) label = "LIVE";
  else if (["connected", "open", "ready"].some((value) => raw.includes(value))) label = mintTimestamp || telemetry.liveMintCount > 0 ? "LIVE" : "CONNECTING";
  else if (mintAge !== null && mintAge > STALE_AFTER_MS) label = "STALE";

  if (label === "LIVE" && mintAge !== null && mintAge > STALE_AFTER_MS && !["live", "healthy"].includes(raw)) label = "STALE";
  if (state.mode !== "live" && raw === "simulated") label = "CONNECTING";

  const details = {
    LIVE: "PumpPortal ingest is receiving real mint events.",
    STALE: "Upstream telemetry is outside its freshness window; no activity is inferred.",
    CONNECTING: state.mode === "live" ? "Establishing the feed and waiting for the first real mint." : "Simulation mode is active; live feed status is not asserted."
  };
  let detail = details[label];
  if (dashboardStreamState === "reconnecting") detail += " Dashboard updates are reconnecting.";
  if (snapshotFailed) detail = "The latest snapshot could not be reached. Displayed observations may be stale.";
  return { label, detail, telemetry };
}

function trustedStats() {
  const telemetry = feedTelemetry();
  const tokens = rankedTokens();
  const hiddenCount = hiddenSyntheticTokens().length;
  const serverStatsTrusted = state.mode !== "live" || telemetry.demoPurged === true || hiddenCount === 0;
  const countSince = (milliseconds) => tokens.filter((token) => { const timestamp = parseTime(token.createdAt); return timestamp && timestamp >= Date.now() - milliseconds; }).length;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const countToday = tokens.filter((token) => { const timestamp = parseTime(token.createdAt); return timestamp && timestamp >= startOfDay.getTime(); }).length;
  return {
    indexed: state.mode === "live" && telemetry.liveMintCount !== null ? telemetry.liveMintCount : serverStatsTrusted ? number(state.stats?.indexed) : tokens.length,
    mintedToday: serverStatsTrusted ? number(state.stats?.mintedToday) : countToday,
    lastHour: serverStatsTrusted ? number(state.stats?.lastHour) : countSince(3_600_000),
    last15m: serverStatsTrusted ? number(state.stats?.last15m) : countSince(900_000),
    graduations: serverStatsTrusted ? number(state.stats?.graduations) : tokens.filter((token) => token.status === "graduated").length
  };
}

function renderFeedObservability() {
  const { label, detail, telemetry } = healthView();
  const hiddenCount = hiddenSyntheticTokens().length;
  const fallbackLiveCount = rankedTokens().length;
  const liveMintCount = telemetry.liveMintCount ?? fallbackLiveCount;
  const integrityLabel = state.mode !== "live" ? "N/A" : telemetry.demoPurged === true ? "CLEAN" : telemetry.demoPurged === false || hiddenCount ? "PENDING" : "UNKNOWN";
  const integrityDetail = state.mode !== "live" ? "Demo mode keeps simulation data" : hiddenCount ? `${hiddenCount} synthetic row${hiddenCount === 1 ? "" : "s"} excluded` : telemetry.demoPurged === true ? telemetry.demoPurgedCount ? `${telemetry.demoPurgedCount} legacy demo row${telemetry.demoPurgedCount === 1 ? "" : "s"} purged` : "Persisted demo rows cleared" : telemetry.demoPurged === false ? "Demo purge not confirmed" : "Purge telemetry unavailable";

  document.body.dataset.feedState = label.toLowerCase();
  $("#feed-indicator").className = `feed-indicator ${label.toLowerCase()}`;
  $("#feed-indicator").setAttribute("aria-label", `Feed state: ${label}`);
  $("#feed-status").textContent = label;
  $("#feed-state").textContent = label;
  $("#feed-state-card").className = `feed-overview ${label.toLowerCase()}`;
  $("#feed-detail").textContent = detail;
  $("#live-mint-count").textContent = nf.format(liveMintCount);
  $("#live-mint-note").textContent = telemetry.liveMintCount === null ? "Confirmed rows in this snapshot" : "Real mints recorded by ingest";
  $("#reconnect-count").textContent = nf.format(telemetry.reconnects);
  $("#demo-purge-state").textContent = integrityLabel;
  $("#demo-purge-note").textContent = integrityDetail;
  $("#mode-state").textContent = String(state.mode || "unknown").toUpperCase();
  $("#mode-note").textContent = state.mode === "live" ? "Read-only production ingest" : "Synthetic environment";
  updateMintAge();
}

function updateMintAge() {
  const { lastMintAt } = feedTelemetry();
  const label = ageLabel(lastMintAt);
  $("#last-mint-age").textContent = label;
  $("#last-mint-time").textContent = exactTime(lastMintAt);
  $("#last-mint-compact").textContent = label;
}

function renderStats() {
  const stats = trustedStats();
  const liveMode = state.mode === "live";
  const cards = [
    [liveMode ? "Live indexed" : "Total indexed", stats.indexed, liveMode ? "confirmed real mints" : "local simulation index"],
    ["Minted today", stats.mintedToday, "observed mint events"],
    ["Last 60 min", stats.lastHour, "launch observations"],
    ["Last 15 min", stats.last15m, "current feed pulse", stats.last15m > 0 ? "hot" : ""],
    ["Graduations", stats.graduations, "observed migrations"]
  ];
  $("#stats").innerHTML = cards.map(([label, value, note, cls = ""]) => `<div class="stat ${cls}"><label>${label}</label><strong>${nf.format(number(value))}</strong><small>${note}</small></div>`).join("");
}

function emptyTape() {
  const { label } = healthView();
  const hiddenCount = hiddenSyntheticTokens().length;
  const title = label === "STALE" ? "NO FRESH REAL MINTS" : label === "CONNECTING" ? "WAITING FOR THE FIRST REAL MINT" : "NO REAL MINTS IN THIS SNAPSHOT";
  const message = label === "STALE"
    ? "The upstream feed needs a fresh event before this ranking can update."
    : "Rankings appear only after an observed PumpPortal mint is recorded.";
  const hygiene = hiddenCount ? `${hiddenCount} synthetic row${hiddenCount === 1 ? " was" : "s were"} withheld from the ranking.` : "No placeholder assets are inserted.";
  return `<div class="empty-tape" role="status"><div class="empty-radar" aria-hidden="true"><i></i></div><div><span class="kicker">OBSERVATION-ONLY TAPE</span><strong>${title}</strong><p>${message} ${hygiene}</p></div></div>`;
}

function renderTokens() {
  const tokens = rankedTokens().slice(0, 15);
  $("#ranking-kicker").textContent = state.mode === "live" ? "REAL-MINT RANKING" : "SIMULATED RANKING";
  if (!tokens.length) {
    $("#tokens").innerHTML = emptyTape();
    return;
  }
  $("#tokens").innerHTML = tokens.map((token) => {
    const momentum = hasNumber(token.momentum) ? number(token.momentum) : "—";
    const change = hasNumber(token.priceChange5m) ? `${number(token.priceChange5m) >= 0 ? "+" : ""}${Math.round(number(token.priceChange5m))}%` : "—";
    const progress = Math.max(0, Math.min(100, number(token.bondingProgress)));
    const symbol = String(token.symbol || "??");
    return `<div class="token-row" data-mint="${esc(token.mint)}">
      <div class="coin"><div class="coin-icon">${esc(symbol.slice(0, 2))}</div><div class="coin-name"><strong>${esc(token.name || "Unnamed mint")}</strong><span>${esc(symbol)} · ${esc(shortMint(token.mint))} · ${esc(token.narrative || "Unclassified")}</span></div></div>
      <div class="score">${momentum}<small>/100</small></div>
      <div class="metric">${money(token.volume5m)}<small>${change}</small></div>
      <div class="metric">${Math.round(progress)}%<div class="progress"><i style="width:${progress}%"></i></div></div>
      <div class="score ${riskClass(token.risk)}">${riskLabel(token)}<small>${esc(riskConfidence(token))}</small></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".token-row").forEach((row) => row.addEventListener("click", () => openToken(row.dataset.mint)));
}

function narrativeRows() {
  return Object.values(rankedTokens().reduce((rows, token) => {
    const name = token.narrative || "Unclassified";
    const row = rows[name] ||= { name, coins: 0, volume: 0 };
    row.coins += 1;
    row.volume += number(token.volume5m);
    return rows;
  }, {})).sort((a, b) => b.volume - a.volume);
}

function renderNarratives() {
  const narratives = narrativeRows().slice(0, 6);
  if (!narratives.length) {
    $("#narratives").innerHTML = '<div class="rail-empty">No real-mint narrative clusters yet.</div>';
    return;
  }
  const max = Math.max(...narratives.map((narrative) => narrative.volume), 1);
  $("#narratives").innerHTML = narratives.map((narrative) => `<div class="narrative"><div class="narrative-top"><span>${esc(narrative.name)}</span><span>${narrative.coins} coins · ${money(narrative.volume)}</span></div><div class="bar"><i style="width:${Math.max(5, narrative.volume / max * 100)}%"></i></div></div>`).join("");
}

function renderAlerts() {
  const hiddenMints = new Set(hiddenSyntheticTokens().map((token) => token.mint));
  const alerts = (Array.isArray(state.alerts) ? state.alerts : []).filter((alert) => !hiddenMints.has(alert.mint));
  $("#alert-count").textContent = alerts.length;
  $("#alerts").innerHTML = alerts.length ? alerts.slice(0, 12).map((alert) => `<div class="alert ${esc(alert.level)}"><strong>${esc(alert.title)}</strong><span>${esc(alert.message)}</span><time>${ago(alert.createdAt)}</time></div>`).join("") : '<div class="loading">Signal thresholds are quiet.</div>';
}

function renderCallouts() {
  const callouts = Array.isArray(state.callouts) ? state.callouts : [];
  $("#callout-count").textContent = callouts.length;
  $("#callouts").innerHTML = callouts.length ? callouts.slice(0, 8).map((callout) => `<a class="callout" href="${esc(callout.url)}" target="_blank" rel="noreferrer">
    <div><strong>@${esc(callout.caller)} observed ${esc(callout.symbol)}</strong><span>${esc(shortMint(callout.mint))} · ${money(callout.marketCap)}</span></div>
    <b>${hasNumber(callout.multiple) ? `${number(callout.multiple).toFixed(1)}×` : "NEW"}</b><time>${ago(callout.createdAt)}</time>
  </a>`).join("") : `<div class="loading">${state.calloutStatus === "disabled" ? "Callout telemetry is not configured." : "Listening for observed callouts…"}</div>`;
}

function render() {
  $("#app-version").textContent = `v${state.version || "—"}`;
  renderFeedObservability();
  renderStats();
  renderTokens();
  renderCallouts();
  renderNarratives();
  renderAlerts();
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot returned ${response.status}`);
    const snapshot = await response.json();
    state = {
      ...state,
      ...snapshot,
      tokens: Array.isArray(snapshot.tokens) ? snapshot.tokens : [],
      alerts: Array.isArray(snapshot.alerts) ? snapshot.alerts : [],
      callouts: Array.isArray(snapshot.callouts) ? snapshot.callouts : [],
      narratives: Array.isArray(snapshot.narratives) ? snapshot.narratives : [],
      stats: snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : {}
    };
    snapshotFailed = false;
    render();
  } catch (error) {
    snapshotFailed = true;
    renderFeedObservability();
    console.warn("Snapshot refresh failed", error);
  } finally {
    refreshInFlight = false;
  }
}

function openToken(mint) {
  const token = rankedTokens().find((candidate) => candidate.mint === mint);
  if (!token) return;
  const confidence = riskConfidence(token);
  const momentum = [];
  const risks = [];
  if (number(token.volume5m) > 7000) momentum.push("5m volume acceleration");
  if (number(token.uniqueBuyers) >= 18) momentum.push("broad buyer participation");
  if (hasNumber(token.buyRatio) && number(token.buyRatio) >= .64) momentum.push("buy-side pressure");
  if (number(token.bondingProgress) >= 75) momentum.push("approaching graduation");
  if (number(token.devHoldingPct) >= 12) risks.push("elevated dev holdings");
  if (number(token.top10Pct) >= 50) risks.push("holder concentration");
  if (hasNumber(token.buyRatio) && number(token.buyRatio) < .43) risks.push("sell-side pressure");
  if (token.creatorRisk) risks.push("creator history flag");
  $("#token-detail").innerHTML = `<div class="detail"><span class="kicker">${esc(token.narrative || "Unclassified")} // ${esc(token.status || "observed")}</span><h2>${esc(token.name || "Unnamed mint")} <span class="risk-low">${esc(token.symbol || "??")}</span></h2><div class="mint">${esc(token.mint)}</div>
    <div class="detail-grid"><div class="detail-card"><label>MOMENTUM</label><strong>${hasNumber(token.momentum) ? number(token.momentum) : "—"}/100</strong></div><div class="detail-card"><label>RISK · ${esc(confidence.toUpperCase())}</label><strong class="${riskClass(token.risk)}">${riskLabel(token)}${hasNumber(token.risk) ? "/100" : ""}</strong></div><div class="detail-card"><label>MARKET CAP</label><strong>${money(token.marketCap)}</strong></div><div class="detail-card"><label>BUYERS</label><strong>${nf.format(number(token.uniqueBuyers))}</strong></div><div class="detail-card"><label>BUY RATIO</label><strong>${hasNumber(token.buyRatio) ? `${Math.round(number(token.buyRatio) * 100)}%` : "—"}</strong></div><div class="detail-card"><label>SMART WALLETS</label><strong>${nf.format(number(token.smartWallets))}</strong></div></div>
    <div class="reasons"><div class="reason"><strong>Observed movement</strong><br>${esc((momentum.length ? momentum : ["early observation—limited history"]).join(" · "))}</div><div class="reason risk"><strong>Risk read</strong><br>${esc((confidence === "unverified" ? ["awaiting holder, creator, and trade enrichment"] : risks.length ? risks : ["no major heuristic flags"]).join(" · "))}</div></div>
    <div class="detail-actions"><button class="primary" id="export-coin">EXPORT TO OBSIDIAN</button><a href="https://pump.fun/coin/${encodeURIComponent(token.mint)}" target="_blank" rel="noreferrer">PUMP.FUN ↗</a><a href="https://dexscreener.com/solana/${encodeURIComponent(token.mint)}" target="_blank" rel="noreferrer">DEX SCREENER ↗</a><a href="${fomoUrl(token.mint)}" target="_blank" rel="noreferrer">FOMO ↗</a></div></div>`;
  $("#token-dialog").showModal();
  $("#export-coin").onclick = async () => {
    try {
      const response = await fetch(`/api/export/coin/${encodeURIComponent(token.mint)}`, { method: "POST" });
      const result = await response.json();
      toast(result.ok ? "Coin note exported to the vault" : "Export failed");
    } catch { toast("Export failed"); }
  };
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2400);
}

$(".dialog-close").onclick = () => $("#token-dialog").close();
$("#export-daily").onclick = async () => {
  try {
    const response = await fetch("/api/export/daily", { method: "POST" });
    const result = await response.json();
    toast(result.ok ? "Daily brief exported to the vault" : "Export failed");
  } catch { toast("Export failed"); }
};

function tickClock() {
  $("#clock").textContent = `${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET`;
  updateMintAge();
}

tickClock();
setInterval(tickClock, 1000);
await refresh();
const stream = new EventSource("/api/stream");
stream.onopen = () => { dashboardStreamState = "open"; renderFeedObservability(); };
for (const event of ["new-token", "token-update", "callout", "alert", "status"]) stream.addEventListener(event, () => refresh());
stream.onerror = () => { dashboardStreamState = "reconnecting"; renderFeedObservability(); };
setInterval(refresh, 15_000);
