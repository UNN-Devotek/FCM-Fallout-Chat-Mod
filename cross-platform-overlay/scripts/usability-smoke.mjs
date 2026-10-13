#!/usr/bin/env node
// Real Electron + preload + shared renderer, with an isolated local relay/profile.
// Run after build:renderer, under xvfb-run on Linux CI. No hosted account or game.
import { _electron as electron, expect } from '../../admin-dashboard/node_modules/playwright/test.mjs';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = await mkdtemp(`${tmpdir()}/fcm-usability-`);
const packagedExecutable = process.env.FCM_TEST_EXECUTABLE;
const profile = packagedExecutable ? resolve(testRoot, 'FCMData') : testRoot;
const artifacts = resolve(process.env.FCM_TEST_ARTIFACTS || resolve(root, 'test-results/overlay-usability'));
const standardTabs = ['General', 'Trading', 'Events', 'Infests', 'Raids'];
const channels = [{ id: 'fo76', name: 'Fallout 76', parentId: null, color: '#F5CB5B', children:
  standardTabs.map(name => ({ id: name.toLowerCase(), name, parentId: 'fo76', color: '#F5CB5B' })),
}];
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  let data = [];
  if (path === '/api/users') data = { token: 'fixture-only-session', userId: 'alice', username: 'Alice', displayName: 'Alice', discordLinked: true, role: 'admin' };
  else if (path === '/api/channels') data = channels;
  else if (path === '/api/block') data = { blocked: [] };
  else if (path.startsWith('/api/parties/invites')) data = { invites: [] };
  else if (path.startsWith('/api/parties')) data = { parties: [] };
  else if (path.includes('/discord-status/')) data = { linked: true, discordUsername: 'Alice' };
  else if (path.includes('/steam-status/')) data = { linked: false };
  else if (path === '/api/version') data = { version: '1.4.0' };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data }));
});
const relay = new WebSocketServer({ server });
let connectionCount = 0;
let sentMessages = 0;
let moderationHistoryFixture = false;
let moderationSubscriptions = 0;
let moderationHistoryRequests = 0;
const moderationPage = (second = false) => ({ type: 'server:moderation:messages', payload: {
  historyReplay: true, hasMore: !second, nextCursor: second ? null : 'r:auto-a', messages: [{
    id: second ? 'auto-second' : 'auto-first', channelId: second ? 'server:r:auto-b' : 'server:r:auto-a',
    serverDisplayId: second ? '902' : '901', username: 'Fixture', source: 'server',
    timestamp: new Date().toISOString(), content: second ? 'Automatic second Server room' : 'Automatic first Server room',
  }],
} });
relay.on('connection', socket => {
  connectionCount++;
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'server:moderation:subscribe') socket.send(JSON.stringify({ type: 'server:moderation:state', payload: { status: frame.payload.enabled ? 'ready' : 'inactive' } }));
    if (frame.type === 'server:moderation:subscribe' && frame.payload.enabled) {
      moderationSubscriptions++;
      if (moderationHistoryFixture) socket.send(JSON.stringify(moderationPage()));
    }
    if (frame.type === 'server:moderation:history' && moderationHistoryFixture) {
      moderationHistoryRequests++;
      assert.equal(frame.payload.cursor, 'r:auto-a');
      socket.send(JSON.stringify(moderationPage(true)));
    }
    if (frame.type === 'chat:send') {
      sentMessages++;
      socket.send(JSON.stringify({ type: 'chat:message', payload: {
        ...frame.payload, id: `sent-fixture-${sentMessages}`, userId: 'alice', username: 'Alice',
        source: 'game', timestamp: new Date().toISOString(),
      } }));
    }
    if (frame.type === 'presence:stats') socket.send(JSON.stringify({ type: 'presence:stats', payload: {
      requestId: frame.payload.requestId, totalOnline: 17, observedPlayers: null, bindingId: null,
    } }));
    if (frame.type === 'chat:history') {
      const channelId = frame.payload.channelId;
      socket.send(JSON.stringify({ type: 'chat:history', payload: { messages: Array.from({ length: 80 }, (_, index) => ({
        id: `${channelId}-${index}`, channel_id: channelId, user_id: 'bob', username: 'Bob',
        content: `${channelId} message ${index}: readable chat`, source: 'game', effectId: 'shimmer',
        created_at: new Date(Date.UTC(2026, 8, 16, 12, index)).toISOString(),
      })) } }));
    }
  });
});

