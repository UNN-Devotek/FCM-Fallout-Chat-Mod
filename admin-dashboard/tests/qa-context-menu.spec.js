// @ts-check
/**
 * Focused test for context menu on chat messages.
 * Uses a proper WebSocket mock to inject messages into the overlay.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, 'qa-report');
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const BASE_URL = 'http://localhost:7075';

const MOCK_CHANNELS = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'General',
    color: '#18FF62',
    parentId: null,
    position: 0,
    children: [
      { id: '00000000-0000-0000-0000-000000000002', name: 'Trading', color: '#18FF62', parentId: '00000000-0000-0000-0000-000000000001', position: 1, children: [] },
    ],
  },
];

test('context menu: inject messages via WS mock and right-click', async ({ page }) => {
  // Route auth/me
  await page.route('**/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { id: 'dev-user-001', username: 'System User', role: 'user', discordId: 'd1', discordUsername: 'SysUser', avatar: null, installToken: null } }),
  }));

  await page.route('**/api/channels**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: MOCK_CHANNELS }),
  }));

  await page.route('**/api/presence/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));

  await page.route('**/api/commands**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));

  await page.route('**/auth/ws-ticket**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { ticket: 'mock-ticket-abc' } }),
  }));

  // Inject WS mock BEFORE page load
  await page.addInitScript(`
    (function() {
      var _OrigWS = window.WebSocket;
      function MockWS(url) {
        this.url = url;
        this.readyState = 0;
        this.bufferedAmount = 0;
        this.extensions = '';
        this.protocol = '';
        this.binaryType = 'blob';
        this.onopen = null;
        this.onclose = null;
        this.onmessage = null;
        this.onerror = null;
        window.__mockWsInstance = this;

        var self = this;
        setTimeout(function() {
          self.readyState = 1;
          var ev = { type: 'open', target: self };
          if (self.onopen) self.onopen(ev);

          // Seed initial history for both channels after a delay
          setTimeout(function() {
            // Seed Trading channel (first sub — default active)
            var tradingId = '00000000-0000-0000-0000-000000000002';
            var generalId = '00000000-0000-0000-0000-000000000001';
            var channels = [tradingId, generalId];
            channels.forEach(function(chId) {
              var historyMsg = JSON.stringify({
                type: 'chat:history',
                payload: {
                  messages: [
                    { id: 'msg-' + chId + '-1', content: 'Hello wasteland! Welcome to the channel.', username: 'WastelandWanderer', user_id: 'user-aaa', channel_id: chId, source: 'web', created_at: new Date(Date.now() - 120000).toISOString() },
                    { id: 'msg-' + chId + '-2', content: 'Anyone selling a Plasma Rifle? Got caps to trade.', username: 'VaultDweller76', user_id: 'user-bbb', channel_id: chId, source: 'web', created_at: new Date(Date.now() - 60000).toISOString() },
                    { id: 'msg-' + chId + '-3', content: 'Nuke event tonight at 9pm EST!', username: 'EventMaster', user_id: 'user-ccc', channel_id: chId, source: 'web', created_at: new Date().toISOString() }
                  ]
                }
              });
              if (self.onmessage) self.onmessage({ type: 'message', data: historyMsg, target: self });
            });
          }, 300);
        }, 100);
      }

      MockWS.prototype.send = function(data) {
        console.log('[MockWS] send:', typeof data === 'string' ? data.substring(0, 80) : '[binary]');
        // Reply to chat:history requests with the same history
        if (typeof data === 'string') {
          try {
            var frame = JSON.parse(data);
            if (frame.type === 'chat:history') {
              var self = this;
              var chId = frame.payload.channelId;
              setTimeout(function() {
                var resp = JSON.stringify({
                  type: 'chat:history',
                  payload: {
                    messages: [
                      { id: 'msg-' + chId + '-1', content: 'Hello wasteland! Welcome to the channel.', username: 'WastelandWanderer', user_id: 'user-aaa', channel_id: chId, source: 'web', created_at: new Date(Date.now() - 120000).toISOString() },
                      { id: 'msg-' + chId + '-2', content: 'Anyone selling a Plasma Rifle? Got caps to trade.', username: 'VaultDweller76', user_id: 'user-bbb', channel_id: chId, source: 'web', created_at: new Date(Date.now() - 60000).toISOString() },
                      { id: 'msg-' + chId + '-3', content: 'Nuke event tonight at 9pm EST!', username: 'EventMaster', user_id: 'user-ccc', channel_id: chId, source: 'web', created_at: new Date().toISOString() }
                    ]
                  }
                });
                if (self.onmessage) self.onmessage({ type: 'message', data: resp, target: self });
              }, 50);
            }
          } catch(e) {}
        }
      };

      MockWS.prototype.close = function() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ type: 'close', wasClean: true, code: 1000 });
      };

      MockWS.CONNECTING = 0;
      MockWS.OPEN = 1;
      MockWS.CLOSING = 2;
      MockWS.CLOSED = 3;

      window.WebSocket = MockWS;
      console.log('[WS-MOCK] WebSocket replaced');
    })();
  `);

  await page.goto(`${BASE_URL}/chat`);

  // Wait for WS mock to fire and messages to render
  await page.waitForTimeout(3000);

  // Screenshot: overlay with messages
  await page.screenshot({ path: path.join(REPORT_DIR, 'CTX_01_overlay_with_messages.png') });

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Page text after WS mock:', bodyText.substring(0, 600));

  const hasMessages = bodyText.includes('WastelandWanderer') || bodyText.includes('VaultDweller76');
  console.log('Messages rendered:', hasMessages);

  if (!hasMessages) {
    // Check if WS mock was used
    const mockStatus = await page.evaluate(() => {
      return {
        wsReplaced: typeof window.WebSocket.prototype.send === 'function',
        mockInstance: !!window.__mockWsInstance,
        instanceReadyState: window.__mockWsInstance?.readyState,
      };
    });
    console.log('WS mock status:', JSON.stringify(mockStatus));

    await page.screenshot({ path: path.join(REPORT_DIR, 'CTX_01b_no_messages_debug.png') });
    return;
  }

  // Right-click a message
  // The component renders messages as spans with onContextMenu
  const msgEl = page.locator('text=WastelandWanderer').first();
  const msgVisible = await msgEl.isVisible().catch(() => false);
  console.log('WastelandWanderer element visible:', msgVisible);

  if (msgVisible) {
    // Get bounding box to right-click precisely
    const box = await msgEl.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    } else {
      await msgEl.click({ button: 'right' });
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(REPORT_DIR, 'CTX_02_context_menu.png') });
    console.log('Context menu triggered');

    // Capture context menu content
    const ctxContent = await page.evaluate(() => {
      const allFixed = document.querySelectorAll('*');
      const menuCandidates = [];
      for (const el of allFixed) {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' && el.children.length > 0 && el.tagName !== 'BODY') {
          menuCandidates.push({
            tag: el.tagName,
            text: el.textContent?.trim().substring(0, 200),
            childCount: el.children.length,
          });
        }
      }
      return menuCandidates;
    });
    console.log('Fixed-position elements (context menu candidates):', JSON.stringify(ctxContent, null, 2));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(REPORT_DIR, 'CTX_03_after_dismiss.png') });
  }
});
