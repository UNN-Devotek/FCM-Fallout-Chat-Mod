#!/usr/bin/env node

export const HOSTED_DEV_HTTP = 'https://dev.falloutchatmod.com';
export const HOSTED_DEV_WS = 'wss://dev.falloutchatmod.com/ws';
export const DEV_SECRET_KEYRING = Object.freeze({
  service: 'fcm-overlay',
  environment: 'dev',
});

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the hosted-Dev persona key without ever putting it in the repo.
 * An explicit environment variable remains useful for CI/Windows; Linux and
 * macOS developers can persist it in their native desktop keyring instead.
 */
export function findHostedDevSecret(env = {}, platform = process.platform, lookup = () => '') {
  const fromEnv = normalizeSecret(env.DEV_PERSONA_LOGIN_SECRET);
  if (fromEnv) return fromEnv;

  const keyring = platform === 'linux'
    ? { command: 'secret-tool', args: ['lookup', 'service', DEV_SECRET_KEYRING.service, 'environment', DEV_SECRET_KEYRING.environment] }
    : platform === 'darwin'
      ? { command: 'security', args: ['find-generic-password', '-a', DEV_SECRET_KEYRING.service, '-s', 'fcm-hosted-dev-persona', '-w'] }
      : null;

  if (!keyring) return '';
  try {
    return normalizeSecret(lookup(keyring.command, keyring.args));
  } catch {
    return '';
  }
}

export function buildHostedDevEnvironment(baseEnv = {}, secret, userDataDir) {
  const normalized = normalizeSecret(secret);
  if (!normalized) {
    throw new Error(
      'Hosted Dev persona login needs DEV_PERSONA_LOGIN_SECRET or the configured OS keyring entry',
    );
  }

  const env = {
    ...baseEnv,
    RENDERER_URL: 'http://localhost:5290',
    RELAY_HTTP: HOSTED_DEV_HTTP,
    RELAY_WS: HOSTED_DEV_WS,
    DEV_PERSONA_LOGIN_SECRET: normalized,
  };
  // Electron inherits this flag in some shells and then runs its main script
  // as Node instead of starting the desktop application.
  delete env.ELECTRON_RUN_AS_NODE;
  if (userDataDir) env.FCM_DEV_USER_DATA_DIR = userDataDir;
  return env;
}
