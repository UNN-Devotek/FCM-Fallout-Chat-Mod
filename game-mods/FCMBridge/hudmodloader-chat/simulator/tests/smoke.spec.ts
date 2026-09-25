import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { HOSTED_HISTORY_PER_CHANNEL, mapHistory } from '../scripts/sync-hosted-dev.mjs';
import { normalizeHudChannel, validateHostedSend } from '../scripts/hosted-dev-bridge.mjs';
import { applyKeybindsToIni, browserKey, defaultKeybinds, normalizeKeybinds } from '../src/keybinds';

for (const provider of ['xscal', 'zfe']) {
  test(`giveaway command and announcement reach HUD Events (${provider})`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=giveaway`);
    await expect(page.locator('#log')).toContainText(/GIVEAWAY (PASS|FAIL)/, { timeout: 25_000 });
    await expect(page.locator('#log')).toContainText(`GIVEAWAY PASS ${provider}`);
    await expect(page.locator('#log')).not.toContainText('GIVEAWAY FAIL');
  });

  test(`sticky manual hide and inspection visibility (${provider})`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=visibility`);
    await expect(page.locator('#log')).toContainText(/VISIBILITY (PASS|FAIL)/, { timeout: 25_000 });
    await expect(page.locator('#log')).toContainText(`VISIBILITY PASS ${provider}`);
    await expect(page.locator('#log')).not.toContainText('VISIBILITY FAIL');
  });

  test(`quoted self-echo remains one decoded row (${provider})`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=quoted-echo`);
    await expect(page.locator('#log')).toContainText(/QUOTED-ECHO (PASS|FAIL)/, { timeout: 25_000 });
    await expect(page.locator('#log')).toContainText(`QUOTED-ECHO PASS ${provider}`);
    await expect(page.locator('#log')).not.toContainText('QUOTED-ECHO FAIL');
  });
}

for (const scenario of ['owned-input-release', 'owned-input-busy', 'owned-input-expiry', 'owned-input-hotkey', 'owned-input-controller-open', 'owned-input-map']) {
  test(`ZFE ${scenario} owns or falls back and cleans up deterministically`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=zfe&scenario=${scenario}`);
    await expect(page.locator('#log')).toContainText(/OWNED-INPUT (PASS|FAIL)/, { timeout: 20_000 });
    await expect(page.locator('#log')).toContainText(`OWNED-INPUT PASS ${scenario} session=bounded release=stable fallback=shared cleanup=ended`);
    await expect(page.locator('#log')).not.toContainText('OWNED-INPUT FAIL');
  });
}

for (const scenario of ['xscal-session-input', 'xscal-session-fallback']) {
  test(`xScal session lifecycle and compatibility: ${scenario}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=xscal&scenario=${scenario}`);
    await expect(page.locator('#log')).toContainText(/XSCAL-SESSION-INPUT (PASS|FAIL)/, { timeout: 20_000 });
    await expect(page.locator('#log')).toContainText(`XSCAL-SESSION-INPUT PASS ${scenario}`);
    await expect(page.locator('#log')).not.toContainText('XSCAL-SESSION-INPUT FAIL');
  });
}

test.afterEach(async ({ page, request }) => {
  await page.evaluate(() => (window as Window & { __FCM_SIM_TEARDOWN__?: () => void }).__FCM_SIM_TEARDOWN__?.()).catch(() => undefined);
  await expect(page.locator('#ruffle-player')).toHaveCount(0);
  await request.post('/__fcm/keybinds/reset', { data: {} });
});

test('loads the exact production widget artifact and records browser key delivery', async ({ page }) => {
  await page.goto('/?mode=artifact');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(page.locator('#widget-version')).toHaveText('2.10.126');
  await page.locator('#focus-stage').click();
  await page.keyboard.press('Insert');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#log')).toContainText('KEYDOWN  Insert');
  await expect(page.locator('#log')).toContainText('KEYDOWN  ArrowUp');
  await expect(page.locator('#long-tasks')).toHaveText(/^\d+$/);
  await page.screenshot({ path: 'test-results/hud-simulator.png', fullPage: true });
});

