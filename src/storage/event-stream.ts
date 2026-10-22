import type { SqlDatabase, SqlValue } from './sql.ts';
import { MUTABLE_TABLES } from './identity.ts';
import { requireSchemaIdentity } from './schema.ts';
import {
  RESOURCES,
  EFFECTS,
  replayEnvelopes,
  encode,
  primaryKey,
  foreignKeys,
  type EncodedRow,
  type Envelope,
  type Header,
  type ReplayEnvelope,
  type ReplayReport,
} from './record-materialization.ts';
import {
  jsonlCodec,
  pipeRecords,
  type RecordTransform,
  type StreamCodec,
  type StreamRecord,
} from '../streams.ts';
export type { ReplayReport } from './record-materialization.ts';

/** Bindings compose independently of framing (JSONL today, DASL later).
 * They deliberately target this schema; another app can supply its own source/sink. */
export interface RecordBinding {
  table: (typeof RESOURCES)[number];
  type: string;
  encode(row: EncodedRow): unknown;
  decode(data: unknown): EncodedRow;
}
function binding(table: RecordBinding['table'], type: string): RecordBinding {
  return { table, type, encode: (row) => row, decode: (data) => data as EncodedRow };
}
export const TRACE_RECORDS = [
  binding('capture_sessions', 'capture.clock'),
  binding('stroke_events', 'trace.raw'),
  binding('ink_policies', 'trace.policy'),
  binding('ink_outputs', 'trace.processed'),
  binding('shapes', 'ink.instance'),
  binding('styles', 'paint.style'),
];
export const CONTENT_RECORDS = [
  binding('asset_refs', 'content.reference'),
  binding('blobs', 'content.bytes'),
  binding('documents', 'document.seed'),
  binding('pages', 'page.seed'),
  binding('object_contents', 'object.content'),
  binding('page_objects', 'object.instance'),
  binding('object_sources', 'object.provenance'),
];
export const DETECTION_RECORDS = [
  binding('detector_policies', 'detection.policy'),
  binding('detection_runs', 'detection.run'),
  binding('detected_boxes', 'detection.box'),
  binding('box_shapes', 'detection.provenance'),
];
export const IDENTITY_RECORDS = [binding('object_ids', 'object.identity')];
export interface NotebookRecordFormat {
  id: string;
  bindings: readonly RecordBinding[];
}
export const notebookRecordFormat: NotebookRecordFormat = {
  id: 'event-draw/records@1',
  bindings: [...TRACE_RECORDS, ...CONTENT_RECORDS, ...DETECTION_RECORDS, ...IDENTITY_RECORDS],
};
export interface ReplayPolicy {
  missing: 'skip' | 'error';
  unknown: 'skip' | 'error';
  retainUnreferenced?: boolean;
}
export const partialReplay: ReplayPolicy = { missing: 'skip', unknown: 'skip', retainUnreferenced: true };

/** Replace the whole source/sink, or compose the default SQLite adapter below.
 * Installed by trusted host code, never loaded from notebook contents. */
export interface NotebookExchange {
  codec: StreamCodec;
  collect(db: SqlDatabase, includeBlobs: boolean): Iterable<StreamRecord>;
  reconstruct(records: Iterable<StreamRecord>, target: SqlDatabase): ReplayReport;
}
export function createNotebookExchange(
  options: {
    codec?: StreamCodec;
    format?: NotebookRecordFormat;
    policy?: ReplayPolicy;
    outbound?: readonly RecordTransform[];
    inbound?: readonly RecordTransform[];
  } = {},
): NotebookExchange {
  return {
    codec: options.codec ?? jsonlCodec,
    collect: (db, includeBlobs) =>
      pipeRecords(collectNotebookRecords(db, includeBlobs, options.format), options.outbound),
    reconstruct: (records, target) =>
      reconstructNotebookRecords(
        pipeRecords(records, options.inbound),
        target,
        options.format,
        options.policy,
      ),
  };
}

