import type { DatabaseClient, Initialized } from '../database.ts';
import type { CaptureSession } from '../model.ts';
import { download } from '../download.ts';
import { NotebookBackups } from './notebook-backups.ts';
import { element } from './shell.ts';
interface NotebookFileOptions {
  canReplace(): boolean;
  canBackup(): boolean;
  revision(): number;
  flush(): Promise<void>;
  busy(value: boolean): void;
  replaced(value: Initialized, name: string): Promise<void>;
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
      void this.replace(async () => {
        if (file.size > 512 * 1024 * 1024) throw new Error('Notebook exceeds 512 MiB');
        return db.openNotebook(new Uint8Array(await file.arrayBuffer()), session);
      }, file.name);
    };
    element('new-notebook').onclick = () => {
      void this.replace(() => db.reset(session), 'New notebook');
    };
    element('restore-backup').onclick = () => {
      void this.backups
        .latest()
        .then((saved) => {
          if (!saved) throw new Error('No recovery copy is available yet.');
          return this.replace(() => db.openNotebook(saved.bytes, session), 'Recovered ' + saved.createdAt);
        })
        .catch(options.error);
    };
    this.timer = setInterval(() => {
      if (!options.canBackup() || options.revision() === this.savedRevision) return;
      const revision = options.revision();
      void db
        .export('full')
        .then((bytes) => this.backups.save(bytes))
        .then(() => {
          this.savedRevision = revision;
        })
        .catch(() => {});
    }, 60000);
  }
  private async replace(load: () => Promise<Initialized>, name: string) {
    if (!this.options.canReplace()) return;
    this.options.busy(true);
    try {
      await this.options.flush();
      const previous = await this.db.export('full');
      try {
        await this.backups.save(previous);
      } catch {
        download(previous, 'application/vnd.sqlite3', 'event-draw-recovery.sqlite3');
      }
      const result = await load();
      if (result.mode === 'blocked') throw new Error('Notebook is locked by another tab');
      this.savedRevision = -1;
      await this.options.replaced(result, name);
    } catch (error) {
      this.options.error(error);
    } finally {
      this.options.busy(false);
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
