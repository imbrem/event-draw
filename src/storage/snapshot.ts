import { insertRow, transaction, type SqlDatabase } from './sql.ts';
import { requireSchemaIdentity } from './schema.ts';
import { recordEvent } from './events.ts';
import { MUTABLE_TABLES } from './identity.ts';
import { clearNotebookRows } from './notebooks.ts';

export interface SnapshotOptions {
  drawnOnly?: boolean;
  includeBlobs?: boolean;
}
/** A baseline replaces history while retaining identities and baked rendering. */
export function snapshotNotebook(
  source: SqlDatabase,
  target: SqlDatabase,
  options: SnapshotOptions = {},
): void {
  if (source === target) throw new Error('Snapshot requires a separate target database');
  transaction(target, () => {
    clearNotebookRows(target);
    for (const table of ['notebook_imports', 'notebook_metadata'])
      for (const row of source.all('SELECT * FROM ' + table)) insertRow(target, table, row);
    const objectView = options.drawnOnly ? 'drawn_objects' : 'visible_objects',
      boxView = options.drawnOnly ? '(SELECT * FROM active_boxes WHERE 0)' : 'active_boxes';
    const pageQuery = 'SELECT * FROM current_pages' + (options.drawnOnly ? ' WHERE deleted=0' : '');
    const refs = `SELECT source_hash AS hash FROM (${pageQuery}) WHERE source_hash IS NOT NULL UNION SELECT json_extract(data_json,'$.hash') FROM ${objectView} WHERE format='image/asset'${options.drawnOnly ? '' : ' UNION SELECT pdf_hash FROM current_documents WHERE pdf_hash IS NOT NULL'}`;
    const documents = source
      .all('SELECT * FROM current_documents ORDER BY id')
      .map((row) => (options.drawnOnly ? { ...row, pdf_hash: null } : row));
    for (const row of source.all('SELECT * FROM asset_refs WHERE hash IN (' + refs + ')'))
      insertRow(target, 'asset_refs', row);
    const hasBlobs = source.all("SELECT name FROM sqlite_schema WHERE name='blobs' AND type='table'").length;
    if (options.includeBlobs !== false && hasBlobs)
      for (const row of source.all('SELECT * FROM blobs WHERE hash IN (' + refs + ')'))
        insertRow(target, 'blobs', row);
    for (const row of documents) insertRow(target, 'documents', row);
    for (const row of source.all(pageQuery + ' ORDER BY id')) insertRow(target, 'pages', row);
    const required = options.drawnOnly
      ? 'SELECT id FROM visible_shapes'
      : `SELECT id FROM visible_shapes UNION
        SELECT s.shape_id FROM object_sources s JOIN ${objectView} o ON o.id = s.object_id UNION
        SELECT s.shape_id FROM box_shapes s JOIN ${boxView} b ON b.id = s.box_id UNION
        SELECT json_extract(j.value, '$[0]') FROM ${boxView} b JOIN detection_runs r ON r.id = b.run_id, json_each(r.input_key) j`;
    const queries: [string, string][] = [
      [
        'capture_sessions',
        `SELECT DISTINCT c.* FROM capture_sessions c JOIN stroke_events r ON r.capture_session_id = c.id
          JOIN ink_outputs o ON o.raw_stroke_id = r.id JOIN shapes s ON s.output_id = o.id WHERE s.id IN (${required})`,
      ],
      [
        'stroke_events',
        `SELECT DISTINCT r.* FROM stroke_events r JOIN ink_outputs o ON o.raw_stroke_id = r.id JOIN shapes s ON s.output_id = o.id WHERE s.id IN (${required})`,
      ],
      ['styles', 'SELECT DISTINCT t.* FROM styles t JOIN visible_shapes v ON v.style_id = t.id'],
      [
        'ink_policies',
        `SELECT DISTINCT p.* FROM ink_policies p JOIN ink_outputs o ON o.policy_id = p.id JOIN shapes s ON s.output_id = o.id WHERE s.id IN (${required})`,
      ],
      [
        'ink_outputs',
        `SELECT DISTINCT o.* FROM ink_outputs o JOIN shapes s ON s.output_id = o.id WHERE s.id IN (${required})`,
      ],
      ['shapes', `SELECT * FROM shapes WHERE id IN (${required})`],
      [
        'object_contents',
        `SELECT DISTINCT c.* FROM object_contents c JOIN ${objectView} v ON v.content_id = c.id`,
      ],
      ['page_objects', `SELECT o.* FROM page_objects o JOIN ${objectView} v ON v.id = o.id`],
      [
        'object_sources',
        `SELECT s.* FROM object_sources s JOIN ${objectView} v ON v.id = s.object_id${options.drawnOnly ? ' WHERE 0' : ''}`,
      ],
      [
        'detector_policies',
        `SELECT DISTINCT p.* FROM detector_policies p JOIN ${boxView} b ON b.policy_id = p.id`,
      ],
    ];
    for (const [table, sql] of queries) for (const row of source.all(sql)) insertRow(target, table, row);
    for (const run of source.all(
      `SELECT DISTINCT r.* FROM detection_runs r JOIN ${boxView} b ON b.run_id = r.id`,
    ))
      insertRow(target, 'detection_runs', { ...run, input_event_id: null });
    for (const box of source.all(`SELECT b.* FROM detected_boxes b JOIN ${boxView} v ON v.id = b.id`))
      insertRow(target, 'detected_boxes', box);
    for (const row of source.all(`SELECT s.* FROM box_shapes s JOIN ${boxView} b ON b.id = s.box_id`))
      insertRow(target, 'box_shapes', row);
    for (const table of MUTABLE_TABLES)
      for (const row of source.all(
        'SELECT * FROM object_ids WHERE kind=? AND local_id IN (SELECT id FROM ' + table + ')',
        [table],
      ))
        if (target.all('SELECT id FROM ' + table + ' WHERE id=?', [row.local_id]).length)
          insertRow(target, 'object_ids', row);
    for (const row of source.all('SELECT * FROM object_ids WHERE local_id IS NULL'))
      insertRow(target, 'object_ids', row);
    const baseline = recordEvent(target, 'history.baseline', { data: { schema: requireSchemaIdentity(source) } });
    for (const { app_event_id: _id, ...row } of source.all(
      'SELECT * FROM latest_shape_states WHERE visible=1 AND shape_id IN (SELECT id FROM visible_shapes)',
    ))
      insertRow(target, 'app_event_shapes', { app_event_id: baseline, ...row });
    for (const { id, ...row } of documents)
      insertRow(target, 'app_event_documents', { app_event_id: baseline, document_id: id, ...row });
    for (const { id, ...row } of source.all(pageQuery))
      insertRow(target, 'app_event_pages', { app_event_id: baseline, page_id: id, ...row });
    const objects = source.all('SELECT * FROM ' + objectView + ' ORDER BY paint_order,id');
    const boxes = source.all('SELECT * FROM ' + boxView + ' ORDER BY id');
    for (const { app_event_id: _id, ...row } of source.all(
      'SELECT * FROM latest_object_states WHERE object_id IN (SELECT id FROM ' + objectView + ')',
    ))
      insertRow(target, 'app_event_objects', { app_event_id: baseline, ...row });
    for (const box of boxes)
      insertRow(target, 'app_event_boxes', { app_event_id: baseline, box_id: box.id, active: 1 });
    if (
      JSON.stringify(source.all('SELECT * FROM visible_shapes ORDER BY paint_order,id')) !==
        JSON.stringify(target.all('SELECT * FROM visible_shapes ORDER BY paint_order,id')) ||
      JSON.stringify(objects) !==
        JSON.stringify(target.all('SELECT * FROM visible_objects ORDER BY paint_order,id')) ||
      JSON.stringify(boxes) !== JSON.stringify(target.all('SELECT * FROM active_boxes ORDER BY id'))
    ) {
      throw new Error('Snapshot validation failed: rendered state or linked objects changed');
    }
    for (const row of source.all('SELECT * FROM sqlite_sequence')) {
      if (target.all('SELECT name FROM sqlite_sequence WHERE name=?', [row.name]).length)
        target.exec('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?', [row.seq, row.name]);
      else insertRow(target, 'sqlite_sequence', row);
    }
  });
}
