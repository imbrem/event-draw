import type { CaptureSession, Gesture, State } from './model.ts';
import type { BrowseResult, Row, ViewerTable } from './storage/sql.ts';

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
  addPage(title: string, width: number | null, height: number | null) {
    return this.call<State>('addPage', { title, width, height });
  }
  undo(pageId: number) { return this.call<State>('undo', pageId); }
  clear(pageId: number) { return this.call<State>('clear', pageId); }
  deleteShapes(pageId: number, shapeIds: number[]) { return this.call<State>('deleteShapes', { pageId, shapeIds }); }
  browse(table: ViewerTable, offset = 0) { return this.call<BrowseResult>('browse', { table, offset }); }
  related(eventId: number) { return this.call<Row[]>('related', eventId); }
  export(mode: 'full' | 'visible') { return this.call<Uint8Array<ArrayBuffer>>('export', mode); }
}
