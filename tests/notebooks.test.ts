import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, note } from './helpers.ts';
import { replaceNotebook } from '../src/storage/notebooks.ts';
import { identifyPdf } from '../src/pdf/source.ts';
import { shapeInk } from '../src/geometry.ts';
import { InkIndex } from '../src/spatial.ts';

test('topology, names, ink and content share ordered undo/redo; branching clears redo', () => {
  const d = database();
  try {
    d.journal.gesture(
      gesture([
        [10, 20],
        [80, 20],
      ]),
      d.sessionId,
    );
    const ink = d.journal.visible();
    d.journal.addPage(1, 1, 300, 400);
    d.journal.setObject(note('second', 2));
    d.journal.renameDocument(1, 'Notebook');
    d.journal.changePage(1, 'delete');
    assert.deepEqual(
      d.journal.state().pages.map((p) => p.id),
      [2],
    );
    d.journal.undo(2);
    assert.deepEqual(d.journal.visible(), ink);
    d.journal.undo(1);
    assert.equal(d.journal.state().documents[0].name, '');
    d.journal.undo(1);
    assert.equal(d.journal.state().objects.length, 0);
    d.journal.undo(1);
    assert.deepEqual(
      d.journal.state().pages.map((p) => p.id),
      [1],
    );
    d.journal.redo(1);
    d.journal.redo(2);
    d.journal.redo(1);
    d.journal.redo(2);
    assert.deepEqual(
      d.journal.state().pages.map((p) => p.id),
      [2],
    );
    assert.equal(d.journal.state().documents[0].name, 'Notebook');
    d.journal.undo(2);
    d.journal.gesture(gesture([[10, 40]], 'pen', 1), d.sessionId);
    assert.deepEqual(d.journal.state().redoablePages, []);
    const before = d.journal.state();
    assert.deepEqual(d.journal.redo(1), before);
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally {
    d.close();
  }
});

test('transforms preserve raw and output identity; copy/paste reuses baked geometry and source clock', () => {
  const d = database(),
    other = database();
  try {
    d.journal.gesture(
      gesture([
        [10, 20],
        [80, 20],
      ]),
      d.sessionId,
    );
    const raw = d.db.all('SELECT * FROM stroke_events'),
      original = d.journal.visible()[0];
    d.journal.transformShapes(1, [original.id], {
      scale: 2,
      rotation: Math.PI / 2,
      center: { x: 10, y: 20 },
    });
    const moved = d.journal.visible()[0];
    assert.equal(moved.id, original.id);
    assert.equal(moved.output_id, original.output_id);
    assert.deepEqual(d.db.all('SELECT * FROM stroke_events'), raw);
    const points = shapeInk(moved);
    assert.ok(Math.abs(points[1].x - 10) < 1e-8);
    assert.ok(Math.abs(points[1].y - 160) < 1e-8);
    const clipboard = d.journal.copyShapes(1, [original.id]);
    d.journal.pasteShapes(1, clipboard);
    assert.equal(d.journal.state().rawCount, 1);
    assert.equal(d.journal.visible().length, 2);
    assert.equal(d.journal.visible()[1].output_id, moved.output_id);
    // Make the receiving notebook's IDs collide with unrelated captures.
    other.journal.gesture(gesture([[1, 1]]), other.sessionId);
    clipboard[0].policy.smoothing.id = 'unavailable-plugin@7';
    other.journal.pasteShapes(1, clipboard);
    const pasted = other.journal.visible().at(-1)!;
    assert.equal(pasted.output_json, moved.output_json);
    assert.equal(pasted.data_json, moved.data_json);
    assert.equal(
      other.db.all('SELECT time_origin_ms FROM capture_sessions ORDER BY id DESC LIMIT 1')[0].time_origin_ms,
      123,
    );
    const before = other.journal.state();
    assert.throws(
      () => other.journal.pasteShapes(1, [{ ...clipboard[0], shape: { ...moved, end_index: 999 } }]),
      /Invalid clipboard/,
    );
    assert.deepEqual(other.journal.state(), before);
    const index = new InkIndex(d.journal.visible());
    assert.ok(index.query({ x: 0, y: 0, width: 20, height: 200 }).has(original.id));
    assert.equal(index.query({ x: 10000, y: 10000, width: 10, height: 10 }).size, 0);
  } finally {
    d.close();
    other.close();
  }
});

test('mixed extensible page sources are journaled; optional blobs and drawn-only state roundtrip', async () => {
  const source = database(),
    target = database(),
    opened = database();
  try {
    const bytes = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>',
      ),
      hash = await identifyPdf(bytes);
    source.journal.importAsset({
      hash,
      bytes,
      name: 'Diagram',
      mediaType: 'image/svg+xml',
      width: 200,
      height: 100,
      documentId: 1,
      afterPageId: 1,
    });
    source.journal.setPageSource(1, {
      source_kind: 'map/custom@1',
      source_hash: null,
      source_page: null,
      source_json: '{"center":[0,0],"zoom":3}',
    });
    source.journal.gesture(
      gesture(
        [
          [10, 10],
          [70, 10],
        ],
        'pen',
        2,
      ),
      source.sessionId,
    );
    source.journal.setObject(note('private', 2));
    source.journal.setObject(note('shown', 2, undefined, true));
    source.journal.setObject({
      ...note('svg', 2, undefined, true),
      format: 'image/asset',
      data: { hash, mediaType: 'image/svg+xml' },
    });
    source.journal.gesture(
      gesture(
        [
          [10, 50],
          [70, 50],
        ],
        'pen',
        2,
      ),
      source.sessionId,
    );
    source.journal.setObject({ ...note('derived display', 2, undefined, true), sourceShapeIds: [2] });
    source.journal.deleteShapes(2, [2]);
    target.db.exec('DELETE FROM capture_sessions');
    source.journal.snapshotInto(target.db, { drawnOnly: true });
    assert.deepEqual(target.journal.visible(), source.journal.visible());
    assert.equal(target.journal.state().objects.length, 3);
    assert.equal(target.journal.state().rawCount, 1);
    assert.equal(target.journal.state().eventCount, 1);
    assert.deepEqual(target.journal.readPdf(hash), bytes);
    assert.equal(target.journal.state().pages[0].source_kind, 'map/custom@1');
    replaceNotebook(target.db, opened.db);
    assert.deepEqual(opened.journal.visible(), target.journal.visible());
    target.db.exec('DROP TABLE blobs');
    replaceNotebook(target.db, opened.db);
    assert.throws(() => opened.journal.readPdf(hash), /not found/);
    assert.deepEqual(opened.journal.visible(), target.journal.visible());
    const before = opened.journal.state();
    target.db.exec('CREATE TABLE blobs(hash TEXT,data TEXT)');
    assert.throws(() => replaceNotebook(target.db, opened.db), /blobs table/);
    assert.deepEqual(opened.journal.state(), before);
    target.db.exec('DROP TABLE blobs');
    target.db.exec('CREATE TRIGGER surprise AFTER INSERT ON app_events BEGIN DELETE FROM stroke_events; END');
    assert.throws(() => replaceNotebook(target.db, opened.db), /schema differs/);
    assert.deepEqual(opened.journal.state(), before);
  } finally {
    source.close();
    target.close();
    opened.close();
  }
});

