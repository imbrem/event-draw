/// <reference lib="webworker" />
import { init as initZstd, compress, decompress } from '@bokuweb/zstd-wasm';
import { cborZstdCodec, tracePayloads } from './trace-codecs.ts';
import sqlite3InitModule, { type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import schema from './schema.sql?raw';
import { Journal } from './journal.ts';
import { resetSchema } from './storage/schema.ts';
import type { BrowseResult, ViewerTable } from './storage/sql.ts';
import type { CaptureSession, Gesture, ObjectInput } from './model.ts';
import { replaceNotebook, validateNotebook } from './storage/notebooks.ts';
import { StateEncoder } from './state-transport.ts';
import type { State } from './model.ts';
import { verifyContent } from './content.ts';
import { createNotebookExchange } from './storage/event-stream.ts';
import { NotebookWorkspace } from './storage/notebook-workspace.ts';
import { sqliteAdapter as adapter } from './storage/sqlite-adapter.ts';

// Build-time host choice. A research build can install a different source/sink,
// payload binding set, framing codec, or inbound/outbound transformation stages.
const exchange = createNotebookExchange();

const scope = self as unknown as DedicatedWorkerGlobalScope;
async function openDatabase() {
  await initZstd();
  tracePayloads.codecs.set(
    'cbor+zstd@1',
    cborZstdCodec({
      compress: (data) => compress(data, 3),
      decompress: (data, size) => decompress(data, { defaultHeapSize: size }),
    }),
  );
  const sqlite = await sqlite3InitModule();
  let pool: SAHPoolUtil | undefined;
  let mode: 'persistent' | 'temporary' = 'persistent';
  let storageError: string | null = null;
  try {
    pool = await sqlite.installOpfsSAHPoolVfs({
      directory: '/event-draw-v1',
      preserveOnInitFailure: true,
    });
  } catch (error) {
    storageError = String(error);
    mode = 'temporary';
  }
  const workspace = await NotebookWorkspace.open(sqlite, pool);
  return { sqlite, workspace, mode, storageError };
}
type Opened = Awaited<ReturnType<typeof openDatabase>>;
type Context = Opened | { mode: 'blocked' };
/** A held Web Lock distinguishes another tab from genuinely unavailable storage. */
const ready = new Promise<Context>((resolve, reject) => {
  if (navigator.locks) {
    void navigator.locks
      .request('event-draw-database', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve({ mode: 'blocked' });
          return;
        }
        try {
          resolve(await openDatabase());
        } catch (error) {
          reject(error);
          return;
        }
        await new Promise(() => {}); // released automatically when the worker closes
      })
      .catch(reject);
  } else {
    void openDatabase().then(resolve, reject);
  }
});
// Mark rejection handled even if no message has reached the worker yet.
void ready.catch(() => {});

