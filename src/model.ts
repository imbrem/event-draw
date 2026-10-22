/** Geometry is in fixed page units; browser measurements retain their own units. */
export interface Sample {
  x: number;
  y: number;
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
  button: number;
  buttons: number;
  pressure: number | null;
  tangentialPressure: number | null;
  width: number | null;
  height: number | null;
  tiltX: number | null;
  tiltY: number | null;
  twist: number | null;
  altitudeAngle: number | null;
  azimuthAngle: number | null;
  persistentDeviceId: number | null;
  movementX: number | null;
  movementY: number | null;
}

export interface Delivery {
  type: string;
  receivedAt: number;
  clientToPage: number[];
  reported: Sample;
  coalesced: Sample[];
  predicted: Sample[];
}

export interface InkData {
  deliveries: Delivery[];
}

export interface StrokeInput {
  kind: string;
  dataVersion: number;
  status: 'complete' | 'cancelled';
  color: string;
  width: number;
  data: InkData;
}

export interface VisibleStroke {
  id: number;
  page_id: number;
  kind: string;
  data_version: number;
  color: string;
  width: number;
  paint_order: number;
  data_json: string;
}

export interface CaptureSession {
  startedAt: string;
  source: string;
  timeOriginMs: number;
  userAgent: string;
  devicePixelRatio: number;
  capabilities: Record<string, unknown>;
}

export interface State {
  strokes: VisibleStroke[];
  shapeCount: number;
  eventCount: number;
  canUndo: boolean;
}

/** Coalesced observations replace their summary event, avoiding double drawing. */
export function measuredSamples(data: InkData): Sample[] {
  const raw = data.deliveries.some((delivery) => delivery.type === 'pointerrawupdate');
  return data.deliveries.filter((delivery) => !raw || delivery.type !== 'pointermove').flatMap((delivery) =>
    delivery.coalesced.length ? delivery.coalesced : [delivery.reported],
  );
}
