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
  if (id !== '#export-existing') await page.locator('.export-menu summary').click();
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
  await page.goto('/');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  await stroke(page);
  await stroke(page, [[100, 220], [450, 260]]);
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 raw strokes · 2 events');
  const drawing = await page.locator('#canvas').screenshot();
  await page.reload();
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 raw strokes · 2 events');
  expect(await page.locator('#canvas').screenshot()).toEqual(drawing);
  await tab(page, 'events');
  await expect(page.getByRole('table', { name: 'app_events', exact: true })).toBeVisible();
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
  await expect(page.locator('#counts')).toHaveText('1 visible · 2 raw strokes · 5 events');
  const full = await exported(page), snapshot = await exported(page, '#export-visible');
  try {
    const visible = 'SELECT * FROM visible_shapes ORDER BY paint_order, id';
    expect(snapshot.prepare(visible).all()).toEqual(full.prepare(visible).all());
    expect(full.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(5);
    expect(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(1);
    expect(snapshot.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
    expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    expect(full.prepare('PRAGMA table_info(stroke_events)').all().map((r) => r.name))
      .toEqual(['id', 'capture_session_id', 'data_version', 'data_json']);
    const data = JSON.parse(full.prepare('SELECT data_json FROM stroke_events LIMIT 1').get()!.data_json as string);
    expect(Object.keys(data)).toEqual(['deliveries']);
    expect(data.deliveries[0].reported.x).toBe(0);
    expect(data.deliveries[0].reported.clientX).toBeGreaterThan(0);
    expect(data.deliveries.length).toBeGreaterThan(2);
  } finally { full.close(); snapshot.close(); }
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/notebook.png', fullPage: true });
});

test('both erasers split or delete geometry and undo restores original raw references', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await page.getByRole('button', { name: 'Erase parts', exact: true }).click();
  await stroke(page, [[300, 120], [300, 180]]);
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 raw strokes · 2 events');
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
  await expect(page.locator('#counts')).toHaveText('0 visible · 3 raw strokes · 4 events');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
});

