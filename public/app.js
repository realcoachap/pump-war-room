import {
  PRESET_LIMIT,
  PREFERENCE_KEY,
  PUBLIC_MINT,
  WATCHLIST_LIMIT,
  normalizeFilterState,
  normalizePreferences,
  readPreferences,
  writePreferences
} from "./preferences.js";
import {
  createSnapshotLiveUpdates,
  createSnapshotRefreshScheduler
} from "./snapshot-refresh.js";

void PREFERENCE_KEY;

let state = { tokens: [], alerts: [], callouts: [], narratives: [], stats: {}, leaderboard: { top100: [] }, outcomes: {}, riskIntelligence: {}, actionIntelligence: {}, earlyActorIntelligence: {}, identityRegistry: {}, publicDelivery: { vaultExports: "disabled" }, mode: "live", feedStatus: "connecting" };
let dashboardStreamState = "connecting";
let snapshotFailed = false;
let caesarRequestPending = false;
let deepLinkOpened = false;
let compareRequestSequence = 0;
let compareCacheKey = "";
let compareCache = null;

const LEGACY_STALE_AFTER_MS = 90_000;
const CAESAR_MAX_QUESTION = 500;
const CAESAR_MAX_ANSWER = 6_000;
const CAESAR_TIMEOUT_MS = 30_000;
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
const riskConfidence = (token = {}) => token.riskIdentity?.overallEvidence || token.riskConfidence || (token.source === "demo" ? "synthetic" : "unavailable");
const riskLabel = (token) => token.source !== "demo" || !hasNumber(token.risk) ? "—" : number(token.risk);
const fomoUrl = (mint) => `https://fomo.family/tokens/solana/${encodeURIComponent(mint)}`;
const cappedText = (value, limit) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}… [truncated]` : text;
};

let preferenceStorageAvailable = true;

function loadPreferences() {
  let storage = null;
  try { storage = globalThis.localStorage; } catch {}
  const result = readPreferences(storage);
  preferenceStorageAvailable = result.available;
  return result.preferences;
}

let preferences = loadPreferences();
const compareMints = new Set();

function savePreferences() {
  let storage = null;
  try { storage = globalThis.localStorage; } catch {}
  const result = writePreferences(storage, preferences);
  preferences = result.preferences;
  preferenceStorageAvailable = result.available;
  return result.available;
}

function watched(mint) { return preferences.watchedMints.includes(mint); }

function filterState() {
  return normalizeFilterState({
    search: $("#leaderboard-search")?.value,
    lens: $("#leaderboard-lens")?.value,
    freshness: $("#leaderboard-freshness")?.value,
    risk: $("#leaderboard-risk")?.value,
    watchlist: $("#leaderboard-watchlist")?.value
  });
}

function applyFilterState(filters) {
  const value = normalizeFilterState(filters);
  if ($("#leaderboard-search")) $("#leaderboard-search").value = value.search;
  if ($("#leaderboard-lens")) $("#leaderboard-lens").value = value.lens;
  if ($("#leaderboard-freshness")) $("#leaderboard-freshness").value = value.freshness;
  if ($("#leaderboard-risk")) $("#leaderboard-risk").value = value.risk;
  if ($("#leaderboard-watchlist")) $("#leaderboard-watchlist").value = value.watchlist;
}

function filtersFromUrl() {
  const query = new URLSearchParams(location.search);
  return normalizeFilterState({
    search: query.get("q") || "",
    lens: query.get("lens") || "radar",
    freshness: query.get("fresh") || "all",
    risk: query.get("risk") || "all",
    watchlist: query.get("watch") || "all"
  });
}

function syncFiltersToUrl() {
  const filters = filterState();
  const url = new URL(location.href);
  for (const key of ["q", "lens", "fresh", "risk", "watch"]) url.searchParams.delete(key);
  if (filters.search) url.searchParams.set("q", filters.search);
  if (filters.lens !== "radar") url.searchParams.set("lens", filters.lens);
  if (filters.freshness !== "all") url.searchParams.set("fresh", filters.freshness);
  if (filters.risk !== "all") url.searchParams.set("risk", filters.risk);
  if (filters.watchlist !== "all") url.searchParams.set("watch", filters.watchlist);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function feedTelemetry() {
  const feedHealth = state.feedHealth;
  const nested = state.feed && typeof state.feed === "object" ? state.feed : feedHealth && typeof feedHealth === "object" ? feedHealth : {};
  return {
    rawHealth: typeof feedHealth === "string" ? feedHealth : nested.state || nested.status || nested.health || state.feedStatus || "connecting",
    lastMintAt: state.lastMintAt || nested.lastMintAt || null,
    liveMintCount: hasNumber(state.liveMintCount ?? nested.liveMintCount) ? Number(state.liveMintCount ?? nested.liveMintCount) : null,
    demoPurged: typeof (state.demoPurged ?? nested.demoPurged) === "boolean" ? state.demoPurged ?? nested.demoPurged : null,
    demoPurgedCount: hasNumber(state.demoPurgedCount ?? nested.demoPurgedCount) ? Number(state.demoPurgedCount ?? nested.demoPurgedCount) : 0,
    reconnects: hasNumber(state.reconnects ?? nested.counters?.reconnects ?? nested.reconnects) ? Number(state.reconnects ?? nested.counters?.reconnects ?? nested.reconnects) : 0,
    staleAfterSeconds: hasNumber(nested.staleAfterSeconds) ? Number(nested.staleAfterSeconds) : LEGACY_STALE_AFTER_MS / 1_000,
    uptimeSeconds: hasNumber(state.service?.uptimeSeconds) ? Number(state.service.uptimeSeconds) : null
  };
}

function durationLabel(seconds) {
  if (!hasNumber(seconds)) return "—";
  const value = Math.max(0, Math.floor(number(seconds)));
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.floor(value / 60)}m`;
  if (value < 86_400) return `${Math.floor(value / 3_600)}h ${Math.floor(value % 3_600 / 60)}m`;
  return `${Math.floor(value / 86_400)}d ${Math.floor(value % 86_400 / 3_600)}h`;
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
  else if (mintAge !== null && mintAge > telemetry.staleAfterSeconds * 1_000) label = "STALE";

  if (label === "LIVE" && mintAge !== null && mintAge > telemetry.staleAfterSeconds * 1_000 && !["live", "healthy"].includes(raw)) label = "STALE";
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
    graduations: serverStatsTrusted ? number(state.stats?.graduations) : tokens.filter((token) => token.status === "graduated").length,
    migrationsObserved: serverStatsTrusted ? number(state.stats?.migrationsObserved)
      : tokens.filter((token) => token.status === "migration-observed" || token.migrationEvidence?.evidenceClass === "feed-observed-processed").length
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
  $("#service-uptime").textContent = durationLabel(telemetry.uptimeSeconds);
  $("#freshness-window").textContent = `${telemetry.staleAfterSeconds}s verified-activity window`;
  updateMintAge();
  updateCaesarContextState();
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
    ["Migrations", stats.migrationsObserved, "processed-feed observations"]
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
  $("#ranking-kicker").textContent = state.mode === "live" ? "REAL-MINT OBSERVATIONS" : "SIMULATED RANKING";
  if (!tokens.length) {
    $("#tokens").innerHTML = emptyTape();
    return;
  }
  $("#tokens").innerHTML = tokens.map((token) => {
    const momentum = hasNumber(token.momentum) ? number(token.momentum) : "—";
    const change = hasNumber(token.priceChange5m) ? `${number(token.priceChange5m) >= 0 ? "+" : ""}${Math.round(number(token.priceChange5m))}%` : "—";
    const virtualSolReserve = hasNumber(token.curveSol) ? Math.max(0, number(token.curveSol)) : null;
    const symbol = String(token.symbol || "??");
    return `<div class="token-row" data-mint="${esc(token.mint)}">
      <div class="coin"><div class="coin-icon">${esc(symbol.slice(0, 2))}</div><div class="coin-name"><strong>${esc(token.name || "Unnamed mint")}</strong><span>${esc(symbol)} · ${esc(shortMint(token.mint))} · ${esc(token.narrative || "Unclassified")}</span></div></div>
      <div class="score">${momentum}${momentum === "—" ? "" : "<small>/100</small>"}</div>
      <div class="metric">${hasNumber(token.volume5m) ? money(token.volume5m) : "—"}<small>${change}</small></div>
      <div class="metric">${virtualSolReserve === null ? "—" : `${nf.format(virtualSolReserve)} SOL`}<small>${virtualSolReserve === null ? "unavailable" : "processed feed"}</small></div>
      <div class="score ${riskClass(token.risk)}">${riskLabel(token)}<small>${esc(riskConfidence(token))}</small></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".token-row").forEach((row) => row.addEventListener("click", () => openToken(row.dataset.mint)));
}

function outcomeCell(entry, window) {
  const outcome = entry?.outcome?.windows?.[window];
  if (!outcome || outcome.status !== "observed" || !hasNumber(outcome.returnPct)) {
    const reason = outcome?.reason ? String(outcome.reason).replaceAll("-", " ") : "No provider-observed follow-up candle";
    return `<span class="outcome-unavailable" title="${esc(reason)}">—</span>`;
  }
  const value = number(outcome.returnPct);
  const evidence = `Expected ${outcome.expectedAt || "—"}; completed close ${outcome.observedAt || "—"}; staleness ${number(outcome.stalenessSeconds)}s; source ${outcome.source || "unverified"}`;
  return `<span class="outcome-value ${value < 0 ? "negative" : "positive"}" title="${esc(evidence)}">${value >= 0 ? "+" : ""}${Math.round(value * 10) / 10}%</span>`;
}

function leaderboardEntries() {
  const entries = Array.isArray(state.leaderboard?.top100) ? [...state.leaderboard.top100] : [];
  const query = String($("#leaderboard-search")?.value || "").trim().toLowerCase();
  const freshness = $("#leaderboard-freshness")?.value || "all";
  const risk = $("#leaderboard-risk")?.value || "all";
  const watchlist = $("#leaderboard-watchlist")?.value || "all";
  const lens = $("#leaderboard-lens")?.value || "radar";
  const filtered = entries.filter((entry) => {
    const token = entry.token || {};
    const haystack = `${token.name || ""} ${token.symbol || ""} ${token.mint || ""}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (freshness === "all" || entry.freshness?.state === freshness)
      && (risk === "all" || entry.riskConfidence === risk)
      && (watchlist === "all" || watched(token.mint));
  });
  return filtered.sort((a, b) => {
    if (lens === "radar") {
      const leftScored = hasNumber(a.score);
      const rightScored = hasNumber(b.score);
      if (leftScored !== rightScored) return rightScored - leftScored;
      if (leftScored && number(a.score) !== number(b.score)) return number(b.score) - number(a.score);
      return (parseTime(b.token?.createdAt) || 0) - (parseTime(a.token?.createdAt) || 0) || number(a.rank) - number(b.rank);
    }
    const value = (entry) => lens === "momentum" ? number(entry.token?.momentum, -1) : (parseTime(entry.token?.createdAt) || 0);
    return value(b) - value(a) || number(a.rank) - number(b.rank);
  });
}

