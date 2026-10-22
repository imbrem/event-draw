import type { CaptureSession, State, StrokeInput } from './model.ts';

export interface Initialized {
  state: State;
  sessionId: number;
  persistent: boolean;
  storageError: string | null;
}

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
    this.worker.onerror = (event) => {
      this.failure = new Error(event.message || 'Database worker failed.');
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
    };
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
  add(stroke: StrokeInput, sessionId: number) { return this.call<State>('add', { stroke, sessionId }); }
  undo() { return this.call<State>('undo'); }
  clear() { return this.call<State>('clear'); }
  export(mode: 'full' | 'visible') { return this.call<Uint8Array<ArrayBuffer>>('export', mode); }
}
