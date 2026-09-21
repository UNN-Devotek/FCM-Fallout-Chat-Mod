import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function pollCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('polls' in value) || typeof value.polls !== 'number') return -1;
  return value.polls;
}

for (const fault of ['throw', 'malformed', 'oversized'] as const) {
  test(`packaged storage diagnostics distinguish ${fault} without exposing payloads`, async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
      ? route.continue() : route.abort());
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
    await page.goto(`/?mode=packaged-bridge&provider=zfe&scenario=packaged-probe-${fault}`);
    await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ writes: 0, active: false, violation: false,
      storageDiagnostic: fault === 'throw' ? '__ZFE call E1014' : '__ZFE parse error' });
    expect(JSON.stringify(await snapshot())).not.toContain('private');
    await page.evaluate(() => window.__FCM_SIM__?.packaged('storage-capability'));
    await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ active: true, storageDiagnostic: '__ZFE ready', violation: false });
    const stopped = await page.evaluate(() => window.__FCM_SIM__?.packaged('unload'));
    await page.waitForTimeout(1200);
    expect(await snapshot()).toEqual(stopped);
  });
}

for (const scenario of ['packaged-legacy', 'packaged-legacy-unavailable']) {
  test(`ZFE BRG_OBJ fallback requires storage capability and exports through ${scenario}`, async ({ page }) => {
    test.setTimeout(40_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
      ? route.continue() : route.abort());
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
    await page.goto(`/?mode=packaged-bridge&provider=zfe&scenario=${scenario}`);
    if (scenario === 'packaged-legacy-unavailable') {
      await expect.poll(async () => pollCount(await snapshot()), { timeout: 15_000 }).toBeGreaterThan(5);
      expect(await snapshot()).toMatchObject({ active: false, writes: 0, registered: false, violation: false });
      await page.evaluate(() => window.__FCM_SIM__?.packaged('storage-capability'));
    }
    await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ isolated: true, active: true,
      registered: true, subscriptions: 8, violation: false, snapshot: { build: expect.any(String), provider: 'zfe',
        environment: 'dev', state: 'active', names: ['PeerA', 'PeerB'] } });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('loading'));
    await expect.poll(snapshot, { timeout: 10_000 }).toMatchObject({ controls: 1, leaves: 0, snapshot: { state: 'holding' } });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('resume'));
    await expect.poll(snapshot, { timeout: 10_000 }).toMatchObject({ controls: 1, leaves: 0, snapshot: { state: 'active' } });
    const stopped = await page.evaluate(() => window.__FCM_SIM__?.packaged('unload'));
    expect(stopped).toMatchObject({ disposed: true, subscriptions: 0, violation: false });
    await page.waitForTimeout(1200);
    expect(await snapshot()).toEqual(stopped);
    expect(errors).toEqual([]);
  });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__FCM_SIM_TEARDOWN__?.()).catch(() => undefined);
  await expect(page.locator('#ruffle-player')).toHaveCount(0);
});

test('isolated host cannot link production helpers and tests exact packaged bytes', async () => {
  const host = await readFile(new URL('../packaged-bridge.hxml', import.meta.url), 'utf8');
  expect(host).not.toContain('--class-path ..');
  const bytes = await readFile(new URL('../public/FCMServerBridge.swf', import.meta.url));
  expect(bytes.includes(Buffer.from('FcmJson'))).toBe(true);
  expect(bytes.includes(Buffer.from('JsonParser'))).toBe(false);
  const manifest: unknown = JSON.parse(await readFile(new URL('../public/bridge-manifest.json', import.meta.url), 'utf8'));
  expect(manifest).toMatchObject({ target: 'dev', swfSha256: createHash('sha256').update(bytes).digest('hex') });
  const hostBytes = await readFile(new URL('../public/PackagedBridgeHost.swf', import.meta.url));
  // FCMServerBridge is only an assertion string; no other production definitions may be supplied.
  for (const symbol of ['FcmRoster', 'FcmHudRosterReader', 'FcmBridgeState', 'FcmNativeApi', 'FcmBridgeStorage', 'FcmBridgeExport', 'FCMChatWidget']) {
    expect(hostBytes.includes(Buffer.from(symbol)), symbol).toBe(false);
  }
});

test('packaged bridge is input and loader-menu silent', async () => {
  const source = await readFile(new URL('../../../hudmodloader-bridge/FCMServerBridge.hx', import.meta.url), 'utf8');
  const bytes = await readFile(new URL('../public/FCMServerBridge.swf', import.meta.url));
  for (const forbidden of ['SharedHUDTools', 'HUDMod::UserEvent', 'ShowMenu', 'CloseMenu']) {
    expect(source, forbidden).not.toContain(forbidden);
    expect(bytes.includes(Buffer.from(forbidden)), forbidden).toBe(false);
  }
});

test('packaged bridge leaves the xScal callback name untouched until xScal attaches', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
    ? route.continue() : route.abort());
  const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
  await page.goto('/?mode=packaged-bridge&provider=xscal&scenario=packaged-xscal-late');
  await expect.poll(async () => pollCount(await snapshot()), { timeout: 15_000 }).toBeGreaterThan(5);
  expect(await snapshot()).toMatchObject({ active: false, registered: false, stageProviderReserved: false, violation: false });
  await page.evaluate(() => window.__FCM_SIM__?.packaged('storage-capability'));
  await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ active: true, registered: true,
    stageProviderReserved: false, violation: false });
});