function renderLeaderboard() {
  const source = Array.isArray(state.leaderboard?.top100) ? state.leaderboard.top100 : [];
  const entries = leaderboardEntries();
  $("#leaderboard-count").textContent = nf.format(source.length);
  $("#leaderboard-updated").textContent = state.leaderboard?.generatedAt ? `UPDATED ${ageLabel(state.leaderboard.generatedAt)}` : "WAITING FOR TAPE";
  $("#leaderboard-summary").textContent = source.length
    ? `${entries.length} visible of ${source.length} ranked observations · ${state.leaderboard.rankingBasis || "inspectable live-feed signals"}.`
    : "Ranking the live-feed observations we can support—never claiming the entire market.";
  if (!entries.length) {
    $("#leaderboard-rows").innerHTML = source.length ? '<div class="leaderboard-empty">No observed coins match these filters.</div>' : emptyTape();
    return;
  }
  $("#leaderboard-rows").innerHTML = entries.map((entry) => {
    const token = entry.token || {};
    const symbol = String(token.symbol || "??");
    const reason = Array.isArray(entry.reasons) ? entry.reasons.slice(0, 2).join(" · ") : "Observed-feed ranking";
    return `<div class="leaderboard-row" data-mint="${esc(token.mint)}" role="button" tabindex="0" aria-label="Open ${esc(token.name || symbol)} details">
      <span class="leaderboard-rank">${number(entry.rank)}</span>
      <span class="leaderboard-asset"><i>${esc(symbol.slice(0, 2))}</i><span><b>${esc(token.name || "Unnamed mint")} <em>${esc(symbol)}</em></b><small>${esc(shortMint(token.mint))} · ${esc(reason)}</small></span></span>
      <span class="leaderboard-score"><b>${hasNumber(entry.score) ? number(entry.score).toFixed(1) : "—"}</b><small>${hasNumber(entry.score) ? "/100" : "RECENCY"}</small></span>
      <span class="freshness ${esc(entry.freshness?.state || "unverified")}">${esc(entry.freshness?.state || "unverified")}<small>${entry.freshness?.ageSeconds === null ? "—" : ago(entry.freshness?.observedAt)}</small></span>
      <span class="confidence ${esc(entry.riskConfidence || "unverified")}">${esc(entry.riskConfidence || "unverified")}</span>
      ${outcomeCell(entry, "5m")}${outcomeCell(entry, "1h")}${outcomeCell(entry, "24h")}
      <button type="button" class="watch-toggle ${watched(token.mint) ? "active" : ""}" data-watch-mint="${esc(token.mint)}" aria-label="${watched(token.mint) ? "Remove" : "Add"} ${esc(symbol)} ${watched(token.mint) ? "from" : "to"} browser watchlist" aria-pressed="${watched(token.mint)}">${watched(token.mint) ? "★" : "☆"}</button>
    </div>`;
  }).join("");
  document.querySelectorAll(".leaderboard-row").forEach((row) => {
    row.addEventListener("click", (event) => { if (!event.target.closest(".watch-toggle")) void openCoin(row.dataset.mint); });
    row.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key) && !event.target.closest(".watch-toggle")) { event.preventDefault(); void openCoin(row.dataset.mint); }
    });
  });
  document.querySelectorAll(".watch-toggle").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWatch(button.dataset.watchMint);
  }));
}

function toggleWatch(mint) {
  if (!PUBLIC_MINT.test(mint)) return;
  if (watched(mint)) {
    preferences.watchedMints = preferences.watchedMints.filter((candidate) => candidate !== mint);
    compareMints.delete(mint);
  } else if (preferences.watchedMints.length >= WATCHLIST_LIMIT) {
    toast(`Watchlist is capped at ${WATCHLIST_LIMIT} exact mints`);
    return;
  } else preferences.watchedMints = [...preferences.watchedMints, mint];
  savePreferences();
  compareCacheKey = "";
  compareCache = null;
  renderLeaderboard();
  renderActionIntelligence();
}

function watchedToken(mint) {
  return allTokens().find((token) => token.mint === mint)
    || state.leaderboard?.top100?.find((entry) => entry.token?.mint === mint)?.token
    || null;
}

function renderWatchlist() {
  $("#watchlist-count").textContent = `${preferences.watchedMints.length}/${WATCHLIST_LIMIT}`;
  $("#preference-status").textContent = preferenceStorageAvailable
    ? "Origin-local only; not cross-device and does not control operator Telegram delivery."
    : "Browser storage is unavailable; changes last only for this page session. Export JSON to retain them.";
  $("#watchlist-items").innerHTML = preferences.watchedMints.length ? preferences.watchedMints.map((mint) => {
    const token = watchedToken(mint);
    const label = token ? `${token.name || "Unnamed mint"} · ${token.symbol || "???"}` : "Retained mint · outside current snapshot";
    return `<div class="watchlist-item"><button type="button" class="watch-open" data-open-watch="${esc(mint)}"><b>${esc(label)}</b><small>${esc(shortMint(mint))}</small></button><label><input type="checkbox" data-compare-mint="${esc(mint)}" ${compareMints.has(mint) ? "checked" : ""}>COMPARE</label><button type="button" class="watch-remove" data-remove-watch="${esc(mint)}" aria-label="Remove ${esc(shortMint(mint))} from watchlist">×</button></div>`;
  }).join("") : '<div class="action-empty">Star an observed coin to keep it in this browser.</div>';
  document.querySelectorAll("[data-open-watch]").forEach((button) => button.addEventListener("click", () => void openCoin(button.dataset.openWatch)));
  document.querySelectorAll("[data-remove-watch]").forEach((button) => button.addEventListener("click", () => toggleWatch(button.dataset.removeWatch)));
  document.querySelectorAll("[data-compare-mint]").forEach((input) => input.addEventListener("change", () => {
    if (input.checked && compareMints.size >= 4) { input.checked = false; toast("Compare is capped at four exact mints"); return; }
    if (input.checked) compareMints.add(input.dataset.compareMint); else compareMints.delete(input.dataset.compareMint);
    compareCacheKey = "";
    compareCache = null;
    renderComparison();
  }));
}

