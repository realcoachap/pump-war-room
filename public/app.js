let state = { tokens: [], alerts: [], callouts: [], narratives: [], stats: {} };
const $ = (selector) => document.querySelector(selector);
const nf = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = (value) => `$${nf.format(value || 0)}`;
const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const riskClass = (risk) => risk >= 70 ? "risk-high" : risk >= 45 ? "risk-mid" : "risk-low";
const shortMint = (mint = "") => mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : mint;
const riskConfidence = (token) => token.riskConfidence || (token.source === "demo" ? "synthetic" : "unverified");
const riskLabel = (token) => riskConfidence(token) === "unverified" || !Number.isFinite(token.risk) ? "—" : token.risk;
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const fomoUrl = (mint) => `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}`;

function renderStats() {
  const cards = [
    ["Total indexed", state.stats.indexed, "local onchain index"], ["Minted today", state.stats.mintedToday, "activated mints"],
    ["Last 60 min", state.stats.lastHour, "launch velocity"], ["Last 15 min", state.stats.last15m, "current pulse", "hot"],
    ["Graduations", state.stats.graduations, "indexed migrations"]
  ];
  $("#stats").innerHTML = cards.map(([label, value, note, cls = ""]) => `<div class="stat ${cls}"><label>${label}</label><strong>${nf.format(value || 0)}</strong><small>${note}</small></div>`).join("");
}
function renderTokens() {
  $("#tokens").innerHTML = state.tokens.slice(0, 15).map((t) => `<div class="token-row" data-mint="${esc(t.mint)}">
    <div class="coin"><div class="coin-icon">${esc(t.symbol.slice(0, 2))}</div><div class="coin-name"><strong>${esc(t.name)}</strong><span>${esc(t.symbol)} · ${esc(shortMint(t.mint))} · ${esc(t.narrative)}</span></div></div>
    <div class="score">${t.momentum}<small>/100</small></div>
    <div class="metric">${money(t.volume5m)}<small>${t.priceChange5m >= 0 ? "+" : ""}${Math.round(t.priceChange5m)}%</small></div>
    <div class="metric">${Math.round(t.bondingProgress)}%<div class="progress"><i style="width:${Math.min(100, t.bondingProgress)}%"></i></div></div>
    <div class="score ${riskClass(t.risk)}">${riskLabel(t)}<small>${esc(riskConfidence(t))}</small></div>
  </div>`).join("");
  document.querySelectorAll(".token-row").forEach((row) => row.addEventListener("click", () => openToken(row.dataset.mint)));
}
function renderNarratives() {
  const max = Math.max(...state.narratives.map((n) => n.volume), 1);
  $("#narratives").innerHTML = state.narratives.slice(0, 6).map((n) => `<div class="narrative"><div class="narrative-top"><span>${esc(n.name)}</span><span>${n.coins} coins · ${money(n.volume)}</span></div><div class="bar"><i style="width:${Math.max(5, n.volume / max * 100)}%"></i></div></div>`).join("");
}
function renderAlerts() {
  $("#alert-count").textContent = state.alerts.length;
  $("#alerts").innerHTML = state.alerts.length ? state.alerts.slice(0, 12).map((a) => `<div class="alert ${esc(a.level)}"><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span><time>${ago(a.createdAt)}</time></div>`).join("") : '<div class="loading">Signal thresholds are quiet.</div>';
}
function renderCallouts() {
  const callouts = state.callouts || [];
  $("#callout-count").textContent = callouts.length;
  $("#callouts").innerHTML = callouts.length ? callouts.slice(0, 8).map((c) => `<a class="callout" href="${esc(c.url)}" target="_blank" rel="noreferrer">
    <div><strong>@${esc(c.caller)} called ${esc(c.symbol)}</strong><span>${esc(shortMint(c.mint))} · ${money(c.marketCap)}</span></div>
    <b>${Number.isFinite(c.multiple) ? `${c.multiple.toFixed(1)}×` : "NEW"}</b><time>${ago(c.createdAt)}</time>
  </a>`).join("") : `<div class="loading">${state.calloutStatus === "disabled" ? "Add BARK_API_KEY to stream verified callout events." : "Listening for callouts…"}</div>`;
}
function render() { $("#app-version").textContent = `v${state.version || "—"}`; renderStats(); renderTokens(); renderCallouts(); renderNarratives(); renderAlerts(); }
async function refresh() { state = await fetch("/api/snapshot").then((r) => r.json()); $("#feed-status").textContent = `${state.mode.toUpperCase()} · ${state.feedStatus.toUpperCase()}`; render(); }

