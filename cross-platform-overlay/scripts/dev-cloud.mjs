#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildHostedDevEnvironment,
  findHostedDevSecret,
} from './hosted-dev-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronCommand = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const defaultUserDataDir = path.join(homedir(), '.fcm', 'hosted-dev');
const userDataDir = process.env.FCM_DEV_USER_DATA_DIR || defaultUserDataDir;

function lookupSecret(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function stopChild(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch { /* best effort */ }
}

async function waitForRenderer(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch { /* Vite is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const secret = findHostedDevSecret(process.env, process.platform, lookupSecret);
if (!secret) {
  console.error('Hosted Dev login key is not available.');
  console.error('Linux/macOS: store it once in the OS keyring; see cross-platform-overlay/README.md.');
  console.error('CI/Windows: set DEV_PERSONA_LOGIN_SECRET in the process environment.');
  process.exit(1);
}

if (!existsSync(electronCommand)) {
  console.error(`Electron binary not found at ${electronCommand}. Run npm install first.`);
  process.exit(1);
}

const electronEnv = buildHostedDevEnvironment(process.env, secret, userDataDir);
const rendererEnv = { ...electronEnv };
delete rendererEnv.DEV_PERSONA_LOGIN_SECRET;

console.log(`[dev:cloud] hosted Dev relay: ${electronEnv.RELAY_HTTP}`);
console.log(`[dev:cloud] isolated user data: ${userDataDir}`);

const renderer = spawn(npmCommand, ['run', 'dev:renderer'], {
  cwd: root,
  env: rendererEnv,
  stdio: 'inherit',
});

let shuttingDown = false;
let electron = null;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(renderer);
  stopChild(electron);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const rendererReady = await waitForRenderer('http://localhost:5290', renderer);
if (!rendererReady) {
  console.error('[dev:cloud] renderer did not become ready on http://localhost:5290');
  shutdown();
  process.exit(1);
}

const electronArgs = [`--user-data-dir=${userDataDir}`, '.', ...process.argv.slice(2)];
electron = spawn(electronCommand, electronArgs, {
  cwd: root,
  env: electronEnv,
  stdio: 'inherit',
});

const exitCode = await new Promise((resolve) => {
  electron.once('error', (error) => {
    console.error(`[dev:cloud] Electron failed to start: ${error.message}`);
    resolve(1);
  });
  electron.once('exit', (code) => resolve(code ?? 1));
  renderer.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev:cloud] renderer exited unexpectedly (${code ?? 'signal'})`);
      resolve(code ?? 1);
    }
  });
});

shutdown();
process.exitCode = exitCode;
