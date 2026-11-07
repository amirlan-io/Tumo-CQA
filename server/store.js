import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind, parent_id);`);
  return {
    db,
    add(kind, body, parent = null) {
      const row = { ...body, id: randomUUID(), created_at: new Date().toISOString() };
      db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?)')
        .run(row.id, kind, parent, JSON.stringify(row), row.created_at);
      return row;
    },
    get(kind, id) {
      const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
      return row ? JSON.parse(row.body) : null;
    },
    list(kind) {
      return db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind)
        .map(row => JSON.parse(row.body));
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
