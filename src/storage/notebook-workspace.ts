import type { Database, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { CaptureSession } from '../model.ts';
import { Journal } from '../journal.ts';
import schema from '../schema.sql?raw';
import { AppCatalog, notebookMetadata, type NotebookEntry } from './app-catalog.ts';
import { initializeSchema } from './schema.ts';
import { replaceNotebook } from './notebooks.ts';
import { sqliteAdapter as adapter } from './sqlite-adapter.ts';
import { transaction, type SqlDatabase } from './sql.ts';

/** The browser host owns files/connections; AppCatalog and Journal only know SQL.
 * A candidate is initialized before activation, so failed opens keep the editor.
 */
export class NotebookWorkspace {
  readonly catalog: AppCatalog;
  db: Database;
  journal: Journal;
  current: NotebookEntry | undefined;
  private memory = new Map<string, Database>();
  private path: string;
  private app: SqlDatabase;
  private constructor(
    private sqlite: Sqlite3Static,
    private pool: SAHPoolUtil | undefined,
    app: Database,
  ) {
    this.app = adapter(app);
    this.catalog = new AppCatalog(this.app);
    this.current = this.catalog.selected();
    this.path = this.current?.path ?? '/notes.sqlite3'; // adopt the original working file in place
    if (this.current && pool && !pool.getFileNames().includes(this.path))
      throw new Error('The selected notebook file is missing');
    this.db = this.open(this.path);
    this.journal = new Journal(adapter(this.db));
    // Catalog the old file before validating its schema. Even an incompatible
    // notebook must remain discoverable/exportable after creating another one.
    if (
      !this.current &&
      this.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    ) {
      let metadata = { uuid: '', createdAt: '', editedAt: '' };
      try {
        metadata = notebookMetadata(adapter(this.db));
      } catch {
        /* Unknown old schema; show unknown metadata. */
      }
      this.current = this.catalog.add(this.path, 'My notebook', metadata, 'notebook.adopt');
      this.catalog.select(this.current.id);
    }
  }
  static async open(sqlite: Sqlite3Static, pool?: SAHPoolUtil) {
    if (pool) await pool.reserveMinimumCapacity(pool.getFileCount() + 4);
    const app = pool ? new pool.OpfsSAHPoolDb('/app.sqlite3') : new sqlite.oo1.DB(':memory:');
    return new NotebookWorkspace(sqlite, pool, app);
  }
  private open(path: string) {
    if (this.pool) return new this.pool.OpfsSAHPoolDb(path);
    let db = this.memory.get(path);
    if (!db) {
      db = new this.sqlite.oo1.DB(':memory:');
      this.memory.set(path, db);
    }
    return db;
  }
  initialize(session: CaptureSession, kind: 'app.open' | 'notebook.open' = 'app.open') {
    initializeSchema(adapter(this.db), schema);
    const sessionId = this.journal.startSession(session, kind);
    this.current = this.current
      ? this.catalog.observe(this.current.id, notebookMetadata(adapter(this.db)))
      : this.catalog.add(this.path, 'My notebook', notebookMetadata(adapter(this.db)), 'notebook.adopt');
    this.catalog.select(this.current.id);
    return sessionId;
  }
  exportStored(id: number): Uint8Array<ArrayBuffer> {
    const item = this.catalog.get(id);
    if (this.current?.id === id) return this.sqlite.capi.sqlite3_js_db_export(this.db.pointer!);
    if (this.pool) return this.pool.exportFile(item.path).slice();
    const db = this.memory.get(item.path);
    if (!db) throw new Error('Notebook file is missing');
    return this.sqlite.capi.sqlite3_js_db_export(db.pointer!);
  }
  observe() {
    if (this.current)
      this.current = this.catalog.observe(this.current.id, notebookMetadata(adapter(this.db)));
  }
  async create(name: string, session: CaptureSession, source?: Database) {
    // Local file handles deliberately differ from UUIDs: importing an older
    // snapshot must not overwrite a newer copy with the same global identity.
    const path = '/notebook-' + crypto.getRandomValues(new Uint32Array(4)).join('-') + '.sqlite3';
    if (this.pool) await this.pool.reserveMinimumCapacity(this.pool.getFileCount() + 4);
    const candidate = this.open(path);
    try {
      initializeSchema(adapter(candidate), schema);
      if (source) replaceNotebook(adapter(source), adapter(candidate));
      const journal = new Journal(adapter(candidate));
      const sessionId = journal.startSession(session, 'notebook.open');
      const item = transaction(this.app, () => {
        const added = this.catalog.add(
          path,
          name,
          notebookMetadata(adapter(candidate)),
          source ? 'notebook.import' : 'notebook.create',
        );
        this.catalog.select(added.id);
        return added;
      });
      this.activate(candidate, journal, item);
      return sessionId;
    } catch (error) {
      candidate.close();
      this.memory.delete(path);
      this.pool?.unlink(path);
      throw error;
    }
  }
  switch(id: number, session: CaptureSession) {
    if (this.current?.id === id) return this.initialize(session, 'notebook.open');
    const item = this.catalog.get(id);
    if (this.pool && !this.pool.getFileNames().includes(item.path))
      throw new Error('Notebook file is missing');
    const candidate = this.open(item.path);
    try {
      initializeSchema(adapter(candidate), schema);
      const journal = new Journal(adapter(candidate));
      const sessionId = journal.startSession(session, 'notebook.open');
      const next = this.catalog.observe(id, notebookMetadata(adapter(candidate)));
      this.catalog.select(next.id);
      this.activate(candidate, journal, next);
      return sessionId;
    } catch (error) {
      if (this.pool) candidate.close();
      throw error;
    }
  }
  private activate(db: Database, journal: Journal, item: NotebookEntry) {
    const previous = this.db;
    this.db = db;
    this.journal = journal;
    this.current = item;
    this.path = item.path;
    if (this.pool) previous.close();
  }
}
