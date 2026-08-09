const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUTCOME_WINDOWS = Object.freeze(["5m", "15m", "1h", "6h", "24h"]);
const PERIODS = Object.freeze({ daily: 86_400_000, weekly: 7 * 86_400_000 });
const MAX_TIMELINE_ROWS = 200;
const DEFAULT_TIMELINE_ROWS = 50;
const TELEGRAM_CHAT_DESTINATION = /^(?:-?\d{1,24}|@[A-Za-z0-9_]{1,32})$/;

export const CLOSED_BRIEF_METHOD_VERSION = "measured-closed-brief-v2";

const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function mint(value, label = "mint") {
  if (typeof value !== "string" || !MINT_PATTERN.test(value)) throw new TypeError(`${label} must be a Solana base58 mint`);
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function text(value, fallback, max = 160) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : fallback;
}

function evidenceTime(...values) {
  for (const value of values) {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function alert({ kind, level, title, message, token, evidenceAt, fingerprint, evidenceClass = null }) {
  const observedAt = evidenceTime(evidenceAt) || new Date().toISOString();
  return {
    kind,
    level,
    title,
    message,
    mint: token.mint,
    evidenceAt: observedAt,
    dedupeKey: `${kind}:${token.mint}:${fingerprint || observedAt}`,
    evidenceClass: evidenceClass || (kind === "migration-observed" ? "feed-observed-processed"
      : kind.startsWith("risk-") ? "provider-observed"
        : "locally-derived")
  };
}

function explicitProviderFactor(token, name) {
  const factor = token?.riskIdentity?.factors?.[name];
  return factor?.evidenceClass === "provider-observed" ? factor : null;
}

function explicitLocalFactor(token, name) {
  const factor = token?.riskIdentity?.factors?.[name];
  return factor?.evidenceClass === "locally-derived" ? factor : null;
}

/**
 * Classify bounded, auditable changes. Unknown values never become alerts and
 * no provider risk factor is promoted into a probability or safety claim.
 */
export function detectMaterialAlerts({ current, previous = null, currentScore = null, previousScore = null, observedAt = new Date().toISOString() } = {}) {
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new TypeError("current must be a token object");
  mint(current.mint, "current.mint");
  if (previous !== null && (!previous || typeof previous !== "object" || previous.mint !== current.mint)) {
    throw new TypeError("previous must be null or the same mint");
  }
  const at = timestamp(observedAt, "observedAt");
  const symbol = text(current.symbol, current.mint.slice(0, 8), 24);
  const alerts = [];

  const migration = current.migrationEvidence;
  const previousMigration = previous?.migrationEvidence;
  if (migration?.evidenceClass === "feed-observed-processed"
    && previousMigration?.evidenceClass !== "feed-observed-processed") {
    const sourceAt = evidenceTime(migration.observedAt, at);
    alerts.push(alert({
      kind: "migration-observed", level: "hot", title: "Migration feed observation",
      message: `${symbol} appeared in the processed migration feed; finalization is not independently verified.`,
      token: current, evidenceAt: sourceAt, fingerprint: sourceAt
    }));
  }

  const score = finite(currentScore);
  const priorScore = finite(previousScore);
  if (previous && score !== null && priorScore !== null) {
    const delta = Math.round((score - priorScore) * 10) / 10;
    if (Math.abs(delta) >= 15) {
      alerts.push(alert({
        kind: delta > 0 ? "score-rise" : "score-drop",
        level: "signal",
        title: delta > 0 ? "Evidence score increased" : "Evidence score decreased",
        message: `${symbol}'s observational radar score changed from ${priorScore} to ${score} (${delta > 0 ? "+" : ""}${delta}); it is not a price forecast.`,
        token: current, evidenceAt: at, fingerprint: `material-score-v2:${priorScore}->${score}:${at}`
      }));
    }
  }

  const concentration = explicitProviderFactor(current, "concentration");
  const priorConcentration = explicitProviderFactor(previous, "concentration");
  const top10 = finite(concentration?.top10Percentage);
  const priorTop10 = finite(priorConcentration?.top10Percentage);
  const concentrationDelta = top10 !== null && priorTop10 !== null ? Math.round((top10 - priorTop10) * 100) / 100 : null;
  if (top10 !== null && ((priorTop10 === null && top10 >= 50)
    || (priorTop10 !== null && priorTop10 < 50 && top10 >= 50)
    || (concentrationDelta !== null && Math.abs(concentrationDelta) >= 10))) {
    const sourceAt = evidenceTime(concentration.providerUpdatedAt, concentration.fetchedAt, at);
    alerts.push(alert({
      kind: "risk-concentration", level: "risk", title: "Concentration evidence changed",
      message: `${symbol} has a provider-reported top-10 holder share of ${top10}%${concentrationDelta === null ? "" : ` (${concentrationDelta > 0 ? "+" : ""}${concentrationDelta} percentage points)`}; custody exclusions are unpublished and the factor is uncalibrated.`,
      token: current, evidenceAt: sourceAt,
      fingerprint: `material-concentration-v1:${priorTop10 ?? "unavailable"}->${top10}:${sourceAt}`
    }));
  }

  const developer = explicitProviderFactor(current, "developer");
  const priorDeveloper = explicitProviderFactor(previous, "developer");
  const holding = finite(developer?.holdingPercentage);
  const priorHolding = finite(priorDeveloper?.holdingPercentage);
  const holdingDelta = holding !== null && priorHolding !== null ? Math.round((holding - priorHolding) * 100) / 100 : null;
  if (holding !== null && ((priorHolding === null && holding >= 12)
    || (priorHolding !== null && priorHolding < 12 && holding >= 12)
    || (holdingDelta !== null && Math.abs(holdingDelta) >= 5))) {
    const sourceAt = evidenceTime(developer.fetchedAt, at);
    alerts.push(alert({
      kind: "risk-developer-holding", level: "risk", title: "Developer-holding evidence changed",
      message: `${symbol} has a provider-reported developer holding of ${holding}%${holdingDelta === null ? "" : ` (${holdingDelta > 0 ? "+" : ""}${holdingDelta} percentage points)`}; provider identity is not independently verified and the factor is uncalibrated.`,
      token: current, evidenceAt: sourceAt,
      fingerprint: `material-developer-v1:${priorHolding ?? "unavailable"}->${holding}:${sourceAt}`
    }));
  }

  const identity = explicitLocalFactor(current, "identity");
  const priorIdentity = explicitLocalFactor(previous, "identity");
  const reuseCount = integer(identity?.exactDuplicateCount);
  const priorReuseCount = integer(priorIdentity?.exactDuplicateCount);
  if (reuseCount !== null && reuseCount > 0 && (priorReuseCount === null || priorReuseCount === 0)) {
    const sourceAt = evidenceTime(identity.calculatedAt, at);
    alerts.push(alert({
      kind: "risk-identity-reuse", level: "risk", title: "Exact declared-identifier reuse observed",
      message: `${symbol} shares at least one exact declared X, Telegram, or registrable-domain identifier with ${reuseCount} other observed mint${reuseCount === 1 ? "" : "s"}; this does not establish common control, fraud, or safety.`,
      token: current, evidenceAt: sourceAt,
      fingerprint: `material-identity-reuse-v1:${priorReuseCount ?? "unavailable"}->${reuseCount}:${sourceAt}`,
      evidenceClass: "locally-derived"
    }));
  }

  const creator = explicitLocalFactor(current, "creatorHistory");
  const priorCreator = explicitLocalFactor(previous, "creatorHistory");
  const launchCount = integer(creator?.observedLaunchCount);
  const priorLaunchCount = integer(priorCreator?.observedLaunchCount);
  if (launchCount !== null && launchCount >= 2 && (priorLaunchCount === null || priorLaunchCount < 2)) {
    const sourceAt = evidenceTime(creator.calculatedAt, at);
    alerts.push(alert({
      kind: "risk-creator-history", level: "risk", title: "Prospective creator history changed",
      message: `${symbol}'s exact observed creator/deployer identifier is now associated with ${launchCount} launches in this deployment's fixed prospective cohort; this is not all-time creator history.`,
      token: current, evidenceAt: sourceAt,
      fingerprint: `material-creator-history-v1:${priorLaunchCount ?? "unavailable"}->${launchCount}:${sourceAt}`,
      evidenceClass: "locally-derived"
    }));
  }

  return alerts;
}

function timelineTokenEvent(row, expectedMint) {
  if (!row || typeof row !== "object" || row.mint !== expectedMint) return null;
  if (row.kind === "risk-evidence") {
    const at = evidenceTime(row.occurredAt, row.createdAt);
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
    if (!at || payload.mint !== expectedMint || !["concentration", "developer-holding", "pool-reserve", "identity-reuse", "creator-history"].includes(payload.factor)) return null;
    const labels = {
      concentration: "Holder distribution observed",
      "developer-holding": "Developer holding observed",
      "pool-reserve": "Pool reserve observed",
      "identity-reuse": "Exact declared-identifier reuse measured",
      "creator-history": "Prospective creator history measured"
    };
    return {
      kind: "risk-evidence", at,
      evidenceClass: ["provider-observed", "locally-derived"].includes(row.evidenceClass) ? row.evidenceClass : "unavailable",
      title: labels[payload.factor],
      detail: `${finite(payload.value) ?? "unavailable"}${text(payload.unit, "", 24)}; ${text(payload.limitation, "Evidence limitations unavailable.", 240)}`
    };
  }
  if (!["mint", "update"].includes(row.kind)) return null;
  const at = evidenceTime(row.occurredAt, row.createdAt);
  if (!at) return null;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
  if (payload.mint !== expectedMint) return null;
  const status = text(payload.status, "observed", 40);
  return {
    kind: row.kind === "mint" ? "launch-observed" : "feed-update",
    at,
    evidenceClass: payload.source === "pumpportal" ? "feed-observed-processed" : payload.source === "demo" ? "synthetic" : "unavailable",
    title: row.kind === "mint" ? "Launch observed" : "Feed observation updated",
    detail: `Status ${status}; momentum ${finite(payload.momentum) ?? "unavailable"}; 5m volume ${finite(payload.volume5m) ?? "unavailable"}.`
  };
}

function timelineAlert(row, expectedMint) {
  if (!row || typeof row !== "object" || row.mint !== expectedMint) return null;
  const at = evidenceTime(row.evidenceAt, row.createdAt);
  if (!at) return null;
  return {
    kind: "material-alert", at,
    evidenceClass: ["provider-observed", "feed-observed-processed", "locally-derived"].includes(row.evidenceClass) ? row.evidenceClass : "unavailable",
    title: text(row.title, "Material observation", 80),
    detail: text(row.message, "Alert detail unavailable.", 240)
  };
}

function timelineCallout(row, expectedMint) {
  if (!row || typeof row !== "object" || row.mint !== expectedMint || row.source !== "bark") return null;
  const at = evidenceTime(row.createdAt);
  if (!at) return null;
  const caller = text(row.sourceActor, "anonymous source actor", 80);
  return {
    kind: "third-party-callout", at, evidenceClass: "third-party",
    title: "Third-party callout observed",
    detail: `${caller}; callout multiple ${finite(row.multiple) ?? "unavailable"}. This is social evidence, not promotion or verification.`
  };
}

function outcomeEvents(outcome, expectedMint) {
  if (!outcome || outcome.mint !== expectedMint || !outcome.windows || typeof outcome.windows !== "object") return [];
  return OUTCOME_WINDOWS.flatMap((windowName) => {
    const window = outcome.windows[windowName];
    if (window?.status !== "observed" || finite(window.returnPct) === null || window.source !== "geckoterminal") return [];
    const at = evidenceTime(window.calculatedAt);
    if (!at) return [];
    return [{
      kind: "outcome-observed", at, evidenceClass: "provider-observed",
      title: `${windowName} return measured`,
      detail: `${window.returnPct >= 0 ? "+" : ""}${window.returnPct}% from completed provider candles; maximum observed-close drawdown ${finite(window.maximumDrawdownPct) ?? "unavailable"}%.`
    }];
  });
}

function riskEvents(token, expectedMint) {
  if (!token || token.mint !== expectedMint) return [];
  const factors = token.riskIdentity?.factors || {};
  const rows = [];
  const concentration = factors.concentration;
  if (concentration?.evidenceClass === "provider-observed" && finite(concentration.top10Percentage) !== null) {
    const at = evidenceTime(concentration.providerUpdatedAt, concentration.fetchedAt);
    if (at) rows.push({ kind: "risk-evidence", at, evidenceClass: "provider-observed", title: "Holder distribution observed", detail: `Provider-reported top-10 share ${concentration.top10Percentage}%; custody exclusions are unpublished.` });
  }
  const developer = factors.developer;
  if (developer?.evidenceClass === "provider-observed" && finite(developer.holdingPercentage) !== null) {
    const at = evidenceTime(developer.fetchedAt);
    if (at) rows.push({ kind: "risk-evidence", at, evidenceClass: "provider-observed", title: "Developer holding observed", detail: `Provider-reported holding ${developer.holdingPercentage}%; developer identity is not independently verified.` });
  }
  const liquidity = factors.liquidity;
  if (liquidity?.evidenceClass === "provider-observed" && finite(liquidity.liquidityUsd) !== null) {
    const at = evidenceTime(liquidity.observedAt);
    if (at) rows.push({ kind: "risk-evidence", at, evidenceClass: "provider-observed", title: "Pool reserve observed", detail: `Provider-observed pool reserve $${Math.round(liquidity.liquidityUsd).toLocaleString("en-US")}; this is not locked-liquidity evidence.` });
  }
  const identity = factors.identity;
  if (identity?.evidenceClass === "locally-derived" && integer(identity.exactDuplicateCount) !== null) {
    const at = evidenceTime(identity.calculatedAt);
    if (at) rows.push({ kind: "risk-evidence", at, evidenceClass: "locally-derived", title: "Exact declared-identifier reuse measured", detail: `${identity.exactDuplicateCount} other observed mint(s) share at least one exact declared identifier; this does not establish common control.` });
  }
  const creator = factors.creatorHistory;
  if (creator?.evidenceClass === "locally-derived" && integer(creator.observedLaunchCount) !== null) {
    const at = evidenceTime(creator.calculatedAt);
    if (at) rows.push({ kind: "risk-evidence", at, evidenceClass: "locally-derived", title: "Prospective creator history measured", detail: `${creator.observedLaunchCount} launches share the exact observed creator/deployer identifier in the fixed cohort; this is not all-time history.` });
  }
  return rows;
}

function encodeTimelineCursor(row) {
  return Buffer.from(JSON.stringify([row.at, row.kind, row.title, row.detail]), "utf8").toString("base64url");
}

function decodeTimelineCursor(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("before must be a valid timeline cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded.some((item) => typeof item !== "string")) throw new Error("invalid cursor");
    return decoded;
  } catch {
    throw new TypeError("before must be a valid timeline cursor");
  }
}

export function buildCoinTimeline({
  mint: requestedMint, token = null, events = [], alerts = [], callouts = [], outcome = null,
  generatedAt = new Date().toISOString(), limit = DEFAULT_TIMELINE_ROWS, before = null
} = {}) {
  const normalizedMint = mint(requestedMint);
  const at = timestamp(generatedAt, "generatedAt");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_ROWS) throw new RangeError(`limit must be between 1 and ${MAX_TIMELINE_ROWS}`);
  const rows = [
    ...(Array.isArray(events) ? events : []).map((row) => timelineTokenEvent(row, normalizedMint)),
    ...(Array.isArray(alerts) ? alerts : []).map((row) => timelineAlert(row, normalizedMint)),
    ...(Array.isArray(callouts) ? callouts : []).map((row) => timelineCallout(row, normalizedMint)),
    ...outcomeEvents(outcome, normalizedMint),
    ...riskEvents(token, normalizedMint)
  ].filter(Boolean);
  const allRows = [...new Map(rows.map((row) => [`${row.kind}:${row.at}:${row.title}:${row.detail}`, row])).values()]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)
      || left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title) || left.detail.localeCompare(right.detail));
  let offset = 0;
  if (before !== null) {
    const cursor = decodeTimelineCursor(before);
    const cursorIndex = allRows.findIndex((row) => [row.at, row.kind, row.title, row.detail].every((value, index) => value === cursor[index]));
    if (cursorIndex < 0) throw new TypeError("before timeline cursor is invalid or no longer retained");
    offset = cursorIndex + 1;
  }
  const entries = allRows.slice(offset, offset + limit);
  const hasMore = offset + entries.length < allRows.length;
  return {
    schemaVersion: 1,
    mint: normalizedMint,
    generatedAt: at,
    limit,
    entries,
    nextBefore: hasMore && entries.length ? encodeTimelineCursor(entries.at(-1)) : null,
    historyAvailableSince: allRows.length ? allRows.at(-1).at : evidenceTime(token?.createdAt),
    scope: "bounded persisted observations available to this deployment; not a complete on-chain history",
    rawProviderPayloadsIncluded: false
  };
}

