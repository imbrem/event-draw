import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Rasterize the existing vector brand for Home Screen launchers.
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const svg = readFileSync(new URL('../public/icons/event-draw.svg', import.meta.url), 'utf8');
  for (const [name, size] of [
    ['icon-192', 192],
    ['icon-512', 512],
    ['apple-touch-icon', 180],
  ] as const) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`);
    await page.screenshot({ path: `public/icons/${name}.png` });
  }
} finally {
  await browser.close();
}