function renderPresets() {
  const select = $("#preset-select");
  const current = select.value;
  select.innerHTML = preferences.presets.length
    ? '<option value="">Choose a saved lens</option>' + preferences.presets.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`).join("")
    : '<option value="">No saved lenses</option>';
  if (preferences.presets.some((preset) => preset.id === current)) select.value = current;
  $("#delete-preset").disabled = !select.value;
}

function comparisonCell(value, formatter = (entry) => entry) {
  return value === null || value === undefined ? '<span class="comparison-missing">—</span>' : esc(formatter(value));
}

function renderComparisonResult(result) {
  const coins = Array.isArray(result?.coins) ? result.coins : [];
  const missing = Array.isArray(result?.missingMints) ? result.missingMints : [];
  if (!coins.length) {
    $("#compare-results").innerHTML = '<div class="action-empty">No retained public evidence matched this comparison.</div>';
    return;
  }
  const rows = [
    ["RADAR", (coin) => comparisonCell(coin.radarScore, (value) => Number(value).toFixed(1))],
    ["MOMENTUM", (coin) => comparisonCell(coin.momentum)],
    ["TOP 10", (coin) => comparisonCell(coin.factors?.top10Percentage?.value, (value) => `${value}%`)],
    ["DEV HOLDING", (coin) => comparisonCell(coin.factors?.developerHoldingPercentage?.value, (value) => `${value}%`)],
    ["POOL RESERVE", (coin) => comparisonCell(coin.factors?.liquidityUsd?.value, money)],
    ["5M RETURN", (coin) => comparisonCell(coin.outcomes?.["5m"]?.returnPct, signedPct)],
    ["1H RETURN", (coin) => comparisonCell(coin.outcomes?.["1h"]?.returnPct, signedPct)],
    ["24H RETURN", (coin) => comparisonCell(coin.outcomes?.["24h"]?.returnPct, signedPct)]
  ];
  $("#compare-results").innerHTML = `<div class="comparison-table" style="--comparison-columns:${coins.length}"><div class="comparison-head"><span>MEASURE</span>${coins.map((coin) => `<button type="button" data-compare-open="${esc(coin.mint)}"><b>${esc(coin.symbol)}</b><small>${esc(shortMint(coin.mint))}</small></button>`).join("")}</div>${rows.map(([label, value]) => `<div class="comparison-row"><b>${label}</b>${coins.map((coin) => `<span>${value(coin)}</span>`).join("")}</div>`).join("")}</div>${missing.length ? `<p class="comparison-warning">No retained row for ${missing.map(shortMint).map(esc).join(", ")}.</p>` : ""}<p class="comparison-footnote">Risk factors are uncalibrated and excluded from rank. Missing values are not zeros.</p>`;
  document.querySelectorAll("[data-compare-open]").forEach((button) => button.addEventListener("click", () => void openCoin(button.dataset.compareOpen)));
}

async function renderComparison() {
  const mints = [...compareMints];
  $("#compare-selection").textContent = mints.length ? `${mints.length}/4 selected · ${mints.map(shortMint).join(" · ")}` : "Select two watched coins to compare.";
  if (mints.length < 2) {
    $("#compare-results").innerHTML = '<div class="action-empty">Select at least two exact mints. Unavailable values stay unavailable.</div>';
    return;
  }
  const key = mints.join(",");
  if (compareCacheKey === key && compareCache) { renderComparisonResult(compareCache); return; }
  const sequence = ++compareRequestSequence;
  $("#compare-results").innerHTML = '<div class="action-empty">Loading bounded comparison…</div>';
  try {
    const response = await fetch(`/api/compare?mints=${encodeURIComponent(key)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Compare returned ${response.status}`);
    const result = await response.json();
    if (sequence !== compareRequestSequence) return;
    compareCacheKey = key;
    compareCache = result;
    renderComparisonResult(result);
  } catch {
    if (sequence === compareRequestSequence) $("#compare-results").innerHTML = '<div class="action-empty error">Comparison is temporarily unavailable.</div>';
  }
}

function renderBrief(target, brief) {
  const element = $(target);
  if (!brief || typeof brief !== "object") {
    element.innerHTML = '<span class="kicker">MEASURED BRIEF</span><div class="action-empty">No frozen closed-period brief is available.</div>';
    return;
  }
  const metric = brief.outcomes?.windows?.["1h"] || {};
  const measured = metric.status === "sufficient-evidence";
  element.innerHTML = `<span class="kicker">${brief.period === "weekly" ? "LAST CLOSED UTC WEEK" : "LAST CLOSED UTC DAY"}</span><div class="brief-title"><h3>${esc(brief.windowStart.slice(0, 10))} → ${esc(brief.windowEnd.slice(0, 10))}</h3><span>${esc(metric.status || "unavailable")}</span></div><div class="brief-metrics"><div><b>${nf.format(number(brief.activity?.launchesObserved))}</b><small>OBSERVED LAUNCHES</small></div><div><b>${nf.format(number(brief.activity?.migrationObservations))}</b><small>MIGRATION OBSERVATIONS</small></div><div><b>${nf.format(number(brief.activity?.materialAlerts))}</b><small>MATERIAL EVENTS</small></div><div><b>${measured ? signedPct(metric.medianReturnPct) : "—"}</b><small>1H MEDIAN · ${number(metric.evidenceCount)}/${number(metric.eligibleCount)}</small></div></div><p>Frozen at ${esc(brief.generatedAt)} · feed coverage unmeasured · raw provider payloads excluded.</p>`;
}

function renderActionIntelligence() {
  if (!$("#watchlist-items")) return;
  renderWatchlist();
  renderPresets();
  void renderComparison();
  const action = state.actionIntelligence && typeof state.actionIntelligence === "object" ? state.actionIntelligence : {};
  const telegram = action.alerts?.telegram || {};
  $("#telegram-alert-state").textContent = telegram.status === "configured" ? "TELEGRAM CONFIGURED" : "TELEGRAM NOT CONFIGURED";
  const counts = telegram.outbox?.statusCounts || {};
  $("#action-method-state").textContent = telegram.status === "configured"
    ? `MATERIALITY POLICY v1 · ${number(counts.pending) + number(counts.retrying)} PENDING · ${number(counts["dead-letter"])} DEAD-LETTER`
    : "MATERIALITY POLICY v1 · NOT CALIBRATED RISK";
  renderBrief("#daily-brief", action.briefs?.daily);
  renderBrief("#weekly-brief", action.briefs?.weekly);
}

function signedPct(value) {
  if (!hasNumber(value)) return "—";
  const rounded = Math.round(number(value) * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function renderRiskIntelligence() {
  const risk = state.riskIntelligence && typeof state.riskIntelligence === "object" ? state.riskIntelligence : {};
  const engine = risk.engine && typeof risk.engine === "object" ? risk.engine : {};
  const syntheticDemo = state.mode === "demo";
  $("#risk-engine-state").textContent = String(engine.status || (state.mode === "live" ? "acquiring" : "disabled")).toUpperCase();
  const summary = risk.summary && typeof risk.summary === "object" ? risk.summary : {};
  const total = number(summary.totalTracked ?? risk.coverage?.stateCount);
  const ratio = (value) => total ? `${nf.format(number(value))}/${nf.format(total)}` : "0/0";
  const cards = syntheticDemo ? [
    ["SYNTHETIC HOLDER DEMO", ratio(summary.holderEvidenceCount), "Synthetic demonstration distribution; not a provider observation", summary.holderEvidenceCount],
    ["SYNTHETIC DEVELOPER DEMO", ratio(summary.developerEvidenceCount), "Synthetic demonstration percentage; no creator identity claim", summary.developerEvidenceCount],
    ["SYNTHETIC IDENTITY DEMO", nf.format(number(summary.exactDuplicateTokenCount)), "Synthetic demonstration reuse only; no control or fraud claim", summary.exactDuplicateTokenCount],
    ["SYNTHETIC HISTORY DEMO", ratio(summary.identityHistoryCount), "Synthetic demonstration history; not an observed launch cohort", summary.identityHistoryCount],
    ["SYNTHETIC RESERVE DEMO", ratio(summary.liquidityEvidenceCount), "No provider reserve is acquired in demo mode", summary.liquidityEvidenceCount],
    ["SYNTHETIC CURVE DEMO", ratio(summary.curveEvidenceCount), "Synthetic demonstration value; not processed-feed evidence", summary.curveEvidenceCount]
  ] : [
    ["HOLDER DISTRIBUTION", ratio(summary.holderEvidenceCount), "GeckoTerminal-reported count + top-10 percentage", summary.holderEvidenceCount],
    ["DEVELOPER HOLDING", ratio(summary.developerEvidenceCount), "Provider-reported address/percentage; creator identity unverified", summary.developerEvidenceCount],
    ["EXACT IDENTITY REUSE", nf.format(number(summary.exactDuplicateTokenCount)), "Exact declared social or registrable-domain reuse; control unknown", summary.exactDuplicateTokenCount],
    ["OBSERVED HISTORY", ratio(summary.identityHistoryCount), "Prospective declared-creator or deployer launches in this deployment", summary.identityHistoryCount],
    ["POOL RESERVE", ratio(summary.liquidityEvidenceCount), "Provider-observed reserve; not locked-liquidity evidence", summary.liquidityEvidenceCount],
    ["VIRTUAL SOL RESERVE", ratio(summary.curveEvidenceCount), "Processed-feed vSolInBondingCurve; not curve progress or migration proof", summary.curveEvidenceCount]
  ];
  $("#risk-factor-summary").innerHTML = cards.map(([label, value, note, observed]) => `<article class="risk-factor-card ${number(observed) ? "observed" : "waiting"}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
  const coverage = risk.coverage && typeof risk.coverage === "object" ? risk.coverage : {};
  $("#risk-coverage").textContent = syntheticDemo
    ? `${nf.format(total)} SYNTHETIC DEMO records · no provider acquisition or feed verification`
    : `${nf.format(number(coverage.successCount))}/${nf.format(number(coverage.stateCount))} normalized provider records · ${nf.format(number(summary.migrationObservationCount))} processed-feed migration observations`;
  const cohort = risk.cohort && typeof risk.cohort === "object" ? risk.cohort : {};
  const observations = Array.isArray(cohort.observations) ? cohort.observations : [];
  $("#risk-cohort-scope").textContent = syntheticDemo
    ? `${nf.format(number(cohort.admittedCount))} SYNTHETIC DEMO rows · no provider cohort admission`
    : `${nf.format(number(cohort.admittedCount))}/${nf.format(number(cohort.limit, 120))} admitted independently from the outcome cohort`;
  $("#risk-cohort").innerHTML = observations.length ? observations.slice(0, 12).map((observation) => {
    const factors = observation.riskIdentity?.factors || {};
    const concentration = factors.concentration || {};
    const developer = factors.developer || {};
    const liquidity = factors.liquidity || {};
    const identity = factors.identity || {};
    const status = observation.riskIdentity?.providerObservation?.sourceStatus || observation.riskIdentity?.overallEvidence || "unavailable";
    const evidence = [
      hasNumber(concentration.top10Percentage) ? `TOP10 ${number(concentration.top10Percentage).toFixed(1)}%` : null,
      hasNumber(developer.holdingPercentage) ? `DEV ${number(developer.holdingPercentage).toFixed(2)}%` : null,
      hasNumber(liquidity.liquidityUsd) ? `RESERVE ${money(liquidity.liquidityUsd)}` : null,
      hasNumber(identity.exactDuplicateCount) ? `REUSE ${nf.format(number(identity.exactDuplicateCount))}` : null
    ].filter(Boolean).join(" · ") || `EVIDENCE ${String(status).toUpperCase()}`;
    const displayEvidence = syntheticDemo ? `SYNTHETIC DEMO · ${evidence}` : evidence;
    const timingLabel = syntheticDemo ? "synthetic launch" : "observed";
    return `<button type="button" class="risk-cohort-row" data-risk-mint="${esc(observation.mint)}"><span><b>${esc(observation.name || "Unnamed mint")}</b><small>${esc(observation.symbol || "??")} · ${esc(shortMint(observation.mint))}</small></span><span><b>${esc(displayEvidence)}</b><small>${timingLabel} ${esc(observation.createdAt || "—")}</small></span></button>`;
  }).join("") : syntheticDemo
    ? '<div class="risk-cohort-empty">SYNTHETIC DEMO has no rows; no provider cohort admission is implied.</div>'
    : '<div class="risk-cohort-empty">The independent v0.7 cohort admits new feed observations while the worker is active; no historical backfill is implied.</div>';
  document.querySelectorAll(".risk-cohort-row").forEach((row) => row.addEventListener("click", () => void openCoin(row.dataset.riskMint)));
}

function renderOutcomes() {
  const outcomeState = state.outcomes && typeof state.outcomes === "object" ? state.outcomes : {};
  const engine = outcomeState.engine && typeof outcomeState.engine === "object" ? outcomeState.engine : {};
  const status = String(engine.status || (state.mode === "live" ? "acquiring" : "disabled")).toUpperCase();
  $("#outcome-engine-state").textContent = status;
  const windows = outcomeState.summary?.windows && typeof outcomeState.summary.windows === "object" ? outcomeState.summary.windows : {};
  const keys = ["5m", "15m", "1h", "6h", "24h"];
  $("#outcome-summary").innerHTML = keys.map((key) => {
    const metric = windows[key] || {};
    const sufficient = metric.status === "sufficient-evidence";
    const sample = number(metric.evidenceCount);
    const minimum = number(metric.minimumEvidence, 3);
    const coverage = Math.round(number(metric.coverageRatio) * 100);
    const minimumCoverage = Math.round(number(metric.minimumCoverageRatio, 0.5) * 100);
    return `<article class="outcome-card ${sufficient ? "measured" : "waiting"}"><span>${key.toUpperCase()} RETURN</span><strong>${sufficient ? signedPct(metric.medianReturnPct) : "—"}</strong><dl><div><dt>HIT RATE</dt><dd>${sufficient ? signedPct(metric.hitRatePct) : "—"}</dd></div><div><dt>WORST DRAWDOWN</dt><dd>${sufficient ? signedPct(-number(metric.maximumDrawdownPct)) : "—"}</dd></div></dl><small>${sample}/${minimum} evidence · ${coverage}%/${minimumCoverage}% coverage</small></article>`;
  }).join("");
  const cohorts = Array.isArray(outcomeState.cohorts?.narrative?.cohorts) ? outcomeState.cohorts.narrative.cohorts : [];
  $("#outcome-cohorts").innerHTML = cohorts.length ? cohorts.slice(0, 8).map((cohort) => {
    const metric = cohort.windows?.["1h"] || {};
    const sufficient = metric.status === "sufficient-evidence";
    return `<div class="outcome-cohort"><span><b>${esc(cohort.cohort)}</b><small>${number(cohort.outcomeCount)} tracked</small></span><span><b>${sufficient ? signedPct(metric.medianReturnPct) : "—"}</b><small>${sufficient ? `${signedPct(metric.hitRatePct)} hit rate` : `${number(metric.evidenceCount)}/${number(metric.minimumEvidence, 3)} evidence`}</small></span></div>`;
  }).join("") : '<div class="outcome-empty">No narrative cohort has provider-observed follow-up evidence yet.</div>';
  const coverage = outcomeState.coverage && typeof outcomeState.coverage === "object" ? outcomeState.coverage : {};
  const cohortLimit = number(outcomeState.sampling?.cohortLimit, 120);
  $("#outcome-coverage").textContent = `${nf.format(number(coverage.total ?? outcomeState.summary?.outcomeCount))}/${nf.format(cohortLimit)} prospective cohort · ${nf.format(number(coverage.withObservedWindows))} with measured windows · raw candle retention off`;
}

function outcomeDetail(entry) {
  const outcome = entry?.outcome;
  if (!outcome?.windows) return '<div class="outcome-detail"><span class="kicker">PROVIDER-OBSERVED OUTCOMES</span><p>No provider-grounded outcome record is available for this observation.</p></div>';
  const rows = ["5m", "15m", "1h", "6h", "24h"].map((key) => {
    const window = outcome.windows[key] || {};
    if (window.status !== "observed") return `<div><b>${key}</b><strong>—</strong><small>${esc(String(window.reason || "target observation missing").replaceAll("-", " "))}</small></div>`;
    return `<div><b>${key}</b><strong class="${number(window.returnPct) < 0 ? "negative" : "positive"}">${signedPct(window.returnPct)}</strong><small>close ${esc(window.observedAt || "—")} · calculated ${esc(window.calculatedAt || "—")} · staleness ${number(window.stalenessSeconds)}s · drawdown ${signedPct(-number(window.maximumDrawdownPct))}</small></div>`;
  }).join("");
  const baseline = outcome.baseline?.status === "observed" ? `Initial baseline reference completed ${outcome.baseline.observedAt}; ${outcome.baseline.source} pool ${shortMint(outcome.baseline.pool)}` : `Baseline ${String(outcome.baseline?.reason || "missing").replaceAll("-", " ")}`;
  return `<div class="outcome-detail"><span class="kicker">PROVIDER-OBSERVED OUTCOMES // SOURCE EVIDENCE</span><p>${esc(baseline)}. Each horizon freezes its first derived value from a baseline and target returned together in that provider refresh; calculated timestamps disclose independently observed provider revisions. Returns never interpolate gaps.</p><div class="outcome-detail-grid">${rows}</div></div>`;
}

function riskIdentityDetail(token) {
  const identity = token?.riskIdentity && typeof token.riskIdentity === "object" ? token.riskIdentity : {};
  const factors = identity.factors && typeof identity.factors === "object" ? identity.factors : {};
  const concentration = factors.concentration || {};
  const developer = factors.developer || {};
  const creator = factors.creatorHistory || {};
  const duplicate = factors.identity || {};
  const liquidity = factors.liquidity || {};
  const curve = factors.curve || {};
  const lifecycle = factors.lifecycle || {};
  const holderValue = hasNumber(concentration.top10Percentage) ? `${number(concentration.top10Percentage).toFixed(1)}% top 10` : "—";
  const developerValue = hasNumber(developer.holdingPercentage) ? `${number(developer.holdingPercentage).toFixed(2)}%` : "—";
  const historyValue = hasNumber(creator.observedLaunchCount) ? `${nf.format(number(creator.observedLaunchCount))} observed` : "—";
  const duplicateValue = hasNumber(duplicate.exactDuplicateCount) ? `${nf.format(number(duplicate.exactDuplicateCount))} exact` : "—";
  const liquidityValue = hasNumber(liquidity.liquidityUsd) ? money(liquidity.liquidityUsd) : "—";
  const curveValue = hasNumber(curve.virtualSolReserve) ? `${nf.format(number(curve.virtualSolReserve))} virtual SOL` : "—";
  const migrationValue = lifecycle.migrationObserved ? "FEED OBSERVED" : "—";
  const acquisition = concentration.sourceStatus
    ? `${concentration.sourceStatus}${concentration.missingReasonCode ? `/${concentration.missingReasonCode}` : ""} · attempted ${concentration.lastAttemptAt || "—"} · next ${concentration.nextAttemptAt || "—"}`
    : null;
  const rows = [
    ["Concentration", holderValue, `${concentration.evidenceClass || "unavailable"} · ${hasNumber(concentration.holderCount) ? nf.format(number(concentration.holderCount)) + " holders" : "holder count unknown"} · provider updated ${concentration.providerUpdatedAt || "—"} · fetched ${concentration.fetchedAt || "—"}${acquisition ? ` · ${acquisition}` : ""}`],
    ["Developer holding", developerValue, `${developer.evidenceClass || "unavailable"} · fetched ${developer.fetchedAt || "—"} · not verified creator identity`],
    ["Observed history", historyValue, `${creator.evidenceClass || "unavailable"} · ${creator.role || "identity unavailable"} · calculated ${creator.calculatedAt || "—"} · ${creator.scope || "prospective scope unavailable"}`],
    ["Identity reuse", duplicateValue, `${duplicate.evidenceClass || "unavailable"} · name/symbol collision ${hasNumber(duplicate.nameSymbolCollisionCount) ? nf.format(number(duplicate.nameSymbolCollisionCount)) : "—"} (low confidence) · calculated ${duplicate.calculatedAt || "—"} · ${duplicate.scope || "scope unavailable"}`],
    ["Pool reserve", liquidityValue, `${liquidity.evidenceClass || "unavailable"} · ${liquidity.missingReasonCode || "observed"} · timestamp ${liquidity.observedAt || liquidity.lastAttemptAt || "—"} · not locked or launch-time liquidity`],
    ["Virtual SOL reserve", curveValue, `${curve.evidenceClass || "unavailable"} · create transaction SOL ${hasNumber(curve.launchSolAmount) ? nf.format(number(curve.launchSolAmount)) : "—"} · observed ${curve.observedAt || "—"} · neither proves curve progress or migration`],
    ["Migration", migrationValue, `${lifecycle.evidenceClass || "unavailable"} · observed ${lifecycle.observedAt || "—"} · processed feed is not finalized proof`]
  ].map(([label, value, note]) => `<div><b>${esc(label)}</b><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  const missing = Array.isArray(identity.missing) && identity.missing.length ? ` Explicit unknowns: ${identity.missing.join(", ")}.` : "";
  return `<div class="risk-detail"><span class="kicker">RISK + IDENTITY FACTORS // ${esc(identity.overallEvidence || "unavailable")}</span><p>No composite risk probability is published and these factors do not affect rank. Exact declared-social or registrable-domain matches establish identifier reuse only—not duplicate content; likely controller and maliciousness remain unknown.${esc(missing)}</p><div class="risk-detail-grid">${rows}</div></div>`;
}

function durationMsLabel(value) {
  if (!hasNumber(value) || number(value) < 0) return "—";
  const seconds = Math.round(number(value) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3_600 * 10) / 10}h`;
}

function offsetMsLabel(value) {
  if (!hasNumber(value)) return "—";
  const amount = number(value);
  return `${amount < 0 ? "−" : "+"}${durationMsLabel(Math.abs(amount))}`;
}

function earlyActorDetail(summary, acquisition = null) {
  const coverage = summary?.coverage && typeof summary.coverage === "object" ? summary.coverage : {};
  const metrics = summary?.metrics && typeof summary.metrics === "object" ? summary.metrics : null;
  const stateLabel = String(coverage.state || acquisition?.status || "unavailable").replaceAll("-", " ");
  if (!metrics) {
    const gate = coverage.gate || {};
    const gateEvidence = summary
      ? `${number(coverage.eventCount)}/${number(gate.minimumEventCount, 5)} summarized observations · ${number(coverage.uniqueActorCount)}/${number(gate.minimumActorCount, 3)} actors · source time ${Math.round(number(coverage.sourceTimestamps?.ratio) * 100)}%`
      : "No minimized actor observation summary is retained for this mint.";
    const reason = acquisition?.missingReason || "The minimum event, actor, and source-time gate has not been met.";
    return `<div class="early-actor-detail"><span class="kicker">ANONYMOUS EARLY-ACTOR EVIDENCE // ${esc(stateLabel.toUpperCase())}</span><p>${esc(gateEvidence)}. ${esc(reason)} Missing evidence is unknown; no behavior or outcome inference is published.</p></div>`;
  }
  const timing = metrics.timing || {};
  const repeats = metrics.repeatActivity || {};
  const holding = metrics.holdingDurationEvidence || {};
  const amount = metrics.amountConcentration || {};
  const burst = metrics.activityBurst || {};
  const rows = [
    ["Unique actors", nf.format(number(metrics.uniqueActors?.count)), `${number(coverage.eventCount)} summarized observations · source-time coverage ${Math.round(number(coverage.sourceTimestamps?.ratio) * 100)}%`],
    ["Launch-relative timing", timing.state === "available" ? offsetMsLabel(timing.actorFirstObservationOffsetMs?.median) : "—", `${timing.actorsObservedWithinWindow ?? "—"} actors observed inside the ${durationMsLabel(timing.earlyWindowMs)} bounded window; source time minus launch receipt`],
    ["Repeat activity", `${number(repeats.actorsWithMultipleBuys)} buy / ${number(repeats.actorsWithMultipleSells)} sell`, `${number(repeats.actorsObservedOnBothSides)} actors observed on both validated sides`],
    ["Observed duration", holding.state === "available" ? durationMsLabel(holding.medianMs) : "—", `${number(holding.pairedObservationCount)} observed buy-to-later-sell pairings; not a complete holding period`],
    ["Amount concentration", amount.state === "available" ? `${Math.round(number(amount.largestActorShare) * 100)}%` : "—", "Largest share of sampled token amount; not holder concentration or current holdings"],
    ["Activity burst", burst.state === "available" ? `${number(burst.maximumEventCount)} events` : "—", `${number(burst.maximumUniqueActorCount)} unique actors in the busiest ${durationMsLabel(burst.windowMs)} sampled window`]
  ].map(([label, value, note]) => `<div><b>${esc(label)}</b><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  return `<div class="early-actor-detail"><span class="kicker">ANONYMOUS EARLY-ACTOR EVIDENCE // ELIGIBLE PER-COIN SAMPLE</span><p>Finalized instruction evidence is bounded and partial. Actor numbers are installation-scoped, non-reversible labels—not identities. These observations do not establish coordination, automation, intent, skill, safety, or a trade signal.</p><div class="early-actor-detail-grid">${rows}</div></div>`;
}

function renderEarlyActors() {
  const intelligence = state.earlyActorIntelligence && typeof state.earlyActorIntelligence === "object" ? state.earlyActorIntelligence : {};
  const engine = intelligence.engine && typeof intelligence.engine === "object" ? intelligence.engine : {};
  const cohort = intelligence.cohort && typeof intelligence.cohort === "object" ? intelligence.cohort : {};
  const observations = Array.isArray(cohort.observations) ? cohort.observations : [];
  const engineStatus = String(engine.status || (state.mode === "live" ? "awaiting-prospective-admission" : "disabled"));
  $("#early-actor-engine-state").textContent = engineStatus.replaceAll("-", " ").toUpperCase();
  const counts = engine.cohort || {};
  const admitted = number(counts.admittedCount ?? cohort.admittedCount);
  const limit = number(counts.limit ?? cohort.limit, 32);
  const evidenceMints = number(counts.evidenceMintCount);
  const eligibleMints = number(counts.eligibleMintCount);
  const acquisition = admitted ? Math.round(evidenceMints / admitted * 100) : 0;
  $("#early-actor-summary").innerHTML = [
    ["ADMITTED MINTS", `${nf.format(admitted)}/${nf.format(limit)}`, "fixed prospective cohort; no historical backfill"],
    ["EVIDENCE MINTS", nf.format(evidenceMints), `${admitted ? acquisition : 0}% sampled acquisition; completeness unmeasured`],
    ["ELIGIBLE MINTS", nf.format(eligibleMints), "per-coin event, actor, and source-time gates met"],
    ["RAW ADDRESSES / SIGNATURES", "EXCLUDED", "not stored in actor evidence tables or exposed publicly"]
  ].map(([label, value, note]) => `<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
  $("#early-actor-cohort-scope").textContent = `${nf.format(admitted)}/${nf.format(limit)} admitted · showing all ${nf.format(observations.length)} · ${nf.format(evidenceMints)} with evidence`;
  $("#early-actor-cohort").innerHTML = observations.length ? observations.map((observation) => {
    const coverage = observation.summary?.coverage || {};
    const status = String(coverage.state || observation.acquisition?.status || "unavailable").replaceAll("-", " ");
    const detail = observation.summary
      ? `${number(coverage.eventCount)} events · ${number(coverage.uniqueActorCount)} actors`
      : observation.acquisition?.missingReason || "No retained observation summary";
    return `<button type="button" class="early-actor-row" data-early-actor-mint="${esc(observation.mint)}"><span><b>${esc(observation.name || "Unnamed mint")}</b><small>${esc(observation.symbol || "??")} · ${esc(shortMint(observation.mint))}</small></span><span><b>${esc(status.toUpperCase())}</b><small>${esc(detail)}</small></span></button>`;
  }).join("") : '<div class="early-actor-empty">The v0.9 cohort admits only new PumpPortal launch observations while this worker is active. No backfill is implied.</div>';
  document.querySelectorAll(".early-actor-row").forEach((row) => row.addEventListener("click", () => void openCoin(row.dataset.earlyActorMint)));
  const gate = engine.correlationGate || intelligence.downstream || {};
  $("#early-actor-gate").textContent = gate.status === "review-required" ? "POLICY REVIEW REQUIRED" : "CORRELATIONS WITHHELD";
}

function narrativeRows() {
  return Object.values(rankedTokens().reduce((rows, token) => {
    const name = token.narrative || "Unclassified";
    const row = rows[name] ||= { name, coins: 0, volume: null, volumeEvidenceCount: 0 };
    row.coins += 1;
    if (hasNumber(token.volume5m) && number(token.volume5m) >= 0) {
      row.volume = (row.volume ?? 0) + number(token.volume5m);
      row.volumeEvidenceCount++;
    }
    return rows;
  }, {})).sort((a, b) => b.volumeEvidenceCount - a.volumeEvidenceCount
    || number(b.volume) - number(a.volume) || b.coins - a.coins || a.name.localeCompare(b.name));
}

function renderNarratives() {
  const narratives = narrativeRows().slice(0, 6);
  if (!narratives.length) {
    $("#narratives").innerHTML = '<div class="rail-empty">No real-mint narrative clusters yet.</div>';
    return;
  }
  const measuredVolumes = narratives.filter((narrative) => narrative.volumeEvidenceCount > 0).map((narrative) => narrative.volume);
  const max = Math.max(...measuredVolumes, 1);
  $("#narratives").innerHTML = narratives.map((narrative) => {
    const measured = narrative.volumeEvidenceCount > 0;
    const volume = measured ? money(narrative.volume) : "volume —";
    const width = measured ? Math.max(5, narrative.volume / max * 100) : 0;
    return `<div class="narrative"><div class="narrative-top"><span>${esc(narrative.name)}</span><span>${narrative.coins} coins · ${volume}</span></div><div class="bar"><i style="width:${width}%"></i></div></div>`;
  }).join("");
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
    <div><strong>${esc(callout.sourceActor || "Anonymous source actor")} observed ${esc(callout.symbol)}</strong><span>${esc(shortMint(callout.mint))} · ${money(callout.marketCap)}</span></div>
    <b>${hasNumber(callout.multiple) ? `${number(callout.multiple).toFixed(1)}×` : "NEW"}</b><time>${ago(callout.createdAt)}</time>
  </a>`).join("") : `<div class="loading">${state.calloutStatus === "disabled" ? "Callout telemetry is not configured." : "Listening for observed callouts…"}</div>`;
}

function updateCaesarContextState() {
  const badge = $("#caesar-context-state");
  if (!badge) return;
  const feed = healthView().label;
  const view = state.mode !== "live"
    ? { label: "SIMULATED TAPE", className: "simulated" }
    : feed === "LIVE"
      ? { label: "LIVE TAPE", className: "live" }
      : feed === "STALE"
        ? { label: "STALE TAPE", className: "stale" }
        : { label: "UNVERIFIED TAPE", className: "unverified" };
  badge.className = `context-badge ${view.className}`;
  badge.querySelector("b").textContent = view.label;
  badge.setAttribute("aria-label", `Analyst context: ${view.label}`);
}

function intelElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function intelTime(value) {
  const timestamp = parseTime(value) || Date.now();
  return new Date(timestamp).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET";
}

function validMint(value) {
  const mint = typeof value === "string" ? value.trim() : "";
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? mint : "";
}

function trimIntelTranscript(transcript) {
  while (transcript.children.length > 24) transcript.firstElementChild?.remove();
}

function scrollIntelTranscript() {
  const transcript = $("#caesar-transcript");
  requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
}

function appendIntelMessage({ role, text, evidence = [], generatedAt, error = false }) {
  const transcript = $("#caesar-transcript");
  const item = intelElement("li", `intel-message ${role}${error ? " error" : ""}`);
  const mark = intelElement("div", "message-mark", role === "user" ? "U" : error ? "!" : "C");
  mark.setAttribute("aria-hidden", "true");
  const body = intelElement("div", "message-body");
  const meta = intelElement("div", "message-meta");
  meta.append(intelElement("strong", "", role === "user" ? "YOU" : error ? "CHANNEL NOTICE" : "CAESAR INTEL"));
  meta.append(intelElement("span", "", intelTime(generatedAt)));
  body.append(meta, intelElement("p", "", cappedText(text, role === "user" ? CAESAR_MAX_QUESTION : CAESAR_MAX_ANSWER)));

  if (role === "assistant" && !error) {
    const grounding = intelElement("div", "message-grounding");
    grounding.setAttribute("aria-label", "Tape observations cited by Caesar Intel");
    grounding.append(intelElement("span", "grounding-label", "GROUNDING"));
    const records = Array.isArray(evidence) ? evidence.slice(0, 8) : [];
    const validRecords = records.filter((record) => record && typeof record === "object" && typeof record.label === "string" && record.label.trim());
    if (!validRecords.length) {
      grounding.append(intelElement("span", "grounding-empty", "NO CITED TAPE OBSERVATIONS"));
    } else {
      const chips = intelElement("div", "evidence-chips");
      for (const record of validRecords) {
        const chip = intelElement("span", "evidence-chip");
        chip.append(intelElement("b", "", cappedText(record.label, 100)));
        const mint = validMint(record.mint);
        if (mint) chip.append(intelElement("small", "", shortMint(mint)));
        chips.append(chip);
      }
      grounding.append(chips);
    }
    body.append(grounding);
  }

  item.append(mark, body);
  transcript.append(item);
  trimIntelTranscript(transcript);
  scrollIntelTranscript();
  return item;
}

function appendIntelLoading() {
  const transcript = $("#caesar-transcript");
  const item = intelElement("li", "intel-message assistant pending");
  item.dataset.state = "loading";
  const mark = intelElement("div", "message-mark", "C");
  mark.setAttribute("aria-hidden", "true");
  const body = intelElement("div", "message-body");
  const meta = intelElement("div", "message-meta");
  meta.append(intelElement("strong", "", "CAESAR INTEL"), intelElement("span", "", "ANALYZING"));
  body.append(meta, intelElement("p", "thinking-line", "Reading the current tape"));
  item.append(mark, body);
  transcript.append(item);
  scrollIntelTranscript();
  return item;
}

function setCaesarStatus(message, kind = "") {
  const status = $("#caesar-form-status");
  status.textContent = message;
  status.dataset.state = kind;
}

function setCaesarBusy(busy) {
  caesarRequestPending = busy;
  $("#caesar-form").setAttribute("aria-busy", String(busy));
  $("#caesar-transcript").setAttribute("aria-busy", String(busy));
  $("#caesar-question").disabled = busy;
  $("#caesar-submit").disabled = busy;
  document.querySelectorAll(".quick-prompt").forEach((button) => { button.disabled = busy; });
}

function caesarAnswer(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [payload.answer, payload.response, payload.message, payload.data?.answer];
  return cappedText(candidates.find((candidate) => typeof candidate === "string") || "", CAESAR_MAX_ANSWER);
}

function caesarErrorMessage(status, timedOut) {
  if (timedOut) return "The briefing timed out before the tape could be analyzed. Try again.";
  if (status === 400 || status === 422) return "Caesar could not parse that request. Rephrase it and try again.";
  if (status === 401 || status === 403) return "The analyst channel is not available in this session.";
  if (status === 429) return "Caesar is handling another briefing. Wait a moment and try again.";
  if (status >= 500) return "Caesar Intel is temporarily offline. The dashboard remains available; try again shortly.";
  return "The analyst channel was interrupted. Check your connection and try again.";
}

async function askCaesar(question) {
  const submittedQuestion = String(question || "").trim().slice(0, CAESAR_MAX_QUESTION);
  if (!submittedQuestion || caesarRequestPending) {
    if (!submittedQuestion) {
      setCaesarStatus("ENTER A QUESTION", "error");
      $("#caesar-question").focus();
    }
    return;
  }

  appendIntelMessage({ role: "user", text: submittedQuestion });
  $("#caesar-question").value = "";
  setCaesarBusy(true);
  setCaesarStatus("ANALYZING CURRENT TAPE", "loading");
  const loadingMessage = appendIntelLoading();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAESAR_TIMEOUT_MS);
  let responseStatus = 0;

  try {
    const response = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ question: submittedQuestion }),
      signal: controller.signal
    });
    responseStatus = response.status;
    const payload = await response.json();
    const answer = caesarAnswer(payload);
    if (!response.ok || payload?.ok === false || !answer) throw new Error("request-failed");
    loadingMessage.remove();
    appendIntelMessage({ role: "assistant", text: answer, evidence: payload.evidence, generatedAt: payload.generatedAt });
    $("#caesar-agent-mode").textContent = payload.mode === "local" ? "LOCAL ANALYST" : "ANALYST";
    setCaesarStatus("BRIEF READY", "ready");
  } catch (error) {
    loadingMessage.remove();
    const timedOut = error?.name === "AbortError";
    appendIntelMessage({ role: "assistant", text: caesarErrorMessage(responseStatus, timedOut), error: true });
    setCaesarStatus("CHANNEL INTERRUPTED", "error");
  } finally {
    clearTimeout(timeout);
    setCaesarBusy(false);
    $("#caesar-question").focus();
  }
}

