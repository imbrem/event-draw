import { isWritingNote } from '../note-pages.ts';
import { inkWindow } from './surface-layout.ts';
import type { ViewBox } from '../model.ts';
import type { Page } from '../model.ts';
import type { PageSources } from '../page-sources.ts';

/** Layout, zoom and cancellable background rendering. Coordinates remain page-local. */
export class PageSurface {
  private page: Page | undefined;
  private generation = 0;
  private zoom = 1;
  private frame = 0;
  private observer: ResizeObserver;
  private notes = false;
  private cssScale = 1;
  private windowFrame = 0;
  private visibleView: ViewBox | undefined;
  private events = new AbortController();
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
    private ink: HTMLCanvasElement,
    private onView: () => void,
  ) {
    this.viewport = viewport;
    this.paper = paper;
    this.canvas = canvas;
    this.sources = sources;
    this.onStatus = onStatus;
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(viewport);
    viewport.addEventListener('scroll', () => this.scheduleWindow(), {
      passive: true,
      signal: this.events.signal,
    });
  }
  setNotes(enabled: boolean) {
    if (this.notes === enabled) return;
    this.notes = enabled;
    this.layout();
  }
  inkView() {
    return this.visibleView;
  }
  get aspect() {
    const padding = this.notes ? 0 : 24;
    return (
      Math.max(1, this.viewport.clientWidth - padding) / Math.max(1, this.viewport.clientHeight - padding)
    );
  }
  update(page: Page | undefined) {
    const previous = this.page;
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
    if (previous?.id !== page?.id || previous?.source_hash !== page?.source_hash) {
      this.zoom = 1;
      this.viewport.scrollTop = this.viewport.scrollLeft = 0;
    }
    this.layout();
  }
  scale(factor: number, anchor?: { x: number; y: number }) {
    const before = this.paper.getBoundingClientRect(),
      viewport = this.viewport.getBoundingClientRect();
    const point = anchor ?? { x: viewport.left + viewport.width / 2, y: viewport.top + viewport.height / 2 };
    const ratioX = (point.x - before.left) / before.width,
      ratioY = (point.y - before.top) / before.height;
    this.zoom = Math.min(8, Math.max(0.25, this.zoom * factor));
    this.layout();
    const after = this.paper.getBoundingClientRect();
    // Layout may already adjust/clamp scroll. Correct the anchor from that actual position.
    this.viewport.scrollLeft += after.left + ratioX * after.width - point.x;
    this.viewport.scrollTop += after.top + ratioY * after.height - point.y;
    this.scheduleWindow();
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
    this.page = undefined;
    this.visibleView = undefined;
    this.zoom = 1;
    this.viewport.scrollTop = this.viewport.scrollLeft = 0;
    delete this.paper.dataset.layout;
  }
  private layout() {
    const page = this.page;
    if (!page) return;
    const writing = this.notes || isWritingNote(page),
      padding = this.notes ? 0 : 24;
    const width = Math.max(1, this.viewport.clientWidth - padding),
      height = Math.max(1, this.viewport.clientHeight - padding);
    const scale =
      page.kind === 'page'
        ? (writing ? width / page.width : Math.min(width / page.width, height / page.height)) * this.zoom
        : 1;
    const w = page.kind === 'page' ? page.width * scale : width,
      h = page.kind === 'page' ? page.height * scale : height;
    const size = w + 'px:' + h + 'px:' + this.key;
    if (this.paper.dataset.layout === size) {
      this.syncWindow();
      return;
    }
    const top = this.viewport.scrollTop / this.cssScale;
    this.cssScale = scale;
    this.paper.dataset.layout = size;
    this.paper.style.width = w + 'px';
    this.paper.style.height = h + 'px';
    this.paper.classList.toggle('whiteboard', page.kind === 'whiteboard');
    this.viewport.scrollTop = top * scale;
    this.syncWindow();
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
  private scheduleWindow() {
    if (!this.windowFrame)
      this.windowFrame = requestAnimationFrame(() => {
        this.windowFrame = 0;
        this.syncWindow();
      });
  }
  private syncWindow() {
    const page = this.page;
    if (page?.kind === 'page' && (this.notes || isWritingNote(page))) {
      const window = inkWindow(
        this.paper.getBoundingClientRect(),
        this.viewport.getBoundingClientRect(),
        page.width,
      );
      this.visibleView = window.view;
      Object.assign(this.ink.style, {
        inset: 'auto',
        left: window.left + 'px',
        top: window.top + 'px',
        width: window.width + 'px',
        height: window.height + 'px',
      });
    } else {
      this.visibleView = undefined;
      this.ink.removeAttribute('style');
    }
    this.onView();
  }
  close() {
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.events.abort();
    cancelAnimationFrame(this.windowFrame);
  }
}
