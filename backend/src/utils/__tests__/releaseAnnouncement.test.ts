/**
 * Unit tests for releaseAnnouncement.ts — the @everyone ping, env-aware download
 * links, and the Nexus endorsement copy used in the Discord release announcement.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_PING,
  DEFAULT_NEXUS_MOD_URL,
  nexusModUrl,
  downloadPageUrl,
  releaseDownloadFieldValue,
  nexusEndorseFieldValue,
  releaseAnnouncementMessage,
} from '../releaseAnnouncement';

describe('releaseAnnouncement', () => {
  const orig = {
    NEXUS_MOD_URL: process.env.NEXUS_MOD_URL,
    DOWNLOAD_PAGE_URL: process.env.DOWNLOAD_PAGE_URL,
    RELEASE_DOWNLOAD_HOST: process.env.RELEASE_DOWNLOAD_HOST,
  };
  afterEach(() => {
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  test('RELEASE_PING pings @everyone', () => {
    assert.equal(RELEASE_PING, '@everyone');
  });

  test('quiet release posts omit content and allowed mentions', () => {
    assert.deepEqual(releaseAnnouncementMessage(false), {});
  });

  test('normal release posts retain the explicit @everyone mention', () => {
    assert.deepEqual(releaseAnnouncementMessage(true), {
      content: '@everyone',
      allowedMentions: { parse: ['everyone'] },
    });
  });

  describe('nexusModUrl', () => {
    test('defaults to the FCM Nexus page', () => {
      delete process.env.NEXUS_MOD_URL;
      assert.equal(nexusModUrl(), DEFAULT_NEXUS_MOD_URL);
      assert.ok(nexusModUrl().includes('nexusmods.com/fallout76/mods/4082'));
    });
    test('honours NEXUS_MOD_URL override', () => {
      process.env.NEXUS_MOD_URL = 'https://www.nexusmods.com/fallout76/mods/9999';
      assert.equal(nexusModUrl(), 'https://www.nexusmods.com/fallout76/mods/9999');
    });
  });

  describe('downloadPageUrl', () => {
    test('defaults to prod, overridable per environment', () => {
      delete process.env.DOWNLOAD_PAGE_URL;
      assert.equal(downloadPageUrl(), 'https://falloutchatmod.com');
      process.env.DOWNLOAD_PAGE_URL = 'https://dev.falloutchatmod.com';
      assert.equal(downloadPageUrl(), 'https://dev.falloutchatmod.com');
    });
  });

  describe('releaseDownloadFieldValue (env-aware platform links — the prod-404 fix)', () => {
    test('uses the configured host for Windows, both Linux packages, and the Linux ZIP', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      const v = releaseDownloadFieldValue('1.3.91-dev');
      assert.ok(v.includes('🪟 [Windows](https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%201.3.91-dev%20(Windows).zip)'));
      assert.ok(v.includes('🐧 [Linux AppImage](https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.3.91-dev.AppImage)'));
      assert.ok(v.includes('[Linux .deb](https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.3.91-dev.deb)'));
      assert.ok(v.includes('[Linux ZIP + install docs](https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.3.91-dev.AppImage%20(Linux).zip)'));
    });
    test('defaults to the prod host when RELEASE_DOWNLOAD_HOST is unset', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      const v = releaseDownloadFieldValue('1.2.3');
      // Assert the exact prod links rather than a bare host substring — a bare
      // `includes('host')` trips CodeQL's incomplete-url-substring-sanitization
      // and proves nothing about the host. The full prod URLs exclude the dev host.
      assert.ok(v.includes('🪟 [Windows](https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%201.2.3%20(Windows).zip)'));
      assert.ok(v.includes('🐧 [Linux AppImage](https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.2.3.AppImage)'));
      assert.ok(v.includes('[Linux .deb](https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.2.3.deb)'));
      assert.ok(v.includes('[Linux ZIP + install docs](https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.2.3.AppImage%20(Linux).zip)'));
    });

    test('includes the target HUD package when release metadata provides one', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      const v = releaseDownloadFieldValue('1.3.91-dev', {
        version: '2.10.8',
        url: 'https://dev.falloutchatmod.com/downloads/electron/ZFE%20FCM%20HUD%20Mod-2.10.8%20(DEV).zip',
      });
      assert.ok(v.includes('[ZFE FCM HUD Mod ZIP v2.10.8](https://dev.falloutchatmod.com/downloads/electron/ZFE%20FCM%20HUD%20Mod-2.10.8%20(DEV).zip)'));
    });
  });

  describe('nexusEndorseFieldValue', () => {
    test('has the endorse link, the encouragement, and the download caveat', () => {
      delete process.env.NEXUS_MOD_URL;
      const v = nexusEndorseFieldValue();
      assert.ok(v.includes('[endorse it on Nexus](https://www.nexusmods.com/fallout76/mods/4082)'));
      assert.ok(v.includes('Enjoying Fallout Chat Mod?'));
      assert.ok(v.includes('downloaded the mod from there at least once'));
      // the "grab it on Nexus first, then hit Endorse" tail was dropped per request
      assert.ok(!v.includes('grab it on Nexus first'));
    });
  });
});
