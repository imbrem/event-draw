import { PDFDocument } from 'pdf-lib';
import html2canvas from 'html2canvas-pro';
import type { Page, State, ViewBox } from '../model.ts';
import type { PageSources } from '../page-sources.ts';
import { selectionBounds } from '../geometry.ts';
import { render } from '../render.ts';
import { PageObjects } from '../ui/page-objects.ts';

function exportView(page: Page, state: State): ViewBox {
  if (page.kind === 'page') return { x: 0, y: 0, width: page.width, height: page.height };
  const ink = selectionBounds(state.shapes.filter((s) => s.page_id === page.id)),
    objects = state.objects.filter((o) => o.page_id === page.id && o.rendered);
  // A rotation-independent bounding square contains each object at any angle.
  const boxes = [
    ...(ink ? [ink] : []),
    ...objects.map((o) => {
      const r = Math.hypot(o.width, o.height) / 2;
      return { x: o.x + o.width / 2 - r, y: o.y + o.height / 2 - r, width: 2 * r, height: 2 * r };
    }),
  ];
  if (!boxes.length) return { x: 0, y: 0, width: 1000, height: 1200 };
  const x = Math.min(...boxes.map((b) => b.x)) - 30,
    y = Math.min(...boxes.map((b) => b.y)) - 30;
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x + 30,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y + 30,
  };
}
/** Portable first export: a flattened PDF, with independently sized mixed pages. */
export async function annotatedPdf(
  state: State,
  documentId: number,
  sources: PageSources,
  progress: (message: string) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create(),
    pages = state.pages.filter((p) => p.document_id === documentId);
  for (const [index, page] of pages.entries()) {
    progress('Exporting page ' + (index + 1) + ' / ' + pages.length + '…');
    const view = exportView(page, state),
      scale = Math.min(
        1.5,
        2400 / Math.max(view.width, view.height),
        Math.sqrt(8_000_000 / (view.width * view.height)),
      );
    const host = document.createElement('div');
    host.className = 'paper export-paper';
    Object.assign(host.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      margin: '0',
      width: view.width * scale + 'px',
      height: view.height * scale + 'px',
      background: 'white',
    });
    const background = document.createElement('canvas'),
      ink = document.createElement('canvas'),
      objects = document.createElement('div');
    objects.className = 'page-objects';
    host.append(background, ink, objects);
    document.body.append(host);
    const layer = new PageObjects(
      objects,
      host,
      () => {},
      () => {},
    );
    try {
      await sources.render(background, page, new AbortController().signal);
      render(ink, {
        shapes: state.shapes.filter((s) => s.page_id === page.id),
        pending: [],
        active: null,
        hover: null,
        selected: [],
        view,
        tool: 'pen',
        radius: 0,
      });
      layer.update(
        state.objects.filter((o) => o.page_id === page.id),
        [],
        view,
        false,
        false,
      );
      await layer.settled();
      await document.fonts.ready;
      const canvas = await html2canvas(host, {
        scale: 1,
        backgroundColor: '#ffffff',
        logging: false,
        imageTimeout: 15000,
      });
      const image = await pdf.embedPng(canvas.toDataURL('image/png'));
      const sizeScale = Math.min(1, 14400 / Math.max(view.width, view.height));
      const target = pdf.addPage([view.width * sizeScale, view.height * sizeScale]);
      target.drawImage(image, { x: 0, y: 0, width: target.getWidth(), height: target.getHeight() });
    } finally {
      layer.close();
      host.remove();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Uint8Array(await pdf.save());
}