function render() {
  $("#app-version").textContent = `v${state.version || "—"}`;
  const exportDaily = $("#export-daily");
  if (exportDaily) exportDaily.hidden = !vaultExportsEnabled();
  renderFeedObservability();
  renderStats();
  renderLeaderboard();
  renderIdentityRegistry();
  renderActionIntelligence();
  renderRiskIntelligence();
  renderEarlyActors();
  renderOutcomes();
  renderTokens();
  renderCallouts();
  renderNarratives();
  renderAlerts();
}

function vaultExportsEnabled() {
  return state.mode === "demo" && state.publicDelivery?.vaultExports === "local-demo-only";
}

async function refresh({ signal } = {}) {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Snapshot returned ${response.status}`);
    const snapshot = await response.json();
    state = {
      ...state,
      ...snapshot,
      tokens: Array.isArray(snapshot.tokens) ? snapshot.tokens : [],
      alerts: Array.isArray(snapshot.alerts) ? snapshot.alerts : [],
      callouts: Array.isArray(snapshot.callouts) ? snapshot.callouts : [],
      narratives: Array.isArray(snapshot.narratives) ? snapshot.narratives : [],
      stats: snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : {},
      leaderboard: snapshot.leaderboard && typeof snapshot.leaderboard === "object" ? snapshot.leaderboard : { top100: [] },
      outcomes: snapshot.outcomes && typeof snapshot.outcomes === "object" ? snapshot.outcomes : {},
      riskIntelligence: snapshot.riskIntelligence && typeof snapshot.riskIntelligence === "object" ? snapshot.riskIntelligence : {},
      actionIntelligence: snapshot.actionIntelligence && typeof snapshot.actionIntelligence === "object" ? snapshot.actionIntelligence : {},
      earlyActorIntelligence: snapshot.earlyActorIntelligence && typeof snapshot.earlyActorIntelligence === "object" ? snapshot.earlyActorIntelligence : {},
      identityRegistry: snapshot.identityRegistry && typeof snapshot.identityRegistry === "object" ? snapshot.identityRegistry : {}
    };
    snapshotFailed = false;
    render();
    const deepLinkMint = new URLSearchParams(location.search).get("coin");
    if (!deepLinkOpened && PUBLIC_MINT.test(deepLinkMint || "")) {
      deepLinkOpened = true;
      void openCoin(deepLinkMint);
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    snapshotFailed = true;
    renderFeedObservability();
    console.warn("Snapshot refresh failed", error);
  }
}

async function renderCoinTimeline(mint) {
  const target = $("#coin-timeline");
  if (!target) return;
  try {
    const response = await fetch(`/api/coins/${encodeURIComponent(mint)}/timeline`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Timeline returned ${response.status}`);
    const timeline = await response.json();
    const entries = Array.isArray(timeline.entries) ? timeline.entries : [];
    target.innerHTML = entries.length ? entries.map((entry) => `<div class="timeline-entry"><time>${esc(entry.at)}</time><span class="confidence ${esc(entry.evidenceClass || "unavailable")}">${esc(entry.evidenceClass || "unavailable")}</span><div><b>${esc(entry.title || "Observation")}</b><p>${esc(entry.detail || "Evidence detail unavailable.")}</p></div></div>`).join("") : '<div class="action-empty">No discrete retained events are available for this coin.</div>';
  } catch {
    target.innerHTML = '<div class="action-empty error">Timeline is temporarily unavailable.</div>';
  }
}

