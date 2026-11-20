#!/usr/bin/env node
'use strict';

// Validate `docker compose config --format json --no-env-resolution` without
// printing environment values. This is a definition check, not live acceptance.
const PROJECT = 'chat-mod-fallout-chat-mod-dprwq2';
const ROOT = '/home/devotek/fcm-return-mothership-20261013';
const PREFIX = 'fcm-return-prod-20261013';
const IDS = {
  postgres: 'sha256:c648923b3dfaf480613614622fcc5b15c5aa5d70c51b41f859e3da00dd522b3c',
  redis: 'sha256:5509c0097c6064aa8a3b1df58f1d950e67090fffa6678ae8f3f1dc2385f12deb',
  minio: 'sha256:69b2ec208575b69597784255eec6fa6a2985ee9e1a47f4411a51f7f5fdd193a9',
  cloudflared: 'sha256:97db6eb4ae40bde4fa6dda97c0dd0471bb6e64fb33989f5f30f062b03bc93da7',
};

function validateDefinition(config) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(config?.name === PROJECT, 'Wrong production project identity');
  const services = config?.services ?? {};
  check(Object.keys(services).sort().join(',') === 'backend,cloudflared,minio,postgres,redis',
    'Unexpected or missing service');
  for (const [name, service] of Object.entries(services)) {
    check(typeof service.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(service.image),
      `${name}: image must be an immutable local config ID`);
    if (IDS[name]) check(service.image === IDS[name], `${name}: source image mismatch`);
    check(service.pull_policy === 'never' && !service.build, `${name}: pull/build forbidden`);
    check(!service.privileged && !service.network_mode && !service.container_name,
      `${name}: unsafe identity/network override`);
    check(!Object.keys(service.extra_hosts ?? {}).length, `${name}: host resolution overrides forbidden`);
    check(!service.volumes_from && !service.external_links, `${name}: foreign storage/network attachment`);
    check(!service.entrypoint && (name !== 'backend' || !service.command),
      `${name}: startup override forbidden`);
    const environmentFile = name === 'backend' ? 'runtime' : name === 'cloudflared' ? 'edge' : name;
    const files = service.env_file ?? [];
    check(files.length === 1 && files[0].path === `${ROOT}/config/${environmentFile}.env`
      && files[0].required !== false && files[0].format === 'raw', `${name}: wrong secret-file scope/format`);
    if (name !== 'backend') check(!service.ports?.length, `${name}: published port forbidden`);
  }
  const networks = config?.networks ?? {};
  check(Object.keys(networks).sort().join(',') === 'app,data'
    && networks.data?.internal === true && !networks.data?.external
    && networks.data?.name === `${PREFIX}-data`
    && !networks.app?.external && networks.app?.name === `${PREFIX}-app`,
  'Networks must be private, dedicated and stable');
  for (const name of ['postgres', 'redis', 'minio']) {
    check(Object.keys(services[name]?.networks ?? {}).join(',') === 'data',
      `${name}: data network only`);
  }
  check(Object.keys(services.cloudflared?.networks ?? {}).join(',') === 'app',
    'Connector must use only the app network');
  check(services.cloudflared?.profiles?.join(',') === 'edge', 'Connector must require the edge profile');
  const backend = services.backend ?? {};
  const expectedEnvironment = {
    NODE_ENV: 'production', PORT: '7676', DB_HOST: 'postgres', DB_PORT: '5432',
    REDIS_HOST: 'redis', REDIS_PORT: '6379', MINIO_ENDPOINT: 'http://minio-internal:9700',
    TRUST_PROXY: 'true', FCM_RUNTIME_CONTROL_DIR: '/app/runtime-control', FCM_DRAIN_TIMEOUT_MS: '120000',
  };
  check(Object.keys(backend.environment ?? {}).sort().join(',') === Object.keys(expectedEnvironment).sort().join(',')
    && Object.entries(expectedEnvironment).every(([key, value]) => String(backend.environment?.[key]) === value),
  'Backend inline environment must retain the reviewed private runtime settings');
  for (const name of ['postgres', 'redis', 'minio', 'cloudflared']) {
    check(!Object.keys(services[name]?.environment ?? {}).length, `${name}: inline secret/runtime overrides forbidden`);
  }
  check(Object.keys(backend.networks ?? {}).sort().join(',') === 'app,data'
    && backend.networks?.app?.aliases?.includes(`${PROJECT}-backend-1`),
  'Backend must retain the named tunnel origin alias');
  check(backend.ports?.length === 1 && backend.ports[0].host_ip === '127.0.0.1'
    && Number(backend.ports[0].target) === 7676
    && Number(backend.ports[0].published) >= 1024 && Number(backend.ports[0].published) <= 65535,
  'Backend origin must use one explicit loopback port');
  check(backend.stop_grace_period === '3m0s' || backend.stop_grace_period === '180s',
    'Backend must allow the rehearsed drain grace period');
  check(backend.environment?.FCM_RUNTIME_CONTROL_DIR === '/app/runtime-control'
    && String(backend.environment?.FCM_DRAIN_TIMEOUT_MS) === '120000',
  'Backend must enable the persistent drain controller');
  const expectedVolumes = {
    postgres_data: ['postgres', '/var/lib/postgresql/data', 'postgres'],
    redis_data: ['redis', '/data', 'redis'],
    minio_data: ['minio', '/data', 'minio'],
    releases_downloads: ['backend', '/app/downloads', 'downloads'],
  };
  check(Object.keys(config?.volumes ?? {}).sort().join(',') === Object.keys(expectedVolumes).sort().join(','),
    'Unexpected or missing production volume');
  for (const [key, [service, target, suffix]] of Object.entries(expectedVolumes)) {
    check(config.volumes?.[key]?.external === true && config.volumes[key].name === `${PREFIX}-${suffix}`,
      `${key}: explicit restored external volume required`);
    check(services[service]?.volumes?.some(v => v.type === 'volume' && v.source === key
      && v.target === target && !v.read_only), `${key}: incorrect service mount`);
  }
  for (const [target, source] of [
    ['/app/runtime-control', `${ROOT}/runtime-control`],
    ['/app/releases.json', `${ROOT}/config/releases.json`],
  ]) {
    check(backend.volumes?.some(v => v.type === 'bind' && v.target === target
      && v.source === source && !v.read_only && v.bind?.create_host_path === false),
    `${target}: existing writable persistent bind required`);
  }
  check((backend.volumes?.length ?? 0) === 3, 'Backend has unexpected storage mounts');
  for (const name of ['postgres', 'redis', 'minio']) {
    check(services[name]?.volumes?.length === 1, `${name}: unexpected storage mount`);
  }
  check(!services.cloudflared?.volumes?.length, 'Connector must not mount production storage');
  return errors;
}

module.exports = { validateDefinition };
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    let errors;
    try { errors = validateDefinition(JSON.parse(input)); }
    catch { errors = ['Invalid or incomplete Compose JSON']; }
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else console.log('Production definition checks passed; live readiness is separate.');
  });
}
