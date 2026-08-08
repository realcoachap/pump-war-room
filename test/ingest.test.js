import test from "node:test";
import assert from "node:assert/strict";
import { PumpPortalIngestor } from "../src/ingest.js";

test("new live tokens remain risk-unverified until enrichment arrives", () => {
  let observed;
  const ingestor = new PumpPortalIngestor({
    url: "wss://example.invalid",
    onToken: (token) => { observed = token; }
  });

  ingestor.handle({ mint: "LiveMintPump", name: "Same Name", symbol: "SAME", marketCapSol: 10 });

  assert.equal(observed.mint, "LiveMintPump");
  assert.equal(observed.source, "pumpportal");
  assert.equal(observed.risk, null);
  assert.equal(observed.riskConfidence, "unverified");
  assert.equal(observed.devHoldingPct, null);
  assert.equal(observed.top10Pct, null);
});
