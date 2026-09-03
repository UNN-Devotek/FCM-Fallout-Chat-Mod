import { describe, expect, it } from 'vitest';
import {
  buildHostedDevEnvironment,
  findHostedDevSecret,
  HOSTED_DEV_HTTP,
  HOSTED_DEV_WS,
} from '../scripts/hosted-dev-config.mjs';

describe('hosted Dev launcher configuration', () => {
  it('prefers an explicit secret without consulting the keyring', () => {
    let lookedUp = false;
    const secret = findHostedDevSecret(
      { DEV_PERSONA_LOGIN_SECRET: '  from-env  ' },
      'linux',
      () => { lookedUp = true; return 'from-keyring'; },
    );
    expect(secret).toBe('from-env');
    expect(lookedUp).toBe(false);
  });

  it('loads the Linux keyring entry when no environment secret is set', () => {
    const secret = findHostedDevSecret({}, 'linux', (command, args) => {
      expect(command).toBe('secret-tool');
      expect(args).toEqual(['lookup', 'service', 'fcm-overlay', 'environment', 'dev']);
      return 'from-keyring\n';
    });
    expect(secret).toBe('from-keyring');
  });

  it('does not attempt a keyring lookup on unsupported platforms', () => {
    expect(findHostedDevSecret({}, 'win32', () => 'unexpected')).toBe('');
  });

  it('builds a hosted-Dev environment and removes Electron-as-Node leakage', () => {
    const env = buildHostedDevEnvironment(
      { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'development' },
      'secret',
      '/tmp/fcm-hosted-dev',
    );
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      RENDERER_URL: 'http://localhost:5290',
      RELAY_HTTP: HOSTED_DEV_HTTP,
      RELAY_WS: HOSTED_DEV_WS,
      DEV_PERSONA_LOGIN_SECRET: 'secret',
      FCM_DEV_USER_DATA_DIR: '/tmp/fcm-hosted-dev',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
