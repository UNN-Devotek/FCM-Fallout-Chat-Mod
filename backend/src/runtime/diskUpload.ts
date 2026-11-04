import multer from 'multer';
import { lstat, WriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Readable } from 'node:stream';
import type { RuntimeCoordinator } from './coordinator';

type Filename = (req: Request, file: Express.Multer.File, done: (error: Error | null, value: string) => void) => void;
type DiskUploadOptions = Omit<multer.Options, 'storage' | 'dest'> & { diskStorage: {
  destination: Filename; filename: Filename;
} };
type Entry = {
  id: string; file: Express.Multer.File; destination?: string; filename?: string; pathname?: string;
  prior?: 'absent' | 'existing'; output?: WriteStream; opened: boolean; finished: boolean;
  callbackDone: boolean; error?: unknown; cleanupStarted: boolean; cleanupDone: boolean;
  cleanupError?: unknown; recorded: boolean; releasePath?: () => void;
};
type Upload = {
  lease: ReturnType<RuntimeCoordinator['lease']>; entries: Entry[]; middlewareDone: boolean;
  error?: unknown; forwarded: boolean; next: Parameters<RequestHandler>[2];
};
const errorCode = (error: unknown): unknown => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const prematureClose = () => Object.assign(new Error('Upload stream did not finish'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
const metadataError = (error: unknown) => error instanceof Error ? error : new Error('Upload metadata callback failed');

/** Wrap only this installed Multer/diskStorage instance. HTTP error/next is not
 * proof of file cleanup. Keep actual input/output close and unlink callbacks,
 * including partial writes, and retain the disposition before forwarding next.
 * A path stays serialized until this multipart operation and cleanup complete;
 * another upload cannot be mistaken for the file being rolled back. */
export function createRuntimeDiskUpload(options: DiskUploadOptions, runtime: RuntimeCoordinator, configureStorage?: (storage: multer.StorageEngine) => void) {
  const uploads = new WeakMap<Request, Upload>();
  const entries = new WeakMap<Express.Multer.File, Entry>();
  const pathOwners = new Map<string, { waiting: Array<() => void> }>();
  const evidence = (entry: Entry, stage: string) => ({ operationId: entry.id, source: 'release-upload', stage,
    ...(entry.pathname ? { artifactId: createHash('sha256').update(entry.pathname).digest('hex') } : {}) });
  const fail = (entry: Entry, label: string, error: unknown, stage: string) => {
    if (entry.recorded) return;
    entry.recorded = true;
    runtime.recordFailure(label, error, evidence(entry, stage));
  };
  const closed = (entry: Entry) => entry.file.stream.closed && (!entry.output || entry.output.closed);

  const diskOptions: Parameters<typeof multer.diskStorage>[0] = {
    destination(req, file, done) {
      try { options.diskStorage.destination(req, file, (error, destination) => {
        const upload = uploads.get(req)!, entry = entries.get(file)!;
        upload.lease.run(() => { entry.destination = destination; done(error, destination); });
      }); } catch (error) { done(metadataError(error), ''); }
    },
    filename(req, file, done) {
      try { options.diskStorage.filename(req, file, (error, filename) => {
        const upload = uploads.get(req)!, entry = entries.get(file)!;
        upload.lease.run(() => {
          if (error) { done(error, ''); return; }
          const pathname = path.join(entry.destination!, filename);
          entry.pathname = pathname; entry.filename = filename;
          const begin = () => upload.lease.run(() => {
            entry.releasePath = () => {
              const owner = pathOwners.get(pathname)!;
              const next = owner.waiting.shift();
              if (next) next(); else pathOwners.delete(pathname);
            };
            // Discover before the SDK opens with 'w', not after truncation.
            lstat(pathname, (statError, stat) => upload.lease.run(() => {
              if (statError && errorCode(statError) !== 'ENOENT') { done(statError, ''); return; }
              if (stat?.isSymbolicLink()) { done(new Error('Invalid upload path'), ''); return; }
              entry.prior = statError ? 'absent' : 'existing';
              if (file.stream.destroyed) { done(prematureClose(), ''); return; }
              done(null, filename);
            }));
          });
          const owner = pathOwners.get(pathname);
          if (owner) owner.waiting.push(begin);
          else { pathOwners.set(pathname, { waiting: [] }); begin(); }
        });
      }); } catch (error) { done(metadataError(error), ''); }
    },
  };
  const storage = multer.diskStorage(diskOptions);
  // Tests may wrap this actual instance's callback before the adapter binds it.
  configureStorage?.(storage);
  const handle = storage._handleFile.bind(storage), remove = storage._removeFile.bind(storage);

  function finish(req: Request): void {
    const upload = uploads.get(req)!;
    if (upload.forwarded || !upload.middlewareDone) return;
    for (const entry of upload.entries) {
      if (!closed(entry)) return;
      // Installed diskStorage reports metadata, success and aborted/error
      // pipeline outcomes through this callback. Real stream closure and unlink
      // cannot substitute for a result still pending before the adapter.
      if (!entry.callbackDone) return;
      // Multer omits a failed _handleFile from uploadedFiles. Its concrete
      // partial file still needs cleanup once both streams have actually closed.
      if (upload.error && entry.opened && !entry.cleanupStarted) {
        storage._removeFile(req, { ...entry.file, path: entry.pathname! }, () => finish(req));
        return;
      }
      if (entry.cleanupStarted && !entry.cleanupDone) return;
      if (entry.cleanupError) fail(entry, 'filesystem:upload-cleanup', entry.cleanupError, 'storage-cleanup-unconfirmed');
      else if (upload.error && entry.prior === 'existing' && entry.opened) {
        fail(entry, 'filesystem:upload-write', entry.error || upload.error, 'prior-artifact-overwritten');
      } else if (entry.error && !(entry.prior === 'absent' && entry.cleanupDone)
        && !(!entry.opened && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR'].includes(String(errorCode(entry.error))))
        && entry.output) {
        fail(entry, 'filesystem:upload-write', entry.error, 'storage-write-unconfirmed');
      }
    }
    upload.forwarded = true;
    try { upload.lease.run(() => upload.next(upload.error)); }
    finally {
      for (const entry of upload.entries) entry.releasePath?.();
      upload.lease.release();
    }
  }

  storage._handleFile = (req, file, done) => {
    const upload = uploads.get(req)!;
    const entry: Entry = { id: randomUUID(), file, opened: false, finished: false, callbackDone: false,
      cleanupStarted: false, cleanupDone: false, recorded: false };
    upload.entries.push(entry); entries.set(file, entry);
    const pipe = file.stream.pipe;
    // diskStorage creates and passes its real fs.WriteStream to this exact
    // file stream. No fs function, SDK prototype or unrelated stream is patched.
    file.stream.pipe = function<T extends NodeJS.WritableStream>(destination: T, pipeOptions?: { end?: boolean }): T {
      if (!(destination instanceof WriteStream)) {
        fail(entry, 'filesystem:upload-write', new Error('Unexpected disk storage stream'), 'storage-stream-unknown');
        throw new Error('Unexpected disk storage stream');
      }
      const output = destination;
      entry.output = output;
      output.once('open', () => upload.lease.run(() => { entry.opened = true; }));
      output.once('finish', () => upload.lease.run(() => { entry.finished = true; }));
      output.once('error', error => upload.lease.run(() => {
        entry.error = error; file.stream.unpipe(output); file.stream.destroy();
      }));
      output.once('close', () => upload.lease.run(() => {
        if (!entry.finished && !entry.error) entry.error = prematureClose();
        finish(req);
      }));
      return pipe.call(this, destination, pipeOptions) as T;
    };
    file.stream.once('error', error => upload.lease.run(() => { entry.error = error; entry.output?.destroy(); }));
    file.stream.once('close', () => upload.lease.run(() => {
      if (!file.stream.readableEnded) { entry.error ||= prematureClose(); entry.output?.destroy(); }
      finish(req);
    }));
    const complete: Parameters<multer.StorageEngine['_handleFile']>[2] = (error, info) => upload.lease.run(() => {
      if (entry.callbackDone) return;
      entry.callbackDone = true; entry.error ||= error;
      file.stream.pipe = pipe;
      if (error) file.stream.destroy();
      try { done(error, info); } finally { finish(req); }
    });
    try { upload.lease.run(() => handle(req, file, complete)); }
    catch (error) { entry.output?.destroy(); complete(error); }
  };

  storage._removeFile = (req, file, done) => {
    const upload = uploads.get(req)!;
    const entry = upload.entries.find(value => value.pathname === file.path);
    if (!entry) {
      runtime.recordFailure('filesystem:upload-cleanup', new Error('Upload cleanup has no owning artifact'), { stage: 'storage-cleanup-owner-unknown' });
      done(new Error('Upload cleanup has no owning artifact')); return;
    }
    entry.cleanupStarted = true;
    const input: Readable = entry.file.stream;
    // A request abort can invoke _removeFile while diskStorage is still writing.
    // Unlink cannot be the final result until those actual streams have closed.
    const clean = () => upload.lease.run(() => {
      if (!closed(entry)) return;
      input.off('close', clean); entry.output?.off('close', clean);
      remove(req, file, error => upload.lease.run(() => {
        if (entry.cleanupDone) return;
        entry.cleanupDone = true; entry.cleanupError = error;
        if (error) fail(entry, 'filesystem:upload-cleanup', error, 'storage-cleanup-unconfirmed');
        if (error && upload.middlewareDone && upload.error && typeof upload.error === 'object') {
          const original = upload.error as { storageErrors?: unknown[] };
          original.storageErrors ??= [];
          if (!original.storageErrors.includes(error)) original.storageErrors.push(error);
        }
        try { done(error); } finally { finish(req); }
      }));
    });
    input.once('close', clean); entry.output?.once('close', clean);
    if (!input.readableEnded) input.destroy();
    if (entry.output && !entry.finished) entry.output.destroy();
    clean();
  };

  const uploader = multer({ ...options, storage });
  const single = uploader.single.bind(uploader);
  uploader.single = field => {
    const middleware = single(field);
    return (req, res, next) => {
      let lease: Upload['lease'];
      try { lease = runtime.lease('filesystem:upload'); }
      catch (error) { next(error); return; }
      const upload: Upload = { lease, entries: [], middlewareDone: false, forwarded: false, next };
      uploads.set(req, upload);
      try {
        lease.run(() => middleware(req, res, error => lease.run(() => {
          upload.middlewareDone = true; upload.error = error; finish(req);
        })));
      } catch (error) {
        upload.middlewareDone = true; upload.error = error;
        for (const entry of upload.entries) { entry.file.stream.destroy(); entry.output?.destroy(); }
        finish(req);
      }
    };
  };
  return uploader;
}