function publicFactor(token, name, field) {
  const factor = token?.riskIdentity?.factors?.[name];
  const value = factor ? finite(factor[field]) : null;
  return {
    value,
    evidenceClass: value === null ? "unavailable" : factor.evidenceClass,
    observedAt: value === null ? null : evidenceTime(factor.providerUpdatedAt, factor.fetchedAt, factor.observedAt, factor.calculatedAt)
  };
}

export function buildCoinComparison({ mints, snapshot } = {}) {
  if (!Array.isArray(mints) || mints.length < 2 || mints.length > 4) throw new RangeError("mints must contain 2 to 4 values");
  const normalizedMints = mints.map((value, index) => mint(value, `mints[${index}]`));
  if (new Set(normalizedMints).size !== normalizedMints.length) throw new TypeError("mints must be unique");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("snapshot must be an object");
  const tokenByMint = new Map((Array.isArray(snapshot.tokens) ? snapshot.tokens : []).filter((token) => token?.mint).map((token) => [token.mint, token]));
  const entryByMint = new Map((Array.isArray(snapshot.leaderboard?.top100) ? snapshot.leaderboard.top100 : []).filter((entry) => entry?.token?.mint).map((entry) => [entry.token.mint, entry]));
  const coins = normalizedMints.flatMap((candidateMint) => {
    const entry = entryByMint.get(candidateMint);
    const token = tokenByMint.get(candidateMint) || entry?.token;
    if (!token) return [];
    const outcome = entry?.outcome;
    return [{
      mint: candidateMint,
      name: text(token.name, "Unknown", 80),
      symbol: text(token.symbol, "???", 24),
      createdAt: evidenceTime(token.createdAt),
      status: text(token.status, "unknown", 40),
      lifecycleEvidenceClass: token.riskIdentity?.factors?.lifecycle?.evidenceClass || "unavailable",
      radarScore: finite(entry?.score),
      scoreBasis: entry?.orderingBasis || "unavailable",
      momentum: finite(token.momentum),
      freshness: entry?.freshness?.state || "unavailable",
      riskEvidence: token.riskIdentity?.overallEvidence || "unavailable",
      factors: {
        top10Percentage: publicFactor(token, "concentration", "top10Percentage"),
        developerHoldingPercentage: publicFactor(token, "developer", "holdingPercentage"),
        liquidityUsd: publicFactor(token, "liquidity", "liquidityUsd")
      },
      outcomes: Object.fromEntries(OUTCOME_WINDOWS.map((windowName) => {
        const window = outcome?.windows?.[windowName];
        return [windowName, window?.status === "observed" && finite(window.returnPct) !== null
          ? { status: "observed", returnPct: window.returnPct, calculatedAt: evidenceTime(window.calculatedAt), source: window.source }
          : { status: "unavailable", returnPct: null, calculatedAt: null, source: null, reason: text(window?.reason, "not-in-current-comparison-snapshot", 80) }];
      }))
    }];
  });
  return {
    schemaVersion: 1,
    generatedAt: evidenceTime(snapshot.generatedAt) || new Date().toISOString(),
    requestedMints: normalizedMints,
    missingMints: normalizedMints.filter((candidate) => !coins.some((coin) => coin.mint === candidate)),
    coins,
    rankingBoundary: "uncalibrated risk factors do not affect radar rank",
    disclaimer: "Observational comparison only; missing evidence stays unavailable and values are not a recommendation or price forecast."
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildMeasuredBrief({
  period,
  now = new Date().toISOString(),
  windowStart = null,
  windowEnd = null,
  activity = {},
  priorActivity = {},
  outcomes = [],
  minimumEvidence = 3,
  minimumCoverageRatio = 0.5
} = {}) {
  if (!Object.hasOwn(PERIODS, period)) throw new TypeError("period must be daily or weekly");
  const cutoff = timestamp(now, "now");
  if (!Number.isSafeInteger(minimumEvidence) || minimumEvidence < 1 || minimumEvidence > 1_000) throw new RangeError("minimumEvidence must be between 1 and 1000");
  if (typeof minimumCoverageRatio !== "number" || !Number.isFinite(minimumCoverageRatio) || minimumCoverageRatio < 0 || minimumCoverageRatio > 1) throw new RangeError("minimumCoverageRatio must be between 0 and 1");
  if ((windowStart === null) !== (windowEnd === null)) throw new TypeError("windowStart and windowEnd must be supplied together");
  const closed = windowStart !== null;
  const end = closed ? timestamp(windowEnd, "windowEnd") : cutoff;
  const start = closed ? timestamp(windowStart, "windowStart") : new Date(Date.parse(end) - PERIODS[period]).toISOString();
  if (Date.parse(end) - Date.parse(start) !== PERIODS[period]) throw new RangeError(`${period} brief window has an invalid duration`);
  if (end > cutoff) throw new RangeError("brief windowEnd must not be after the data cutoff");
  const methodVersion = closed ? CLOSED_BRIEF_METHOD_VERSION : "measured-rolling-brief-v1";
  const countRecord = (value, label) => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || integer(count) === null) throw new TypeError(`${label} must contain stable keys and non-negative integer counts`);
      return [key, count];
    }));
  };
  const normalizeActivity = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    for (const key of ["launchesObserved", "migrationObservations", "materialAlerts", "thirdPartyCallouts"]) {
      if (value[key] !== undefined && integer(value[key]) === null) throw new TypeError(`${label}.${key} must be a non-negative integer`);
    }
    const cohortAdmissions = value.cohortAdmissions === undefined ? { outcome: 0, risk: 0 } : value.cohortAdmissions;
    if (!cohortAdmissions || typeof cohortAdmissions !== "object" || [cohortAdmissions.outcome, cohortAdmissions.risk].some((count) => integer(count) === null)) {
      throw new TypeError(`${label}.cohortAdmissions must contain non-negative outcome and risk counts`);
    }
    return {
      launchesObserved: integer(value.launchesObserved) ?? 0,
      migrationObservations: integer(value.migrationObservations) ?? 0,
      materialAlerts: integer(value.materialAlerts) ?? 0,
      materialByKind: countRecord(value.materialByKind, `${label}.materialByKind`),
      factorEventsByEvidenceClass: countRecord(value.factorEventsByEvidenceClass, `${label}.factorEventsByEvidenceClass`),
      telegramDelivery: countRecord(value.telegramDelivery, `${label}.telegramDelivery`),
      deduplicatedSuppressed: value.deduplicatedSuppressed === null ? null : integer(value.deduplicatedSuppressed),
      thirdPartyCallouts: integer(value.thirdPartyCallouts) ?? 0,
      cohortAdmissions: { outcome: cohortAdmissions.outcome, risk: cohortAdmissions.risk },
      cohortDrops: { outcome: null, risk: null, reason: "Historical cohort removals are unavailable; null does not mean zero." }
    };
  };
  const validatedActivity = normalizeActivity(activity, "activity");
  const validatedPriorActivity = normalizeActivity(priorActivity, "priorActivity");
  if (!Array.isArray(outcomes)) throw new TypeError("outcomes must be an array");
  const validOutcomes = outcomes.filter((outcome) => outcome && typeof outcome === "object" && outcome.windows && typeof outcome.windows === "object");
  const summarizeWindows = (rangeStart, rangeEnd) => Object.fromEntries(OUTCOME_WINDOWS.map((windowName) => {
    const eligible = validOutcomes.map((outcome) => outcome.windows[windowName]).filter((window) => {
      const expected = Date.parse(window?.expectedAt);
      return Number.isFinite(expected) && expected >= Date.parse(rangeStart) && expected < Date.parse(rangeEnd);
    });
    const observed = eligible.filter((window) => window.status === "observed" && finite(window.returnPct) !== null && finite(window.maximumDrawdownPct) !== null && window.source === "geckoterminal");
    const coverageRatio = eligible.length ? observed.length / eligible.length : null;
    const sufficient = coverageRatio !== null && observed.length >= minimumEvidence && coverageRatio >= minimumCoverageRatio;
    const missingReasons = Object.fromEntries([...eligible.filter((window) => window.status !== "observed")
      .reduce((counts, window) => counts.set(text(window.reason, "unavailable", 80), (counts.get(text(window.reason, "unavailable", 80)) || 0) + 1), new Map())]
      .sort(([left], [right]) => left.localeCompare(right)));
    return [windowName, {
      status: sufficient ? "sufficient-evidence" : "insufficient-evidence",
      eligibleCount: eligible.length,
      evidenceCount: observed.length,
      missingCount: eligible.length - observed.length,
      coverageRatio: coverageRatio === null ? null : round(coverageRatio),
      minimumEvidence,
      minimumCoverageRatio,
      missingReasons,
      hitDefinition: "returnPct > 0",
      hitCount: sufficient ? observed.filter((window) => window.returnPct > 0).length : null,
      hitRatePct: sufficient ? round(observed.filter((window) => window.returnPct > 0).length / observed.length * 100) : null,
      medianReturnPct: sufficient ? round(median(observed.map((window) => window.returnPct))) : null,
      maximumDrawdownPct: sufficient ? round(Math.max(...observed.map((window) => window.maximumDrawdownPct))) : null,
      drawdownBasis: "maximum observed completed-candle-close drawdown; sparse samples may understate intraperiod drawdown"
    }];
  }));
  const windows = summarizeWindows(start, end);
  const priorEnd = start;
  const priorStart = new Date(Date.parse(start) - PERIODS[period]).toISOString();
  const priorWindows = summarizeWindows(priorStart, priorEnd);
  return {
    schemaVersion: 1,
    methodVersion,
    briefId: `${methodVersion}:${period}:${start}:${end}:UTC`,
    period,
    generatedAt: cutoff,
    windowStart: start,
    windowEnd: end,
    timezone: "UTC",
    feedCoverage: "unmeasured",
    source: "pumpportal observations plus GeckoTerminal completed-candle outcomes",
    universe: `${closed ? "closed-period" : "rolling-window"} activity observed by this deployment; outcome denominators are fixed-cohort horizons due in [start,end)`,
    activity: validatedActivity,
    outcomes: { minimumEvidence, minimumCoverageRatio, windows },
    priorPeriod: {
      windowStart: priorStart,
      windowEnd: priorEnd,
      activity: validatedPriorActivity,
      outcomes: { minimumEvidence, minimumCoverageRatio, windows: priorWindows },
      comparisonRule: "Compare counts only with both denominators visible; unavailable and zero are distinct."
    },
    rawProviderPayloadsIncluded: false,
    disclaimer: "Measured observational research only; missing data is not performance and results are not financial advice."
  };
}

