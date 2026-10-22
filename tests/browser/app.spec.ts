import { SCHEMA_IDENTITY } from '../../src/storage/schema.ts';
import type { InkData } from '../../src/model.ts';
import type { Row } from '../../src/storage/sql.ts';
import '../../src/node-trace-codecs.ts';
import { tracePayloads } from '../../src/trace-codecs.ts';
import { test as base, expect, webkit, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WebKit's ephemeral test contexts do not support OPFS. Exercise persistence
// in an isolated on-disk profile instead; never use the user's Safari profile.
const test = base.extend({
  context: async ({ context, browserName, baseURL, viewport, acceptDownloads }, use) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), 'event-draw-browser-'));
    const persistent = await webkit.launchPersistentContext(directory, {
      baseURL, viewport: viewport ?? undefined, acceptDownloads,
    });
    try {
      // WebKit's default data store can retain origin data between launches.
      // Reset only this prototype's directory in the isolated test browser.
      const reset = await persistent.newPage();
      await reset.route('**/__test_reset__', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Test storage reset</title>',
      }));
      await reset.goto(new URL('/__test_reset__', baseURL).href);
      await reset.evaluate(async () => {
        localStorage.clear();
        const root = await navigator.storage.getDirectory();
        try { await root.removeEntry('event-draw-v1', { recursive: true }); }
        catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
        }
      });
      await reset.close();
      await use(persistent);
    }
    finally {
      await persistent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

async function stroke(page: Page, points = [[100, 150], [500, 150]]) {
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await menu(page, false);
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = false; });
  const canvas = page.locator('#canvas');
  // A tall page can intersect the viewport while its drawing start is above it
  // (notably after reloading with the footer scrolled into view).
  await canvas.evaluate((c) => c.scrollIntoView({ block: 'start' }));
  const box = (await canvas.boundingBox())!;
  const view = await canvas.evaluate((c) => [Number((c as HTMLCanvasElement).dataset.viewWidth), Number((c as HTMLCanvasElement).dataset.viewHeight)]);
  const positions = points.map(([x, y]) => ({ x: box.x + x / view[0] * box.width,
    y: box.y + y / view[1] * box.height }));
  await page.mouse.move(positions[0].x, positions[0].y);
  await page.mouse.down();
  for (const p of positions.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

async function menu(page: Page, open = true) {
  if (await page.locator('#options').evaluate((e) => (e as HTMLDetailsElement).open) !== open) await page.locator('#options > summary').click();
}
async function tab(page: Page, name: string) {
  await menu(page);
  await page.locator('[data-tab="' + name + '"]').click();
}
async function clearPage(page: Page) {
  await menu(page, false);
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = true; });
  await page.locator('#clear').click();
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = false; });
}
async function download(page: Page, id: string) {
  if (id !== '#export-existing') await menu(page);
  if (id !== '#export-existing') await page.locator('.export-menu').evaluate((e)=>{(e as HTMLDetailsElement).open=true;});
  const next = page.waitForEvent('download');
  await page.locator(id).click();
  const path = await (await next).path();
  await menu(page, false);
  return path;
}
async function exported(page: Page, id = '#export-full') {
  return new DatabaseSync(await download(page, id));
}

test('draw, reload, inspect raw and app rows, undo, and compact with identical rendering', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  await stroke(page);
  await stroke(page, [[100, 220], [450, 260]]);
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 2 raw strokes · \d+ events$/);
  const drawing = await page.locator('#canvas').screenshot();
  await page.reload();
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 2 raw strokes · \d+ events$/);
  expect(await page.locator('#canvas').screenshot()).toEqual(drawing);
  await tab(page, 'events');
  await expect(page.getByRole('table', { name: 'app_events', exact: true })).toBeVisible();
  await page.getByRole('table', { name: 'app_events', exact: true }).locator('tbody tr').filter({ hasText: 'stroke.add' }).first().click();
  await expect(page.locator('#record-json')).toContainText('stroke.add');
  await expect(page.locator('#event-effects')).toContainText('offset_x');
  await tab(page, 'raw');
  await expect(page.getByRole('table', { name: 'stroke_events', exact: true })).toBeVisible();
  await expect(page.locator('#record-json')).toContainText('deliveries');
  await expect(page.getByLabel('Neutral raw stroke preview')).toBeVisible();
  await expect.poll(() => page.getByLabel('Neutral raw stroke preview').evaluate((canvas) => {
    const c = canvas as HTMLCanvasElement;
    return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((n, i) => i % 4 === 3 && n > 0);
  })).toBe(true);
  await page.screenshot({ path: 'test-results/raw-viewer.png', fullPage: true });
  await page.locator('#return-notebook').click();
  await clearPage(page);
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('2 visible');
  expect(await page.locator('#canvas').screenshot()).toEqual(drawing);
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toHaveText(/^1 visible · 2 raw strokes · \d+ events$/);
  const full = await exported(page), snapshot = await exported(page, '#export-visible');
  try {
    const visible = 'SELECT * FROM visible_shapes ORDER BY paint_order, id';
    expect(snapshot.prepare(visible).all()).toEqual(full.prepare(visible).all());
    expect(full.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(8);
    expect(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(1);
    expect(snapshot.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
    expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    expect(full.prepare('PRAGMA table_info(stroke_events)').all().map((r) => r.name))
      .toEqual(['id', 'capture_session_id', 'data_version', 'data_codec', 'decoded_bytes', 'data']);
    const data = tracePayloads.unpack(full.prepare('SELECT * FROM stroke_events LIMIT 1').get()! as Row) as InkData;
    expect(Object.keys(data)).toEqual(['deliveries']);
    expect(data.deliveries[0].reported.x).toBe(0);
    expect(data.deliveries[0].reported.clientX).toBeGreaterThan(0);
    expect(data.deliveries.length).toBeGreaterThan(2);
  } finally { full.close(); snapshot.close(); }
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/notebook.png', fullPage: true });
});

test('both erasers split or delete geometry and undo restores original raw references', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await page.getByRole('button', { name: 'Erase parts', exact: true }).click();
  await stroke(page, [[300, 120], [300, 180]]);
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 2 raw strokes · \d+ events$/);
  const split = await exported(page);
  try {
    const rows = split.prepare('SELECT * FROM visible_shapes ORDER BY start_index').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].raw_stroke_id).toBe(rows[1].raw_stroke_id);
    expect(Number(rows[0].end_index)).toBeLessThan(Number(rows[1].start_index));
    expect(split.prepare('SELECT tool FROM app_events ORDER BY id DESC LIMIT 1').get()!.tool).toBe('erase-parts');
  } finally { split.close(); }
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
  await page.getByRole('button', { name: 'Erase whole strokes', exact: true }).click();
  await stroke(page, [[300, 120], [300, 180]]);
  await expect(page.locator('#counts')).toHaveText(/^0 visible · 3 raw strokes · \d+ events$/);
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
});

test('pages share one journal and whiteboards pan/zoom independently of raw geometry', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await menu(page);
  await page.locator('#page-size').selectOption('landscape');
  await page.locator('#add-page').click();
  await menu(page, false);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#canvas')).toHaveAttribute('data-view-width', '842');
  await expect(page.locator('#canvas')).toHaveAttribute('data-view-height', '595');
  await expect(page.locator('#counts')).toContainText('0 visible');
  await stroke(page, [[100, 100], [400, 100]]);
  await clearPage(page);
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.locator('#page-number').fill('1');
  await page.locator('#page-number').press('Enter');
  await expect(page.locator('#counts')).toContainText('1 visible');
  await menu(page);
  await page.locator('#page-size').selectOption('whiteboard');
  await page.locator('#add-page').click();
  await menu(page, false);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.getByRole('button', { name: 'Pan board', exact: true }).click();
  await stroke(page, [[100, 100], [300, 200]]);
  // Pointer coordinates can round to CSS pixels after fitting the viewport.
  await expect.poll(async () => {
    const position = (await page.locator('#view-position').textContent())!.match(/x (-?\d+), y (-?\d+)/)!;
    return Math.max(Math.abs(Number(position[1]) + 200), Math.abs(Number(position[2]) + 100));
  }).toBeLessThan(2);
  await page.locator('#zoom-in').click();
  await expect(page.locator('#view-position')).toContainText('125%');
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await stroke(page);
  const full = await exported(page), snapshot = await exported(page, '#export-visible');
  try {
    expect(full.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(3);
    expect(full.prepare('SELECT DISTINCT page_id FROM app_events WHERE page_id IS NOT NULL ORDER BY page_id').all().map((r) => r.page_id)).toEqual([1, 2, 3]);
    expect(snapshot.prepare('SELECT * FROM pages').all()).toEqual(full.prepare('SELECT * FROM pages').all());
    expect(snapshot.prepare('SELECT * FROM visible_shapes ORDER BY id').all())
      .toEqual(full.prepare('SELECT * FROM visible_shapes ORDER BY id').all());
  } finally { full.close(); snapshot.close(); }
});

