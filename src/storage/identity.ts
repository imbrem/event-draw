import { insertRow, scalar, transaction, type SqlDatabase } from './sql.ts';

export interface GlobalObjectId {
  notebook: string;
  timestampUs: number;
}
export const MUTABLE_TABLES = ['documents', 'pages', 'shapes', 'page_objects'] as const;
export type MutableTable = (typeof MUTABLE_TABLES)[number];

/** One writer allocates logical microseconds, even during bursts or clock rollback. */
export function identifyObject(db: SqlDatabase, kind: MutableTable, localId: number): number {
  return transaction(db, () => {
    const existing = db.all('SELECT id FROM object_ids WHERE kind=? AND local_id=?', [kind, localId])[0];
    if (existing) return Number(existing.id);
    const metadata = db.all('SELECT * FROM notebook_metadata')[0];
    if (!metadata) throw new Error('Notebook identity is not initialized');
    const timestamp = Math.max(Date.now() * 1000, Number(metadata.last_timestamp_us) + 1);
    if (!Number.isSafeInteger(timestamp)) throw new Error('Object clock exceeds the safe integer range');
    db.exec('UPDATE notebook_metadata SET last_timestamp_us=? WHERE id=1', [timestamp]);
    insertRow(db, 'object_ids', {
      import_id: metadata.self_import_id,
      timestamp_us: timestamp,
      kind,
      local_id: localId,
    });
    return scalar(db, 'SELECT last_insert_rowid()');
  });
}

export function globalObjectId(db: SqlDatabase, kind: MutableTable, localId: number): GlobalObjectId {
  const row = db.all(
    'SELECT n.uuid,o.timestamp_us FROM object_ids o JOIN notebook_imports n ON n.id=o.import_id WHERE o.kind=? AND o.local_id=?',
    [kind, localId],
  )[0];
  if (!row) throw new Error('Object identity not found');
  return { notebook: String(row.uuid), timestampUs: Number(row.timestamp_us) };
}

/** Foreign references need no materialized page/document in this notebook. */
export function referenceObject(db: SqlDatabase, identity: GlobalObjectId, kind: string): number {
  if (
    !/^[0-9a-f]{64}$/.test(identity.notebook) ||
    !Number.isSafeInteger(identity.timestampUs) ||
    identity.timestampUs <= 0 ||
    !kind
  )
    throw new Error('Invalid global object identity');
  return transaction(db, () => {
    db.exec('INSERT OR IGNORE INTO notebook_imports(uuid) VALUES(?)', [identity.notebook]);
    const namespace = scalar(db, 'SELECT id FROM notebook_imports WHERE uuid=?', [identity.notebook]);
    // A self-reference can arrive from a filtered export before its local object.
    db.exec(
      'UPDATE notebook_metadata SET last_timestamp_us=max(last_timestamp_us,?) WHERE self_import_id=?',
      [identity.timestampUs, namespace],
    );
    const existing = db.all('SELECT id,kind FROM object_ids WHERE import_id=? AND timestamp_us=?', [
      namespace,
      identity.timestampUs,
    ])[0];
    if (existing) {
      if (existing.kind !== kind) throw new Error('Conflicting object kind');
      return Number(existing.id);
    }
    insertRow(db, 'object_ids', {
      import_id: namespace,
      timestamp_us: identity.timestampUs,
      kind,
      local_id: null,
    });
    return scalar(db, 'SELECT last_insert_rowid()');
  });
}

/** Notebook creation is distinct from app opening; reopening preserves this ID. */
export function initializeIdentity(db: SqlDatabase): boolean {
  if (db.all('SELECT id FROM notebook_metadata').length) return false;
  const uuid = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  insertRow(db, 'notebook_imports', { uuid });
  insertRow(db, 'notebook_metadata', {
    id: 1,
    self_import_id: scalar(db, 'SELECT last_insert_rowid()'),
    created_at: new Date().toISOString(),
    last_timestamp_us: 0,
  });
  for (const table of MUTABLE_TABLES)
    for (const row of db.all('SELECT id FROM ' + table)) identifyObject(db, table, Number(row.id));
  return true;
}
