// @ts-check
/**
 * WS Reconnect & Re-registration regression tests
 *
 * Fix 1 (Nekanox blank-chat bug):
 *   ChatOverlay watchdog was 60 s — reduced to 15 s.
 *   Test: after a relay WS closes, a new one must open within 20 s.
 *
 * Fix 2 (re-registration on every focus):
 *   refreshDiscordStatus called registerForToken even when already linked.
 *   Multiple focus events must NOT produce extra POST /relay/register calls.
 *
 * Requires: dashboard at localhost:7075, backend at localhost:7177 (Docker).
 */
import { test, expect } from '@playwright/test';

const CHAT_URL = 'http://localhost:7075/chat';
const WS_RECONNECT_TIMEOUT_MS = 20_000; // watchdog fires at 15 s + headroom

// Budget per test: login(3s) + stabilise(3s) + reconnect window(20s) + nav overhead
test.setTimeout(60_000);

async function loginAsOwner(page) {
  await page.goto('/auth/dev-login/owner');
  await page.waitForLoadState('load');
}

/** Only the relay WebSocket — not Vite HMR. */
function isRelayWs(url) {
  return url.includes('/ws?ticket=');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: After a relay WS closes mid-session, the next one opens within 20 s
// (verifies the 15 s watchdog in ChatOverlay.tsx)
// ─────────────────────────────────────────────────────────────────────────────
test('WS watchdog: reconnects within 20 s after relay WS close', async ({ page }) => {
  const relayOpens = []; // timestamps of each relay WS open
  let forcedCloseAt = null;
  let serverRef = null; // WebSocketRoute for the proxied server connection

  // Intercept relay WS connections so we can force-close the server side.
  // Must be set up BEFORE navigate so the first connection is caught.
  await page.routeWebSocket('**/ws?ticket=*', ws => {
    relayOpens.push(Date.now());
    console.log(`[relay] open  (proxied) #${relayOpens.length}`);
    const server = ws.connectToServer();
    // Forward bidirectionally.
    ws.onMessage(msg => server.send(msg));
    server.onMessage(msg => ws.send(msg));
    // Keep latest server ref so we can close it.
    serverRef = server;
  });

  await loginAsOwner(page);
  await page.goto(CHAT_URL);
  await page.waitForLoadState('load');

  // Wait for initial relay connection.
  await expect.poll(() => relayOpens.length, { timeout: 15_000, intervals: [300] })
    .toBeGreaterThan(0);

  // Let it stabilise for 2 s.
  await page.waitForTimeout(2_000);
  console.log(`Initial relay connected. Forcing server-side close...`);

  // Close the server side — browser gets a close frame, triggering the reconnect path.
  forcedCloseAt = Date.now();
  serverRef.close();

  // Wait for the watchdog to fire and open a new relay WS.
  await expect.poll(() => relayOpens.length > 1, {
    timeout: WS_RECONNECT_TIMEOUT_MS, intervals: [300],
  }).toBe(true);

  const reconnectGap = relayOpens[1] - forcedCloseAt;
  console.log(`Relay reconnected ${reconnectGap} ms after forced close (budget: ${WS_RECONNECT_TIMEOUT_MS} ms)`);
  expect(reconnectGap).toBeLessThan(WS_RECONNECT_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Multiple focus events do NOT trigger extra POST /relay/register calls
// ─────────────────────────────────────────────────────────────────────────────
test('No extra relay registrations on repeated window focus events', async ({ page }) => {
  const registerCalls = [];
  await page.route('**/relay/register', (route, request) => {
    if (request.method() === 'POST') {
      registerCalls.push({ time: Date.now() });
      console.log(`/relay/register POST at ${new Date().toISOString()}`);
    }
    return route.continue();
  });

  await loginAsOwner(page);
  await page.goto(CHAT_URL);
  await page.waitForLoadState('load');
  await page.waitForTimeout(3_000);

  const initialCount = registerCalls.length;
  console.log(`Initial register calls: ${initialCount}`);

  // Fire 5 rapid window focus events.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(2_000);

  const afterCount = registerCalls.length;
  console.log(`Register calls after 5 focus events: ${afterCount} (delta: ${afterCount - initialCount})`);

  // The fix skips re-registration when already linked — expect ≤1 extra.
  expect(afterCount - initialCount).toBeLessThanOrEqual(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Navigate away and back — relay reconnects within 20 s on return
// ─────────────────────────────────────────────────────────────────────────────
test('WS gate: relay reconnects within 20 s after navigating back to /chat', async ({ page }) => {
  const relayOpens = [];

  page.on('websocket', ws => {
    if (!isRelayWs(ws.url())) return;
    relayOpens.push({ url: ws.url(), at: Date.now() });
    console.log(`[relay] open  ${ws.url()}`);
  });

  await loginAsOwner(page);
  await page.goto(CHAT_URL);
  await page.waitForLoadState('load');

  // Wait for initial relay WS.
  await expect.poll(() => relayOpens.length, { timeout: 15_000, intervals: [300] })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_500);

  const opensBeforeNav = relayOpens.length;
  console.log(`Relay opens before nav away: ${opensBeforeNav}`);

  // Navigate to a non-chat route.
  await page.goto('http://localhost:7075/server-health');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1_000);

  // Navigate back and time the reconnect.
  const returnTime = Date.now();
  await page.goto(CHAT_URL);
  await page.waitForLoadState('load');

  // Wait for a new relay WS to open after return.
  await expect.poll(() => relayOpens.length > opensBeforeNav, {
    timeout: WS_RECONNECT_TIMEOUT_MS, intervals: [300],
  }).toBe(true);

  const elapsed = Date.now() - returnTime;
  console.log(`Relay reconnected ${elapsed} ms after return to /chat`);
  expect(elapsed).toBeLessThan(WS_RECONNECT_TIMEOUT_MS);
});