async function openCoin(mint) {
  if (!PUBLIC_MINT.test(mint)) return;
  const fallback = rankedTokens().find((candidate) => candidate.mint === mint) || null;
  try {
    const response = await fetch(`/api/coins/${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Coin dossier returned ${response.status}`);
    const dossier = await response.json();
    openToken(mint, dossier);
  } catch {
    if (fallback) openToken(mint);
    else toast("Retained coin dossier is unavailable");
  }
}

function renderIdentityRegistry() {
  const target = $("#identity-registry-summary");
  if (!target) return;
  const registry = state.identityRegistry || {};
  const proposals = registry.proposalStatusCounts || {};
  const cards = [
    ["REVIEWED ENTITIES", number(registry.entityCount), "stable project or meme identities"],
    ["REGISTERED MINTS", number(registry.variantCount), "exact official / migration / relaunch variants"],
    ["REVIEWED EDGES", number(registry.relationshipCount), "typed cross-mint relationships"],
    ["PENDING PROPOSALS", number(proposals.pending), "locally derived; never facts without review"],
    ["DECISIONS", number(registry.decisionCount), "append-only review history"]
  ];
  target.innerHTML = cards.map(([label, value, note]) => `<article><span>${label}</span><strong>${nf.format(value)}</strong><small>${note}</small></article>`).join("");
  $("#identity-registry-status").textContent = registry.automatedVerification === false ? "REVIEW-GATED" : "REGISTRY DEGRADED";
}

