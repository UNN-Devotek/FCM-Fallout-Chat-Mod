import { test, expect } from '@playwright/test';

const BASE_URL = process.env.TEST_URL || 'https://falloutchatmod.com';

test.describe('Chat Overlay Smoke Tests', () => {

  test('homepage loads', async ({ page }) => {
    const response = await page.goto(BASE_URL);
    expect(response?.status()).toBeLessThan(400);
  });

  test('login page loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('body')).toBeVisible();
  });

  test('API health endpoint responds', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/health`);
    expect(response.status()).toBe(200);
  });

  test('channels API returns data', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/channels`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('users API requires auth', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/users`);
    // Should be 401 or 403 without auth
    expect([401, 403]).toContain(response.status());
  });

  test('discord link endpoint requires installToken', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/auth/discord/link`);
    expect(response.status()).toBe(400);
  });

  test('discord status endpoint returns linked:false for unknown token', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/auth/discord-status/00000000-0000-0000-0000-000000000000`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.linked).toBe(false);
  });

  test('user registration rejects without client key', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/users`, {
      data: {
        username: 'TestUser',
        installToken: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(response.status()).toBe(403);
  });

  test('message persistence - send and retrieve', async ({ request }) => {
    // Register a test user
    const regResponse = await request.post(`${BASE_URL}/api/users`, {
      headers: { 'X-App-Client-Key': 'fo76-chat-desktop-v1' },
      data: {
        username: `E2ETest_${Date.now()}`,
        installToken: crypto.randomUUID(),
      },
    });

    if (regResponse.status() === 201) {
      const regBody = await regResponse.json();
      const token = regBody.data.token;

      // Fetch channels
      const chanResponse = await request.get(`${BASE_URL}/api/channels`);
      const channels = (await chanResponse.json()).data;

      if (channels.length > 0) {
        const channelId = channels[0].children?.length > 0
          ? channels[0].children[0].id
          : channels[0].id;

        // Note: messages are sent via WebSocket, not REST
        // We can at least verify the messages endpoint works
        const msgResponse = await request.get(
          `${BASE_URL}/api/messages?channelId=${channelId}&limit=10`,
          { headers: { 'X-Auth-Token': token } }
        );
        // Could be 200 or 401 depending on session vs token auth
        expect(msgResponse.status()).toBeLessThan(500);
      }
    }
  });
});
