import type { CaptureSession, Gesture, PdfImport, State, ObjectInput } from './model.ts';
import type { BrowseResult, Row, ViewerTable } from './storage/sql.ts';
import type { DatabaseDiagnostics } from './storage/diagnostics.ts';
import type { InkPolicy } from './ink.ts';

export type Initialized = {
  mode: 'persistent' | 'temporary'; state: State; sessionId: number; storageError: string | null;
} | { mode: 'blocked' };

export class DatabaseClient {
  private worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private failure: Error | null = null;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Database worker failed'));
  }
  private fail(error: Error) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  close() {
    this.worker.terminate();
    this.fail(new Error('Database closed'));
  }
  private call<T>(method: string, payload?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, method, payload });
    });
  }
  init(session: CaptureSession) { return this.call<Initialized>('init', session); }
  reset(session: CaptureSession) { return this.call<Initialized>('reset', session); }
  gesture(gesture: Gesture, sessionId: number) { return this.call<State>('gesture', { gesture, sessionId }); }
  addPage(documentId: number, afterPageId: number, width: number | null, height: number | null) {
    return this.call<State>('addPage', { documentId, afterPageId, width, height });
  }
  createDocument(name: string) { return this.call<State>('createDocument', name); }
  renameDocument(id: number, name: string) { return this.call<State>('renameDocument', { id, name }); }
  importPdf(input: PdfImport) { return this.call<State>('importPdf', input); }
  read(hash: string) { return this.call<Uint8Array>('readPdf', hash); }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete') { return this.call<State>('changePage', { pageId, action }); }
  undo(pageId: number) { return this.call<State>('undo', pageId); }
  clear(pageId: number) { return this.call<State>('clear', pageId); }
  deleteShapes(pageId: number, shapeIds: number[]) { return this.call<State>('deleteShapes', { pageId, shapeIds }); }
  reprocess(pageId: number, shapeIds: number[], policy: InkPolicy) { return this.call<State>('reprocess', { pageId, shapeIds, policy }); }
  outputs(rawId: number) { return this.call<Row[]>('outputs', rawId); }
  setObject(input: ObjectInput) { return this.call<State>('setObject', input); }
  deleteObject(pageId: number, id: number) { return this.call<State>('deleteObject', { pageId, id }); }
  browse(table: ViewerTable, offset = 0) { return this.call<BrowseResult>('browse', { table, offset }); }
  related(eventId: number) { return this.call<Row[]>('related', eventId); }
  relatedContent(eventId: number) { return this.call<{ objects: Row[]; boxes: Row[] }>('relatedContent', eventId); }
  diagnostics() { return this.call<DatabaseDiagnostics>('diagnostics'); }
  export(mode: 'full' | 'visible') { return this.call<Uint8Array<ArrayBuffer>>('export', mode); }
}
