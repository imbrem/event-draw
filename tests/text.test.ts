import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, note, gesture } from './helpers.ts';
import { textRenderers } from '../src/text.ts';

test('multiple page objects share immutable content while placement, linked notes, deletion and undo remain independent', () => {
  const d = database(), compact = database();
  try {
    d.journal.addPage(1, 1, 500, 500);
    d.journal.setObject(note('# First $x=5$'));
    const first = d.journal.state().objects[0];
    d.journal.setObject(note('# First $x=5$', 1, first.id));
    assert.equal(d.journal.state().eventCount, 4);
    d.journal.setObject(note('# First $x=5$', 1, undefined, true));
    const onPage = d.journal.state().objects[1];
    assert.equal(first.content_id, onPage.content_id);
    assert.equal(onPage.rendered, 1); assert.equal(first.rendered, 0);
    d.journal.setObject(note('Other page', 2));
    d.journal.setObject({ ...note('Revision', 1, first.id), x: 150, rotation: .5 });
    d.journal.deleteObject(1, first.id);
    assert.equal(d.journal.state().objects.length, 2);
    d.journal.undo(1); assert.equal(JSON.parse(d.journal.state().objects[0].data_json).source, 'Revision');
    d.journal.undo(1); assert.deepEqual(d.journal.state().objects[0], first);
    assert.equal(d.journal.state().objects[2].page_id, 2); d.journal.snapshotInto(compact.db);
    assert.deepEqual(compact.journal.state().objects, d.journal.state().objects);
    assert.equal(compact.db.all('SELECT * FROM object_contents').length, 2);
    assert.deepEqual(compact.db.all('PRAGMA foreign_key_check'), []);
    compact.journal.setObject(note('New', 1, first.id)); compact.journal.undo(1);
    assert.deepEqual(compact.journal.state().objects[0], first);
    d.journal.setObject({ ...note('= Heading'), format: 'future/typst' });
    assert.equal(d.journal.state().objects.at(-1)!.format, 'future/typst');
    assert.throws(() => d.journal.setObject(note('Missing page', 99)), /Page does not exist/);
    assert.throws(() => d.journal.setObject(note('x'.repeat(1_000_001))), /1,000,000/);
    assert.throws(() => d.journal.setObject({ ...note('Bad'), width: -1 }), /placement/);
    assert.equal(d.journal.state().rawCount, 0);
  } finally { d.close(); compact.close(); }
});

test('content provenance retains deleted source geometry through compaction without rendering it', () => {
  const d = database(), compact = database();
  try {
    d.journal.gesture(gesture([[10, 20], [30, 40]]), d.sessionId);
    d.journal.setObject({ ...note('x = 5'), format: 'math/latex', sourceShapeIds: [1] });
    d.journal.deleteShapes(1, [1]);
    assert.equal(d.journal.visible().length, 0); d.journal.snapshotInto(compact.db);
    assert.equal(compact.journal.visible().length, 0); assert.equal(compact.journal.state().rawCount, 1);
    assert.deepEqual(compact.db.all('SELECT * FROM object_sources'), d.db.all('SELECT * FROM object_sources'));
    assert.deepEqual(compact.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); compact.close(); }
});

test('Markdown with inline math preserves code/escapes and treats scripts, links and TeX as untrusted text', () => {
  const render = textRenderers.get('markdown')!;
  const output = render('# Heading\n**Bold** and $x^2$ and `$literal$` and \\$5\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://example.com/a.png)\n\n$\\href{javascript:alert(1)}{click}$');
  assert.match(output, /<h1>Heading<\/h1>/); assert.match(output, /<strong>Bold<\/strong>/);
  assert.match(output, /class="katex"/); assert.match(output, /<code>\$literal\$<\/code>/);
  assert.match(output, /and \$5/); assert.match(output, /&lt;script&gt;/);
  assert.doesNotMatch(output, /<script|href="javascript:|<img/);
  assert.match(render('[safe](https://example.com)'), /rel="noopener noreferrer"/);
});