test('replays the observed Nexus xScal 0.2.16 chat and input contract', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const result = await page.evaluate(() => {
    const host = window.__INSTALLED_XSCAL__!;
    const insert = host.fixture.keys.insert;
    return {
      evidence: host.fixture.evidence,
      methods: host.fixture.chatMethods,
      runtime: host.getRuntimeInfo(),
      beforeConnect: host.pollEvents(),
      connected: host.connect(),
      firstPoll: host.pollEvents(),
      secondPoll: host.pollEvents(),
      sent: host.sendMessage({ channel: 'global', body: 'automated HUD message' }),
      input: host.call('Input.ClearKeys')
        && host.call('Input.RegisterKey', insert)
        && host.setPressed(insert, true)
        && host.call('Input.IsKeyPressed', insert)
        && host.call('Input.UnregisterKey', insert),
    };
  });
  expect(result.evidence).toMatchObject({ version: '0.2.16', sha256: '185de187aa616ae5db118f463aa43ff760f7819df77ca4a09f6b71714195fd5a', sizeBytes: 315904, falloutRuntime: '1.7.26.10' });
  expect(result.methods).toEqual(expect.arrayContaining(['connect', 'pollEvents', 'sendMessage', 'reportMessage']));
  expect(result.runtime).toMatchObject({ success: true, runtime: 'xScal Chat', version: '0.2.16' });
  expect(result.beforeConnect.success).toBe(false);
  expect(result.connected).toBe(true);
  expect(result.firstPoll.events).toHaveLength(3);
  expect(result.firstPoll.events[0].body).toContain('https://example.com/path');
  expect(result.firstPoll.events[1].body).toContain('discord.com/events/');
  expect(result.firstPoll.events[2]).toMatchObject({ targetUserId: 'discord:111222333' });
  expect(result.secondPoll.events).toHaveLength(0);
  expect(result.sent.success).toBe(true);
  expect(result.input).toBe(true);
});

