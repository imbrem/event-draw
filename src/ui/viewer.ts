import type { DatabaseClient } from '../database.ts';
import { measuredSamples, type InkData, type Point } from '../model.ts';
import { drawPath, prepareCanvas } from '../render.ts';
import { VIEWER_TABLES, type Row, type ViewerTable } from '../storage/sql.ts';

export class DatabaseViewer {
  private client: DatabaseClient;
  private root: HTMLElement;
  private raw = false;
  private table: ViewerTable = 'app_events';
  private offset = 0;
  private generation = 0;
  constructor(root: HTMLElement, client: DatabaseClient) {
    this.root = root;
    this.client = client;
  }
  async show(raw: boolean) {
    this.raw = raw;
    this.table = raw ? 'stroke_events' : 'app_events';
    this.offset = 0;
    await this.refresh();
  }
  async refresh() {
    const generation = ++this.generation;
    try {
      const result = await this.client.browse(this.table, this.offset);
      if (generation !== this.generation) return;
      this.root.replaceChildren();
      const heading = document.createElement('h2');
      heading.textContent = this.raw ? 'Raw stroke database' : 'Event database';
      const description = document.createElement('p');
      description.className = 'viewer-description';
      description.textContent = this.raw ?
        'Captured observations only. Page, tool, painted width, color and placement are stored separately. Sample width/height are sensor contact dimensions.' :
        'The actual SQLite rows. Select a row to inspect its fields and referenced shape states.';
      const controls = document.createElement('div');
      controls.className = 'viewer-controls';
      if (!this.raw) {
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Database table');
        for (const table of VIEWER_TABLES.filter((name) => name !== 'stroke_events')) {
          const option = new Option(table, table);
          option.selected = table === this.table;
          select.add(option);
        }
        select.onchange = () => { this.table = select.value as ViewerTable; this.offset = 0; void this.refresh(); };
        controls.append(select);
      }
      const previous = document.createElement('button'), next = document.createElement('button');
      previous.textContent = 'Previous'; next.textContent = 'Next';
      previous.disabled = this.offset === 0; next.disabled = this.offset + 25 >= result.total;
      previous.onclick = () => { this.offset = Math.max(0, this.offset - 25); void this.refresh(); };
      next.onclick = () => { this.offset += 25; void this.refresh(); };
      const count = document.createElement('span');
      count.textContent = result.total ? (this.offset + 1) + '–' +
        Math.min(this.offset + result.rows.length, result.total) + ' of ' + result.total + ' rows' : 'No rows yet';
      controls.append(previous, next, count);
      const grid = document.createElement('div');
      grid.className = 'database-grid';
      const wrapper = document.createElement('div');
      wrapper.className = 'database-table';
      const table = document.createElement('table');
      table.setAttribute('aria-label', this.table);
      const head = table.createTHead().insertRow();
      const columns = result.rows.length ? Object.keys(result.rows[0]) : [];
      for (const column of columns) {
        const th = document.createElement('th'); th.textContent = column; head.append(th);
      }
      const body = table.createTBody();
      const detail = document.createElement('div');
      detail.className = 'record-detail';
      detail.id = 'record-detail';
      for (const row of result.rows) {
        const tr = body.insertRow();
        tr.tabIndex = 0;
        for (const column of columns) {
          const cell = tr.insertCell(), value = row[column];
          const text = value === null ? 'NULL' : String(value);
          cell.textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
        }
        const choose = () => {
          body.querySelectorAll('tr').forEach((item) => item.classList.toggle('selected', item === tr));
          void this.inspect(row, detail);
        };
        tr.onclick = choose;
        tr.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') choose(); };
      }
      wrapper.append(table);
      grid.append(wrapper, detail);
      this.root.append(heading, description, controls, grid);
      if (result.rows.length) {
        body.rows[0].classList.add('selected');
        await this.inspect(result.rows[0], detail);
      }
    } catch (error) {
      if (generation === this.generation) this.root.textContent = String(error);
    }
  }
  private async inspect(row: Row, detail: HTMLElement) {
    detail.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = this.table + (row.id === undefined ? '' : ' #' + row.id);
    const pre = document.createElement('pre');
    pre.id = 'record-json';
    const decoded: Record<string, unknown> = { ...row };
    for (const key of Object.keys(decoded)) {
      if (key.endsWith('_json') && typeof row[key] === 'string') {
        try { decoded[key] = JSON.parse(row[key] as string); } catch { /* show original bytes */ }
      }
    }
    pre.textContent = JSON.stringify(decoded, null, 2);
    detail.append(heading);
    if (this.table === 'stroke_events' && row.data_version === 1) {
      const canvas = document.createElement('canvas');
      canvas.className = 'raw-preview';
      canvas.setAttribute('aria-label', 'Neutral raw stroke preview');
      detail.append(canvas);
      const points = measuredSamples(JSON.parse(String(row.data_json)) as InkData);
      requestAnimationFrame(() => this.preview(canvas, points));
    }
    detail.append(pre);
    if (this.table === 'app_events') {
      const related = await this.client.related(Number(row.id));
      if (!detail.contains(pre)) return; // selection changed while querying
      const label = document.createElement('h4'), effects = document.createElement('pre');
      label.textContent = 'Referenced shape states';
      effects.id = 'event-effects';
      effects.textContent = JSON.stringify(related, null, 2);
      detail.append(label, effects);
    }
  }
  private preview(canvas: HTMLCanvasElement, points: Point[]) {
    if (!canvas.isConnected || !points.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const size = Math.max(maxX - minX, maxY - minY, 20), pad = size * 0.1;
    const view = { x: minX - pad, y: minY - pad, width: size + 2 * pad, height: size + 2 * pad };
    const context = prepareCanvas(canvas, view);
    if (context) drawPath(context, points, '#203b42', view.width / 150);
  }
}