test('narrow touch layout preserves cancelled pen observations without displaying them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const tools = page.getByRole('group', { name: 'Tools', exact: true });
  await expect(tools.getByRole('button')).toHaveCount(8);
  for (const button of await tools.getByRole('button').all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: 'test-results/tool-buttons-mobile.png', fullPage: true });
  await page.locator('#canvas').evaluate((canvas) => {
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const options = { pointerId: 8, pointerType: 'pen', isPrimary: true, bubbles: true,
      clientX: rect.left + 50, clientY: rect.top + 60, button: 0, buttons: 1,
      pressure: 0.83, tiltX: 23, tiltY: -12 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', options));
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: rect.left + 100 }));
    canvas.dispatchEvent(new PointerEvent('pointercancel', options));
  });
  await expect(page.locator('#counts')).toHaveText(/^0 visible · 1 raw strokes · \d+ events$/);
  await menu(page);
  await page.locator('#diagnostics summary').click();
  const details = JSON.parse((await page.locator('#sample-info').textContent())!);
  expect(details.lastReported.pressure).toBeCloseTo(0.83, 6);
  expect(details.status).toBe('cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('tool buttons support keyboard selection, contextual controls, and drawing/page constraints', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const tools = page.getByRole('group', { name: 'Tools', exact: true });
  const pen = tools.getByRole('button', { name: 'Pen', exact: true });
  const lasso = tools.getByRole('button', { name: 'Lasso select', exact: true });
  const pan = tools.getByRole('button', { name: 'Pan board', exact: true });
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await expect(pan).toBeDisabled();
  await lasso.focus();
  await page.keyboard.press('Space');
  await expect(lasso).toHaveAttribute('aria-pressed', 'true');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#selection-controls')).toBeVisible();
  await expect(page.locator('#color-control')).toBeHidden();
  await tools.getByRole('button', { name: 'Erase parts', exact: true }).click();
  await page.locator('#ink-settings > summary').click();
  await expect(page.getByLabel('Eraser radius')).toBeVisible();
  await page.locator('#ink-settings > summary').click();
  await expect(page.locator('#selection-controls')).toBeHidden();
  await menu(page);
  await page.locator('#page-size').selectOption('whiteboard');
  await page.locator('#add-page').click();
  await menu(page, false);
  await expect(pan).toBeEnabled();
  await pan.focus();
  await page.keyboard.press('Enter');
  await expect(pan).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#page-number').fill('1');
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect(page.locator('#page-number')).toHaveValue('1');
  await page.locator('#page-number').press('Enter');
  await expect(pan).toBeDisabled();
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#ink-settings > summary').click();
  await expect(page.getByLabel('Pen width')).toBeVisible();
  await page.locator('#ink-settings > summary').click();
  await page.locator('#canvas').evaluate((c) => c.scrollIntoView({ block: 'start' }));
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 100);
  await page.mouse.down();
  for (const button of await tools.getByRole('button').all()) await expect(button).toBeDisabled();
  await page.mouse.move(box.x + 120, box.y + 120);
  await page.mouse.up();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(pen).toBeEnabled();
  await expect(pan).toBeDisabled();
  await expect(page.locator('#counts')).toContainText('1 visible');
});

test('a second tab is blocked rather than silently drawing into an unrelated database', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  const other = await page.context().newPage();
  await other.goto('./');
  await expect(other.locator('#storage')).toHaveText('Open in another tab');
  await expect(other.locator('#notice')).toContainText('Close that tab');
  await expect(other.getByRole('button', { name: 'Pen', exact: true })).toBeDisabled();
  await expect(other.locator('#reset-settings')).toBeDisabled();
  await page.close();
  await other.reload();
  await expect(other.locator('#storage')).toHaveText('Stored on this device');
  await other.close();
});

test('reset is explicit, cancellation preserves data, and reset persists across reloads', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await menu(page);
  await page.locator('.local-state summary').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#reset-settings').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reset-settings').click();
  await expect(page.locator('#counts')).toHaveText(/^0 visible · 0 raw strokes · \d+ events$/);
  await page.reload();
  await expect(page.locator('#counts')).toHaveText(/^0 visible · 0 raw strokes · \d+ events$/);
  await stroke(page);
  await expect(page.locator('#counts')).toContainText('1 visible');
});

test('an unsupported on-disk schema can be exported and reset from the error screen', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await page.route('**/__test_closed__', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Closed notebook</title>' }));
  await page.goto('/__test_closed__');
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0)).toBe(0);
  // Change only the schema-family UUID in this isolated test origin.
  // The first occurrence is the schema_identity row; its length stays unchanged.
  const changed = await page.evaluate(async (uuid) => {
    async function change(directory: FileSystemDirectoryHandle): Promise<boolean> {
      const entries = directory as unknown as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [, entry] of entries) {
        if (entry.kind === 'directory') {
          if (await change(entry as FileSystemDirectoryHandle)) return true;
        } else {
          const file = entry as FileSystemFileHandle;
          const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
          const magic = new TextEncoder().encode(uuid);
          for (let offset = 0; offset + magic.length <= bytes.length; offset++) {
            if (!magic.every((byte, index) => bytes[offset + index] === byte)) continue;
            bytes[offset] = '0'.charCodeAt(0);
            const writer = await file.createWritable();
            await writer.write(bytes); await writer.close();
            return true;
          }
        }
      }
      return false;
    }
    const root = await navigator.storage.getDirectory();
    return change(await root.getDirectoryHandle('event-draw-v1'));
  }, SCHEMA_IDENTITY.uuid);
  expect(changed).toBe(true);
  await page.goto('./');
  await expect(page.locator('#notice')).toContainText('Unsupported notebook schema: 0' + SCHEMA_IDENTITY.uuid.slice(1));
  await expect(page.locator('#reset-local')).toBeVisible();
  const old = await exported(page, '#export-existing');
  try {
    expect(old.prepare('SELECT uuid FROM schema_identity').get()!.uuid).toBe('0' + SCHEMA_IDENTITY.uuid.slice(1));
    expect(old.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
  } finally { old.close(); }
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reset-local').click();
  await expect(page.locator('#counts')).toHaveText(/^0 visible · 0 raw strokes · \d+ events$/);
  await expect(page.locator('#notice')).toBeHidden();
  await stroke(page);
  await page.reload();
  await expect(page.locator('#counts')).toHaveText(/^1 visible · 1 raw strokes · \d+ events$/);
});

