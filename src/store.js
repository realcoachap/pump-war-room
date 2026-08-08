import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const STORE_SCHEMA_VERSION = 501;

function parsePayloadRows(rows) {
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.payload)]; } catch { return []; }
  });
}

export class Store {
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mint TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, mint TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS callouts (
        external_id TEXT PRIMARY KEY, mint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS callouts_mint_created ON callouts(mint, created_at DESC);
      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
    `);
    this.upsertStmt = this.db.prepare(`INSERT INTO tokens (mint,payload,created_at,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`);
    this.eventStmt = this.db.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)");
    this.alertStmt = this.db.prepare("INSERT INTO alerts (level,title,message,mint,created_at) VALUES (?,?,?,?,?)");
    this.calloutStmt = this.db.prepare(`INSERT INTO callouts (external_id,mint,payload,created_at)
      VALUES (?,?,?,?) ON CONFLICT(external_id) DO UPDATE SET payload=excluded.payload`);
    this.sourceCountStmts = {
      tokens: this.db.prepare(`SELECT count(*) AS count FROM tokens
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`),
      events: this.db.prepare(`SELECT count(*) AS count FROM events
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`),
      alerts: this.db.prepare(`SELECT count(*) AS count FROM alerts
        WHERE mint IN (
          SELECT mint FROM tokens
          WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?
        )`)
    };
    this.sourceTokenCountSinceStmt = this.db.prepare(`SELECT count(*) AS count FROM tokens
      WHERE created_at >= ?
        AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = ?`);
    this.deleteDemoStmts = {
      alerts: this.db.prepare(`DELETE FROM alerts
        WHERE mint IN (
          SELECT mint FROM tokens
          WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'
        )`),
      events: this.db.prepare(`DELETE FROM events
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'`),
      tokens: this.db.prepare(`DELETE FROM tokens
        WHERE CASE WHEN json_valid(payload) THEN json_extract(payload, '$.source') END = 'demo'`)
    };
  }
  upsertToken(token) {
    const now = new Date().toISOString();
    this.upsertStmt.run(token.mint, JSON.stringify(token), token.createdAt || now, now);
  }
  addEvent(kind, payload) {
    this.eventStmt.run(kind, payload.mint || null, JSON.stringify(payload), new Date().toISOString());
  }
  addAlert(alert) {
    const createdAt = alert.createdAt || new Date().toISOString();
    this.alertStmt.run(alert.level, alert.title, alert.message, alert.mint || null, createdAt);
    return { ...alert, createdAt };
  }
  upsertCallout(callout) {
    this.calloutStmt.run(callout.externalId, callout.mint, JSON.stringify(callout), callout.createdAt);
  }
  tokens(limit = 100) {
    return parsePayloadRows(this.db.prepare("SELECT payload FROM tokens ORDER BY updated_at DESC LIMIT ?").all(limit));
  }
  token(mint) {
    const row = this.db.prepare("SELECT payload FROM tokens WHERE mint=?").get(mint);
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }
  alerts(limit = 30) {
    return this.db.prepare("SELECT level,title,message,mint,created_at AS createdAt FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
  }
  callouts(limit = 50) {
    return parsePayloadRows(this.db.prepare("SELECT payload FROM callouts ORDER BY created_at DESC LIMIT ?").all(limit));
  }
  countBySource(source) {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
    return {
      tokens: this.sourceCountStmts.tokens.get(source).count,
      events: this.sourceCountStmts.events.get(source).count,
      alerts: this.sourceCountStmts.alerts.get(source).count
    };
  }
  purgeDemoData() {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const removed = {
        alerts: this.deleteDemoStmts.alerts.run().changes,
        events: this.deleteDemoStmts.events.run().changes,
        tokens: this.deleteDemoStmts.tokens.run().changes
      };
      this.db.exec("COMMIT");
      transactionStarted = false;
      return removed;
    } catch (error) {
      if (transactionStarted) {
        try { this.db.exec("ROLLBACK"); } catch {}
      }
      throw error;
    }
  }
  calloutCountSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM callouts WHERE created_at >= ?").get(iso).count; }
  count() { return this.db.prepare("SELECT count(*) AS count FROM tokens").get().count; }
  countSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM tokens WHERE created_at >= ?").get(iso).count; }
  countSinceBySource(iso, source) {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
    return this.sourceTokenCountSinceStmt.get(iso, source).count;
  }
}