const encoder = new StateEncoder();
async function handle(request: { id: number; method: string; payload: any }) {
  try {
    const context = await ready;
    if (context.mode === 'blocked') {
      if (request.method === 'init') {
        scope.postMessage({ id: request.id, value: { mode: 'blocked' } });
        return;
      }
      throw new Error('Notebook already open in another tab. Close it and reload.');
    }
    const { sqlite, workspace } = context;
    const { db, journal } = workspace;
    const initialized = (sessionId: number) => ({
      mode: context.mode,
      state: workspace.journal.state(),
      sessionId,
      storageError: context.storageError,
      notebook: workspace.current!,
    });
    let value: unknown;
    switch (request.method) {
      case 'init':
      case 'reset': {
        if (request.method === 'reset') {
          resetSchema(adapter(db), schema);
          workspace.journal = new Journal(adapter(db));
        }
        value = initialized(
          workspace.initialize(
            request.payload as CaptureSession,
            request.method === 'init' ? 'app.open' : 'notebook.open',
          ),
        );
        break;
      }
      case 'listNotebooks':
        value = { notebooks: workspace.catalog.list(), activeId: workspace.current?.id ?? null };
        break;
      case 'exportStoredNotebook': {
        const bytes = workspace.exportStored(request.payload);
        scope.postMessage({ id: request.id, value: bytes }, [bytes.buffer]);
        return;
      }
      case 'renameNotebook':
        value = workspace.catalog.rename(request.payload.id, request.payload.name);
        if (workspace.current?.id === request.payload.id)
          workspace.current = value as typeof workspace.current;
        break;
      case 'createNotebook':
        value = initialized(await workspace.create(request.payload.name, request.payload.session));
        break;
      case 'switchNotebook':
        value = initialized(workspace.switch(request.payload.id, request.payload.session));
        break;
      case 'openEventStream': {
        const input = new sqlite.oo1.DB(':memory:');
        try {
          input.exec(schema);
          const report = exchange.reconstruct(
            exchange.codec.decode(String(request.payload.text).split('\n')),
            adapter(input),
          );
          for (const row of input.selectObjects('SELECT hash,data FROM blobs'))
            await verifyContent(String(row.hash), row.data as Uint8Array);
          value = {
            ...initialized(await workspace.create(request.payload.name, request.payload.session, input)),
            report,
          };
        } finally {
          input.close();
        }
        break;
      }
      case 'exportEventStream':
        value = [...exchange.codec.encode(exchange.collect(adapter(db), request.payload !== false))].join('');
        break;
      case 'openNotebook': {
        const bytes = request.payload.bytes as Uint8Array;
        if (
          bytes.length > 512 * 1024 * 1024 ||
          new TextDecoder().decode(bytes.slice(0, 16)) !== 'SQLite format 3\0'
        )
          throw new Error('Choose a SQLite notebook smaller than 512 MiB');
        const input = new sqlite.oo1.DB(':memory:'),
          pointer = sqlite.wasm.allocFromTypedArray(bytes);
        try {
          const result = sqlite.capi.sqlite3_deserialize(
            input.pointer!,
            'main',
            pointer,
            bytes.length,
            bytes.length,
            sqlite.capi.SQLITE_DESERIALIZE_READONLY,
          );
          if (result) throw new Error('Could not read SQLite notebook');
          input.exec('PRAGMA trusted_schema=OFF');
          const expected = new sqlite.oo1.DB(':memory:');
          try {
            expected.exec(schema);
            validateNotebook(adapter(input), adapter(expected));
          } finally {
            expected.close();
          }
          if (input.selectValue("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='blobs'"))
            for (const row of input.selectObjects(
              'SELECT b.hash,b.data,a.byte_length FROM blobs b JOIN asset_refs a USING(hash)',
            )) {
              const blob = row.data as Uint8Array;
              if (blob.length !== Number(row.byte_length))
                throw new Error('Embedded resource length does not match metadata');
              await verifyContent(String(row.hash), blob);
            }
          value = initialized(await workspace.create(request.payload.name, request.payload.session, input));
        } finally {
          input.close();
          sqlite.wasm.dealloc(pointer);
        }
        break;
      }
      case 'insertPdf':
        await verifyContent(request.payload.input.hash, request.payload.input.bytes);
        value = journal.insertPdf(
          request.payload.input,
          request.payload.documentId,
          request.payload.afterPageId,
        );
        break;
      case 'setPageSource':
        value = journal.setPageSource(request.payload.pageId, request.payload.source);
        break;
      case 'importAsset':
        await verifyContent(request.payload.hash, request.payload.bytes);
        value = journal.importAsset(request.payload);
        break;
      case 'transformShapes':
        value = journal.transformShapes(request.payload.pageId, request.payload.ids, request.payload.change);
        break;
      case 'copyShapes':
        value = journal.copyShapes(request.payload.pageId, request.payload.ids);
        break;
      case 'pasteShapes':
        value = journal.pasteShapes(request.payload.pageId, request.payload.items);
        break;
      case 'redo':
        value = journal.redo(request.payload);
        break;
      case 'gesture':
        value = journal.gesture(request.payload.gesture as Gesture, request.payload.sessionId);
        break;
      case 'addPage': {
        const { documentId, afterPageId, width, height, layout } = request.payload;
        value = journal.addPage(documentId, afterPageId, width, height, layout);
        break;
      }
      case 'extendNote':
        value = journal.extendNote(request.payload);
        break;
      case 'createDocument':
        value = journal.createDocument(request.payload.name, request.payload.layout);
        break;
      case 'renameDocument':
        value = journal.renameDocument(request.payload.id, request.payload.name);
        break;
      case 'changePage':
        value = journal.changePage(request.payload.pageId, request.payload.action);
        break;
      case 'importPdf':
        await verifyContent(request.payload.hash, request.payload.bytes);
        value = journal.importPdf(request.payload);
        break;
      case 'readPdf':
        value = journal.readPdf(request.payload);
        break;
      case 'clear':
        value = journal.clear(request.payload);
        break;
      case 'deleteShapes':
        value = journal.deleteShapes(request.payload.pageId, request.payload.shapeIds);
        break;
      case 'reprocess':
        value = journal.reprocess(request.payload.pageId, request.payload.shapeIds, request.payload.policy);
        break;
      case 'outputs':
        value = journal.outputs(request.payload);
        break;
      case 'setObject':
        value = journal.setObject(request.payload as ObjectInput);
        break;
      case 'deleteObject':
        value = journal.deleteObject(request.payload.pageId, request.payload.id);
        break;
      case 'undo':
        value = journal.undo(request.payload);
        break;
      case 'browse':
        value = journal.browse(
          request.payload.table as ViewerTable,
          request.payload.offset,
        ) satisfies BrowseResult;
        break;
      case 'related':
        value = journal.related(request.payload);
        break;
      case 'relatedContent':
        value = journal.relatedContent(request.payload);
        break;
      case 'diagnostics':
        value = journal.diagnostics();
        break;
      case 'export': {
        if (
          request.payload === 'visible' ||
          request.payload === 'drawn' ||
          request.payload?.mode === 'visible' ||
          request.payload?.mode === 'drawn'
        ) {
          const snapshot = new sqlite.oo1.DB(':memory:');
          try {
            snapshot.exec(schema);
            journal.snapshotInto(adapter(snapshot), {
              drawnOnly: request.payload === 'drawn' || request.payload?.mode === 'drawn',
              includeBlobs: request.payload?.includeBlobs !== false,
            });
            value = sqlite.capi.sqlite3_js_db_export(snapshot.pointer!);
          } finally {
            snapshot.close();
          }
        } else if (request.payload?.includeBlobs === false) {
          const copy = new sqlite.oo1.DB(':memory:');
          try {
            copy.exec(schema);
            replaceNotebook(adapter(db), adapter(copy));
            copy.exec('DELETE FROM blobs; VACUUM');
            value = sqlite.capi.sqlite3_js_db_export(copy.pointer!);
          } finally {
            copy.close();
          }
        } else value = sqlite.capi.sqlite3_js_db_export(db.pointer!);
        const bytes = value as Uint8Array<ArrayBuffer>;
        scope.postMessage({ id: request.id, value: bytes }, [bytes.buffer]);
        return;
      }
      default:
        throw new Error('Unknown database operation');
    }
    if (value && typeof value === 'object' && 'shapes' in value && Array.isArray(value.shapes)) {
      workspace.observe();
      value = encoder.encode(value as State);
    } else if (value && typeof value === 'object' && 'state' in value) {
      const initialized = value as { state: State };
      initialized.state = encoder.encode(initialized.state) as unknown as State;
    }
    scope.postMessage({ id: request.id, value });
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}
let queue = Promise.resolve();
scope.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};
