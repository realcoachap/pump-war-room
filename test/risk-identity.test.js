import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRiskIdentityEvidence,
  deriveTokenIdentityEvidence,
  GECKOTERMINAL_INFO_API_VERSION,
  parseGeckoTerminalTokenInfo,
  RISK_IDENTITY_METHOD_VERSION,
  RiskIdentityError
} from "../src/risk-identity.js";

const firstMint = "11111111111111111111111111111111";
const secondMint = "22222222222222222222222222222222";
const thirdMint = "33333333333333333333333333333333";
const creator = "So11111111111111111111111111111111111111112";
const otherCreator = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const fetchedAt = "2026-08-09T12:00:00Z";

function payload(mint = firstMint, attributes = {}) {
  return {
    data: {
      id: `solana_${mint}`,
      type: "token",
      attributes: {
        address: mint,
        name: "Caf\u00e9 Coin",
        symbol: "CAF\u00c9",
        holders: {
          count: 42,
          distribution_percentage: { top_10: "27.125" },
          last_updated: "2026-08-09T11:58:00Z"
        },
        developer_address: creator,
        developer_holding_percentage: 4.5,
        twitter_handle: "@Open_Caesar",
        telegram_handle: "OpenCaesar",
        websites: ["https://B\u00dcCHER.example/a?tracking=discarded#fragment"],
        image_url: "https://assets.invalid/raw-image.png",
        image: { large: "raw" },
        description: "RAW_DESCRIPTION_MARKER",
        gt_score: 99.99,
        gt_score_details: { opaque: true },
        is_honeypot: false,
        ...attributes
      }
    }
  };
}

function parse(mint = firstMint, attributes = {}) {
  return parseGeckoTerminalTokenInfo(payload(mint, attributes), { mint, fetchedAt });
}

