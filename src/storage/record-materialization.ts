import { insertRow, scalar, transaction, type Row, type SqlDatabase, type SqlValue } from './sql.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { clearNotebookRows, validateNotebook } from './notebooks.ts';
import { DocumentStore } from './documents.ts';
import { recordEvent } from './events.ts';

export const EFFECTS = [
  'app_event_documents',
  'app_event_pages',
  'app_event_shapes',
  'app_event_objects',
  'app_event_boxes',
] as const;
export const RESOURCES = [
  'asset_refs',
  'blobs',
  'documents',
  'pages',
  'capture_sessions',
  'stroke_events',
  'styles',
  'ink_policies',
  'ink_outputs',
  'shapes',
  'object_contents',
  'page_objects',
  'object_sources',
  'detector_policies',
  'detection_runs',
  'detected_boxes',
  'box_shapes',
  'object_ids',
] as const;
export type EncodedRow = Record<string, string | number | null | { $bytes: string }>;
export interface Envelope {
  type: 'event';
  recordId?: number;
  event: EncodedRow;
  effects: Partial<Record<(typeof EFFECTS)[number], EncodedRow[]>>;
  records: Partial<Record<(typeof RESOURCES)[number], EncodedRow[]>>;
}
export type ReplayEnvelope = Envelope | { type: 'resources'; recordId: number; records: Envelope['records'] };
export interface Header {
  schema: number;
  metadata: Row;
  imports: Row[];
  references: Row[];
  sequences: Row[];
}
export interface ReplayReport {
  accepted: number;
  skipped: { recordId: number; reason: string }[];
  missingLinks: number;
  recoveryPage: boolean;
}

export function encode(row: Row): EncodedRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (!(value instanceof Uint8Array)) return [key, value];
      let text = '';
      for (let i = 0; i < value.length; i += 8192)
        text += String.fromCharCode(...value.subarray(i, i + 8192));
      return [key, { $bytes: btoa(text) }];
    }),
  );
}
function decode(row: EncodedRow): Row {
  if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('Expected a record');
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (
        value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        return [key, value];
      if (typeof value === 'object' && typeof value.$bytes === 'string')
        return [key, Uint8Array.from(atob(value.$bytes), (c) => c.charCodeAt(0))];
      throw new Error('Invalid record value');
    }),
  );
}
export function primaryKey(db: SqlDatabase, table: string): string[] {
  return db
    .all('PRAGMA table_info(' + table + ')')
    .filter((r) => r.pk)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}
export function foreignKeys(db: SqlDatabase, table: string) {
  return db.all('PRAGMA foreign_key_list(' + table + ')');
}

/** Fixed schema, data only. Failed envelopes roll back independently; surviving
 * complete effects determine state, rather than reinterpreting old commands. */
