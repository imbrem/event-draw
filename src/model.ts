/** Only sensor observations and coordinate transforms belong in raw stroke JSON. */
export interface Point { x: number; y: number }
export interface Sample extends Point {
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number; clientY: number; pageX: number; pageY: number;
  screenX: number; screenY: number;
  button: number; buttons: number;
  pressure: number | null; tangentialPressure: number | null;
  /** Sensor contact dimensions, NOT painted line width. */
  width: number | null; height: number | null;
  tiltX: number | null; tiltY: number | null; twist: number | null;
  altitudeAngle: number | null; azimuthAngle: number | null;
  persistentDeviceId: number | null;
  movementX: number | null; movementY: number | null;
}
export interface Delivery {
  type: string;
  receivedAt: number;
  clientToPage: number[];
  reported: Sample;
  coalesced: Sample[];
  predicted: Sample[];
}
export interface InkData { deliveries: Delivery[] }
export interface ViewBox extends Point { width: number; height: number }
export type ContentId = string;
export interface Document { id: number; name: string; pdf_hash: ContentId | null }
export interface PdfPageSize { width: number; height: number }
export interface PdfImport { hash: ContentId; name: string; bytes: Uint8Array; pages: PdfPageSize[] }
export type Page = { id: number; document_id: number; page_number: number; source_page: number | null; deleted: number } & (
  { kind: 'page'; width: number; height: number } |
  { kind: 'whiteboard'; width: null; height: null }
);
export interface Style { color: string; lineWidth: number }
export type Tool = 'pen' | 'erase-parts' | 'erase-strokes' | 'lasso' | 'pan';
export interface Gesture {
  pageId: number;
  tool: Exclude<Tool, 'pan'> | 'move-selection';
  /** App operation targets; never serialized into raw capture JSON. */
  shapeIds?: number[];
  style: Style;
  radius: number;
  cancelled: boolean;
  data: InkData;
}
export interface VisibleShape {
  id: number;
  raw_stroke_id: number;
  start_index: number; end_index: number;
  page_id: number; style_id: number;
  offset_x: number; offset_y: number;
  paint_order: number;
  color: string; line_width: number;
  data_version: number; data_json: string;
}
export interface CaptureSession {
  startedAt: string; source: string; timeOriginMs: number;
  userAgent: string; devicePixelRatio: number;
  capabilities: Record<string, unknown>;
}
export interface State {
  documents: Document[];
  pages: Page[];
  shapes: VisibleShape[];
  rawCount: number;
  eventCount: number;
  undoablePages: number[];
}
export const EMPTY_STATE: State = {
  documents: [], pages: [], shapes: [], rawCount: 0, eventCount: 0, undoablePages: [],
};
export type Range = [number, number];

/** Keep summary/rawupdate streams in storage, but avoid drawing both streams. */
export function measuredSamples(data: InkData): Sample[] {
  const raw = data.deliveries.some((d) => d.type === 'pointerrawupdate');
  return data.deliveries.filter((d) => !raw || d.type !== 'pointermove')
    .flatMap((d) => d.coalesced.length ? d.coalesced : [d.reported]);
}

/** Preserve original browser measurements while making render geometry local. */
export function localize(data: InkData): { data: InkData; origin: Point } {
  const first = measuredSamples(data)[0] ?? { x: 0, y: 0 };
  const origin = { x: first.x, y: first.y };
  const sample = (s: Sample): Sample => ({ ...s, x: s.x - origin.x, y: s.y - origin.y });
  return {
    origin,
    data: {
      deliveries: data.deliveries.map((d) => ({
        ...d,
        clientToPage: d.clientToPage.map((n, i) => i === 4 ? n - origin.x : i === 5 ? n - origin.y : n),
        reported: sample(d.reported), coalesced: d.coalesced.map(sample), predicted: d.predicted.map(sample),
      })),
    },
  };
}
