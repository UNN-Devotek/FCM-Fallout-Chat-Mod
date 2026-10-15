import { safeDiagnostic } from './failureEvidence';
import { createServer, createConnection, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeCoordinator } from './coordinator';
import env from '../config/environment';

export const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
export function drainTimeout(value = String(env.FCM_DRAIN_TIMEOUT_MS ?? DEFAULT_DRAIN_TIMEOUT_MS)): number {
  if (!value) return DEFAULT_DRAIN_TIMEOUT_MS;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 100 || result > 1_800_000) throw new Error('Invalid FCM_DRAIN_TIMEOUT_MS');
  return result;
}

/** Local filesystem permissions are the authorization boundary. There is no HTTP
 * maintenance endpoint and no in-process unfreeze or governance bypass.
 */
export async function openRuntimeControl(runtime: RuntimeCoordinator,
  closeIngress: () => Promise<void>, closeProcess: () => void): Promise<Server> {
  mkdirSync(runtime.controlDir, { recursive: true, mode: 0o700 });
  chmodSync(runtime.controlDir, 0o700);
  const socketPath = path.join(runtime.controlDir, 'control.sock');
  if (existsSync(socketPath)) {
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath);
      const timeout = setTimeout(() => { probe.destroy(); reject(new Error('Unknown operator socket state; refusing takeover')); }, 250);
      probe.once('connect', () => { clearTimeout(timeout); probe.destroy(); reject(new Error('Another backend owns the operator socket')); });
      probe.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (err.code === 'ECONNREFUSED') {
          // A stale inode left by a terminated process, not an active authority.
          try { unlinkSync(socketPath); resolve(); } catch (error) { reject(error); }
        } else if (err.code === 'ENOENT') resolve();
        else reject(err);
      });
    });
  }
  const server = createServer(socket => {
    socket.on('error', () => {}); // A local caller disconnecting cannot abort accepted work.
    let body = '';
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1024) { socket.destroy(); return; }
      if (!body.includes('\n')) return;
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      void (async () => {
        let command: unknown;
        try { command = JSON.parse(body.trim()); } catch { socket.end('{"error":"Invalid command"}\n'); return; }
        if (!command || typeof command !== 'object' || !('action' in command)) {
          socket.end('{"error":"Invalid command"}\n'); return;
        }
        if (command.action === 'status') { socket.end(`${JSON.stringify(runtime.snapshot())}\n`); return; }
        if (command.action === 'freeze') {
          const persisted = runtime.freeze('local operator');
          const snapshot = runtime.snapshot();
          socket.end(`${JSON.stringify({ ...snapshot, ...(!persisted ? { error: 'Operator maintenance marker persistence failed' } : {}) })}\n`); return;
        }
        if (command.action !== 'drain' && command.action !== 'shutdown') {
          socket.end('{"error":"Unknown command"}\n'); return;
        }
        const closing = command.action === 'shutdown';
        const snapshot = await runtime.drain({ timeoutMs: drainTimeout(), close: closing,
          ...(closing ? { closeIngress } : {}) });
        const completed = snapshot.phase === 'closed' && snapshot.ingressClosed && snapshot.failures.length === 0;
        socket.end(`${JSON.stringify({ ...snapshot, ...(closing && !completed ? { error: 'Shutdown did not complete' } : {}) })}\n`, () => {
          if (closing && completed) closeProcess();
        });
      })().catch(error => socket.end(`${JSON.stringify({ ...safeDiagnostic(error, 'Runtime control command failed'), error: 'Runtime control command failed' })}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return server;
}

export function installRuntimeSignals(runtime: RuntimeCoordinator, closeIngress: () => Promise<void>, exit: () => void,
  target: Pick<NodeJS.Process, 'on'> = process): void {
  const shutdown = () => {
    // Freeze synchronously in the signal turn; no additional event may enter.
    runtime.freezeForRestart();
    void runtime.drain({ timeoutMs: drainTimeout(), close: true, closeIngress, maintenance: false }).then(snapshot => {
      if (snapshot.phase === 'closed') exit();
    }).catch(err => runtime.recordFailure('signal-drain', err));
  };
  target.on('SIGTERM', shutdown);
  target.on('SIGINT', shutdown);
}
