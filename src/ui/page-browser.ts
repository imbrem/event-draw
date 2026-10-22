import type { Page, State } from '../model.ts';
import type { PageSources } from '../page-sources.ts';
import type { PdfLibrary } from '../pdf/library.ts';
import { shapeInk } from '../geometry.ts';
import { drawInk } from './drawing.ts';
import { PageObjects } from './page-objects.ts';

/** Grid/continuous readers and text search are disposable journal projections.
 * Only nearby pages hold pixel buffers; choosing a page opens the ink editor.
 */
export class PageBrowser {
  private generation = 0;
  private searchGeneration = 0;
  private observer: IntersectionObserver | null = null;
  private releases: (() => void)[] = [];
  private continuous = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private root: HTMLDialogElement,
    private sources: PageSources,
    private pdfs: PdfLibrary,
    private select: (id: number) => void,
  ) {
    root.addEventListener('close', () => this.release());
  }
  private release() {
    this.generation++;
    this.searchGeneration++;
    this.observer?.disconnect();
    for (const release of this.releases) release();
    this.releases = [];
  }
  async show(state: State, currentDocument: number) {
    this.release();
    const generation = this.generation;
    this.root.innerHTML =
      '<header><strong>Notebook pages</strong><button id="reader-mode">' +
      (this.continuous ? 'Page grid' : 'Continuous reader') +
      '</button><button id="close-page-browser">Close</button></header><form id="notebook-search-form"><input id="notebook-search" type="search" aria-label="Search notebook" placeholder="Search page text, linked notes and PDF text"><button>Search</button></form><p id="search-status"></p><div class="search-results"></div><div class="page-thumbnails"></div>';
    this.root.querySelector<HTMLButtonElement>('#close-page-browser')!.onclick = () => this.root.close();
    this.root.querySelector<HTMLButtonElement>('#reader-mode')!.onclick = () => {
      this.continuous = !this.continuous;
      void this.show(state, currentDocument);
    };
    if (!this.root.open) this.root.showModal();
    this.root.scrollTop = 0;
    this.root.querySelector<HTMLFormElement>('form')!.onsubmit = (event) => {
      event.preventDefault();
      void this.search(state, generation);
    };
    const list = this.root.querySelector<HTMLElement>('.page-thumbnails')!;
    list.classList.toggle('continuous-reader', this.continuous);
    const nodes = new Map<Element, { show(): void; hide(): void }>();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const node = nodes.get(entry.target);
          if (entry.isIntersecting) node?.show();
          else node?.hide();
        }
      },
      { root: this.root, rootMargin: '300px' },
    );
    for (const page of state.pages.filter((p) => p.document_id === currentDocument)) {
      const button = document.createElement('button'),
        host = document.createElement('div'),
        label = document.createElement('span');
      const width = this.continuous ? Math.max(140, Math.min(700, this.root.clientWidth - 60)) : 140;
      button.className = 'page-thumbnail';
      button.setAttribute('aria-label', 'Open page ' + page.page_number);
      button.onclick = () => {
        this.select(page.id);
        this.root.close();
      };
      host.className = 'thumbnail-image';
      host.style.width = width + 'px';
      host.style.height =
        page.kind === 'page'
          ? (this.continuous
              ? (width * page.height) / page.width
              : Math.min(240, (width * page.height) / page.width)) + 'px'
          : width * 1.2 + 'px';
      label.textContent = 'Page ' + page.page_number + ' · ' + page.source_kind;
      button.append(host, label);
      list.append(button);
      let job: AbortController | null = null;
      const hide = () => {
        job?.abort();
        job = null;
        host.replaceChildren();
      };
      this.releases.push(hide);
      nodes.set(button, {
        hide,
        show: () => {
          if (job) return;
          const abort = new AbortController();
          job = abort;
          this.queue = this.queue
            .catch(() => {})
            .then(async () => {
              if (abort.signal.aborted || generation !== this.generation) return;
              try {
                await this.preview(host, page, state, abort.signal);
              } catch {
                if (!abort.signal.aborted) label.textContent += ' · source unavailable';
              }
            });
        },
      });
      this.observer.observe(button);
    }
  }
  private async preview(host: HTMLElement, page: Page, state: State, signal: AbortSignal) {
    const background = document.createElement('canvas'),
      ink = document.createElement('canvas'),
      objects = document.createElement('div');
    objects.className = 'page-objects';
    host.replaceChildren(background, ink, objects);
    const layer = new PageObjects(
      objects,
      host,
      () => {},
      () => {},
    );
    try {
      await this.sources.render(background, page, signal);
      if (signal.aborted) return;
      const view =
        page.kind === 'page'
          ? { x: 0, y: 0, width: page.width, height: page.height }
          : { x: 0, y: 0, width: 1000, height: 1200 };
      const scale = Math.min(2, Math.sqrt(4_000_000 / (host.clientWidth * host.clientHeight)));
      ink.width = Math.max(1, Math.round(host.clientWidth * scale));
      ink.height = Math.max(1, Math.round(host.clientHeight * scale));
      const ctx = ink.getContext('2d')!;
      ctx.scale(ink.width / view.width, ink.height / view.height);
      for (const shape of state.shapes.filter((s) => s.page_id === page.id))
        drawInk(ctx, shapeInk(shape), shape.color, shape.line_width, shape.opacity, shape.blend_mode);
      layer.update(
        state.objects.filter((o) => o.page_id === page.id),
        [],
        view,
        false,
        false,
      );
      await layer.settled();
    } finally {
      layer.close();
      if (signal.aborted) {
        background.width = background.height = ink.width = ink.height = 0;
      }
    }
  }
  private async search(state: State, generation: number) {
    const search = ++this.searchGeneration,
      query = this.root.querySelector<HTMLInputElement>('input')!.value.trim().toLocaleLowerCase(),
      results = this.root.querySelector<HTMLElement>('.search-results')!,
      status = this.root.querySelector<HTMLElement>('#search-status')!;
    results.replaceChildren();
    if (!query) {
      status.textContent = '';
      return;
    }
    status.textContent = 'Searching…';
    let count = 0,
      missing = 0;
    for (const page of state.pages) {
      if (generation !== this.generation || search !== this.searchGeneration) return;
      const text = state.objects
        .filter((o) => o.page_id === page.id)
        .map((o) => o.label + ' ' + o.data_json)
        .join('\n');
      let pdfText = '';
      if (page.source_kind === 'pdf')
        try {
          pdfText = await this.pdfs.usingPage(page.source_hash!, page.source_page!, async (pdf) =>
            (await pdf.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' '),
          );
        } catch {
          missing++;
        }
      if (generation !== this.generation || search !== this.searchGeneration) return;
      const all = text + '\n' + pdfText,
        index = all.toLocaleLowerCase().indexOf(query);
      if (index < 0) continue;
      const button = document.createElement('button');
      button.textContent =
        (state.documents.find((d) => d.id === page.document_id)?.name || 'Notes') +
        '/' +
        page.page_number +
        ' · ' +
        all.slice(Math.max(0, index - 35), index + 100);
      button.onclick = () => {
        this.select(page.id);
        this.root.close();
      };
      results.append(button);
      count++;
      if (count >= 100) break;
    }
    status.textContent =
      count +
      ' matching pages' +
      (missing ? ' · ' + missing + ' PDF pages unavailable' : '') +
      ' · handwriting recognition is not enabled';
  }
  close() {
    this.release();
    this.root.close();
  }
}
