import test from "node:test";
import assert from "node:assert/strict";
import { coinMarkdown } from "../src/vault.js";

test("coin export includes frontmatter, links, and disclaimer", () => {
  const markdown = coinMarkdown({ mint: "ABCpump", name: "Agent Cat", symbol: "ACAT", createdAt: "2026-08-08T00:00:00Z", status: "bonding", narrative: "AI agents", momentum: 82, risk: 21, marketCap: 42000, volume5m: 9000, bondingProgress: 70, uniqueBuyers: 20, buyRatio: .7, devHoldingPct: 3, top10Pct: 25 });
  assert.match(markdown, /type: pump-coin/); assert.match(markdown, /pump\.fun\/coin\/ABCpump/); assert.match(markdown, /not investment advice/);
});
