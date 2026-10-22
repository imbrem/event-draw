import { getDocument, GlobalWorkerOptions, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ContentId, PdfPageSize } from '../model.ts';
import { verifyPdf, type PdfSource } from './source.ts';

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = import.meta.env.BASE_URL + 'pdf-assets/';
async function open(bytes: Uint8Array) {
  const task = getDocument({
    data: bytes.slice(),
    cMapUrl: assets + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/',
    iccUrl: assets + 'iccs/',
  });
  try {
    return { document: await task.promise, close: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}
/** PDF parsing/cache depends only on read(contentId), never on SQLite or UI. */
export class PdfLibrary {
  private loaded = new Map<ContentId, ReturnType<typeof open>>();
  private leases = new Map<ContentId, number>();
  private generation = 0;
  private source: PdfSource;
  constructor(source: PdfSource) {
    this.source = source;
  }
  async inspect(bytes: Uint8Array): Promise<PdfPageSize[]> {
    const loaded = await open(bytes);
    try {
      const pages: PdfPageSize[] = [];
      for (let n = 1; n <= loaded.document.numPages; n++) {
        const page = await loaded.document.getPage(n),
          view = page.getViewport({ scale: 1 });
        pages.push({ width: view.width, height: view.height });
        page.cleanup();
      }
      return pages;
    } finally {
      await loaded.close();
    }
  }
  async page(id: ContentId, number: number) {
    let loaded = this.loaded.get(id);
    if (!loaded) {
      loaded = this.source.read(id).then(async (bytes) => {
        await verifyPdf(id, bytes);
        return open(bytes);
      });
      this.loaded.set(id, loaded);
      void loaded.catch(() => this.loaded.delete(id));
    }
    this.loaded.delete(id);
    this.loaded.set(id, loaded);
    return (await loaded).document.getPage(number);
  }
  async usingPage<T>(id: ContentId, number: number, work: (page: PDFPageProxy) => Promise<T>): Promise<T> {
    const generation = this.generation;
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    try {
      return await work(await this.page(id, number));
    } finally {
      if (generation === this.generation) {
        this.leases.set(id, this.leases.get(id)! - 1);
        for (const [key, loaded] of this.loaded) {
          if (this.loaded.size <= 4) break;
          if (this.leases.get(key)) continue;
          this.loaded.delete(key);
          this.leases.delete(key);
          void loaded.then((d) => d.close()).catch(() => {});
        }
      }
    }
  }
  close() {
    this.generation++;
    for (const loaded of this.loaded.values()) void loaded.then((d) => d.close()).catch(() => {});
    this.loaded.clear();
    this.leases.clear();
  }
}