test('lasso selects ink, dragging changes placement only, and deletion and movement undo separately', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await stroke(page, [[100, 300], [500, 300]]);
  const before = await exported(page);
  const raw = before.prepare('SELECT * FROM stroke_events ORDER BY id').all();
  const original = before.prepare('SELECT * FROM visible_shapes WHERE id = 1').get()!;
  before.close();
  await page.getByRole('button', { name: 'Lasso select', exact: true }).click();
  await stroke(page, [[250, 120], [350, 120], [350, 180], [250, 180], [250, 120]]);
  await expect(page.locator('#selection-count')).toHaveText('1 selected');
  await stroke(page, [[300, 150], [350, 230]]);
  await expect(page.locator('#selection-count')).toHaveText('1 selected');
  const moved = await exported(page), compact = await exported(page, '#export-visible');
  try {
    expect(moved.prepare('SELECT * FROM stroke_events WHERE id <= 2 ORDER BY id').all()).toEqual(raw);
    const current = moved.prepare('SELECT * FROM visible_shapes WHERE id = 1').get()!;
    expect(current.raw_stroke_id).toBe(original.raw_stroke_id);
    // WebKit rounds synthetic mouse coordinates to CSS pixels.
    expect(Math.abs(Number(current.offset_x) - Number(original.offset_x) - 50)).toBeLessThan(2);
    expect(Math.abs(Number(current.offset_y) - Number(original.offset_y) - 80)).toBeLessThan(2);
    expect(moved.prepare('SELECT kind FROM app_events ORDER BY id').all().map((r) => r.kind))
      .toEqual(['notebook.create', 'app.open', 'stroke.add', 'stroke.add', 'selection.lasso', 'selection.move']);
    expect(moved.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(4);
    expect(compact.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(2);
    expect(compact.prepare('SELECT * FROM visible_shapes ORDER BY id').all())
      .toEqual(moved.prepare('SELECT * FROM visible_shapes ORDER BY id').all());
  } finally { moved.close(); compact.close(); }
  await page.screenshot({ path: 'test-results/lasso-selection.png', fullPage: true });
  await page.locator('#delete-selection').click();
  await expect(page.locator('#counts')).toHaveText(/^1 visible · 4 raw strokes · \d+ events$/);
  await expect(page.locator('#selection-count')).toHaveText('0 selected');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('2 visible');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 4 raw strokes · \d+ events$/);
  const restored = await exported(page);
  try { expect(restored.prepare('SELECT * FROM visible_shapes WHERE id = 1').get()).toEqual(original); }
  finally { restored.close(); }
  await page.reload();
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 4 raw strokes · \d+ events$/);
});

const pdfFixture = new URL('../fixtures/pages.pdf', import.meta.url);
test('PDF file and URL imports deduplicate by hash; annotations survive navigation, zoom, reload and compact export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bytes = readFileSync(pdfFixture), hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#page-heading')).toHaveText('/1');
  await menu(page);
  await page.locator('#pdf-file').setInputFiles(pdfFixture.pathname);
  await expect(page.locator('#document')).toHaveValue('2');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#page-total')).toHaveText('/ 3');
  await expect(page.locator('#document-hash')).toHaveText(hash);
  await expect(page.locator('#blank-page-controls')).not.toHaveAttribute('hidden');
  await expect(page.locator('#canvas')).toHaveAttribute('data-view-width', '600');
  const painted = () => page.locator('#pdf-canvas').evaluate((c) => {
    const canvas = c as HTMLCanvasElement;
    const pixel = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), 20, 1, 1).data;
    return pixel[0] < 100 && pixel[2] > 60 && pixel[3] === 255;
  });
  await expect.poll(painted).toBe(true);
  await stroke(page, [[100, 200], [450, 240]]);
  const drawing = await page.locator('#canvas').screenshot();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#home-view').click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect(await page.locator('#canvas').screenshot()).toEqual(drawing);
  await page.locator('#next-page').click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#canvas')).toHaveAttribute('data-view-width', '840');
  await expect(page.locator('#counts')).toContainText('0 visible');
  await stroke(page, [[120, 200], [500, 250]]);
  await page.reload();
  await expect(page.locator('#document')).toHaveValue('2');
  await expect(page.locator('#page-number')).toHaveValue('2');
  await expect(page.locator('#counts')).toContainText('1 visible');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect.poll(painted).toBe(true);
  await page.locator('#previous-page').click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect(await page.locator('#canvas').screenshot()).toEqual(drawing);
  await page.setViewportSize({ width: 820, height: 1050 });
  await expect.poll(painted).toBe(true);
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: 'test-results/pdf-annotation.png', fullPage: true });
  // Importing the same bytes under a different URL/name reopens its document.
  await page.route('**/another-name.pdf', (route) => route.fulfill({ contentType: 'application/pdf', body: bytes }));
  await menu(page);
  await page.locator('#pdf-url').fill(new URL('/another-name.pdf', page.url()).href);
  await page.locator('#import-url').click();
  await expect(page.locator('#options')).not.toHaveAttribute('open', '');
  await expect(page.locator('#document option')).toHaveCount(2);
  await expect(page.locator('#counts')).toHaveText(/^1 visible · 2 raw strokes · \d+ events$/);
  const full = await exported(page), snapshot = await exported(page, '#export-visible');
  try {
    for (const table of ['assets', 'documents', 'pages', 'visible_shapes']) {
      expect(snapshot.prepare('SELECT * FROM ' + table).all()).toEqual(full.prepare('SELECT * FROM ' + table).all());
    }
    expect(Buffer.from(full.prepare('SELECT data FROM assets').get()!.data as Uint8Array)).toEqual(bytes);
    expect(full.prepare('SELECT hash FROM assets').get()!.hash).toBe(hash);
    expect(full.prepare('SELECT source_page, width, height FROM pages WHERE document_id = 2 ORDER BY page_number').all())
      .toEqual([{ source_page: 1, width: 600, height: 800 }, { source_page: 2, width: 840, height: 500 }, { source_page: 3, width: 500, height: 700 }]);
    expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(1);
  } finally { full.close(); snapshot.close(); }
  expect(errors).toEqual([]);
});

test('failed URL and malformed PDF imports keep the notebook usable and intact', async ({ page }) => {
  await page.goto('./');
  await stroke(page);
  await page.route('**/unavailable.pdf', (route) => route.abort());
  await menu(page);
  await page.locator('#pdf-url').fill(new URL('/unavailable.pdf', page.url()).href);
  await page.locator('#import-url').click();
  await expect(page.locator('#notice')).toContainText('CORS');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#pdf-file').setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invalid PDF') });
  await expect(page.locator('#notice')).toContainText('Invalid PDF');
  await expect(page.locator('#document option')).toHaveCount(1);
  await stroke(page, [[100, 250], [450, 250]]);
  await expect(page.locator('#counts')).toHaveText(/^2 visible · 2 raw strokes · \d+ events$/);
});