let app;
let page;
const errors = [];
try {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  await mkdir(profile, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await writeFile(`${profile}/overlay-state.json`, JSON.stringify({
    installToken: 'usability-fixture-only', username: 'Alice', displayName: 'Alice',
    discordLinked: true, userRole: 'admin', settings: { onboarded: true, fadeWhenIdle: true, idleCollapseSeconds: 120, fontSize: 14 },
  }));
  const env = { ...process.env, BUILD_CHANNEL: 'stable', APP_CLIENT_KEY: 'fixture-only-client',
    RELAY_HTTP: `http://127.0.0.1:${port}`, RELAY_WS: `ws://127.0.0.1:${port}/ws`,
    XDG_CURRENT_DESKTOP: '', XDG_SESSION_DESKTOP: '', XDG_SESSION_TYPE: 'x11',
  };
  if (packagedExecutable) env.PORTABLE_EXECUTABLE_DIR = testRoot;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'APPIMAGE', 'APPDIR', 'RENDERER_URL', 'WAYLAND_DISPLAY',
    'OVERLAY_SHOT', 'OVERLAY_FIRE', 'DEV_PERSONA_LOGIN_SECRET']) delete env[key];
  async function launch() {
    app = await electron.launch({
      executablePath: packagedExecutable || resolve(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
      args: [...(packagedExecutable ? [] : [root]), `--user-data-dir=${profile}`, ...(process.platform === 'linux' ? ['--ozone-platform=x11', '--no-sandbox'] : [])],
      env, timeout: 30_000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('general message 79: readable chat', { exact: true }).waitFor();
    // Presence is sampled asynchronously after every launch, including restart.
    // Do not race its legitimate game-launch wake against a hide assertion.
    // Portable startup legitimately queues a 20s hidden visibility grace when
    // the game is closed. Let it finish before supplying visible fixture state.
    await page.waitForTimeout(packagedExecutable ? 25000 : 5000);
    // Packaged Windows normally hides when the game is absent. The fixture must
    // explicitly show its own window; never launch/spoof/input-automate the game.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.webContents.send('overlay:game-state', true);
      window.webContents.send('overlay:visibility', true);
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  }
  const command = value => app.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0].webContents.send('overlay:command', cmd), value);
  const composer = () => page.locator('[contenteditable="true"]').first();
  await launch();
  // Preserve bottom-follow through layout scroll, late content and viewport
  // changes. No wheel/key/pointer input means these are not a reading gesture.
  await page.evaluate(async () => {
    const list = document.querySelector('[data-fcm-message-line]').closest('.fcm-scrollbar');
    window.dispatchEvent(new Event('fcm-scroll-bottom'));
    await new Promise(resolve => setTimeout(resolve, 200));
    list.scrollTop = 100;
    list.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => {
    const list = document.querySelector('[data-fcm-message-line]').closest('.fcm-scrollbar');
    return list.scrollHeight - list.scrollTop - list.clientHeight;
  })).toBeLessThan(3);
  const presetBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const applyPreset = async (width, height) => {
    await app.evaluate(({ ipcMain }, bounds) => ipcMain.emit('window:set-bounds', {}, bounds), { ...presetBounds, width, height });
    // Let native resize notification and renderer reflow arrive before checking
    // scroll position; an immediate check could read the previous viewport.
    await page.waitForTimeout(160);
  };
  const bottomDistance = () => page.evaluate(() => {
    const list = document.querySelector('[data-fcm-message-line]').closest('.fcm-scrollbar');
    return list.scrollHeight - list.scrollTop - list.clientHeight;
  });
  for (let cycle = 0; cycle < 10; cycle++) {
    await applyPreset(420, 280);
    await expect.poll(bottomDistance).toBeLessThan(3);
    await applyPreset(700, 560);
    await expect.poll(bottomDistance).toBeLessThan(3);
  }
  await applyPreset(700, 560);
  for (const content of ['Large-size send first', 'Large-size send newest']) {
    await composer().fill(content); await composer().press('Enter');
    await expect(page.getByText(content, { exact: true })).toBeVisible();
  }
  assert.equal(sentMessages, 2, 'both test messages must reach the isolated relay');
  await applyPreset(420, 280);
  await expect.poll(bottomDistance).toBeLessThan(3);
  await expect(page.getByText('Large-size send newest', { exact: true })).toBeInViewport();
  console.log('PASS send two messages in large size, shrink, newest remains visible without Insert');
  // Real wheel input to the overlay only establishes intentional reading.
  await page.locator('[data-fcm-message-line]').last().hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(bottomDistance).toBeGreaterThan(100);
  for (let cycle = 0; cycle < 3; cycle++) {
    await applyPreset(420, 280); await page.waitForTimeout(150);
    await expect.poll(bottomDistance).toBeGreaterThan(100);
    await applyPreset(700, 560); await page.waitForTimeout(150);
    await expect.poll(bottomDistance).toBeGreaterThan(100);
  }
  await applyPreset(presetBounds.width, presetBounds.height);
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-scroll-bottom')));
  await expect.poll(bottomDistance).toBeLessThan(3);
  console.log('PASS repeated saved-size changes preserve bottom-follow and intentional history reading');
  // Exercise real renderer collapse layout and native size IPC, not just source
  // contracts. This does not send input to any game process.
  const animationSamples = [];
  for (const mode of ['subtabs', 'full']) {
    for (let cycle = 0; cycle < 3; cycle++) {
      const samples = await page.evaluate(async mode => {
        window.__ovTest.setAutoHideMode(mode);
        // Real idle collapse occurs after settings/render work has settled.
        // Do not include a full settings re-render in the fade frame budget.
        await new Promise(resolve => setTimeout(resolve, 500));
        const samples = [];
        const start = performance.now();
        window.__ovTest.collapse();
        await new Promise(resolve => {
          const sample = () => {
            samples.push({ time: performance.now() - start, height: window.innerHeight, opacity: Number(getComputedStyle(document.body).opacity), clip: getComputedStyle(document.body).clipPath });
            if (performance.now() - start < 1000) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return samples;
      }, mode);
      animationSamples.push({ mode, cycle, samples });
      await writeFile(`${artifacts}/animation-samples.json`, JSON.stringify(animationSamples, null, 2));
      if (mode === 'full') {
        assert.ok(samples.some(sample => sample.opacity > 0 && sample.opacity < 1), 'full hide must paint intermediate opacity, not blink');
      } else {
        const first = samples[0].height, last = samples.at(-1).height;
        assert.ok(last < first, 'native height must settle smaller after the visible clip');
        assert.ok(new Set(samples.filter(sample => sample.height === first).map(sample => sample.clip)).size >= 4,
          'visible collapse must animate on the compositor before native resizing');
      }
      if (mode === 'subtabs') {
        await expect(page.locator('[data-fcm-main-tab-row]')).toBeVisible();
        await expect(page.locator('[data-fcm-subtab-row="channels"]')).toBeVisible();
      } else {
        await expect(page.locator('[data-fcm-main-tab-row]')).toBeHidden();
      }
      await expect(composer()).toBeHidden();
      for (const selector of ['#shell-bg-dim', '#shell-scanline']) {
        await expect(page.locator(selector)).toBeHidden();
      }
      for (const pseudo of ['::before', '::after']) {
        assert.equal(await page.evaluate(pseudo => getComputedStyle(document.body, pseudo).visibility, pseudo),
          'hidden', `body${pseudo} must not leave an effect layer behind`);
      }
      // Catch a native rejection/force-expand after renderer collapse.
      await page.waitForTimeout(1500);
      await expect(composer()).toBeHidden();
      await page.evaluate(() => window.__ovTest.expand());
      await expect(composer()).toBeVisible();
      for (const pseudo of ['::before', '::after']) {
        assert.equal(await page.evaluate(pseudo => getComputedStyle(document.body, pseudo).visibility, pseudo), 'visible');
      }
      await composer().fill(`collapse recovery ${cycle}`);
      await expect(composer()).toHaveText(`collapse recovery ${cycle}`);
    }
  }
  await writeFile(`${artifacts}/animation-samples.json`, JSON.stringify(animationSamples, null, 2));
  // A wake during the fade must cancel its delayed hide completion.
  await page.evaluate(async () => {
    window.__ovTest.setAutoHideMode('full'); window.__ovTest.collapse();
    await new Promise(resolve => setTimeout(resolve, 60));
    window.__ovTest.expand();
  });
  await page.waitForTimeout(700);
  await expect(composer()).toBeVisible();
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).opacity), '1');
  // Native focus activation can arrive while the renderer's reveal is pending.
  for (const mode of ['subtabs', 'full']) {
    await page.evaluate(async mode => {
      window.__ovTest.setAutoHideMode(mode); window.__ovTest.collapse();
      await new Promise(resolve => setTimeout(resolve, 600));
      window.__ovTest.expand();
    }, mode);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('overlay:force-expand', true));
    await page.waitForTimeout(700);
    await expect(composer()).toBeVisible();
    assert.equal(await page.evaluate(() => document.getElementById('root').classList.contains('collapsed')), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).opacity), '1');
  }
  await composer().fill('');
  await page.evaluate(() => { window.__ovTest.setAutoHideMode('subtabs'); window.__ovTest.noIdle(); });
  console.log('PASS repeated sub-tab/full collapse visibility, effect-layer hiding and composer recovery');
  // Real header interactions: portals must escape row clipping and not drag the window.
  const headerConnections = connectionCount;
  const actions = page.getByRole('button', { name: 'Overlay actions', exact: true });
  for (let cycle = 0; cycle < 5; cycle++) {
    await actions.click(); await expect(actions).toHaveAttribute('aria-expanded', 'true');
    const settingsItem = page.getByRole('menuitem', { name: 'Settings', exact: true });
    await settingsItem.hover();
    await expect(settingsItem).not.toHaveCSS('box-shadow', 'none');
    await settingsItem.focus();
    await expect(settingsItem).not.toHaveCSS('box-shadow', 'none');
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
    assert.match(await page.getByRole('menu').evaluate(el => getComputedStyle(el).backgroundColor), /^rgb\(/, 'menu must be opaque, not rgba/transparent');
    if (cycle === 0) await page.screenshot({ path: `${artifacts}/header-actions.png` });
    await page.keyboard.press('Escape'); await expect(actions).toHaveAttribute('aria-expanded', 'false');
  }
  await page.getByRole('button', { name: 'Live status', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('17 FCM Online');
  await page.mouse.move(1, 1);
  await page.locator('[data-fcm-main-tab-row]').getByText('PM', { exact: true }).click();
  await expect(page.locator('[data-fcm-main-divider="right"]')).toBeVisible();
  await page.locator('[data-fcm-main-tab-row]').getByText('Fallout 76', { exact: true }).click();
  assert.equal(connectionCount, headerConnections);
  console.log('PASS PM divider, Live counts, repeated actions menu and Escape without reconnect');
  await expect.poll(() => page.locator('[data-fcm-motion-paused]').count()).toBeGreaterThan(0);
  const newestName = page.locator('[data-msg-id="general-79"] .fcm-name-fx--shimmer');
  await newestName.scrollIntoViewIfNeeded();
  await expect(newestName).not.toHaveAttribute('data-fcm-motion-paused');
  await expect(newestName).toHaveCSS('animation-name', 'fcm-shimmer-highlight');
  assert.equal(await newestName.evaluate(name => name.getAnimations()[0].playState), 'paused');
  assert.equal(await newestName.evaluate(name => name.getAnimations()[0].currentTime), 0);
  await page.waitForTimeout(220);
  assert.equal(await newestName.evaluate(name => name.getAnimations()[0].currentTime), 0);
  await expect(newestName.locator('.fcm-shimmer-letter').first()).toHaveCSS('animation-name', 'none');
  // Sample the same animation at its resting/highlight times. No game inputs.
  const shimmerPaint = await newestName.evaluate(name => {
    const animation = name.getAnimations()[0];
    const timing = animation.effect.getTiming();
    const sample = fraction => {
      animation.currentTime = Number(timing.delay) + 8000 * (1 + fraction);
      return { color: getComputedStyle(name).color, shadow: getComputedStyle(name).textShadow,
        text: name.textContent, width: name.getBoundingClientRect().width };
    };
    const previousTime = animation.currentTime;
    try { return { resting: sample(0.5), highlight: sample(0.9) }; }
    finally { animation.currentTime = previousTime; }
  });
  assert.notEqual(shimmerPaint.resting.color, shimmerPaint.highlight.color);
  assert.equal(shimmerPaint.resting.shadow, shimmerPaint.highlight.shadow);
  assert.equal(shimmerPaint.resting.text, shimmerPaint.highlight.text);
  assert.equal(shimmerPaint.resting.width, shimmerPaint.highlight.width);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(newestName).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await newestName.evaluate(name => name.classList.add('fcm-no-name-motion'));
  await expect(newestName).toHaveCSS('animation-name', 'none');
  await newestName.evaluate(name => name.classList.remove('fcm-no-name-motion'));
  await expect(newestName).toHaveCSS('animation-name', 'fcm-shimmer-highlight');
  console.log('PASS desktop name effects retain static styling with no recurring animation');
  const originalNameClass = await newestName.getAttribute('class');
  const chromaName = page.locator('[data-msg-id="general-79"] .fcm-name-fx--chroma-split');
  await newestName.evaluate(name => {
    name.style.setProperty('--fcm-chroma-duration', '12s');
    name.style.setProperty('--fcm-effect-delay', '-9.84s');
    name.classList.replace('fcm-name-fx--shimmer', 'fcm-name-fx--chroma-split');
  });
  await expect(chromaName).toHaveAttribute('data-fcm-chroma', 'a');
  await expect(chromaName).toHaveCSS('animation-name', 'none');
  await expect(chromaName).toHaveCSS('transition-property', 'color, background');
  const burstShadow = await chromaName.evaluate(name => getComputedStyle(name).textShadow);
  await expect(chromaName).toHaveAttribute('data-fcm-chroma', 'rest');
  assert.notEqual(await chromaName.evaluate(name => getComputedStyle(name).textShadow), burstShadow);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(chromaName).not.toHaveAttribute('data-fcm-chroma');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(chromaName).toHaveAttribute('data-fcm-chroma', 'a');
  for (const hiddenClass of ['fcm-full-auto-fading', 'fcm-full-auto-hidden']) {
    try {
      await page.evaluate(value => document.documentElement.classList.add(value), hiddenClass);
      await expect(chromaName).not.toHaveAttribute('data-fcm-chroma');
      await expect(chromaName).toHaveAttribute('data-fcm-motion-paused', '');
    } finally {
      await page.evaluate(value => document.documentElement.classList.remove(value), hiddenClass);
    }
    await expect(chromaName).toHaveAttribute('data-fcm-chroma', 'a');
  }
  await chromaName.evaluate((name, original) => {
    name.setAttribute('class', original);
    name.style.removeProperty('--fcm-chroma-duration');
    name.style.removeProperty('--fcm-effect-delay');
  }, originalNameClass);
  console.log('PASS discrete chroma shadows change without CSS animation and honor reduced motion');
  const glitchName = page.locator('[data-msg-id="general-79"] .fcm-name-fx--glitch');
  await newestName.evaluate(name => {
    name.style.setProperty('--fcm-glitch-duration', '10s');
    name.style.setProperty('--fcm-effect-delay', '-9.1s');
    name.classList.replace('fcm-name-fx--shimmer', 'fcm-name-fx--glitch');
  });
  const glitchPaint = await glitchName.evaluate(async name => {
    const samples = [];
    for (let index = 0; index < 25; index++) {
      const before = getComputedStyle(name, '::before');
      const after = getComputedStyle(name, '::after');
      const animations = name.getAnimations({ subtree: true }).filter(animation =>
        animation.animationName === 'fcm-glitch-r' || animation.animationName === 'fcm-glitch-c');
      samples.push({ red: before.transform, cyan: after.transform, opacity: before.opacity,
        text: name.textContent, width: name.getBoundingClientRect().width,
        states: animations.map(animation => animation.playState) });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return samples;
  });
  await writeFile(`${artifacts}/glitch-paint.json`, JSON.stringify(glitchPaint, null, 2));
  assert.ok(new Set(glitchPaint.map(sample => sample.red)).size >= 4, 'red layer must visit all three tears and rest');
  assert.ok(new Set(glitchPaint.map(sample => sample.cyan)).size >= 4, 'cyan layer must visit all three tears and rest');
  assert.ok(glitchPaint.some(sample => Number(sample.opacity) > 0), 'the burst must actually paint');
  assert.ok(glitchPaint.every(sample => sample.states.length === 2 && sample.states.every(state => state === 'paused')),
    'glitch must use discrete seeks, never continuous browser playback');
  assert.ok(glitchPaint.every(sample => sample.text === glitchPaint[0].text && sample.width === glitchPaint[0].width));
  const checkGlitchStopped = async () => {
    const time = () => glitchName.evaluate(name => name.getAnimations({ subtree: true })
      .filter(animation => animation.animationName === 'fcm-glitch-r' || animation.animationName === 'fcm-glitch-c')
      .map(animation => animation.currentTime));
    await expect.poll(time).toEqual([0, 0]);
    await page.waitForTimeout(350);
    assert.deepEqual(await time(), [0, 0], 'hidden/offscreen glitch must have no advancing clock');
  };
  await glitchName.hover();
  await page.mouse.wheel(0, -3000); // Real reading gesture; bottom-follow must not undo it.
  await expect(glitchName).toHaveAttribute('data-fcm-motion-paused', '');
  await checkGlitchStopped();
  await glitchName.scrollIntoViewIfNeeded();
  await expect(glitchName).not.toHaveAttribute('data-fcm-motion-paused');
  for (const state of ['collapsed', 'fcm-full-auto-fading', 'fcm-full-auto-hidden']) {
    try {
      await page.evaluate(state => (state === 'collapsed' ? document.getElementById('root') : document.documentElement).classList.add(state), state);
      await checkGlitchStopped();
    } finally {
      await page.evaluate(state => (state === 'collapsed' ? document.getElementById('root') : document.documentElement).classList.remove(state), state);
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('overlay:visibility', false));
  await checkGlitchStopped();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('overlay:visibility', true));
  await expect.poll(() => glitchName.evaluate(name => {
    const animations = name.getAnimations({ subtree: true })
      .filter(animation => animation.animationName === 'fcm-glitch-r' || animation.animationName === 'fcm-glitch-c');
    return animations.length === 2 && animations.every(animation => animation.currentTime > 0);
  })).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => glitchName.evaluate(name => name.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await glitchName.evaluate(name => name.classList.add('fcm-no-name-motion'));
  await expect.poll(() => glitchName.evaluate(name => name.getAnimations({ subtree: true }).length)).toBe(0);
  await glitchName.evaluate((name, original) => {
    name.setAttribute('class', original);
    name.style.removeProperty('--fcm-glitch-duration');
    name.style.removeProperty('--fcm-effect-delay');
  }, originalNameClass);
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-scroll-bottom')));
  console.log('PASS glitch paints all discrete tears, stays paused, stops offscreen/hidden and honors motion opt-out');
  await page.evaluate(() => {
    const preview = document.createElement('span');
    preview.id = 'appearance-chroma-check';
    preview.className = 'fcm-name-fx--chroma-split';
    preview.textContent = 'Preview';
    document.body.append(preview);
  });
  try {
    const preview = page.locator('#appearance-chroma-check');
    await expect(preview).toHaveAttribute('data-fcm-status-motion', 'fcm-chroma-preview');
    const shadows = await preview.evaluate(element => {
      const animation = element.getAnimations()[0];
      const paused = animation.playState;
      const initial = animation.currentTime;
      animation.currentTime = 10000;
      const burst = getComputedStyle(element).textShadow;
      animation.currentTime = 11000;
      const rest = getComputedStyle(element).textShadow;
      animation.currentTime = 0;
      return { paused, initial, burst, rest };
    });
    assert.equal(shadows.paused, 'paused');
    assert.equal(shadows.initial, 0);
    assert.notEqual(shadows.burst, shadows.rest);
    await page.waitForTimeout(220);
    assert.equal(await preview.evaluate(element => element.getAnimations()[0].currentTime), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(preview).toHaveCSS('animation-name', 'none');
  } finally {
    await page.evaluate(() => document.querySelector('#appearance-chroma-check')?.remove());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  console.log('PASS appearance preview retains static chroma styling and reduced-motion fallback');
  const initialConnections = connectionCount;
  await composer().fill('draft survives appearance changes');
  const tabRow = page.locator('[data-fcm-subtab-row="channels"]');
  const generalTab = tabRow.getByRole('button', { name: 'General channel', exact: true });
  const tradingTab = tabRow.getByRole('button', { name: 'Trading channel', exact: true });
  const tabLabels = () => tabRow.locator('[data-fcm-tab-key]').allTextContents();
  const windowBeforeDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await tradingTab.dragTo(generalTab);
  const windowAfterDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.equal(windowBeforeDrag.x, windowAfterDrag.x); assert.equal(windowBeforeDrag.y, windowAfterDrag.y);
  assert.deepEqual(await tabLabels(), ['Trading', 'General', ...standardTabs.slice(2)]);
  await expect(composer()).toHaveText('draft survives appearance changes');
  await tradingTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set as default', exact: true }).click();
  await tradingTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide channel', exact: true }).click();
  await expect(tradingTab).toHaveCount(0);
  await page.getByRole('button', { name: 'Channel layout settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Channel layout' })).toContainText('Default: General');
  await page.getByRole('checkbox', { name: 'Trading', exact: true }).check();
  await page.getByRole('button', { name: 'Reset layout and defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(await tabLabels(), standardTabs);
  await tradingTab.focus(); await tradingTab.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Move left', exact: true }).click();
  assert.deepEqual(await tabLabels(), ['Trading', 'General', ...standardTabs.slice(2)]);
  await tradingTab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move right', exact: true }).click();
  assert.equal(connectionCount, initialConnections, 'tab customization must not reconnect');
  await expect(composer()).toHaveText('draft survives appearance changes');
  const from = await tradingTab.boundingBox(), to = await generalTab.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await tabLabels(), standardTabs);
  // Repeated mutations exercise the actual controls, not only pure ordering helpers.
  for (let cycle = 0; cycle < 5; cycle++) {
    await tradingTab.dragTo(generalTab);
    await expect.poll(tabLabels).toEqual(['Trading', 'General', ...standardTabs.slice(2)]);
    await generalTab.dragTo(tradingTab);
    await expect.poll(tabLabels).toEqual(standardTabs);
    await page.getByRole('button', { name: 'Channel layout settings', exact: true }).click();
    for (const name of standardTabs) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    await expect(tabRow.locator('[data-fcm-tab-key]')).toHaveCount(0);
    for (const name of standardTabs) await page.getByRole('checkbox', { name, exact: true }).check();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(tabLabels).toEqual(standardTabs);
    const extra = { id: `fixture-${cycle}`, name: `New channel ${cycle}`, parentId: 'fo76', color: '#F5CB5B' };
    channels[0].children.push(extra);
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'channels:refresh' }));
    const extraTab = tabRow.getByRole('button', { name: `${extra.name} channel`, exact: true });
    await expect(extraTab).toHaveCount(1); // New channels are visible without changing settings.
    extra.name = `Renamed channel ${cycle}`;
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'channels:refresh' }));
    await expect(tabRow.getByRole('button', { name: `${extra.name} channel`, exact: true })).toHaveCount(1);
    await tabRow.getByRole('button', { name: `${extra.name} channel`, exact: true }).click();
    await expect(page).toHaveTitle(new RegExp(extra.name));
    channels[0].children.pop();
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'channels:refresh' }));
    await expect.poll(tabLabels).toEqual(standardTabs);
    await expect(page).toHaveTitle(/General/);
  }
  await generalTab.click();
  assert.equal(connectionCount, initialConnections, 'repeated tab/channel changes must not reconnect');
  await expect(composer()).toHaveText('draft survives appearance changes');
  console.log('PASS five cycles of all-channel hide/restore, bidirectional drag, channel addition/rename/removal');
  console.log('PASS overlay tab drag, keyboard reorder, hide/restore and default fallback preserve draft/socket');
  await page.evaluate(() => { window.usabilityComposer = document.querySelector('[contenteditable="true"]'); });
  await command('settings:open');
  await page.locator('.ss-navbtn').filter({ hasText: /keybinds/i }).click();
  await expect(page.locator('.ss-toggle').filter({ hasText: 'Always show FCM online count' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Channel layout and hidden channels', exact: true })).toHaveCount(0);
  await page.locator('.ss-navbtn').filter({ hasText: /appearance/i }).click();
  await expect(page.locator('[data-fcm-pinned-stats]')).toContainText('17 Online');
  await page.locator('.ss-toggle').filter({ hasText: 'Always show FCM online count' }).click();
  await page.locator('.ss-toggle').filter({ hasText: 'Always show observed server players' }).click();
  await expect(page.locator('[data-fcm-pinned-stats]')).toHaveCount(0);
  await page.locator('.ss-toggle').filter({ hasText: 'Always show FCM online count' }).click();
  await page.locator('.ss-toggle').filter({ hasText: 'Always show observed server players' }).click();
  await expect(page.locator('[data-fcm-pinned-stats]')).toContainText('17 Online');
  await page.getByRole('button', { name: 'Channel layout and hidden channels', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Channel layout' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Raids', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Raids', exact: true }).locator('..')).toHaveCSS('align-items', 'center');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.ss-navbtn').filter({ hasText: /appearance/i }).click();
  const fontButton = page.getByRole('button', { name: 'Chat font', exact: true });
  await fontButton.press('ArrowDown');
  await page.getByRole('option', { name: 'Verdana', exact: true }).click();
  await expect(fontButton).toContainText('Verdana');
  await expect(composer()).toHaveCSS('font-family', /Verdana/);
  await expect(composer()).toHaveText('draft survives appearance changes');
  assert.equal(await page.evaluate(() => window.usabilityComposer === document.querySelector('[contenteditable="true"]')), true, 'font choice must retain the composer node');
  assert.equal(connectionCount, initialConnections, 'font choice must not reconnect');

  // Change color theme independently, using the real custom popover.
  await page.locator('.ss-select-btn').first().click();
  await page.locator('.ss-select-item').filter({ hasText: /^White$/ }).click();
  await expect(composer()).toHaveCSS('font-family', /Verdana/);
  await page.screenshot({ path: `${artifacts}/font-picker.png` });
  await fontButton.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.locator('#shell-settings-backdrop')).toHaveClass(/open/);
  await expect(fontButton).toBeFocused();
  await page.keyboard.press('Escape');

  for (const name of [...standardTabs.slice(1), 'General']) {
    await command('channel:next');
    await expect(page).toHaveTitle(new RegExp(name));
  }
  assert.equal(connectionCount, initialConnections, 'navigation must not reconnect');
  console.log('PASS live font/theme changes and one-step navigation retain chat, draft and socket');

  // A same-account metadata refresh must not remount or erase drafts.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('relay:status', {
    state: 'authenticated', displayName: 'Alice renamed', role: null,
  }));
  await expect(composer()).toHaveText('draft survives appearance changes');
  assert.equal(connectionCount, initialConnections);

  // Wait for startup pinning, then read older messages during recoveries.
  await expect.poll(() => page.evaluate(() => {
    const row = document.querySelector('[data-fcm-message-line]');
    const list = row?.closest('.fcm-scrollbar');
    return !!list && list.scrollHeight > list.clientHeight;
  })).toBe(true);
  await page.evaluate(() => {
    const list = document.querySelector('[data-fcm-message-line]').closest('.fcm-scrollbar');
    window.usabilityList = list;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    list.scrollTop = 150;
    // CSS zoom/display scaling can quantize a requested CSS offset to a physical
    // pixel (e.g. 150 becomes 150.4). Preserve the accepted offset exactly.
    window.usabilityScrollTop = list.scrollTop;
    list.dispatchEvent(new Event('scroll'));
    window.usabilityAnchor = [...list.querySelectorAll('[data-fcm-message-line]')]
      .find(row => row.getBoundingClientRect().top >= list.getBoundingClientRect().top);
    window.usabilityAnchorOffset = window.usabilityAnchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
  });
  // Catch deferred navigation/layout callbacks before introducing a disconnect.
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.usabilityList.scrollTop),
    await page.evaluate(() => window.usabilityScrollTop), 'deferred layout work must respect a reader scrolling up');
  for (let index = 0; index < 10; index++) {
    const before = connectionCount;
    for (const socket of relay.clients) socket.terminate();
    // Preserve the production reconnect backoff (up to 30s plus jitter).
    await expect.poll(() => connectionCount, { timeout: 35_000 }).toBe(before + 1);
    await expect(page.getByText('general message 79: readable chat', { exact: true })).toHaveCount(1);
    await expect(composer()).toHaveText('draft survives appearance changes');
    await expect(page).toHaveTitle(/General/);
    const anchorShift = await page.evaluate(() => window.usabilityAnchor.getBoundingClientRect().top
      - window.usabilityList.getBoundingClientRect().top - window.usabilityAnchorOffset);
    assert.ok(Math.abs(anchorShift) <= 1, `recovery must retain the visible message anchor (shift=${anchorShift})`);
  }
  console.log('PASS ten real relay disconnects retain messages, selected tab, draft and reading position');

  await page.getByRole('button', { name: 'Channel layout settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Default channel', exact: true }).selectOption('trading');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveTitle(/General/); // Setting a startup preference does not interrupt the current conversation.
  await page.reload();
  await expect(page).toHaveTitle(/Trading/);
  await expect(page.getByText('trading message 79: readable chat', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Channel layout settings', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Server', exact: true })).toBeChecked();
  await page.getByRole('combobox', { name: 'Default channel', exact: true }).selectOption('server');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload(); await expect(page).toHaveTitle(/General/);
  await page.getByRole('button', { name: 'Channel layout settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Default channel', exact: true })).toHaveValue('server');
  await page.getByRole('button', { name: 'Reset layout and defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('PASS settings defaults persist across reload, unavailable Server falls back, and new channels default visible');

  await expect.poll(async () => JSON.parse(await readFile(`${profile}/overlay-state.json`, 'utf8')).settings.fontId).toBe('verdana');
  await app.close(); app = null;
  // Exercise the durable native preference fallback, not merely localStorage.
  await rm(`${profile}/Local Storage`, { recursive: true, force: true });
  await launch();
  await expect(composer()).toHaveCSS('font-family', /Verdana/);
  await expect(page.locator('[data-fcm-pinned-stats]')).toContainText('17 Online');
  console.log('PASS native preference persistence after restart and localStorage removal');

  for (const [size, width] of [[9, 320], [14, 520], [22, 800]]) {
    await command('settings:open');
    await page.locator('.ss-navbtn').filter({ hasText: /appearance/i }).click();
    const scale = page.getByText('Scale (font size)', { exact: true }).locator('..').locator('input[type="range"]');
    await scale.evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, size);
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 500), width);
    await expect(composer()).toBeVisible();
    await expect(composer()).toHaveCSS('font-family', /Verdana/);
    const layout = await composer().evaluate(input => {
      const box = input.getBoundingClientRect();
      return { left: box.left, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth + 1 && layout.bottom <= layout.viewportHeight + 1,
      `composer must stay within the viewport at scale ${size}`);
    for (const name of standardTabs) {
      // launch() above replaced the Electron page; do not reuse a locator from
      // the deliberately closed pre-restart renderer.
      const tab = page.locator('[data-fcm-subtab-row="channels"]').getByRole('button', { name: `${name} channel`, exact: true });
      await tab.focus();
      await expect.poll(() => tab.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { fits: bounds.left >= 0 && bounds.right <= innerWidth + 1, left: bounds.left, right: bounds.right, viewport: innerWidth };
      }), { message: `${name} must be reachable in the settled viewport after resizing to ${width}` }).toMatchObject({ fits: true });
    }
    await page.screenshot({ path: `${artifacts}/font-scale-${size}.png` });
  }
  console.log('PASS font scales 9/14/22 at narrow/default/wide bounds retain a visible composer');

  // Focusing overflow tabs can scroll the tab strip; explicitly select the
  // fixture's destination before asserting message rows in the hidden view.
  await page.getByRole('button', { name: 'General channel', exact: true }).click();
  await expect(page).toHaveTitle(/General/);

  // Simulated active game keeps the real transport gate open while hidden. No
  // game process or game input is involved. Exercise the native visibility IPC.
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.send('overlay:game-state', true);
    ipcMain.emit('window:hide');
  });
  await expect.poll(() => page.locator('.fcm-name-fx--shimmer:not([data-fcm-motion-paused])').count(),
    { timeout: 30_000 }).toBe(0);
  const hiddenConnections = connectionCount;
  for (let index = 0; index < 100; index++) {
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:message', payload: {
      id: `perf-hidden-${index}`, channelId: 'general', userId: 'bob', username: 'Bob',
      content: `Hidden fixture ${index}`, source: 'game', createdAt: new Date().toISOString(), effectId: 'shimmer',
    } }));
  }
  await expect.poll(() => page.locator('[data-msg-id^="perf-hidden-"]').count()).toBe(100);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.webContents.send('overlay:visibility', true);
  });
  await expect.poll(() => page.locator('.fcm-name-fx--shimmer:not([data-fcm-motion-paused])').count()).toBeGreaterThan(0);
  assert.equal(connectionCount, hiddenConnections, 'hiding during active game must not reconnect');
  assert.equal(await page.locator('[data-msg-id^="perf-hidden-"]').evaluateAll(rows => new Set(rows.map(row => row.getAttribute('data-msg-id'))).size), 100);
  console.log('PASS 100 hidden messages survive show without duplicates or a visibility reconnect');

  // Use relay-driven typing, not a mocked scheduler: the label/dots remain visible,
  // but the desktop overlay must not advance their CSS animation while in-game.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:typing', payload: {
      userId: 'bob', username: 'Bob', channelId: 'general',
    } }));
    const dot = page.locator('[data-fcm-status-motion="fcm-typing-dot"]').first();
    await expect(dot).toBeVisible();
    assert.equal(await dot.evaluate(el => el.getAnimations()[0].playState), 'paused');
    const paint = await dot.evaluate(el => getComputedStyle(el).opacity);
    await page.waitForTimeout(220);
    assert.equal(await dot.evaluate(el => getComputedStyle(el).opacity), paint);
    assert.equal(await dot.evaluate(el => el.getAnimations()[0].currentTime), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => dot.evaluate(el => el.getAnimations()[0].currentTime)).toBe(0);
    const frozenTime = await dot.evaluate(el => el.getAnimations()[0].currentTime);
    await page.waitForTimeout(220);
    assert.equal(await dot.evaluate(el => el.getAnimations()[0].currentTime), frozenTime);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => dot.evaluate(el => el.getAnimations()[0].currentTime)).toBe(0);
  }
  console.log('PASS relay typing remains visible and static without a recurring paint cadence');

  // User-visible unread dots are live-only, close to the corresponding label,
  // clear on click, and keep the theme color with reduced-motion support.
  const channelTab = name => page.locator('[data-fcm-subtab-row="channels"]').getByRole('button', { name: `${name} channel`, exact: true });
  await channelTab('Trading').click();
  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:message', payload: {
    id: 'unread-ui-1', channelId: 'events', userId: 'bob', username: 'Bob', content: 'Unread UI fixture', source: 'game', createdAt: new Date().toISOString(),
  } }));
  const unreadDot = page.getByRole('img', { name: 'Unread messages in Events' });
  await expect(unreadDot).toBeVisible();
  await expect(unreadDot).toHaveCSS('margin-right', '3px');
  await expect(unreadDot).toHaveCSS('animation-name', 'fcm-unread-pulse');
  await expect(unreadDot).toHaveAttribute('data-fcm-status-motion', 'fcm-unread-pulse');
  assert.equal(await unreadDot.evaluate(el => el.getAnimations()[0].playState), 'paused');
  assert.equal(await unreadDot.evaluate(el => el.getAnimations()[0].currentTime), 0);
  const unreadOpacity = await unreadDot.evaluate(el => getComputedStyle(el).opacity);
  await page.waitForTimeout(220);
  assert.equal(await unreadDot.evaluate(el => getComputedStyle(el).opacity), unreadOpacity);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(unreadDot).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: `${artifacts}/unread-dot.png` });
  await channelTab('Events').click();
  await expect(unreadDot).toHaveCount(0);
  await channelTab('General').click();
  const emitUnread = (id, channelId) => {
    for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:message', payload: {
      id, channelId, userId: 'bob', username: 'Bob', content: id, source: 'game', createdAt: new Date().toISOString(),
    } }));
  };
  emitUnread('unread-general-selected', 'general');
  emitUnread('unread-general-other', 'events');
  await expect(page.getByRole('img', { name: 'Unread messages in General' })).toHaveCount(0);
  await expect(unreadDot).toBeVisible();
  await command('channel:next');
  await command('channel:next');
  await expect(unreadDot).toHaveCount(0);
  emitUnread('unread-events-selected', 'events');
  await expect(page.getByText('unread-events-selected', { exact: true })).toBeVisible();
  await expect(unreadDot).toHaveCount(0);
  await channelTab('General').click();
  emitUnread('unread-before-disable', 'events');
  await expect(unreadDot).toBeVisible();
  await command('settings:open');
  await page.locator('.ss-navbtn').filter({ hasText: /appearance/i }).click();
  const dotToggle = page.locator('.ss-toggle').filter({ hasText: 'Show unread channel dots' });
  await dotToggle.click();
  await expect.poll(async () => JSON.parse(await readFile(`${profile}/overlay-state.json`, 'utf8')).settings.showUnreadDots).toBe(false);
  emitUnread('unread-disabled', 'events');
  await expect(unreadDot).toHaveCount(0);
  await dotToggle.click();
  await page.keyboard.press('Escape');
  await expect(unreadDot).toHaveCount(0);
  emitUnread('unread-reenabled', 'events');
  await expect(unreadDot).toBeVisible();
  await channelTab('Events').click();
  await expect(unreadDot).toHaveCount(0);
  await channelTab('General').click();
  console.log('PASS selected channel exemption, keyboard clearing, and saved Appearance unread toggle');

  // Privileged stream remains a view over canonical room/message IDs.
  const ownRoom = 'server:r:own-fixture';
  // Supply an already-confirmed state at the renderer boundary. This suite has
  // no installed game export; native local-bridge authority is separately tested
  // and must continue rejecting uncorrelated ready frames from the fixture relay.
  await page.evaluate(() => { window.fixtureSocketUnsubscribe = window.relayBridge.onWsMessage(m => { window.fixtureSocketId = m.id; }); });
  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'fixture:identify-socket', payload: {} }));
  await expect.poll(() => page.evaluate(() => window.fixtureSocketId)).toBeTruthy();
  const fixtureSocketId = await page.evaluate(() => window.fixtureSocketId);
  await app.evaluate(({ BrowserWindow }, { id, channelId }) => BrowserWindow.getAllWindows()[0].webContents.send('proxy:ws:message', {
    id, data: JSON.stringify({ type: 'bridge:state', payload: { status: 'ready', channelId, bindingId: 'fixture/r:own-fixture' } }),
  }), { id: fixtureSocketId, channelId: ownRoom });
  await page.evaluate(() => window.fixtureSocketUnsubscribe?.());
  for (const socket of relay.clients) {
    socket.send(JSON.stringify({ type: 'server:moderation:messages', payload: { historyReplay: false, messages: [
      { id: `${ownRoom}:1`, channelId: ownRoom, serverDisplayId: '101', username: 'Bob', userId: 'bob', content: 'Own room moderation fixture', source: 'server', timestamp: new Date().toISOString() },
      { id: 'server:r:other-fixture:1', channelId: 'server:r:other-fixture', serverDisplayId: '102', username: 'Bob', userId: 'bob', content: 'Other room moderation fixture', source: 'server', timestamp: new Date().toISOString() },
    ] } }));
  }
  await expect(page.getByText('[Your server]', { exact: true })).toBeVisible();
  await expect(page.getByText('[Server · 102]', { exact: true })).toBeVisible();
  await expect(channelTab('Server')).toBeVisible();
  await expect(channelTab('Your server')).toHaveCount(0);
  await page.getByText('[Server · 102]', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute this server', exact: true }).click();
  await expect(page.getByText('Other room moderation fixture', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-subtab-settings')));
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Other room moderation fixture', { exact: true })).toBeVisible();
  await page.getByText('[Server · 102]', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute this server', exact: true }).click();
  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'server:moderation:expired', payload: { channelIds: ['server:r:other-fixture'] } }));
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-subtab-settings')));
  await expect(page.getByText('Muted Server rooms', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => {
    const values = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('fcm-server-mutes:')).map(key => JSON.parse(localStorage.getItem(key))));
    return values.some(value => value.ids.includes('server:r:other-fixture'));
  }).toBe(false);
  console.log('PASS backend-confirmed room expiry removes persisted Unmute entry');
  await page.screenshot({ path: `${artifacts}/server-moderation.png` });
  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'server:moderation:state', payload: { status: 'denied' } }));
  await expect(page.getByText('Other room moderation fixture', { exact: true })).toHaveCount(0);
  console.log('PASS live unread pulse/click/reduced-motion and moderator labels/mute/unmute/revocation');

  await command('settings:open');
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.locator('.ss-navbtn').filter({ hasText: /appearance/i }).click();
    await page.getByRole('spinbutton', { name: 'Overlay width in pixels' }).fill(String(640 + cycle * 20));
    await page.getByRole('spinbutton', { name: 'Overlay height in pixels' }).fill(String(480 + cycle * 20));
    await page.getByRole('button', { name: 'Apply size', exact: true }).click();
    // The previous cycle's "Applied" status remains until native IPC completes.
    // Wait for this request's dimensions, not the previous successful response.
    await expect.poll(async () => {
      const width = Number(await page.getByRole('spinbutton', { name: 'Overlay width in pixels' }).inputValue());
      const height = Number(await page.getByRole('spinbutton', { name: 'Overlay height in pixels' }).inputValue());
      const status = await page.locator('[data-fcm-size-status]').textContent();
      return Math.abs(width - (640 + cycle * 20)) <= 2 && Math.abs(height - (480 + cycle * 20)) <= 2
        && status === `Applied ${width}×${height}`;
    }).toBe(true);
    const actualWidth = Number(await page.getByRole('spinbutton', { name: 'Overlay width in pixels' }).inputValue());
    const actualHeight = Number(await page.getByRole('spinbutton', { name: 'Overlay height in pixels' }).inputValue());
    assert.ok(Math.abs(actualWidth - (640 + cycle * 20)) <= 2 && Math.abs(actualHeight - (480 + cycle * 20)) <= 2, `only desktop pixel rounding may alter these in-range dimensions: cycle=${cycle} actual=${actualWidth}x${actualHeight}`);
    await expect(page.locator('[data-fcm-size-status]')).toHaveText(`Applied ${actualWidth}×${actualHeight}`);
    await page.locator('.ss-navbtn').filter({ hasText: /keybinds/i }).click();
    await page.getByRole('button', { name: 'SET POS', exact: true }).first().click();
    await expect.poll(async () => JSON.parse(await readFile(`${profile}/overlay-state.json`, 'utf8')).settings.presets[0].w).toBe(actualWidth);
    const saved = JSON.parse(await readFile(`${profile}/overlay-state.json`, 'utf8')).settings.presets[0];
    assert.equal(saved.h, actualHeight);
    await applyPreset(800, 600);
    await page.evaluate(p => window.relayBridge.setBounds({ x: p.x, y: p.y, width: p.w, height: p.h }), saved);
    await expect.poll(async () => Math.abs(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width) - saved.w)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().height) - saved.h)).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press('Escape');
  console.log('PASS pixel Apply -> SET POS persistence -> restore repeated three times');

  // Exercise the real message renderer and picker, without posting to Discord.
  const emojiRequests = [];
  await page.route(/https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\//, async route => {
    const url = route.request().url();
    emojiRequests.push(url);
    if (url.includes('1509625415726006313') ||
        (url.includes('1509631843207614626') && new URL(url).hostname === 'cdn.discordapp.com')) {
      await route.abort();
    } else {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="gold"/></svg>' });
    }
  });
  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:message', payload: {
    id: 'emoji-ui-fixture', channelId: 'general', userId: 'bob', username: 'Bob',
    content: '<a:Confused:1509625415726006313> <:Birthdaycake:1509631843207614626> <:falloutlondon:1549283103372222514>',
    source: 'discord', createdAt: new Date().toISOString(),
  } }));
  const emojiRow = page.locator('[data-msg-id="emoji-ui-fixture"]');
  await expect(emojiRow.getByText(':Confused:', { exact: true })).toBeVisible();
  await expect(emojiRow.getByAltText(':Birthdaycake:')).toHaveAttribute('src', 'https://media.discordapp.net/emojis/1509631843207614626.png');
  await expect.poll(() => emojiRow.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  assert.ok(emojiRequests.some(url => url.includes('media.discordapp.net/emojis/1509625415726006313.webp?animated=true')));
  assert.ok(!(await emojiRow.innerText()).includes('<:'), 'custom tokens must not leak as raw markup');
  await composer().fill('Emoji draft ');
  await page.getByTitle('Emoji picker', { exact: true }).click();
  const search = page.getByPlaceholder('Search emoji…');
  await expect(search).toBeVisible();
  await page.screenshot({ path: `${artifacts}/emoji-picker.png` });
  await search.fill('grinning');
  const cell = page.locator('.fcm-ep-cell[title=":grinning:"]').first();
  await expect(cell).toBeVisible();
  assert.ok((await cell.locator('span').evaluate(el => getComputedStyle(el).fontFamily)).includes('Noto Color Emoji'));
  await cell.click();
  await expect(composer()).toContainText('😀');
  await expect(composer()).toContainText('Emoji draft');
  if (await search.isVisible()) await page.getByTitle('Emoji picker', { exact: true }).click();
  await composer().press('Enter');
  await expect(page.getByText('Emoji draft 😀', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${artifacts}/emoji-message.png` });
  console.log('PASS custom emoji image/retry/label paths, native picker font, insertion and send');

  moderationHistoryFixture = true;
  for (const socket of relay.clients) {
    socket.send(JSON.stringify({ type: 'server:moderation:state', payload: { status: 'ready' } }));
    socket.send(JSON.stringify(moderationPage()));
  }
  await channelTab('General').click();
  await expect(page.getByText('Automatic first Server room', { exact: true })).toBeVisible();
  await expect(page.getByText('Automatic second Server room', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Next Server rooms|Refresh Server history/ })).toHaveCount(0);
  assert.equal(moderationHistoryRequests, 1);
  const subscriptionsBeforeRefresh = moderationSubscriptions;
  await page.getByRole('button', { name: 'Overlay actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => moderationSubscriptions).toBeGreaterThan(subscriptionsBeforeRefresh);
  await expect(page.getByText('Automatic first Server room', { exact: true })).toBeVisible();
  await expect(page.getByText('Automatic second Server room', { exact: true })).toBeVisible({ timeout: 10000 });
  console.log('PASS automatic multi-room General history and normal dropdown Refresh');

  await composer().fill('opacity regression draft');
  const opacityCheck = await page.evaluate(async () => {
    const root = document.documentElement;
    const original = window.getComputedStyle;
    let opacityReads = 0;
    window.getComputedStyle = function (...args) {
      const style = original.apply(this, args);
      if (args[0] !== root) return style;
      return new Proxy(style, { get(target, key) {
        if (key === 'getPropertyValue') return name => {
          if (name === '--fcm-chrome-bg-alpha' || name === '--fcm-text-opacity') opacityReads++;
          return target.getPropertyValue(name);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    try {
      for (let i = 0; i < 100; i++) {
        root.style.setProperty('--fcm-performance-fixture', String(i));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { opacityReads };
    } finally {
      window.getComputedStyle = original;
      root.style.removeProperty('--fcm-performance-fixture');
    }
  });
  assert.equal(opacityCheck.opacityReads, 0);
  await expect(composer()).toHaveText('opacity regression draft');
  await expect(page.getByText('Automatic first Server room', { exact: true })).toBeVisible();
  console.log('PASS 100 unrelated shell style changes avoid computed opacity reads and retain draft/history');

  for (const socket of relay.clients) socket.send(JSON.stringify({ type: 'chat:history', payload: {
    messages: Array.from({ length: 1500 }, (_, index) => ({
      id: `window-fixture-${index}`, channel_id: 'general', user_id: 'bob', username: 'Bob',
      content: `Window fixture ${index}`, source: 'game',
      created_at: new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString(),
    })),
  } }));
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-scroll-bottom')));
  await expect(page.getByText('Window fixture 1499', { exact: true })).toBeVisible();
  await expect(page.locator('[data-fcm-message-line]')).toHaveCount(100);
  await expect(page.getByText('Window fixture 1399', { exact: true })).toHaveCount(0);
  const anchorBefore = await page.evaluate(async () => {
    const first = document.querySelector('[data-fcm-message-line]').closest('[data-msg-id]');
    const list = first.closest('.fcm-scrollbar');
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    // Let the intent observer cancel any pending bottom-pin work before the
    // synthetic scroll. On loaded CI runners, doing both in one task can race
    // the render-window effect rebind and leave the feed at its 100-row tail.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    list.scrollTop = 0;
    const anchor = { id: first.getAttribute('data-msg-id'), top: first.getBoundingClientRect().top };
    list.dispatchEvent(new Event('scroll'));
    // A second frame-bound event mirrors the browser's coalesced native scroll
    // delivery and makes this acceptance gesture deterministic under Xvfb.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    list.dispatchEvent(new Event('scroll'));
    return anchor;
  });
  await expect(page.locator('[data-fcm-message-line]')).toHaveCount(200);
  await expect.poll(() => page.evaluate(anchor => {
    const row = [...document.querySelectorAll('[data-msg-id]')].find(row => row.getAttribute('data-msg-id') === anchor.id);
    return row ? Math.abs(row.getBoundingClientRect().top - anchor.top) : Infinity;
  }, anchorBefore)).toBeLessThan(3);
  await expect(composer()).toHaveText('opacity regression draft');
  await page.evaluate(() => window.dispatchEvent(new Event('fcm-scroll-bottom')));
  await expect(page.locator('[data-fcm-message-line]')).toHaveCount(100);
  await expect(page.getByText('Window fixture 1499', { exact: true })).toBeVisible();
  console.log('PASS 1500 cached messages render 100, reveal 100 older rows with stable anchor, and reset at latest');

  // The real account boundary still discards the old component and its draft.
  await composer().fill('private draft from Alice');
  await page.evaluate(() => { window.usabilityComposer = document.querySelector('[contenteditable="true"]'); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('relay:status', {
    state: 'authenticated', userId: 'bob', displayName: 'Bob', role: 'user',
  }));
  await expect(composer()).toHaveText('');
  assert.equal(await page.evaluate(() => window.usabilityComposer === document.querySelector('[contenteditable="true"]')), false);
  console.log('PASS account switch discards the previous composer and private draft');
  assert.deepEqual(errors, [], 'renderer exceptions');
  await writeFile(`${artifacts}/result.json`, JSON.stringify({
    status: 'passed', completedAt: new Date().toISOString(), disconnects: 10,
    fontScales: [9, 14, 22], widths: [320, 520, 800], rendererErrors: errors,
    checks: ['discrete-glitch-motion', 'unread-dots', 'server-moderation-muting', 'pixel-size-presets', 'emoji-image-fallback-picker-insert-send', 'saved-size-bottom-follow', 'send-then-shrink', 'compositor-collapse-and-full-fade',
      'interrupted-hide-and-reveal', 'live-font-and-theme', 'one-step-navigation', 'same-account-update',
      'reading-anchor', 'native-preference-restart', 'composer-layout', 'account-switch-reset'],
  }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  const log = await readFile(`${profile}/logs/main.log`, 'utf8').catch(() => '');
  await writeFile(`${artifacts}/main.log`, log);
  console.error(errors);
  throw error;
} finally {
  if (app) await app.close();
  for (const socket of relay.clients) socket.terminate();
  await new Promise(resolve => relay.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(testRoot, { recursive: true, force: true });
  console.log('Teardown: owned Electron, local relay and temporary profile removed');
}
