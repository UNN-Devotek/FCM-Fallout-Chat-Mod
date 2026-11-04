import { ReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { RequestHandler, Response } from 'express';
import type { RuntimeCoordinator } from './coordinator';

// Use the exact send dependency installed for Express, including when nested.
const send = createRequire(require.resolve('express'))('send') as typeof import('send');
type ReadSignals = { done: (error?: unknown) => void; metadata: () => void; stream: (source: unknown) => void };

/** Installed send/serve-static pipes an actual fs.ReadStream to this response.
 * Its response-close cleanup destroys the stream without next() or finish.
 * Only these explicitly registered file reads may use that cancellation proof;
 * arbitrary HTTP callbacks, uploads and mutations have their own completion. */
function accountReadResponse(runtime: RuntimeCoordinator, res: Response,
  start: (signals: ReadSignals) => void, explicitMetadata = false): Promise<void> {
  const lease = runtime.lease('http-file-read', true);
  const streams = new Set<ReadStream>();
  let returned = false, terminal = false, canceled = false, settled = false;
  let metadataDone = !explicitMetadata;
  let completionError: unknown;
  let complete: () => void;
  const operation = new Promise<void>((resolve, reject) => {
    complete = () => {
      if (settled || !returned || !metadataDone
        || (!terminal && !(canceled && (streams.size > 0 || explicitMetadata)))) return;
      if ([...streams].some(stream => !stream.closed)) return;
      settled = true;
      res.off('pipe', onPipe); res.off('finish', onFinish); res.off('close', onClose);
      if (res.end === onEnd) res.end = end;
      for (const stream of streams) stream.off('close', onStreamClose);
      if (completionError) reject(completionError); else resolve();
    };
  });
  const onStreamClose = () => lease.run(complete);
  const onPipe = (source: unknown) => lease.run(() => {
    if (!(source instanceof ReadStream) || streams.has(source)) return;
    streams.add(source);
    source.once('close', onStreamClose);
  });
  const onFinish = () => lease.run(() => { terminal = true; complete(); });
  const onClose = () => lease.run(() => {
    canceled = true;
    if (explicitMetadata && !res.writableFinished) completionError ||= Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' });
    complete();
  });
  const end = res.end;
  const onEnd = function(...args: Parameters<Response['end']>) {
    // send has completed stat/cache/HEAD processing before requesting end(),
    // even if the already-closed response cannot emit finish. This hook belongs
    // only to this concrete read response; captured streams must still close.
    return lease.run(() => {
      terminal = true;
      try { return end.apply(res, args); } finally { complete(); }
    });
  } as Response['end'];
  res.end = onEnd;
  res.on('pipe', onPipe); res.once('finish', onFinish); res.once('close', onClose);
  try {
    lease.run(() => start({
      done: error => lease.run(() => { terminal = true; completionError ||= error; complete(); }),
      metadata: () => lease.run(() => {
        metadataDone = true;
        // The SDK emits file before it synchronously creates/pipes its stream.
        // Complete only after that callback turn has supplied the real stream.
        queueMicrotask(() => lease.run(complete));
      }), stream: onPipe,
    }));
  } catch (error) { terminal = true; completionError = error; }
  returned = true;
  if (res.writableFinished) terminal = true;
  complete!();
  return operation.finally(lease.release);
}

export function accountFileRead(handler: RequestHandler, runtime: RuntimeCoordinator): RequestHandler {
  return function runtimeFileRead(req, res, next) {
    // Forward only when the SDK actually calls next. Canceled stream closure is
    // completion of this read, and must not invoke another application handler.
    return accountReadResponse(runtime, res, ({ done }) => {
      handler(req, res, error => { done(); next(error); });
    });
  };
}

export function sendFileRead(res: Response, filename: string, runtime: RuntimeCoordinator): Promise<void> {
  if (!path.isAbsolute(filename)) return Promise.reject(new TypeError('File path must be absolute'));
  return accountReadResponse(runtime, res, signals => {
    // Express sendFile's abort callback can precede a pending stat callback.
    // This per-transfer instance exposes the actual metadata and stream events
    // while preserving its file/cache/range/HEAD headers and existing errors.
    const transfer = send(res.req, encodeURI(filename), { etag: res.app.enabled('etag') });
    transfer.on('file', signals.metadata);
    transfer.on('stream', signals.stream);
    transfer.on('end', () => signals.done());
    transfer.on('directory', () => {
      signals.metadata(); signals.done(Object.assign(new Error('Path is a directory'), { code: 'EISDIR' }));
    });
    transfer.on('error', error => { signals.metadata(); signals.done(error); });
    transfer.pipe(res);
  }, true);
}
