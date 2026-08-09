const MAX_QUESTION_LENGTH = 500;
const FRESH_MINT_WINDOW_MS = 90_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

const cleanText = (value, maxLength = 96) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
};

const safeMint = (value) => cleanText(value, 96).replace(/[^A-Za-z0-9._:-]/g, "_");

const numberLabel = (value) => Number.isInteger(value)
  ? String(value)
  : value.toLocaleString("en-US", { maximumFractionDigits: 1 });

const tokenLabel = (token) => cleanText(token.symbol, 16) || cleanText(token.name, 48) || "unnamed token";

const validDate = (value) => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const citation = (source, detail, mint) => {
  const item = { citation: source, detail: cleanText(detail, 240) };
  const normalizedMint = safeMint(mint);
  if (normalizedMint) item.mint = normalizedMint;
  return item;
};

const dedupeEvidence = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.citation || !item.detail) return false;
    const key = `${item.citation}\u0000${item.detail}\u0000${item.mint || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
};

function resolveNow(now) {
  const supplied = typeof now === "function" ? now() : now;
  const date = supplied === undefined ? new Date() : supplied instanceof Date ? new Date(supplied.getTime()) : new Date(supplied);
  if (Number.isNaN(date.getTime())) throw new TypeError("options.now must resolve to a valid date");
  return date;
}

function normalizeQuestion(question) {
  if (typeof question !== "string") throw new TypeError("question must be a string");
  if (question.length > MAX_QUESTION_LENGTH) throw new RangeError(`question must be at most ${MAX_QUESTION_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(question)) throw new TypeError("question must not contain control characters");

  const normalized = question.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) throw new TypeError("question must not be empty");
  if (normalized.length > MAX_QUESTION_LENGTH) throw new RangeError(`question must be at most ${MAX_QUESTION_LENGTH} characters`);
  return normalized;
}

function snapshotHealth(snapshot, now) {
  const nested = isRecord(snapshot.feedHealth) ? snapshot.feedHealth : null;
  const healthValue = typeof snapshot.feedHealth === "string"
    ? snapshot.feedHealth
    : nested?.state || nested?.status || nested?.health || snapshot.feedStatus;
  const health = cleanText(healthValue, 32) || "unknown";
  const healthCitation = typeof snapshot.feedHealth === "string" || nested ? "snapshot.feedHealth" : "snapshot.feedStatus";
  const lastMintValue = snapshot.lastMintAt || nested?.lastMintAt;
  const lastMint = validDate(lastMintValue);

  let freshness = "unknown";
  let ageSeconds = null;
  if (lastMint) {
    const ageMs = now.getTime() - lastMint.getTime();
    if (ageMs < -5_000) freshness = "clock-skewed";
    else {
      ageSeconds = Math.max(0, Math.floor(ageMs / 1_000));
      freshness = ageMs <= FRESH_MINT_WINDOW_MS ? "fresh" : "stale";
    }
  }

  return { health, healthCitation, lastMint, lastMintValue, freshness, ageSeconds };
}

function eligibleTokens(snapshot) {
  const tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens.filter(isRecord) : [];
  const scoped = snapshot.mode === "live" ? tokens.filter((token) => token.source === "pumpportal") : tokens;
  return scoped.filter((token) => safeMint(token.mint));
}

