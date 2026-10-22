import type { Page, AssetImport } from './model.ts';
import type { PdfLibrary } from './pdf/library.ts';
import { identifyContent, verifyContent, type ContentSource } from './content.ts';

export type BackgroundRenderer = (
  canvas: HTMLCanvasElement,
  page: Page,
  signal: AbortSignal,
) => Promise<void>;
/** Host-injected source kinds keep page topology independent of background media. */
export class PageSources {
  readonly renderers = new Map<string, BackgroundRenderer>();
  private source: ContentSource;
  constructor(source: ContentSource, pdfs: PdfLibrary) {
    this.source = source;
    this.renderers.set('blank', async (canvas) => {
      canvas.hidden = true;
    });
    this.renderers.set('pdf', async (canvas, page, signal) =>
      pdfs.usingPage(page.source_hash!, page.source_page!, async (pdf) => {
        if (signal.aborted) return;
        const rect = canvas.parentElement!.getBoundingClientRect(),
          base = pdf.getViewport({ scale: 1 });
        const scale = Math.min(
          (rect.width * Math.min(devicePixelRatio || 1, 3)) / base.width,
          Math.sqrt(16_000_000 / (base.width * base.height)),
        );
        const viewport = pdf.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const task = pdf.render({ canvas, viewport }),
          cancel = () => task.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await task.promise;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      }),
    );
    const image: BackgroundRenderer = async (canvas, page, signal) => {
      const bytes = await source.read(page.source_hash!);
      await verifyContent(page.source_hash!, bytes);
      if (signal.aborted) return;
      const img = await decodeImage(bytes, page.source_kind === 'svg' ? 'image/svg+xml' : undefined);
      if (signal.aborted) return;
      const rect = canvas.parentElement!.getBoundingClientRect(),
        scale = Math.min(
          ((devicePixelRatio || 1) * rect.width) / page.width!,
          Math.sqrt(16_000_000 / (page.width! * page.height!)),
        );
      canvas.width = Math.max(1, Math.round(page.width! * scale));
      canvas.height = Math.max(1, Math.round(page.height! * scale));
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    this.renderers.set('image', image);
    this.renderers.set('svg', image);
  }
  async render(canvas: HTMLCanvasElement, page: Page, signal: AbortSignal) {
    canvas.hidden = false;
    const renderer = this.renderers.get(page.source_kind);
    if (renderer) await renderer(canvas, page, signal);
    else {
      canvas.width = 600;
      canvas.height = 80;
      const ctx = canvas.getContext('2d')!;
      ctx.font = '16px sans-serif';
      ctx.fillText('Unsupported page source: ' + page.source_kind, 16, 40);
    }
  }
  async imageElement(hash: string, mediaType: string): Promise<HTMLImageElement> {
    const bytes = await this.source.read(hash);
    await verifyContent(hash, bytes);
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([bytes.slice().buffer], { type: mediaType }));
    });
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
}
export async function decodeImage(bytes: Uint8Array, type?: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(
      new Blob([bytes.slice().buffer], { type: type ?? 'application/octet-stream' }),
    ),
    img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 100_000_000)
      throw new Error('Invalid image or image exceeds 100 megapixels');
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function inspectImage(
  bytes: Uint8Array,
  name: string,
  mediaType: string,
): Promise<Pick<AssetImport, 'hash' | 'width' | 'height' | 'mediaType'>> {
  const svg =
    mediaType === 'image/svg+xml' ||
    /\.svg$/i.test(name) ||
    new TextDecoder().decode(bytes.slice(0, 300)).includes('<svg');
  const type = svg ? 'image/svg+xml' : mediaType || 'application/octet-stream';
  const image = await decodeImage(bytes, type);
  return {
    hash: await identifyContent(bytes),
    width: image.naturalWidth,
    height: image.naturalHeight,
    mediaType: svg ? 'image/svg+xml' : type,
  };
}
