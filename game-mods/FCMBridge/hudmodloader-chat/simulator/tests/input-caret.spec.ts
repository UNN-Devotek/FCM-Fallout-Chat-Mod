import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__FCM_SIM__?.unload()).catch(() => undefined);
  await page.evaluate(() => window.__FCM_SIM_TEARDOWN__?.()).catch(() => undefined);
});

for (const provider of ['zfe', 'xscal']) {
  test(`local caret blinks, follows arrow editing and never enters messages on ${provider}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
      ? route.continue() : route.abort());
    await page.goto(`/?mode=harness&provider=${provider}&scenario=input-caret`);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.snapshot());
    await expect.poll(snapshot, { timeout: 20_000 }).toMatchObject({ editorActive: false,
      caretVisible: false, canSend: true, ordinarySendCount: 0 });
    const initial = await snapshot();
    await page.locator('#ruffle-player').focus();
    await page.keyboard.press('Insert');
    await expect.poll(snapshot).toMatchObject({ editorActive: true, caretVisible: true, caretPosition: 0 });
    // Sample more often than the blink period to avoid aliasing at 1-second polls.
    await expect.poll(snapshot, { intervals: [75] }).toMatchObject({ editorActive: true, caretVisible: false });
    await expect.poll(snapshot, { intervals: [75] }).toMatchObject({ editorActive: true, caretVisible: true });
    await page.keyboard.type('abcd');
    await expect.poll(snapshot).toMatchObject({ editorText: 'abcd', caretPosition: 4 });
    const end = await snapshot();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(snapshot).toMatchObject({ caretVisible: true, caretPosition: 2, editorText: 'abcd' });
    expect((await snapshot())!.caretX).toBeLessThan(end!.caretX as number);
    await page.keyboard.type('X');
    await expect.poll(snapshot).toMatchObject({ caretPosition: 3, editorText: 'abXcd' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await expect.poll(snapshot).toMatchObject({ caretPosition: 3, editorText: 'abXd' });
    await expect.poll(snapshot).toMatchObject({ ordinarySendCount: 0, feedRowCount: initial!.feedRowCount });
    const sends = (await snapshot())!.ordinarySendCount as number;
    await page.keyboard.press('Enter');
    await expect.poll(snapshot).toMatchObject({ editorActive: false, caretVisible: false, caretAttached: false,
      ordinarySendCount: sends + 1, lastChatBody: 'abXd' });
    await page.keyboard.press('Insert');
    await expect.poll(snapshot).toMatchObject({ editorActive: true, caretVisible: true, editorText: '' });
    await page.evaluate(() => {
      const player = document.querySelector('#ruffle-player') as HTMLElement & {
        ruffle(): { callExternalInterface(name: string, ...args: unknown[]): unknown };
      };
      player.ruffle().callExternalInterface('simDispatch', 'stale-input-poll', true);
    });
    await expect.poll(snapshot).toMatchObject({ editorActive: true, caretAttached: true });
    await page.keyboard.type('q');
    await page.keyboard.press('Escape');
    await expect.poll(snapshot).toMatchObject({ editorActive: false, caretAttached: false,
      ordinarySendCount: sends + 1, lastChatBody: 'abXd' });
    await page.keyboard.press('Insert');
    await expect.poll(snapshot).toMatchObject({ editorActive: true, caretVisible: true });
    await page.evaluate(() => window.__FCM_SIM__?.unload());
    await expect.poll(snapshot).toMatchObject({ editorActive: false, caretAttached: false });
    await expect(page.locator('#log')).not.toContainText('Uncaught');
  });
}

test('native xScal cursor snapshots drive the caret without changing editor ownership or messages', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:41739'
    ? route.continue() : route.abort());
  await page.goto('/?mode=harness&provider=xscal&scenario=xscal-native-caret');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const snapshot = () => page.evaluate(() => window.__FCM_SIM__?.snapshot());
  const invoke = (name: string, ...args: unknown[]) => page.evaluate(({ name, args }) => {
    const player = document.querySelector('#ruffle-player') as HTMLElement & {
      ruffle(): { callExternalInterface(name: string, ...args: unknown[]): unknown };
    };
    return player.ruffle().callExternalInterface(name, ...args);
  }, { name, args });
  const native = (text: string, index: number | string | null, state = 'active') => {
    const encoded = JSON.stringify(text).replace(/[\u007f-\uffff]/g,
      unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return invoke('simNativeInput', encoded, index, state);
  };
  await expect.poll(snapshot, { timeout: 20_000 }).toMatchObject({ canSend: true, nativeInputActive: false });
  await page.locator('#ruffle-player').focus();
  await page.keyboard.press('Insert');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, editorActive: false,
    caretVisible: true, caretPosition: 0, nativeBeginCount: 1 });
  await expect.poll(snapshot, { intervals: [75] }).toMatchObject({ caretVisible: false });
  await expect.poll(snapshot, { intervals: [75] }).toMatchObject({ caretVisible: true });
  await native('abcd', 4);
  await expect.poll(snapshot).toMatchObject({ nativeDraft: 'abcd', caretPosition: 4 });
  const end = (await snapshot())!;
  await native('abcd', 2); // Same text/revision: an actual cursor-only native snapshot.
  await expect.poll(snapshot).toMatchObject({ caretPosition: 2, caretVisible: true,
    nativeRevision: end.nativeRevision, nativeBeginCount: 1, editorActive: false });
  expect((await snapshot())!.caretX).toBeLessThan(end.caretX as number);
  await native('abXcd', 3);
  await native('abXd', 3);
  await expect.poll(snapshot).toMatchObject({ nativeDraft: 'abXd', caretPosition: 3,
    ordinarySendCount: 0, feedRowCount: 0 });
  await native('abXd', '3');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, caretAttached: false,
    nativeDraft: 'abXd', nativeBeginCount: 1 });
  await native('a  <&> b', 5);
  await expect.poll(snapshot).toMatchObject({ nativeDraft: 'a  <&> b', caretPosition: 5, caretVisible: true });
  await native('a😀b', 3);
  await expect.poll(snapshot).toMatchObject({ nativeDraftUnits: [97, 0xD83D, 0xDE00, 98], caretPosition: 3, caretVisible: true });
  await native('a😀b', 2); // A UTF-16 offset inside the surrogate pair is invalid presentation data.
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, caretAttached: false });
  const longDraft = '0'.repeat(480);
  await native(longDraft, 480);
  await expect.poll(snapshot).toMatchObject({ caretPosition: 480, caretVisible: true });
  const scrolled = (await snapshot())!;
  expect(scrolled.nativeFieldScrollH).toBeGreaterThan(0);
  expect(scrolled.caretX).toBeGreaterThanOrEqual(scrolled.nativeFieldLeft as number);
  expect(scrolled.caretX).toBeLessThan(scrolled.nativeFieldRight as number);
  await native(longDraft, 0);
  await expect.poll(snapshot).toMatchObject({ caretPosition: 0, caretVisible: true });
  expect((await snapshot())!.nativeFieldScrollH).toBeLessThan(scrolled.nativeFieldScrollH as number);
  await invoke('simDispatch', 'caret-render-fault', true);
  await native('abXd', 3);
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, nativeDraft: 'abXd',
    nativeBeginCount: 1, nativeEndCount: 0, ordinarySendCount: 0 });
  await invoke('simDispatch', 'caret-render-fault', false);
  await native('abXd', 3, 'submitted');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: false, caretAttached: false,
    ordinarySendCount: 1, lastChatBody: 'abXd', nativeEndCount: 1 });
  await page.keyboard.press('Insert');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, caretVisible: true, nativeDraft: '' });
  await native('', null); // Older providers omit the optional field: keep the same native owner.
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, editorActive: false, caretAttached: false });
  await native('', 0);
  await invoke('simDispatch', 'stale-input-poll', true);
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, caretAttached: true, nativeBeginCount: 2 });
  await native('', 0, 'cancelled');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: false, caretAttached: false,
    nativeEndCount: 2, ordinarySendCount: 1 });
  await page.keyboard.press('Insert');
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: true, caretVisible: true });
  await page.evaluate(() => window.__FCM_SIM__?.unload());
  await expect.poll(snapshot).toMatchObject({ nativeInputActive: false, caretAttached: false,
    nativeEndCount: 3, ordinarySendCount: 1 });
  await expect(page.locator('#log')).not.toContainText('Uncaught');
});
