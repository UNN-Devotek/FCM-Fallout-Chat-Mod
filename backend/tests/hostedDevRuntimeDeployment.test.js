const fs = require('node:fs'); const path = require('node:path'); const yaml = require('js-yaml');
const filename = path.resolve(__dirname, '../../deploy/dev/docker-compose.yml');
function render() { return yaml.safeLoad(fs.readFileSync(filename, 'utf8').replace(/\$\{([A-Z_]+)(?::[-?][^}]*)?\}/g, (_, key) => `fixture-${key.toLowerCase()}`)); }
test('hosted Dev keeps restart fences and accepted-effect journals across container replacement within its own stack', () => {
  const config = render(), backend = config.services['backend-dev'];
  expect(backend.environment.FCM_RUNTIME_CONTROL_DIR).toBe('/app/runtime-control');
  expect(Number(backend.environment.FCM_DRAIN_TIMEOUT_MS)).toBe(120000); expect(backend.stop_grace_period).toBe('180s');
  expect(backend.volumes).toContain('runtime_dev_control:/app/runtime-control'); expect(config.volumes).toHaveProperty('runtime_dev_control');
  expect(backend.volumes).toContain('releases_dev_downloads:/app/downloads');
  expect(Object.keys(config.services)).toEqual(['postgres-dev','redis-dev','minio-dev','backend-dev','cloudflared-dev']);
  expect(Object.keys(config.volumes)).toEqual(['postgres_dev_data','redis_dev_data','minio_dev_data','releases_dev_downloads','runtime_dev_control']);
  for (const service of Object.values(config.services)) { expect(service.ports).toBeUndefined(); expect(service.mem_limit).toBeDefined(); expect(service.cpus).toBeDefined(); }
  expect(config.services['postgres-dev'].volumes).toEqual(['postgres_dev_data:/var/lib/postgresql/data']);
  expect(config.services['redis-dev'].volumes).toEqual(['redis_dev_data:/data']); expect(config.services['minio-dev'].volumes).toEqual(['minio_dev_data:/data']);
  expect(backend.networks).toEqual(['fcm-dev-network']); expect(config.services['cloudflared-dev'].networks).toEqual(['fcm-dev-network']);
  expect(config.networks['fcm-dev-network'].external).toBeUndefined(); expect(config.volumes.runtime_dev_control).toBeNull();
  expect(backend.cap_drop).toEqual(['ALL']); expect(backend.security_opt).toEqual(['no-new-privileges:true']);
});
