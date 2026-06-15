// @ts-check
/**
 * QA Test: Chat Overlay UI
 *
 * Tests: settings panel, onboarding state, context menu on messages.
 * Uses API mocking to bypass Discord auth on production.
 *
 * Run with: npx playwright test tests/qa-chat-overlay.spec.js
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, 'qa-report');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const BASE_URL = 'http://localhost:7075';

// Mock user session data
const MOCK_USER = {
  id: 'dev-user-001',
  username: 'System User',
  role: 'user',
  discordId: 'mock-discord-001',
  discordUsername: 'SystemUser#0000',
  avatar: null,
  installToken: null,
};

// Mock channels response
const MOCK_CHANNELS = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'General',
    color: '#18FF62',
    parentId: null,
    position: 0,
    subChannels: [
      { id: '00000000-0000-0000-0000-000000000002', name: 'Trading', color: '#18FF62', parentId: '00000000-0000-0000-0000-000000000001', position: 1, subChannels: [] },
      { id: '00000000-0000-0000-0000-000000000003', name: 'Events',  color: '#18FF62', parentId: '00000000-0000-0000-0000-000000000001', position: 2, subChannels: [] },
    ],
  },
];

// Mock messages response
const MOCK_MESSAGES = [
  {
    id: 'msg-001',
    content: 'Hello wasteland! Welcome to Fallout Chat.',
    userId: 'user-abc',
    username: 'WastelandWanderer',
    discordUsername: 'WandererGamer#1234',
    channelId: '00000000-0000-0000-0000-000000000001',
    createdAt: new Date(Date.now() - 60000).toISOString(),
    isDeleted: false,
    source: 'web',
  },
  {
    id: 'msg-002',
    content: 'Does anyone have spare caps for a Plasma Rifle?',
    userId: 'user-def',
    username: 'VaultDweller76',
    discordUsername: 'VaultDweller#5678',
    channelId: '00000000-0000-0000-0000-000000000001',
    createdAt: new Date(Date.now() - 30000).toISOString(),
    isDeleted: false,
    source: 'web',
  },
  {
    id: 'msg-003',
    content: 'Server event tonight at 8pm EST — Nuke drop at Fissure Site Prime!',
    userId: 'user-ghi',
    username: 'NukeMaster',
    discordUsername: null,
    channelId: '00000000-0000-0000-0000-000000000001',
    createdAt: new Date().toISOString(),
    isDeleted: false,
    source: 'web',
  },
];

/**
 * Set up API mocks so the chat page loads without a real backend.
 */
async function setupMocks(page) {
  await page.route('**/auth/me', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_USER }),
    });
  });

  await page.route('**/api/channels**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_CHANNELS }),
    });
  });

  await page.route('**/api/messages**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: MOCK_MESSAGES }),
    });
  });

  await page.route('**/api/presence/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  // Block WebSocket upgrades gracefully
  await page.route('**/ws**', route => route.abort());

  // Let everything else through (static assets etc)
}