test('blank document names, page ordering and deletion are separate from annotation identity', async ({ page }) => {
  await page.goto('./');
  await stroke(page);
  await menu(page);
  await page.locator('#document-name').fill('Notebook');
  await page.locator('#rename-document').click();
  await expect(page.locator('#page-heading')).toHaveText('Notebook/1');
  await page.locator('#add-page').click();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.locator('#page-earlier').click();
  await expect(page.locator('#page-number')).toHaveValue('1');
  await menu(page, false);
  await page.locator('#next-page').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
  await menu(page);
  page.once('dialog', (d) => d.accept());
  await page.locator('#delete-page').click();
  await expect(page.locator('#page-total')).toHaveText('/ 1');
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.locator('#new-document').click();
  await expect(page.locator('#document')).toHaveValue('2');
  await expect(page.locator('#page-heading')).toHaveText('Notes/1');
  const full = await exported(page);
  try {
    expect(full.prepare('SELECT page_id FROM app_event_shapes WHERE visible = 1').get()!.page_id).toBe(1);
    expect(full.prepare('SELECT deleted FROM pages WHERE id = 1').get()!.deleted).toBe(1);
    expect(full.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
  } finally { full.close(); }
});

test('database diagnostics and timestamped raw replay are read-only and cancel on navigation', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#canvas').evaluate((canvas) => {
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    for (const [i, type] of ['pointerdown', 'pointermove', 'pointerup'].entries()) {
      const event = new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true,
        clientX: rect.left + 50 + i * 70, clientY: rect.top + 80 + i * 30, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, pressure: 0.6 });
      Object.defineProperty(event, 'timeStamp', { value: 1000 + i * 1000 });
      canvas.dispatchEvent(event);
    }
  });
  await expect(page.locator('#counts')).toHaveText(/^1 visible · 1 raw strokes · \d+ events$/);
  const before = await exported(page), raw = before.prepare('SELECT * FROM stroke_events').all();
  const eventCount = before.prepare('SELECT count(*) AS n FROM app_events').get()!.n; before.close();
  await tab(page, 'raw');
  const diagnostics = page.getByRole('region', { name: 'Database diagnostics', exact: true });
  await expect(diagnostics).toContainText('1 / 1 (100.0%)');
  await expect(diagnostics).toContainText('all documents');
  const canvas = page.getByLabel('Neutral raw stroke preview');
  await expect(canvas).toHaveAttribute('data-replayed-samples', '3');
  const full = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.getByLabel('Replay speed').fill('4');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect(page.locator('.replay-status')).toContainText('Replaying');
  await expect.poll(() => canvas.getAttribute('data-replayed-samples')).toBe('1');
  await expect(page.locator('.replay-status')).toHaveText('Replay complete');
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL())).toEqual(full);
  await page.getByLabel('Replay speed').fill('0.25');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(page.locator('.replay-status')).toContainText('Paused');
  const paused = await canvas.getAttribute('data-replayed-samples');
  await page.waitForTimeout(100);
  await expect(canvas).toHaveAttribute('data-replayed-samples', paused!);
  await page.getByLabel('Replay speed').fill('2');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect(page.locator('.replay-status')).toContainText('Replaying');
  await page.getByRole('button', { name: 'Stop replay', exact: true }).click();
  await expect(page.locator('.replay-status')).toHaveText('Full capture');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh database', exact: true }).click();
  await expect(page.locator('.replay-status')).toHaveText('Full capture');
  await page.screenshot({ path: 'test-results/raw-replay-diagnostics.png', fullPage: true });
  await page.locator('.stroke-preview').screenshot({ path: 'test-results/stroke-playback.png' });
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.locator('#return-notebook').click();
  const after = await exported(page);
  try {
    expect(after.prepare('SELECT * FROM stroke_events').all()).toEqual(raw);
    expect(after.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(eventCount);
  } finally { after.close(); }
});

async function penTrace(page: Page) {
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#canvas').evaluate((canvas) => {
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    try {
      const c = canvas as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
      const points = [[100, 160, .1], [200, 200, .9], [300, 130, .2], [400, 160, 0]];
      points.forEach(([x, y, pressure], i) => {
        const type = i === 0 ? 'pointerdown' : i === points.length - 1 ? 'pointerup' : 'pointermove';
        const event = new PointerEvent(type, { pointerId: 77, pointerType: 'pen', isPrimary: true, bubbles: true,
          clientX: rect.left + x / Number(c.dataset.viewWidth) * rect.width,
          clientY: rect.top + y / Number(c.dataset.viewHeight) * rect.height,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure });
        Object.defineProperty(event, 'timeStamp', { value: 1000 + i * 1000 });
        canvas.dispatchEvent(event);
      });
    } finally { canvas.setPointerCapture = capture; }
  });
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

test('pressure output and per-trace experimental comparison replay without writing history', async ({ page }) => {
  await page.goto('./');
  await penTrace(page);
  const before = await exported(page);
  const original = before.prepare('SELECT * FROM stroke_events').all();
  const eventCount = before.prepare('SELECT count(*) AS n FROM app_events').get()!.n;
  try {
    const output = JSON.parse(before.prepare('SELECT data_json FROM ink_outputs').get()!.data_json as string);
    expect(output.points.map((p: { widthFactor: number }) => p.widthFactor)).toEqual(expect.arrayContaining([
      expect.closeTo(.48, 5), expect.closeTo(1.52, 5), expect.closeTo(.61, 5),
    ]));
  } finally { before.close(); }
  await tab(page, 'raw');
  const raw = page.getByLabel('Neutral raw stroke preview'), processed = page.getByLabel('Processed stroke preview');
  await expect(processed).toHaveAttribute('data-replayed-samples', '4');
  const unsmoothed = await processed.screenshot();
  await page.getByText('Processor', { exact: true }).click();
  await page.getByLabel('Preview Smoothing policy').selectOption('moving-average@1');
  await page.getByRole('button', { name: 'Preview policies', exact: true }).click();
  await expect(page.locator('.output-status')).toHaveText('Experimental preview · not saved');
  expect(await processed.screenshot()).not.toEqual(unsmoothed);
  await page.getByLabel('Replay speed').fill('4');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect(raw).toHaveAttribute('data-replayed-samples', '1');
  await expect(processed).toHaveAttribute('data-replayed-samples', '1');
  await expect(page.locator('.replay-status')).toHaveText('Replay complete');
  await page.screenshot({ path: 'test-results/processing-comparison.png', fullPage: true });
  await page.locator('#return-notebook').click();
  const after = await exported(page);
  try {
    expect(after.prepare('SELECT * FROM stroke_events').all()).toEqual(original);
    expect(after.prepare('SELECT count(*) AS n FROM ink_outputs').get()!.n).toBe(1);
    expect(after.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(eventCount);
  } finally { after.close(); }
});

test('highlighter has uniform per-contact translucency and touch restyling retains trace/output identity', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Highlighter', exact: true }).click();
  await stroke(page);
  const alphas = await page.locator('#canvas').evaluate((element) => {
    const c = element as HTMLCanvasElement, context = c.getContext('2d')!;
    return [120, 250, 400].map((x) => context.getImageData(Math.round(x / Number(c.dataset.viewWidth) * c.width),
      Math.round(150 / Number(c.dataset.viewHeight) * c.height), 1, 1).data[3]);
  });
  for (const alpha of alphas) expect(Math.abs(alpha - .28 * 255)).toBeLessThan(2);
  const before = await exported(page), original = before.prepare('SELECT * FROM visible_shapes').get()!;
  const raw = before.prepare('SELECT * FROM stroke_events').all(); before.close();
  expect(original.opacity).toBe(.28); expect(original.line_width).toBe(24);
  await page.getByRole('button', { name: 'Restyle on touch', exact: true }).click();
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = true; });
  await page.locator('#color').fill('#dd2233');
  await stroke(page, [[300, 100], [300, 200]]);
  const after = await exported(page);
  try {
    const shape = after.prepare('SELECT * FROM visible_shapes').get()!;
    expect(shape.color).toBe('#dd2233'); expect(shape.opacity).toBe(1);
    expect(shape.id).toBe(original.id); expect(shape.output_id).toBe(original.output_id);
    expect(after.prepare('SELECT * FROM stroke_events WHERE id=1').all()).toEqual(raw);
    expect(after.prepare('SELECT kind FROM app_events ORDER BY id DESC LIMIT 1').get()!.kind).toBe('shape.touch');
  } finally { after.close(); }
  await page.locator('#undo').click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const undone = await exported(page);
  try { expect(undone.prepare('SELECT * FROM visible_shapes').get()).toEqual(original); }
  finally { undone.close(); }
});

test('selected traces get a new immutable processing version as one undoable edit', async ({ page }) => {
  await page.goto('./'); await penTrace(page);
  await page.getByRole('button', { name: 'Lasso select', exact: true }).click();
  await stroke(page, [[80, 100], [450, 100], [450, 230], [80, 230], [80, 100]]);
  await expect(page.locator('#selection-count')).toHaveText('1 selected');
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = true; });
  await page.getByLabel('Smoothing policy', { exact: true }).selectOption('moving-average@1');
  await page.getByLabel('Lasso policy').selectOption('vertices-inside@1');
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = false; });
  await page.locator('#apply-processing').click();
  await expect(page.locator('#selection-count')).toHaveText('0 selected');
  const current = await exported(page), compact = await exported(page, '#export-visible');
  try {
    expect(current.prepare('SELECT count(*) AS n FROM ink_outputs').get()!.n).toBe(2);
    expect(current.prepare('SELECT kind FROM app_events ORDER BY id DESC LIMIT 1').get()!.kind).toBe('ink.reprocess');
    expect(compact.prepare('SELECT * FROM visible_shapes').all()).toEqual(current.prepare('SELECT * FROM visible_shapes').all());
    expect(compact.prepare('SELECT count(*) AS n FROM ink_outputs').get()!.n).toBe(1);
    expect(current.prepare('SELECT output_id FROM visible_shapes').get()!.output_id).toBe(2);
  } finally { current.close(); compact.close(); }
  await page.locator('#undo').click(); await expect(page.locator('#save-state')).toHaveText('Saved');
  const undone = await exported(page);
  try { expect(undone.prepare('SELECT output_id FROM visible_shapes').get()!.output_id).toBe(1); }
  finally { undone.close(); }
});