test('keeps simulator diagnostics off the rendered HUD stage', async () => {
  const source = await readFile(new URL('../haxe/MockXscal.hx', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\btrace\s*\(/);
  expect(source).toContain('last = clean');
});

test('disables inactivity auto-hide only in the generated simulator config', async () => {
  const simulatorConfig = await readFile(new URL('../public/FCMChat.ini', import.meta.url), 'utf8');
  const productionConfig = await readFile(new URL('../../FCMChat.ini', import.meta.url), 'utf8');
  expect(simulatorConfig).toContain('autoHideEnabled=false');
  expect(productionConfig).toContain('autoHideEnabled=true');
  expect(simulatorConfig).toContain('ExamineConfirmMode');
  expect(productionConfig).toContain('ExamineConfirmMode');
});

test('validates profiles and writes every simulator INI key without changing production defaults', () => {
  const profile = normalizeKeybinds({ ...defaultKeybinds, openKey: 'f9', scrollBottomKey: 'home' });
  expect(profile).toMatchObject({ openKey: 'F9', scrollBottomKey: 'HOME' });
  expect(browserKey('F8')).toEqual({ code: 'F8', key: 'F8', keyCode: 119 });
  expect(() => normalizeKeybinds({ ...defaultKeybinds, openKey: 'F8', hideKey: 'F8' })).toThrow(/different key/);
  const ini = applyKeybindsToIni('openKey=INSERT\nchannelNextKey=NextPage\nchannelPrevKey=PrevPage\nscrollUpKey=Up\nscrollDownKey=Down\nscrollBottomKey=\nactivateLinkKey=F8\nhideKey=DELETE\n', profile);
  expect(ini).toContain('openKey=F9');
  expect(ini).toContain('scrollBottomKey=HOME');
  expect(ini).toContain('activateLinkKey=F8');
});

test('packages provider-neutral key routing and xScal self-echo', async () => {
  const harnessSource = await readFile(new URL('../haxe/FCMHarness.hx', import.meta.url), 'utf8');
  const mockSource = await readFile(new URL('../haxe/MockXscal.hx', import.meta.url), 'utf8');
  expect(harnessSource).toContain('stage.addEventListener(KeyboardEvent.KEY_DOWN');
  expect(harnessSource).toContain('stage.dispatchEvent(new SimUserEvent(action, down))');
  expect(harnessSource).toContain('MockXscal.setVirtualKey(keyCode, down)');
  expect(mockSource).toContain('scenarioEvents.push({kind:"chat.message"');
  expect(mockSource).toContain('senderUserId:"sim-linked-user"');
  expect(mockSource).toContain('ExternalInterface.call("fcmHostedDevSend", channel, body)');
});

test('packages independent tab ranges, file-key precedence, ZFE synchronization, and HUD-mode guards', async () => {
  const widgetSource = await readFile(new URL('../../FCMChatWidget.hx', import.meta.url), 'utf8');
  const configSource = await readFile(new URL('../../FcmConfig.hx', import.meta.url), 'utf8');
  expect(widgetSource).toContain('_subTf.setTextFormat(format, range.start, range.end)');
  expect(widgetSource).toContain('FcmConfig.mergePersistedCustomization(_cfg, stored)');
  expect(widgetSource).toContain('callTop("updateChatHotkey", _cfg.openKey)');
  expect(widgetSource).toMatch(/function openInput\(\):Void[\s\S]*?if \(!isValidHUDMode\(\)\) return;/);
  expect(widgetSource).toMatch(/function pollOpenKey\(\):Void[\s\S]*?if \(!isValidHUDMode\(\)\)/);
  expect(widgetSource).toContain('FcmCommand.linkActivationEnabled(action, _cfg.activateLinkKey');
  expect(widgetSource).toContain('activateSelectedLinkFromOpenInput()');
  expect(widgetSource).not.toContain('_feedContentLayer.removeChild(kept.view)');
  expect(widgetSource).toContain('layer.addChildAt(rows[i].view, i)');
  expect(widgetSource).toContain('_renderedVisualContext != feedVisualContext()');
  expect(widgetSource).toContain('removeEventListener(TimerEvent.TIMER_COMPLETE, _sliceTimerHandler)');
  expect(configSource).toContain('stored.openKey = environment.openKey');
  expect(configSource).toContain('stored.activateLinkKey = environment.activateLinkKey');
});

for (const provider of ['xscal', 'zfe']) {
  test(`slots late Server history chronologically through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=server-history-chronology`);
    await expect(page.locator('#log')).toContainText(/SERVER-HISTORY-CHRONOLOGY (PASS|FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`SERVER-HISTORY-CHRONOLOGY PASS ${provider} general=overlap-slotted,old-hidden server=complete,chronological`);
    expect(log).not.toContain('SERVER-HISTORY-CHRONOLOGY FAIL');
  });

  test(`backfills retained own-message cosmetics through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=cosmetics-history`);
    await expect(page.locator('#log')).toContainText(/COSMETICS-HISTORY (PASS|FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`COSMETICS-HISTORY PASS ${provider} own=backfilled foreign=unchanged identity=id-only`);
    expect(log).not.toContain('COSMETICS-HISTORY FAIL');
  });

  test(`acknowledges contiguous ${provider} retention without weakening gap recovery`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=queue-loss`);
    await expect(page.locator('#log')).toContainText(/QUEUE-(RETENTION PASS|DIAGNOSTIC FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`QUEUE-RETENTION PASS ${provider} contiguous=acknowledged gap=recovered private=omitted`);
    expect(log).not.toContain('QUEUE-DIAGNOSTIC FAIL');
  });

  test(`automatically binds Server after delayed ${provider} authentication`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=delayed-auth`);
    await expect(page.locator('#log')).toContainText(/DELAYED-AUTH (PASS|FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`DELAYED-AUTH PENDING ${provider} history=received roster=read controls=blocked`);
    expect(log).toContain(`DELAYED-AUTH PASS ${provider} automatic=auth,roster,tab reconnects=0 user-sends=0`);
    expect(log).toContain(`SERVER-LABEL PASS ${provider} regular=Server staff=Your-server revoked=Server`);
    expect(log).not.toContain('DELAYED-AUTH FAIL');
  });

  test(`preserves background bridge membership through ${provider} fast travel`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=bridge-fast-travel`);
    await expect(page.locator('#log')).toContainText(`HARNESS bridge constructed provider=${provider}`);
    await expect(page.locator('#log')).toContainText(/BRIDGE-ROSTER (PASS|FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`BRIDGE-ROSTER PASS ${provider}`);
    expect(log).not.toContain('BRIDGE-ROSTER FAIL');
    expect(log).toContain('BRIDGE-EVENTS PASS fresh-push=preferred retry=deferred test-provider=rejected');
    expect(log).toContain('BRIDGE-DIAGNOSTICS PASS export-only labels=private-data-free menu=absent');
    expect(log).toContain('BRIDGE-ERRORS PASS getter=E1014 nested-names=rejected subscribe=E1006');
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(log).toContain(`BRIDGE-CYCLE PASS ${cycle} source=PublicTeamsData nonce=preserved controls=unchanged`);
    }
  });

  test(`preserves same-server fast-travel history through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=fast-travel`);
    await expect(page.locator('#log')).toContainText(`HARNESS widget constructed provider=${provider} scenario=fast-travel`);
    await expect(page.locator('#log')).toContainText(/ROSTER-SCENARIO (PASS|FAIL)/, { timeout: 25_000 });
    const log = await page.locator('#log').textContent();
    expect(log).toContain(`ROSTER-SCENARIO PASS ${provider}`);
    expect(log).toContain('RETAINED-HISTORY PASS authorized=once stale=rejected unmarked=rejected id=preserved');
    expect(log).toContain('RESTORED-READER PASS sources=6 cached-pull=stale fresh-push=accepted damaged=rejected');
    expect(log).not.toContain('ROSTER-SCENARIO FAIL');
    expect(log).toContain('ROSTER-DIAGNOSTICS PASS probes=local-only repeated-error=throttled evidence=unchanged');
    expect(log).toContain('ROSTER-PROBES PASS count=7 error=numeric-only phases=fixed private-error=omitted');
    expect(log).not.toContain('PRIVATE-ROSTER-ERROR');
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(log).toContain(`ROSTER-CYCLE PASS ${cycle} source=PublicTeamsData history=preserved controls=unchanged`);
    }
  });

  test(`boots and accepts compose controls through the ${provider} provider contract`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}`);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.locator('#provider-mode')).toHaveText(provider);
    await page.getByRole('button', { name: 'Open chat', exact: true }).click();
    await page.keyboard.type(`${provider} contract message`);
    await page.keyboard.press('Enter');
    await expect(page.locator('#log')).toContainText('KEYDOWN    Enter');
  });
}

