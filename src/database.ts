import type {
  CaptureSession,
  Gesture,
  PdfImport,
  State,
  ObjectInput,
  AssetImport,
  SelectionTransform,
  ClipboardInk,
  PageSource,
} from './model.ts';
import type { BrowseResult, Row, ViewerTable } from './storage/sql.ts';
import type { DatabaseDiagnostics } from './storage/diagnostics.ts';
import { StateDecoder, type StatePatch } from './state-transport.ts';
import type { InkPolicy } from './ink.ts';
import type { NotebookEntry } from './storage/app-catalog.ts';
import type { ReplayReport } from './storage/event-stream.ts';

export type Initialized =
  | {
      mode: 'persistent' | 'temporary';
      notebook: NotebookEntry;
      state: State;
      sessionId: number;
      storageError: string | null;
      report?: ReplayReport;
    }
  | { mode: 'blocked' };

export class DatabaseClient {
  private worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
  private decoder = new StateDecoder();
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private failure: Error | null = null;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else {
        let value = data.value;
        if (value?.patch) value = this.decoder.decode(value as StatePatch);
        else if (value?.state?.patch)
          value = { ...value, state: this.decoder.decode(value.state as StatePatch) };
        pending.resolve(value);
      }
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
  openNotebook(bytes: Uint8Array, session: CaptureSession, name = 'Imported notebook') {
    return this.call<Initialized>('openNotebook', { bytes, session, name });
  }
  openEventStream(text: string, session: CaptureSession, name = 'Reconstructed notebook') {
    return this.call<Initialized>('openEventStream', { text, session, name });
  }
  listNotebooks() {
    return this.call<{ notebooks: NotebookEntry[]; activeId: number | null }>('listNotebooks');
  }
  exportStoredNotebook(id: number) {
    return this.call<Uint8Array<ArrayBuffer>>('exportStoredNotebook', id);
  }
  createNotebook(name: string, session: CaptureSession) {
    return this.call<Initialized>('createNotebook', { name, session });
  }
  switchNotebook(id: number, session: CaptureSession) {
    return this.call<Initialized>('switchNotebook', { id, session });
  }
  renameNotebook(id: number, name: string) {
    return this.call<NotebookEntry>('renameNotebook', { id, name });
  }
  exportEventStream(includeBlobs = true) {
    return this.call<string>('exportEventStream', includeBlobs);
  }
  setPageSource(pageId: number, source: PageSource) {
    return this.call<State>('setPageSource', { pageId, source });
  }
  insertPdf(input: PdfImport, documentId: number, afterPageId: number) {
    return this.call<State>('insertPdf', { input, documentId, afterPageId });
  }
  importAsset(input: AssetImport) {
    return this.call<State>('importAsset', input);
  }
  transformShapes(pageId: number, ids: number[], change: SelectionTransform) {
    return this.call<State>('transformShapes', { pageId, ids, change });
  }
  copyShapes(pageId: number, ids: number[]) {
    return this.call<ClipboardInk[]>('copyShapes', { pageId, ids });
  }
  pasteShapes(pageId: number, items: ClipboardInk[]) {
    return this.call<State>('pasteShapes', { pageId, items });
  }
  redo(pageId: number) {
    return this.call<State>('redo', pageId);
  }
  init(session: CaptureSession) {
    return this.call<Initialized>('init', session);
  }
  reset(session: CaptureSession) {
    return this.call<Initialized>('reset', session);
  }
  gesture(gesture: Gesture, sessionId: number) {
    return this.call<State>('gesture', { gesture, sessionId });
  }
  addPage(documentId: number, afterPageId: number, width: number | null, height: number | null) {
    return this.call<State>('addPage', { documentId, afterPageId, width, height });
  }
  createDocument(name: string) {
    return this.call<State>('createDocument', name);
  }
  renameDocument(id: number, name: string) {
    return this.call<State>('renameDocument', { id, name });
  }
  importPdf(input: PdfImport) {
    return this.call<State>('importPdf', input);
  }
  read(hash: string) {
    return this.call<Uint8Array>('readPdf', hash);
  }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete') {
    return this.call<State>('changePage', { pageId, action });
  }
  undo(pageId: number) {
    return this.call<State>('undo', pageId);
  }
  clear(pageId: number) {
    return this.call<State>('clear', pageId);
  }
  deleteShapes(pageId: number, shapeIds: number[]) {
    return this.call<State>('deleteShapes', { pageId, shapeIds });
  }
  reprocess(pageId: number, shapeIds: number[], policy: InkPolicy) {
    return this.call<State>('reprocess', { pageId, shapeIds, policy });
  }
  outputs(rawId: number) {
    return this.call<Row[]>('outputs', rawId);
  }
  setObject(input: ObjectInput) {
    return this.call<State>('setObject', input);
  }
  deleteObject(pageId: number, id: number) {
    return this.call<State>('deleteObject', { pageId, id });
  }
  browse(table: ViewerTable, offset = 0) {
    return this.call<BrowseResult>('browse', { table, offset });
  }
  related(eventId: number) {
    return this.call<Row[]>('related', eventId);
  }
  relatedContent(eventId: number) {
    return this.call<{ objects: Row[]; boxes: Row[] }>('relatedContent', eventId);
  }
  diagnostics() {
    return this.call<DatabaseDiagnostics>('diagnostics');
  }
  export(mode: 'full' | 'visible' | 'drawn', includeBlobs = true) {
    return this.call<Uint8Array<ArrayBuffer>>('export', includeBlobs ? mode : { mode, includeBlobs });
  }
}
