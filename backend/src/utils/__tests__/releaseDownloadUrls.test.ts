/**
 * Unit tests for releaseDownloadUrls.ts — the environment-aware release
 * download origin + SSRF allow-list behind the publish-verify gate.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RELEASE_DOWNLOAD_HOST,
  releaseDownloadHost,
  electronDownloadsBase,
  linuxZipUrl,
  rawWindowsInstallerUrl,
  rawLinuxAppImageUrl,
  isAllowedDownloadUrl,
  assertAllowedDownloadUrl,
} from '../releaseDownloadUrls';

describe('releaseDownloadUrls', () => {
  const original = process.env.RELEASE_DOWNLOAD_HOST;
  afterEach(() => {
    if (original === undefined) delete process.env.RELEASE_DOWNLOAD_HOST;
    else process.env.RELEASE_DOWNLOAD_HOST = original;
  });

  describe('releaseDownloadHost', () => {
    test('defaults to prod when RELEASE_DOWNLOAD_HOST is unset', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      assert.equal(releaseDownloadHost(), 'falloutchatmod.com');
      assert.equal(releaseDownloadHost(), DEFAULT_RELEASE_DOWNLOAD_HOST);
    });

    test('honours the RELEASE_DOWNLOAD_HOST override (dev stack)', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      assert.equal(releaseDownloadHost(), 'dev.falloutchatmod.com');
    });
  });

  describe('artifact URLs', () => {
    test('default (prod) host + electron-builder filenames', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      assert.equal(electronDownloadsBase(), 'https://falloutchatmod.com/downloads/electron');
      assert.equal(
        linuxZipUrl('1.2.3'),
        'https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.2.3.AppImage%20(Linux).zip',
      );
      assert.equal(
        rawWindowsInstallerUrl('1.2.3'),
        'https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%201.2.3.exe',
      );
      assert.equal(
        rawLinuxAppImageUrl('1.2.3'),
        'https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.2.3.AppImage',
      );
    });

    test('dev override swaps the host, keeps the filenames', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      assert.equal(
        linuxZipUrl('1.3.91-dev'),
        'https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod-1.3.91-dev.AppImage%20(Linux).zip',
      );
      assert.ok(
        rawLinuxAppImageUrl('1.3.91-dev').startsWith('https://dev.falloutchatmod.com/downloads/electron/'),
      );
    });
  });

  describe('isAllowedDownloadUrl / assertAllowedDownloadUrl (SSRF allow-list)', () => {
    test('accepts an https /downloads/ URL on the configured host', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      assert.equal(isAllowedDownloadUrl('https://falloutchatmod.com/downloads/electron/x.zip'), true);
      assert.doesNotThrow(() => assertAllowedDownloadUrl('https://falloutchatmod.com/downloads/electron/x.zip'));
    });

    test('follows the configured host — prod allowed by default, dev only when set', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      assert.equal(isAllowedDownloadUrl('https://dev.falloutchatmod.com/downloads/x.zip'), false);
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      assert.equal(isAllowedDownloadUrl('https://dev.falloutchatmod.com/downloads/x.zip'), true);
      // With the dev host configured, prod URLs are no longer accepted.
      assert.equal(isAllowedDownloadUrl('https://falloutchatmod.com/downloads/x.zip'), false);
    });

    test('rejects other hosts, http, non-/downloads paths, and junk', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      assert.equal(isAllowedDownloadUrl('https://evil.com/downloads/x.zip'), false);
      assert.equal(isAllowedDownloadUrl('http://falloutchatmod.com/downloads/x.zip'), false); // not https
      assert.equal(isAllowedDownloadUrl('https://falloutchatmod.com/etc/passwd'), false);     // not /downloads/
      assert.equal(isAllowedDownloadUrl('https://169.254.169.254/downloads/x'), false);       // cloud metadata IP
      assert.equal(isAllowedDownloadUrl('not a url'), false);
      assert.throws(() => assertAllowedDownloadUrl('https://evil.com/downloads/x.zip'), /must be an https/);
    });
  });
});
