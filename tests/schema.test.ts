import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, schema } from './helpers.ts';
import { initializeSchema, resetSchema, SCHEMA_IDENTITY, readSchemaIdentity } from '../src/storage/schema.ts';

test('unknown schemas are left untouched and explicit reset rebuilds an empty notebook', () => {
  const d = database();
  try {
    d.journal.gesture(
      gesture([
        [1, 2],
        [3, 4],
      ]),
      d.sessionId,
    );
    d.db.exec('UPDATE schema_identity SET uuid=?', ['0'.repeat(64)]);
    assert.throws(() => initializeSchema(d.db, schema), /Unsupported notebook schema: 000/);
    assert.equal(d.journal.state().rawCount, 1);
    resetSchema(d.db, schema);
    assert.equal(d.journal.state().rawCount, 0);
    assert.equal(d.journal.state().eventCount, 1);
    assert.equal(d.journal.state().pages.length, 1);
    assert.deepEqual(readSchemaIdentity(d.db), SCHEMA_IDENTITY);
    const created = d.db.all("SELECT data_json FROM app_events WHERE kind='notebook.create'")[0];
    assert.deepEqual(JSON.parse(String(created.data_json)).schema, SCHEMA_IDENTITY);
    d.db.exec("UPDATE schema_identity SET version='1.0.0'");
    assert.throws(() => initializeSchema(d.db, schema), /@1.0.0/);
    assert.equal(d.db.all('PRAGMA foreign_keys')[0].foreign_keys, 1);
  } finally {
    d.close();
  }
});

test('SQLite user_version is independent; UUID and version survive initialization and reject missing identity', () => {
  const d = database();
  try {
    d.db.exec('PRAGMA user_version=999');
    initializeSchema(d.db, schema);
    assert.deepEqual(readSchemaIdentity(d.db), SCHEMA_IDENTITY);
    d.db.exec('DROP TABLE schema_identity');
    assert.throws(() => initializeSchema(d.db, schema), /missing UUID/);
    assert.equal(d.journal.state().eventCount, 2);
  } finally {
    d.close();
  }
});