test('Markdown/math notes autosave, survive page changes and reload, export drafts immediately, and undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
  await page.goto('./'); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click();
  await page.locator('#add-page-text').click();
  const source = page.getByRole('textbox', { name: 'Text source', exact: true });
  await source.fill('# Variables\n\n**Given** $x=5$\n\n<script>alert(1)</script>');
  await expect(page.locator('#text-preview h1')).toHaveText('Variables');
  await expect(page.locator('#text-preview strong')).toHaveText('Given');
  await expect(page.locator('#text-preview .katex')).toHaveCount(1);
  await expect(page.locator('#text-preview script')).toHaveCount(0);
  await expect(page.locator('#text-status')).toHaveText('Saved');
  await source.fill('# Latest\n$2x=10$');
  const immediate = await exported(page); // flushes without waiting for debounce
  try { expect(immediate.prepare("SELECT json_extract(data_json, '$.source') AS source FROM visible_objects").get()!.source).toBe('# Latest\n$2x=10$'); }
  finally { immediate.close(); }
  await menu(page); await page.locator('#add-page').click(); await menu(page, false);
  await expect(page.locator('#page-number')).toHaveValue('2'); await expect(source).toHaveValue('');
  await page.locator('#add-linked-note').click();
  await source.fill('Second page');
  // Navigation flushes a dirty draft, preserving its page association.
  await page.locator('#previous-page').click();
  await expect(source).toHaveValue('# Latest\n$2x=10$');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#next-page').click(); await expect(source).toHaveValue('Second page');
  await page.locator('#undo').click(); await expect(source).toHaveValue('');
  await page.locator('#previous-page').click();
  await page.reload(); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click(); await expect(source).toHaveValue('# Latest\n$2x=10$');
  const full = await exported(page), compact = await exported(page, '#export-visible');
  try {
    expect(compact.prepare('SELECT * FROM visible_objects').all()).toEqual(full.prepare('SELECT * FROM visible_objects').all());
    expect(full.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(0);
    expect(compact.prepare('SELECT count(*) AS n FROM object_contents').get()!.n).toBe(2);
  } finally { full.close(); compact.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeVisible(); await expect(page.locator('#close-text')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: 'test-results/markdown-math-mobile.png', fullPage: true });
  await page.locator('#close-text').click(); await expect(source).toBeHidden();
  expect(errors).toEqual([]);
});

test('typing during an in-flight text save commits the latest draft without losing edits', async ({ page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
      if (message && typeof message === 'object' && 'method' in message && message.method === 'setObject') setTimeout(send, 350);
      else send();
    };
  });
  await page.goto('./'); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click();
  await page.locator('#add-page-text').click();
  const source = page.getByRole('textbox', { name: 'Text source', exact: true });
  await source.fill('First draft'); await page.locator('#save-text').click();
  await expect(page.locator('#text-status')).toHaveText('Saving…');
  await expect(source).toBeEnabled();
  await source.fill('Latest **during save** $x=5$');
  await expect(page.locator('#text-status')).toHaveText('Saved');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const full = await exported(page);
  try {
    expect(full.prepare("SELECT json_extract(data_json, '$.source') AS source FROM visible_objects").get()!.source).toBe('Latest **during save** $x=5$');
    expect(full.prepare('SELECT count(*) AS n FROM object_contents').get()!.n).toBe(3);
  } finally { full.close(); }
  await page.reload(); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click();
  await expect(source).toHaveValue('Latest **during save** $x=5$');
});

