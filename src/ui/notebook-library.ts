import { download } from '../download.ts';
import type { DatabaseClient } from '../database.ts';
import type { NotebookEntry } from '../storage/app-catalog.ts';

interface LibraryActions {
  create(name: string): Promise<void>;
  select(id: number): Promise<void>;
  save(id: number): Promise<Uint8Array<ArrayBuffer>>;
  renamed(item: NotebookEntry): void;
  error(error: unknown): void;
}
/** Catalog presentation has no knowledge of canvas tools or notebook contents. */
export class NotebookLibrary {
  private generation = 0;
  constructor(
    private root: HTMLDialogElement,
    private db: DatabaseClient,
    private actions: LibraryActions,
  ) {}
  async show() {
    const generation = ++this.generation;
    this.root.innerHTML = `<header><strong>Notebooks</strong><button id="close-notebook-library">Close</button></header>
      <p>Each notebook is a separate SQLite file on this device. Documents, pages and notes stay inside it.</p>
      <form id="create-notebook-form"><input type="text" id="new-notebook-name" aria-label="New notebook name" placeholder="Notebook name" maxlength="200" required><button>Create notebook</button></form>
      <p id="library-status" role="status">Loading…</p><div id="notebook-list"></div>`;
    this.root.querySelector<HTMLButtonElement>('#close-notebook-library')!.onclick = () => this.root.close();
    this.root.querySelector<HTMLFormElement>('form')!.onsubmit = (event) => {
      event.preventDefault();
      const name = this.root.querySelector<HTMLInputElement>('#new-notebook-name')!.value;
      void this.run(() => this.actions.create(name), true);
    };
    if (!this.root.open) this.root.showModal();
    try {
      const { notebooks, activeId } = await this.db.listNotebooks();
      if (generation !== this.generation) return;
      this.root.querySelector('#library-status')!.textContent =
        notebooks.length + ' notebooks · names are local to this device';
      const list = this.root.querySelector('#notebook-list')!;
      for (const item of notebooks) {
        const row = document.createElement('article');
        row.className = 'notebook-entry';
        row.setAttribute('aria-label', item.name);
        row.dataset.notebookId = String(item.id);
        row.dataset.uuid = item.uuid;
        const title = document.createElement('div'),
          input = document.createElement('input'),
          rename = document.createElement('button'),
          open = document.createElement('button'),
          save = document.createElement('button');
        input.type = 'text';
        input.value = item.name;
        input.maxLength = 200;
        input.setAttribute('aria-label', 'Notebook name');
        rename.textContent = 'Rename';
        rename.onclick = () =>
          void this.run(async () => {
            const renamed = await this.db.renameNotebook(item.id, input.value);
            this.actions.renamed(renamed);
            await this.show();
          });
        open.textContent = item.id === activeId ? 'Current' : 'Open';
        open.disabled = item.id === activeId;
        open.dataset.current = String(item.id === activeId);
        open.onclick = () => void this.run(() => this.actions.select(item.id), true);
        save.textContent = 'Save SQLite';
        save.onclick = () =>
          void this.run(async () => {
            const bytes = await this.actions.save(item.id);
            download(bytes, 'application/vnd.sqlite3', item.name.replace(/[/\\]/g, '-') + '.sqlite3');
          });
        title.append(input, rename, open);
        const uuid = document.createElement('p');
        uuid.className = 'content-id';
        uuid.textContent = item.uuid || 'UUID unavailable · incompatible notebook';
        const dates = document.createElement('dl');
        for (const [label, date] of [
          ['Created', item.createdAt],
          ['Last edited', item.editedAt],
        ]) {
          const term = document.createElement('dt'),
            value = document.createElement('dd'),
            time = document.createElement('time');
          term.textContent = label;
          time.dateTime = date;
          time.textContent = date ? new Date(date).toLocaleString() : 'Unknown';
          value.append(time);
          dates.append(term, value);
        }
        row.append(title, uuid, dates, save);
        list.append(row);
      }
    } catch (error) {
      this.actions.error(error);
      this.root.querySelector('#library-status')!.textContent = String(error);
    }
  }
  private async run(work: () => Promise<void>, close = false) {
    for (const node of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input'))
      node.disabled = true;
    try {
      await work();
      if (close) this.root.close();
    } catch (error) {
      this.actions.error(error);
      this.root.querySelector('#library-status')!.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      for (const node of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input'))
        node.disabled = node.dataset.current === 'true';
    }
  }
  close() {
    this.generation++;
    this.root.close();
  }
}