test.describe('Chat Overlay QA', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Task 1 — Settings Panel
  // ─────────────────────────────────────────────────────────────────────────
  test('1a - settings panel: gear icon opens settings modal', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${BASE_URL}/chat`);
    await page.waitForLoadState('networkidle');

    // Save base screenshot
    await page.screenshot({ path: path.join(REPORT_DIR, '01_chat_loaded.png'), fullPage: false });

    // Locate the gear / settings button — try multiple selectors
    const gearBtn = page.locator([
      'button[aria-label*="settings" i]',
      'button[aria-label*="setting" i]',
      'button[title*="settings" i]',
      'button[aria-label*="gear" i]',
      // SVG gear icon fallback — look for a button containing an SVG
      '[data-testid="settings-button"]',
      '[data-testid="chat-settings"]',
    ].join(', ')).first();

    // Try fallback: find all buttons in the title bar region and look for the rightmost one
    const gearVisible = await gearBtn.isVisible().catch(() => false);
    let settingsOpened = false;

    if (gearVisible) {
      await gearBtn.click();
      settingsOpened = true;
    } else {
      // Snapshot to discover actual element refs
      const snapshot = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.map((b, i) => ({
          i,
          text: b.textContent?.trim().substring(0, 40),
          ariaLabel: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          dataTestId: b.getAttribute('data-testid'),
        }));
      });
      console.log('All buttons on page:', JSON.stringify(snapshot, null, 2));

      // Look for settings/gear button by text or icon pattern
      const allBtns = page.locator('button');
      const count = await allBtns.count();
      for (let i = 0; i < count; i++) {
        const btn = allBtns.nth(i);
        const text = (await btn.textContent() || '').toLowerCase();
        const label = (await btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (await btn.getAttribute('title') || '').toLowerCase();
        if (text.includes('setting') || label.includes('setting') || title.includes('setting') ||
            text.includes('gear') || label.includes('gear') || title.includes('gear') ||
            text === '⚙' || text === '⚙️') {
          await btn.click();
          settingsOpened = true;
          break;
        }
      }
    }

    if (!settingsOpened) {
      // Try clicking SVGs that look like gear icons by checking parent buttons
      const svgBtns = page.locator('button svg, button img');
      const svgCount = await svgBtns.count();
      console.log(`Found ${svgCount} SVG/img buttons`);

      // Last resort: look for any modal-opening interactions
      await page.screenshot({ path: path.join(REPORT_DIR, '01b_settings_not_found.png') });

      // Record failure but don't throw — continue to document state
      console.log('WARN: Could not find settings/gear button automatically. Manual investigation needed.');
    } else {
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(REPORT_DIR, '02_settings_modal_open.png') });
      console.log('Settings modal opened successfully');
    }

    // Check if any modal/dialog appeared
    const modal = page.locator('[role="dialog"], .modal, [class*="modal"], [class*="settings"], [class*="Settings"]').first();
    const modalVisible = await modal.isVisible().catch(() => false);

    if (modalVisible) {
      await page.screenshot({ path: path.join(REPORT_DIR, '02_settings_modal_open.png') });

      // Find and click close button
      const closeBtn = page.locator([
        '[role="dialog"] button[aria-label*="close" i]',
        '[role="dialog"] button[aria-label*="dismiss" i]',
        '.modal button[aria-label*="close" i]',
        'button:has-text("✕")',
        'button:has-text("×")',
        'button:has-text("Close")',
        '[data-testid="close-modal"]',
      ].join(', ')).first();

      const closeBtnVisible = await closeBtn.isVisible().catch(() => false);
      if (closeBtnVisible) {
        await closeBtn.click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(REPORT_DIR, '03_settings_modal_closed.png') });
        console.log('Settings modal closed');
      } else {
        // Try pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(REPORT_DIR, '03_settings_modal_closed_via_esc.png') });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 2 — Onboarding / Setup state
  // ─────────────────────────────────────────────────────────────────────────
  test('2 - onboarding: screenshot setup/registration state', async ({ page }) => {
    await setupMocks(page);

    // Check /setup route
    await page.goto(`${BASE_URL}/setup`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(REPORT_DIR, '04_setup_page.png'), fullPage: true });
    const setupUrl = page.url();
    const setupTitle = await page.title();
    console.log(`/setup -> URL: ${setupUrl}, Title: ${setupTitle}`);

    // Try /onboarding
    await page.goto(`${BASE_URL}/onboarding`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(REPORT_DIR, '05_onboarding_page.png'), fullPage: true });
    console.log(`/onboarding -> URL: ${page.url()}`);

    // Check the chat page for any onboarding/install-token banner
    await page.goto(`${BASE_URL}/chat`);
    await page.waitForLoadState('networkidle');

    // Mock user with no install token to trigger onboarding
    await page.route('**/auth/me', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ...MOCK_USER, installToken: null } }),
      });
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(REPORT_DIR, '06_chat_no_install_token.png'), fullPage: false });

    // Look for onboarding/setup UI elements
    const onboardingElements = await page.evaluate(() => {
      const keywords = ['onboard', 'setup', 'install', 'token', 'register', 'link', 'overlay'];
      const allText = document.body.innerText.toLowerCase();
      return keywords.filter(kw => allText.includes(kw));
    });
    console.log('Onboarding-related keywords found:', onboardingElements);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 3 — Context menu on chat messages
  // ─────────────────────────────────────────────────────────────────────────
  test('3 - context menu: right-click on chat message', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${BASE_URL}/chat`);
    await page.waitForLoadState('networkidle');

    // Wait for messages to render
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(REPORT_DIR, '07_chat_with_messages.png') });

    // Look for chat message elements
    const messageEl = page.locator([
      '[data-testid="chat-message"]',
      '[class*="message"]',
      '[class*="Message"]',
      '.chat-message',
      'li[class*="message"]',
    ].join(', ')).first();

    const msgVisible = await messageEl.isVisible().catch(() => false);

    if (msgVisible) {
      await messageEl.click({ button: 'right' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(REPORT_DIR, '08_context_menu.png') });
      console.log('Context menu triggered on message element');
    } else {
      // Try finding message text elements
      const msgText = page.locator('text=Hello wasteland').first();
      const msgTextVisible = await msgText.isVisible().catch(() => false);

      if (msgTextVisible) {
        await msgText.click({ button: 'right' });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(REPORT_DIR, '08_context_menu_on_text.png') });
        console.log('Context menu triggered on message text');
      } else {
        // Document what elements are visible
        const visibleText = await page.evaluate(() => document.body.innerText.substring(0, 500));
        console.log('Page text:', visibleText);
        await page.screenshot({ path: path.join(REPORT_DIR, '08_no_messages_visible.png') });
        console.log('WARN: No chat messages visible — API mocks may not have populated the UI');
      }
    }

    // Also screenshot any context menu that appeared
    const contextMenu = page.locator('[role="menu"], [class*="context"], [class*="Context"]').first();
    const ctxVisible = await contextMenu.isVisible().catch(() => false);
    if (ctxVisible) {
      await page.screenshot({ path: path.join(REPORT_DIR, '09_context_menu_detail.png') });
      const menuItems = await contextMenu.locator('[role="menuitem"], li, button').allTextContents();
      console.log('Context menu items:', menuItems);
    }

    // Dismiss
    await page.keyboard.press('Escape');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 4 — Full chat overlay UI discovery (no-auth, mocked)
  // ─────────────────────────────────────────────────────────────────────────
  test('4 - full overlay screenshot and element discovery', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`${BASE_URL}/chat`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await page.screenshot({ path: path.join(REPORT_DIR, '10_full_overlay.png'), fullPage: false });

    // Collect all interactive elements for the report
    const elements = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('button, a, input, [role="tab"]').forEach(el => {
        items.push({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 60),
          ariaLabel: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          href: el.getAttribute('href'),
          type: el.getAttribute('type'),
          class: el.className?.toString().substring(0, 80),
        });
      });
      return items;
    });

    console.log('Interactive elements:', JSON.stringify(elements, null, 2));

    // Record page structure
    fs.writeFileSync(
      path.join(REPORT_DIR, 'elements.json'),
      JSON.stringify(elements, null, 2)
    );
  });
});