function identityDetail(identity) {
  if (!identity || typeof identity !== "object") return `<section class="identity-detail"><span class="kicker">CANONICAL IDENTITY</span><p>Identity resolution is unavailable for this fallback view.</p></section>`;
  const entity = identity.entity || {};
  const primary = identity.primary || {};
  const relationships = Array.isArray(identity.relationships) ? identity.relationships : [];
  const proposals = Array.isArray(identity.proposals) ? identity.proposals : [];
  const edge = (item, proposed = false) => {
    const other = item.fromMint === identity.mint ? item.toMint : item.fromMint;
    return `<div class="identity-edge ${proposed ? "proposed" : "reviewed"}"><span><b>${esc(item.kind || "unresolved")}</b><small>${proposed ? "PROPOSED · NOT A FACT" : esc(item.reviewState || "reviewed").toUpperCase()}</small></span><code>${esc(shortMint(other))}</code><em>${esc(item.evidenceClass || "unavailable")}</em></div>`;
  };
  return `<section class="identity-detail"><div class="identity-detail-head"><div><span class="kicker">CANONICAL IDENTITY // ${esc(identity.resolvedBy || "unresolved")}</span><h3>${esc(entity.displayName || "Unresolved exact mint")}</h3></div><span class="identity-review-state">${esc(entity.reviewState || "proposed").toUpperCase()}</span></div><div class="identity-detail-grid"><div><b>ENTITY</b><strong>${esc(entity.entityId || `mint:${identity.mint}`)}</strong></div><div><b>PRIMARY MINT</b><strong>${primary.mint ? esc(shortMint(primary.mint)) : "WITHHELD"}</strong><small>${esc(primary.selectionReason || "unavailable")}</small></div><div><b>REVIEWED EDGES</b><strong>${relationships.length}</strong></div><div><b>OPEN PROPOSALS</b><strong>${proposals.length}</strong></div></div><div class="identity-edges">${relationships.map((item) => edge(item)).join("")}${proposals.map((item) => edge(item, true)).join("") || '<div class="action-empty">No reviewed or proposed cross-mint edges for this exact mint.</div>'}</div><p>${esc(primary.meaning || "Identity resolution only; not a trade recommendation.")}</p></section>`;
}

