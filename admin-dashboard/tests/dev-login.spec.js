// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Dev login integration tests.
 * Requires: `npm run dev` at localhost:7075 AND backend at localhost:7676 (via Docker).
 * Tests real auth flow — no mocks.
 */

// Clear session between tests
test.beforeEach(async ({ page }) => {
  await page.goto('/auth/logout');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAs(page, persona) {
  await page.goto(`/auth/dev-login/${persona}`);
  // Wait for React to settle after redirect
  await page.waitForLoadState('networkidle');
}

async function getAuthMe(page) {
  const resp = await page.request.get('/auth/me');
  if (!resp.ok()) return null;
  const json = await resp.json();
  return json.data ?? null;
}

// ── ADMIN persona ─────────────────────────────────────────────────────────────
test.describe('dev-login/admin', () => {
  test('redirects to /server-health and session is set', async ({ page }) => {
    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/server-health/);
    const me = await getAuthMe(page);
    expect(me).not.toBeNull();
    expect(me.role).toBe('admin');
  });

  test('shows CHAT, MODERATION, SYSTEM tabs', async ({ page }) => {
    await loginAs(page, 'admin');
    const nav = page.locator('nav');
    await expect(nav).toContainText('CHAT');
    await expect(nav).toContainText('MODERATION');
    await expect(nav).toContainText('SYSTEM');
  });

  test('can access /feed', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/feed');
    await expect(page).toHaveURL(/\/feed/);
    await expect(page.locator('h1')).toContainText('LIVE GLOBAL FEED');
  });

  test('can access /users', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/users');
    await expect(page).toHaveURL(/\/users/);
  });
});

// ── MOD persona ───────────────────────────────────────────────────────────────
test.describe('dev-login/mod', () => {
  test('redirects to /server-health and session is set', async ({ page }) => {
    await loginAs(page, 'mod');
    await expect(page).toHaveURL(/\/server-health/);
    const me = await getAuthMe(page);
    expect(me).not.toBeNull();
    expect(me.role).toBe('moderator');
  });

  test('shows MODERATION tab', async ({ page }) => {
    await loginAs(page, 'mod');
    await expect(page.locator('nav')).toContainText('MODERATION');
  });
});

// ── SUPPORTER persona ─────────────────────────────────────────────────────────
test.describe('dev-login/supporter', () => {
  test('redirects to /server-health and session is set', async ({ page }) => {
    await loginAs(page, 'supporter');
    await expect(page).toHaveURL(/\/server-health/);
    const me = await getAuthMe(page);
    expect(me).not.toBeNull();
    expect(me.role).toBe('supporter');
  });
});

// ── USER persona ──────────────────────────────────────────────────────────────
test.describe('dev-login/user', () => {
  test('redirects to /chat and session is set', async ({ page }) => {
    await loginAs(page, 'user');
    await expect(page).toHaveURL(/\/chat/);
    const me = await getAuthMe(page);
    expect(me).not.toBeNull();
    expect(me.role).toBe('user');
  });

  test('only shows CHAT tab with OVERLAY subtab', async ({ page }) => {
    await loginAs(page, 'user');
    const nav = page.locator('nav');
    await expect(nav).toContainText('CHAT');
    await expect(nav).not.toContainText('MODERATION');
    await expect(nav).toContainText('SYSTEM');
    await expect(nav).not.toContainText('FEED');
    await expect(nav).not.toContainText('CHANNELS');
  });

  test('navigating to /feed redirects to /chat', async ({ page }) => {
    await loginAs(page, 'user');
    await page.goto('/feed');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/chat/);
  });

  test('navigating to /users redirects to /chat', async ({ page }) => {
    await loginAs(page, 'user');
    await page.goto('/users');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/chat/);
  });

  test('navigating to /server-health redirects to /chat', async ({ page }) => {
    await loginAs(page, 'user');
    await page.goto('/server-health');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/chat/);
  });

  test('no ADMIN TERMINAL text visible', async ({ page }) => {
    await loginAs(page, 'user');
    await expect(page.locator('text=ADMIN TERMINAL')).not.toBeVisible();
  });
});

// ── Unauthenticated ───────────────────────────────────────────────────────────
test.describe('unauthenticated', () => {
  test('navigating to /chat redirects to /login', async ({ page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/login/);
  });

  test('navigating to /server-health redirects to /login', async ({ page }) => {
    await page.goto('/server-health');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────
test.describe('logout', () => {
  test('logout clears session and redirects to landing', async ({ page }) => {
    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/server-health/);
    await page.goto('/auth/logout');
    await page.waitForLoadState('networkidle');
    // After logout, hitting a protected route should go to /login
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/login/);
  });
});
