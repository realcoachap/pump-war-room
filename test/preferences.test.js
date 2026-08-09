import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESET_LIMIT,
  PREFERENCE_KEY,
  WATCHLIST_LIMIT,
  defaultPreferences,
  normalizeFilterState,
  normalizePreferences,
  readPreferences,
  writePreferences
} from "../public/preferences.js";

const mint = (index) => `${"1".repeat(31)}${"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[index % 58]}`;

test("normalizes URL filter state without promoting invalid or unbounded values", () => {
  assert.deepEqual(normalizeFilterState({
    search: `  alpha\u0000${"x".repeat(100)}  `,
    lens: "unsafe", freshness: "fresh", risk: "provider-observed", watchlist: "watched"
  }), {
    search: `alpha ${"x".repeat(74)}`,
    lens: "radar", freshness: "fresh", risk: "provider-observed", watchlist: "watched"
  });
  assert.deepEqual(normalizeFilterState(null), {
    search: "", lens: "radar", freshness: "all", risk: "all", watchlist: "all"
  });
});

test("bounds and deduplicates imported watchlists and filter lenses", () => {
  const watchedMints = Array.from({ length: WATCHLIST_LIMIT + 8 }, (_, index) => mint(index));
  const presets = Array.from({ length: PRESET_LIMIT + 5 }, (_, index) => ({
    id: `lens-${index}`, name: `Lens ${index}\u0000<script>`,
    filters: { search: "meme", lens: "newest", freshness: "stale", risk: "synthetic", watchlist: "watched" }
  }));
  const value = normalizePreferences({ schemaVersion: 1, watchedMints: [...watchedMints, watchedMints[0], "bad"], presets });
  assert.equal(value.watchedMints.length, WATCHLIST_LIMIT);
  assert.equal(new Set(value.watchedMints).size, WATCHLIST_LIMIT);
  assert.equal(value.presets.length, PRESET_LIMIT);
  assert.equal(value.presets[0].name.includes("\u0000"), false);
  assert.equal(value.presets[0].filters.lens, "newest");
  assert.throws(() => normalizePreferences({ schemaVersion: 0 }, { strict: true }), /schema version 1/);
  assert.deepEqual(normalizePreferences({ schemaVersion: 0 }), defaultPreferences());
});

test("recovers from corrupt or blocked browser storage and never throws", () => {
  assert.deepEqual(readPreferences({ getItem: () => "{broken" }), { preferences: defaultPreferences(), available: false });
  assert.deepEqual(readPreferences({ getItem: () => { throw new Error("blocked"); } }), { preferences: defaultPreferences(), available: false });
  assert.deepEqual(writePreferences({ setItem: () => { throw new Error("quota"); } }, defaultPreferences()), {
    preferences: defaultPreferences(), available: false
  });
});

test("writes only the normalized versioned preference contract", () => {
  let storedKey = null;
  let storedValue = null;
  const storage = { setItem(key, value) { storedKey = key; storedValue = value; } };
  const result = writePreferences(storage, {
    schemaVersion: 1,
    watchedMints: [mint(1), mint(1), "bad"],
    presets: [{ id: "valid-lens", name: "<img onerror=alert(1)>", filters: { lens: "invalid" } }],
    credential: "must-not-persist"
  });
  assert.equal(result.available, true);
  assert.equal(storedKey, PREFERENCE_KEY);
  const decoded = JSON.parse(storedValue);
  assert.deepEqual(Object.keys(decoded), ["schemaVersion", "watchedMints", "presets"]);
  assert.deepEqual(decoded.watchedMints, [mint(1)]);
  assert.equal(decoded.presets[0].filters.lens, "radar");
  assert.doesNotMatch(storedValue, /must-not-persist|credential/);
});