test('multiple linked notes and positioned text/math share content renderers, placement, deletion and undo', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./'); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click(); await page.locator('#add-page-text').click();
  const source = page.locator('#text-source');
  await source.fill('# On the page\n**Given** $x=5$'); await expect(page.locator('#text-status')).toHaveText('Saved');
  await expect(page.locator('.page-object h1')).toHaveText('On the page');
  await expect(page.locator('.page-object .katex')).toHaveCount(1);
  await page.locator('#add-linked-note').click(); await source.fill('First private note'); await expect(page.locator('#text-status')).toHaveText('Saved');
  await page.locator('#add-linked-note').click(); await source.fill('Second private note'); await expect(page.locator('#text-status')).toHaveText('Saved');
  await expect(page.locator('#content-object option')).toHaveCount(3); await expect(page.locator('.page-object')).toHaveCount(1);
  await page.getByLabel('Content object').selectOption('1');
  await expect(source).toHaveValue('# On the page\n**Given** $x=5$');
  await page.locator('.object-advanced > summary').click();
  await page.locator('#object-x').fill('150'); await page.locator('#object-y').fill('200');
  await page.locator('#object-rotation').fill('30'); await page.locator('#object-label').fill('Equation');
  await page.locator('#object-format').fill('math/latex'); await source.fill('x^2 + y^2 = 1');
  await expect(page.locator('#text-status')).toHaveText('Saved');
  await expect(page.locator('.page-object .katex')).toHaveCount(1);
  const rotation = await page.locator('.page-object').evaluate((e) => Number((e as HTMLElement).style.transform.match(/rotate\(([^r]+)rad\)/)?.[1]));
  expect(rotation).toBeCloseTo(Math.PI / 6, 5);
  await page.locator('#close-text').click();
  await page.locator('#zoom-in').click(); await page.locator('#home-view').click();
  await expect(page.locator('.page-object')).toBeVisible();
  await page.screenshot({ path: 'test-results/page-content.png', fullPage: true });
  const full = await exported(page), compact = await exported(page, '#export-visible');
  try {
    expect(full.prepare('SELECT rendered FROM visible_objects ORDER BY id').all()).toEqual([{ rendered: 1 }, { rendered: 0 }, { rendered: 0 }]);
    expect(full.prepare("SELECT json_extract(data_json, '$.source') AS source FROM visible_objects ORDER BY id").all()).toEqual([
      { source: 'x^2 + y^2 = 1' }, { source: 'First private note' }, { source: 'Second private note' },
    ]);
    expect(compact.prepare('SELECT * FROM visible_objects ORDER BY id').all()).toEqual(full.prepare('SELECT * FROM visible_objects ORDER BY id').all());
    expect(full.prepare('SELECT x, y, rotation, format FROM visible_objects WHERE id=1').get()).toEqual({ x: 150, y: 200, rotation: Math.PI / 6, format: 'math/latex' });
  } finally { full.close(); compact.close(); }
  await page.reload(); await expect(page.locator('.page-object .katex')).toHaveCount(1);
  await page.locator('#toggle-text').click(); await page.locator('#delete-object').click(); await expect(page.locator('.page-object')).toHaveCount(0);
  await page.locator('#undo').click(); await expect(page.locator('.page-object .katex')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('detected boxes link constituent strokes and finish/break events; erasure, undo, rotation and compact export preserve provenance', async ({ page }) => {
  await page.goto('./');
  for (const points of [[[100, 100], [400, 100]], [[400, 100], [400, 300]], [[400, 300], [100, 300]], [[100, 300], [100, 100]]]) await stroke(page, points);
  await expect(page.locator('.detected-box')).toHaveCount(1);
  await page.getByRole('button', { name: 'Lasso select', exact: true }).click();
  await page.getByRole('button', { name: 'Select strokes for box 1', exact: true }).click();
  await expect(page.locator('#selection-count')).toHaveText('4 selected');
  await page.getByRole('button', { name: 'Erase parts', exact: true }).click();
  await stroke(page, [[250, 50], [250, 140]]); await expect(page.locator('.detected-box')).toHaveCount(0);
  await page.locator('#undo').click(); await expect(page.locator('.detected-box')).toHaveCount(1);
  const full = await exported(page), compact = await exported(page, '#export-visible');
  try {
    expect(full.prepare("SELECT kind FROM app_events WHERE kind LIKE 'box.%' ORDER BY id").all()).toEqual([{ kind: 'box.finish' }, { kind: 'box.break' }, { kind: 'box.finish' }]);
    expect(full.prepare('SELECT * FROM box_shapes').all()).toHaveLength(4);
    expect(compact.prepare('SELECT * FROM active_boxes').all()).toEqual(full.prepare('SELECT * FROM active_boxes').all());
    expect(compact.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { full.close(); compact.close(); }
  await tab(page, 'events'); await expect(page.locator('#record-json')).toContainText('box.finish');
  await expect(page.locator('#event-content')).toContainText('raw_stroke_id');
  await page.locator('#return-notebook').click(); await clearPage(page);
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  const angle = Math.PI / 6;
  const points = [[-150, -90], [150, -90], [150, 90], [-150, 90], [-150, -90]].map(([x, y]) => [400 + x * Math.cos(angle) - y * Math.sin(angle), 300 + x * Math.sin(angle) + y * Math.cos(angle)]);
  await stroke(page, points); await expect(page.locator('.detected-box')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/rotated-box.png', fullPage: true });
  const rotated = await exported(page);
  try { expect(Math.abs(Number(rotated.prepare('SELECT rotation FROM active_boxes').get()!.rotation) - angle)).toBeLessThan(.02); }
  finally { rotated.close(); }
});

test('speed/pressure formulas are configurable in notebook and per-trace preview without changing raw samples', async ({ page }) => {
  await page.goto('./'); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = true; });
  await page.getByLabel('Pressure policy', { exact: true }).selectOption('pressure-speed@1');
  await page.getByLabel('Pressure weight', { exact: true }).fill('0'); await page.getByLabel('Speed weight', { exact: true }).fill('1');
  await page.getByLabel('Speed response', { exact: true }).selectOption('thicker-fast');
  await page.getByLabel('Weighting', { exact: true }).selectOption('geometric');
  await page.locator('#ink-settings').evaluate((e) => { (e as HTMLDetailsElement).open = false; });
  await penTrace(page);
  const full = await exported(page);
  try {
    const policy = JSON.parse(full.prepare('SELECT config_json FROM ink_policies').get()!.config_json as string);
    expect(policy.pressure.id).toBe('pressure-speed@1'); expect(policy.pressure.options).toMatchObject({ pressureWeight: 0, speedWeight: 1, direction: 'thicker-fast', mix: 'geometric' });
    const raw = JSON.stringify(tracePayloads.unpack(full.prepare('SELECT * FROM stroke_events').get()! as Row));
    expect(raw).not.toContain('speedWeight'); expect(raw).toContain('pressure');
  } finally { full.close(); }
  await tab(page, 'raw'); await page.getByText('Processor', { exact: true }).click();
  await page.getByLabel('Preview Pressure policy').selectOption('speed-width@1');
  await page.getByLabel('Preview Speed exponent').fill('2'); await page.getByRole('button', { name: 'Preview policies', exact: true }).click();
  await expect(page.locator('.output-status')).toHaveText('Experimental preview · not saved');
});

test('notebook files reopen atomically, recovery restores replacement, and drawn export omits linked notes',async({page})=>{
  const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  await page.goto('./');await stroke(page);await page.locator('#toggle-text').click();await page.locator('#add-linked-note').click();await page.locator('#text-source').fill('private provenance');await page.locator('#close-text').click();
  const path=await download(page,'#export-full'),bytes=readFileSync(path!);
  const drawn=await exported(page,'#export-drawn');try{expect(drawn.prepare('SELECT * FROM visible_shapes').all()).toHaveLength(1);expect(drawn.prepare('SELECT * FROM visible_objects').all()).toHaveLength(0);expect(drawn.prepare('SELECT * FROM app_events').all()).toHaveLength(1);}finally{drawn.close();}
  await menu(page);await page.locator('#new-notebook').click();await expect(page.locator('#counts')).toHaveText(/^0 visible · 0 raw strokes · \d+ events$/);
  await menu(page);await page.locator('#restore-backup').click();await expect(page.locator('#counts')).toContainText('1 visible');
  await menu(page);await page.locator('#notebook-file').setInputFiles({name:'Saved.sqlite3',mimeType:'application/vnd.sqlite3',buffer:bytes});await expect(page.locator('#notebook-name')).toHaveText('Saved.sqlite3');await expect(page.locator('#counts')).toContainText('1 visible');
  await menu(page);await page.locator('#notebook-file').setInputFiles({name:'bad.sqlite3',mimeType:'application/vnd.sqlite3',buffer:Buffer.from('not a database')});await expect(page.locator('#notice')).toContainText('Choose a SQLite notebook');await expect(page.locator('#counts')).toContainText('1 visible');
  await menu(page,false);await stroke(page,[[100,250],[500,250]]);await expect(page.locator('#counts')).toContainText('2 visible');
  const restyled=new DatabaseSync(path!);restyled.prepare('UPDATE styles SET color=?').run('#e14433');restyled.close();await menu(page);await page.locator('#notebook-file').setInputFiles({name:'Other colors.sqlite3',mimeType:'application/vnd.sqlite3',buffer:readFileSync(path!)});await expect(page.locator('#notebook-name')).toHaveText('Other colors.sqlite3');
  await expect.poll(() => page.locator('#canvas').evaluate((element) => {
    const c = element as HTMLCanvasElement;
    const sx = c.width / Number(c.dataset.viewWidth), sy = c.height / Number(c.dataset.viewHeight);
    // Resizing the page shifts the thin stroke between device pixels. Inspect
    // its neighborhood instead of requiring one antialiased edge pixel's RGB.
    const { data } = c.getContext('2d')!.getImageData(
      Math.floor(196 * sx), Math.floor(146 * sy), Math.ceil(8 * sx), Math.ceil(8 * sy),
    );
    for (let i = 0; i < data.length; i += 4)
      if (Math.abs(data[i] - 225) <= 2 && Math.abs(data[i + 1] - 68) <= 2 &&
          Math.abs(data[i + 2] - 51) <= 2 && data[i + 3] >= 64) return true;
    return false;
  })).toBe(true);
  const replaced = await exported(page);
  try {
    expect(replaced.prepare('SELECT color FROM styles').all()).toEqual([{ color: '#e14433' }]);
    expect(replaced.prepare('SELECT count(*) AS n FROM visible_shapes').get()!.n).toBe(1);
  } finally { replaced.close(); }
  expect(errors).toEqual([]);
});

test('mixed SVG, image, PDF and blank pages export as a portable notebook and annotated PDF',async({page})=>{
  const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  await page.goto('./');await expect(page.locator('#save-state')).toHaveText('Saved');
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#ffe080"/><circle cx="300" cy="200" r="80" fill="#c05040"/></svg>');
  await menu(page);await page.locator('#image-file').setInputFiles({name:'drawing.svg',mimeType:'image/svg+xml',buffer:svg});await expect(page.locator('#page-number')).toHaveValue('2');await expect(page.locator('#save-state')).toHaveText('Saved');await stroke(page,[[60,50],[500,70]]);
  await menu(page);await page.locator('#image-as-object').check();await page.locator('#image-file').setInputFiles({name:'object.svg',mimeType:'image/svg+xml',buffer:svg});await expect(page.locator('.page-object img')).toHaveCount(1);await expect(page.locator('.page-object img')).toBeVisible();await page.screenshot({path:'test-results/svg-page.png',fullPage:true});
  const png=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=400;canvas.height=300;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#90b0c0';ctx.fillRect(0,0,400,300);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
  await menu(page);await page.locator('#image-as-object').uncheck();await page.locator('#image-file').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:png});await expect(page.locator('#page-number')).toHaveValue('3');await expect(page.locator('#save-state')).toHaveText('Saved');await page.screenshot({path:'test-results/image-page.png',fullPage:true});
  await menu(page);await page.locator('#insert-pdf').check();await page.locator('#pdf-file').setInputFiles(pdfFixture.pathname);await expect(page.locator('#page-total')).toHaveText('/ 6');
  await menu(page);await page.locator('#add-page').click();await expect(page.locator('#page-total')).toHaveText('/ 7');await page.locator('#page-earlier').click();await menu(page,false);await expect(page.locator('#page-number')).toHaveValue('4');
  const db=await exported(page);try{expect(db.prepare('SELECT count(*) AS n FROM blobs').get()!.n).toBe(3);expect(db.prepare('SELECT source_kind FROM current_pages WHERE deleted=0 ORDER BY page_number').all()).toEqual([{source_kind:'blank'},{source_kind:'svg'},{source_kind:'image'},{source_kind:'blank'},{source_kind:'pdf'},{source_kind:'pdf'},{source_kind:'pdf'}]);expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);}finally{db.close();}
  const pdfPath=await download(page,'#export-pdf');const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.load(readFileSync(pdfPath!));expect(pdf.getPageCount()).toBe(7);expect(pdf.getPage(1).getSize()).toEqual({width:600,height:400});
  await menu(page);await page.locator('.export-menu').evaluate((e)=>{(e as HTMLDetailsElement).open=true;});await page.locator('#include-blobs').uncheck();await menu(page,false);const external=await exported(page);try{expect(external.prepare('SELECT count(*) AS n FROM blobs').get()!.n).toBe(0);expect(external.prepare('SELECT count(*) AS n FROM asset_refs').get()!.n).toBe(3);}finally{external.close();}
  await menu(page);await page.locator('#insert-pdf').uncheck();await page.locator('#pdf-file').setInputFiles({name:'Flattened.pdf',mimeType:'application/pdf',buffer:readFileSync(pdfPath!)});await expect(page.locator('#document')).toHaveValue('2');await expect(page.locator('#save-state')).toHaveText('Saved');await page.locator('#page-number').fill('3');await page.locator('#page-number').press('Enter');await page.locator('#next-page').focus();await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect.poll(()=>page.locator('#pdf-canvas').evaluate((element)=>{const c=element as HTMLCanvasElement;const pixel=c.getContext('2d')!.getImageData(c.width/2,c.height/2,1,1).data;return [...pixel];})).toEqual([144,176,192,255]);
  await page.screenshot({path:'test-results/mixed-notebook.png',fullPage:true});expect(errors).toEqual([]);
});

