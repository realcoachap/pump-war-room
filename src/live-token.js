/** Withhold fields whose v0.6 ingest semantics were not source-grounded. */
export function normalizePersistedLiveToken(token, { mode = "live" } = {}) {
  if (mode !== "live" || token?.source !== "pumpportal" || token.ingestSchemaVersion === 2) return token;
  return {
    ...token,
    creator: null,
    deployer: null,
    marketCap: null,
    volume5m: null,
    priceChange5m: null,
    uniqueBuyers: null,
    buyRatio: null,
    bondingProgress: null,
    momentum: null,
    smartWallets: null,
    risk: null,
    riskConfidence: "unavailable",
    status: token.status === "graduated" ? "legacy-migration-unverified" : token.status,
    legacySemanticsWithheld: true
  };
}