test("parses the documented token-info fields into a strict persistence allowlist", () => {
  const result = parse();

  assert.equal(result.mint, firstMint);
  assert.equal(result.network, "solana");
  assert.equal(result.provider, "geckoterminal");
  assert.equal(result.source, "geckoterminal");
  assert.equal(result.endpoint, `/networks/solana/tokens/${firstMint}/info`);
  assert.equal(result.apiVersion, GECKOTERMINAL_INFO_API_VERSION);
  assert.equal(result.fetchedAt, "2026-08-09T12:00:00.000Z");
  assert.equal(result.methodVersion, RISK_IDENTITY_METHOD_VERSION);
  assert.deepEqual(result.factors.holderCount, {
    value: 42,
    evidenceClass: "provider-observed",
    sourceField: "data.attributes.holders.count"
  });
  assert.equal(result.factors.top10HolderPercentage.value, 27.125);
  assert.equal(result.factors.providerLastUpdated.value, "2026-08-09T11:58:00.000Z");
  assert.equal(result.factors.developerHoldingPercentage.value, 4.5);
  assert.match(result.fingerprints.developerAddress.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.fingerprints.xHandle.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.fingerprints.telegramHandle.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.fingerprints.websiteDomains.values.map((entry) => Object.keys(entry)), [["fingerprint"]]);
  assert.match(result.fingerprints.nameSymbol.fingerprint, /^[a-f0-9]{64}$/);

  const forbiddenKeys = new Set([
    "raw", "rawResponse", "payload", "image", "image_url", "banner_image_url",
    "description", "gt_score", "gt_score_details", "is_honeypot"
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden output key: ${key}`);
      visit(child);
    }
  };
  visit(result);
  assert.doesNotMatch(JSON.stringify(result), /RAW_DESCRIPTION_MARKER|raw-image|99\.99|open_caesar|opencaesar|bcher|example\/a|Caf/i);
});

test("missing provider fields remain explicit unavailable evidence", () => {
  const result = parse(firstMint, {
    name: null,
    symbol: null,
    holders: null,
    developer_address: null,
    developer_holding_percentage: null,
    twitter_handle: null,
    telegram_handle: null,
    websites: []
  });

  for (const factor of Object.values(result.factors)) {
    assert.equal(factor.value, null);
    assert.equal(factor.evidenceClass, "unavailable");
  }
  for (const key of ["developerAddress", "xHandle", "telegramHandle", "nameSymbol"]) {
    assert.equal(result.fingerprints[key].fingerprint, null);
    assert.equal(result.fingerprints[key].evidenceClass, "unavailable");
  }
  assert.deepEqual(result.fingerprints.websiteDomains, {
    values: [],
    evidenceClass: "unavailable",
    sourceField: "data.attributes.websites"
  });
});

test("rejects malformed bounded factors, timestamps, handles, and websites", () => {
  const invalidAttributes = [
    { holders: { count: -1 } },
    { holders: { distribution_percentage: { top_10: "100.01" } } },
    { holders: { last_updated: "yesterday" } },
    { holders: { last_updated: "2026-02-30T12:00:00Z" } },
    { developer_holding_percentage: -0.01 },
    { developer_holding_percentage: "4.5" },
    { twitter_handle: "https://x.com/not-a-handle" },
    { telegram_handle: "unicode-\u2603" },
    { websites: ["javascript:alert(1)"] },
    { websites: ["https://user:secret@example.com/"] }
  ];
  for (const attributes of invalidAttributes) {
    assert.throws(
      () => parse(firstMint, attributes),
      (error) => error instanceof RiskIdentityError && ["invalid-response", "invalid-timestamp"].includes(error.code)
    );
  }
});

test("rejects data id or address mismatches", () => {
  const wrongId = payload();
  wrongId.data.id = `solana_${secondMint}`;
  assert.throws(
    () => parseGeckoTerminalTokenInfo(wrongId, { mint: firstMint, fetchedAt }),
    (error) => error instanceof RiskIdentityError && error.code === "token-mismatch"
  );

  const wrongAddress = payload();
  wrongAddress.data.attributes.address = secondMint;
  assert.throws(
    () => parseGeckoTerminalTokenInfo(wrongAddress, { mint: firstMint, fetchedAt }),
    (error) => error instanceof RiskIdentityError && error.code === "token-mismatch"
  );
});

test("case, Unicode composition, and WHATWG IDNA normalization produce exact stable fingerprints", () => {
  const left = parse(firstMint, {
    name: "Cafe\u0301 Coin",
    symbol: "CAFE\u0301",
    twitter_handle: "@Open_Caesar",
    telegram_handle: "OpenCaesar",
    websites: ["https://b\u00fccher.example/path"]
  });
  const right = parse(secondMint, {
    name: "CAF\u00c9 COIN",
    symbol: "caf\u00e9",
    twitter_handle: "open_caesar",
    telegram_handle: "opencaesar",
    websites: ["http://XN--BCHER-KVA.EXAMPLE/other"]
  });

  assert.equal(left.fingerprints.nameSymbol.fingerprint, right.fingerprints.nameSymbol.fingerprint);
  assert.equal(left.fingerprints.xHandle.fingerprint, right.fingerprints.xHandle.fingerprint);
  assert.equal(left.fingerprints.telegramHandle.fingerprint, right.fingerprints.telegramHandle.fingerprint);
  assert.equal(left.fingerprints.websiteDomains.values[0].fingerprint, right.fingerprints.websiteDomains.values[0].fingerprint);
  assert.notEqual(left.fingerprints.xHandle.fingerprint, left.fingerprints.telegramHandle.fingerprint);
});

test("matches registrable website domains across subdomains including private suffixes", () => {
  const apex = parse(firstMint, { websites: ["https://example.com/path", "https://foo.github.io/"] });
  const subdomains = parse(secondMint, { websites: ["https://www.example.com/other", "https://a.foo.github.io/page"] });
  assert.deepEqual(
    apex.fingerprints.websiteDomains.values.map(({ fingerprint }) => fingerprint).sort(),
    subdomains.fingerprints.websiteDomains.values.map(({ fingerprint }) => fingerprint).sort()
  );
});

test("derives only prospectively observed declared creator/deployer evidence", () => {
  const rows = deriveTokenIdentityEvidence([
    { mint: firstMint, source: "pumpportal", createdAt: fetchedAt, name: "One", symbol: "ONE", creator, deployer: otherCreator },
    { mint: secondMint, source: "historical-import", createdAt: fetchedAt, name: "Two", symbol: "TWO", creator },
    { mint: thirdMint, source: "pumpportal", createdAt: "not-a-time", name: "Three", symbol: "THREE", creator }
  ]);

  assert.equal(rows[0].prospectivelyObserved, true);
  assert.match(rows[0].declaredCreator.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(rows[0].declaredDeployer.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(rows[1].prospectivelyObserved, false);
  assert.equal(rows[1].declaredCreator.evidenceClass, "unavailable");
  assert.equal(rows[2].prospectivelyObserved, false);
  assert.equal(rows[2].declaredCreator.fingerprint, null);
});

test("counts exact duplicates and prospective launches without making controller or harm claims", () => {
  const evidenceRows = [
    parse(firstMint, { developer_address: creator }),
    parse(secondMint, { developer_address: creator }),
    parse(thirdMint, {
      name: "Different",
      symbol: "DIFF",
      developer_address: null,
      twitter_handle: null,
      telegram_handle: null,
      websites: []
    })
  ];
  const tokenRows = [
    { mint: firstMint, source: "pumpportal", createdAt: "2026-08-09T10:00:00Z", name: "Caf\u00e9 Coin", symbol: "CAF\u00c9", creator, deployer: otherCreator },
    { mint: secondMint, source: "pumpportal", createdAt: "2026-08-09T10:01:00Z", name: "CAFE\u0301 COIN", symbol: "cafe\u0301", creator, deployer: creator },
    { mint: thirdMint, source: "pumpportal", createdAt: "2026-08-09T10:02:00Z", name: "Different", symbol: "DIFF", creator: otherCreator }
  ];
  const result = aggregateRiskIdentityEvidence(evidenceRows, tokenRows);
  const first = result.byMint[firstMint];
  const second = result.byMint[secondMint];
  const third = result.byMint[thirdMint];

  assert.equal(first.exactDuplicateCounts.xHandle.value, 1);
  assert.equal(first.exactDuplicateCounts.telegramHandle.value, 1);
  assert.equal(first.exactDuplicateCounts.websiteDomain.value, 1);
  assert.equal(first.exactDuplicateCounts.nameSymbol.value, 1);
  assert.equal(second.exactDuplicateCounts.nameSymbol.value, 1);
  assert.equal(third.exactDuplicateCounts.xHandle.value, null);
  assert.equal(third.exactDuplicateCounts.nameSymbol.value, 0);
  assert.equal(first.prospectiveLaunchCounts.declaredCreator.value, 2);
  assert.equal(second.prospectiveLaunchCounts.declaredCreator.value, 2);
  assert.equal(first.prospectiveLaunchCounts.declaredDeployer.value, 1);
  assert.equal(second.prospectiveLaunchCounts.declaredDeployer.value, 1);
  assert.equal(third.prospectiveLaunchCounts.declaredCreator.value, 1);
  assert.equal(first.prospectiveLaunchCounts.providerDeveloperAddress.value, 2);
  assert.deepEqual(first.exactDeclaredIdentifierReuse, { value: 1, evidenceClass: "locally-derived" });
  assert.deepEqual(first.duplicateContent, { value: null, evidenceClass: "unavailable" });
  assert.deepEqual(first.likelyController, { value: null, evidenceClass: "unavailable" });
  assert.deepEqual(first.maliciousness, { value: null, evidenceClass: "unavailable" });
  assert.deepEqual(result.coverage, {
    evidenceRowCount: 3,
    providerEvidenceMintCount: 3,
    tokenRowCount: 3,
    tokenEvidenceMintCount: 3,
    prospectivelyObservedTokenMintCount: 3,
    outputMintCount: 3,
    evidenceClass: "locally-derived"
  });

  const publicOutput = JSON.stringify(result.byMint);
  const visitPublic = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /fingerprint/i);
      visitPublic(child);
    }
  };
  visitPublic(result.byMint);
  assert.doesNotMatch(publicOutput, /[a-f0-9]{64}/i);
  assert.doesNotMatch(publicOutput, /safe|no.flags|probab|risk.score/i);
});

test("does not claim provider developer launch history without an observed identity match", () => {
  const unmatchedDeveloper = "SysvarRent111111111111111111111111111111111";
  const result = aggregateRiskIdentityEvidence([
    parse(firstMint, { developer_address: unmatchedDeveloper })
  ], [
    { mint: firstMint, source: "pumpportal", createdAt: fetchedAt, creator, deployer: otherCreator }
  ]);
  assert.deepEqual(result.byMint[firstMint].prospectiveLaunchCounts.providerDeveloperAddress, {
    value: null,
    evidenceClass: "unavailable"
  });
});

test("bounds website and aggregation input sizes", () => {
  assert.throws(
    () => parse(firstMint, { websites: Array.from({ length: 17 }, (_, index) => `https://site${index}.example/`) }),
    /at most 16/
  );
  assert.throws(() => deriveTokenIdentityEvidence(Array(1_001).fill({})), /at most 1000/);
  assert.throws(() => aggregateRiskIdentityEvidence(Array(1_001).fill({}), []), /at most 1000/);
});