function feedAnswer(snapshot, now) {
  const mode = cleanText(snapshot.mode, 16) || "unknown";
  const telemetry = snapshotHealth(snapshot, now);
  const evidence = [
    citation("snapshot.mode", `Mode: ${mode}`),
    citation(telemetry.healthCitation, `Reported feed health: ${telemetry.health}`)
  ];

  let answer;
  if (mode === "demo") {
    answer = `This snapshot is in demo mode; its ${telemetry.health} feed state is simulated and is not a live-data claim.`;
  } else {
    answer = `The snapshot reports feed health as ${telemetry.health}.`;
  }

  if (telemetry.lastMint) {
    const age = telemetry.ageSeconds === null ? "has a future timestamp" : `was ${telemetry.ageSeconds}s old`;
    answer += ` The last observed mint ${age} at analysis time, so local freshness is ${telemetry.freshness}.`;
    evidence.push(citation("snapshot.lastMintAt", `Last mint: ${telemetry.lastMint.toISOString()}; derived freshness: ${telemetry.freshness}`));
  } else {
    answer += " No valid last-mint timestamp is available, so freshness cannot be verified.";
    evidence.push(citation("snapshot.lastMintAt", "No valid last-mint timestamp supplied"));
  }

  const reconnects = finiteNumber(snapshot.reconnects);
  if (reconnects !== null) evidence.push(citation("snapshot.reconnects", `Reconnects: ${numberLabel(reconnects)}`));
  return { answer, evidence };
}

function momentumAnswer(snapshot, tokens, limit = 3) {
  const ranked = tokens
    .filter((token) => finiteNumber(token.momentum) !== null)
    .sort((a, b) => finiteNumber(b.momentum) - finiteNumber(a.momentum))
    .slice(0, limit);

  if (!ranked.length) {
    return {
      answer: "No eligible token has an available momentum score in this snapshot.",
      evidence: [citation("snapshot.tokens", `${tokens.length} eligible token rows; no available momentum scores`)]
    };
  }

  const qualifier = snapshot.mode === "demo" ? "simulated " : "";
  const leaders = ranked.map((token) => `${tokenLabel(token)} ${numberLabel(finiteNumber(token.momentum))}/100`).join(", ");
  return {
    answer: `Top ${qualifier}momentum observations: ${leaders}. This is a ranking of supplied scores, not a trade recommendation.`,
    evidence: ranked.map((token) => citation(
      `token:${safeMint(token.mint)}`,
      `${tokenLabel(token)} momentum: ${numberLabel(finiteNumber(token.momentum))}/100`,
      token.mint
    ))
  };
}

function newestAnswer(snapshot, tokens, limit = 3) {
  const newest = tokens
    .map((token) => ({ token, createdAt: validDate(token.createdAt) }))
    .filter(({ createdAt }) => createdAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);

  if (!newest.length) {
    return {
      answer: "No eligible token has a valid creation timestamp in this snapshot.",
      evidence: [citation("snapshot.tokens", `${tokens.length} eligible token rows; no valid creation timestamps`)]
    };
  }

  const qualifier = snapshot.mode === "demo" ? "simulated " : "";
  const observations = newest.map(({ token, createdAt }) => `${tokenLabel(token)} at ${createdAt.toISOString()}`).join(", ");
  return {
    answer: `Newest ${qualifier}mint observations: ${observations}.`,
    evidence: newest.map(({ token, createdAt }) => citation(
      `token:${safeMint(token.mint)}`,
      `${tokenLabel(token)} createdAt: ${createdAt.toISOString()}`,
      token.mint
    ))
  };
}

function narrativeAnswer(snapshot, tokens) {
  const rows = new Map();
  for (const token of tokens) {
    const name = cleanText(token.narrative, 64);
    if (!name) continue;
    const row = rows.get(name) || { name, coins: 0, mints: [] };
    row.coins++;
    row.mints.push(safeMint(token.mint));
    rows.set(name, row);
  }
  const narratives = [...rows.values()].sort((a, b) => b.coins - a.coins || a.name.localeCompare(b.name)).slice(0, 5);

  if (!narratives.length) {
    return {
      answer: "No eligible token has a narrative label in this snapshot.",
      evidence: [citation("snapshot.tokens.narrative", `${tokens.length} eligible token rows; no narrative labels`)]
    };
  }

  return {
    answer: `Most represented snapshot narratives: ${narratives.map((row) => `${row.name} (${row.coins})`).join(", ")}. Counts reflect supplied token labels only.`,
    evidence: narratives.map((row) => citation(
      "snapshot.tokens.narrative",
      `${row.name}: ${row.coins} eligible token${row.coins === 1 ? "" : "s"}`,
      row.mints[0]
    ))
  };
}

