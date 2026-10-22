import { insertRow, scalar, transaction, type SqlDatabase } from './sql.ts';

/** Local handles identify files; imported snapshots may share a notebook UUID. */
export interface NotebookEntry {
  id: number;
  path: string;
  name: string;
  uuid: string;
  createdAt: string;
  editedAt: string;
}
export interface NotebookMetadata {
  uuid: string;
  createdAt: string;
  editedAt: string;
}
export const APP_SCHEMA_IDENTITY = {
  uuid: 'bcf538b3c8c46acc3682933dd9380d24c605cd9922cb181c15914b7f3b7c66cb',
  version: '0.0.0',
} as const;
const schema = `
CREATE TABLE IF NOT EXISTS app_schema_identity(id INTEGER PRIMARY KEY CHECK(id=1), uuid TEXT NOT NULL, version TEXT NOT NULL);
INSERT OR IGNORE INTO app_schema_identity VALUES(1,'${APP_SCHEMA_IDENTITY.uuid}','${APP_SCHEMA_IDENTITY.version}');
CREATE TABLE IF NOT EXISTS notebooks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  uuid TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL, notebook_id INTEGER NOT NULL REFERENCES notebooks(id), data_json TEXT NOT NULL
);`;
function entry(row: Record<string, unknown>): NotebookEntry {
  return {
    id: Number(row.id),
    path: String(row.path),
    name: String(row.name),
    uuid: String(row.uuid),
    createdAt: String(row.created_at),
    editedAt: String(row.edited_at),
  };
}
export function notebookMetadata(db: SqlDatabase): NotebookMetadata {
  const row = db.all(`SELECT n.uuid,m.created_at FROM notebook_metadata m
    JOIN notebook_imports n ON n.id=m.self_import_id WHERE m.id=1`)[0];
  if (!row) throw new Error('Notebook identity is missing');
  // Opening a session is recorded, but is not a content edit. Use event order,
  // not the wall clock maximum, so imported and reconstructed histories work.
  const last = db.all(`SELECT occurred_at FROM app_events
    WHERE kind NOT IN ('app.open','notebook.open') ORDER BY id DESC LIMIT 1`)[0];
  return {
    uuid: String(row.uuid),
    createdAt: String(row.created_at),
    editedAt: String(last?.occurred_at ?? row.created_at),
  };
}

/** App/config DB only. Notebook content remains authoritative in its own file.
 * Names and selection are device-local preferences; content exports need no catalog.
 */
export class AppCatalog {
  private db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.db = db;
    const exists = db.all("SELECT name FROM sqlite_schema WHERE name='app_schema_identity'").length;
    if (exists) {
      const row = db.all('SELECT uuid,version FROM app_schema_identity WHERE id=1')[0];
      if (row?.uuid !== APP_SCHEMA_IDENTITY.uuid || row?.version !== APP_SCHEMA_IDENTITY.version)
        throw new Error('Unsupported app catalog schema');
    } else if (db.all("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").length) {
      throw new Error('Unrecognized app catalog');
    }
    db.exec('PRAGMA foreign_keys=ON');
    transaction(db, () => db.exec(schema));
  }
  list(): NotebookEntry[] {
    return this.db.all('SELECT * FROM notebooks ORDER BY edited_at DESC,id DESC').map(entry);
  }
  get(id: number): NotebookEntry {
    const row = this.db.all('SELECT * FROM notebooks WHERE id=?', [id])[0];
    if (!row) throw new Error('Notebook not found');
    return entry(row);
  }
  preference<T>(key: string): T | undefined {
    const row = this.db.all('SELECT value_json FROM preferences WHERE key=?', [key])[0];
    return row ? (JSON.parse(String(row.value_json)) as T) : undefined;
  }
  setPreference(key: string, value: unknown) {
    this.db.exec(
      'INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
      [key, JSON.stringify(value)],
    );
  }
  selected(): NotebookEntry | undefined {
    const id = this.preference<number>('active-notebook');
    return id === undefined ? undefined : this.get(id);
  }
  select(id: number) {
    this.get(id);
    this.setPreference('active-notebook', id);
  }
  add(path: string, name: string, metadata: NotebookMetadata, kind = 'notebook.add'): NotebookEntry {
    return transaction(this.db, () => {
      insertRow(this.db, 'notebooks', {
        path,
        name: this.name(name),
        uuid: metadata.uuid,
        created_at: metadata.createdAt,
        edited_at: metadata.editedAt,
      });
      const id = scalar(this.db, 'SELECT last_insert_rowid()');
      this.event(id, kind, { path, name: this.get(id).name, ...metadata });
      return this.get(id);
    });
  }
  rename(id: number, name: string): NotebookEntry {
    return transaction(this.db, () => {
      this.get(id);
      name = this.name(name);
      this.db.exec('UPDATE notebooks SET name=? WHERE id=?', [name, id]);
      this.event(id, 'notebook.rename', { name });
      return this.get(id);
    });
  }
  observe(id: number, metadata: NotebookMetadata): NotebookEntry {
    const before = this.get(id);
    if (
      before.uuid !== metadata.uuid ||
      before.createdAt !== metadata.createdAt ||
      before.editedAt !== metadata.editedAt
    )
      transaction(this.db, () => {
        this.db.exec('UPDATE notebooks SET uuid=?,created_at=?,edited_at=? WHERE id=?', [
          metadata.uuid,
          metadata.createdAt,
          metadata.editedAt,
          id,
        ]);
        if (before.uuid !== metadata.uuid) this.event(id, 'notebook.reset', metadata);
      });
    return this.get(id);
  }
  private name(name: string) {
    name = name.trim();
    if (!name || name.length > 200) throw new Error('Use a notebook name between 1 and 200 characters');
    return name;
  }
  private event(id: number, kind: string, data: unknown) {
    insertRow(this.db, 'catalog_events', {
      occurred_at: new Date().toISOString(),
      kind,
      notebook_id: id,
      data_json: JSON.stringify(data),
    });
  }
}
