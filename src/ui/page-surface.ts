import type { Document, Page } from '../model.ts';
import type { PageSources } from '../page-sources.ts';

/** Layout, zoom and cancellable background rendering. Coordinates remain page-local. */
export class PageSurface {
  private page: Page | undefined;
  private generation = 0;
  private zoom = 1;
  private frame = 0;
  private observer: ResizeObserver;
  private key = '';
  private abort = new AbortController();
  private rendering: Promise<void> = Promise.resolve();
  private viewport: HTMLElement;
  private paper: HTMLElement;
  private canvas: HTMLCanvasElement;
  private sources: PageSources;
  private onStatus: (status: 'ready' | 'loading' | 'error', error?: unknown) => void;
  constructor(
    viewport: HTMLElement,
    paper: HTMLElement,
    canvas: HTMLCanvasElement,
    sources: PageSources,
    onStatus: PageSurface['onStatus'],
  ) {
    this.viewport = viewport;
    this.paper = paper;
    this.canvas = canvas;
    this.sources = sources;
    this.onStatus = onStatus;
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(viewport);
  }
  get aspect() {
    return Math.max(1, this.viewport.clientWidth - 24) / Math.max(1, this.viewport.clientHeight - 24);
  }
  update(page: Page | undefined, _document?: Document) {
    this.page = page;
    const key = JSON.stringify([
      page?.id,
      page?.source_kind,
      page?.source_hash,
      page?.source_page,
      page?.source_json,
      page?.width,
      page?.height,
    ]);
    if (key === this.key) return;
    this.key = key;
    this.zoom = 1;
    this.viewport.scrollTop = this.viewport.scrollLeft = 0;
    this.layout();
  }
  scale(factor: number, anchor?: { x: number; y: number }) {
    const before = this.paper.getBoundingClientRect(),
      left = this.viewport.scrollLeft,
      top = this.viewport.scrollTop,
      ratioX = anchor ? (anchor.x - before.left) / before.width : 0.5,
      ratioY = anchor ? (anchor.y - before.top) / before.height : 0.5;
    this.zoom = Math.min(8, Math.max(0.25, this.zoom * factor));
    this.layout();
    const after = this.paper.getBoundingClientRect();
    this.viewport.scrollLeft =
      left + (after.left + ratioX * after.width) - (before.left + ratioX * before.width);
    this.viewport.scrollTop =
      top + (after.top + ratioY * after.height) - (before.top + ratioY * before.height);
  }
  pan(dx: number, dy: number) {
    this.viewport.scrollLeft -= dx;
    this.viewport.scrollTop -= dy;
  }
  reset() {
    this.zoom = 1;
    this.layout();
    this.viewport.scrollTop = this.viewport.scrollLeft = 0;
  }
  invalidate() {
    this.abort.abort();
    this.key = '';
    delete this.paper.dataset.layout;
  }
  private layout() {
    const page = this.page;
    if (!page) return;
    const width = Math.max(1, this.viewport.clientWidth - 24),
      height = Math.max(1, this.viewport.clientHeight - 24);
    const scale = page.kind === 'page' ? Math.min(width / page.width, height / page.height) * this.zoom : 1;
    const w = page.kind === 'page' ? page.width * scale : width,
      h = page.kind === 'page' ? page.height * scale : height;
    const size = w + 'px:' + h + 'px:' + this.key;
    if (this.paper.dataset.layout === size) return;
    this.paper.dataset.layout = size;
    this.paper.style.width = w + 'px';
    this.paper.style.height = h + 'px';
    this.paper.classList.toggle('whiteboard', page.kind === 'whiteboard');
    const generation = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    cancelAnimationFrame(this.frame);
    this.onStatus(page.source_kind === 'blank' ? 'ready' : 'loading');
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const previous = this.rendering;
      this.rendering = (async () => {
        await previous.catch(() => {});
        if (signal.aborted) return;
        try {
          await this.sources.render(this.canvas, page, signal);
          if (generation === this.generation) this.onStatus('ready');
        } catch (e) {
          if (!signal.aborted && generation === this.generation) this.onStatus('error', e);
        }
      })();
    });
  }
  close() {
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
  }
}