function riskAnswer(tokens) {
  const groups = {
    "on-chain-finalized": [], "provider-observed": [], "feed-observed-processed": [],
    "locally-derived": [], unavailable: [], synthetic: [], undeclared: []
  };
  for (const token of tokens) {
    const confidence = cleanText(token.riskIdentity?.overallEvidence || token.riskConfidence, 32).toLowerCase();
    (groups[confidence] || groups.undeclared).push(token);
  }

  if (!tokens.length) {
    return {
      answer: "No eligible token rows are available for a risk-evidence assessment. Missing evidence is never inferred as safety.",
      evidence: [citation("snapshot.tokens", "No eligible token rows")]
    };
  }

  const summary = ["on-chain-finalized", "provider-observed", "feed-observed-processed", "locally-derived", "unavailable", "synthetic", "undeclared"]
    .filter((name) => groups[name].length)
    .map((name) => `${name} ${groups[name].length}`)
    .join(", ");
  let answer = `Risk-evidence classes across ${tokens.length} eligible tokens: ${summary}.`;
  answer += " Holder and developer values are provider observations; duplicate matches and launch counts are local derivations. They are not calibrated maliciousness probabilities and do not alter the leaderboard rank.";
  if (groups.unavailable.length || groups.undeclared.length) answer += " Missing evidence remains explicitly unavailable.";
  if (groups.synthetic.length) answer += " Synthetic scores are simulation data, not live risk evidence.";
  answer += " Exact declared-social or registrable-domain reuse shows identifier reuse only; it does not establish duplicate content, common control, fraud, or safety. This is not trade advice.";

  const evidence = [];
  for (const confidence of ["unavailable", "undeclared", "provider-observed", "feed-observed-processed", "locally-derived", "on-chain-finalized", "synthetic"]) {
    for (const token of groups[confidence].slice(0, 3)) {
      const top10 = finiteNumber(token.riskIdentity?.factors?.concentration?.top10Percentage);
      const factor = top10 === null ? "; concentration unknown" : `; provider-reported top-10: ${numberLabel(top10)}%`;
      evidence.push(citation(
        `token:${safeMint(token.mint)}`,
        `${tokenLabel(token)} risk evidence: ${confidence}${factor}; numeric composite withheld`,
        token.mint
      ));
    }
  }
  return { answer, evidence };
}

function graduationAnswer(snapshot, tokens) {
  const lifecycle = tokens.filter((token) => ["migration-observed", "graduated", "migrated"].includes(cleanText(token.status, 32).toLowerCase()));
  const stats = isRecord(snapshot.stats) ? snapshot.stats : {};
  const migrationReported = finiteNumber(stats.migrationsObserved);
  const legacyReported = finiteNumber(stats.graduations);
  const reported = migrationReported ?? legacyReported;
  const citationKey = migrationReported !== null ? "snapshot.stats.migrationsObserved" : "snapshot.stats.graduations";

  if (lifecycle.length) {
    return {
      answer: `${lifecycle.length} eligible token${lifecycle.length === 1 ? " has" : "s have"} a supplied migration/graduation status: ${lifecycle.slice(0, 5).map(tokenLabel).join(", ")}. A processed-feed migration observation is not independently finalized proof.`,
      evidence: lifecycle.slice(0, 5).map((token) => citation(
        `token:${safeMint(token.mint)}`,
        `${tokenLabel(token)} supplied lifecycle status: ${cleanText(token.status, 32)}`,
        token.mint
      ))
    };
  }

  if (reported !== null && reported > 0) {
    return {
      answer: `Snapshot stats report ${numberLabel(reported)} migration/graduation observations, but no eligible supplied token row has a matching status, so mint-level details are unavailable.`,
      evidence: [citation(citationKey, `Reported migration/graduation observations: ${numberLabel(reported)}`)]
    };
  }
  return {
    answer: "No eligible supplied token row has a migration or graduation status in this snapshot.",
    evidence: [citation(reported === null ? "snapshot.tokens.status" : citationKey, reported === null ? "No eligible migration/graduation rows" : `Reported migration/graduation observations: ${numberLabel(reported)}`)]
  };
}