test('topology projections ignore mutable caches and subsequent operations repair them', () => {
  const d = database();
  try {
    const before = d.journal.state();
    d.db.exec("UPDATE pages SET width=777; UPDATE documents SET name='cache-only'");
    assert.deepEqual(d.journal.state(), before);
    d.journal.addPage(1, 1, 300, 400);
    const pages = d.journal.state().pages;
    d.db.exec('UPDATE pages SET page_number=99,width=11');
    assert.deepEqual(d.journal.state().pages, pages);
    d.journal.changePage(2, 'earlier');
    assert.deepEqual(
      d.journal.state().pages.map((p) => [p.id, p.page_number, p.width]),
      [
        [2, 1, 300],
        [1, 2, 1000],
      ],
    );
  } finally {
    d.close();
  }
});

test('reimporting a PDF hydrates missing bytes without replacing its page identities', async () => {
  const d = database();
  try {
    const bytes = new TextEncoder().encode('PDF source'),
      hash = await identifyPdf(bytes),
      input = { bytes, hash, name: 'Paper', pages: [{ width: 600, height: 800 }] };
    d.journal.importPdf(input);
    const pages = d.journal.state().pages;
    d.db.exec('DELETE FROM blobs');
    assert.throws(() => d.journal.readPdf(hash), /not found/);
    d.journal.importPdf(input);
    assert.deepEqual(d.journal.readPdf(hash), bytes);
    assert.deepEqual(d.journal.state().pages, pages);
    assert.equal(d.journal.state().documents.length, 2);
    assert.equal(d.db.all('SELECT kind FROM app_events ORDER BY id DESC LIMIT 1')[0].kind, 'asset.embed');
  } finally {
    d.close();
  }
});
