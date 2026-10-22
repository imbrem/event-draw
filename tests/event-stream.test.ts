import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, note } from './helpers.ts';
import { globalObjectId, identifyObject, referenceObject } from '../src/storage/identity.ts';
import {
  collectNotebookRecords,
  exportEventStream,
  reconstructEventStream,
  reconstructNotebookRecords,
  notebookRecordFormat,
} from '../src/storage/event-stream.ts';
import { jsonlCodec } from '../src/streams.ts';

test('notebook and mutable identities survive reopen, rollback, foreign references and compaction', () => {
  const source = database(),
    target = database();
  try {
    const metadata = source.db.all('SELECT * FROM notebook_metadata')[0];
    assert.match(String(source.db.all('SELECT uuid FROM notebook_imports')[0].uuid), /^[a-f0-9]{64}$/);
    source.journal.startSession({
      startedAt: 'later',
      source: 'test',
      timeOriginMs: 10,
      userAgent: '',
      devicePixelRatio: 1,
      capabilities: {},
    });
    assert.deepEqual(source.db.all('SELECT * FROM notebook_metadata')[0], metadata);
    assert.equal(source.db.all("SELECT * FROM app_events WHERE kind='app.open'").length, 2);
    source.journal.createDocument('Work');
    source.journal.setObject(note('hello', 1, undefined, true));
    source.journal.gesture(
      gesture([
        [1, 2],
        [20, 40],
      ]),
      source.sessionId,
    );
    const shape = globalObjectId(source.db, 'shapes', 1);
    const ids = source.db.all('SELECT * FROM object_ids ORDER BY id');
    assert.ok(ids.every((row, i) => !i || Number(row.timestamp_us) > Number(ids[i - 1].timestamp_us)));
    assert.equal(identifyObject(source.db, 'shapes', 1), Number(ids.at(-1)!.id));
    const foreign = globalObjectId(target.db, 'pages', 1);
    const ref = referenceObject(source.db, foreign, 'pages');
    assert.equal(referenceObject(source.db, foreign, 'pages'), ref);
    assert.notEqual(foreign.notebook, shape.notebook);
    source.journal.snapshotInto(target.db, { drawnOnly: true });
    assert.deepEqual(globalObjectId(target.db, 'shapes', 1), shape);
    assert.deepEqual(
      target.db.all('SELECT * FROM notebook_metadata'),
      source.db.all('SELECT * FROM notebook_metadata'),
    );
    assert.equal(target.db.all('SELECT * FROM object_ids WHERE local_id IS NULL').length, 1);
    assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), []);
  } finally {
    source.close();
    target.close();
  }
});

test('typed JSONL includes raw/processed traces, clocks, blobs, identities and edit effects with increasing IDs', () => {
  const source = database(),
    target = database();
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    source.journal.importPdf({
      hash: 'sha256:' + 'a'.repeat(64),
      bytes,
      name: 'Source',
      pages: [{ width: 100, height: 200 }],
    });
    source.journal.renameDocument(1, 'Math');
    source.journal.setObject(note('$x=5$', 1, undefined, true));
    source.journal.gesture(
      gesture([
        [0, 50],
        [100, 50],
      ]),
      source.sessionId,
    );
    source.journal.gesture(
      gesture(
        [
          [50, 0],
          [50, 100],
        ],
        'erase-parts',
      ),
      source.sessionId,
    );
    source.journal.undo(1);
    const records = [...collectNotebookRecords(source.db)];
    assert.deepEqual(
      records.map((r) => r.id),
      records.map((_, i) => i + 1),
    );
    for (const type of [
      'trace.raw',
      'trace.processed',
      'capture.clock',
      'content.bytes',
      'object.identity',
      'app.edit',
    ])
      assert.ok(
        records.some((r) => r.type === type),
        type,
      );
    assert.ok(records.every((r) => !('previous_event' in r)));
    const lines = [...exportEventStream(source.db)];
    const report = reconstructEventStream(lines, target.db);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.missingLinks, 0);
    assert.deepEqual(target.journal.state(), source.journal.state());
    for (const table of [
      'stroke_events',
      'ink_outputs',
      'app_events',
      'object_ids',
      'capture_sessions',
      'blobs',
      'detection_runs',
    ])
      assert.deepEqual(
        target.db.all('SELECT * FROM ' + table),
        source.db.all('SELECT * FROM ' + table),
        table,
      );
  } finally {
    source.close();
    target.close();
  }
});

