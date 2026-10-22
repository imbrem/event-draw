import type { Document, Page } from '../model.ts';
import type { RenderTask } from 'pdfjs-dist';
import type { PdfLibrary } from '../pdf/library.ts';

/** Full-window layout and PDF raster background, independent of ink rendering. */
export class PageSurface {
  private page: Page | undefined;
  private document: Document | undefined;
  private task: RenderTask | undefined;
  private generation = 0;
  private zoom = 1;
  private frame = 0;
  private observer: ResizeObserver;
  private key = '';
  private viewport: HTMLElement;
  private paper: HTMLElement;
  private canvas: HTMLCanvasElement;
  private pdfs: PdfLibrary;
  private onStatus: (status: 'ready' | 'loading' | 'error', error?: unknown) => void;
  constructor(viewport: HTMLElement, paper: HTMLElement, canvas: HTMLCanvasElement,
    pdfs: PdfLibrary, onStatus: (status: 'ready' | 'loading' | 'error', error?: unknown) => void) {
    this.viewport = viewport; this.paper = paper; this.canvas = canvas;
    this.pdfs = pdfs; this.onStatus = onStatus;
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(viewport);
  }
  get aspect() { return Math.max(1, this.viewport.clientWidth - 24) / Math.max(1, this.viewport.clientHeight - 24); }
  update(page: Page | undefined, document: Document | undefined) {
    this.page = page; this.document = document;
    const key = String(page?.id) + ':' + document?.pdf_hash;
    if (key === this.key) return;
    this.key = key; this.zoom = 1;
    this.viewport.scrollTop = 0; this.viewport.scrollLeft = 0;
    this.layout();
  }
  scale(factor: number) { this.zoom = Math.min(8, Math.max(0.25, this.zoom * factor)); this.layout(); }
  reset() { this.zoom = 1; this.layout(); }
  private layout() {
    const page = this.page;
    if (!page) return;
    const width = Math.max(1, this.viewport.clientWidth - 24), height = Math.max(1, this.viewport.clientHeight - 24);
    const scale = page.kind === 'page' ? Math.min(width / page.width, height / page.height) * this.zoom : 1;
    this.paper.style.width = (page.kind === 'page' ? page.width * scale : width) + 'px';
    this.paper.style.height = (page.kind === 'page' ? page.height * scale : height) + 'px';
    this.paper.classList.toggle('whiteboard', page.kind === 'whiteboard');
    this.generation++;
    this.task?.cancel();
    cancelAnimationFrame(this.frame);
    this.onStatus(this.document?.pdf_hash && page.source_page ? 'loading' : 'ready');
    this.frame = requestAnimationFrame(() => { this.frame = 0; void this.render(); });
  }
  private async render() {
    const generation = ++this.generation, previous = this.task;
    previous?.cancel();
    const page = this.page, hash = this.document?.pdf_hash;
    this.canvas.hidden = !hash;
    if (!hash || !page?.source_page) { this.onStatus('ready'); return; }
    this.onStatus('loading');
    try {
      await previous?.promise.catch(() => {});
      const pdf = await this.pdfs.page(hash, page.source_page);
      if (generation !== this.generation) return;
      const rect = this.paper.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = pdf.getViewport({ scale: rect.width * dpr / pdf.getViewport({ scale: 1 }).width });
      this.canvas.width = Math.max(1, Math.ceil(viewport.width));
      this.canvas.height = Math.max(1, Math.ceil(viewport.height));
      this.task = pdf.render({ canvas: this.canvas, viewport });
      await this.task.promise;
      if (generation === this.generation) this.onStatus('ready');
    } catch (error) {
      if (generation === this.generation) this.onStatus('error', error);
    }
  }
  close() { this.generation++; this.task?.cancel(); cancelAnimationFrame(this.frame); this.observer.disconnect(); }
}
