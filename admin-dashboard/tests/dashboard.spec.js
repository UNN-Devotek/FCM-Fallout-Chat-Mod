// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Admin Dashboard Playwright Tests
 *
 * These tests use Playwright's route interception to mock API calls.
 * Run with: npm test (requires `npm run dev` running on port 3000)
 *
 * Pre-condition: set up auth mock so /auth/me returns a valid admin user.
 */

const MOCK_USER = {
  id: '1234',
  username: 'TestModerator',
  avatar: null,
  roles: ['moderator-role-id'],
};

const MOCK_CHANNELS = [
  { id: 'ch-1', name: 'General', color: '#18FF62', discord_relay: false },
  { id: 'ch-2', name: 'Trading', color: '#00aaff', discord_relay: true },
];

const MOCK_REPORTS = [
  {
    id: 'rep-1',
    reporter_username: 'Alice',
    target_username: 'BadActor',
    reason: 'Spamming',
    status: 'open',
    created_at: new Date().toISOString(),
    message_id: null,
  },
];

const MOCK_AUDIT_LOGS = [
  {
    id: 'log-1',
    actor: 'TestModerator',
    action: 'ban',
    target_type: 'user',
    target_id: 'user-uuid-1234',
    reason: 'Trolling',
    created_at: new Date().toISOString(),
  },
];

const MOCK_HEALTH = {
  status: 'ok',
  uptime: 3600,
  database: 'connected',
  redis: 'connected',
  discord: 'connected',
  websocket_clients: 3,
  timestamp: new Date().toISOString(),
};

const MOCK_WORD_FILTERS = [
  { id: 1, phrase: 'badword', is_regex: false, created_at: new Date().toISOString() },
];

// Helper: set up common API mocks
async function setupMocks(page) {
  await page.route('/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_USER }) })
  );
  await page.route('/api/channels*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_CHANNELS }) })
  );
  await page.route('/api/reports*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_REPORTS }) })
  );
  await page.route('/api/audit-log*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_AUDIT_LOGS }) })
  );
  await page.route('/api/health*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_HEALTH) })
  );
  await page.route('/api/moderation/word-filter*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_WORD_FILTERS }) })
  );
  await page.route('/api/users*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
  );
}

// ── Live Feed ─────────────────────────────────────────────────────────────────
test.describe('Live Feed page', () => {
  test('renders live feed section with correct heading', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('LIVE GLOBAL FEED');
  });

  test('shows connection status indicator', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/');
    // WS won't connect in test, so it should show OFFLINE
    await expect(page.locator('span:has-text("OFFLINE"), span:has-text("LIVE")')).toBeVisible({ timeout: 5000 });
  });

  test('shows waiting for messages placeholder when empty', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/');
    const feed = page.locator('[data-testid="live-feed"]');
    await expect(feed).toBeVisible();
    await expect(feed).toContainText('Waiting for messages');
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────
test.describe('Reports page', () => {
  test('renders reports table', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/reports');
    await expect(page.locator('h1')).toContainText('REPORTS QUEUE');
    await expect(page.locator('[data-testid="report-row"]')).toHaveCount(1);
  });

  test('shows status filter dropdown', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/reports');
    const filter = page.locator('[data-testid="status-filter"]');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveValue('open');
  });

  test('shows view button for each report', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/reports');
    await expect(page.locator('[data-testid="view-report-btn"]')).toHaveCount(1);
  });

  test('report row shows correct data', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/reports');
    const row = page.locator('[data-testid="report-row"]').first();
    await expect(row).toContainText('Alice');
    await expect(row).toContainText('BadActor');
    await expect(row).toContainText('Spamming');
  });
});

// ── Channels ──────────────────────────────────────────────────────────────────
test.describe('Channels page', () => {
  test('renders channels table', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/channels');
    await expect(page.locator('h1')).toContainText('CHANNELS');
    await expect(page.locator('[data-testid="channel-row"]')).toHaveCount(2);
  });

  test('create channel form is visible', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/channels');
    await expect(page.locator('[data-testid="channel-name-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="create-channel-btn"]')).toBeVisible();
  });

  test('create button has min 44px touch target', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/channels');
    const btn = page.locator('[data-testid="create-channel-btn"]');
    const box = await btn.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

// ── Audit Log ─────────────────────────────────────────────────────────────────
test.describe('Audit Log page', () => {
  test('renders audit log table', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/audit-log');
    await expect(page.locator('h1')).toContainText('AUDIT LOG');
    await expect(page.locator('[data-testid="audit-row"]')).toHaveCount(1);
  });

  test('filter inputs are present', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/audit-log');
    await expect(page.locator('[data-testid="audit-action-filter"]')).toBeVisible();
    await expect(page.locator('[data-testid="apply-filters-btn"]')).toBeVisible();
  });

  test('audit row shows action', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/audit-log');
    const row = page.locator('[data-testid="audit-row"]').first();
    await expect(row).toContainText('ban');
  });
});

// ── Server Health ─────────────────────────────────────────────────────────────
test.describe('Server Health page', () => {
  test('renders health cards', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/server-health');
    await expect(page.locator('h1')).toContainText('SERVER HEALTH');
    const cards = page.locator('[data-testid="health-card"]');
    await expect(cards).toHaveCount(8);
  });

  test('shows connected status for db and redis', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/server-health');
    await expect(page.locator('[data-testid="health-card"]')).toContainText('CONNECTED');
  });
});

// ── Auto-Moderation ───────────────────────────────────────────────────────────
test.describe('Auto-Moderation page', () => {
  test('renders word filter list', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/moderation');
    await expect(page.locator('h1')).toContainText('AUTO-MODERATION');
    await expect(page.locator('[data-testid="filter-row"]')).toHaveCount(1);
  });

  test('word filter input and add button are present', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/moderation');
    await expect(page.locator('[data-testid="word-filter-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-filter-btn"]')).toBeVisible();
  });
});

// ── Sidebar navigation ────────────────────────────────────────────────────────
test.describe('Sidebar navigation', () => {
  test('shows nav items when authenticated', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/');
    await expect(page.locator('nav')).toContainText('Live Feed');
    await expect(page.locator('nav')).toContainText('Users');
    await expect(page.locator('nav')).toContainText('Reports');
  });

  test('navigates to reports page', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/');
    await page.click('a[href="/reports"]');
    await expect(page).toHaveURL(/\/reports/);
    await expect(page.locator('h1')).toContainText('REPORTS QUEUE');
  });

  test('all action buttons meet 44px minimum touch target', async ({ page }) => {
    await setupMocks(page);
    // Check moderation page buttons
    await page.goto('/moderation');
    const addBtn = page.locator('[data-testid="add-filter-btn"]');
    const box = await addBtn.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
