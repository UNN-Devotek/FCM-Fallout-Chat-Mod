const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { validateDefinition } = require('../../deploy/return-mothership/validate-definition.cjs');

const directory = path.resolve(__dirname, '../../deploy/return-mothership');
const example = Object.fromEntries(fs.readFileSync(path.join(directory, '.env.example'), 'utf8')
  .split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
example.FCM_BACKEND_IMAGE = `sha256:${'a'.repeat(64)}`;
example.ORIGIN_PORT = '17676';

function definition() {
  const source = fs.readFileSync(path.join(directory, 'docker-compose.yml'), 'utf8')
    .replace(/\$\{([A-Z_]+):\?[^}]+\}/g, (_, key) => example[key]);
  return yaml.safeLoad(source);
}

describe('Mothership production definition', () => {
  test('the checked-in definition satisfies the production isolation contract', () => {
    expect(validateDefinition(definition())).toEqual([]);
  });
  test('accepts Compose normalization of defaults and the shutdown duration', () => {
    const config = definition();
    for (const service of Object.values(config.services)) delete service.env_file[0].required;
    config.services.backend.stop_grace_period = '3m0s';
    expect(validateDefinition(config)).toEqual([]);
  });
  test.each([
    ['mutable backend tag', c => { c.services.backend.image = 'fcm-backend:prod'; }],
    ['different dependency image', c => { c.services.postgres.image = `sha256:${'b'.repeat(64)}`; }],
    ['implicit image pull', c => { delete c.services.redis.pull_policy; }],
    ['checkout build', c => { c.services.backend.build = '.'; }],
    ['historical production volume', c => { c.volumes.postgres_data.name = 'chat-mod-fallout-chat-mod-dprwq2_postgres_data'; }],
    ['implicit empty volume creation', c => { delete c.volumes.minio_data.external; }],
    ['foreign volume attachment', c => { c.services.backend.volumes_from = ['old-backend']; }],
    ['public database port', c => { c.services.postgres.ports = [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }]; }],
    ['public backend bypass', c => { c.services.backend.ports[0].host_ip = '0.0.0.0'; }],
    ['database on ingress network', c => { c.services.postgres.networks.app = {}; }],
    ['shared data network', c => { c.networks.data.external = true; }],
    ['wrong tunnel origin', c => { c.services.backend.networks.app.aliases = ['backend']; }],
    ['unconditional connector', c => { delete c.services.cloudflared.profiles; }],
    ['connector credentials in backend', c => { c.services.backend.env_file.push(c.services.cloudflared.env_file[0]); }],
    ['optional runtime secret file', c => { c.services.backend.env_file[0].required = false; }],
    ['interpolated secret-file parsing', c => { delete c.services.backend.env_file[0].format; }],
    ['inline connector credentials in backend', c => { c.services.backend.environment.TUNNEL_TOKEN = 'fixture-only'; }],
    ['foreign database URL override', c => { c.services.backend.environment.DATABASE_URL = 'postgresql://old-db/fixture'; }],
    ['startup fence bypass', c => { c.services.backend.entrypoint = ['node', 'dist/server.js']; }],
    ['backend command override', c => { c.services.backend.command = ['node', 'dist/server.js']; }],
    ['missing persistent freeze', c => { c.services.backend.volumes.splice(1, 1); }],
    ['implicit control directory creation', c => { c.services.backend.volumes[1].bind.create_host_path = true; }],
    ['readonly drain checkpoint directory', c => { c.services.backend.volumes[1].read_only = true; }],
    ['missing release metadata', c => { c.services.backend.volumes.splice(2, 1); }],
    ['short shutdown grace', c => { c.services.backend.stop_grace_period = '10s'; }],
    ['extra writer service', c => { c.services.worker = { ...c.services.backend }; }],
    ['host networking', c => { c.services.cloudflared.network_mode = 'host'; }],
    ['foreign store host override', c => { c.services.backend.extra_hosts = { postgres: '192.0.2.1', redis: '192.0.2.2', 'minio-internal': '192.0.2.3' }; }],
    ['foreign origin host override', c => { c.services.cloudflared.extra_hosts = { 'chat-mod-fallout-chat-mod-dprwq2-backend-1': '192.0.2.4' }; }],
  ])('rejects %s', (_, mutate) => {
    const config = definition();
    mutate(config);
    expect(validateDefinition(config).length).toBeGreaterThan(0);
  });
});
