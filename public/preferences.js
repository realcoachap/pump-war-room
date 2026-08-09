export const PREFERENCE_KEY = "pump-war-room:action-intelligence:v1";
export const PREFERENCE_SCHEMA_VERSION = 1;
export const WATCHLIST_LIMIT = 50;
export const PRESET_LIMIT = 12;
export const PUBLIC_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const allowedFilters = Object.freeze({
  lens: new Set(["radar", "momentum", "newest"]),
  freshness: new Set(["all", "fresh", "aging", "stale"]),
  risk: new Set(["all", "provider-observed", "locally-derived", "feed-observed-processed", "unavailable", "synthetic"]),
  watchlist: new Set(["all", "watched"])
});

export const defaultPreferences = () => ({ schemaVersion: PREFERENCE_SCHEMA_VERSION, watchedMints: [], presets: [] });

export function normalizeFilterState(value = {}) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const search = typeof candidate.search === "string"
    ? candidate.search.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80)
    : "";
  return {
    search,
    lens: allowedFilters.lens.has(candidate.lens) ? candidate.lens : "radar",
    freshness: allowedFilters.freshness.has(candidate.freshness) ? candidate.freshness : "all",
    risk: allowedFilters.risk.has(candidate.risk) ? candidate.risk : "all",
    watchlist: allowedFilters.watchlist.has(candidate.watchlist) ? candidate.watchlist : "all"
  };
}

export function normalizePreferences(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== PREFERENCE_SCHEMA_VERSION) {
    if (strict) throw new TypeError(`preferences must use schema version ${PREFERENCE_SCHEMA_VERSION}`);
    return defaultPreferences();
  }
  const watchedMints = [...new Set((Array.isArray(value.watchedMints) ? value.watchedMints : [])
    .filter((mint) => typeof mint === "string" && PUBLIC_MINT.test(mint)))].slice(0, WATCHLIST_LIMIT);
  const presets = [];
  const ids = new Set();
  for (const candidate of Array.isArray(value.presets) ? value.presets : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || presets.length >= PRESET_LIMIT) continue;
    const id = typeof candidate.id === "string" && /^[a-z0-9-]{1,48}$/.test(candidate.id) ? candidate.id : null;
    const name = typeof candidate.name === "string"
      ? candidate.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 32)
      : "";
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    presets.push({ id, name, filters: normalizeFilterState(candidate.filters) });
  }
  return { schemaVersion: PREFERENCE_SCHEMA_VERSION, watchedMints, presets };
}

export function readPreferences(storage) {
  try {
    if (!storage || typeof storage.getItem !== "function") throw new TypeError("storage is unavailable");
    const raw = storage.getItem(PREFERENCE_KEY);
    return { preferences: raw ? normalizePreferences(JSON.parse(raw)) : defaultPreferences(), available: true };
  } catch {
    return { preferences: defaultPreferences(), available: false };
  }
}

export function writePreferences(storage, value) {
  try {
    if (!storage || typeof storage.setItem !== "function") throw new TypeError("storage is unavailable");
    const normalized = normalizePreferences(value, { strict: true });
    storage.setItem(PREFERENCE_KEY, JSON.stringify(normalized));
    return { preferences: normalized, available: true };
  } catch {
    return { preferences: normalizePreferences(value), available: false };
  }
}