export function telegramAlertStatus(env = process.env) {
  const tokenConfigured = typeof env.TELEGRAM_BOT_TOKEN === "string"
    && env.TELEGRAM_BOT_TOKEN.length >= 20 && !/\s/.test(env.TELEGRAM_BOT_TOKEN);
  const chatConfigured = typeof env.TELEGRAM_CHAT_ID === "string"
    && TELEGRAM_CHAT_DESTINATION.test(env.TELEGRAM_CHAT_ID);
  return {
    status: tokenConfigured && chatConfigured ? "configured" : "not-configured",
    tokenConfigured,
    chatConfigured,
    delivery: "restart-safe-bounded-at-least-once-material-alerts-only",
    paidBroadcastsRequired: false
  };
}

export class TelegramDeliveryError extends Error {
  constructor(message, { code = "delivery-failed", retryAfterSeconds = null, ambiguous = false } = {}) {
    super(message);
    this.name = "TelegramDeliveryError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.ambiguous = ambiguous;
  }
}

export function telegramRetryPlan(error, { attemptCount, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 1_000) {
    throw new RangeError("attemptCount must be a positive integer");
  }
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp");
  const errorCode = typeof error?.code === "string" && /^[a-z0-9-]{1,64}$/.test(error.code)
    ? error.code : "delivery-failed";
  const retryable = errorCode === "rate-limited" || error?.ambiguous === true;
  if (!retryable || attemptCount >= 5) {
    return { retry: false, status: "dead-letter", errorCode, delayMs: null, nextAttemptAt: null };
  }
  const providerDelay = errorCode === "rate-limited" && Number.isSafeInteger(error?.retryAfterSeconds)
    && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 3_600
    ? error.retryAfterSeconds * 1_000 : null;
  const delayMs = providerDelay ?? (errorCode === "rate-limited" ? 60_000 : Math.min(5_000 * 2 ** (attemptCount - 1), 60_000));
  return {
    retry: true,
    status: "retrying",
    errorCode,
    delayMs,
    nextAttemptAt: new Date(now + delayMs).toISOString()
  };
}

