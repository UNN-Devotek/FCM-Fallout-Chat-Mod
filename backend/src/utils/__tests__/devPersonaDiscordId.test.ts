import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devPersonaDiscordId, devPersonaUsername } from '../devPersonaDiscordId';

test('is deterministic for the same (persona, install)', () => {
  assert.equal(
    devPersonaDiscordId('owner', 'install-A'),
    devPersonaDiscordId('owner', 'install-A'),
  );
});

test('differs across installs for the SAME persona (the collision the bug caused)', () => {
  assert.notEqual(
    devPersonaDiscordId('owner', 'install-A'),
    devPersonaDiscordId('owner', 'install-B'),
  );
});

test('differs across personas for the SAME install', () => {
  assert.notEqual(
    devPersonaDiscordId('owner', 'install-A'),
    devPersonaDiscordId('user', 'install-A'),
  );
});

test('is prefixed with the persona for readability', () => {
  assert.match(devPersonaDiscordId('moderator', 'install-X'), /^dev-moderator-[0-9a-f]{16}$/);
});

test('username: unique per install but keeps the readable base name', () => {
  const a = devPersonaUsername('System Owner', 'install-A');
  const b = devPersonaUsername('System Owner', 'install-B');
  assert.notEqual(a, b);                       // no @unique collision across installs
  assert.ok(a.startsWith('System Owner '));    // still human-readable
  assert.equal(devPersonaUsername('System Owner', 'install-A'), a); // deterministic
});