test('partial replay reports missing dependencies, preserves remaining ink and never reuses allocated IDs', () => {
  const source = database(),
    target = database();
  try {
    source.journal.gesture(
      gesture([
        [10, 20],
        [30, 40],
      ]),
      source.sessionId,
    );
    source.journal.gesture(
      gesture([
        [50, 60],
        [70, 80],
      ]),
      source.sessionId,
    );
    const records = [...collectNotebookRecords(source.db)];
    const missing = records.find((r) => r.type === 'trace.raw')!.id;
    const report = reconstructNotebookRecords(
      records.filter((r) => r.id !== missing),
      target.db,
    );
    assert.ok(report.skipped.length > 0);
    assert.deepEqual(
      target.journal.visible().map((s) => s.raw_stroke_id),
      [2],
    );
    assert.equal(target.journal.state().rawCount, 1);
    const timestamp = target.db.all('SELECT last_timestamp_us FROM notebook_metadata')[0].last_timestamp_us;
    target.journal.gesture(
      gesture([
        [100, 20],
        [130, 40],
      ]),
      source.sessionId,
    );
    assert.deepEqual(
      target.journal.visible().map((s) => s.id),
      [2, 3],
    );
    assert.ok(globalObjectId(target.db, 'shapes', 3).timestampUs > Number(timestamp));
    assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), []);
    const state = target.journal.state();
    assert.throws(
      () =>
        reconstructNotebookRecords(
          records.filter((r) => r.id !== missing),
          target.db,
          notebookRecordFormat,
          { missing: 'error', unknown: 'error' },
        ),
      /Missing event/,
    );
    assert.deepEqual(target.journal.state(), state);
  } finally {
    source.close();
    target.close();
  }
});

test('record bindings and framing compose; partial edit history uses effects and preserves standalone raw events', () => {
  const source = database(),
    target = database();
  try {
    source.journal.gesture(
      gesture([
        [0, 0],
        [10, 20],
      ]),
      source.sessionId,
    );
    source.journal.clear(1);
    const format = {
      id: 'research/wrapped-raw@1',
      bindings: notebookRecordFormat.bindings.map((b) =>
        b.table === 'stroke_events'
          ? {
              ...b,
              type: 'research/observations',
              encode: (row: Parameters<typeof b.encode>[0]) => ({ observations: row }),
              decode: (value: unknown) =>
                (value as { observations: ReturnType<typeof b.decode> }).observations,
            }
          : b,
      ),
    };
    const records = [...collectNotebookRecords(source.db, true, format)].filter(
      (r) => !(r.type === 'app.edit' && (r.data as { event: { kind: string } }).event.kind === 'page.clear'),
    );
    const report = reconstructEventStream(jsonlCodec.encode(records), target.db, jsonlCodec, format);
    assert.deepEqual(report.skipped, []);
    assert.equal(target.journal.state().rawCount, 1);
    // Clear is an effect snapshot; its absence leaves the earlier draw visible.
    assert.equal(target.journal.visible().length, 1);
    const json = [...jsonlCodec.encode(records)];
    assert.throws(() => [...jsonlCodec.decode([...json, json[1]])], /non-increasing/);
  } finally {
    source.close();
    target.close();
  }
});

