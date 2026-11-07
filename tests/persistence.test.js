import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
test('SQLite preserves conversations versions cache and decisions across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tumo-test-'));
  try {
    let store = createStore(join(dir, 'test.sqlite'));
    const kinds = ['conversation', 'checklist_version', 'evaluation', 'appeal', 'decision', 'ai_cache'];
    const rows = kinds.map(kind => store.add(kind, { marker: kind }));
    store.db.close();
    store = createStore(join(dir, 'test.sqlite'));
    try {
      kinds.forEach((kind, i) => assert.equal(store.get(kind, rows[i].id).marker, kind));
      assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally { store.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
