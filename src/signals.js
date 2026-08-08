const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

export function momentumScore(token) {
  const velocity = clamp((token.volume5m || 0) / 125);
  const buyers = clamp((token.uniqueBuyers || 0) * 3.2);
  const pressure = clamp(((token.buyRatio || 0.5) - 0.35) * 150);
  const curve = clamp((token.bondingProgress || 0) * 0.8);
  return Math.round(clamp(velocity * 0.34 + buyers * 0.28 + pressure * 0.22 + curve * 0.16));
}

export function riskScore(token) {
  const dev = clamp(((token.devHoldingPct || 0) - 3) * 5.3);
  const holders = clamp(((token.top10Pct || 0) - 25) * 2.2);
  const sells = clamp((0.55 - (token.buyRatio || 0.5)) * 180);
  const history = token.creatorRisk ? 80 : 12;
  return Math.round(clamp(dev * 0.34 + holders * 0.29 + sells * 0.2 + history * 0.17));
}

export function riskConfidence(token) {
  if (token.source === "demo") return "synthetic";
  const verifiedInputs = [token.devHoldingPct, token.top10Pct, token.buyRatio]
    .filter((value) => Number.isFinite(value)).length + (typeof token.creatorRisk === "boolean" ? 1 : 0);
  if (verifiedInputs === 4) return "verified";
  if (verifiedInputs >= 2) return "partial";
  return "unverified";
}

export function scoreReasons(token) {
  const momentum = [];
  const risk = [];
  if ((token.volume5m || 0) > 7000) momentum.push("5m volume acceleration");
  if ((token.uniqueBuyers || 0) >= 18) momentum.push("buyer breadth");
  if ((token.buyRatio || 0) >= 0.64) momentum.push("buy-side pressure");
  if ((token.bondingProgress || 0) >= 75) momentum.push("near graduation");
  if ((token.devHoldingPct || 0) >= 12) risk.push("elevated dev holdings");
  if ((token.top10Pct || 0) >= 50) risk.push("holder concentration");
  if ((token.buyRatio || 0) < 0.43) risk.push("sell-side pressure");
  if (token.creatorRisk) risk.push("creator history flag");
  const confidence = token.riskConfidence || riskConfidence(token);
  return {
    momentum: momentum.length ? momentum : ["early signal—limited history"],
    risk: confidence === "unverified"
      ? ["awaiting holder, creator, and trade enrichment"]
      : risk.length ? risk : ["no major heuristic flags"],
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
