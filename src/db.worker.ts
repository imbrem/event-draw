/// <reference lib="webworker" />
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import schema from './schema.sql?raw';
import { Journal } from './journal.ts';
import { initializeSchema, resetSchema } from './storage/schema.ts';
import type { BrowseResult, Row, SqlDatabase, ViewerTable } from './storage/sql.ts';
import type { CaptureSession, Gesture } from './model.ts';
import { verifyPdf } from './pdf/source.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
function adapter(db: Database): SqlDatabase {
  return {
    exec(sql, bind) { db.exec(sql, bind ? { bind } : {}); },
    all(sql, bind) { return db.selectObjects(sql, bind) as Row[]; },
  };
}
async function openDatabase() {
  const sqlite = await sqlite3InitModule();
  let db: Database;
  let mode: 'persistent' | 'temporary' = 'persistent';
  let storageError: string | null = null;
  try {
    const pool = await sqlite.installOpfsSAHPoolVfs({
      directory: '/event-draw-v1', preserveOnInitFailure: true,
    });
    db = new pool.OpfsSAHPoolDb('/notes.sqlite3');
  } catch (error) {
    storageError = String(error);
    mode = 'temporary';
    db = new sqlite.oo1.DB(':memory:');
  }
  return { sqlite, db, mode, storageError };
}
type Opened = Awaited<ReturnType<typeof openDatabase>>;
type Context = Opened | { mode: 'blocked' };
/** A held Web Lock distinguishes another tab from genuinely unavailable storage. */
const ready = new Promise<Context>((resolve, reject) => {
  if (navigator.locks) {
    void navigator.locks.request('event-draw-database', { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve({ mode: 'blocked' }); return; }
      try { resolve(await openDatabase()); }
      catch (error) { reject(error); return; }
      await new Promise(() => {}); // released automatically when the worker closes
    }).catch(reject);
  } else {
    void openDatabase().then(resolve, reject);
  }
});
// Mark rejection handled even if no message has reached the worker yet.
void ready.catch(() => {});

scope.onmessage = async ({ data: request }) => {
  try {
    const context = await ready;
    if (context.mode === 'blocked') {
      if (request.method === 'init') {
        scope.postMessage({ id: request.id, value: { mode: 'blocked' } });
        return;
      }
      throw new Error('Notebook already open in another tab. Close it and reload.');
    }
    const { sqlite, db } = context;
    const journal = new Journal(adapter(db));
    let value: unknown;
    switch (request.method) {
      case 'init':
      case 'reset': {
        if (request.method === 'reset') resetSchema(adapter(db), schema);
        else initializeSchema(adapter(db), schema);
        value = {
          mode: context.mode, state: journal.state(),
          sessionId: journal.startSession(request.payload as CaptureSession),
          storageError: context.storageError,
        };
        break;
      }
      case 'gesture':
        value = journal.gesture(request.payload.gesture as Gesture, request.payload.sessionId); break;
      case 'addPage': {
        const { documentId, afterPageId, width, height } = request.payload;
        value = journal.addPage(documentId, afterPageId, width, height); break;
      }
      case 'createDocument': value = journal.createDocument(request.payload); break;
      case 'renameDocument': value = journal.renameDocument(request.payload.id, request.payload.name); break;
      case 'changePage': value = journal.changePage(request.payload.pageId, request.payload.action); break;
      case 'importPdf':
        await verifyPdf(request.payload.hash, request.payload.bytes);
        value = journal.importPdf(request.payload); break;
      case 'readPdf': value = journal.readPdf(request.payload); break;
      case 'clear': value = journal.clear(request.payload); break;
      case 'deleteShapes': value = journal.deleteShapes(request.payload.pageId, request.payload.shapeIds); break;
      case 'undo': value = journal.undo(request.payload); break;
      case 'browse':
        value = journal.browse(request.payload.table as ViewerTable, request.payload.offset) satisfies BrowseResult; break;
      case 'related': value = journal.related(request.payload); break;
      case 'diagnostics': value = journal.diagnostics(); break;
      case 'export': {
        if (request.payload === 'visible') {
          const snapshot = new sqlite.oo1.DB(':memory:');
          try {
            snapshot.exec(schema);
            journal.snapshotInto(adapter(snapshot));
            value = sqlite.capi.sqlite3_js_db_export(snapshot.pointer!);
          } finally { snapshot.close(); }
        } else value = sqlite.capi.sqlite3_js_db_export(db.pointer!);
        const bytes = value as Uint8Array<ArrayBuffer>;
        scope.postMessage({ id: request.id, value: bytes }, [bytes.buffer]);
        return;
      }
      default: throw new Error('Unknown database operation');
    }
    scope.postMessage({ id: request.id, value });
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
