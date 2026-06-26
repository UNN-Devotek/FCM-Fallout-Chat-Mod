# QA Role + Golden Dev Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let vetted QA testers run a packaged "golden" dev overlay build that connects to the hosted dev service as a regular chat user — gated by a dev-guild QA Discord role (enforced via Discord OAuth) — with a version-string golden-build lock that hard-rejects any build that isn't the single currently-active one.

**Architecture:** Backend adds (a) a pure QA-role gate + dev-only Discord-OAuth flow that mints a normal `X-Auth-Token` session only for users holding the QA role, delivered to the desktop app via the existing install-token + Redis + poll pattern; (b) a Redis-backed "active QA version" store, flipped by an admin endpoint, enforced at the poll endpoint (HTTP 426) and the WebSocket handshake (close 4003). The overlay gains a `qa` build channel (dev URLs + QA login + an `X-Client-Version` header). Cloudflare Access is reconfigured to bypass the overlay paths while keeping the dashboard/admin SSO-gated (infra + docs).

**Tech Stack:** Node/TypeScript backend (Express, Prisma, `redis`), Jest + supertest tests; Electron overlay (plain JS main process, Vite renderer), Vitest tests; electron-builder; Cloudflare Access.

**Spec:** `docs/superpowers/specs/2026-06-25-qa-role-golden-dev-build-design.md`

## Global Constraints

These apply to EVERY task:

