/**
 * Playwright script: capture the real wiki flow for WikiFlowVideo.
 * Screenshots are cropped to ONLY the overlay widget — no admin nav/status chrome.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const OUT_DIR = '/mnt/d/Projects/Unnamed/Fallout Chat Mod/marketing/promo/public/wiki-screens';
mkdirSync(OUT_DIR, { recursive: true });

const BACKEND  = 'http://127.0.0.1:7177';
const FRONTEND = 'http://127.0.0.1:7075';

// Capture just the overlay widget area (main's first child — no nav/statusbar chrome).
async function shot(page, name, clipBox) {
  return page.screenshot({ path: join(OUT_DIR, name), fullPage: false, clip: clipBox });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // ── 1. Dev login ──────────────────────────────────────────────────────────────
  await page.route('**', async (r) => {
    if (r.request().url().includes(':5290')) await r.abort();
    else await r.continue();
  });
  await page.goto(`${BACKEND}/auth/dev-login/user`, { waitUntil: 'commit', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.unrouteAll();
  await page.goto(`${FRONTEND}/chat`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);

  // ── 2. Find overlay clip box (main > first div = ChatOverlay root) ────────────
  // The admin layout is: PipboyNav | <main padding=4px 12px> | PipboyStatusBar
  // We want ONLY the main content area, no nav/status chrome.
  const mainEl = await page.$('main');
  let clipBox = null;
  if (mainEl) {
    const box = await mainEl.boundingBox();
    if (box) {
      // Strip the 4px/12px padding from main so we get just the overlay widget
      clipBox = {
        x:      box.x + 12,
        y:      box.y + 4,
        width:  box.width  - 24,
        height: box.height - 8,
      };
      console.log('Overlay clip:', JSON.stringify(clipBox));
    }
  }
  if (!clipBox) {
    // Fallback: full viewport (shouldn't happen)
    clipBox = { x: 0, y: 0, width: 1280, height: 720 };
    console.warn('Could not find <main> — using full viewport');
  }

  // ── 3. Capture initial chat feed ──────────────────────────────────────────────
  await shot(page, '01-chat-feed.png', clipBox);
  console.log('01: chat feed');

  // ── 4. Type /wiki in the textarea ─────────────────────────────────────────────
  const chatInput = await page.waitForSelector('textarea[placeholder="Type a message..."]', { timeout: 10000 });
  await chatInput.click();
  await page.waitForTimeout(200);
  await chatInput.type('/wiki Toilet paper', { delay: 35 });
  await page.waitForTimeout(1800);

  // ── 5. Capture with autocomplete ──────────────────────────────────────────────
  await shot(page, '02-autocomplete.png', clipBox);
  console.log('02: autocomplete');

  // ── 6. Select first AC result with Tab ────────────────────────────────────────
  await page.keyboard.press('Tab');
  await page.waitForTimeout(3000); // wait for wiki panel + image to load

  // ── 7. Capture wiki item panel ────────────────────────────────────────────────
  await shot(page, '03-wiki-item.png', clipBox);
  console.log('03: wiki item');

  // ── 8. Scroll the wiki panel to show the Locations section ──────────────────
  await page.mouse.move(640, 400);
  let rrVisible = false;
  for (let scroll = 0; scroll < 800; scroll += 120) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const link = page.locator('span[title="Open Red Rocket Mega Stop in the wiki"]');
    rrVisible = await link.isVisible().catch(() => false);
    if (rrVisible) {
      console.log(`Found Red Rocket Mega Stop after ${scroll + 120}px scroll`);
      break;
    }
  }

  // ── 9. Capture locations section ─────────────────────────────────────────────
  await shot(page, '04-wiki-locations.png', clipBox);
  console.log('04: wiki locations');

  // ── 10. Click Red Rocket Mega Stop location link ───────────────────────────────
  if (rrVisible) {
    console.log('Clicking Red Rocket Mega Stop');
    await page.locator('span[title="Open Red Rocket Mega Stop in the wiki"]').first().click();
  } else {
    const links = await page.$$('span[role="button"][title^="Open "][title$=" in the wiki"]');
    let clicked = false;
    for (const link of links) {
      const title = await link.getAttribute('title');
      if (title && !title.includes('Collectron') && !title.includes('station')) {
        console.log('Clicking fallback link:', title);
        await link.click();
        clicked = true;
        break;
      }
    }
    if (!clicked && links[0]) {
      const t = await links[0].getAttribute('title');
      console.log('Clicking first available link:', t);
      await links[0].click();
    }
  }
  await page.waitForTimeout(3000);

  // ── 11. Capture Red Rocket Mega Stop page with map ────────────────────────────
  await shot(page, '05-location-map.png', clipBox);
  console.log('05: location map');

  // ── 12. Click the first (map) image in the wiki panel ─────────────────────────
  const wikiImg = await page.waitForSelector(
    'img[src*="wiki-images"], img[src*="/api/wiki/img"]',
    { timeout: 8000 }
  ).catch(() => null);

  if (wikiImg) {
    const box = await wikiImg.boundingBox();
    console.log('Clicking wiki img:', Math.round(box?.width ?? 0), 'x', Math.round(box?.height ?? 0));
    await wikiImg.click();
  } else {
    const imgs = await page.$$('img');
    let best = null, bestArea = 0;
    for (const img of imgs) {
      const box = await img.boundingBox();
      if (box && box.width * box.height > bestArea) {
        bestArea = box.width * box.height;
        best = img;
      }
    }
    if (best) {
      const box = await best.boundingBox();
      console.log('Clicking fallback img:', Math.round(box?.width ?? 0), 'x', Math.round(box?.height ?? 0));
      await best.click();
    } else {
      console.log('No image found');
    }
  }
  await page.waitForTimeout(2000);

  // ── 13. Capture lightbox ──────────────────────────────────────────────────────
  await shot(page, '06-lightbox.png', clipBox);
  console.log('06: lightbox');

  await browser.close();
  console.log('\nDone. Screenshots in:', OUT_DIR);
  console.log('Clip box was:', JSON.stringify(clipBox));
})();