test('pages share one journal and whiteboards pan/zoom independently of raw geometry', async ({ page }) => {
  await page.goto('/');
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
  await expect(page.locator('#view-position')).toContainText('x -200, y -100');
  await page.locator('#zoom-in').click();
  await expect(page.locator('#view-position')).toContainText('125%');
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await stroke(page);
  const full = await exported(page), snapshot = await exported(page, '#export-visible');
  try {
    expect(full.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(3);
    expect(full.prepare('SELECT DISTINCT page_id FROM app_events ORDER BY page_id').all().map((r) => r.page_id)).toEqual([1, 2, 3]);
    expect(snapshot.prepare('SELECT * FROM pages').all()).toEqual(full.prepare('SELECT * FROM pages').all());
    expect(snapshot.prepare('SELECT * FROM visible_shapes ORDER BY id').all())
      .toEqual(full.prepare('SELECT * FROM visible_shapes ORDER BY id').all());
  } finally { full.close(); snapshot.close(); }
});

test('narrow touch layout preserves cancelled pen observations without displaying them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const tools = page.getByRole('group', { name: 'Tools', exact: true });
  await expect(tools.getByRole('button')).toHaveCount(5);
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
  await expect(page.locator('#counts')).toHaveText('0 visible · 1 raw strokes · 1 events');
  await menu(page);
  await page.locator('#diagnostics summary').click();
  const details = JSON.parse((await page.locator('#sample-info').textContent())!);
  expect(details.lastReported.pressure).toBeCloseTo(0.83, 6);
  expect(details.status).toBe('cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('tool buttons support keyboard selection, contextual controls, and drawing/page constraints', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  const other = await page.context().newPage();
  await other.goto('/');
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
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await menu(page);
  await page.locator('.local-state summary').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#reset-settings').click();
  await expect(page.locator('#counts')).toContainText('1 visible');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reset-settings').click();
  await expect(page.locator('#counts')).toHaveText('0 visible · 0 raw strokes · 0 events');
  await page.reload();
  await expect(page.locator('#counts')).toHaveText('0 visible · 0 raw strokes · 0 events');
  await stroke(page);
  await expect(page.locator('#counts')).toContainText('1 visible');
});

test('an unsupported on-disk schema can be exported and reset from the error screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await stroke(page);
  await page.route('**/__test_closed__', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Closed notebook</title>' }));
  await page.goto('/__test_closed__');
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0)).toBe(0);
  // Change only SQLite's user_version header in this isolated test origin.
  // SAH pool files prepend VFS metadata, so locate the database header first.
  const changed = await page.evaluate(async () => {
    async function change(directory: FileSystemDirectoryHandle): Promise<boolean> {
      const entries = directory as unknown as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [, entry] of entries) {
        if (entry.kind === 'directory') {
          if (await change(entry as FileSystemDirectoryHandle)) return true;
        } else {
          const file = entry as FileSystemFileHandle;
          const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
          const magic = new TextEncoder().encode('SQLite format 3');
          for (let offset = 0; offset + 100 < bytes.length; offset++) {
            if (!magic.every((byte, index) => bytes[offset + index] === byte)) continue;
            new DataView(bytes.buffer).setUint32(offset + 60, 999);
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
  });
  expect(changed).toBe(true);
  await page.goto('/');
  await expect(page.locator('#notice')).toContainText('Unsupported database schema version: 999');
  await expect(page.locator('#reset-local')).toBeVisible();
  const old = await exported(page, '#export-existing');
  try {
    expect(old.prepare('PRAGMA user_version').get()!.user_version).toBe(999);
    expect(old.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
  } finally { old.close(); }
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reset-local').click();
  await expect(page.locator('#counts')).toHaveText('0 visible · 0 raw strokes · 0 events');
  await expect(page.locator('#notice')).toBeHidden();
  await stroke(page);
  await page.reload();
  await expect(page.locator('#counts')).toHaveText('1 visible · 1 raw strokes · 1 events');
});

test('lasso selects ink, dragging changes placement only, and deletion and movement undo separately', async ({ page }) => {
  await page.goto('/');
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
      .toEqual(['stroke.add', 'stroke.add', 'selection.lasso', 'selection.move']);
    expect(moved.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(4);
    expect(compact.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(2);
    expect(compact.prepare('SELECT * FROM visible_shapes ORDER BY id').all())
      .toEqual(moved.prepare('SELECT * FROM visible_shapes ORDER BY id').all());
  } finally { moved.close(); compact.close(); }
  await page.screenshot({ path: 'test-results/lasso-selection.png', fullPage: true });
  await page.locator('#delete-selection').click();
  await expect(page.locator('#counts')).toHaveText('1 visible · 4 raw strokes · 5 events');
  await expect(page.locator('#selection-count')).toHaveText('0 selected');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toContainText('2 visible');
  await page.locator('#undo').click();
  await expect(page.locator('#counts')).toHaveText('2 visible · 4 raw strokes · 7 events');
  const restored = await exported(page);
  try { expect(restored.prepare('SELECT * FROM visible_shapes WHERE id = 1').get()).toEqual(original); }
  finally { restored.close(); }
  await page.reload();
  await expect(page.locator('#counts')).toHaveText('2 visible · 4 raw strokes · 7 events');
});

const pdfFixture = new URL('../fixtures/pages.pdf', import.meta.url);
test('PDF file and URL imports deduplicate by hash; annotations survive navigation, zoom, reload and compact export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bytes = readFileSync(pdfFixture), hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#page-heading')).toHaveText('/1');
  await menu(page);
  await page.locator('#pdf-file').setInputFiles(pdfFixture.pathname);
  await expect(page.locator('#document')).toHaveValue('2');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#page-total')).toHaveText('/ 3');
  await expect(page.locator('#document-hash')).toHaveText(hash);
  await expect(page.locator('#blank-page-controls')).toBeHidden();
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
  await expect(page.locator('#counts')).toHaveText('1 visible · 2 raw strokes · 3 events');
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
  await page.goto('/');
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
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 raw strokes · 2 events');
});

test('blank document names, page ordering and deletion are separate from annotation identity', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
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
  await expect(page.locator('#counts')).toHaveText('1 visible · 1 raw strokes · 1 events');
  const before = await exported(page), raw = before.prepare('SELECT * FROM stroke_events').all(); before.close();
  await tab(page, 'raw');
  const diagnostics = page.getByRole('region', { name: 'Database diagnostics', exact: true });
  await expect(diagnostics).toContainText('1 / 1 (100.0%)');
  await expect(diagnostics).toContainText('all documents');
  const canvas = page.getByLabel('Neutral raw stroke preview');
  await expect(canvas).toHaveAttribute('data-replayed-samples', '3');
  const full = await canvas.screenshot();
  await page.getByLabel('Replay speed').selectOption('4');
  await page.getByRole('button', { name: 'Replay stroke', exact: true }).click();
  await expect(page.locator('.replay-status')).toContainText('Replaying');
  await expect.poll(() => canvas.getAttribute('data-replayed-samples')).toBe('1');
  await expect(page.locator('.replay-status')).toHaveText('Replay complete');
  expect(await canvas.screenshot()).toEqual(full);
  await page.getByLabel('Replay speed').selectOption('0.25');
  await page.getByRole('button', { name: 'Replay stroke', exact: true }).click();
  await page.getByRole('button', { name: 'Stop replay', exact: true }).click();
  await expect(page.locator('.replay-status')).toHaveText('Full capture');
  await page.getByRole('button', { name: 'Replay stroke', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh database', exact: true }).click();
  await expect(page.locator('.replay-status')).toHaveText('Full capture');
  await page.screenshot({ path: 'test-results/raw-replay-diagnostics.png', fullPage: true });
  await page.getByRole('button', { name: 'Replay stroke', exact: true }).click();
  await page.locator('#return-notebook').click();
  const after = await exported(page);
  try {
    expect(after.prepare('SELECT * FROM stroke_events').all()).toEqual(raw);
    expect(after.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(1);
  } finally { after.close(); }
});