- **Dev-only, gated on `NODE_ENV === 'development'` ALONE** — never on `ENABLE_DEV_LOGIN` (hosted dev has `ENABLE_DEV_LOGIN=false`). No QA code path may run when `NODE_ENV === 'production'`.
- **Zero prod impact.** No change to the prod overlay, prod auth, prod release flow, or the `Release` table. The active-QA-version store is SEPARATE from `Release` (which feeds prod's `app:update-available`).
- **QA session = a plain `user`.** The QA role gates *getting in*; it is never a chat privilege.
- **Version lock is exact-match to the single active version.** `isBuildAllowed` returns true only when `clientVersion === activeVersion`. Fail-OPEN when the active version is unset (never brick all testers on misconfig); fail-CLOSED on mismatch.
- **EULA-safe overlay track only.** The QA build still merely process-detects `Fallout76`; no game-memory reading, injection, or network scanning. No `.ba2` work.
- **Tests + CI (hard rule).** Every task ships with tests in the same change. Backend tests live in `backend/tests/**/*.test.js` (auto-discovered by Jest); overlay tests in `cross-platform-overlay/__tests__/**/*.{test,spec}.{js,ts}` (auto-discovered by Vitest). No CI YAML edits are needed — new files in those dirs are picked up by `backend-jest` and `unit-vitest`.
- **Docs in sync (hard rule).** Doc updates are folded into the relevant tasks plus a final docs/CF task.
- **No emojis** anywhere (code, output, docs, commit messages). House style.
- **Commits carry NO AI attribution** (no `Co-Authored-By: Claude`, no "Generated with" footer). Conventional-commit subjects.
- **Branch:** `feat/qa-role-golden-dev-build` (already created off `dev`; rebase onto fresh `origin/dev` before the first code task — local `dev` is ~38 commits behind).

---

## Task 1: Pure QA-role gate (`qaAuthService.ts`) + `DEV_QA_ROLE_ID` env

**Files:**
- Create: `backend/src/services/qaAuthService.ts`
- Modify: `backend/src/config/environment.ts` (add `DEV_QA_ROLE_ID` to the interface near line 112 and the parse block near line 239)
- Test: `backend/tests/qaAuthService.test.js`

**Interfaces:**
- Consumes: `DevAuthDeps`, `discordOAuthDeps` from `backend/src/services/devAuthService.ts` (existing); `env.DEV_GUILD_ID`, `env.DEV_QA_ROLE_ID`.
- Produces:
  - `verifyQaRole(devMemberRoles: string[], qaRoleId: string): { authorized: boolean; reason?: string }`
  - `checkQaAccess(discordUserId: string, deps: DevAuthDeps, accessToken?: string): Promise<{ discordUserId: string; authorized: boolean; reason?: string }>`

- [ ] **Step 1: Add the env var.** In `backend/src/config/environment.ts`, in the interface block right after the dual-role-gate fields (after `PROD_VERIFY_TOKEN: string;` near line 112) add:

```typescript
  // QA tester gate — dev guild only. The QA role ID in the DEV Discord guild.
  DEV_QA_ROLE_ID: string;
```

In the parse/return object right after `PROD_VERIFY_TOKEN: process.env.PROD_VERIFY_TOKEN || '',` (near line 239) add:

```typescript
  DEV_QA_ROLE_ID: process.env.DEV_QA_ROLE_ID || '',
```

- [ ] **Step 2: Write the failing test** `backend/tests/qaAuthService.test.js`:

```javascript
const DEV_GUILD = 'dev-guild-1';
const QA_ROLE = 'qa-role-1';

const env = require('../src/config/environment');
env.DEV_GUILD_ID = DEV_GUILD;
env.DEV_QA_ROLE_ID = QA_ROLE;

const { verifyQaRole, checkQaAccess } = require('../src/services/qaAuthService');

function fakeDeps(rolesByGuild) {
  return { fetchGuildMemberRoles: async (guildId) => rolesByGuild[guildId] || [] };
}

describe('verifyQaRole (pure)', () => {
  test('has QA role -> authorized', () => {
    expect(verifyQaRole([QA_ROLE, 'x'], QA_ROLE)).toEqual({ authorized: true });
  });
  test('missing QA role -> denied with reason', () => {
    const r = verifyQaRole(['x'], QA_ROLE);
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/QA role/i);
  });
  test('missing role id (unconfigured) -> denied', () => {
    expect(verifyQaRole([QA_ROLE], '').authorized).toBe(false);
  });
  test('non-array roles -> denied (no throw)', () => {
    expect(verifyQaRole(undefined, QA_ROLE).authorized).toBe(false);
  });
});

describe('checkQaAccess (env + injected fakes)', () => {
  test('QA role present in dev guild -> authorized', async () => {
    const deps = fakeDeps({ [DEV_GUILD]: [QA_ROLE] });
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r).toEqual({ discordUserId: 'user-1', authorized: true });
  });
  test('QA role absent -> denied', async () => {
    const deps = fakeDeps({ [DEV_GUILD]: ['other'] });
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.discordUserId).toBe('user-1');
  });
  test('deps throw -> denied (fail closed)', async () => {
    const deps = { fetchGuildMemberRoles: async () => { throw new Error('discord down'); } };
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/membership/i);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && npm test -- qaAuthService.test.js`
Expected: FAIL — `Cannot find module '../src/services/qaAuthService'`.

- [ ] **Step 4: Implement** `backend/src/services/qaAuthService.ts`:

```typescript
import env from '../config/environment';
import type { DevAuthDeps } from './devAuthService';

/**
 * Pure QA-role check (dev guild only). Authorized iff the caller holds the
 * configured QA role ID. No network, no env access — deterministic.
 */
export function verifyQaRole(
  devMemberRoles: string[],
  qaRoleId: string,
): { authorized: boolean; reason?: string } {
  if (!qaRoleId) {
    return { authorized: false, reason: 'QA gate is not configured (missing QA role ID).' };
  }
  const has = Array.isArray(devMemberRoles) && devMemberRoles.includes(qaRoleId);
  return has ? { authorized: true } : { authorized: false, reason: 'Missing the QA role in the dev Discord.' };
}

export interface QaAccessResult {
  discordUserId: string;
  authorized: boolean;
  reason?: string;
}

/**
 * Reads the caller's roles in the DEV guild via the injected deps boundary and
 * applies verifyQaRole. The dev bot is in the dev guild, so the OAuth
 * guilds.members.read path (discordOAuthDeps) works here.
 */
export async function checkQaAccess(
  discordUserId: string,
  deps: DevAuthDeps,
  accessToken = '',
): Promise<QaAccessResult> {
  const devGuildId = env.DEV_GUILD_ID;
  const qaRoleId = env.DEV_QA_ROLE_ID;
  if (!devGuildId || !qaRoleId) {
    return { discordUserId, authorized: false, reason: 'QA gate is not configured (missing guild or role ID).' };
  }
  let roles: string[];
  try {
    roles = await deps.fetchGuildMemberRoles(devGuildId, discordUserId, accessToken);
  } catch (err) {
    return {
      discordUserId,
      authorized: false,
      reason: `Failed to read dev-guild membership: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { discordUserId, ...verifyQaRole(roles, qaRoleId) };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd backend && npm test -- qaAuthService.test.js`
Expected: PASS (all cases green).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/qaAuthService.ts backend/src/config/environment.ts backend/tests/qaAuthService.test.js
git commit -m "feat(qa): pure QA-role gate service + DEV_QA_ROLE_ID env"
```

---

## Task 2: Build-lock pure helpers (`buildLock.ts`) + `QA_ACTIVE_VERSION` / `QA_BUILD_LOCK` env

**Files:**
- Create: `backend/src/services/buildLock.ts`
- Modify: `backend/src/config/environment.ts` (add `QA_ACTIVE_VERSION`, `QA_BUILD_LOCK`)
- Test: `backend/tests/buildLock.test.js`

**Interfaces:**
- Produces:
  - `isBuildAllowed(clientVersion: string, activeVersion: string | null, lockEnabled: boolean): boolean`
  - `evaluateBuildGate(headers: Record<string, unknown>, activeVersion: string | null, lockEnabled: boolean): { allowed: boolean; clientVersion: string; reason?: string }`

- [ ] **Step 1: Add the env vars.** In `backend/src/config/environment.ts` interface (right after the `DEV_QA_ROLE_ID` line from Task 1):

```typescript
  // Golden-build version lock (dev-only). The single currently-active QA build
  // version, and the on/off switch for the lock.
  QA_ACTIVE_VERSION: string;
  QA_BUILD_LOCK: boolean;
```

In the parse block (after `DEV_QA_ROLE_ID: ...`):

```typescript
  QA_ACTIVE_VERSION: process.env.QA_ACTIVE_VERSION || '',
  QA_BUILD_LOCK: process.env.QA_BUILD_LOCK === 'true',
```

- [ ] **Step 2: Write the failing test** `backend/tests/buildLock.test.js`:

```javascript
const { isBuildAllowed, evaluateBuildGate } = require('../src/services/buildLock');

describe('isBuildAllowed', () => {
  test('lock disabled -> always allowed', () => {
    expect(isBuildAllowed('0.0.1', '9.9.9', false)).toBe(true);
    expect(isBuildAllowed('', '9.9.9', false)).toBe(true);
  });
  test('lock enabled but active unset -> fail open', () => {
    expect(isBuildAllowed('1.0.0', '', true)).toBe(true);
    expect(isBuildAllowed('1.0.0', null, true)).toBe(true);
  });
  test('lock enabled, exact match -> allowed', () => {
    expect(isBuildAllowed('1.4.0-qa', '1.4.0-qa', true)).toBe(true);
  });
  test('lock enabled, mismatch -> denied', () => {
    expect(isBuildAllowed('1.3.0-qa', '1.4.0-qa', true)).toBe(false);
  });
  test('lock enabled, missing client version -> denied', () => {
    expect(isBuildAllowed('', '1.4.0-qa', true)).toBe(false);
  });
});

describe('evaluateBuildGate', () => {
  test('reads x-client-version header (lowercase) and allows on match', () => {
    const r = evaluateBuildGate({ 'x-client-version': '1.4.0-qa' }, '1.4.0-qa', true);
    expect(r).toEqual({ allowed: true, clientVersion: '1.4.0-qa' });
  });
  test('denies on mismatch with a reason', () => {
    const r = evaluateBuildGate({ 'x-client-version': '1.3.0-qa' }, '1.4.0-qa', true);
    expect(r.allowed).toBe(false);
    expect(r.clientVersion).toBe('1.3.0-qa');
    expect(r.reason).toMatch(/1\.4\.0-qa/);
  });
  test('missing header -> clientVersion empty, denied when locked', () => {
    const r = evaluateBuildGate({}, '1.4.0-qa', true);
    expect(r.allowed).toBe(false);
    expect(r.clientVersion).toBe('');
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && npm test -- buildLock.test.js`
Expected: FAIL — `Cannot find module '../src/services/buildLock'`.

- [ ] **Step 4: Implement** `backend/src/services/buildLock.ts`:

```typescript
/**
 * Golden-build version lock (dev-only). The dev backend blesses exactly ONE
 * active QA build version; any build that does not report exactly that version
 * is rejected. Fail-OPEN when no active version is configured (so flipping the
 * lock on before setting a version cannot brick every tester); fail-CLOSED on
 * mismatch or a missing client version.
 */
export function isBuildAllowed(
  clientVersion: string,
  activeVersion: string | null,
  lockEnabled: boolean,
): boolean {
  if (!lockEnabled) return true;
  if (!activeVersion) return true; // misconfig safety: lock can't function without a target
  return clientVersion === activeVersion;
}

/**
 * Reads the `x-client-version` request header and evaluates the lock. Pure given
 * its inputs (pass the active version + flag in). Header keys are lowercased by
 * Node's http layer.
 */
export function evaluateBuildGate(
  headers: Record<string, unknown>,
  activeVersion: string | null,
  lockEnabled: boolean,
): { allowed: boolean; clientVersion: string; reason?: string } {
  const raw = headers['x-client-version'];
  const clientVersion = typeof raw === 'string' ? raw : '';
  const allowed = isBuildAllowed(clientVersion, activeVersion, lockEnabled);
  return allowed
    ? { allowed: true, clientVersion }
    : { allowed: false, clientVersion, reason: `Outdated build: v${clientVersion || 'unknown'} (active v${activeVersion}).` };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd backend && npm test -- buildLock.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/buildLock.ts backend/src/config/environment.ts backend/tests/buildLock.test.js
git commit -m "feat(qa): build-lock pure helpers + QA_ACTIVE_VERSION/QA_BUILD_LOCK env"
```

---

## Task 3: Active-QA-version store (`activeQaVersion.ts`, Redis-backed)

**Files:**
- Create: `backend/src/services/activeQaVersion.ts`
- Test: `backend/tests/activeQaVersion.test.js`

**Interfaces:**
- Consumes: `getRedisClient` from `backend/src/config/redis`; `env.QA_ACTIVE_VERSION`.
- Produces:
  - `getActiveQaVersion(): Promise<string | null>`
  - `setActiveQaVersion(version: string): Promise<void>`
  - `initActiveQaVersion(): Promise<void>` (seeds Redis from env on boot if unset)
  - Redis key constant: `qa:active-version`

- [ ] **Step 1: Write the failing test** `backend/tests/activeQaVersion.test.js`:

```javascript
jest.mock('../src/config/redis', () => {
  const store = {};
  return {
    __store: store,
    getRedisClient: async () => ({
      get: async (k) => (k in store ? store[k] : null),
      set: async (k, v) => { store[k] = v; },
    }),
  };
});

const redisMock = require('../src/config/redis');
const env = require('../src/config/environment');
const { getActiveQaVersion, setActiveQaVersion, initActiveQaVersion } = require('../src/services/activeQaVersion');

beforeEach(() => {
  for (const k of Object.keys(redisMock.__store)) delete redisMock.__store[k];
});

test('get returns null when unset', async () => {
  expect(await getActiveQaVersion()).toBeNull();
});

test('set then get round-trips', async () => {
  await setActiveQaVersion('1.4.0-qa');
  expect(await getActiveQaVersion()).toBe('1.4.0-qa');
});

test('init seeds from env when key is empty', async () => {
  env.QA_ACTIVE_VERSION = '1.4.0-qa';
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBe('1.4.0-qa');
});

test('init does NOT overwrite an existing key', async () => {
  env.QA_ACTIVE_VERSION = '1.4.0-qa';
  await setActiveQaVersion('1.5.0-qa');
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBe('1.5.0-qa');
});

test('init is a no-op when env is empty', async () => {
  env.QA_ACTIVE_VERSION = '';
  await initActiveQaVersion();
  expect(await getActiveQaVersion()).toBeNull();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && npm test -- activeQaVersion.test.js`
Expected: FAIL — `Cannot find module '../src/services/activeQaVersion'`.

- [ ] **Step 3: Implement** `backend/src/services/activeQaVersion.ts`:

```typescript
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import env from '../config/environment';

/** Redis key holding the single currently-active QA build version. */
const ACTIVE_QA_VERSION_KEY = 'qa:active-version';

/** Returns the active QA version, or null if none is set / Redis is unreachable. */
export async function getActiveQaVersion(): Promise<string | null> {
  try {
    const redis = await getRedisClient();
    return await redis.get(ACTIVE_QA_VERSION_KEY);
  } catch (err) {
    logger.warn({ err }, '[activeQaVersion] redis get failed (non-fatal)');
    return null;
  }
}

/** Sets the active QA version (called by the admin flip endpoint). */
export async function setActiveQaVersion(version: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(ACTIVE_QA_VERSION_KEY, version);
  logger.info({ version }, '[activeQaVersion] active QA build version set');
}

/**
 * Seeds Redis from QA_ACTIVE_VERSION at boot, but only if no value is already
 * stored (so a live flip survives a redeploy). No-op when the env is empty.
 */
export async function initActiveQaVersion(): Promise<void> {
  try {
    if (!env.QA_ACTIVE_VERSION) return;
    const redis = await getRedisClient();
    const existing = await redis.get(ACTIVE_QA_VERSION_KEY);
    if (!existing) {
      await redis.set(ACTIVE_QA_VERSION_KEY, env.QA_ACTIVE_VERSION);
      logger.info({ version: env.QA_ACTIVE_VERSION }, '[activeQaVersion] seeded from env');
    }
  } catch (err) {
    logger.warn({ err }, '[activeQaVersion] init failed (non-fatal)');
  }
}

export { ACTIVE_QA_VERSION_KEY };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd backend && npm test -- activeQaVersion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/activeQaVersion.ts backend/tests/activeQaVersion.test.js
git commit -m "feat(qa): Redis-backed active-QA-version store"
```

---

## Task 4: Admin flip endpoint `POST/GET /api/admin/qa/active-version`

**Files:**
- Create: `backend/src/controllers/qaVersionController.ts`
- Modify: `backend/src/server.ts` (new `if (env.NODE_ENV === 'development') { ... }` block — this same block is reused for the QA routes in Tasks 5 and 6; mount `initActiveQaVersion()` next to `initLatestVersion()` at boot)
- Test: `backend/tests/qaVersionController.test.js`

**Interfaces:**
- Consumes: `setActiveQaVersion`, `getActiveQaVersion` (Task 3); `requireAdminKey` (existing `backend/src/middleware/requireAdminKey`, already imported in `server.ts`).
- Produces: `setQaActiveVersion(req,res,next)`, `getQaActiveVersion(req,res,next)`.

- [ ] **Step 1: Write the failing test** `backend/tests/qaVersionController.test.js`:

```javascript
const express = require('express');
const request = require('supertest');

const setMock = jest.fn(async () => {});
const getMock = jest.fn(async () => '1.4.0-qa');
jest.mock('../src/services/activeQaVersion', () => ({
  setActiveQaVersion: (...a) => setMock(...a),
  getActiveQaVersion: (...a) => getMock(...a),
}));

const env = require('../src/config/environment');
env.ADMIN_API_KEY = 'test-admin-key';
const requireAdminKey = require('../src/middleware/requireAdminKey').default
  || require('../src/middleware/requireAdminKey');
const { setQaActiveVersion, getQaActiveVersion } = require('../src/controllers/qaVersionController');

function app() {
  const a = express();
  a.use(express.json());
  a.post('/api/admin/qa/active-version', requireAdminKey, setQaActiveVersion);
  a.get('/api/admin/qa/active-version', requireAdminKey, getQaActiveVersion);
  return a;
}

beforeEach(() => { setMock.mockClear(); getMock.mockClear(); });

test('POST without admin key -> 401', async () => {
  const res = await request(app()).post('/api/admin/qa/active-version').send({ version: '1.4.0-qa' });
  expect(res.status).toBe(401);
  expect(setMock).not.toHaveBeenCalled();
});

test('POST with key + version -> 200 and stores it', async () => {
  const res = await request(app())
    .post('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key')
    .send({ version: '1.4.0-qa' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { activeVersion: '1.4.0-qa' } });
  expect(setMock).toHaveBeenCalledWith('1.4.0-qa');
});

test('POST with key but no version -> 400', async () => {
  const res = await request(app())
    .post('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key')
    .send({});
  expect(res.status).toBe(400);
});

test('GET with key -> current active version', async () => {
  const res = await request(app())
    .get('/api/admin/qa/active-version')
    .set('x-admin-api-key', 'test-admin-key');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { activeVersion: '1.4.0-qa' } });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && npm test -- qaVersionController.test.js`
Expected: FAIL — `Cannot find module '../src/controllers/qaVersionController'`.

- [ ] **Step 3: Implement** `backend/src/controllers/qaVersionController.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { setActiveQaVersion, getActiveQaVersion } from '../services/activeQaVersion';

/** POST /api/admin/qa/active-version  { version } -> flip the active golden build. */
async function setQaActiveVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const version = String((req.body && req.body.version) || '').trim();
    if (!version) {
      res.status(400).json({ error: 'A non-empty `version` is required.' });
      return;
    }
    await setActiveQaVersion(version);
    res.json({ data: { activeVersion: version } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/qa/active-version -> the current active golden build version. */
async function getQaActiveVersion(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const activeVersion = await getActiveQaVersion();
    res.json({ data: { activeVersion } });
  } catch (err) {
    next(err);
  }
}

export { setQaActiveVersion, getQaActiveVersion };
module.exports = { setQaActiveVersion, getQaActiveVersion };
```

- [ ] **Step 4: Wire the route + boot init in `server.ts`.** First add the import near the other controller imports:

```typescript
import { setQaActiveVersion, getQaActiveVersion } from './controllers/qaVersionController';
import { initActiveQaVersion } from './services/activeQaVersion';
```

Add a NEW dev-only block (place it just after the existing `if (env.NODE_ENV === 'development' && env.ENABLE_DEV_LOGIN) { ... }` block ends, i.e. after line ~278). This block is gated on `NODE_ENV` ALONE so it is live on hosted dev (where `ENABLE_DEV_LOGIN=false`). Tasks 5 and 6 add more routes inside this SAME block:

```typescript
// QA-tester surface — live only on the dev backend (NODE_ENV=development),
// independent of ENABLE_DEV_LOGIN (hosted dev runs with it off). Never mounts in
// production. See docs/deployment/hosted-dev-environment.md (QA tester access).
if (env.NODE_ENV === 'development') {
  app.post('/api/admin/qa/active-version', apiLimiter, requireAdminKey, setQaActiveVersion);
  app.get('/api/admin/qa/active-version', apiLimiter, requireAdminKey, getQaActiveVersion);
  // (Task 5 adds /auth/discord/qa/start + /auth/discord/qa/callback here.)
  // (Task 6 adds GET /api/auth/qa-status/:installToken here.)
}
```

Then, where `initLatestVersion()` is awaited/called at boot, add alongside it:

```typescript
  await initActiveQaVersion();
```

- [ ] **Step 5: Run the controller test to confirm it passes**

Run: `cd backend && npm test -- qaVersionController.test.js`
Expected: PASS.

- [ ] **Step 6: Build to confirm the `server.ts` wiring type-checks**

Run: `cd backend && npm run build`
Expected: PASS (tsc clean).

- [ ] **Step 7: Commit**

```bash
git add backend/src/controllers/qaVersionController.ts backend/src/server.ts backend/tests/qaVersionController.test.js
git commit -m "feat(qa): admin endpoint to flip the active golden build version"
```

---

## Task 5: QA Discord-OAuth flow (start + callback, role-gated, mints a session)

**Files:**
- Create: `backend/src/controllers/qaOAuthController.ts`
- Modify: `backend/src/server.ts` (mount `/auth/discord/qa/start` + `/auth/discord/qa/callback` inside the Task 4 dev-only block; add `DISCORD_QA_REDIRECT_URI` env in `environment.ts`)
- Test: `backend/tests/qaOAuthController.test.js`

**Interfaces:**
- Consumes: `verifyQaRole` (Task 1); `getRedisClient`; `prisma`; `env`.
- Produces:
  - `qaStart(req,res)` — stores `qa_oauth_state:${state}` = installToken (300s) and redirects to Discord.
  - `QaCallbackDeps` interface + `makeQaCallbackHandler(deps): RequestHandler`.
  - `defaultQaCallbackDeps: QaCallbackDeps` (real wiring).
  - Redis grant key format: `qa_grant:${installToken}` → JSON `{ token, userId, displayName, role: 'user' }`, TTL 600s. (Consumed by Task 6.)

- [ ] **Step 1: Add the redirect-uri env.** In `environment.ts` interface (after `DEV_QA_ROLE_ID`):

```typescript
  // Optional explicit redirect URI for the QA OAuth callback; falls back to the
  // request's proto+host + /auth/discord/qa/callback when empty.
  DISCORD_QA_REDIRECT_URI: string;
```

Parse block:

```typescript
  DISCORD_QA_REDIRECT_URI: process.env.DISCORD_QA_REDIRECT_URI || '',
```

- [ ] **Step 2: Write the failing test** `backend/tests/qaOAuthController.test.js` (tests the callback decision logic via injected deps — authorized stores a grant + mints a session; unauthorized stores nothing):

```javascript
const express = require('express');
const request = require('supertest');

const env = require('../src/config/environment');
env.DEV_GUILD_ID = 'dev-guild-1';
env.DEV_QA_ROLE_ID = 'qa-role-1';

const { makeQaCallbackHandler } = require('../src/controllers/qaOAuthController');

function depsWith({ roles, installToken = 'inst-123' }) {
  const grants = {};
  const minted = [];
  return {
    grants,
    minted,
    impl: {
      consumeState: async () => installToken,
      exchangeCode: async () => ({ accessToken: 'access-tok' }),
      fetchIdentity: async () => ({ id: 'discord-1', username: 'Tester', global_name: 'Tester', avatar: null }),
      fetchDevGuildRoles: async () => roles,
      upsertUser: async (identity) => ({ id: 'user-1', displayName: identity.username }),
      mintSession: async (userId) => { const t = 'sess-' + userId; minted.push(t); return t; },
      storeGrant: async (it, grant) => { grants[it] = grant; },
    },
  };
}

function app(handler) {
  const a = express();
  a.get('/auth/discord/qa/callback', handler);
  return a;
}

test('user WITH the QA role -> session minted + grant stored + success page', async () => {
  const d = depsWith({ roles: ['qa-role-1'] });
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 's' });
  expect(res.status).toBe(200);
  expect(res.text).toMatch(/return to the app|QA access granted/i);
  expect(d.minted).toHaveLength(1);
  expect(d.grants['inst-123']).toMatchObject({ token: 'sess-user-1', role: 'user', displayName: 'Tester' });
});

test('user WITHOUT the QA role -> no grant, no session, denial page', async () => {
  const d = depsWith({ roles: ['other-role'] });
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 's' });
  expect(res.status).toBe(403);
  expect(res.text).toMatch(/QA role/i);
  expect(d.minted).toHaveLength(0);
  expect(d.grants['inst-123']).toBeUndefined();
});

test('invalid/expired state -> 400, nothing minted', async () => {
  const d = depsWith({ roles: ['qa-role-1'] });
  d.impl.consumeState = async () => null;
  const res = await request(app(makeQaCallbackHandler(d.impl)))
    .get('/auth/discord/qa/callback').query({ code: 'c', state: 'bad' });
  expect(res.status).toBe(400);
  expect(d.minted).toHaveLength(0);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && npm test -- qaOAuthController.test.js`
Expected: FAIL — `Cannot find module '../src/controllers/qaOAuthController'`.

- [ ] **Step 4: Implement** `backend/src/controllers/qaOAuthController.ts`:

```typescript
import { Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { verifyQaRole } from '../services/qaAuthService';

const STATE_TTL = 300; // 5 min
const GRANT_TTL = 600; // 10 min
const SESSION_TTL_SECONDS = 24 * 60 * 60;

function qaRedirectUri(req: Request): string {
  if (env.DISCORD_QA_REDIRECT_URI) return env.DISCORD_QA_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'dev.falloutchatmod.com';
  return `${proto}://${host}/auth/discord/qa/callback`;
}