export function replayEnvelopes(
  header: Header,
  envelopes: Iterable<ReplayEnvelope>,
  target: SqlDatabase,
  strict: boolean,
): ReplayReport {
  if (header?.schema !== SCHEMA_VERSION || !header.metadata || !Array.isArray(header.imports))
    throw new Error('Unsupported or missing notebook metadata');
  const report: ReplayReport = { accepted: 0, skipped: [], missingLinks: 0, recoveryPage: false };
  const columns = new Map<string, string[]>(),
    primary = new Map<string, string[]>();
  for (const table of [...RESOURCES, ...EFFECTS, 'app_events', 'notebook_metadata', 'notebook_imports']) {
    columns.set(
      table,
      target.all('PRAGMA table_info(' + table + ')').map((r) => String(r.name)),
    );
    primary.set(table, primaryKey(target, table));
  }
  const put = (table: string, input: EncodedRow | Row) => {
    const row = decode(input as EncodedRow),
      expected = columns.get(table);
    if (!expected || Object.keys(row).length !== expected.length || expected.some((k) => !(k in row)))
      throw new Error('Invalid record columns: ' + table);
    const key = primary.get(table)!;
    const existing = target.all(
      'SELECT * FROM ' + table + ' WHERE ' + key.map((k) => k + '=?').join(' AND '),
      key.map((k) => row[k]),
    )[0];
    if (existing) {
      if (
        expected.some(
          (k) => JSON.stringify(encode({ value: existing[k] })) !== JSON.stringify(encode({ value: row[k] })),
        )
      )
        throw new Error('Conflicting record: ' + table);
    } else insertRow(target, table, row);
  };
  const links: { table: string; id: SqlValue; column: string; value: SqlValue }[] = [];
  const unlink = (table: string, input: EncodedRow, pending: typeof links) => {
    const row = { ...input };
    for (const column of table === 'app_events'
      ? ['cause_event_id', 'undo_of_event_id', 'redo_of_event_id']
      : ['input_event_id']) {
      if (row[column] !== null)
        pending.push({ table, id: row.id as SqlValue, column, value: row[column] as SqlValue });
      row[column] = null;
    }
    return row;
  };
  return transaction(target, () => {
    clearNotebookRows(target);
    for (const row of header.imports) put('notebook_imports', row);
    put('notebook_metadata', header.metadata);
    for (const row of header.references ?? []) put('object_ids', row);
    for (const envelope of envelopes) {
      const recordId = envelope.recordId ?? 1;
      try {
        const resourcesOnly = envelope.type === 'resources';
        if (
          (!resourcesOnly && (envelope.type !== 'event' || !envelope.event || !envelope.effects)) ||
          !envelope.records
        )
          throw new Error('Expected an event envelope');
        const pending: typeof links = [];
        transaction(target, () => {
          for (const [table, rows] of Object.entries(envelope.records)) {
            if (!(RESOURCES as readonly string[]).includes(table) || !Array.isArray(rows))
              throw new Error('Unknown resource table');
            for (const row of rows)
              put(table, table === 'detection_runs' ? unlink(table, row, pending) : row);
          }
          if (!resourcesOnly) put('app_events', unlink('app_events', envelope.event, pending));
          for (const [table, rows] of Object.entries(envelope.type === 'event' ? envelope.effects : {})) {
            if (!(EFFECTS as readonly string[]).includes(table) || !Array.isArray(rows))
              throw new Error('Unknown effect table');
            for (const row of rows) {
              if (envelope.type !== 'event' || row.app_event_id !== envelope.event.id)
                throw new Error('Effect belongs to another event');
              put(table, row);
            }
          }
          if (target.all('PRAGMA foreign_key_check').length) throw new Error('Missing resource dependency');
        });
        links.push(...pending);
        if (!resourcesOnly) report.accepted++;
      } catch (error) {
        if (strict) throw error;
        report.skipped.push({ recordId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // Effects are already materialized; missing undo/causal links are metadata gaps.
    const uniqueLinks = new Map(links.map((link) => [link.table + ':' + link.id + ':' + link.column, link]));
    for (const { table, id, column, value } of uniqueLinks.values()) {
      if (target.all('SELECT id FROM app_events WHERE id=?', [value]).length)
        target.exec('UPDATE ' + table + ' SET ' + column + '=? WHERE id=?', [value, id]);
      else report.missingLinks++;
    }
    for (const row of header.sequences ?? []) {
      if (!columns.has(String(row.name)) || !Number.isSafeInteger(row.seq) || Number(row.seq) < 0)
        throw new Error('Invalid local ID high-water mark');
      if (target.all('SELECT name FROM sqlite_sequence WHERE name=?', [row.name]).length)
        target.exec('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?', [row.seq, row.name]);
      else insertRow(target, 'sqlite_sequence', row);
    }
    const maximum = scalar(
      target,
      'SELECT coalesce(max(timestamp_us),0) FROM object_ids WHERE import_id=(SELECT self_import_id FROM notebook_metadata)',
    );
    target.exec('UPDATE notebook_metadata SET last_timestamp_us=max(last_timestamp_us,?)', [maximum]);
    const documents = new DocumentStore(target, (kind, documentId, pageId, data) =>
      recordEvent(target, kind, { documentId, pageId, data }),
    );
    if (!target.all('SELECT id FROM current_pages WHERE deleted=0').length) {
      documents.create('Recovered notebook');
      report.recoveryPage = true;
    }
    documents.syncCaches();
    validateNotebook(target, target);
    return report;
  });
}
