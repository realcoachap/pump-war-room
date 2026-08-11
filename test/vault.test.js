import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coinMarkdown, exportCoin, measuredBriefMarkdown } from "../src/vault.js";

test("coin export includes frontmatter, links, and disclaimer", () => {
  const markdown = coinMarkdown({ mint: "ABCpump", name: "Agent Cat", symbol: "ACAT", createdAt: "2026-08-08T00:00:00Z", status: "bonding", narrative: "AI agents", momentum: 82, risk: 21, marketCap: 42000, volume5m: 9000, bondingProgress: 70, uniqueBuyers: 20, buyRatio: .7, devHoldingPct: 3, top10Pct: 25 });
  assert.match(markdown, /type: pump-coin/); assert.match(markdown, /pump\.fun\/coin\/ABCpump/); assert.match(markdown, /not investment advice/);
  assert.match(markdown, /risk_score: null/); assert.match(markdown, /Risk probability withheld/); assert.doesNotMatch(markdown, /Risk 21\/100/);
});

test("coin export keeps unavailable numeric observations unknown instead of rendering zero", () => {
  const markdown = coinMarkdown({ mint: "ABCpump", name: "Unknown", symbol: "UNK", createdAt: "2026-08-08T00:00:00Z", status: "bonding", narrative: "Other", momentum: null, risk: null, marketCap: null, volume5m: null, bondingProgress: null });
  assert.match(markdown, /market_cap_usd: null/);
  assert.match(markdown, /bonding_progress: null/);
  assert.match(markdown, /virtual_sol_reserve: null/);
  assert.match(markdown, /\*\*Market cap:\*\* unknown/);
  assert.match(markdown, /\*\*5m volume:\*\* unknown/);
  assert.match(markdown, /\*\*Virtual SOL reserve:\*\* unknown/);
  assert.doesNotMatch(markdown, /Momentum 0\/100/);
});

test("coin export preserves attached public risk evidence", () => {
  const markdown = coinMarkdown({
    mint: "ABCpump", name: "Observed", symbol: "OBS", createdAt: "2026-08-08T00:00:00Z",
    status: "bonding", narrative: "Other", momentum: null, risk: null,
    riskIdentity: { overallEvidence: "provider-observed" }
  });
  assert.match(markdown, /risk_evidence: "provider-observed"/);
});

test("coin export neutralizes untrusted Markdown, HTML, and Obsidian syntax", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pump-war-room-vault-markdown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const injected = '<img src="https://tracker.invalid/pixel"> ![beacon](https://tracker.invalid/b) [[Injected|alias]] ``` #tag';
  const coinPath = await exportCoin(directory, {
    mint: "ABCpump", name: injected, symbol: "../../[OWNED]", createdAt: "2026-08-08T00:00:00Z",
    status: injected, narrative: injected, creatorActor: injected, deployerActor: injected,
    momentum: null, risk: null, marketCap: null, volume5m: null, bondingProgress: null,
    riskConfidence: injected
  });

  assert.equal(path.relative(directory, coinPath).startsWith(".."), false);
  assert.equal(path.basename(coinPath).includes("/"), false);
  const coinBody = readFileSync(coinPath, "utf8").split("---\n").slice(2).join("---\n");
  assert.doesNotMatch(coinBody, /<img\b/i);
  assert.doesNotMatch(coinBody, /!\[beacon\]/i);
  assert.doesNotMatch(coinBody, /\[\[Injected\|alias\]\]/i);
  assert.doesNotMatch(coinBody, /https:\/\/tracker\.invalid/i);
  assert.match(coinBody, /&lt;img/);
  assert.match(coinBody, /\\!\\\[beacon\\\]/);

  const [narrativeFile] = readdirSync(path.join(directory, "Narratives"));
  assert.equal(narrativeFile.includes("/"), false);
  const narrativeBody = readFileSync(path.join(directory, "Narratives", narrativeFile), "utf8")
    .split("---\n").slice(2).join("---\n");
  assert.doesNotMatch(narrativeBody, /<img\b/i);
  assert.doesNotMatch(narrativeBody, /!\[beacon\]/i);
  assert.doesNotMatch(narrativeBody, /\[\[Injected\|alias\]\]/i);
  assert.doesNotMatch(narrativeBody, /https:\/\/tracker\.invalid/i);
  assert.match(narrativeBody, /&lt;img/);
  assert.equal((narrativeBody.match(/^```/gm) || []).length, 2, "the note must retain only its fixed Dataview fence");
});

test("measured brief export preserves closed-period denominators and suppression", () => {
  const window = {
    status: "insufficient-evidence", eligibleCount: 2, evidenceCount: 1, coverageRatio: 0.5,
    hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
  };
  const markdown = measuredBriefMarkdown({
    period: "daily", methodVersion: "measured-closed-brief-v2",
    windowStart: "2026-08-08T00:00:00.000Z", windowEnd: "2026-08-09T00:00:00.000Z",
    generatedAt: "2026-08-09T00:05:00.000Z", source: "pumpportal observations plus GeckoTerminal completed-candle outcomes",
    activity: { launchesObserved: 4, migrationObservations: 1, materialAlerts: 2, telegramDelivery: { sent: 1 } },
    outcomes: { windows: { "1h": window } },
    priorPeriod: { activity: { launchesObserved: 3, migrationObservations: 0, materialAlerts: 1 }, outcomes: { windows: { "1h": { ...window, eligibleCount: 3 } } } }
  });
  assert.match(markdown, /\[2026-08-08T00:00:00\.000Z, 2026-08-09T00:00:00\.000Z\)/);
  assert.match(markdown, /Evidence: \*\*1\/2\*\* \(prior: 1\/3\)/);
  assert.match(markdown, /suppressed for insufficient evidence/);
  assert.match(markdown, /feed coverage: \*\*unmeasured\*\*/i);
  assert.doesNotMatch(markdown, /finalized migration/i);
  assert.throws(() => measuredBriefMarkdown({ period: "daily", methodVersion: "measured-closed-brief-v1" }),
    /frozen measured daily or weekly brief/);
});

test("measured brief export renders persisted source text inert", () => {
  const window = {
    status: "insufficient-evidence", eligibleCount: 0, evidenceCount: 0, coverageRatio: null,
    hitRatePct: null, medianReturnPct: null, maximumDrawdownPct: null
  };
  const markdown = measuredBriefMarkdown({
    period: "daily", methodVersion: "measured-closed-brief-v2",
    windowStart: "2026-08-08T00:00:00.000Z", windowEnd: "2026-08-09T00:00:00.000Z",
    generatedAt: "2026-08-09T00:05:00.000Z",
    source: '<script>alert(1)</script> ![beacon](https://tracker.invalid/pixel) [[Injected]]',
    activity: { launchesObserved: 0, migrationObservations: 0, materialAlerts: 0, telegramDelivery: {} },
    outcomes: { windows: { "1h": window } },
    priorPeriod: { activity: {}, outcomes: { windows: { "1h": window } } }
  });
  const body = markdown.split("---\n").slice(2).join("---\n");
  assert.doesNotMatch(body, /<script\b/i);
  assert.doesNotMatch(body, /!\[beacon\]/i);
  assert.doesNotMatch(body, /\[\[Injected\]\]/i);
  assert.doesNotMatch(body, /https:\/\/tracker\.invalid/i);
  assert.match(body, /&lt;script/);
});