/** GET /auth/discord/qa/start?installToken=... -> redirect to Discord OAuth. */
export async function qaStart(req: Request, res: Response): Promise<void> {
  const installToken = String(req.query.installToken || '');
  if (!installToken) { res.status(400).send('Missing installToken'); return; }
  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    await redis.set(`qa_oauth_state:${state}`, installToken, { EX: STATE_TTL });
  } catch (err) {
    logger.error({ err }, '[qa-oauth] failed to store state');
    res.status(500).send('Internal error');
    return;
  }
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: qaRedirectUri(req),
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
}

export interface QaIdentity { id: string; username: string; global_name?: string; avatar?: string | null; }

export interface QaCallbackDeps {
  consumeState(state: string): Promise<string | null>;          // -> installToken or null (one-time)
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchIdentity(accessToken: string): Promise<QaIdentity>;
  fetchDevGuildRoles(discordUserId: string, accessToken: string): Promise<string[]>;
  upsertUser(identity: QaIdentity, installToken: string): Promise<{ id: string; displayName: string }>;
  mintSession(userId: string): Promise<string>;                  // -> session token
  storeGrant(installToken: string, grant: { token: string; userId: string; displayName: string; role: string }): Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0b0f0b;color:#18FF62;padding:24px;line-height:1.5">` +
    `${body}</body>`;
}