test('optional blob tables, recovery allocation and self references preserve reserved identities', () => {
  const source = database(),
    target = database();
  try {
    source.journal.importPdf({
      hash: 'sha256:' + 'a'.repeat(64),
      bytes: new Uint8Array([1]),
      name: 'PDF',
      pages: [{ width: 100, height: 200 }],
    });
    source.db.exec('DROP TABLE blobs');
    const records = [...collectNotebookRecords(source.db)];
    assert.ok(!records.some((r) => r.type === 'content.bytes'));
    assert.deepEqual(reconstructNotebookRecords(records, target.db).skipped, []);
    const maximum = Math.max(...source.db.all('SELECT id FROM pages').map((r) => Number(r.id)));
    const recovery = reconstructNotebookRecords([records[0]], target.db);
    assert.equal(recovery.recoveryPage, true);
    assert.ok(target.journal.state().pages[0].id > maximum);
    const metadata = target.db.all(
      'SELECT n.uuid,m.last_timestamp_us FROM notebook_metadata m JOIN notebook_imports n ON n.id=m.self_import_id',
    )[0];
    const future = Number(metadata.last_timestamp_us) + 100_000_000;
    referenceObject(target.db, { notebook: String(metadata.uuid), timestampUs: future }, 'pages');
    const page = target.journal.state().pages[0];
    target.journal.addPage(page.document_id, page.id, 100, 200);
    const latest = target.journal.state().pages.at(-1)!;
    assert.ok(globalObjectId(target.db, 'pages', latest.id).timestampUs > future);
  } finally {
    source.close();
    target.close();
  }
});

test('strict replay rolls back invalid SQL dependencies; composable transforms replace wire payloads', async () => {
  const { createNotebookExchange } = await import('../src/storage/event-stream.ts');
  const source = database(),
    target = database();
  try {
    source.journal.gesture(
      gesture([
        [0, 0],
        [20, 30],
      ]),
      source.sessionId,
    );
    const exchange = createNotebookExchange({
      outbound: [
        function* (records) {
          for (const record of records) yield { ...record, data: { wrapped: record.data } };
        },
      ],
      inbound: [
        function* (records) {
          for (const record of records)
            yield { ...record, data: (record.data as { wrapped: unknown }).wrapped };
        },
      ],
    });
    const report = exchange.reconstruct(
      exchange.codec.decode(exchange.codec.encode(exchange.collect(source.db, true))),
      target.db,
    );
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(target.journal.state(), source.journal.state());
    const state = target.journal.state();
    const records = [...collectNotebookRecords(source.db)];
    const edit = records.find(
      (r) => r.type === 'app.edit' && (r.data as { event: { kind: string } }).event.kind === 'stroke.add',
    )!;
    (edit.data as { event: { page_id: number } }).event.page_id = 9999;
    assert.throws(
      () =>
        reconstructNotebookRecords(records, target.db, notebookRecordFormat, {
          missing: 'error',
          unknown: 'error',
        }),
      /Missing resource/,
    );
    assert.deepEqual(target.journal.state(), state);
    const partial = reconstructNotebookRecords(records, target.db);
    assert.ok(partial.skipped.some((r) => r.recordId === edit.id));
    assert.equal(target.journal.visible().length, 0);
  } finally {
    source.close();
    target.close();
  }
});

test('missing optional causal links are counted once even when resources are shared by several edits', () => {
  const source = database(),
    target = database();
  try {
    source.journal.gesture(
      gesture([
        [100, 100],
        [300, 100],
        [300, 200],
        [100, 200],
        [100, 100],
      ]),
      source.sessionId,
    );
    const records = [...collectNotebookRecords(source.db)];
    const removed = records.find(
      (r) => r.type === 'app.edit' && (r.data as { event: { kind: string } }).event.kind === 'stroke.add',
    )!;
    const sqlId = (removed.data as { event: { id: number } }).event.id;
    const runs = source.db.all('SELECT * FROM detection_runs WHERE input_event_id=?', [sqlId]).length;
    const edits = source.db.all('SELECT * FROM app_events WHERE cause_event_id=?', [sqlId]).length;
    assert.ok(runs > 0 && edits > 0);
    const report = reconstructNotebookRecords(
      records.filter((r) => r.id !== removed.id),
      target.db,
    );
    assert.equal(report.missingLinks, runs + edits);
    assert.deepEqual(report.skipped, []);
  } finally {
    source.close();
    target.close();
  }
});
