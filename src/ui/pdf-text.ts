import { TextLayer } from 'pdfjs-dist';
import type { Page } from '../model.ts';
import type { PdfLibrary } from '../pdf/library.ts';
/** A separate selectable layer leaves the drawing surface's input path intact. */
export class PdfText {
  private generation = 0;
  private task: TextLayer | null = null;
  private observer: ResizeObserver;
  private page?: Page;
  private enabled = false;
  constructor(
    private root: HTMLElement,
    private pdfs: PdfLibrary,
  ) {
    this.observer = new ResizeObserver(() => void this.render());
    this.observer.observe(root.parentElement!);
  }
  update(page: Page | undefined, enabled: boolean) {
    if (this.page === page && this.enabled === enabled) return;
    this.page = page;
    this.enabled = enabled;
    void this.render();
  }
  private async render() {
    const generation = ++this.generation;
    this.task?.cancel();
    this.task = null;
    this.root.replaceChildren();
    this.root.hidden = !this.enabled || this.page?.source_kind !== 'pdf';
    if (this.root.hidden) return;
    const page = this.page!;
    try {
      await this.pdfs.usingPage(page.source_hash!, page.source_page!, async (pdf) => {
        if (generation !== this.generation) return;
        const viewport = pdf.getViewport({
          scale: this.root.parentElement!.getBoundingClientRect().width / pdf.getViewport({ scale: 1 }).width,
        });
        this.root.style.setProperty('--scale-factor', String(viewport.scale));
        this.root.style.setProperty('--total-scale-factor', String(viewport.scale));
        this.task = new TextLayer({
          textContentSource: await pdf.getTextContent(),
          container: this.root,
          viewport,
        });
        await this.task.render();
      });
    } catch (e) {
      if (generation === this.generation) this.root.textContent = 'PDF text unavailable: ' + String(e);
    }
  }
  close() {
    this.generation++;
    this.task?.cancel();
    this.observer.disconnect();
  }
}
