import { randomBytes } from "node:crypto";
import { classifyNarrative, momentumScore, riskScore } from "./signals.js";

const names = [
  ["Senator Cat", "SCAT"], ["Neural Ape", "NAPE"], ["Just A Duck", "DUCK"],
  ["Based Terminal", "TERM"], ["President Pepe", "PREPE"], ["Agent Wojak", "AWOJ"],
  ["Breaking Goat", "BGOAT"], ["Onchain Penguin", "PENG"], ["Viral Bot", "VBOT"],
  ["Moon Clerk", "CLERK"], ["Meme Reserve", "MEMER"], ["Red Button", "BUTTON"]
];
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    encoded = b58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}
const randomMint = () => encodeBase58(randomBytes(32));
const between = (min, max) => min + Math.random() * (max - min);

export function createDemoToken(index = 0, ageMinutes = 0) {
  const [name, symbol] = names[index % names.length];
  const buyRatio = between(0.38, 0.79);
  const token = {
    mint: randomMint(), name, symbol, creator: randomMint(),
    description: `${name} is a community meme experiment`,
    createdAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    status: "bonding", narrative: classifyNarrative(`${name} ${symbol}`),
    marketCap: between(7_500, 155_000), volume5m: between(350, 21_000),
    priceChange5m: between(-18, 74), uniqueBuyers: Math.round(between(3, 39)),
    buyRatio, bondingProgress: between(6, 97), devHoldingPct: between(1, 19),
    top10Pct: between(22, 67), creatorRisk: Math.random() > 0.86,
    smartWallets: Math.floor(between(0, 6)), source: "demo"
  };
  token.momentum = momentumScore(token);
  token.risk = riskScore(token);
  token.riskConfidence = "synthetic";
  return token;
}

export function tickDemoToken(token) {
  const next = { ...token };
  next.volume5m = Math.max(0, next.volume5m * between(0.92, 1.18));
  next.priceChange5m = Math.max(-80, Math.min(250, next.priceChange5m + between(-5, 8)));
  next.uniqueBuyers += Math.random() > 0.55 ? 1 : 0;
  next.buyRatio = Math.max(0.2, Math.min(0.9, next.buyRatio + between(-0.025, 0.03)));
  next.bondingProgress = Math.min(100, next.bondingProgress + between(0.2, 2.8));
  if (next.bondingProgress >= 100) next.status = "graduated";
  next.marketCap = Math.max(3000, next.marketCap * between(0.96, 1.09));
  next.momentum = momentumScore(next);
  next.risk = riskScore(next);
  next.riskConfidence = "synthetic";
  return next;
}
