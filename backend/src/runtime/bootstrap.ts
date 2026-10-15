import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ProcessFence = { path: string; content: string; cleared: boolean };
const filename = 'restart-active.json';

export function syncControlDirectory(controlDir: string): void {
  const directory = openSync(controlDir, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function fenceNames(controlDir: string): string[] {
  try { return readdirSync(controlDir).filter(name => name === 'maintenance.json' || /^restart-.*\.json$/.test(name)); }
  catch (err) { if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []; throw err; }
}

/** Atomic single-process claim before baseline migrations or imported producers.
 * An existing/unknown fence is never claimed using age or a previous process ID.
 */
export function claimProcessFence(controlDir: string, pid: number): ProcessFence | undefined {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  if (fenceNames(controlDir).length) return undefined;
  const failures = path.join(controlDir, 'failures.jsonl');
  if (existsSync(failures) && readFileSync(failures, 'utf8').length) return undefined;
  const fencePath = path.join(controlDir, filename);
  const content = JSON.stringify({ format: 'fcm-restart-fence-v1', owner: randomUUID(), pid, at: new Date().toISOString() });
  try { writeFileSync(fencePath, content, { flag: 'wx', mode: 0o600, flush: true }); }
  catch (err) { if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') return undefined; throw err; }
  // Persist the directory entry as well as the file before allowing writers.
  syncControlDirectory(controlDir);
  return { path: fencePath, content, cleared: false };
}

/** Only the shell's freshly generated nonce and its exec-preserved PID allow
 * Node to inherit the claim. This is a local bootstrap handshake, never ingress.
 */
export function inheritedProcessFence(controlDir: string, nonce: string, pid: number): ProcessFence | undefined {
  const fencePath = path.join(controlDir, filename);
  let content: string;
  try { content = readFileSync(fencePath, 'utf8'); }
  catch (err) { if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined; throw err; }
  let value: unknown;
  try { value = JSON.parse(content); } catch { return undefined; }
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'fcm-restart-fence-v1'
      || !('owner' in value) || value.owner !== nonce || !('pid' in value) || value.pid !== pid) return undefined;
  return { path: fencePath, content, cleared: false };
}

if (require.main === module) {
  const pid = Number(process.argv[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Bootstrap requires the exec-preserved shell PID');
  const fence = claimProcessFence(process.env.FCM_RUNTIME_CONTROL_DIR || '/app/runtime-control', pid);
  if (fence) process.stdout.write(String((JSON.parse(fence.content) as { owner: string }).owner));
}
