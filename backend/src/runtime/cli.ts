import { createConnection } from 'node:net';
import env from '../config/environment';
import { runtimeControlDirectory, runtimeControlEndpoint, runtimeControlToken } from './platform';

const action = process.argv[2] ?? 'status';
if (!['status', 'freeze', 'drain', 'shutdown'].includes(action)) throw new Error('Use status, freeze, drain, or shutdown');
const directory = runtimeControlDirectory(env.FCM_RUNTIME_CONTROL_DIR, env.NODE_ENV);
const token = runtimeControlToken(directory);
const socket = createConnection(runtimeControlEndpoint(directory));
let body = '';
socket.on('connect', () => socket.write(`${JSON.stringify({ action, ...(token ? { token } : {}) })}\n`));
socket.on('data', chunk => { body += chunk.toString(); });
socket.on('end', () => {
  process.stdout.write(body);
  let result: unknown;
  try { result = JSON.parse(body); } catch { process.exitCode = 1; return; }
  if (!result || typeof result !== 'object' || 'error' in result) { process.exitCode = 1; return; }
  if (action === 'freeze' && (!('operatorMarkerPersisted' in result) || result.operatorMarkerPersisted !== true
    || !('fences' in result) || !Array.isArray(result.fences) || !result.fences.includes('maintenance.json'))) process.exitCode = 1;
  if (action === 'shutdown' && (!('phase' in result) || result.phase !== 'closed'
    || !('ingressClosed' in result) || result.ingressClosed !== true)) process.exitCode = 1;
  if (action === 'drain' && (!('phase' in result) || !['drained', 'closed'].includes(String(result.phase)))) process.exitCode = 1;
  if (action !== 'status' && 'failures' in result && (!Array.isArray(result.failures) || result.failures.length > 0)) process.exitCode = 1;
});
socket.on('error', err => { process.stderr.write(`${err.message}\n`); process.exitCode = 1; });