function calloutAnswer(snapshot) {
  const callouts = Array.isArray(snapshot.callouts)
    ? snapshot.callouts.filter((callout) => isRecord(callout) && safeMint(callout.mint))
    : [];
  const recent = callouts
    .map((callout, index) => ({ callout, index, createdAt: validDate(callout.createdAt) }))
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0) || a.index - b.index)
    .slice(0, 3);

  if (!recent.length) {
    return {
      answer: "No mint-linked callouts are available in this snapshot.",
      evidence: [citation("snapshot.callouts", "No mint-linked callout rows")]
    };
  }

  const labels = recent.map(({ callout }) => {
    const caller = cleanText(callout.caller, 48) || "unknown caller";
    return `@${caller} on ${cleanText(callout.symbol, 16) || safeMint(callout.mint)}`;
  });
  return {
    answer: `Most recent supplied callouts: ${labels.join(", ")}. Callouts are third-party observations, not validation or trade advice.`,
    evidence: recent.map(({ callout, createdAt }) => {
      const multiple = finiteNumber(callout.multiple);
      const detail = [
        `Caller: ${cleanText(callout.caller, 48) || "unknown"}`,
        `mint: ${safeMint(callout.mint)}`,
        createdAt ? `createdAt: ${createdAt.toISOString()}` : null,
        multiple !== null ? `reported multiple: ${numberLabel(multiple)}x` : null
      ].filter(Boolean).join("; ");
      return citation("snapshot.callouts", detail, callout.mint);
    })
  };
}

function overviewAnswer(snapshot, tokens, now) {
  const feed = feedAnswer(snapshot, now);
  const momentum = momentumAnswer(snapshot, tokens, 1);
  const newest = newestAnswer(snapshot, tokens, 1);
  const migrated = tokens.filter((token) => ["migration-observed", "graduated", "migrated"].includes(cleanText(token.status, 32).toLowerCase())).length;
  const callouts = Array.isArray(snapshot.callouts) ? snapshot.callouts.filter(isRecord).length : 0;
  return {
    answer: `${feed.answer} ${momentum.answer} ${newest.answer} The supplied rows contain ${migrated} migration/graduation observation${migrated === 1 ? "" : "s"} and ${callouts} callout${callouts === 1 ? "" : "s"}.`,
    evidence: [
      ...feed.evidence,
      ...momentum.evidence,
      ...newest.evidence,
      citation("snapshot.tokens.status", `Eligible migration/graduation rows: ${migrated}`),
      citation("snapshot.callouts", `Supplied callout rows: ${callouts}`)
    ]
  };
}

function hasTradeActionRequest(question) {
  return /\b(?:should|shall|would|can|could|will)\s+(?:i|we|you)\s+(?:buy|sell|swap|trade|ape|enter|exit)\b/i.test(question)
    || /\b(?:execute|place|submit|open|close)\b.{0,30}\b(?:trade|order|position|swap)\b/i.test(question)
    || /\b(?:best|which|what)\b.{0,30}\b(?:to buy|to sell|to trade)\b/i.test(question)
    || /^(?:buy|sell|swap|trade|ape)\b/i.test(question);
}

function hasExternalDataRequest(question) {
  return /\b(?:search|browse|query|check|fetch)\b.{0,40}\b(?:web|internet|twitter|x\.com|telegram|discord|api)\b/i.test(question);
}

/**
 * Answer a bounded intelligence question using only a supplied War Room snapshot.
 * The function is synchronous, deterministic when `options.now` is supplied,
 * read-only, and performs no I/O.
 */
