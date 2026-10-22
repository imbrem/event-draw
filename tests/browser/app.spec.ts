import { test as base, expect, webkit, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function stroke(page: Page, offset = 0) {
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 100 + offset);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 135 + offset, { steps: 6 });
  await page.mouse.move(box.x + 240, box.y + 105 + offset, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

async function download(page: Page, id: string) {
  await page.locator('.export-menu summary').click();
  const next = page.waitForEvent('download');
  await page.locator(id).click();
  return await (await next).path();
}

test('draw, reload, undo, export full history and compact state with identical rendering', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  await stroke(page);
  await stroke(page, 50);
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 captured · 2 app events');
  const drawing = await page.locator('canvas').screenshot();
  await page.reload();
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  await expect(page.locator('#counts')).toHaveText('2 visible · 2 captured · 2 app events');
  expect(await page.locator('canvas').screenshot()).toEqual(drawing);
  await page.getByRole('button', { name: 'Clear page', exact: true }).click();
  await expect(page.locator('#counts')).toContainText('0 visible');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#counts')).toContainText('2 visible');
  expect(await page.locator('canvas').screenshot()).toEqual(drawing);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#counts')).toHaveText('1 visible · 2 captured · 5 app events');

  const fullPath = await download(page, '#export-full');
  const snapshotPath = await download(page, '#export-visible');
  const full = new DatabaseSync(fullPath);
  const snapshot = new DatabaseSync(snapshotPath);
  try {
    const visible = 'SELECT id, kind, data_version, color, width, paint_order, data_json FROM visible_strokes ORDER BY paint_order, id';
    expect(snapshot.prepare(visible).all()).toEqual(full.prepare(visible).all());
    expect(full.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(5);
    expect(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n).toBe(1);
    expect(snapshot.prepare('SELECT count(*) AS n FROM stroke_events').get()!.n).toBe(1);
    expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    const row = full.prepare('SELECT created_at, data_json FROM stroke_events LIMIT 1').get()!;
    const data = JSON.parse(row.data_json as string);
    expect(data.created_at).toBeUndefined();
    expect(data.deliveries.length).toBeGreaterThan(2);
    expect(data.deliveries[0].reported.clientX).toBeGreaterThan(0);
    expect(readFileSync(fullPath).subarray(0, 15).toString()).toBe('SQLite format 3');
  } finally { full.close(); snapshot.close(); }
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/notebook.png', fullPage: true });
});

test('narrow touch layout captures pen data and cancelled strokes without displaying them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('canvas').evaluate((canvas) => {
    // Synthetic events have no active browser pointer, so omit pointer capture.
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const options = {
      pointerId: 8, pointerType: 'pen', isPrimary: true, bubbles: true,
      clientX: rect.left + 50, clientY: rect.top + 60, button: 0, buttons: 1,
      pressure: 0.83, tiltX: 23, tiltY: -12,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', options));
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: rect.left + 100 }));
    canvas.dispatchEvent(new PointerEvent('pointercancel', options));
  });
  await expect(page.locator('#counts')).toHaveText('0 visible · 1 captured · 1 app events');
  await page.locator('#diagnostics summary').click();
  const details = JSON.parse((await page.locator('#sample-info').textContent())!);
  expect(details.lastReported.pressure).toBeCloseTo(0.83, 6);
  await expect(page.locator('#sample-info')).toContainText('"status": "cancelled"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unavailable persistent storage has a visible session-only fallback', async ({ page }) => {
  // A second tab cannot acquire the same SAH pool while this tab owns it.
  await page.goto('/');
  await expect(page.locator('#storage')).toHaveText('Stored on this device');
  const other = await page.context().newPage();
  try {
    await other.goto('/');
    await expect(other.locator('#storage')).toHaveText('Session only · export to keep');
    await expect(other.locator('#notice')).toBeVisible();
    await stroke(other);
    const path = await download(other, '#export-full');
    const exported = new DatabaseSync(path);
    expect(exported.prepare('SELECT count(*) AS n FROM visible_strokes').get()!.n).toBe(1);
    exported.close();
  } finally { await other.close(); }
});
