import { MUTABLE_TABLES } from './identity.ts';
import { insertRow, scalar, transaction, type SqlDatabase } from './sql.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { measuredSamples, type InkData } from '../model.ts';
import type { InkOutput } from '../ink.ts';

function definitions(db: SqlDatabase) {
  return db.all(
    "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name<>'blobs' ORDER BY type,name",
  );
}
/** Never execute schema/code from an imported notebook. Accept only our schema. */
export function validateNotebook(source: SqlDatabase, expected: SqlDatabase) {
  if (scalar(source, 'PRAGMA user_version') !== SCHEMA_VERSION)
    throw new Error('Unsupported notebook schema; expected ' + SCHEMA_VERSION);
  if (JSON.stringify(definitions(source)) !== JSON.stringify(definitions(expected)))
    throw new Error('Notebook schema differs from this app version');
  const blobDefinition = source.all("SELECT type,name,sql FROM sqlite_schema WHERE name='blobs'");
  if (
    blobDefinition.length &&
    JSON.stringify(blobDefinition) !==
      JSON.stringify(expected.all("SELECT type,name,sql FROM sqlite_schema WHERE name='blobs'"))
  )
    throw new Error('Invalid blobs table');
  if (
    source.all('PRAGMA integrity_check')[0]?.integrity_check !== 'ok' ||
    source.all('PRAGMA foreign_key_check').length
  )
    throw new Error('Notebook integrity check failed');
  if (source.all('SELECT * FROM notebook_metadata').length !== 1)
    throw new Error('Notebook identity is missing');
  const metadata = source.all('SELECT * FROM notebook_metadata')[0];
  if (
    !Number.isFinite(Date.parse(String(metadata.created_at))) ||
    scalar(source, 'SELECT coalesce(max(timestamp_us),0) FROM object_ids WHERE import_id=?', [
      metadata.self_import_id,
    ]) > Number(metadata.last_timestamp_us)
  )
    throw new Error('Invalid notebook creation time or object clock');
  for (const table of MUTABLE_TABLES)
    if (
      source.all(
        'SELECT id FROM ' +
          table +
          ' WHERE id NOT IN (SELECT local_id FROM object_ids WHERE kind=? AND local_id IS NOT NULL)',
        [table],
      ).length
    )
      throw new Error('Missing object identity: ' + table);
  if (
    source.all(
      "SELECT * FROM object_ids WHERE kind NOT IN ('documents','pages','shapes','page_objects') AND local_id IS NOT NULL",
    ).length
  )
    throw new Error('Invalid materialized object kind');
  if (!source.all('SELECT id FROM current_pages WHERE deleted=0').length)
    throw new Error('Notebook has no active pages');
  for (const page of source.all('SELECT * FROM current_pages')) {
    if (
      !Number.isSafeInteger(page.page_number) ||
      Number(page.page_number) < 1 ||
      !page.source_kind ||
      (page.kind === 'page' &&
        ![page.width, page.height].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) ||
      (page.kind !== 'page' && page.kind !== 'whiteboard')
    )
      throw new Error('Invalid notebook page geometry');
  }
  if (
    source.all(
      'SELECT document_id,page_number FROM current_pages WHERE deleted=0 GROUP BY document_id,page_number HAVING count(*)>1',
    ).length
  )
    throw new Error('Notebook page order is ambiguous');
  const counts = new Map<number, number>();
  for (const row of source.all('SELECT id,data_json FROM stroke_events')) {
    const data = JSON.parse(String(row.data_json)) as InkData;
    if (
      !Array.isArray(data.deliveries) ||
      data.deliveries.some(
        (d) =>
          !d ||
          !d.reported ||
          !Array.isArray(d.coalesced) ||
          !Array.isArray(d.predicted) ||
          !Array.isArray(d.clientToPage) ||
          d.clientToPage.length !== 6 ||
          !d.clientToPage.every(Number.isFinite),
      )
    )
      throw new Error('Invalid raw trace');
    const samples = measuredSamples(data);
    if (samples.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      throw new Error('Invalid raw coordinates');
    counts.set(Number(row.id), samples.length);
  }
  for (const output of source.all('SELECT * FROM ink_outputs')) {
    if (output.data_version !== 1) throw new Error('Unsupported processing output version');
    const geometry = JSON.parse(String(output.data_json)) as InkOutput;
    if (
      geometry.kind !== 'ink-path' ||
      !Array.isArray(geometry.points) ||
      geometry.points.some(
        (p, i) =>
          ![p.x, p.y, p.sourceIndex, p.widthFactor].every(Number.isFinite) ||
          p.widthFactor <= 0 ||
          p.widthFactor > 8 ||
          p.sourceIndex < 0 ||
          p.sourceIndex >= counts.get(Number(output.raw_stroke_id))! ||
          (i > 0 && p.sourceIndex <= geometry.points[i - 1].sourceIndex),
      )
    )
      throw new Error('Invalid processing output');
  }
  if (
    source.all(
      "SELECT s.id FROM shapes s JOIN ink_outputs o ON o.id=s.output_id WHERE s.end_index>=json_array_length(o.data_json,'$.points')",
    ).length
  )
    throw new Error('Invalid shape range');
  for (const [table, fields] of [
    ['app_event_shapes', ['offset_x', 'offset_y', 'scale', 'rotation']],
    ['app_event_objects', ['x', 'y', 'width', 'height', 'rotation']],
    ['styles', ['line_width', 'opacity']],
  ] as const)
    for (const row of source.all('SELECT ' + fields.join(',') + ' FROM ' + table))
      if (fields.some((key) => typeof row[key] !== 'number' || !Number.isFinite(row[key])))
        throw new Error('Invalid notebook placement or style');
}
/** Transactional replacement keeps the existing working notebook on any error. */
export function replaceNotebook(source: SqlDatabase, target: SqlDatabase) {
  validateNotebook(source, target);
  const tables = target
    .all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => String(r.name));
  const present = new Set(
    source.all("SELECT name FROM sqlite_schema WHERE type='table'").map((r) => String(r.name)),
  );
  transaction(target, () => {
    target.exec('PRAGMA defer_foreign_keys=ON');
    for (const table of [...tables].reverse()) target.exec('DELETE FROM ' + table);
    for (const table of tables)
      if (present.has(table))
        for (const row of source.all('SELECT * FROM ' + table)) insertRow(target, table, row);
    target.exec('DELETE FROM sqlite_sequence');
    for (const row of source.all('SELECT * FROM sqlite_sequence')) insertRow(target, 'sqlite_sequence', row);
    if (target.all('PRAGMA foreign_key_check').length)
      throw new Error('Imported notebook references missing records');
  });
}

/** Internal schema names only. Call inside a replacement transaction. */
export function clearNotebookRows(db: SqlDatabase) {
  db.exec('PRAGMA defer_foreign_keys=ON');
  const tables = db.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables.reverse()) db.exec('DELETE FROM ' + name);
  db.exec('DELETE FROM sqlite_sequence');
}
