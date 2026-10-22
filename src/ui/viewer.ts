import type { DatabaseClient } from '../database.ts';
import type { InkData } from '../model.ts';
import { diagnosticsPanel } from './database-diagnostics.ts';
import { StrokePreview } from './stroke-preview.ts';
import { VIEWER_TABLES, type Row, type ViewerTable } from '../storage/sql.ts';

export class DatabaseViewer {
  private client: DatabaseClient;
  private root: HTMLElement;
  private raw = false;
  private table: ViewerTable = 'app_events';
  private offset = 0;
  private generation = 0;
  private preview: StrokePreview | undefined;
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
  hide() {
    this.generation++;
    this.preview?.close();
    this.preview = undefined;
  }
  async refresh() {
    const generation = ++this.generation;
    this.preview?.close();
    this.preview = undefined;
    try {
      const [result, diagnostics] = await Promise.all([
        this.client.browse(this.table, this.offset),
        this.client.diagnostics(),
      ]);
      if (generation !== this.generation) return;
      this.root.replaceChildren();
      const heading = document.createElement('h2');
      heading.textContent = this.raw ? 'Raw stroke database' : 'Event database';
      const description = document.createElement('p');
      description.className = 'viewer-description';
      description.textContent = this.raw
        ? 'Captured observations only. data is an encoded BLOB; decoded_json is computed for inspection, never stored twice. Page, tool, paint and placement stay separate. Sample width/height are sensor contact dimensions.'
        : 'The actual SQLite rows. Select a row to inspect its fields and referenced shape states.';
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
        select.onchange = () => {
          this.table = select.value as ViewerTable;
          this.offset = 0;
          void this.refresh();
        };
        controls.append(select);
      }
      const previous = document.createElement('button'),
        next = document.createElement('button');
      previous.textContent = 'Previous';
      next.textContent = 'Next';
      previous.disabled = this.offset === 0;
      next.disabled = this.offset + 25 >= result.total;
      previous.onclick = () => {
        this.offset = Math.max(0, this.offset - 25);
        void this.refresh();
      };
      next.onclick = () => {
        this.offset += 25;
        void this.refresh();
      };
      const count = document.createElement('span');
      count.textContent = result.total
        ? this.offset +
          1 +
          '–' +
          Math.min(this.offset + result.rows.length, result.total) +
          ' of ' +
          result.total +
          ' rows'
        : 'No rows yet';
      const refresh = document.createElement('button');
      refresh.textContent = 'Refresh database';
      refresh.onclick = () => {
        void this.refresh();
      };
      controls.append(previous, next, count, refresh);
      const grid = document.createElement('div');
      grid.className = 'database-grid';
      const wrapper = document.createElement('div');
      wrapper.className = 'database-table';
      const table = document.createElement('table');
      table.setAttribute('aria-label', this.table);
      const head = table.createTHead().insertRow();
      const columns = result.rows.length ? Object.keys(result.rows[0]) : [];
      for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column;
        head.append(th);
      }
      const body = table.createTBody();
      const detail = document.createElement('div');
      detail.className = 'record-detail';
      detail.id = 'record-detail';
      for (const row of result.rows) {
        const tr = body.insertRow();
        tr.tabIndex = 0;
        for (const column of columns) {
          const cell = tr.insertCell(),
            value = row[column];
          const text =
            value instanceof Uint8Array
              ? value.byteLength + ' bytes (BLOB)'
              : value === null
                ? 'NULL'
                : String(value);
          cell.textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
        }
        const choose = () => {
          body.querySelectorAll('tr').forEach((item) => item.classList.toggle('selected', item === tr));
          void this.inspect(row, detail);
        };
        tr.onclick = choose;
        tr.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') choose();
        };
      }
      wrapper.append(table);
      grid.append(wrapper, detail);
      this.root.append(heading, description, diagnosticsPanel(diagnostics), controls, grid);
      if (result.rows.length) {
        body.rows[0].classList.add('selected');
        await this.inspect(result.rows[0], detail);
      }
    } catch (error) {
      if (generation === this.generation) this.root.textContent = String(error);
    }
  }
  private async inspect(row: Row, detail: HTMLElement) {
    this.preview?.close();
    this.preview = undefined;
    detail.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = this.table + (row.id === undefined ? '' : ' #' + row.id);
    const pre = document.createElement('pre');
    pre.id = 'record-json';
    const decoded: Record<string, unknown> = { ...row };
    for (const key of Object.keys(decoded)) {
      if (row[key] instanceof Uint8Array) {
        decoded[key] = { blobBytes: (row[key] as Uint8Array).byteLength };
        continue;
      }
      if (key.endsWith('_json') && typeof row[key] === 'string') {
        try {
          decoded[key] = JSON.parse(row[key] as string);
        } catch {
          /* show original bytes */
        }
      }
    }
    pre.textContent = JSON.stringify(decoded, null, 2);
    detail.append(heading);
    const preview = document.createElement('div');
    detail.append(preview, pre);
    if (this.table === 'stroke_events' && row.data_version === 1) {
      const outputs = await this.client.outputs(Number(row.id));
      if (!detail.contains(pre)) return;
      this.preview = new StrokePreview(preview, JSON.parse(String(row.decoded_json)) as InkData, outputs);
      const stored = document.createElement('details'),
        title = document.createElement('summary'),
        content = document.createElement('pre');
      title.textContent = 'Processed trace data (' + outputs.length + ')';
      content.setAttribute('aria-label', 'Processed trace data');
      content.textContent = JSON.stringify(
        outputs.map((output) => ({
          ...output,
          data_json: JSON.parse(String(output.data_json)),
          config_json: JSON.parse(String(output.config_json)),
        })),
        null,
        2,
      );
      stored.append(title, content);
      detail.append(stored);
    }
    if (this.table === 'app_events') {
      const [related, content] = await Promise.all([
        this.client.related(Number(row.id)),
        this.client.relatedContent(Number(row.id)),
      ]);
      if (!detail.contains(pre)) return; // selection changed while querying
      const label = document.createElement('h4'),
        effects = document.createElement('pre');
      label.textContent = 'Referenced shape states';
      effects.id = 'event-effects';
      effects.textContent = JSON.stringify(related, null, 2);
      detail.append(label, effects);
      if (content.objects.length || content.boxes.length) {
        const heading = document.createElement('h4'),
          linked = document.createElement('pre');
        heading.textContent = 'Referenced content and detections';
        linked.id = 'event-content';
        linked.textContent = JSON.stringify(content, null, 2);
        detail.append(heading, linked);
      }
    }
  }
}