/** GET /auth/discord/qa/callback — role-gate, mint a session, store the grant. */
export function makeQaCallbackHandler(deps: QaCallbackDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) { res.status(400).send(page('QA login', '<h3>Missing code/state.</h3>')); return; }

    const installToken = await deps.consumeState(state);
    if (!installToken) { res.status(400).send(page('QA login', '<h3>Login expired. Please try again from the app.</h3>')); return; }

    let accessToken: string;
    let identity: QaIdentity;
    let roles: string[];
    try {
      ({ accessToken } = await deps.exchangeCode(code, qaRedirectUri(req)));
      identity = await deps.fetchIdentity(accessToken);
      roles = await deps.fetchDevGuildRoles(identity.id, accessToken);
    } catch (err) {
      logger.warn({ err }, '[qa-oauth] callback discord exchange/lookup failed');
      res.status(502).send(page('QA login', '<h3>Could not reach Discord. Please try again.</h3>'));
      return;
    }

    const decision = verifyQaRole(roles, env.DEV_QA_ROLE_ID);
    if (!decision.authorized) {
      res.status(403).send(page('QA login',
        '<h3>Access denied</h3><p>You need the <strong>QA role</strong> in the FCM dev Discord. ' +
        'Ask a maintainer to grant it, then try again.</p>'));
      return;
    }

    let user: { id: string; displayName: string };
    let token: string;
    try {
      user = await deps.upsertUser(identity, installToken);
      token = await deps.mintSession(user.id);
      await deps.storeGrant(installToken, { token, userId: user.id, displayName: user.displayName, role: 'user' });
    } catch (err) {
      logger.error({ err }, '[qa-oauth] failed to issue QA session');
      res.status(500).send(page('QA login', '<h3>Could not create your session. Please try again.</h3>'));
      return;
    }

    res.status(200).send(page('QA access granted',
      '<h3>QA access granted</h3><p>You can close this window and return to the app.</p>'));
  };
}

/** Real deps wiring. */
export const defaultQaCallbackDeps: QaCallbackDeps = {
  async consumeState(state) {
    const redis = await getRedisClient();
    const it = await redis.get(`qa_oauth_state:${state}`);
    if (it) await redis.del(`qa_oauth_state:${state}`);
    return it;
  },
  async exchangeCode(code, redirectUri) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!r.ok) throw new Error(`token exchange HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string };
    return { accessToken: j.access_token };
  },
  async fetchIdentity(accessToken) {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`identity HTTP ${r.status}`);
    return (await r.json()) as QaIdentity;
  },
  async fetchDevGuildRoles(_discordUserId, accessToken) {
    const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${env.DEV_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`dev-guild member HTTP ${r.status}`);
    const m = (await r.json()) as { roles?: string[] };
    return Array.isArray(m.roles) ? m.roles : [];
  },
  async upsertUser(identity, installToken) {
    // Mirror the user upsert used by the dev login-as / link flow. Align field
    // names with prisma User (see backend/prisma/schema.prisma + the upsert in
    // server.ts `/api/dev/login-as`). discordId is @unique.
    const displayName = String(identity.global_name || identity.username).slice(0, 128);
    const user = await prisma.user.upsert({
      where: { discordId: identity.id },
      update: { discordUsername: identity.username, discordDisplayName: displayName, discordAvatar: identity.avatar ?? null },
      create: {
        discordId: identity.id,
        username: identity.username,
        discordUsername: identity.username,
        discordDisplayName: displayName,
        discordAvatar: identity.avatar ?? null,
        installToken,
      },
      select: { id: true, discordDisplayName: true, username: true },
    });
    return { id: user.id, displayName: user.discordDisplayName || user.username };
  },
  async mintSession(userId) {
    const token = uuidv4();
    const redis = await getRedisClient();
    await redis.set(`session:${token}`, userId, { EX: SESSION_TTL_SECONDS });
    prisma.session.create({ data: { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) } })
      .catch((err: Error) => logger.warn({ err }, '[qa-oauth] failed to persist session to DB'));
    return token;
  },
  async storeGrant(installToken, grant) {
    const redis = await getRedisClient();
    await redis.set(`qa_grant:${installToken}`, JSON.stringify(grant), { EX: GRANT_TTL });
  },
};
```

> Implementer note: confirm the `prisma.user.upsert` field set against the real `User` model and the existing `/api/dev/login-as` upsert in `server.ts` (~line 1490). If `User` has additional NOT NULL columns without defaults, add them to the `create` block to match that handler exactly.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd backend && npm test -- qaOAuthController.test.js`
Expected: PASS.

- [ ] **Step 6: Mount the routes in `server.ts`** (inside the Task 4 dev-only block). Add the import near other controllers:

```typescript
import { qaStart, makeQaCallbackHandler, defaultQaCallbackDeps } from './controllers/qaOAuthController';
```

Inside `if (env.NODE_ENV === 'development') { ... }` (where the Task-4 comment marks it):

```typescript
  app.get('/auth/discord/qa/start', authLimiter, qaStart);
  app.get('/auth/discord/qa/callback', authLimiter, makeQaCallbackHandler(defaultQaCallbackDeps));
```

- [ ] **Step 7: Build to confirm wiring type-checks**

Run: `cd backend && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/controllers/qaOAuthController.ts backend/src/server.ts backend/src/config/environment.ts backend/tests/qaOAuthController.test.js
git commit -m "feat(qa): dev-only QA Discord-OAuth flow that mints a role-gated session"
```

---

## Task 6: QA status poll endpoint (delivers the session, enforces the build lock)

**Files:**
- Create: `backend/src/controllers/qaStatusController.ts`
- Modify: `backend/src/server.ts` (mount `GET /api/auth/qa-status/:installToken` in the dev-only block)
- Test: `backend/tests/qaStatusController.test.js`

**Interfaces:**
- Consumes: `evaluateBuildGate` (Task 2); `getActiveQaVersion` (Task 3); `env.QA_BUILD_LOCK`; `getRedisClient`.
- Produces:
  - `QaStatusDeps` interface + `makeQaStatusHandler(deps): RequestHandler`.
  - `defaultQaStatusDeps`.
  - Response shapes: `426` when the build is stale; `{ data: { authorized: true, token, displayName, role } }` when a grant exists (one-time, then deleted); `{ data: { authorized: false } }` otherwise.

- [ ] **Step 1: Write the failing test** `backend/tests/qaStatusController.test.js`:

```javascript
const express = require('express');
const request = require('supertest');

const env = require('../src/config/environment');
env.QA_BUILD_LOCK = true;

const { makeQaStatusHandler } = require('../src/controllers/qaStatusController');

function depsWith({ active = '1.4.0-qa', grant = null }) {
  const deleted = [];
  return {
    deleted,
    impl: {
      getActiveQaVersion: async () => active,
      readGrant: async () => grant,
      deleteGrant: async (it) => { deleted.push(it); },
    },
  };
}

function app(handler) {
  const a = express();
  a.get('/api/auth/qa-status/:installToken', handler);
  return a;
}

test('stale build (version mismatch, lock on) -> 426', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: { token: 't', displayName: 'X', role: 'user' } });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.3.0-qa');
  expect(res.status).toBe(426);
  expect(d.deleted).toHaveLength(0); // grant preserved; user just needs to update
});

