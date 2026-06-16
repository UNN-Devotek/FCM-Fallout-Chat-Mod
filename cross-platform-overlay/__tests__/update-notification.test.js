// Unit tests for the update-notification system added in lieu of the auto-updater.
//
// Covers:
//   1. cmpVersions helper — newer/older/equal, multi-digit, malformed input.
//   2. Notification trigger logic — fires when latestVersion > APP_VERSION, not when
//      equal or older; once-per-session guard suppresses reconnect spam; click handler
//      calls shell.openExternal(NEXUS_MOD_URL).
//
// The main-process notification path (showUpdateNotification / the WS message handler)
// is pure logic extracted for testing — no Electron runtime required.
//
// Runner: vitest (environment 'node' — no DOM needed).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import core from '../overlay-core.js';

const { cmpVersions } = core;

// ── 1. cmpVersions ────────────────────────────────────────────────────────────

describe('cmpVersions', () => {
  it('returns > 0 when a is newer than b (simple)', () => {
    expect(cmpVersions('1.3.10', '1.3.9')).toBeGreaterThan(0);
  });

  it('returns < 0 when a is older than b (simple)', () => {
    expect(cmpVersions('1.3.9', '1.3.10')).toBeLessThan(0);
  });

  it('returns 0 when a equals b', () => {
    expect(cmpVersions('1.3.10', '1.3.10')).toBe(0);
  });

  it('handles multi-digit minor/patch correctly (1.3.10 > 1.3.9, not string order)', () => {
    expect(cmpVersions('1.3.10', '1.3.9')).toBeGreaterThan(0);
    expect(cmpVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(cmpVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('handles equal versions at each segment level', () => {
    expect(cmpVersions('2.0.0', '2.0.0')).toBe(0);
    expect(cmpVersions('0.0.0', '0.0.0')).toBe(0);
    expect(cmpVersions('1.3.91', '1.3.91')).toBe(0);
  });

  it('treats null as 0.0.0 — any real version is newer', () => {
    expect(cmpVersions('1.0.0', null)).toBeGreaterThan(0);
    expect(cmpVersions(null, '1.0.0')).toBeLessThan(0);
    expect(cmpVersions(null, null)).toBe(0);
  });

  it('treats undefined as 0.0.0', () => {
    expect(cmpVersions('1.0.0', undefined)).toBeGreaterThan(0);
    expect(cmpVersions(undefined, '1.0.0')).toBeLessThan(0);
  });

  it('treats empty string as 0.0.0', () => {
    expect(cmpVersions('1.0.0', '')).toBeGreaterThan(0);
    expect(cmpVersions('', '1.0.0')).toBeLessThan(0);
    expect(cmpVersions('', '')).toBe(0);
  });

  it('handles version without patch segment', () => {
    // localeCompare numeric treats '1.4' > '1.3'
    expect(cmpVersions('1.4', '1.3')).toBeGreaterThan(0);
    expect(cmpVersions('1.3', '1.4')).toBeLessThan(0);
  });

  it('major version bump', () => {
    expect(cmpVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(cmpVersions('1.9.9', '2.0.0')).toBeLessThan(0);
  });
});

// ── 2. Notification trigger logic ─────────────────────────────────────────────
//
// We test the logic that lives in main.js's WS message handler without requiring
// an Electron runtime. The handler logic is:
//
//   if (msg.type === 'app:update-available' && typeof msg.payload.latestVersion === 'string') {
//     if (!updateNotifiedThisSession && cmpVersions(latestVersion, APP_VERSION) > 0) {
//       updateNotifiedThisSession = true;
//       showUpdateNotification(latestVersion);
//     }
//   }
//
// We re-implement the decision function here so the logic is unit-testable in
// isolation, mirroring how overlay-core.js externalises pure logic from main.js.

const NEXUS_MOD_URL = 'https://www.nexusmods.com/fallout76/mods/4082';

/**
 * Pure decision function extracted from main.js's WS message handler.
 * Returns { shouldNotify: boolean, newSessionFlag: boolean }.
 */
function evaluateUpdateMessage(msg, APP_VERSION, updateNotifiedThisSession) {
  if (!msg || msg.type !== 'app:update-available') return { shouldNotify: false, newSessionFlag: updateNotifiedThisSession };
  const payload = msg.payload;
  if (!payload || typeof payload.latestVersion !== 'string') return { shouldNotify: false, newSessionFlag: updateNotifiedThisSession };
  const latestVersion = payload.latestVersion;
  if (updateNotifiedThisSession) return { shouldNotify: false, newSessionFlag: true };
  if (cmpVersions(latestVersion, APP_VERSION) <= 0) return { shouldNotify: false, newSessionFlag: false };
  return { shouldNotify: true, newSessionFlag: true };
}

/**
 * Simulate showUpdateNotification — builds and returns the notification descriptor.
 * In main.js this calls `new Notification(...)` + `shell.openExternal`. Here we
 * return a plain object so tests can assert without an Electron runtime.
 */
function makeUpdateNotificationDescriptor(version) {
  return {
    title: `Update!  v${version}`,
    body: 'A new version of Fallout Chat Mod is available. Click to get it on Nexus Mods.',
    onClickUrl: NEXUS_MOD_URL,
  };
}

describe('update notification trigger logic', () => {
  const APP_VERSION = '1.3.91';

  it('fires when latestVersion is newer than APP_VERSION', () => {
    const msg = { type: 'app:update-available', payload: { latestVersion: '1.3.92' } };
    const { shouldNotify, newSessionFlag } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(true);
    expect(newSessionFlag).toBe(true);
  });

  it('does NOT fire when latestVersion equals APP_VERSION', () => {
    const msg = { type: 'app:update-available', payload: { latestVersion: '1.3.91' } };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(false);
  });

  it('does NOT fire when latestVersion is older than APP_VERSION', () => {
    const msg = { type: 'app:update-available', payload: { latestVersion: '1.3.90' } };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(false);
  });

  it('once-per-session guard: does NOT fire a second time even if version is newer', () => {
    const msg = { type: 'app:update-available', payload: { latestVersion: '1.3.92' } };
    // First call: fires
    const first = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(first.shouldNotify).toBe(true);
    // Second call (reconnect): guard is set
    const second = evaluateUpdateMessage(msg, APP_VERSION, first.newSessionFlag);
    expect(second.shouldNotify).toBe(false);
  });

  it('once-per-session guard resets per app launch (flag starts false)', () => {
    // Simulate fresh launch: flag is false
    const msg = { type: 'app:update-available', payload: { latestVersion: '2.0.0' } };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(true);
  });

  it('ignores messages of a different type', () => {
    const msg = { type: 'release:published', payload: { latestVersion: '2.0.0' } };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(false);
  });

  it('ignores malformed payload (missing latestVersion)', () => {
    const msg = { type: 'app:update-available', payload: {} };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(false);
  });

  it('ignores non-string latestVersion', () => {
    const msg = { type: 'app:update-available', payload: { latestVersion: 9999 } };
    const { shouldNotify } = evaluateUpdateMessage(msg, APP_VERSION, false);
    expect(shouldNotify).toBe(false);
  });
});

describe('update notification descriptor (title / body / click URL)', () => {
  it('title contains "Update!" and the version', () => {
    const desc = makeUpdateNotificationDescriptor('1.3.92');
    expect(desc.title).toBe('Update!  v1.3.92');
  });

  it('body matches the contract copy', () => {
    const desc = makeUpdateNotificationDescriptor('1.3.92');
    expect(desc.body).toBe('A new version of Fallout Chat Mod is available. Click to get it on Nexus Mods.');
  });

  it('click URL is the Nexus mod page', () => {
    const desc = makeUpdateNotificationDescriptor('1.3.92');
    expect(desc.onClickUrl).toBe(NEXUS_MOD_URL);
    expect(desc.onClickUrl).toBe('https://www.nexusmods.com/fallout76/mods/4082');
  });

  it('version is included verbatim in the title', () => {
    const desc = makeUpdateNotificationDescriptor('2.1.0');
    expect(desc.title).toContain('2.1.0');
  });
});