test('redo, duplicate, rotation and object dragging are event-backed without duplicating raw captures',async({page})=>{
  await page.goto('./');await stroke(page);await page.keyboard.press('Meta+a');await expect(page.locator('#selection-count')).toHaveText('1 selected');
  await page.locator('#duplicate-selection').click();await expect(page.locator('#counts')).toContainText('2 visible · 1 raw strokes');await page.locator('#rotate-selection').click();
  await page.locator('#undo').click();await page.locator('#undo').click();await expect(page.locator('#counts')).toContainText('1 visible');await page.locator('#redo').click();await expect(page.locator('#counts')).toContainText('2 visible');
  await page.locator('#toggle-text').click();await page.locator('#add-page-text').click();await page.locator('#text-source').fill('Move me $x=5$');await expect(page.locator('#text-status')).toHaveText('Saved');
  const handle=page.locator('.page-object .object-body'),box=(await handle.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+30,box.y+box.height/2+35,{steps:5});await page.mouse.up();await expect(page.locator('#save-state')).toHaveText('Saved');
  const db=await exported(page);try{expect(Number(db.prepare('SELECT x FROM visible_objects').get()!.x)).toBeGreaterThan(100);expect(db.prepare("SELECT count(*) AS n FROM app_events WHERE kind='object.set'").get()!.n).toBeGreaterThan(0);expect(db.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);}finally{db.close();}
});

test('two-finger navigation cancels accidental ink, pen rejects palms, and interruption retains observations',async({page})=>{
  await page.goto('./');await expect(page.locator('#save-state')).toHaveText('Saved');
  const size=await page.locator('#paper').boundingBox();
  await page.locator('#canvas').evaluate((canvas)=>{
    canvas.setPointerCapture=()=>{};const rect=canvas.getBoundingClientRect();const send=(type:string,id:number,x:number,y:number,pointerType='touch')=>canvas.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType,isPrimary:id===10,clientX:rect.x+x,clientY:rect.y+y,buttons:type==='pointerup'?0:1,button:0,bubbles:true}));
    send('pointerdown',10,100,100);send('pointerdown',11,200,100);send('pointermove',11,300,100);send('pointerup',11,300,100);send('pointerup',10,100,100);
  });
  await expect(page.locator('#save-state')).toHaveText('Saved');expect((await page.locator('#paper').boundingBox())!.width).toBeGreaterThan(size!.width);
  await page.locator('#canvas').evaluate((canvas)=>{const r=canvas.getBoundingClientRect();const send=(type:string,id:number,pointerType:string)=>canvas.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType,clientX:r.x+100,clientY:r.y+100,buttons:1,button:0,bubbles:true}));send('pointerdown',20,'pen');send('pointerdown',21,'touch');document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('blur'));send('pointerup',21,'touch');});
  await expect(page.locator('#counts')).toContainText('0 visible · 2 raw strokes');const db=await exported(page);try{expect(db.prepare("SELECT kind FROM app_events").all()).toEqual([{kind:'notebook.create'},{kind:'app.open'},{kind:'input.cancel'},{kind:'input.cancel'}]);}finally{db.close();}
});

test('page picker searches linked notes and PDF text and exposes selectable PDF text',async({page})=>{
  const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));await page.goto('./');await expect(page.locator('#save-state')).toHaveText('Saved');await menu(page);await page.locator('#pdf-file').setInputFiles(pdfFixture.pathname);await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#toggle-text').click();await page.locator('#add-linked-note').click();await page.locator('#text-source').fill('needle algebra');await page.locator('#close-text').click();await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#browse-pages').click();await expect(page.locator('.page-thumbnail')).toHaveCount(3);await page.locator('#reader-mode').click();await expect(page.locator('.continuous-reader')).toBeVisible();await expect(page.locator('.page-thumbnail canvas').first()).toBeVisible();await page.screenshot({path:'test-results/continuous-reader.png',fullPage:true});await page.locator('#reader-mode').click();await page.getByLabel('Search notebook').fill('needle');await page.locator('#notebook-search-form button').click();await expect(page.locator('#search-status')).toContainText('1 matching pages');await page.locator('.search-results button').click();
  await page.locator('#ink-settings').evaluate((e)=>{(e as HTMLDetailsElement).open=true;});await page.locator('#select-pdf-text').check();await expect(page.locator('#pdf-text span')).not.toHaveCount(0);await expect(page.locator('#pdf-text')).toBeVisible();await page.screenshot({path:'test-results/pdf-text-layer.png',fullPage:true});expect(errors).toEqual([]);
});

