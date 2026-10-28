import { expect, test } from '@playwright/test';

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
