/// <reference lib="webworker" />
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import schema from './schema.sql?raw';
import { Journal, type Row, type SqlDatabase } from './journal.ts';
import type { CaptureSession, StrokeInput } from './model.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

function adapter(db: Database): SqlDatabase {
  return {
    exec(sql, bind) { db.exec(sql, bind ? { bind } : {}); },
    all(sql, bind) { return db.selectObjects(sql, bind) as Row[]; },
  };
}

const ready = (async () => {
  const sqlite = await sqlite3InitModule();
  let db: Database;
  let persistent = false;
  let storageError: string | null = null;
  try {
    const pool = await sqlite.installOpfsSAHPoolVfs({
      directory: '/event-draw-v1', preserveOnInitFailure: true,
    });
    db = new pool.OpfsSAHPoolDb('/notes.sqlite3');
    persistent = true;
  } catch (error) {
    storageError = String(error);
    db = new sqlite.oo1.DB(':memory:');
  }
  // Refuse unknown database versions rather than silently rewriting them.
  const version = Number(db.selectValue('PRAGMA user_version'));
  if (version !== 0 && version !== 1) throw new Error('Unsupported database schema version: ' + version);
  db.exec(schema);
  return { sqlite, db, journal: new Journal(adapter(db)), persistent, storageError };
})();

scope.onmessage = async ({ data: request }) => {
  try {
    const context = await ready;
    const { sqlite, db, journal } = context;
    let value: unknown;
    switch (request.method) {
      case 'init':
        value = {
          state: journal.state(),
          sessionId: journal.startSession(request.payload as CaptureSession),
          persistent: context.persistent,
          storageError: context.storageError,
        };
        break;
      case 'add':
        value = journal.addStroke(request.payload.stroke as StrokeInput, request.payload.sessionId);
        break;
      case 'clear': value = journal.clear(); break;
      case 'undo': value = journal.undo(); break;
      case 'export': {
        if (request.payload === 'visible') {
          const snapshot = new sqlite.oo1.DB(':memory:');
          try {
            snapshot.exec(schema);
            journal.snapshotInto(adapter(snapshot));
            value = sqlite.capi.sqlite3_js_db_export(snapshot.pointer!);
          } finally {
            snapshot.close();
          }
        } else {
          value = sqlite.capi.sqlite3_js_db_export(db.pointer!);
        }
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
