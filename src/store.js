import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

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
    `);
    this.upsertStmt = this.db.prepare(`INSERT INTO tokens (mint,payload,created_at,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`);
    this.eventStmt = this.db.prepare("INSERT INTO events (kind,mint,payload,created_at) VALUES (?,?,?,?)");
    this.alertStmt = this.db.prepare("INSERT INTO alerts (level,title,message,mint,created_at) VALUES (?,?,?,?,?)");
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
  tokens(limit = 100) {
    return this.db.prepare("SELECT payload FROM tokens ORDER BY updated_at DESC LIMIT ?").all(limit).map((row) => JSON.parse(row.payload));
  }
  token(mint) {
    const row = this.db.prepare("SELECT payload FROM tokens WHERE mint=?").get(mint);
    return row ? JSON.parse(row.payload) : null;
  }
  alerts(limit = 30) {
    return this.db.prepare("SELECT level,title,message,mint,created_at AS createdAt FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
  }
  count() { return this.db.prepare("SELECT count(*) AS count FROM tokens").get().count; }
  countSince(iso) { return this.db.prepare("SELECT count(*) AS count FROM tokens WHERE created_at >= ?").get(iso).count; }
}