for (const provider of ['xscal', 'zfe']) {
  test(`delivers T, Insert, and container-mode controls through ${provider}`, async ({ page, request }) => {
    const response = await request.post('/__fcm/keybinds', { data: { ...defaultKeybinds, openKey: 'T' } });
    expect(response.ok()).toBe(true);
    await page.goto(`/?mode=harness&provider=${provider}`);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.locator('#log')).toContainText(/gameFonts=(loaded|fallback)/);

    await page.locator('#ruffle-player').focus();
    await page.getByRole('button', { name: 'Clear log' }).click();
    await page.keyboard.press('Insert');
    await page.keyboard.press('t');
    await page.keyboard.press('F9');
    await page.keyboard.press('t');
    await page.keyboard.press('F10');
    await page.keyboard.press('t');
    for (const code of ['Insert', 'KeyT', 'F9', 'F10']) {
      await expect(page.locator('#log')).toContainText(`KEYDOWN    ${code}`);
      await expect(page.locator('#log')).toContainText(`KEYUP      ${code}`);
    }
  });
}

for (const provider of ['xscal', 'zfe']) {
  test(`profiles and routes an editor-gated F7 link action through ${provider}`, async ({ page, request }) => {
    const response = await request.post('/__fcm/keybinds', {
      data: { ...defaultKeybinds, activateLinkKey: 'F7' },
    });
    expect(response.ok()).toBe(true);
    await page.goto(`/?mode=harness&provider=${provider}`);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.locator('#bind-activateLinkKey')).toHaveValue('F7');
    await page.getByRole('button', { name: 'Open selected link', exact: true }).click();
    await expect(page.locator('#log')).toContainText(`activateLinkKey=F7 provider=${provider}`);
    await expect(page.locator('#log')).toContainText('KEYDOWN    F7');
    await expect(page.locator('#log')).toContainText('KEYUP      F7');
  });
}

