import type { DatabaseClient, Initialized } from '../database.ts';
import type { CaptureSession } from '../model.ts';
import { NotebookBackups } from './notebook-backups.ts';
import { element } from './shell.ts';
interface NotebookFileOptions {
  canReplace(): boolean;
  canBackup(): boolean;
  revision(): number;
  notebookId(): number | null;
  flush(): Promise<void>;
  busy(value: boolean): void;
  replaced(value: Initialized): Promise<void>;
  error(value: unknown): void;
}
/** Portable file lifecycle is independent of page layout and edit selection. */
export class NotebookFiles {
  private backups = new NotebookBackups();
  private timer: ReturnType<typeof setInterval>;
  private savedRevision = -1;
  constructor(
    private db: DatabaseClient,
    private session: CaptureSession,
    private options: NotebookFileOptions,
  ) {
    element<HTMLInputElement>('notebook-file').onchange = () => {
      const input = element<HTMLInputElement>('notebook-file'),
        file = input.files?.[0];
      input.value = '';
      if (!file) return;
      void this.activate(async () => {
        if (file.size > 512 * 1024 * 1024) throw new Error('Notebook exceeds 512 MiB');
        return db.openNotebook(new Uint8Array(await file.arrayBuffer()), session, file.name);
      }).catch(options.error);
    };
    element<HTMLInputElement>('jsonl-file').onchange = () => {
      const input = element<HTMLInputElement>('jsonl-file'),
        file = input.files?.[0];
      input.value = '';
      if (!file) return;
      void this.activate(async () => {
        if (file.size > 512 * 1024 * 1024) throw new Error('Event stream exceeds 512 MiB');
        return db.openEventStream(await file.text(), session, file.name);
      }).catch(options.error);
    };
    element('new-notebook').onclick = () => {
      void this.activate(() => db.createNotebook('New notebook', session)).catch(options.error);
    };
    element('restore-backup').onclick = () => {
      void this.backups
        .latest(options.notebookId())
        .then((saved) => {
          if (!saved) throw new Error('No recovery copy is available yet.');
          return this.activate(() => db.openNotebook(saved.bytes, session, 'Recovered ' + saved.createdAt));
        })
        .catch(options.error);
    };
    this.timer = setInterval(() => {
      if (!options.canBackup() || options.revision() === this.savedRevision) return;
      const revision = options.revision(),
        notebookId = options.notebookId();
      void db
        .export('full')
        .then((bytes) => this.backups.save(bytes, notebookId))
        .then(() => {
          if (options.notebookId() === notebookId) this.savedRevision = revision;
        })
        .catch(() => {});
    }, 60000);
  }
  /** Flush and back up the outgoing notebook before changing the active file. */
  async activate(load: () => Promise<Initialized>) {
    if (!this.options.canReplace()) throw new Error('Finish the current edit before changing notebooks.');
    this.options.busy(true);
    try {
      await this.options.flush();
      if (this.options.notebookId() !== null) {
        const previous = await this.db.export('full');
        // The outgoing notebook is retained in the library even if backup storage fails.
        await this.backups.save(previous, this.options.notebookId()).catch(() => {});
      }
      const result = await load();
      if (result.mode === 'blocked') throw new Error('Notebook is locked by another tab');
      this.savedRevision = -1;
      await this.options.replaced(result);
    } finally {
      this.options.busy(false);
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
