const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function momentumScore(token) {
  const supplied = [token.volume5m, token.uniqueBuyers, token.buyRatio, token.bondingProgress]
    .filter((value) => finite(value) !== null);
  if (!supplied.length) return null;
  const velocity = finite(token.volume5m) === null ? 0 : clamp(token.volume5m / 125);
  const buyers = finite(token.uniqueBuyers) === null ? 0 : clamp(token.uniqueBuyers * 3.2);
  const pressure = finite(token.buyRatio) === null ? 0 : clamp((token.buyRatio - 0.35) * 150);
  const curve = finite(token.bondingProgress) === null ? 0 : clamp(token.bondingProgress * 0.8);
  return Math.round(clamp(velocity * 0.34 + buyers * 0.28 + pressure * 0.22 + curve * 0.16));
}

export function riskScore(token) {
  // v0.7 exposes auditable factors, not an uncalibrated probability-like
  // composite.  Keep the legacy export for callers while refusing to invent
  // a numeric risk score from correlated or missing provider fields.
  return null;
}

export function riskConfidence(token) {
  if (token.source === "demo") return "synthetic";
  const evidenceClass = token?.riskIdentity?.overallEvidence;
  return ["on-chain-finalized", "provider-observed", "feed-observed-processed", "locally-derived", "unavailable"]
    .includes(evidenceClass) ? evidenceClass : "unavailable";
}

export function scoreReasons(token) {
  const momentum = [];
  const risk = [];
  if ((token.volume5m || 0) > 7000) momentum.push("5m volume acceleration");
  if ((token.uniqueBuyers || 0) >= 18) momentum.push("buyer breadth");
  if ((token.buyRatio || 0) >= 0.64) momentum.push("buy-side pressure");
  if ((token.bondingProgress || 0) >= 75) momentum.push("near graduation");
  if (Number.isFinite(token.devHoldingPct) && token.devHoldingPct >= 12) risk.push("provider-reported developer holding is elevated");
  if (Number.isFinite(token.top10Pct) && token.top10Pct >= 50) risk.push("provider-reported top-10 concentration is elevated");
  if (Number.isFinite(token.buyRatio) && token.buyRatio < 0.43) risk.push("observed sell-side pressure");
  if (token.creatorRisk === true) risk.push("prospectively observed identity reuse");
  const confidence = token.riskConfidence || riskConfidence(token);
  return {
    momentum: momentum.length ? momentum : ["early signal—limited history"],
    risk: risk.length ? risk : ["risk interpretation unavailable; review factor coverage and explicit unknowns"],
    riskConfidence: confidence
  };
}

export function classifyNarrative(text = "") {
  const value = text.toLowerCase();
  const families = [
    ["AI agents", /\b(ai|agent|bot|gpt|neural|model)\b/],
    ["Politics", /\b(trump|president|vote|senate|maga|government)\b/],
    ["Animals", /\b(cat|dog|frog|ape|penguin|goat|duck|bear)\b/],
    ["Breaking news", /\b(breaking|alert|official|news|just in)\b/],
    ["Internet culture", /\b(meme|viral|based|wojak|pepe|chad|brainrot)\b/]
  ];
  return families.find(([, pattern]) => pattern.test(value))?.[0] || "Other";
}