test('current build + grant present -> authorized with token, grant consumed', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: { token: 'sess-1', userId: 'u1', displayName: 'Tester', role: 'user' } });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.4.0-qa');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { authorized: true, token: 'sess-1', displayName: 'Tester', role: 'user' } });
  expect(d.deleted).toEqual(['inst-1']);
});

test('current build, no grant yet -> authorized:false', async () => {
  const d = depsWith({ active: '1.4.0-qa', grant: null });
  const res = await request(app(makeQaStatusHandler(d.impl)))
    .get('/api/auth/qa-status/inst-1').set('x-client-version', '1.4.0-qa');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: { authorized: false } });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && npm test -- qaStatusController.test.js`
Expected: FAIL — `Cannot find module '../src/controllers/qaStatusController'`.

- [ ] **Step 3: Implement** `backend/src/controllers/qaStatusController.ts`:

```typescript
import { Request, Response, RequestHandler } from 'express';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import env from '../config/environment';
import { evaluateBuildGate } from '../services/buildLock';
import { getActiveQaVersion } from '../services/activeQaVersion';

export interface QaGrant { token: string; userId: string; displayName: string; role: string; }

export interface QaStatusDeps {
  getActiveQaVersion(): Promise<string | null>;
  readGrant(installToken: string): Promise<QaGrant | null>;
  deleteGrant(installToken: string): Promise<void>;
}

/**
 * GET /api/auth/qa-status/:installToken — polled by the overlay after QA OAuth.
 * Enforces the golden-build lock (426 when stale), then hands back the session
 * grant exactly once.
 */
export function makeQaStatusHandler(deps: QaStatusDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const installToken = req.params.installToken;
    if (!installToken) { res.status(400).json({ data: { authorized: false } }); return; }

    const activeVersion = await deps.getActiveQaVersion();
    const gate = evaluateBuildGate(req.headers as Record<string, unknown>, activeVersion, env.QA_BUILD_LOCK);
    if (!gate.allowed) {
      res.status(426).json({
        error: 'OUTDATED_BUILD',
        detail: gate.reason,
        activeVersion,
      });
      return;
    }

    const grant = await deps.readGrant(installToken);
    if (!grant) { res.json({ data: { authorized: false } }); return; }
    await deps.deleteGrant(installToken);
    res.json({ data: { authorized: true, token: grant.token, displayName: grant.displayName, role: grant.role } });
  };
}