function openToken(mint, dossier = null) {
  const token = dossier?.token || rankedTokens().find((candidate) => candidate.mint === mint);
  if (!token) return;
  const leaderboardEntry = dossier ? { token, outcome: dossier.outcome, ...dossier.radar }
    : Array.isArray(state.leaderboard?.top100) ? state.leaderboard.top100.find((entry) => entry.token?.mint === mint) : null;
  const confidence = riskConfidence(token);
  const momentum = [];
  if (hasNumber(token.volume5m) && number(token.volume5m) > 7000) momentum.push("5m volume acceleration");
  if (hasNumber(token.uniqueBuyers) && number(token.uniqueBuyers) >= 18) momentum.push("broad buyer participation");
  if (hasNumber(token.buyRatio) && number(token.buyRatio) >= .64) momentum.push("buy-side pressure");
  if (hasNumber(token.bondingProgress) && number(token.bondingProgress) >= 75) momentum.push("approaching migration");
  $("#token-detail").innerHTML = `<div class="detail"><span class="kicker">${esc(token.narrative || "Unclassified")} // ${esc(token.status || "observed")}</span><h2>${esc(token.name || "Unnamed mint")} <span class="risk-low">${esc(token.symbol || "??")}</span></h2><div class="mint">${esc(token.mint)}</div>
    <div class="detail-grid"><div class="detail-card"><label>MOMENTUM</label><strong>${hasNumber(token.momentum) ? `${number(token.momentum)}/100` : "—"}</strong></div><div class="detail-card"><label>RISK COMPOSITE</label><strong class="risk-unverified">WITHHELD</strong><small>${esc(confidence)}</small></div><div class="detail-card"><label>MARKET CAP</label><strong>${hasNumber(token.marketCap) ? money(token.marketCap) : "—"}</strong></div><div class="detail-card"><label>BUYERS</label><strong>${hasNumber(token.uniqueBuyers) ? nf.format(number(token.uniqueBuyers)) : "—"}</strong></div><div class="detail-card"><label>BUY RATIO</label><strong>${hasNumber(token.buyRatio) ? `${Math.round(number(token.buyRatio) * 100)}%` : "—"}</strong></div><div class="detail-card"><label>ACTIVITY EVIDENCE</label><strong>SEE BELOW</strong><small>never rank input</small></div></div>
    <div class="reasons"><div class="reason"><strong>Observed movement</strong><br>${esc((momentum.length ? momentum : ["early observation—limited history"]).join(" · "))}</div><div class="reason risk"><strong>Risk interpretation</strong><br>Withheld until factors have labeled outcomes and holdout calibration. Missing evidence is unknown, never safe.</div></div>${identityDetail(dossier?.identity)}${riskIdentityDetail(token)}${earlyActorDetail(dossier?.earlyActor || state.earlyActorIntelligence?.cohort?.observations?.find((observation) => observation.mint === token.mint)?.summary, state.earlyActorIntelligence?.cohort?.observations?.find((observation) => observation.mint === token.mint)?.acquisition)}${outcomeDetail(leaderboardEntry)}
    <div class="coin-timeline"><span class="kicker">DISCRETE RETAINED TIMELINE // NO INTERPOLATION</span><div id="coin-timeline"><div class="action-empty">Loading typed observations…</div></div></div>
    <div class="detail-actions"><button class="primary" id="watch-coin" aria-pressed="${watched(token.mint)}">${watched(token.mint) ? "★ WATCHED" : "☆ WATCH IN BROWSER"}</button>${vaultExportsEnabled() ? '<button id="export-coin">EXPORT TO OBSIDIAN</button>' : ""}<a href="https://pump.fun/coin/${encodeURIComponent(token.mint)}" target="_blank" rel="noreferrer">PUMP.FUN ↗</a><a href="https://dexscreener.com/solana/${encodeURIComponent(token.mint)}" target="_blank" rel="noreferrer">DEX SCREENER ↗</a><a href="${fomoUrl(token.mint)}" target="_blank" rel="noreferrer">FOMO ↗</a></div></div>`;
  $("#token-dialog").showModal();
  void renderCoinTimeline(token.mint);
  $("#watch-coin").onclick = () => {
    toggleWatch(token.mint);
    $("#watch-coin").textContent = watched(token.mint) ? "★ WATCHED" : "☆ WATCH IN BROWSER";
    $("#watch-coin").setAttribute("aria-pressed", String(watched(token.mint)));
  };
  const exportCoinButton = $("#export-coin");
  if (exportCoinButton) exportCoinButton.onclick = async () => {
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
  if (!vaultExportsEnabled()) { toast("Vault exports are disabled on the public live service"); return; }
  try {
    const response = await fetch("/api/export/daily", { method: "POST" });
    const result = await response.json();
    toast(result.ok ? "Daily brief exported to the vault" : "Export failed");
  } catch { toast("Export failed"); }
};

$("#caesar-form").addEventListener("submit", (event) => {
  event.preventDefault();
  askCaesar($("#caesar-question").value);
});
$("#caesar-question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#caesar-form").requestSubmit();
  }
});
$("#caesar-question").addEventListener("input", () => {
  if (!caesarRequestPending) setCaesarStatus("OBSERVATION-ONLY");
});
document.querySelectorAll(".quick-prompt").forEach((button) => button.addEventListener("click", () => {
  $("#caesar-question").value = String(button.dataset.question || "").slice(0, CAESAR_MAX_QUESTION);
  $("#caesar-form").requestSubmit();
}));
for (const id of ["leaderboard-search", "leaderboard-lens", "leaderboard-freshness", "leaderboard-risk", "leaderboard-watchlist"]) {
  $(`#${id}`).addEventListener(id === "leaderboard-search" ? "input" : "change", () => {
    syncFiltersToUrl();
    renderLeaderboard();
  });
}

