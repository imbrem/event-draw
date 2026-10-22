import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture } from './helpers.ts';
import { identifyPdf } from '../src/pdf/source.ts';

test('document names and content IDs are separate; import deduplicates without losing annotations', async () => {
  const d = database();
  try {
    assert.equal(d.journal.state().documents[0].name, '');
    const bytes = new TextEncoder().encode('test PDF bytes'), hash = await identifyPdf(bytes);
    const input = { bytes, hash, name: 'Paper', pages: [{ width: 600, height: 800 }, { width: 840, height: 500 }] };
    const state = d.journal.importPdf(input), document = state.documents.at(-1)!;
    const pages = state.pages.filter((p) => p.document_id === document.id);
    assert.deepEqual(pages.map((p) => [p.page_number, p.source_page, p.width, p.height]), [[1, 1, 600, 800], [2, 2, 840, 500]]);
    d.journal.gesture(gesture([[10, 20], [100, 20]], 'pen', pages[0].id), d.sessionId);
    d.journal.renameDocument(document.id, 'Renamed');
    const before = d.journal.state();
    assert.deepEqual(d.journal.importPdf({ ...input, name: 'Other name' }), before);
    assert.deepEqual(d.journal.readPdf(hash), bytes);
    assert.throws(() => d.journal.readPdf('missing'), /not found/);
    assert.throws(() => d.journal.renameDocument(1, 'Renamed'), /already in use/);
    assert.throws(() => d.journal.renameDocument(1, 'bad/name'), /cannot contain/);
    d.journal.addPage(document.id, pages[0].id, 100, 100);
    d.journal.undo(pages[0].id);
    assert.deepEqual(d.journal.state().pages.filter((p)=>p.document_id===document.id),pages);
    d.journal.changePage(pages[0].id, 'delete');
    d.journal.undo(pages[1].id);
    assert.deepEqual(d.journal.visible(pages[0].id),before.shapes);
    assert.deepEqual(Object.keys(d.journal.browse('assets').rows[0]), ['hash', 'media_type', 'byte_length']);
  } finally { d.close(); }
});

test('blank page insertion, ordering and deletion preserve stable shape/page identities', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[10, 20], [100, 20]]), d.sessionId);
    d.journal.addPage(1, 1, 400, 300);
    d.journal.addPage(1, 1, null, null);
    assert.deepEqual(d.journal.state().pages.map((p) => [p.id, p.page_number]), [[1, 1], [3, 2], [2, 3]]);
    d.journal.changePage(1, 'later');
    const original = d.journal.visible();
    assert.deepEqual(d.journal.state().pages.map((p) => p.id), [3, 1, 2]);
    assert.equal(original[0].page_id, 1);
    d.journal.changePage(1, 'delete');
    assert.equal(d.journal.visible().length, 0);
    assert.deepEqual(d.journal.state().pages.map((p) => [p.id, p.page_number]), [[3, 1], [2, 2]]);
    assert.equal(d.journal.state().rawCount, 1);
    assert.throws(() => d.journal.gesture(gesture([[1, 2]]), d.sessionId), /Page does not exist/);
    const other = d.journal.createDocument('Notes').documents.at(-1)!;
    const otherPage = d.journal.state().pages.find((p) => p.document_id === other.id)!;
    assert.throws(() => d.journal.addPage(1, otherPage.id, 100, 100), /does not belong/);
    assert.throws(() => d.journal.changePage(otherPage.id, 'delete'), /at least one/);
    d.journal.createDocument('Notes');
    assert.equal(d.journal.state().documents.at(-1)!.name, 'Notes 2');
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); }
});

test('snapshot retains byte-identical PDF assets, names, page topology and visible annotations', async () => {
  const source = database(), target = database();
  try {
    const bytes = new Uint8Array([0, 255, 10, 37, 42]);
    const hash = await identifyPdf(bytes);
    source.journal.importPdf({ bytes, hash, name: 'PDF', pages: [{ width: 600, height: 800 }] });
    source.journal.gesture(gesture([[10, 20], [100, 20]], 'pen', 2), source.sessionId);
    source.journal.clear(2); source.journal.undo(2);
    source.journal.addPage(1, 1, 300, 400);
    source.journal.changePage(1, 'delete');
    source.journal.snapshotInto(target.db);
    for (const table of ['assets', 'documents', 'pages', 'visible_shapes']) {
      assert.deepEqual(target.db.all('SELECT * FROM ' + table), source.db.all('SELECT * FROM ' + table));
    }
    assert.equal(target.journal.state().eventCount, 1);
    assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), []);
    target.journal.gesture(gesture([[2, 3]], 'pen', 2), target.sessionId);
    assert.equal(target.journal.visible().length, 2);
  } finally { source.close(); target.close(); }
});