export async function sendTelegramAlert(alertValue, { token, chatId, baseUrl, fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  if (!alertValue || typeof alertValue !== "object" || !alertValue.mint) throw new TypeError("alert is required");
  mint(alertValue.mint, "alert.mint");
  if (typeof token !== "string" || token.length < 20 || /\s/.test(token)) throw new TypeError("Telegram bot token is not configured");
  if (typeof chatId !== "string" || !TELEGRAM_CHAT_DESTINATION.test(chatId)) throw new TypeError("Telegram chat id is not configured");
  if (typeof baseUrl !== "string" || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(baseUrl)) throw new TypeError("baseUrl must be an HTTPS origin");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new RangeError("timeoutMs must be between 1000 and 30000");
  const message = [
    `🏛️ Pump War Room — ${text(alertValue.title, "Material observation", 80)}`,
    text(alertValue.message, "Observation detail unavailable.", 500),
    `Evidence: ${text(alertValue.evidenceClass, "unavailable", 40)} at ${evidenceTime(alertValue.evidenceAt) || "unavailable"}`,
    alertValue.evidenceClass === "provider-observed" ? "Provider attribution: GeckoTerminal / CoinGecko public-beta evidence." : null,
    Number.isSafeInteger(alertValue.id) && alertValue.id > 0 ? `Event: PWR-${alertValue.id}` : null,
    `Inspect: ${baseUrl}/?coin=${alertValue.mint}`,
    "Observational research only; not financial advice."
  ].filter(Boolean).join("\n");
  if (message.length > 4_096) throw new RangeError("Telegram alert text exceeds the sendMessage limit");
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new TelegramDeliveryError("Telegram send result was ambiguous", { code: "ambiguous-network-failure", ambiguous: true });
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok !== true) {
    const retryAfter = Number(body?.parameters?.retry_after);
    if (response.status === 429) {
      throw new TelegramDeliveryError("Telegram rate limit requested a retry", {
        code: "rate-limited",
        retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3_600 ? retryAfter : 60
      });
    }
    if (response.ok) {
      throw new TelegramDeliveryError("Telegram response did not confirm delivery", { code: "invalid-success-response", ambiguous: true });
    }
    throw new TelegramDeliveryError(`Telegram send failed with HTTP ${response.status}`, {
      code: response.status >= 500 ? "ambiguous-upstream-failure" : `http-${response.status}`,
      ambiguous: response.status >= 500
    });
  }
  if (!Number.isSafeInteger(body?.result?.message_id) || body.result.message_id < 1) {
    throw new TelegramDeliveryError("Telegram response omitted message identity", { code: "invalid-success-response", ambiguous: true });
  }
  return { ok: true, messageId: body.result.message_id };
}

export const ACTION_INTELLIGENCE_WINDOWS = OUTCOME_WINDOWS;
