import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './helpers.ts';
import { textRenderers } from '../src/text.ts';

test('text revisions, clearing and undo use the shared stream with page isolation and deduplication', () => {
  const d = database(), compact = database();
  try {
    d.journal.addPage(1, 1, 500, 500);
    d.journal.setText(1, 'markdown', '# First $x=5$');
    const first = d.journal.state().texts[0];
    d.journal.setText(1, 'markdown', '# First $x=5$');
    assert.equal(d.journal.state().eventCount, 2); // add page + one text event
    d.journal.setText(2, 'markdown', 'Other page');
    d.journal.setText(1, 'markdown', 'Revision');
    d.journal.setText(1, 'markdown', '');
    assert.deepEqual(d.journal.state().texts.map((t) => t.page_id), [2]);
    d.journal.undo(1); assert.equal(d.journal.state().texts[0].source, 'Revision');
    d.journal.undo(1); assert.deepEqual(d.journal.state().texts[0], first);
    assert.equal(d.journal.state().texts[1].source, 'Other page');
    compact.db.exec('DELETE FROM capture_sessions'); d.journal.snapshotInto(compact.db);
    assert.deepEqual(compact.journal.state().texts, d.journal.state().texts);
    assert.equal(compact.db.all('SELECT * FROM text_contents').length, 2);
    assert.deepEqual(compact.db.all('PRAGMA foreign_key_check'), []);
    compact.journal.setText(1, 'markdown', 'New'); compact.journal.undo(1);
    assert.deepEqual(compact.journal.state().texts[0], first);
    d.journal.setText(1, 'future/typst', '= Heading');
    assert.equal(d.journal.state().texts[0].format, 'future/typst');
    assert.throws(() => d.journal.setText(99, 'markdown', 'Missing page'), /Page does not exist/);
    assert.throws(() => d.journal.setText(1, 'markdown', 'x'.repeat(200_001)), /200,000/);
    assert.equal(d.journal.state().rawCount, 0);
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
