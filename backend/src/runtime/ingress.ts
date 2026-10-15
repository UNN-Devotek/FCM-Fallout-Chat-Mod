import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler, Express } from 'express';
import type { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { MaintenanceError, type RuntimeCoordinator } from './coordinator';

export function maintenanceResponse(res: Response): void {
  res.setHeader('Retry-After', '30');
  res.status(503).type('application/problem+json').json({ type: 'about:blank', title: 'Service Unavailable',
    status: 503, detail: new MaintenanceError().message, code: 'maintenance', retryAfterMs: 30_000 });
}

export function accountHttpIngress(runtime: RuntimeCoordinator, frozenRead?: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (runtime.isFrozen()) {
      if (frozenRead) return frozenRead(req, res, () => maintenanceResponse(res));
      maintenanceResponse(res);
      return;
    }
    const lease = runtime.lease(`http:${req.method}`, true);
    const release = () => { res.off('finish', release); res.off('close', release); lease.release(); };
    res.once('finish', release);
    res.once('close', release);
    lease.run(next);
  };
}

type HttpLayer = { handle: RequestHandler | ErrorRequestHandler | (RequestHandler & { stack?: HttpLayer[] });
  route?: { stack: HttpLayer[] } };

/** Express only observes returned promises; it cannot account for work after a
 * response or a client close. Retain each middleware callback until next/finish
 * or its returned promise settles, and account for detached descendant promises.
 * Invoke once after route registration and before listening.
 */
export function instrumentHttpHandlers(app: Express, runtime: RuntimeCoordinator): void {
  const visit = (layers: HttpLayer[]) => {
    for (const layer of layers) {
      const handler = layer.handle;
      const nested = 'stack' in handler ? handler.stack : undefined;
      if (Array.isArray(nested)) { visit(nested); continue; }
      if (layer.route) { visit(layer.route.stack); continue; }
      const invoke = (req: Request, res: Response, next: NextFunction, error?: unknown) => {
        const lease = runtime.lease(`http-handler:${handler.name || 'anonymous'}`, true);
        let returned = false;
        let releaseRequested = false;
        const release = () => {
          res.off('finish', release);
          if (returned) lease.release();
          else releaseRequested = true; // next() may be followed by more work.
        };
        res.once('finish', release);
        const forward: NextFunction = err => { release(); next(err); };
        let result: unknown;
        try {
          result = lease.run(() => handler.length === 4
            ? (handler as ErrorRequestHandler)(error, req, res, forward)
            : (handler as RequestHandler)(req, res, forward));
        } catch (err) { returned = true; release(); throw err; }
        returned = true;
        if (releaseRequested) release();
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          return Promise.resolve(result).finally(release);
        }
        // A finished response may have emitted synchronously in a test fixture.
        if (res.writableFinished) release();
        return result;
      };
      layer.handle = handler.length === 4
        ? (err: unknown, req: Request, res: Response, next: NextFunction) => invoke(req, res, next, err)
        : (req: Request, res: Response, next: NextFunction) => invoke(req, res, next);
    }
  };
  visit((app.router as unknown as { stack: HttpLayer[] }).stack);
}

const accountedSockets = new WeakSet<WebSocket>();
export function accountSocket(ws: WebSocket, runtime: RuntimeCoordinator, transport: 'ws' | 'relay'): void {
  if (accountedSockets.has(ws)) return;
  accountedSockets.add(ws);
  const emit = ws.emit;
  ws.emit = function(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'message' && runtime.isFrozen()) {
      if (ws.readyState === 1) ws.send(JSON.stringify(transport === 'relay'
        ? { success: false, error: { code: 'maintenance', message: new MaintenanceError().message, retryAfterMs: 30_000 } }
        : { type: 'error', payload: { code: 'maintenance', message: new MaintenanceError().message, retryAfterMs: 30_000 } }));
      return false;
    }
    if (event !== 'message' && event !== 'close' && event !== 'error') return emit.call(this, event, ...args);
    const lease = runtime.lease(`${transport}:${String(event)}`, true);
    try { return lease.run(() => emit.call(this, event, ...args)); }
    finally { lease.release(); }
  };
}

/** Account before service listeners are installed, including listeners returning
 * void while spawning async work. Infrastructure events remain available for
 * recovery; gateway feature handlers receive no new work after freeze.
 */
export function accountDiscordEmitter(client: EventEmitter, runtime: RuntimeCoordinator): void {
  const emit = client.emit;
  const infrastructure = new Set(['error', 'warn', 'debug', 'shardError', 'shardDisconnect', 'shardReconnecting',
    'shardReady', 'shardResume', 'invalidated', 'rateLimit']);
  client.emit = function(event: string | symbol, ...args: unknown[]): boolean {
    if (runtime.isFrozen() && !infrastructure.has(String(event))) {
      if (event === 'interactionCreate') {
        const interaction = args[0];
        if (interaction && typeof interaction === 'object' && 'reply' in interaction
          && typeof interaction.reply === 'function') {
          const reply = interaction.reply.bind(interaction);
          void runtime.required('discord:maintenance-refusal', async () => await reply({
            content: new MaintenanceError().message, ephemeral: true }), undefined, true)
            .catch(() => {});
        }
      }
      return false;
    }
    const lease = runtime.lease(`discord:${String(event)}`, true);
    try { return lease.run(() => emit.call(this, event, ...args)); }
    finally { lease.release(); }
  };
}

/** Completion callbacks on this SDK instance are descendants of already-started
 * operations, including responses/retries arriving after freeze. Their returned
 * and detached application promises remain owned independently of SDK internals. */
export function accountSdkCallbackEmitter(emitter: EventEmitter, runtime: RuntimeCoordinator, label: string): void {
  const emit = emitter.emit;
  emitter.emit = function(event: string | symbol, ...args: unknown[]): boolean {
    const lease = runtime.lease(`${label}:${String(event)}`, true);
    try { return lease.run(() => emit.call(this, event, ...args)); }
    finally { lease.release(); }
  };
}