test('mobile palette, editable title and direct page text use journal-backed edits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.getByLabel('Event Draw', { exact: true })).toBeVisible();
  const title = page.getByRole('textbox', { name: 'Document title', exact: true });
  await title.fill('Math notebook'); await title.press('Enter');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Blue ink', exact: true }).click();
  await stroke(page);
  await page.getByRole('button', { name: 'Highlighter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Yellow ink', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Red ink', exact: true }).click();
  await stroke(page, [[100, 240], [500, 240]]);
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Blue ink', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await page.locator('#canvas').click({ position: { x: 35, y: 60 } });
  const pageText = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(pageText).toBeFocused();
  await pageText.fill('Let $x = 5$.');
  await page.getByRole('button', { name: 'Finish text', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('.page-object .katex')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-palette-text.png', fullPage: true });
  const db = await exported(page);
  try {
    expect(db.prepare('SELECT name FROM current_documents WHERE id=1').get()!.name).toBe('Math notebook');
    expect(db.prepare("SELECT count(*) AS n FROM app_events WHERE kind='document.rename'").get()!.n).toBe(1);
    expect(db.prepare('SELECT color,opacity FROM styles ORDER BY id').all()).toEqual([
      { color: '#1971c2', opacity: 1 }, { color: '#e03131', opacity: .28 },
    ]);
    expect(db.prepare('SELECT rendered FROM visible_objects').get()!.rendered).toBe(1);
  } finally { db.close(); }
});

test('typed JSONL reconstructs notebooks and partial history; malformed input preserves the working copy', async ({ page }) => {
  await page.goto('./'); await stroke(page); await stroke(page, [[100, 260], [500, 260]]);
  const canvas = await page.locator('#canvas').screenshot();
  const before = await exported(page);
  const identities = before.prepare('SELECT * FROM object_ids ORDER BY id').all(); before.close();
  const path = await download(page, '#export-jsonl');
  const text = readFileSync(path, 'utf8');
  const records = text.trim().split('\n').map((line) => JSON.parse(line));
  expect(records.map((r) => r.id)).toEqual(records.map((_, i) => i + 1));
  expect(records.some((r) => r.type === 'trace.raw')).toBe(true);
  expect(records.some((r) => r.type === 'trace.processed')).toBe(true);
  await menu(page);
  await page.locator('#jsonl-file').setInputFiles({ name: 'restored.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(text) });
  await expect(page.locator('#replay-report')).toContainText('0 skipped');
  await expect(page.locator('#counts')).toContainText('2 visible · 2 raw strokes');
  await menu(page, false);
  expect(await page.locator('#canvas').screenshot()).toEqual(canvas);
  const restored = await exported(page);
  try { expect(restored.prepare('SELECT * FROM object_ids ORDER BY id').all()).toEqual(identities); }
  finally { restored.close(); }
  const missing = records.find((r) => r.type === 'trace.raw').id;
  const partial = records.filter((r) => r.id !== missing).map((r) => JSON.stringify(r)).join('\n');
  await menu(page);
  await page.locator('#jsonl-file').setInputFiles({ name: 'partial.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(partial) });
  await expect(page.locator('#counts')).toContainText('1 visible · 1 raw strokes');
  await expect(page.locator('#replay-report')).toHaveText(/Reconstructed \d+ edits; [1-9]\d* skipped/);
  await expect(page.locator('#notice')).toContainText('skipped');
  await page.locator('#jsonl-file').setInputFiles({ name: 'invalid.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from('{}\n') });
  await expect(page.locator('#notice')).toContainText('Invalid record');
  await expect(page.locator('#counts')).toContainText('1 visible · 1 raw strokes');
  await menu(page, false); await stroke(page, [[100, 350], [500, 350]]);
  await expect(page.locator('#counts')).toContainText('2 visible · 2 raw strokes');
});

test('keyboard undo/redo respects native text editing and bottom indicators stay read-only', async ({ page }) => {
  await page.goto('./'); await stroke(page);
  await expect(page.locator('[data-indicator=database]')).toHaveText(/DB [\d.]+ [KM]?i?B/);
  const count = page.locator('[data-indicator=events]');
  await expect(count).toHaveText(/\d+ events/);
  await page.keyboard.press('Control+z');
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('#counts')).toContainText('1 visible');
  await page.keyboard.press('Meta+z');
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.keyboard.press('Control+y');
  await expect(page.locator('#counts')).toContainText('1 visible');
  await page.keyboard.press('t');
  await expect(page.locator('#insert-page-text')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#canvas').click({ position: { x: 90, y: 200 } });
  const source = page.getByRole('textbox', { name: 'Page text', exact: true });
  await source.pressSequentially('native undo');
  const events = await count.textContent();
  await source.press('ControlOrMeta+z');
  // App undo would remove the object creation. Native undo keeps the editor.
  await expect(source).toBeVisible(); await expect(count).toHaveText(events!);
  await source.fill('Saved text'); await source.press('Escape');
  await expect(source).toHaveCount(0); await expect(page.locator('#save-state')).toHaveText('Saved');
  const before = await exported(page), eventCount = before.prepare('SELECT count(*) AS n FROM app_events').get()!.n;
  before.close();
  await expect(count).toHaveText(eventCount + ' events');
  await expect(page.locator('[data-indicator=raw]')).toHaveText(/1 traces · [\d.]+ [KM]?i?B/);
  const after = await exported(page);
  try { expect(after.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(eventCount); }
  finally { after.close(); }
});

test('on-page Markdown and plain text share drafts, direct manipulation, undo and reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./'); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  const canvas = page.locator('#canvas');
  await canvas.click({ position: { x: 80, y: 150 } });
  const source = page.getByRole('textbox', { name: 'Page text', exact: true });
  await expect(source).toBeFocused();
  await source.fill('# First\n$x=5$');
  await expect(page.locator('#text-status')).toHaveText('Saved');
  // A clean saved draft can be rehydrated while this editor remains mounted.
  await source.fill('**Second** $2x=10$');
  await expect(page.locator('#text-status')).toHaveText('Saved');
  await source.fill('**Third** $3x=15$');
  await source.press('ControlOrMeta+Enter');
  await expect(page.locator('.page-object strong')).toHaveText('Third');
  await expect(page.locator('.page-object .katex')).toHaveCount(1);
  await page.locator('.page-object .object-body').dblclick();
  await expect(source).toBeFocused();
  await page.getByLabel('Page text format', { exact: true }).selectOption('text/plain');
  await source.fill('**literal** $x$\n<script>raw</script>');
  await page.getByRole('button', { name: 'Finish text', exact: true }).click();
  await expect(page.locator('.page-object .plain-text')).toHaveText('**literal** $x$\n<script>raw</script>');
  await expect(page.locator('.page-object strong, .page-object script, .page-object .katex')).toHaveCount(0);
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const original = await page.locator('.page-object').boundingBox();
  const body = page.locator('.page-object .object-body'), box = (await body.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 75, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect((await page.locator('.page-object').boundingBox())!.x).toBeGreaterThan(original!.x + 20);
  const resize = page.getByRole('button', { name: 'Resize object 1', exact: true });
  const corner = (await resize.boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
  await page.mouse.move(corner.x + 50, corner.y + 30, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  expect((await page.locator('.page-object').boundingBox())!.width).toBeGreaterThan(original!.width + 30);
  await page.keyboard.press('Delete'); await expect(page.locator('.page-object')).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator('.page-object .plain-text')).toBeVisible();
  await page.reload(); await expect(page.locator('.page-object .plain-text')).toBeVisible();
  await page.locator('#toggle-text').click();
  await page.getByLabel('Editor style', { exact: true }).selectOption('source');
  await expect(page.locator('#text-source')).toHaveClass(/editor-source/);
  await expect(page.locator('#text-source')).toHaveValue('**literal** $x$\n<script>raw</script>');
  await page.getByLabel('Text format', { exact: true }).selectOption('text/markdown');
  await expect(page.locator('.page-object strong')).toHaveText('literal');
  await expect(page.locator('#text-status')).toHaveText('Saved');
  const db = await exported(page);
  try {
    expect(db.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(0);
    expect(db.prepare('SELECT format FROM visible_objects').get()!.format).toBe('text/markdown');
  } finally { db.close(); }
  await page.locator('#close-text').click();
  await page.getByRole('button', { name: 'Lasso select', exact: true }).click();
  await page.locator('.page-object .object-body').click();
  await expect(page.locator('.page-object')).toHaveClass(/selected/);
  await menu(page); await page.locator('#add-page').click(); await menu(page, false);
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.keyboard.press('Delete');
  await page.locator('#previous-page').click();
  await expect(page.locator('.page-object strong')).toHaveText('literal');
  expect(errors).toEqual([]);
});