function openToken(mint) {
  const t = state.tokens.find((token) => token.mint === mint); if (!t) return;
  const confidence = riskConfidence(t);
  const momentum = []; const risks = [];
  if (t.volume5m > 7000) momentum.push("5m volume acceleration"); if (t.uniqueBuyers >= 18) momentum.push("broad buyer participation"); if (t.buyRatio >= .64) momentum.push("buy-side pressure"); if (t.bondingProgress >= 75) momentum.push("approaching graduation");
  if (t.devHoldingPct >= 12) risks.push("elevated dev holdings"); if (t.top10Pct >= 50) risks.push("holder concentration"); if (Number.isFinite(t.buyRatio) && t.buyRatio < .43) risks.push("sell-side pressure"); if (t.creatorRisk) risks.push("creator history flag");
  $("#token-detail").innerHTML = `<div class="detail"><span class="kicker">${esc(t.narrative)} // ${esc(t.status)}</span><h2>${esc(t.name)} <span class="risk-low">${esc(t.symbol)}</span></h2><div class="mint">${esc(t.mint)}</div>
    <div class="detail-grid"><div class="detail-card"><label>MOMENTUM</label><strong>${t.momentum}/100</strong></div><div class="detail-card"><label>RISK · ${esc(confidence.toUpperCase())}</label><strong class="${riskClass(t.risk)}">${riskLabel(t)}${Number.isFinite(t.risk) ? "/100" : ""}</strong></div><div class="detail-card"><label>MARKET CAP</label><strong>${money(t.marketCap)}</strong></div><div class="detail-card"><label>BUYERS</label><strong>${t.uniqueBuyers}</strong></div><div class="detail-card"><label>BUY RATIO</label><strong>${Number.isFinite(t.buyRatio) ? `${Math.round(t.buyRatio * 100)}%` : "—"}</strong></div><div class="detail-card"><label>SMART WALLETS</label><strong>${t.smartWallets}</strong></div></div>
    <div class="reasons"><div class="reason"><strong>Why it’s moving</strong><br>${esc((momentum.length ? momentum : ["early signal—limited history"]).join(" · "))}</div><div class="reason risk"><strong>Risk read</strong><br>${esc((confidence === "unverified" ? ["awaiting holder, creator, and trade enrichment"] : risks.length ? risks : ["no major heuristic flags"]).join(" · "))}</div></div>
    <div class="detail-actions"><button class="primary" id="export-coin">EXPORT TO OBSIDIAN</button><a href="https://pump.fun/coin/${encodeURIComponent(t.mint)}" target="_blank" rel="noreferrer">PUMP.FUN ↗</a><a href="https://dexscreener.com/solana/${encodeURIComponent(t.mint)}" target="_blank" rel="noreferrer">DEX SCREENER ↗</a><a href="${fomoUrl(t.mint)}" target="_blank" rel="noreferrer">FOMO ↗</a></div></div>`;
  $("#token-dialog").showModal();
  $("#export-coin").onclick = async () => { const result = await fetch(`/api/export/coin/${encodeURIComponent(t.mint)}`, { method: "POST" }).then((r) => r.json()); toast(result.ok ? "Coin note exported to the vault" : "Export failed"); };
}
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); }
$(".dialog-close").onclick = () => $("#token-dialog").close();
$("#export-daily").onclick = async () => { const result = await fetch("/api/export/daily", { method: "POST" }).then((r) => r.json()); toast(result.ok ? "Daily brief exported to the vault" : "Export failed"); };
setInterval(() => $("#clock").textContent = `${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET`, 1000);
await refresh();
const stream = new EventSource("/api/stream");
for (const event of ["new-token", "token-update", "callout", "alert", "status"]) stream.addEventListener(event, () => refresh());
stream.onerror = () => { $("#feed-status").textContent = "RECONNECTING"; };
setInterval(refresh, 15_000);