$("#save-preset").addEventListener("click", () => {
  const name = $("#preset-name").value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 32);
  if (!name) { toast("Name the filter lens first"); $("#preset-name").focus(); return; }
  if (preferences.presets.length >= PRESET_LIMIT) { toast(`Saved lenses are capped at ${PRESET_LIMIT}`); return; }
  const id = `lens-${Date.now().toString(36)}`;
  preferences.presets = [...preferences.presets, { id, name, filters: filterState() }];
  savePreferences();
  $("#preset-name").value = "";
  renderPresets();
  $("#preset-select").value = id;
  $("#delete-preset").disabled = false;
  toast("Filter lens saved in this browser");
});

$("#preset-select").addEventListener("change", () => {
  const preset = preferences.presets.find((candidate) => candidate.id === $("#preset-select").value);
  $("#delete-preset").disabled = !preset;
  if (!preset) return;
  applyFilterState(preset.filters);
  syncFiltersToUrl();
  renderLeaderboard();
});

$("#delete-preset").addEventListener("click", () => {
  const id = $("#preset-select").value;
  if (!id) return;
  preferences.presets = preferences.presets.filter((preset) => preset.id !== id);
  savePreferences();
  renderPresets();
  toast("Saved lens deleted");
});

$("#clear-compare").addEventListener("click", () => {
  compareMints.clear();
  compareCacheKey = "";
  compareCache = null;
  renderWatchlist();
  void renderComparison();
});

$("#export-preferences").addEventListener("click", () => {
  const blob = new Blob([`${JSON.stringify(preferences, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pump-war-room-preferences-v1.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

$("#import-preferences").addEventListener("click", () => $("#preference-file").click());
$("#preference-file").addEventListener("change", async () => {
  const file = $("#preference-file").files?.[0];
  $("#preference-file").value = "";
  if (!file || file.size > 50_000) { if (file) toast("Preference JSON is too large"); return; }
  try {
    preferences = normalizePreferences(JSON.parse(await file.text()), { strict: true });
    compareMints.clear();
    savePreferences();
    renderLeaderboard();
    renderActionIntelligence();
    toast("Browser preferences imported");
  } catch { toast("Preference JSON is invalid"); }
});

addEventListener("popstate", () => { applyFilterState(filtersFromUrl()); renderLeaderboard(); });

function tickClock() {
  $("#clock").textContent = `${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET`;
  updateMintAge();
}

tickClock();
setInterval(tickClock, 1000);
applyFilterState(filtersFromUrl());

const snapshotRefreshScheduler = createSnapshotRefreshScheduler({ refresh });
const snapshotLiveUpdates = createSnapshotLiveUpdates({
  scheduler: snapshotRefreshScheduler,
  onState: (streamState) => {
    dashboardStreamState = streamState;
    renderFeedObservability();
  }
});

addEventListener("pagehide", () => snapshotLiveUpdates.stop());
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  snapshotLiveUpdates.start();
  snapshotRefreshScheduler.request({ immediate: true });
});

snapshotLiveUpdates.start();
snapshotRefreshScheduler.request({ immediate: true });
