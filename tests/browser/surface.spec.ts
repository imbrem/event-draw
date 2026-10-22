import { test, expect, type Page } from '@playwright/test';

async function coordinate(page: Page, fraction = .5) {
  return page.evaluate(fraction => {
    const viewport = document.querySelector('#page-viewport')!.getBoundingClientRect();
    const paper = document.querySelector('#paper')!.getBoundingClientRect();
    const x = viewport.left + viewport.width * fraction, y = viewport.top + viewport.height * fraction;
    return { x, y, pageX: (x - paper.left) / paper.width * 1000, pageY: (y - paper.top) / paper.width * 1000 };
  }, fraction);
}

test('zoom on a scrolled note preserves the viewport centre and explicit pinch anchor', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#options').evaluate(e => { (e as HTMLDetailsElement).open = true; });
  await page.getByLabel('Writing workspace').selectOption('notes');
  await page.locator('#page-viewport').evaluate(e => { e.scrollTop = 250; });
  const centre = await coordinate(page);
  await page.locator('#zoom-in').click();
  await expect.poll(async () => Math.abs((await coordinate(page)).pageY - centre.pageY)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await coordinate(page)).pageX - centre.pageX)).toBeLessThan(1);
  await page.locator('#options').evaluate(e => { (e as HTMLDetailsElement).open = false; });
  const anchor = await coordinate(page, .25);
  const width = (await page.locator('#paper').boundingBox())!.width;
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -40);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await page.locator('#paper').boundingBox())!.width).toBeGreaterThan(width);
  await expect.poll(async () => Math.abs((await coordinate(page, .25)).pageY - anchor.pageY)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await coordinate(page, .25)).pageX - anchor.pageX)).toBeLessThan(1);
  await expect(page.locator('#counts')).toContainText('0 raw strokes');
});