test('keeps xScal object calls and ZFE JSON dispatch as separate contracts', async () => {
  const zfeSource = await readFile(new URL('../haxe/MockZfe.hx', import.meta.url), 'utf8');
  const widgetSource = await readFile(new URL('../../FCMChatWidget.hx', import.meta.url), 'utf8');
  const wireSource = await readFile(new URL('../../FcmWire.hx', import.meta.url), 'utf8');
  expect(zfeSource).toContain('Reflect.setField(out, "call"');
  expect(zfeSource).toContain('haxe.Json.parse(Std.string(payload))');
  expect(zfeSource).toContain('zfe-chat-online-v1');
  expect(zfeSource).toContain('zfe-chat-async-send-v1');
  expect(zfeSource).toContain('zfe-chat-async-control-v1');
  expect(zfeSource).toContain('version:"0.15.0"');
  expect(zfeSource).toContain('verb == "consumeChatInputSubmitted"');
  expect(zfeSource).toContain('handleKey(keyCode:Int, charCode:Int, down:Bool)');
  expect(widgetSource).toContain('FONT_BODY:String = "$MAIN_Font"');
  expect(widgetSource).not.toContain('FONT_BODY:String = "$MAIN_Font_Light"');
  expect(wireSource).toContain('FcmJson.parse(raw)');
  expect(wireSource).not.toContain('haxe.Json');
});

test('packages capability-gated Server-room controls for ZFE and xScal', async () => {
  const [widgetSource, apiSource, zfeSource, xscalSource] = await Promise.all([
    readFile(new URL('../../FCMChatWidget.hx', import.meta.url), 'utf8'),
    readFile(new URL('../../../FcmNativeApi.hx', import.meta.url), 'utf8'),
    readFile(new URL('../haxe/MockZfe.hx', import.meta.url), 'utf8'),
    readFile(new URL('../haxe/MockXscal.hx', import.meta.url), 'utf8'),
  ]);
  expect(apiSource).toContain('supportsNonBlockingControl');
  expect(apiSource).toContain('zfe-chat-async-control-v1');
  expect(widgetSource).toContain('if (!_api.supportsNonBlockingControl()) return;');
  expect(widgetSource).not.toContain('if (_api.provider == FcmNativeApi.ZFE) return;');
  expect(zfeSource).toContain('zfe-chat-async-control-v1');
  expect(zfeSource).toContain('status:"queued", requestId:requestId');
  expect(widgetSource).toContain('FcmWire.asyncSendCompletion(obj)');
  expect(widgetSource).toContain('_zfePendingSends.set(queuedRequestId, localSendId)');
  expect(xscalSource).toContain('FCMCTL/1/SERVER-READY:');
});

test('fits the complete HUD stage inside its responsive viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=harness');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const fit = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.stage-shell')!;
    const player = document.querySelector<HTMLElement>('#ruffle-player')!;
    const shellBox = shell.getBoundingClientRect();
    const playerBox = player.getBoundingClientRect();
    return {
      shellOverflow: shell.scrollWidth - shell.clientWidth,
      leftDelta: playerBox.left - shellBox.left,
      rightDelta: shellBox.right - playerBox.right,
    };
  });
  expect(fit.shellOverflow).toBeLessThanOrEqual(1);
  expect(fit.leftDelta).toBeGreaterThanOrEqual(-1);
  expect(fit.rightDelta).toBeGreaterThanOrEqual(-1);
});

test('maps hosted DEV history into the xScal HUD event contract', () => {
  const events = mapHistory(
    [{ id: 'channel-1', slug: 'trading' }, { id: 'channel-2', slug: 'general' }],
    [{ messages: [
      { id: 'message-2', channel_id: 'channel-1', user_id: 'user-1', username: 'Fake User', content: 'Newer row', created_at: '2026-01-02T00:00:00Z' },
      { id: 'message-1', channel_id: 'channel-2', user_id: 'user-2', username: 'Other Fake User', content: 'Older row', created_at: '2026-01-01T00:00:00Z' },
    ] }],
  );
  expect(events.map(event => [event.messageId, event.channel])).toEqual([
    ['message-1', 'global'], ['message-2', 'trade'],
  ]);
  expect(events[1]).toEqual(expect.objectContaining({
    kind: 'chat.message', senderUserId: 'user-1', senderDisplayName: 'Fake User', body: 'Newer row',
  }));
});