export function analyzeSnapshot(question, snapshot, options = {}) {
  const normalizedQuestion = normalizeQuestion(question);
  if (!isRecord(snapshot)) throw new TypeError("snapshot must be an object");
  if (!isRecord(options)) throw new TypeError("options must be an object");

  const now = resolveNow(options.now);
  const tokens = eligibleTokens(snapshot);
  let result;

  if (hasTradeActionRequest(normalizedQuestion)) {
    result = {
      answer: "Caesar Intel is observation-only: it cannot recommend, execute, or simulate a trade. Ask for feed status, observed momentum, newest mints, narratives, risk evidence, migration observations, or callouts.",
      evidence: [citation("snapshot.tokens", `${tokens.length} eligible token rows are available for read-only analysis`)]
    };
  } else if (hasExternalDataRequest(normalizedQuestion)) {
    result = {
      answer: "Caesar Intel does not call external services. It can answer only from the supplied snapshot's feed, token, narrative, lifecycle, risk-evidence, and callout sections.",
      evidence: [citation("snapshot", "Analysis scope is limited to the supplied snapshot")]
    };
  } else {
    let intents = [
      ["feed", /\b(?:feed|status|health|live|stale|freshness|connect(?:ed|ion|ing)?|reconnects?)\b/i],
      ["momentum", /\b(?:momentum|hottest|hot|leaders?|leading|ranking|ranked|velocity|top tokens?)\b/i],
      ["newest", /\b(?:newest|latest|recent|freshest|new tokens?|just launched|launches)\b/i],
      ["narratives", /\b(?:narratives?|themes?|clusters?|categories)\b/i],
      ["risk", /\b(?:risk|confidence|safe|safety|danger|rug|holders?|creator)\b/i],
      ["graduations", /\b(?:graduations?|graduated|migrations?|migrated|bonding curve)\b/i],
      ["callouts", /\b(?:callouts?|callers?|mentions?|social signals?)\b/i]
    ].filter(([, pattern]) => pattern.test(normalizedQuestion)).map(([name]) => name);

    // "Latest callouts" and similar phrases qualify that section; they do not
    // also request the newest-token ranking unless tokens/mints are named.
    if (intents.includes("newest")
      && intents.some((intent) => ["narratives", "graduations", "callouts"].includes(intent))
      && !/\b(?:tokens?|mints?|launches)\b/i.test(normalizedQuestion)) {
      intents = intents.filter((intent) => intent !== "newest");
    }

    if (/\b(?:overview|summary|brief|what(?:'s| is) happening|what do you see|war room)\b/i.test(normalizedQuestion)) {
      result = overviewAnswer(snapshot, tokens, now);
    } else if (intents.length) {
      const answers = {
        feed: () => feedAnswer(snapshot, now),
        momentum: () => momentumAnswer(snapshot, tokens),
        newest: () => newestAnswer(snapshot, tokens),
        narratives: () => narrativeAnswer(snapshot, tokens),
        risk: () => riskAnswer(tokens),
        graduations: () => graduationAnswer(snapshot, tokens),
        callouts: () => calloutAnswer(snapshot)
      };
      const parts = intents.map((intent) => answers[intent]());
      result = {
        answer: parts.map((part) => part.answer).join(" "),
        evidence: parts.flatMap((part) => part.evidence)
      };
    } else {
      result = {
        answer: "I can summarize feed status, observed momentum and new mints, narratives, risk evidence, migration observations, or callouts from this snapshot. Ask about one or more of those topics.",
        evidence: [citation("snapshot.tokens", `${tokens.length} eligible token rows are available`)]
      };
    }
  }

  return {
    answer: cleanText(result.answer, 1_600),
    evidence: dedupeEvidence(result.evidence),
    generatedAt: now.toISOString(),
    mode: "local"
  };
}

export { MAX_QUESTION_LENGTH };