function bindings(format: NotebookRecordFormat) {
  const byTable = new Map(format.bindings.map((b) => [b.table, b])),
    byType = new Map(format.bindings.map((b) => [b.type, b]));
  if (
    byTable.size !== format.bindings.length ||
    byType.size !== format.bindings.length ||
    RESOURCES.some((table) => !byTable.has(table)) ||
    format.bindings.some((b) => ['notebook', 'app.edit'].includes(b.type))
  )
    throw new Error('Record bindings must uniquely cover this adapter’s resource tables');
  return { byTable, byType };
}

export function* collectNotebookRecords(
  db: SqlDatabase,
  includeBlobs = true,
  format = notebookRecordFormat,
): Generator<StreamRecord> {
  const { byTable } = bindings(format);
  const header: Header = {
    schema: requireSchemaIdentity(db),
    metadata: db.all('SELECT * FROM notebook_metadata')[0],
    imports: db.all('SELECT * FROM notebook_imports ORDER BY id'),
    references: db.all('SELECT * FROM object_ids WHERE local_id IS NULL ORDER BY id'),
    sequences: db.all('SELECT * FROM sqlite_sequence'),
  };
  if (!header.metadata) throw new Error('Notebook identity is not initialized');
  const keys = new Map(
    [...RESOURCES, 'app_events', ...EFFECTS].map((table) => [table as string, foreignKeys(db, table)]),
  );
  const primary = new Map(RESOURCES.map((table) => [table as string, primaryKey(db, table)]));
  const key = (table: string, row: EncodedRow) =>
    table + ':' + JSON.stringify(primary.get(table)!.map((k) => row[k]));
  const resources = new Map<string, { id: number; table: RecordBinding['table']; row: EncodedRow }>();
  for (const table of RESOURCES) {
    if (
      table === 'blobs' &&
      (!includeBlobs || !db.all("SELECT name FROM sqlite_schema WHERE name='blobs'").length)
    )
      continue;
    for (const input of db.all('SELECT * FROM ' + table + ' ORDER BY ' + primary.get(table)!.join(','))) {
      const row = encode(input);
      // Encode each payload once: a large PDF must not be copied for every edit.
      resources.set(key(table, row), { id: resources.size + 2, table, row });
    }
  }
  const reference = (table: string, row: EncodedRow) => resources.get(key(table, row))!.id;
  const dependencies = (table: string, row: EncodedRow) => {
    const refs = new Set<number>();
    for (const fk of keys.get(table) ?? []) {
      const value = row[String(fk.from)],
        parent = String(fk.table);
      if (value === null || !byTable.has(parent as RecordBinding['table'])) continue;
      const parentRow = db.all('SELECT * FROM ' + parent + ' WHERE ' + fk.to + '=?', [value as SqlValue])[0];
      if (parentRow) refs.add(reference(parent, encode(parentRow)));
    }
    return refs;
  };
  yield { id: 1, type: 'notebook', refs: [], data: { ...header, adapter: format.id } };
  for (const { id, table, row } of resources.values()) {
    const codec = byTable.get(table)!,
      refs = dependencies(table, row);
    if ((MUTABLE_TABLES as readonly string[]).includes(table)) {
      const identity = db.all('SELECT * FROM object_ids WHERE kind=? AND local_id=?', [
        table,
        row.id as SqlValue,
      ])[0];
      if (identity) refs.add(reference('object_ids', encode(identity)));
    }
    // Reverse provenance edges retain source assignments with their instances.
    const sources =
      table === 'page_objects'
        ? ['object_sources', 'object_id']
        : table === 'detected_boxes'
          ? ['box_shapes', 'box_id']
          : null;
    if (sources)
      for (const source of db.all('SELECT * FROM ' + sources[0] + ' WHERE ' + sources[1] + '=?', [
        row.id as SqlValue,
      ]))
        refs.add(reference(sources[0], encode(source)));
    if (table === 'detection_runs')
      for (const [shapeId] of JSON.parse(String(row.input_key))) {
        const shape = db.all('SELECT * FROM shapes WHERE id=?', [shapeId])[0];
        if (shape) refs.add(reference('shapes', encode(shape)));
      }
    yield { id, type: codec.type, refs: [...refs], data: codec.encode(row) };
  }
  let id = resources.size + 2;
  for (const event of db.all('SELECT * FROM app_events ORDER BY id')) {
    const refs = dependencies('app_events', encode(event)),
      effects: Envelope['effects'] = {};
    for (const table of EFFECTS) {
      const rows = db.all('SELECT * FROM ' + table + ' WHERE app_event_id=?', [event.id]).map(encode);
      if (rows.length) effects[table] = rows;
      for (const row of rows) for (const dependency of dependencies(table, row)) refs.add(dependency);
    }
    // Rejected inputs can have outputs without a visible geometry instance.
    if (event.raw_stroke_id !== null)
      for (const output of db.all('SELECT * FROM ink_outputs WHERE raw_stroke_id=?', [event.raw_stroke_id]))
        refs.add(reference('ink_outputs', encode(output)));
    yield { id: id++, type: 'app.edit', refs: [...refs], data: { event: encode(event), effects } };
  }
}

