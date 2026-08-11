import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

function specification() {
  const source = readFileSync(path.join(root, "public", "openapi.json"), "utf8");
  assert.match(source, /__APP_VERSION__/);
  return JSON.parse(source.replaceAll("__APP_VERSION__", packageVersion));
}

function schemaReferences(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (typeof value.$ref === "string") found.push(value.$ref);
  for (const child of Object.values(value)) schemaReferences(child, found);
  return found;
}

test("publishes a versioned OpenAPI 3.1 read-only API contract", () => {
  const spec = specification();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.version, packageVersion);
  assert.deepEqual(spec.security, []);
  assert.equal(spec.components.securitySchemes, undefined);
  const methods = {
    "/api/health": "get",
    "/api/snapshot": "get",
    "/api/v1/entities": "get",
    "/api/v1/entities/resolve": "get",
    "/api/v1/openapi.json": "get",
    "/api/coins/{mint}": "get",
    "/api/coins/{mint}/timeline": "get",
    "/api/compare": "get",
    "/api/briefs/daily": "get",
    "/api/briefs/weekly": "get",
    "/api/agent/chat": "post",
    "/api/stream": "get"
  };
  assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(methods).sort());
  for (const [pathname, method] of Object.entries(methods)) {
    const route = spec.paths[pathname];
    assert.deepEqual(Object.keys(route), [method], `${pathname} documented an unsupported method`);
    assert.ok(route[method].responses["200"], `${pathname} must document HTTP 200`);
    assert.ok(route[method].responses["405"], `${pathname} must document HTTP 405`);
  }
  const list = spec.paths["/api/v1/entities"].get;
  assert.match(list.description, /never summed/);
  assert.match(list.description, /weak consistency/);
  assert.deepEqual(list.parameters.find(({ name }) => name === "limit").schema, {
    type: "integer", minimum: 1, maximum: 100, default: 20
  });
  assert.ok(list.responses["400"]);
  assert.ok(list.responses["429"]);
  assert.ok(list.responses["200"].headers["X-RateLimit-Limit"]);
  assert.ok(spec.paths["/api/v1/entities/resolve"].get.responses["429"]);
  assert.ok(spec.paths["/api/snapshot"].get.responses["429"]);
  assert.ok(spec.paths["/api/snapshot"].get.responses["200"].headers["X-RateLimit-Limit"]);
  assert.ok(spec.paths["/api/agent/chat"].post.responses["413"]);
  assert.ok(spec.paths["/api/agent/chat"].post.responses["415"]);
  assert.ok(spec.paths["/api/agent/chat"].post.responses["429"]);
  assert.equal(spec.paths["/api/stream"].get.responses["503"].$ref, "#/components/responses/StreamCapacity");
  assert.ok(spec.components.responses.StreamCapacity.headers["Retry-After"]);
  assert.ok(Object.keys(spec.paths).every((pathname) => !pathname.startsWith("/api/export/")));
  assert.equal(spec.components.schemas.EntityPage.properties.methodVersion.const, "reviewed-entity-intelligence-v1");
  assert.equal(spec.components.schemas.EntityPage.properties.page.properties.order.const, "entity-id-ascending");
  assert.equal(spec.components.schemas.RegistryCapacity.properties.entities.const, 500);
  assert.equal(spec.components.schemas.RegistryCapacity.properties.variants.const, 2000);
  assert.ok(spec.components.schemas.RegistryProjection.required.includes("integrityOmittedCounts"));
  assert.deepEqual(spec.components.schemas.RegistryCounts.required, ["entities", "variants", "relationships"]);
  assert.ok(spec.components.schemas.IdentityResolution.required.includes("relationshipCoverage"));
  assert.ok(spec.components.schemas.IdentityResolution.required.includes("proposalCoverage"));
  assert.equal(spec.components.schemas.RelationshipCoverage.properties.limit.const, 100);
  assert.match(spec.components.schemas.RelationshipCoverage.description, /projectionOmittedCount/);
  assert.ok(spec.components.schemas.RelationshipCoverage.required.includes("limitOmittedCount"));
  assert.equal(spec.components.schemas.IdentityVariant.properties.reviewState.enum.includes("unreviewed"), true);
  assert.equal(spec.components.schemas.IdentityProposal.properties.reviewState.const, "proposed");
  assert.ok(spec.components.schemas.EntityAggregate.required.includes("volume"));
  assert.equal(spec.paths["/api/health"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/Health");
  assert.equal(spec.paths["/api/snapshot"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/Snapshot");
  assert.equal(spec.paths["/api/coins/{mint}/timeline"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/CoinTimeline");
  assert.equal(spec.paths["/api/agent/chat"].post.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/AnalystResponse");
  assert.deepEqual(spec.components.schemas.AnalystEvidence.required, ["label"]);
  assert.equal(spec.components.schemas.AnalystEvidence.properties.label.maxLength, 240);
  assert.equal(spec.components.schemas.AnalystEvidence.properties.mint.$ref, "#/components/schemas/SolanaMint");
  assert.equal(spec.components.schemas.AnalystEvidence.properties.citation, undefined);
  assert.equal(spec.components.schemas.AnalystEvidence.properties.detail, undefined);
  assert.equal(spec.components.schemas.TokenIntegrity.properties.maxStalenessSeconds.const, 5);
  assert.equal(spec.components.schemas.TokenIntegrity.properties.basis.const, "cached-full-retained-token-sql-aggregate");
  assert.equal(spec.components.schemas.TokenIntegrity.properties.checkedCount.maximum, undefined);
  assert.equal(spec.components.schemas.EntityVolume.properties.contributingMintCount.maximum, 1);
  assert.match(spec.components.schemas.EntityVolume.description, /plus missingMintCount equals/);
  assert.ok(spec.components.schemas.IncludedVariant.required.includes("registryObservedAt"));
  assert.ok(spec.components.schemas.IncludedVariant.required.includes("tokenObservedAt"));
  assert.match(spec.components.headers.RateLimitReset.description, /Unix timestamp in seconds/);
  assert.deepEqual(spec.servers, [{ url: "/" }]);
  for (const reference of schemaReferences(spec)) {
    if (!reference.startsWith("#/components/schemas/")) continue;
    assert.ok(spec.components.schemas[reference.split("/").at(-1)], `unresolved schema reference ${reference}`);
  }
});

test("keeps the checked-in API guide aligned with runtime routes and evidence boundaries", () => {
  const server = readFileSync(path.join(root, "src", "server.js"), "utf8");
  const docs = readFileSync(path.join(root, "public", "api.html"), "utf8");
  for (const route of [
    "/api/health", "/api/snapshot", "/api/v1/entities", "/api/v1/entities/resolve", "/api/v1/openapi.json",
    "/api/compare", "/api/briefs/daily", "/api/agent/chat", "/api/stream", "/api/export/daily"
  ]) {
    assert.ok(server.includes(`url.pathname === "${route}"`), `runtime route missing: ${route}`);
  }
  assert.ok(server.includes("/api/coins/"));
  assert.match(docs, /data-release-marker="entity-api-hardening-v1"/);
  assert.match(docs, /Each entity trend has at most one exact-mint contributor/i);
  assert.match(docs, /cap reviewed incident edges at 100/i);
  assert.match(docs, /500 whole entities, 2,000 variants, and 5,000 relationships/i);
  assert.match(docs, /does not offer external API keys/i);
  assert.match(docs, /process-global .* per instance/i);
  assert.match(docs, /Readiness is not rate-limited/i);
  assert.match(docs, /vault exports are outside this public contract/i);
  assert.match(docs, /fail closed with typed HTTP 403 in every mode/i);
  assert.match(docs, /not authenticity, safety, common control, quality, performance, or a trade recommendation/i);
  assert.doesNotMatch(docs, /<script\b/i);
  assert.doesNotMatch(docs, /pump-war-room-production\.up\.railway\.app/i);
});
