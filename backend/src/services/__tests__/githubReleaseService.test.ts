/**
 * Unit tests for githubReleaseService — config resolution, payload shaping, and
 * the best-effort create/update flow (with an injected fetch).
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  githubReleaseConfig,
  isPrereleaseVersion,
  releaseTag,
  buildGitHubReleaseBody,
  githubReleasePayload,
  createGitHubRelease,
} from '../githubReleaseService';

const KEYS = ['GITHUB_RELEASE_TOKEN', 'GITHUB_PAT', 'GITHUB_OWNER', 'GITHUB_REPO', 'RELEASE_DOWNLOAD_HOST', 'NEXUS_MOD_URL'];

describe('githubReleaseService', () => {
  const orig: Record<string, string | undefined> = {};
  for (const k of KEYS) orig[k] = process.env[k];
  afterEach(() => {
    for (const k of KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  describe('githubReleaseConfig', () => {
    test('null only when no token is available', () => {
      for (const k of KEYS) delete process.env[k];
      assert.equal(githubReleaseConfig(), null);
    });
    test('defaults owner/repo to the FCM repo when unset (prod has only GITHUB_PAT)', () => {
      delete process.env.GITHUB_RELEASE_TOKEN;
      delete process.env.GITHUB_OWNER;
      delete process.env.GITHUB_REPO;
      process.env.GITHUB_PAT = 'tok';
      assert.deepEqual(githubReleaseConfig(), { token: 'tok', owner: 'UNN-Devotek', repo: 'FCM-Fallout-Chat-Mod' });
    });
    test('explicit GITHUB_OWNER/REPO override the defaults', () => {
      process.env.GITHUB_PAT = 'tok';
      process.env.GITHUB_OWNER = 'o';
      process.env.GITHUB_REPO = 'r';
      assert.deepEqual(githubReleaseConfig(), { token: 'tok', owner: 'o', repo: 'r' });
    });
    test('GITHUB_RELEASE_TOKEN overrides GITHUB_PAT', () => {
      process.env.GITHUB_PAT = 'pat';
      process.env.GITHUB_RELEASE_TOKEN = 'rel';
      assert.equal(githubReleaseConfig()?.token, 'rel');
    });
  });

  describe('version helpers + payload', () => {
    test('isPrereleaseVersion / releaseTag', () => {
      assert.equal(isPrereleaseVersion('1.3.91-dev'), true);
      assert.equal(isPrereleaseVersion('1.3.91'), false);
      assert.equal(releaseTag('1.3.91'), 'v1.3.91');
    });
    test('prod release is "latest"; a -suffix version is a prerelease', () => {
      delete process.env.RELEASE_DOWNLOAD_HOST;
      delete process.env.NEXUS_MOD_URL;
      const prod = githubReleasePayload('1.3.91', 'notes');
      assert.equal(prod.tag_name, 'v1.3.91');
      assert.equal(prod.name, 'Fallout Chat Mod v1.3.91');
      assert.equal(prod.prerelease, false);
      assert.equal(prod.make_latest, 'true');
      const dev = githubReleasePayload('1.3.91-dev', 'notes');
      assert.equal(dev.prerelease, true);
      assert.equal(dev.make_latest, 'false');
    });
  });

  describe('buildGitHubReleaseBody', () => {
    test('includes the notes, env-aware download links, and the endorse line', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      delete process.env.NEXUS_MOD_URL;
      const body = buildGitHubReleaseBody('1.3.91-dev', 'My notes here');
      assert.ok(body.includes('My notes here'));
      assert.ok(body.includes('## Download'));
      // Full markdown links (not a bare host substring → CodeQL-clean, matches releaseAnnouncement.test).
      assert.ok(body.includes('🪟 [Windows](https://dev.falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%201.3.91-dev%20(Windows).zip)'));
      assert.ok(body.includes('## Endorse on Nexus'));
      assert.ok(body.includes('[endorse it on Nexus](https://www.nexusmods.com/fallout76/mods/4082)'));
    });

    test('includes the versioned HUD package link when supplied', () => {
      process.env.RELEASE_DOWNLOAD_HOST = 'dev.falloutchatmod.com';
      const body = buildGitHubReleaseBody('1.3.91-dev', 'My notes here', {
        version: '2.10.8',
        url: 'https://dev.falloutchatmod.com/downloads/electron/ZFE%20FCM%20HUD%20Mod-2.10.8%20(DEV).zip',
      });
      assert.ok(body.includes('[ZFE FCM HUD Mod ZIP v2.10.8](https://dev.falloutchatmod.com/downloads/electron/ZFE%20FCM%20HUD%20Mod-2.10.8%20(DEV).zip)'));
    });
  });

  describe('createGitHubRelease (best-effort)', () => {
    test('skips with no calls when not configured', async () => {
      for (const k of KEYS) delete process.env[k];
      const calls: string[] = [];
      const fetchImpl = (async (u: unknown) => { calls.push(String(u)); return new Response('', { status: 200 }); }) as unknown as typeof fetch;
      await createGitHubRelease('1.3.91', 'n', { fetchImpl });
      assert.equal(calls.length, 0);
    });

    test('POSTs a new release when the tag does not exist (404)', async () => {
      process.env.GITHUB_PAT = 't'; process.env.GITHUB_OWNER = 'o'; process.env.GITHUB_REPO = 'r';
      const calls: { method: string; url: string }[] = [];
      const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
        const u = String(url); calls.push({ method: init?.method || 'GET', url: u });
        if (u.includes('/releases/tags/')) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }) as unknown as typeof fetch;
      await createGitHubRelease('1.3.91', 'n', { fetchImpl });
      assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/releases/tags/v1.3.91')));
      assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/releases')));
    });

    test('PATCHes the existing release when the tag exists', async () => {
      process.env.GITHUB_PAT = 't'; process.env.GITHUB_OWNER = 'o'; process.env.GITHUB_REPO = 'r';
      const calls: { method: string; url: string }[] = [];
      const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
        const u = String(url); calls.push({ method: init?.method || 'GET', url: u });
        if (u.includes('/releases/tags/')) return new Response(JSON.stringify({ id: 42 }), { status: 200 });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      await createGitHubRelease('1.3.91', 'n', { fetchImpl });
      assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('/releases/42')));
    });

    test('never throws on API failure (best-effort)', async () => {
      process.env.GITHUB_PAT = 't'; process.env.GITHUB_OWNER = 'o'; process.env.GITHUB_REPO = 'r';
      const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
      await assert.doesNotReject(createGitHubRelease('1.3.91', 'n', { fetchImpl }));
    });
  });
});
