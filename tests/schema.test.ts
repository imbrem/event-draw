import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, schema } from './helpers.ts';
import { initializeSchema, resetSchema } from '../src/storage/schema.ts';

test('unknown schemas are left untouched and explicit reset rebuilds an empty notebook', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[1, 2], [3, 4]]), d.sessionId);
    d.db.exec('PRAGMA user_version = 999');
    assert.throws(() => initializeSchema(d.db, schema), /Unsupported database schema version: 999/);
    assert.equal(d.journal.state().rawCount, 1);
    resetSchema(d.db, schema);
    assert.equal(d.journal.state().rawCount, 0);
    assert.equal(d.journal.state().eventCount, 0);
    assert.equal(d.journal.state().pages.length, 1);
    assert.equal(d.db.all('PRAGMA user_version')[0].user_version, 6);
    assert.equal(d.db.all('PRAGMA foreign_keys')[0].foreign_keys, 1);
  } finally { d.close(); }
});