export const defaultQaStatusDeps: QaStatusDeps = {
  getActiveQaVersion,
  async readGrant(installToken) {
    try {
      const redis = await getRedisClient();
      const raw = await redis.get(`qa_grant:${installToken}`);
      return raw ? (JSON.parse(raw) as QaGrant) : null;
    } catch (err) {
      logger.warn({ err }, '[qa-status] readGrant failed');
      return null;
    }
  },
  async deleteGrant(installToken) {
    try {
      const redis = await getRedisClient();
      await redis.del(`qa_grant:${installToken}`);
    } catch (err) {
      logger.warn({ err }, '[qa-status] deleteGrant failed');
    }
  },
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd backend && npm test -- qaStatusController.test.js`
Expected: PASS.

- [ ] **Step 5: Mount the route in `server.ts`** (inside the dev-only block). Import:

```typescript
import { makeQaStatusHandler, defaultQaStatusDeps } from './controllers/qaStatusController';
```

Inside the dev-only block:

```typescript
  app.get('/api/auth/qa-status/:installToken', apiLimiter, makeQaStatusHandler(defaultQaStatusDeps));
```

- [ ] **Step 6: Build + commit**

Run: `cd backend && npm run build` (Expected: PASS), then:

```bash
git add backend/src/controllers/qaStatusController.ts backend/src/server.ts backend/tests/qaStatusController.test.js
git commit -m "feat(qa): QA status poll endpoint with golden-build lock (426)"
```

---

## Task 7: WebSocket version gate (close 4003 on stale build)

**Files:**
- Modify: `backend/src/websocket/handlers.ts` (add `WS_CLOSE_OUTDATED_BUILD = 4003` near line 185; insert the gate between the `app:update-available` send (~line 1402) and the `room:join` broadcast (~line 1404))
- Test: extend `backend/tests/buildLock.test.js` already covers `evaluateBuildGate`; add a focused gate-wiring assertion in a new `backend/tests/wsBuildGate.test.js` using `evaluateBuildGate` against a fake upgrade-request headers object.

**Interfaces:**
- Consumes: `evaluateBuildGate` (Task 2), `getActiveQaVersion` (Task 3), `env.QA_BUILD_LOCK`.

- [ ] **Step 1: Write the failing test** `backend/tests/wsBuildGate.test.js` (asserts the decision the handler will make from a real upgrade-request `headers` object — the same call the handler performs):

```javascript
const { evaluateBuildGate } = require('../src/services/buildLock');

// Simulates the handler's read of the WS upgrade request headers.
function gateFor(headers, active, lock) {
  return evaluateBuildGate(headers, active, lock);
}

test('lock on, stale WS client -> not allowed (handler will close 4003)', () => {
  const r = gateFor({ 'x-auth-token': 'abc', 'x-client-version': '1.3.0-qa' }, '1.4.0-qa', true);
  expect(r.allowed).toBe(false);
});

test('lock on, current WS client -> allowed', () => {
  const r = gateFor({ 'x-client-version': '1.4.0-qa' }, '1.4.0-qa', true);
  expect(r.allowed).toBe(true);
});

test('lock off -> allowed regardless (prod overlays unaffected)', () => {
  const r = gateFor({ 'x-client-version': '0.0.0' }, '1.4.0-qa', false);
  expect(r.allowed).toBe(true);
});
```

- [ ] **Step 2: Run it to confirm it passes already** (the helper exists from Task 2 — this test documents the WS gate contract):

Run: `cd backend && npm test -- wsBuildGate.test.js`
Expected: PASS. (This locks the contract before wiring the handler.)

- [ ] **Step 3: Add the close-code constant.** In `backend/src/websocket/handlers.ts` near line 185, after `const WS_CLOSE_BANNED = 4002;`:

```typescript
const WS_CLOSE_OUTDATED_BUILD = 4003;
```

- [ ] **Step 4: Add imports** near the top of `handlers.ts` (with the other service imports):

```typescript
import { evaluateBuildGate } from '../services/buildLock';
import { getActiveQaVersion } from '../services/activeQaVersion';
import env from '../config/environment';
```

(If `env` is already imported in this file, skip that line.)

- [ ] **Step 5: Insert the gate** in `handleConnection`, immediately AFTER the `app:update-available` try/catch block (~line 1402) and BEFORE `broadcast({ type: 'room:join', ... })` (~line 1404):

```typescript
  // Golden-build lock (dev-only): reject a stale QA build. No-op in prod, where
  // QA_BUILD_LOCK is unset. Fail-open when no active version is configured.
  if (env.QA_BUILD_LOCK) {
    const activeQaVersion = await getActiveQaVersion();
    const gate = evaluateBuildGate(req.headers as Record<string, unknown>, activeQaVersion, true);
    if (!gate.allowed) {
      logger.info({ userId: user.id, clientVersion: gate.clientVersion, activeQaVersion }, '[ws] rejecting outdated build');
      ws.close(WS_CLOSE_OUTDATED_BUILD, `OUTDATED_BUILD:${activeQaVersion || ''}`);
      clients.delete(token);
      return;
    }
  }
```

(Note: `clients.delete(token)` undoes the registration done a few lines above; confirm the client was registered before this point — it is, at ~line 1324.)

- [ ] **Step 6: Build to confirm it type-checks**

Run: `cd backend && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/websocket/handlers.ts backend/tests/wsBuildGate.test.js
git commit -m "feat(qa): WS handshake rejects stale builds with close 4003"
```

---

## Task 8: Overlay relay URLs become build-channel aware

**Files:**
- Modify: `cross-platform-overlay/overlay-core.js` (`resolveRelayUrls`)
- Modify: `cross-platform-overlay/main.js` (pass the channel; define `BUILD_CHANNEL` — full plumbing in Task 11, here just thread the arg)
- Test: extend `cross-platform-overlay/__tests__/overlay-core.test.js`

**Interfaces:**
- Produces: `resolveRelayUrls(env, channel?)` — when `channel === 'qa'`, defaults to the dev host; otherwise prod. Env overrides still win.

- [ ] **Step 1: Write the failing test** — append to `cross-platform-overlay/__tests__/overlay-core.test.js` (use the existing `core` import):

```javascript
describe('resolveRelayUrls (build channel)', () => {
  it('stable/undefined channel -> prod defaults', () => {
    expect(core.resolveRelayUrls({})).toEqual({
      relayHttp: 'https://falloutchatmod.com',
      relayWs: 'wss://falloutchatmod.com/ws',
    });
  });
  it('qa channel -> dev defaults', () => {
    expect(core.resolveRelayUrls({}, 'qa')).toEqual({
      relayHttp: 'https://dev.falloutchatmod.com',
      relayWs: 'wss://dev.falloutchatmod.com/ws',
    });
  });
  it('env override beats the channel default', () => {
    expect(core.resolveRelayUrls({ RELAY_HTTP: 'http://localhost:7177', RELAY_WS: 'ws://localhost:7177/ws' }, 'qa'))
      .toEqual({ relayHttp: 'http://localhost:7177', relayWs: 'ws://localhost:7177/ws' });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd cross-platform-overlay && npx vitest run __tests__/overlay-core.test.js`
Expected: FAIL — `qa channel -> dev defaults` returns prod URLs.

- [ ] **Step 3: Implement** — replace `resolveRelayUrls` in `cross-platform-overlay/overlay-core.js`:

```javascript
function resolveRelayUrls(env, channel) {
  if (channel === 'qa') {
    return {
      relayHttp: env.RELAY_HTTP || 'https://dev.falloutchatmod.com',
      relayWs:   env.RELAY_WS   || 'wss://dev.falloutchatmod.com/ws',
    };
  }
  return {
    relayHttp: env.RELAY_HTTP || 'https://falloutchatmod.com',
    relayWs:   env.RELAY_WS   || 'wss://falloutchatmod.com/ws',
  };
}
```

(Keep the existing exports; `resolveRelayUrls` is already exported.)

- [ ] **Step 4: Thread the channel in `main.js`** — at line ~467 change the call to pass the channel (the `BUILD_CHANNEL` constant is fully defined in Task 11; for now read it inline so this task is self-contained):

```javascript
const BUILD_CHANNEL = (() => {
  try { return require('./package.json').fcmChannel || process.env.BUILD_CHANNEL || 'stable'; }
  catch { return process.env.BUILD_CHANNEL || 'stable'; }
})();
const { relayHttp: RELAY_HTTP, relayWs: RELAY_WS } = overlayCore.resolveRelayUrls(process.env, BUILD_CHANNEL);
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd cross-platform-overlay && npx vitest run __tests__/overlay-core.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cross-platform-overlay/overlay-core.js cross-platform-overlay/main.js cross-platform-overlay/__tests__/overlay-core.test.js
git commit -m "feat(qa): build-channel-aware relay URL resolution (qa -> dev host)"
```

---

## Task 9: Overlay sends `X-Client-Version` on WS + HTTP

**Files:**
- Modify: `cross-platform-overlay/main.js` (WS headers ~line 1346; HTTP proxy headers ~line 1304)
- Test: create `cross-platform-overlay/__tests__/client-version-header.test.js` (source-assertion test, mirroring the `no-autoupdate.test.js` style)

**Interfaces:** none (header addition).

- [ ] **Step 1: Write the failing test** `cross-platform-overlay/__tests__/client-version-header.test.js`:

```javascript
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

describe('overlay transmits X-Client-Version', () => {
  it('sets X-Client-Version on the relay WebSocket', () => {
    // The WS headers block (openRelaySocket) must include the version header.
    const wsBlock = main.slice(main.indexOf('function openRelaySocket'), main.indexOf('function flushPendingWsOpens'));
    expect(wsBlock).toMatch(/'X-Client-Version':\s*APP_VERSION/);
  });
  it('sets X-Client-Version on proxied relay HTTP requests', () => {
    expect(main).toMatch(/outHeaders\['X-Client-Version'\]\s*=\s*APP_VERSION/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd cross-platform-overlay && npx vitest run __tests__/client-version-header.test.js`
Expected: FAIL (header not present yet).

- [ ] **Step 3: Implement — WS.** In `openRelaySocket` (`main.js` ~line 1346), add the header inside the `headers` object:

```javascript
  const sock = new WebSocket(RELAY_WS, {
    headers: {
      'X-Auth-Token': sessionToken,
      'X-Client-Version': APP_VERSION,
      'User-Agent': APP_UA,
      'Origin': RELAY_HTTP,
    },
  });
```

- [ ] **Step 4: Implement — HTTP.** In the `proxy:http` handler (`main.js` ~line 1304), right after the `X-Auth-Token` line:

```javascript
  if (sessionToken) outHeaders['X-Auth-Token'] = sessionToken;
  outHeaders['X-Client-Version'] = APP_VERSION;
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd cross-platform-overlay && npx vitest run __tests__/client-version-header.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cross-platform-overlay/main.js cross-platform-overlay/__tests__/client-version-header.test.js
git commit -m "feat(qa): overlay sends X-Client-Version on WS + HTTP"
```

---

## Task 10: Overlay handles WS close 4003 (outdated build)

**Files:**
- Modify: `cross-platform-overlay/main.js` (the `sock.on('close', ...)` handler in `openRelaySocket`, line ~1379; reuse `showUpdateNotification`)
- Test: extend `cross-platform-overlay/__tests__/client-version-header.test.js` (or a new `outdated-build.test.js`) with a source assertion.

**Interfaces:** none.

- [ ] **Step 1: Write the failing test** `cross-platform-overlay/__tests__/outdated-build.test.js`:

```javascript
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

describe('overlay reacts to WS close 4003 (outdated build)', () => {
  it('the WS close handler special-cases code 4003', () => {
    const closeBlock = main.slice(main.indexOf("sock.on('close'"), main.indexOf("sock.on('error'"));
    expect(closeBlock).toMatch(/4003/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd cross-platform-overlay && npx vitest run __tests__/outdated-build.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — replace the `sock.on('close', ...)` handler in `openRelaySocket` (`main.js` ~line 1379):

```javascript
  sock.on('close', (code, reason) => {
    relaySockets.delete(id);
    relaySendBuffers.delete(id);
    // Golden-build lock: the dev backend rejected this build as outdated. This is
    // terminal — do NOT auto-reconnect. Tell the user to grab the current QA build.
    if (code === 4003) {
      diag('[relay] WS closed 4003 OUTDATED_BUILD — prompting update');
      try { showUpdateNotification((reason && reason.toString().split(':')[1]) || ''); } catch { /* ignore */ }
      sendToRenderer('relay:status', { state: 'error', message: 'This QA build is no longer active. Download the current QA build from the dev Discord.' });
      sendToRenderer('proxy:ws:close', { id, code, reason: reason && reason.toString() });
      return;
    }
    sendToRenderer('proxy:ws:close', { id, code, reason: reason && reason.toString() });
  });
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd cross-platform-overlay && npx vitest run __tests__/outdated-build.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cross-platform-overlay/main.js cross-platform-overlay/__tests__/outdated-build.test.js
git commit -m "feat(qa): overlay handles WS 4003 outdated-build close"
```

---

## Task 11: QA build channel plumbing (`__BUILD_CHANNEL__`, `dist:qa`)

**Files:**
- Modify: `cross-platform-overlay/vite.config.ts` (add `__BUILD_CHANNEL__` define)
- Modify: `cross-platform-overlay/src/env.d.ts` (declare `__BUILD_CHANNEL__`)
- Modify: `cross-platform-overlay/package.json` (add a `dist:qa` script using electron-builder `extraMetadata.fcmChannel=qa`)
- Test: create `cross-platform-overlay/__tests__/qa-build-channel.test.js`

**Interfaces:**
- Produces: renderer constant `__BUILD_CHANNEL__`; package.json `fcmChannel` metadata in the QA artifact (read by `main.js` from Task 8).

- [ ] **Step 1: Write the failing test** `cross-platform-overlay/__tests__/qa-build-channel.test.js`:

```javascript
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('QA build channel plumbing', () => {
  it('vite.config defines __BUILD_CHANNEL__', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/__BUILD_CHANNEL__/);
  });
  it('env.d.ts declares __BUILD_CHANNEL__', () => {
    const env = readFileSync(join(ROOT, 'src', 'env.d.ts'), 'utf8');
    expect(env).toMatch(/__BUILD_CHANNEL__/);
  });
  it('package.json has a dist:qa script setting fcmChannel=qa', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dist:qa']).toBeDefined();
    expect(pkg.scripts['dist:qa']).toMatch(/extraMetadata\.fcmChannel=qa/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd cross-platform-overlay && npx vitest run __tests__/qa-build-channel.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the Vite define** — in `cross-platform-overlay/vite.config.ts`, extend the `define` block:

```typescript
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_CHANNEL__: JSON.stringify(process.env.BUILD_CHANNEL || 'stable'),
  },
```

- [ ] **Step 4: Declare it** — in `cross-platform-overlay/src/env.d.ts`, after the `__APP_VERSION__` declaration:

```typescript
// Defined by Vite (vite.config.ts `define`). 'stable' for the prod build, 'qa'
// for the golden dev build.
declare const __BUILD_CHANNEL__: string;
```

- [ ] **Step 5: Add the build script** — in `cross-platform-overlay/package.json` `scripts`, add a `dist:qa` that mirrors the existing dist script for the current platform but injects the channel into both the renderer build (env) and the packaged metadata (electron-builder). Model it on the existing `dist`/`dist:win`/`dist:linux` script (read the existing one and reuse its renderer-build + electron-builder invocation). Example shape:

```json
    "dist:qa": "cross-env BUILD_CHANNEL=qa npm run build:renderer && electron-builder -c.extraMetadata.fcmChannel=qa -c.productName=\"Fallout Chat Mod QA\""
```

> Implementer note: match the exact renderer-build step name and electron-builder flags used by the existing `dist` script in this package.json. If `cross-env` is not already a devDependency, set `BUILD_CHANNEL=qa` the way the existing scripts set env (they may use plain `VAR=... cmd`). Keep `appId` unchanged so QA + stable can coexist; `productName` "Fallout Chat Mod QA" gives a distinct install dir/shortcut.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd cross-platform-overlay && npx vitest run __tests__/qa-build-channel.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cross-platform-overlay/vite.config.ts cross-platform-overlay/src/env.d.ts cross-platform-overlay/package.json cross-platform-overlay/__tests__/qa-build-channel.test.js
git commit -m "feat(qa): QA build channel plumbing (__BUILD_CHANNEL__, dist:qa)"
```

---

## Task 12: Overlay QA login flow (OAuth window + poll + auto-start on qa channel)

**Files:**
- Modify: `cross-platform-overlay/main.js` (add `qaLogin()` BrowserWindow flow modeled on `discord:link` at line 1801; add `pollQaStatus()` modeled on `refreshDiscordStatus` at line 1900; on startup, when `BUILD_CHANNEL === 'qa'`, run the QA login instead of `startRelay()` — see the startup call at ~line 3475; add an `overlay:qa-login` IPC for manual retry)
- Modify: `cross-platform-overlay/preload.js` (expose `qaLogin()` for a renderer retry button)
- Test: create `cross-platform-overlay/__tests__/qa-login.test.js` (source assertions)

**Interfaces:**
- Consumes: backend `/auth/discord/qa/start` (Task 5), `/api/auth/qa-status/:installToken` (Task 6); existing `flushPendingWsOpens`, `saveState`, `rebuildTray`, `sendToRenderer`, `showUpdateNotification`.

- [ ] **Step 1: Write the failing test** `cross-platform-overlay/__tests__/qa-login.test.js`:

```javascript
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

describe('overlay QA login flow', () => {
  it('opens the QA OAuth start URL', () => {
    expect(main).toMatch(/\/auth\/discord\/qa\/start\?installToken=/);
  });
  it('polls the qa-status endpoint with the client version header', () => {
    expect(main).toMatch(/\/api\/auth\/qa-status\//);
    const pollRegion = main.slice(main.indexOf('qa-status/'), main.indexOf('qa-status/') + 800);
    expect(pollRegion).toMatch(/X-Client-Version/);
  });
  it('handles a 426 outdated-build response from the poll', () => {
    expect(main).toMatch(/426/);
  });
  it('auto-starts QA login on the qa channel', () => {
    expect(main).toMatch(/BUILD_CHANNEL === 'qa'/);
  });
  it('registers an overlay:qa-login IPC handler', () => {
    expect(main).toMatch(/ipcMain\.(on|handle)\('overlay:qa-login'/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd cross-platform-overlay && npx vitest run __tests__/qa-login.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the QA login flow** — add to `main.js` (place near the `discord:link` handler, ~line 1890). This reuses the `discord:link` BrowserWindow pattern and the `dev-login-as` token-store sequence:

```javascript
// ─── QA login (golden dev build) ──────────────────────────────────────────────
// Opens the QA Discord OAuth in a window, then polls /api/auth/qa-status until the
// backend hands back a role-gated session token (or 426 OUTDATED_BUILD).
function startQaLogin() {
  const st = loadState();
  if (!st || !st.installToken) return;
  const startUrl = `${RELAY_HTTP}/auth/discord/qa/start?installToken=${encodeURIComponent(st.installToken)}`;
  const callbackPath = '/auth/discord/qa/callback';
  sendToRenderer('relay:status', { state: 'qa_required' });

  let win = null;
  try {
    win = new BrowserWindow({
      width: 520, height: 720, parent: mainWindow || undefined, modal: false,
      title: 'QA Login — Fallout Chat Mod', icon: appIcon() || undefined, center: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
  } catch {
    try { shell.openExternal(startUrl); } catch { /* ignore */ }
    pollQaStatus(0);
    return;
  }
  const wc = win.webContents;
  const checkNav = (url) => {
    try {
      if (new URL(url).pathname === callbackPath) {
        setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 1200);
      }
    } catch { /* ignore */ }
  };
  wc.on('did-navigate', (_e, url) => checkNav(url));
  wc.on('will-redirect', (_e, url) => checkNav(url));
  wc.on('did-redirect-navigation', (_e, url) => checkNav(url));
  win.on('closed', () => { win = null; pollQaStatus(0); });
  win.loadURL(startUrl).catch(() => { try { shell.openExternal(startUrl); } catch { /* ignore */ } pollQaStatus(0); });
}

function pollQaStatus(attempt = 0) {
  const st = loadState();
  if (!st || !st.installToken) return;
  const MAX = 20;
  const url = new URL(`${RELAY_HTTP}/api/auth/qa-status/${encodeURIComponent(st.installToken)}`);
  const req = httpModule(url).request(
    { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Client-Version': APP_VERSION } },
    (res) => {
      if (res.statusCode === 426) {
        res.resume();
        diag('[qa-status] 426 OUTDATED_BUILD');
        try { showUpdateNotification(''); } catch { /* ignore */ }
        sendToRenderer('relay:status', { state: 'error', message: 'This QA build is no longer active. Download the current QA build from the dev Discord.' });
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let d = {};
        try { d = (JSON.parse(data).data) || {}; } catch { /* ignore */ }
        if (d.authorized && d.token) {
          sessionToken = d.token;
          flushPendingWsOpens();
          saveState({ discordLinked: true, displayName: d.displayName || '', userRole: d.role || null });
          userRole = d.role || null;
          rebuildTray();
          sendToRenderer('relay:status', { state: 'authenticated', displayName: d.displayName || '', discordLinked: true, role: d.role || null });
          return;
        }
        if (attempt + 1 < MAX) setTimeout(() => pollQaStatus(attempt + 1), 1500);
        else sendToRenderer('relay:status', { state: 'error', message: 'QA login timed out. Click to retry.' });
      });
    },
  );
  req.on('error', () => { if (attempt + 1 < MAX) setTimeout(() => pollQaStatus(attempt + 1), 1500); });
  req.setTimeout(12000, () => req.destroy(new Error('qa-status timeout')));
  req.end();
}

ipcMain.handle('overlay:qa-login', async () => { startQaLogin(); return { ok: true }; });
```

- [ ] **Step 4: Auto-start on the qa channel** — at the startup call site (`main.js` ~line 3475, where `startRelay();` runs), branch:

```javascript
    if (BUILD_CHANNEL === 'qa') {
      startQaLogin();
    } else {
      startRelay();
    }
```

- [ ] **Step 5: Expose the retry IPC** — in `cross-platform-overlay/preload.js`, add to the exposed API (mirror an existing `invoke` binding such as the dev-login one):

```javascript
  qaLogin: () => ipcRenderer.invoke('overlay:qa-login'),
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd cross-platform-overlay && npx vitest run __tests__/qa-login.test.js`
Expected: PASS.

- [ ] **Step 7: Manual smoke (local, optional but recommended).** With the local backend running in dev (`NODE_ENV=development`, `DEV_GUILD_ID`/`DEV_QA_ROLE_ID` set, your dev Discord account holding the QA role): build the renderer with `BUILD_CHANNEL=qa` and launch unpackaged pointing at the local backend; confirm the QA OAuth window opens, the role check passes, and chat connects. Then set `QA_BUILD_LOCK=true` + an active version different from the build and confirm the 426 path shows the update message.

- [ ] **Step 8: Commit**

```bash
git add cross-platform-overlay/main.js cross-platform-overlay/preload.js cross-platform-overlay/__tests__/qa-login.test.js
git commit -m "feat(qa): overlay QA login flow (OAuth window + status poll)"
```

---

## Task 13: Cloudflare Access path-bypass + documentation

**Files:**
- Modify: `docs/deployment/hosted-dev-environment.md` (QA tester access section: onboarding, CF path-bypass policy, env vars)
- Modify: `docs/overlay/README.md` (QA build channel, version lock, `X-Client-Version`, close 4003)
- Modify: `docs/realtime/README.md` (new `X-Client-Version` upgrade header + `4003 OUTDATED_BUILD` close code)
- Modify: `docs/backend/README.md` (new endpoints: QA OAuth start/callback, qa-status poll, admin active-version)
- Modify: `deploy/dev/.env.dev.example` (add the new env vars as placeholders)
- Test: none (docs + infra). Verified by review + the maintainer checklist.

- [ ] **Step 1: Document the CF Access path-bypass policy** in `docs/deployment/hosted-dev-environment.md` — add a "QA tester access" section stating:
  - On `dev.falloutchatmod.com`, add CF Access applications so the overlay surface is **Bypass** (no Access) while the human surface stays SSO-gated. CF evaluates the most-specific path first:
    - Bypass: `/ws`, `/auth/discord/qa/*`, `/api/auth/qa-status/*`, and the `/api/*` routes the overlay uses.
    - Keep SSO Access: `/api/admin/*`, `/api/internal/*`, and the dashboard web app (root + static).
  - Verify a WebSocket upgrade succeeds through the Access *bypass* application.
  - Note the security model: app-level QA-role gate + golden-build lock are the boundary on the bypassed surface; dev data is fake by construction.

- [ ] **Step 2: Document onboarding + env** in the same file:
  - Onboarding a QA tester: invite to the dev Discord, assign the `QA` role. Revoke = remove the role.
  - New dev env vars: `DEV_QA_ROLE_ID`, `QA_ACTIVE_VERSION`, `QA_BUILD_LOCK`, `DISCORD_QA_REDIRECT_URI` (+ register the QA callback redirect URI in the dev Discord app).
  - Flipping the golden build: `POST /api/admin/qa/active-version { version }` with `x-admin-api-key`.
  - Build delivery: post the `dist:qa` artifact to the existing dev Discord updates channel.

- [ ] **Step 3: Update `docs/realtime/README.md`** — add `X-Client-Version` (sent on the WS upgrade) and the `4003 OUTDATED_BUILD` close code to the protocol reference.

- [ ] **Step 4: Update `docs/overlay/README.md`** — document the `qa` build channel (`dist:qa`, dev URLs, `__BUILD_CHANNEL__`, QA login), `X-Client-Version`, and the 4003 update prompt.

- [ ] **Step 5: Update `docs/backend/README.md`** — list the new dev-only endpoints and that they are gated on `NODE_ENV==='development'`.

- [ ] **Step 6: Update `deploy/dev/.env.dev.example`** — add the four new vars as commented placeholders.

- [ ] **Step 7: Commit**

```bash
git add docs/deployment/hosted-dev-environment.md docs/overlay/README.md docs/realtime/README.md docs/backend/README.md deploy/dev/.env.dev.example
git commit -m "docs(qa): QA tester access, CF path-bypass, build lock, new endpoints"
```

---

## Task 14: Full-suite green + maintainer handoff checklist

**Files:** none (verification).

- [ ] **Step 1: Backend full suite**

Run: `cd backend && npm run build && npm test`
Expected: PASS (all suites, including the 6 new QA suites).

- [ ] **Step 2: Overlay full suite**

Run: `cd cross-platform-overlay && npm run test:unit`
Expected: PASS (all suites, including the 5 new QA suites).

- [ ] **Step 3: Lint/typecheck** (mirror the CI `lint-typecheck` job command for backend + overlay).

Expected: PASS.

- [ ] **Step 4: Record the maintainer (manual, non-code) checklist** in the PR description:
  1. Create the `QA` role in the dev Discord; set `DEV_QA_ROLE_ID` in the `fcm-dev` Dokploy env.
  2. Register the QA OAuth redirect URI (`https://dev.falloutchatmod.com/auth/discord/qa/callback`) in the dev Discord app; set `DISCORD_QA_REDIRECT_URI`.
  3. Add the CF Access path-bypass policy (Task 13 Step 1).
  4. Set `QA_BUILD_LOCK=true` and `QA_ACTIVE_VERSION` in the dev env; or flip live via the admin endpoint after the first QA build.
  5. Build with `npm run dist:qa`; post the artifact to the dev Discord updates channel; flip the active version to match.

- [ ] **Step 5: Open the PR** against `dev` (after rebasing onto fresh `origin/dev`). Add `ci-approved` to run CI.

---

## Self-Review (completed by plan author)

- **Spec coverage:** D1 QA OAuth gate → Tasks 1, 5, 6. D2 version-string lock → Tasks 2, 3, 7 (+426 in 6). D3 CF path-bypass → Task 13. D4 QA role dev-guild-only → Task 1 (`checkQaAccess` reads `DEV_GUILD_ID` only). D5 admin flip endpoint → Task 4. D6 dev-Discord-updates delivery → Tasks 11 (artifact) + 13 (docs). Overlay golden build → Tasks 8–12. Tests + CI → every task; full-suite gate → Task 14. Docs → Task 13 + folded notes. All spec sections map to a task.
- **Placeholder scan:** No "TBD"/"handle errors"/"write tests for the above". The two implementer notes (User upsert fields in Task 5; exact `dist` script shape in Task 11) point at specific existing code to mirror, with concrete starting code given — they are alignment checks against real files, not missing content.
- **Type consistency:** `verifyQaRole(roles, qaRoleId)` and `checkQaAccess(...)` consistent across Tasks 1/5. `isBuildAllowed`/`evaluateBuildGate` signatures consistent across Tasks 2/6/7. `QaGrant` shape `{ token, userId, displayName, role }` consistent between the grant written in Task 5 (`storeGrant`) and read in Task 6 (`readGrant`/response). `resolveRelayUrls(env, channel)` consistent across Tasks 8/12. Redis keys consistent: `qa_oauth_state:`, `qa_grant:`, `qa:active-version`, `session:`. Close code `4003`/`WS_CLOSE_OUTDATED_BUILD` consistent across Tasks 7/10.
