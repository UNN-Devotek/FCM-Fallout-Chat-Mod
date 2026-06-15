/**
 * Playwright script: record the /wiki flow as a proper video.
 *
 * - Viewport: 960×540 (matches CommandsGif / PartyGif composition size)
 * - Admin dashboard chrome (nav, status bar, outer frame) is hidden via JS
 * - Overlay fills the full 960×540 viewport
 * - Interaction is fully natural — types, scrolls, clicks in real time
 * - Output: wiki-flow-raw.webm in the marketing promo public folder
 */

import { chromium } from 'playwright';
import { mkdirSync, createReadStream, createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';

const OUT_DIR = '/mnt/d/Projects/Unnamed/Fallout Chat Mod/marketing/promo/public';
const BACKEND  = 'http://127.0.0.1:7177';
const FRONTEND = 'http://127.0.0.1:7075';
const TMPDIR = '/tmp/pw-wiki-video';
mkdirSync(TMPDIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const ctx = await browser.newContext({
    viewport: { width: 960, height: 540 },
    recordVideo: {
      dir: TMPDIR,
      size: { width: 960, height: 540 },
    },
  });
  const page = await ctx.newPage();

  // ── 1. Dev login ────────────────────────────────────────────────────────────
  await page.route('**', async (r) => {
    if (r.request().url().includes(':5290')) await r.abort();
    else await r.continue();
  });
  await page.goto(`${BACKEND}/auth/dev-login/user`, { waitUntil: 'commit', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.unrouteAll();
  await page.goto(`${FRONTEND}/chat`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);

  // ── 2. Strip admin dashboard chrome so overlay fills the viewport ────────────
  await page.evaluate(() => {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;

    // Hide PipboyNav (sibling before <main>) and PipboyStatusBar (sibling after)
    let el = mainEl.previousElementSibling;
    while (el) { el.style.display = 'none'; el = el.previousElementSibling; }
    el = mainEl.nextElementSibling;
    while (el) { el.style.display = 'none'; el = el.nextElementSibling; }

    // Remove terminal frame border/shadow/size constraints
    const frame = mainEl.parentElement;
    if (frame) {
      frame.style.border = 'none';
      frame.style.boxShadow = 'none';
      frame.style.height = '100vh';
      frame.style.maxWidth = 'none';
    }

    // Remove the outer centering wrapper's padding
    const outer = frame ? frame.parentElement : null;
    if (outer) {
      outer.style.padding = '0';
      outer.style.alignItems = 'stretch';
    }

    // Remove main's own padding
    mainEl.style.padding = '0';

    // Fix help text + version in the overlay footer to look like the real Electron overlay
    // (web shows "Enter send · /help"; Electron shows keybinding shortcuts)
    const helpSpans = document.querySelectorAll('span');
    for (const span of helpSpans) {
      if (span.textContent?.trim() === 'Enter send · /help') {
        span.textContent = 'Ctrl+F9 focus · Ctrl+F10 hide · /help';
        break;
      }
    }
    // Update version display to current release
    const vSpans = document.querySelectorAll('span');
    for (const span of vSpans) {
      if (/^v\d+\.\d+\.\d+$/.test(span.textContent?.trim() ?? '')) {
        span.textContent = 'v1.3.81';
        break;
      }
    }
  });
  await page.waitForTimeout(800); // let layout reflow settle

  // ── 3. Hold on the chat feed for ~2 s ────────────────────────────────────────
  await page.waitForTimeout(2000);

  // ── 4. Type /wiki ────────────────────────────────────────────────────────────
  const chatInput = await page.waitForSelector('textarea[placeholder="Type a message..."]', { timeout: 10000 });
  await chatInput.click();
  await page.waitForTimeout(300);
  await chatInput.type('/wiki Toilet paper', { delay: 60 }); // ~1.1 s to type
  await page.waitForTimeout(1200); // autocomplete appears

  // ── 5. Hold on autocomplete ───────────────────────────────────────────────────
  await page.waitForTimeout(1500);

  // ── 6. Select first result with Tab ──────────────────────────────────────────
  await page.keyboard.press('Tab');
  await page.waitForTimeout(3000); // wiki panel + image load

  // ── 7. Hold on wiki item ─────────────────────────────────────────────────────
  await page.waitForTimeout(1800);

  // ── 8. Scroll down naturally to reveal Locations section ─────────────────────
  await page.mouse.move(480, 270);
  let rrVisible = false;
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, 80);
    await page.waitForTimeout(120);
    rrVisible = await page.locator('span[title="Open Red Rocket Mega Stop in the wiki"]').isVisible().catch(() => false);
    if (rrVisible) break;
  }
  await page.waitForTimeout(1200); // hold on locations

  // ── 9. Click Red Rocket Mega Stop ─────────────────────────────────────────────
  if (rrVisible) {
    await page.locator('span[title="Open Red Rocket Mega Stop in the wiki"]').first().click();
  } else {
    const links = await page.$$('span[role="button"][title^="Open "][title$=" in the wiki"]');
    for (const link of links) {
      const title = await link.getAttribute('title');
      if (title && !title.includes('Collectron') && !title.includes('station')) {
        await link.click(); break;
      }
    }
  }
  await page.waitForTimeout(3000); // location + map load

  // ── 10. Hold on location map ──────────────────────────────────────────────────
  await page.waitForTimeout(1500);

  // ── 11. Click map image → lightbox ────────────────────────────────────────────
  const wikiImg = await page.waitForSelector(
    'img[src*="wiki-images"], img[src*="/api/wiki/img"]',
    { timeout: 8000 }
  ).catch(() => null);

  if (wikiImg) {
    await wikiImg.click();
  } else {
    // Fallback: largest image
    const imgs = await page.$$('img');
    let best = null, bestArea = 0;
    for (const img of imgs) {
      const box = await img.boundingBox();
      if (box && box.width * box.height > bestArea) { bestArea = box.width * box.height; best = img; }
    }
    if (best) await best.click();
  }
  await page.waitForTimeout(2500); // hold on lightbox

  // ── 12. Done — close page to flush the video ──────────────────────────────────
  const video = page.video();
  await page.close();
  await browser.close();

  const rawPath = await video.path();
  const destPath = join(OUT_DIR, 'wiki-flow-raw.webm');
  await pipeline(createReadStream(rawPath), createWriteStream(destPath));
  console.log('\nVideo saved:', destPath);
  console.log('Duration: ~', Math.round(
    // rough estimate: 2+1.1+1.2+1.5+3+1.8+7*0.12+1.2+3+1.5+2.5
    (2000+300+1080+1200+1500+3000+1800+840+1200+3000+1500+2500) / 1000
  ), 's');
})();
