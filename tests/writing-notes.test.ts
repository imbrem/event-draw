import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, note } from './helpers.ts';
import { isWritingNote, contentBottom } from '../src/note-pages.ts';
import { inkWindow } from '../src/ui/surface-layout.ts';
import { exportEventStream, reconstructEventStream } from '../src/storage/event-stream.ts';
import { InkIndex } from '../src/spatial.ts';

test('one notebook mixes growing notes, fixed pages and whiteboards; growth shares edit undo', () => {
  const d = database(),
    target = database();
  try {
    assert.ok(isWritingNote(d.journal.state().pages[0]));
    d.journal.addPage(1, 1, 595, 842);
    d.journal.addPage(1, 2, null, null);
    d.journal.gesture(
      gesture([
        [100, 1500],
        [200, 1550],
      ]),
      d.sessionId,
    );
    assert.equal(d.journal.state().pages[0].height, 2400);
    const event = d.db.all("SELECT id FROM app_events WHERE kind='stroke.add'")[0].id;
    assert.equal(
      d.db.all('SELECT height FROM app_event_pages WHERE app_event_id=? AND page_id=1', [event])[0].height,
      2400,
    );
    d.journal.undo(1);
    assert.equal(d.journal.state().pages[0].height, 1600);
    d.journal.redo(1);
    assert.equal(d.journal.state().pages[0].height, 2400);
    d.journal.gesture(
      gesture(
        [
          [0, 900],
          [100, 950],
        ],
        'pen',
        2,
      ),
      d.sessionId,
    );
    assert.equal(d.journal.state().pages[1].height, 842);
    d.journal.setObject({ ...note('Linked'), y: 20000 });
    assert.equal(d.journal.state().pages[0].height, 2400);
    d.journal.setObject({ ...note('Visible'), rendered: true, y: 2500 });
    assert.equal(d.journal.state().pages[0].height, 3200);
    d.journal.extendNote(1);
    assert.equal(d.journal.state().pages[0].height, 4000);
    reconstructEventStream([...exportEventStream(d.db)], target.db);
    assert.deepEqual(target.journal.state().pages, d.journal.state().pages);
    d.journal.snapshotInto(target.db);
    assert.deepEqual(target.journal.state().pages, d.journal.state().pages);
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally {
    d.close();
    target.close();
  }
});

test('viewport windows bound raster size and preserve page coordinates at arbitrary scroll/scale', () => {
  const viewport = { left: 0, top: 50, width: 820, height: 1000 };
  const window = inkWindow({ left: 0, top: -1590, width: 820, height: 820000 }, viewport, 1000);
  assert.deepEqual([window.left, window.top, window.width, window.height], [0, 1640, 820, 1000]);
  assert.ok(Math.abs(window.view.y - 2000) < 1e-9);
  assert.ok(Math.abs(window.view.width - 1000) < 1e-9);
  assert.ok(window.width * window.height < 1_000_000);
  const rotated = inkWindow(
    { left: -200, top: -100, width: 1180, height: 1180000 },
    { left: 0, top: 0, width: 980, height: 800 },
    1000,
  );
  assert.ok(Math.abs(rotated.view.x * 1.18 - 200) < 1e-9);
  assert.ok(Math.abs(rotated.view.y * 1.18 - 100) < 1e-9);
});

test('viewport ink queries include painted width and transformed strokes, in paint order', () => {
  const d = database();
  try {
    for (let i = 0; i < 100; i++)
      d.journal.gesture(
        gesture([
          [10, i * 100],
          [100, i * 100],
        ]),
        d.sessionId,
      );
    const shapes = d.journal.visible();
    const index = new InkIndex(shapes);
    assert.deepEqual(
      index.select({ x: 0, y: 400, width: 1000, height: 200 }).map((s) => s.id),
      [5, 6, 7],
    );
    const wide = {
      ...shapes[0],
      offset_x: 1000,
      offset_y: 300,
      line_width: 40,
      rotation: Math.PI / 2,
      scale: 2,
    };
    assert.deepEqual(new InkIndex([wide]).select({ x: 970, y: 300, width: 20, height: 100 }), [wide]);
    assert.equal(
      contentBottom(null, [{ rendered: 1, y: 100, width: 300, height: 100, rotation: Math.PI / 2 }]),
      300,
    );
  } finally {
    d.close();
  }
});