for (const provider of ['xscal', 'zfe']) {
  for (const boundary of ['getter', 'subscribe']) {
    test(`unload inside native ${boundary} stops ${provider} polling, subscriptions and exports`, async ({ page }) => {
      await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
        ? route.continue() : route.abort());
      const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
      await page.goto(`/?mode=packaged-bridge&provider=${provider}&scenario=packaged-unload-${boundary}`);
      await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ disposed: true, subscriptions: 0, writes: 0, violation: false });
      const stopped = await snapshot();
      await page.waitForTimeout(1200);
      expect(await snapshot()).toEqual(stopped);
    });
  }

  test(`storage failure is bounded and recovers without native chat calls through ${provider}`, async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
      ? route.continue() : route.abort());
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
    await page.goto(`/?mode=packaged-bridge&provider=${provider}`);
    await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ active: true, violation: false });
    const before = await snapshot() as { writes: number; snapshot: { sequence: number } };
    await page.evaluate(() => window.__FCM_SIM__?.packaged('storage-fail'));
    await expect.poll(async () => (await snapshot() as { writes: number }).writes, { timeout: 10_000 }).toBeGreaterThan(before.writes + 1);
    expect(await snapshot()).toMatchObject({ violation: false, snapshot: { sequence: before.snapshot.sequence } });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('storage-recover'));
    await expect.poll(async () => (await snapshot() as { snapshot: { sequence: number } }).snapshot.sequence,
      { timeout: 10_000 }).toBeGreaterThan(before.snapshot.sequence);
    expect(await snapshot()).toMatchObject({ active: true, violation: false, controls: 1 });
  });

  test(`loads isolated packaged bridge through ${provider}, exports fresh snapshots and tears down`, async ({ page }) => {
    test.setTimeout(40_000);
    const errors: string[] = [];
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== 'http://127.0.0.1:41739') {
        errors.push('Unexpected nonlocal request'); await route.abort(); return;
      }
      await route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
    await page.goto(`/?mode=packaged-bridge&provider=${provider}`);
    await expect(page.locator('#log')).toContainText(`PACKAGED loaded provider=${provider} isolated=true`);
    await expect.poll(snapshot, { timeout: 15_000 }).toMatchObject({ isolated: true, registered: true,
      active: true, controls: 1, subscriptions: 8, acceptedNames: true, violation: false,
      snapshot: { schemaVersion: 1, environment: 'dev', provider, state: 'active', ownName: 'HarnessSelf', names: ['PeerA', 'PeerB'] } });
    if (provider === 'xscal') {
      const named = await snapshot() as { registerCalls: number; namedWrites: number };
      expect(named.registerCalls).toBe(0);
      expect(named.namedWrites).toBeGreaterThan(0);
    }
    await page.evaluate(() => window.__FCM_SIM__?.packaged('loading'));
    // Wait for real production poll ticks, not private-state calls or patched clocks.
    const before: unknown = await snapshot();
    expect(before).toMatchObject({ controls: 1, leaves: 0 });
    await expect.poll(async () => pollCount(await snapshot()), { timeout: 10_000 }).toBeGreaterThan(pollCount(before) + 2);
    expect(await snapshot()).toMatchObject({ controls: 1, leaves: 0 });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('resume'));
    const resumed = pollCount(await snapshot());
    await expect.poll(async () => pollCount(await snapshot()), { timeout: 10_000 }).toBeGreaterThan(resumed + 2);
    await expect.poll(snapshot).toMatchObject({ active: true, controls: 1, leaves: 0, rebound: false });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('hop'));
    await expect.poll(snapshot, { timeout: 10_000 }).toMatchObject({ active: true, controls: 2, leaves: 0,
      rebound: true, acceptedNames: true, violation: false });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('main-menu'));
    await expect.poll(snapshot, { timeout: 10_000 }).toMatchObject({ active: false, controls: 2, leaves: 1 });
    const stopped = await page.evaluate(() => window.__FCM_SIM__?.packaged('unload'));
    expect(stopped).toMatchObject({ disposed: true, subscriptions: 0, violation: false });
    // Observe more than two production 500 ms timer periods after removal.
    await page.waitForTimeout(1200);
    expect(await snapshot()).toEqual(stopped);
    expect(errors).toEqual([]);
  });

  test(`rejects unready cross-domain roster and recovers through ${provider}`, async ({ page }) => {
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
      ? route.continue() : route.abort());
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.packaged('snapshot'));
    await page.goto(`/?mode=packaged-bridge&provider=${provider}&scenario=packaged-unready`);
    await expect(page.locator('#log')).toContainText(`PACKAGED loaded provider=${provider} isolated=true`);
    await expect.poll(async () => pollCount(await snapshot()), { timeout: 15_000 }).toBeGreaterThan(5);
    expect(await snapshot()).toMatchObject({ registered: true, subscriptions: 8, controls: 0, active: false, violation: false });
    await page.evaluate(() => window.__FCM_SIM__?.packaged('resume'));
    await expect.poll(snapshot, { timeout: 10_000 }).toMatchObject({ controls: 1, active: true, acceptedNames: true, violation: false });
  });
}
