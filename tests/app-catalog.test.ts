import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AppCatalog, APP_SCHEMA_IDENTITY, notebookMetadata } from '../src/storage/app-catalog.ts';
import { adapter, database, gesture, note } from './helpers.ts';

const metadata = {
  uuid: 'ab'.repeat(32),
  createdAt: '2026-10-20T12:00:00Z',
  editedAt: '2026-10-21T12:00:00Z',
};
test('app catalog records local names and selection independently of notebook identities', () => {
  const native = new DatabaseSync(':memory:'),
    db = adapter(native),
    catalog = new AppCatalog(db);
  try {
    const a = catalog.add('/a.sqlite3', 'Math', metadata),
      b = catalog.add('/b.sqlite3', 'Snapshot', metadata);
    assert.notEqual(a.id, b.id); // importing a snapshot never overwrites a file with the same UUID
    catalog.select(a.id);
    assert.equal(new AppCatalog(db).selected()?.id, a.id);
    const renamed = catalog.rename(a.id, '  Algebra  ');
    assert.equal(renamed.name, 'Algebra');
    assert.equal(renamed.editedAt, metadata.editedAt); // local catalog rename is not a content edit
    assert.equal(catalog.get(b.id).name, 'Snapshot');
    assert.throws(() => catalog.rename(a.id, ' '), /notebook name/);
    assert.throws(() => catalog.select(999), /not found/);
    assert.equal(catalog.selected()?.id, a.id);
    assert.equal(db.all('SELECT kind FROM catalog_events ORDER BY id').at(-1)?.kind, 'notebook.rename');
    catalog.setPreference('future-style', { color: '#123456' });
    assert.deepEqual(catalog.preference('future-style'), { color: '#123456' });
  } finally {
    native.close();
  }
});
test('catalog timestamps follow content events, excluding opens and session clocks', () => {
  const notebook = database(),
    native = new DatabaseSync(':memory:'),
    catalog = new AppCatalog(adapter(native));
  try {
    const original = notebookMetadata(notebook.db);
    const item = catalog.add('/notes.sqlite3', 'Notes', original);
    notebook.journal.startSession({
      startedAt: '2099-01-01T00:00:00Z',
      timeOriginMs: 1,
      source: 'test',
      userAgent: '',
      devicePixelRatio: 1,
      capabilities: {},
    });
    assert.deepEqual(notebookMetadata(notebook.db), original);
    notebook.journal.gesture(
      gesture([
        [1, 2],
        [3, 4],
      ]),
      notebook.sessionId,
    );
    notebook.journal.setObject(note('A note in the same notebook'));
    notebook.db.exec("UPDATE app_events SET occurred_at='2026-11-01T00:00:00Z' WHERE kind='object.add'");
    const after = notebookMetadata(notebook.db);
    assert.equal(after.uuid, original.uuid);
    assert.equal(after.createdAt, original.createdAt);
    assert.equal(after.editedAt, '2026-11-01T00:00:00Z');
    catalog.observe(item.id, after);
    assert.deepEqual(catalog.get(item.id), { ...item, ...after });
  } finally {
    notebook.close();
    native.close();
  }
});
test('unknown app schema cannot silently reset the catalog', () => {
  const native = new DatabaseSync(':memory:'),
    db = adapter(native);
  try {
    const catalog = new AppCatalog(db);
    catalog.add('/a.sqlite3', 'Keep me', metadata);
    db.exec('UPDATE app_schema_identity SET uuid=?', ['00'.repeat(32)]);
    assert.throws(() => new AppCatalog(db), /Unsupported app catalog schema/);
    assert.equal(db.all('SELECT name FROM notebooks')[0].name, 'Keep me');
    assert.notEqual(APP_SCHEMA_IDENTITY.uuid, '00'.repeat(32));
  } finally {
    native.close();
  }
});