test('bounds hosted DEV history per channel without dropping channel coverage', () => {
  const channels = [{ id: 'general', slug: 'general' }, { id: 'events', slug: 'events' }];
  const messages = Array.from({ length: HOSTED_HISTORY_PER_CHANNEL + 10 }, (_, index) => ({
    id: `general-${index}`, channel_id: 'general', content: `row ${index}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  messages.push({ id: 'event-1', channel_id: 'events', content: 'event row', created_at: '2026-01-01T00:30:30Z' });
  const events = mapHistory(channels, [{ messages }]);
  expect(events.filter(event => event.channel === 'global')).toHaveLength(HOSTED_HISTORY_PER_CHANNEL);
  expect(events.filter(event => event.channel === 'events')).toHaveLength(1);
  expect(events.some(event => event.messageId === 'general-0')).toBe(false);
  expect(events.some(event => event.messageId === 'event-1')).toBe(true);
});

test('simulates multi-poll ZFE history with exactly one terminal marker', async () => {
  const widget = await readFile(new URL('../../FCMChatWidget.hx', import.meta.url), 'utf8');
  expect(widget).toContain('static inline var NATIVE_POLL_BATCH:Int = 16;');
  expect(widget).toContain('initialCount >= NATIVE_POLL_BATCH');
  expect(widget).toContain('count >= NATIVE_POLL_BATCH');

  const events = Array.from({ length: 40 }, (_, index) => ({ body: `history-${index}` }));
  events.push({ body: 'FCMCTL/1/HISTORY-DONE' });
  const delivered: Array<{ body: string }> = [];
  let polls = 0;
  while (events.length > 0) {
    polls++;
    delivered.push(...events.splice(0, 16));
  }
  expect(polls).toBe(3);
  expect(delivered).toHaveLength(41);
  expect(delivered.filter(event => event.body === 'FCMCTL/1/HISTORY-DONE')).toHaveLength(1);
  expect(delivered.at(-1)?.body).toBe('FCMCTL/1/HISTORY-DONE');
});

test('validates live hosted DEV sends before opening a remote socket', () => {
  const channels = new Map([['global', 'channel-global'], ['trade', 'channel-trade']]);
  expect(normalizeHudChannel('Trading')).toBe('trade');
  expect(validateHostedSend({ channel: 'general', body: ' hello ' }, channels)).toEqual({
    ok: true, channel: 'global', channelId: 'channel-global', body: 'hello',
  });
  expect(validateHostedSend({ channel: 'unknown', body: 'hello' }, channels)).toMatchObject({ ok: false, error: 'invalid_channel' });
  expect(validateHostedSend({ channel: 'trade', body: ' '.repeat(2) }, channels)).toMatchObject({ ok: false, error: 'invalid_body' });
});

test('delivers every right-panel control and physical compose keys to the harness', async ({ page }) => {
  await page.goto('/?mode=harness');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  for (const name of ['Open chat', 'Scroll up', 'Scroll down', 'Previous channel', 'Next channel', 'Open selected link', 'Hide']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  for (const code of ['Insert', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'F8', 'Delete']) {
    await expect(page.locator('#log')).toContainText(`KEYDOWN    ${code}`);
    await expect(page.locator('#log')).toContainText(`KEYUP      ${code}`);
  }
  await page.locator('#ruffle-player').focus();
  await page.keyboard.press('Insert');
  await page.keyboard.type('automated HUD message');
  await page.keyboard.press('Enter');
  await expect(page.locator('#log')).toContainText('KEYDOWN    Enter');
  await expect(page.locator('#log')).not.toContainText('command=activate-link handled=false');
  await page.screenshot({ path: 'test-results/hud-harness-input.png', fullPage: true });
});

for (const provider of ['xscal', 'zfe']) {
  test(`applies a custom F9 open keybind through the ${provider} preview route`, async ({ page, request }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    const response = await request.post('/__fcm/keybinds', { data: { ...defaultKeybinds, openKey: 'F9', scrollBottomKey: 'HOME' } });
    expect(response.ok()).toBe(true);
    await page.goto(`/?mode=harness&provider=${provider}`);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.locator('#bind-openKey')).toHaveValue('F9');
    await page.getByRole('button', { name: 'Open chat', exact: true }).click();
    await expect(page.locator('#log')).toContainText(`openKey=F9 provider=${provider}`);
    await expect(page.locator('#log')).toContainText('KEYDOWN    F9');
    expect(browserErrors).toEqual([]);
    await request.post('/__fcm/keybinds/reset', { data: {} });
  });
}

test('releases every old provider key before installing a complete rebound profile', async ({ page }) => {
  const rebound = normalizeKeybinds({
    openKey: 'F2', channelNextKey: 'F3', channelPrevKey: 'F4',
    scrollUpKey: 'F5', scrollDownKey: 'F6', scrollBottomKey: 'F7',
    activateLinkKey: 'F8', hideKey: 'F12',
  });
  const oldCodes = Object.values(defaultKeybinds).filter(Boolean).map(key => browserKey(key)!.keyCode);
  const newCodes = Object.values(rebound).filter(Boolean).map(key => browserKey(key)!.keyCode);

  await page.goto('/');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const result = await page.evaluate(({ oldCodes, newCodes }) => {
    const host = window.__INSTALLED_XSCAL__!;
    const oldRegistered = oldCodes.every(key => host.call('Input.RegisterKey', key));
    const oldReleased = oldCodes.every(key => host.call('Input.UnregisterKey', key));
    const oldInactive = oldCodes.every(key => !host.setPressed(key, true)
      && !host.call('Input.IsKeyPressed', key));
    const newRegistered = newCodes.every(key => host.call('Input.RegisterKey', key));
    const newActive = newCodes.every(key => host.setPressed(key, true)
      && host.call('Input.IsKeyPressed', key));
    return { oldRegistered, oldReleased, oldInactive, newRegistered, newActive };
  }, { oldCodes, newCodes });
  expect(result).toEqual({ oldRegistered: true, oldReleased: true, oldInactive: true,
    newRegistered: true, newActive: true });

  const [widgetSource, zfeSource] = await Promise.all([
    readFile(new URL('../../FCMChatWidget.hx', import.meta.url), 'utf8'),
    readFile(new URL('../haxe/MockZfe.hx', import.meta.url), 'utf8'),
  ]);
  expect(widgetSource.indexOf('stopPhysicalNavigation();')).toBeLessThan(
    widgetSource.indexOf('for (keyCode in keyCodes)'));
  expect(widgetSource).toContain('_physicalOpenKey = FcmCommand.virtualKeyCode(_cfg.openKey);');
  expect(widgetSource).not.toContain('_api.provider == FcmNativeApi.XSCAL\n            ? FcmCommand.virtualKeyCode(_cfg.openKey) : 0;');
  expect(widgetSource).toContain('callTop("updateChatHotkey", _cfg.openKey)');
  expect(zfeSource).toContain('if (verb == "updateChatHotkey") { hotkey = Std.string(payload); hotkeyDown = false;');
  expect(zfeSource).toContain('if (keyCode == FcmCommand.virtualKeyCode(hotkey)) hotkeyDown = down;');
});

for (const provider of ['xscal', 'zfe']) {
  test(`ultrawide positioning and compact customization through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=ultrawide`);
    await expect(page.locator('#log')).toContainText(/ULTRAWIDE (PASS|FAIL)/, { timeout: 25_000 });
    await expect(page.locator('#log')).toContainText(`ULTRAWIDE PASS ${provider} negative=preserved menus=bounded editor=aligned reset=recovered`);
    await expect(page.locator('#log')).toContainText('MENU-FRAME PASS branches=18 edges=all transforms=scaled viewport=16:9,21:9,32:9,small ownership=FCM-only');
  });
}

for (const provider of ['xscal', 'zfe']) {
  test(`renews Server membership while typing through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=typing-renewal`);
    await expect(page.locator('#log')).toContainText(/TYPING-RENEWAL (PASS|FAIL)/, { timeout: 25_000 });
    await expect(page.locator('#log')).toContainText(`TYPING-RENEWAL PASS ${provider} editor=preserved renewal=confirmed history=preserved expiry=enforced stale=leave auth=gated`);
  });
}

for (const provider of ['zfe', 'xscal']) {
  test(`browser request lifecycle and readable fallback through ${provider}`, async ({ page }) => {
    await page.goto(`/?mode=harness&provider=${provider}&scenario=browser-links`);
    await expect(page.locator('#log')).toContainText(`BROWSER PASS ${provider}`, { timeout: 30_000 });
    await expect(page.locator('#log')).not.toContainText('BROWSER FAIL');
  });
}