export function reconstructNotebookRecords(
  input: Iterable<StreamRecord>,
  target: SqlDatabase,
  format = notebookRecordFormat,
  policy: ReplayPolicy = partialReplay,
): ReplayReport {
  const { byType } = bindings(format),
    records = [...input],
    header = records[0];
  if (header?.type !== 'notebook' || (header.data as { adapter?: string })?.adapter !== format.id)
    throw new Error('Mismatched notebook record adapter');
  const resources = new Map<number, StreamRecord>(),
    edits: StreamRecord[] = [],
    skipped: ReplayReport['skipped'] = [];
  let previous = 0;
  for (const record of records) {
    if (
      !Number.isSafeInteger(record.id) ||
      record.id <= previous ||
      !Array.isArray(record.refs) ||
      record.refs.some((id) => !Number.isSafeInteger(id) || id < 1)
    )
      throw new Error('Invalid record or non-increasing stream ID');
    previous = record.id;
    if (record.type === 'app.edit') edits.push(record);
    else if (byType.has(record.type)) resources.set(record.id, record);
    else if (record !== header) {
      if (policy.unknown === 'error') throw new Error('Unknown record type: ' + record.type);
      skipped.push({ recordId: record.id, reason: 'Unknown record type: ' + record.type });
    }
  }
  const envelopes: ReplayEnvelope[] = [];
  const collect = (rootIds: Iterable<number>) => {
    const rows: Envelope['records'] = {},
      seen = new Set<number>();
    const require = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const resource = resources.get(id);
      if (!resource) throw new Error('Missing event record: ' + id);
      const codec = byType.get(resource.type)!;
      (rows[codec.table] ??= []).push(codec.decode(resource.data));
      for (const dependency of resource.refs) require(dependency);
    };
    for (const id of rootIds) require(id);
    return rows;
  };
  if (policy.retainUnreferenced !== false) {
    const valid = new Set<number>();
    for (const id of resources.keys()) {
      try {
        collect([id]);
        valid.add(id);
      } catch (error) {
        if (policy.missing === 'error') throw error;
        skipped.push({ recordId: id, reason: String(error) });
      }
    }
    envelopes.push({ type: 'resources', recordId: header.id, records: collect(valid) });
  }
  for (const edit of edits) {
    try {
      envelopes.push({
        ...(edit.data as Pick<Envelope, 'event' | 'effects'>),
        type: 'event',
        recordId: edit.id,
        records: collect(edit.refs),
      });
    } catch (error) {
      if (policy.missing === 'error') throw error;
      skipped.push({ recordId: edit.id, reason: String(error) });
    }
  }
  const report = replayEnvelopes(header.data as Header, envelopes, target, policy.missing === 'error');
  report.skipped.push(...skipped);
  return report;
}

// Convenience defaults, not a canonical wire format. Sources, bindings,
// replay policy and the framing codec can each be replaced independently.
export function exportEventStream(
  db: SqlDatabase,
  includeBlobs = true,
  codec: StreamCodec = jsonlCodec,
  format = notebookRecordFormat,
): Iterable<string> {
  return codec.encode(collectNotebookRecords(db, includeBlobs, format));
}
export function reconstructEventStream(
  lines: Iterable<string>,
  target: SqlDatabase,
  codec: StreamCodec = jsonlCodec,
  format = notebookRecordFormat,
  policy = partialReplay,
): ReplayReport {
  return reconstructNotebookRecords(codec.decode(lines), target, format, policy);
}
