import { runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SECURITY NOTICE — RAW DATABASE ACCESS                                   ║
 * ║                                                                          ║
 * ║  These endpoints execute arbitrary SQL, dump the entire database, and    ║
 * ║  can restore/overwrite the database.  They are gated by                  ║
 * ║  requireMigrationKey (X-Migration-Key header, fail-closed).             ║
 * ║                                                                          ║
 * ║  pg_dump / pg_restore / psql binaries are required in the runtime        ║
 * ║  environment.  The official postgres Docker image includes them; a       ║
 * ║  slim/alpine image may not — add the `postgresql-client` package if     ║
 * ║  they are absent.  A missing binary returns HTTP 503.                    ║
 * ║                                                                          ║
 * ║  DATABASE_URL must be set in the environment for dump/restore to work.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { Request, Response, NextFunction } from 'express';
import { spawn } from 'child_process';
import tar from 'tar-stream';
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { finished, pipeline } from 'node:stream/promises';
import { s3, BUCKET } from '../config/storage';
import { query } from '../config/database';
import logger from '../config/logger';
import prisma from '../config/prisma';
import { randomUUID } from 'node:crypto';
import { runtime } from '../runtime';
import { isAllowedImageHost, fetchRemoteImage, putToMinio } from '../lib/imageStorage';

const MAX_SQL_ROWS = 1000;
const SQL_PREVIEW_LENGTH = 200;

function canRespond(res: Response): boolean {
  return !res.destroyed && !res.writableEnded && !res.headersSent;
}

// Parse a postgres:// or postgresql:// DATABASE_URL into spawn env vars for
// pg_dump / pg_restore / psql.  We never shell-interpolate the URL — we pass
// discrete env vars so argument lists contain no user-controlled data.
function pgEnvFromUrl(url: string): Record<string, string> | null {
  try {
    const u = new URL(url);
    const env: Record<string, string> = {};
    if (u.hostname) env['PGHOST'] = u.hostname;
    if (u.port)     env['PGPORT'] = u.port;
    if (u.username) env['PGUSER'] = decodeURIComponent(u.username);
    if (u.password) env['PGPASSWORD'] = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, '');
    if (db) env['PGDATABASE'] = db;
    return env;
  } catch {
    return null;
  }
}

/**
 * POST /admin/migration/sql
 * Body: { sql: string }
 *
 * Executes ad-hoc SQL via the existing pg pool.  Returns up to MAX_SQL_ROWS rows.
 * Intended for owner-driven schema migrations (ALTER TABLE, UPDATE, etc.).
 */
async function runSql(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'migrationController:9678444ae0fa', async () => {
  const { sql } = req.body as { sql?: string };

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    res.status(400).json({ error: 'Body must include a non-empty "sql" string.' });
    return;
  }

  const sqlPreview = sql.slice(0, SQL_PREVIEW_LENGTH);

  logger.info(
    {
      audit: 'migration-key',
      action: 'sql',
      sqlPreview,
      sourceIp: req.ip,
      timestamp: new Date().toISOString(),
    },
    'Migration: executing ad-hoc SQL',
  );

  try {
    const result = await runRequiredMutation('domain', 'daed229f825ed1f7f2bee475', { stage: 'primary-write-unconfirmed' }, () => query(sql), undefined, undefined, undefined);
    const rows = Array.isArray(result.rows) ? result.rows.slice(0, MAX_SQL_ROWS) : [];
    res.json({
      rowCount: result.rowCount ?? 0,
      rows,
      truncated: (result.rows?.length ?? 0) > MAX_SQL_ROWS,
    });
  } catch (err) {
    next(err);
  }

  });
}

/**
 * POST /admin/migration/dump
 *
 * Streams a pg_dump (plain SQL format) of the database as a downloadable
 * attachment.  No request body required.
 *
 * NOTE: pg_dump must be available in the runtime container.
 */
async function dumpDatabase(req: Request, res: Response, next: NextFunction): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(503).json({ error: 'DATABASE_URL is not set; cannot run pg_dump.' });
    return;
  }

  const pgEnv = pgEnvFromUrl(databaseUrl);
  if (!pgEnv) {
    res.status(503).json({ error: 'DATABASE_URL is not a valid postgres:// URL.' });
    return;
  }

  logger.info(
    {
      audit: 'migration-key',
      action: 'dump',
      sourceIp: req.ip,
      timestamp: new Date().toISOString(),
    },
    'Migration: starting pg_dump',
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `db-dump-${timestamp}.sql`;

  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await runtime.run('migration:database-dump', () => new Promise<void>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('pg_dump', ['--no-password', '--format=plain', '--no-owner', '--no-acl'], {
        env: { ...process.env, ...pgEnv }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) { if (canRespond(res)) next(err); resolve(); return; }
    let stderrOutput = '';
    let closed = false;
    let cancelled = false;
    const cancel = () => {
      if (closed || cancelled) return;
      cancelled = true;
      child.stdout!.unpipe(res);
      // This is a read-only export. Disconnect cancels it; child close, rather
      // than kill's return value or exit, verifies that its DB read has stopped.
      try { child.kill('SIGTERM'); } catch (err) { logger.error({ err, action: 'dump' }, 'Migration: pg_dump termination unconfirmed'); }
    };
    const responseClose = () => { if (!res.writableFinished) cancel(); };
    res.on('close', responseClose); res.on('error', cancel);
    child.stdout!.on('error', err => { cancel(); if (!res.destroyed) res.destroy(err); });
    child.stderr!.on('error', err => { cancel(); if (!res.destroyed) res.destroy(err); });
    child.stderr!.on('data', (chunk: Buffer) => { stderrOutput = (stderrOutput + chunk.toString()).slice(0, 1000); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (closed) return;
      logger.error({ err, action: 'dump' }, 'Migration: pg_dump spawn error');
      if (err.code === 'ENOENT') res.destroy();
      else if (canRespond(res)) next(err);
    });
    child.on('close', code => {
      if (closed) return;
      closed = true;
      res.off('close', responseClose); res.off('error', cancel);
      if (!cancelled && code !== 0) {
        logger.error({ code, stderrOutput, action: 'dump' }, 'Migration: pg_dump exited with non-zero code');
        if (canRespond(res)) res.status(500).json({ error: 'pg_dump failed', details: stderrOutput.slice(0, 500) });
        else if (!res.destroyed && !res.writableEnded) res.end();
      } else if (!cancelled) logger.info({ action: 'dump' }, 'Migration: pg_dump completed successfully');
      resolve();
    });
    child.stdout!.pipe(res);
  }));
}

/**
 * POST /admin/migration/restore
 *
 * Accepts a raw SQL dump in the request body (Content-Type: text/plain or
 * application/sql, up to 512 MB) and pipes it into `psql`.
 *
 * Use `--data-binary @dump.sql` with curl so the body is sent verbatim.
 * NOTE: psql must be available in the runtime container.
 *
 * WARNING: this OVERWRITES existing data.  Take a dump first.
 */
async function restoreDatabase(req: Request, res: Response, next: NextFunction): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(503).json({ error: 'DATABASE_URL is not set; cannot run psql restore.' });
    return;
  }

  const pgEnv = pgEnvFromUrl(databaseUrl);
  if (!pgEnv) {
    res.status(503).json({ error: 'DATABASE_URL is not a valid postgres:// URL.' });
    return;
  }

  logger.info(
    {
      audit: 'migration-key',
      action: 'restore',
      sourceIp: req.ip,
      timestamp: new Date().toISOString(),
    },
    'Migration: starting psql restore',
  );

  const operationId = randomUUID();
  await runtime.run('migration:database-restore', () => new Promise<void>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('psql', ['--no-password', '--single-transaction', '--set=ON_ERROR_STOP=1'], {
        env: { ...process.env, ...pgEnv }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      runtime.recordFailure('migration:database-restore', new Error('Database restore child could not start'),
        { operationId, stage: 'spawn-threw' });
      if (canRespond(res)) next(err);
      resolve(); return;
    }
    let closed = false;
    let inputFinished = false;
    let failed = false;
    let terminationRequested = false;
    let stdout = '';
    let stderr = '';
    const failure = (stage: string, detail: Record<string, unknown> = {}) => {
      failed = true;
      runtime.recordFailure('migration:database-restore', new Error('Database restore completion could not be verified'),
        { operationId, childPid: child.pid, stage, ...detail });
    };
    const stopIncompleteInput = (stage: string) => {
      if (closed) return;
      failure(stage);
      if (terminationRequested) return;
      terminationRequested = true;
      req.unpipe(child.stdin!);
      child.stdin?.destroy();
      // An incomplete SQL stream is unsafe. Request termination, but retain the
      // restore lease until close verifies the child has actually stopped.
      try { child.kill('SIGTERM'); } catch { failure('child-termination-unconfirmed'); }
    };
    const aborted = () => stopIncompleteInput('request-input-incomplete');
    const requestError = () => stopIncompleteInput('request-input-error');
    const requestClose = () => { if (!req.complete && !req.readableEnded) aborted(); };
    req.on('aborted', aborted); req.on('error', requestError); req.on('close', requestClose);
    child.stdin!.on('finish', () => { inputFinished = true; });
    child.stdin!.on('error', () => { if (!closed) stopIncompleteInput('stdin-write-unconfirmed'); });
    child.stdout!.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 2000); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 1000); });
    child.stdout!.on('error', () => { if (!closed) failure('stdout-incomplete'); });
    child.stderr!.on('error', () => { if (!closed) failure('stderr-incomplete'); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (closed) return;
      failure('child-error', { code: err.code });
      logger.error({ err, action: 'restore' }, 'Migration: psql child error');
      if (canRespond(res)) {
        if (err.code === 'ENOENT') res.status(503).json({ error: 'psql binary not found in container PATH.' });
        else next(err);
      }
      // error/exit is not close: an unknown live child still blocks drain.
    });
    child.on('exit', (code, signal) => {
      if (!closed && (code !== 0 || signal)) failure('child-exit-failed', { code, signal });
    });
    child.on('close', (code, signal) => {
      if (closed) return;
      closed = true;
      req.off('aborted', aborted); req.off('error', requestError); req.off('close', requestClose);
      if (code !== 0 || signal) failure('child-close-failed', { code, signal });
      if (!inputFinished) failure('stdin-completion-unconfirmed');
      if (failed) {
        logger.error({ code, stderr, action: 'restore', operationId }, 'Migration: psql restore failed');
        if (canRespond(res)) res.status(500).json({ error: 'psql restore failed', code, details: stderr.slice(0, 500) });
      } else {
        logger.info({ action: 'restore', operationId }, 'Migration: psql restore completed successfully');
        if (canRespond(res)) res.json({ ok: true, output: stdout });
      }
      resolve();
    });
    // express.raw has already consumed the body. Empty buffered input still
    // needs an explicit stdin end; fallback streams must finish without abort.
    try {
      if (Buffer.isBuffer(req.body)) child.stdin!.end(req.body);
      else req.pipe(child.stdin!);
    } catch { stopIncompleteInput('stdin-write-threw'); }
  }));
}

const ALLOWED_STORAGE_PREFIXES = ['wiki-images/', 'camp-images/'] as const;

// Strict allowlist: prefix/filename where filename is alphanumeric + ._- (no slashes, no ..)
const OBJECT_KEY_RE = /^(wiki-images|camp-images)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function contentTypeForKey(key: string): string {
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.png'))  return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.gif'))  return 'image/gif';
  return 'application/octet-stream';
}

/**
 * POST /admin/migration/storage/dump
 *
 * Streams all objects under wiki-images/ and camp-images/ as a .tar archive.
 * Optional body: { prefixes?: string[] } — filtered to the two allowed prefixes.
 * Objects are streamed one at a time (memory-safe; never buffers all objects).
 */
async function dumpStorage(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Determine which prefixes to dump (body may specify a subset)
  let requestedPrefixes: string[] = ALLOWED_STORAGE_PREFIXES as unknown as string[];
  if (req.body && Array.isArray(req.body.prefixes)) {
    requestedPrefixes = (req.body.prefixes as string[]).filter(
      (p) => (ALLOWED_STORAGE_PREFIXES as readonly string[]).includes(p),
    );
  }
  if (requestedPrefixes.length === 0) {
    res.status(400).json({ error: 'No allowed prefixes selected.' });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="storage-dump-${timestamp}.tar"`);

  const pack = tar.pack();
  const controller = new AbortController();
  let cancelled = false;
  let activeBody: Readable | undefined;
  let activeBodyCompletion: Promise<void> | undefined;
  let packed = false;
  const packing = new Promise<void>(resolve => {
    // streamx propagates response/entry errors to the pack. Always observe them;
    // the controller's ordinary read-error path reports the request failure.
    pack.on('error', () => {});
    pack.on('end', () => { packed = true; resolve(); });
    pack.on('close', resolve);
  });
  const cancel = () => {
    if (res.writableFinished || cancelled) return;
    cancelled = true;
    controller.abort();
    activeBody?.destroy();
    pack.destroy();
  };
  res.on('close', cancel); res.on('error', cancel);
  pack.pipe(res);
  let totalObjects = 0;

  try {
    logger.info(
      { audit: 'migration-key', action: 'storage-dump', prefixes: requestedPrefixes, sourceIp: req.ip, timestamp: new Date().toISOString() },
      'Migration: starting storage dump',
    );

    for (const prefix of requestedPrefixes) {
      if (cancelled) break;
      let continuationToken: string | undefined;

      do {
        const listResp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }), { abortSignal: controller.signal });

        for (const obj of listResp.Contents ?? []) {
          if (cancelled) break;
          const key = obj.Key;
          if (!key) continue;

          // Fetch the object from S3/MinIO
          const getResp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: controller.signal });
          const bodyStream = getResp.Body as Readable | undefined;
          if (!bodyStream) continue;
          activeBody = bodyStream;
          activeBodyCompletion = finished(bodyStream, { cleanup: true }).catch(() => {});
          if (cancelled) { bodyStream.destroy(); break; }

          const size = getResp.ContentLength ?? obj.Size ?? 0;

          // Create a tar entry and stream the S3 body into it — one object at a time
          await pipeline(bodyStream, pack.entry({ name: key, size }));
          await activeBodyCompletion;
          activeBody = undefined;
          activeBodyCompletion = undefined;
          totalObjects++;
        }

        continuationToken = listResp.NextContinuationToken;
      } while (continuationToken && !cancelled);
    }
    if (!cancelled) pack.finalize();
    await packing;
    if (!cancelled && !packed) throw new Error('Storage dump archive output was incomplete');
    if (!cancelled) logger.info(
      { audit: 'migration-key', action: 'storage-dump', totalObjects },
      'Migration: storage dump completed',
    );
  } catch (err) {
    if (!cancelled) {
      logger.error({ err, action: 'storage-dump' }, 'Migration: storage dump error');
      if (res.headersSent) res.destroy();
      else if (canRespond(res)) next(err);
    }
  } finally {
    res.off('close', cancel); res.off('error', cancel);
    activeBody?.destroy();
    pack.destroy();
    await packing;
    await activeBodyCompletion;
  }
}

/**
 * POST /admin/migration/storage/restore
 *
 * Accepts a .tar stream (raw request body — no buffering body parser).
 * For each entry, validates the key against OBJECT_KEY_RE, then Puts the object
 * into MinIO. Additive only — never deletes existing objects.
 */
async function restoreStorage(req: Request, res: Response, _next: NextFunction): Promise<void> {
  let restored = 0;
  let rejected = 0;
  let failed = 0;

  logger.info(
    { audit: 'migration-key', action: 'storage-restore', sourceIp: req.ip, timestamp: new Date().toISOString() },
    'Migration: starting storage restore',
  );

  const operationId = randomUUID();
  await runtime.run('migration:storage-restore', async () => {
    const extract = tar.extract();
    let finished = false;
    let inputFailed = false;
    let currentObjectKey: string | undefined;
    extract.on('finish', () => { finished = true; });
    const incompleteInput = () => {
      if (inputFailed || finished) return;
      inputFailed = true;
      runtime.recordFailure('migration:storage-restore', new Error('Storage restore input was incomplete'),
        { operationId, objectKey: currentObjectKey, stage: 'request-input-incomplete' });
      extract.destroy(new Error('Storage restore request input was incomplete'));
    };
    const requestClose = () => { if (!req.complete && !req.readableEnded) incompleteInput(); };
    req.on('aborted', incompleteInput); req.on('error', incompleteInput); req.on('close', requestClose);
    // The iterator is installed before piping. It keeps archive/entry lifetimes
    // awaited and advances only after this entry's PUT is confirmed or recorded.
    const entries = extract[Symbol.asyncIterator]();
    try {
      req.pipe(extract);
      for await (const stream of entries) {
        const name = stream.header.name;
        const allowed = OBJECT_KEY_RE.test(name);
        currentObjectKey = allowed ? name : undefined;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) { if (allowed) chunks.push(chunk); }
        if (!allowed) { rejected++; continue; }
        const buf = Buffer.concat(chunks);
        if (buf.length !== (stream.header.size ?? 0)) throw new Error('Storage restore entry size was incomplete');
        try {
          await runtime.required('migration:storage-restore:put', async () => s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: name, Body: buf, ContentType: contentTypeForKey(name),
          })), { operationId, objectKey: name, stage: 'object-put-result-unknown' });
          restored++;
        } catch { failed++; }
      }
      if (!finished) throw new Error('Storage restore archive completion was not verified');
      logger.info({ audit: 'migration-key', action: 'storage-restore', operationId, restored, rejected, failed },
        'Migration: storage restore completed');
      if (canRespond(res)) res.json({ data: { restored, rejected, failed } });
    } catch (err) {
      if (!inputFailed) runtime.recordFailure('migration:storage-restore', new Error('Storage restore archive or entry was incomplete'),
        { operationId, objectKey: currentObjectKey, stage: 'archive-or-entry-incomplete' });
      logger.error({ err, action: 'storage-restore', operationId }, 'Migration: tar extract error');
      if (canRespond(res)) res.status(400).json({ error: 'Failed to parse tar stream', detail: (err as Error).message });
    } finally {
      req.off('aborted', incompleteInput); req.off('error', incompleteInput); req.off('close', requestClose);
      req.unpipe(extract);
      extract.destroy();
    }
  });
}

// ── Image backfill ─────────────────────────────────────────────────────────────

const BACKFILL_CONCURRENCY  = 6;
const BACKFILL_MAX_BYTES    = 20 * 1024 * 1024; // 20 MB (same cap as wikiImageService)

/**
 * Extract the MinIO object key from a stored wiki_images.url value.
 * Identical logic to wikiImageController.minioKey():
 *   find 'wiki-images/' in the url and return everything from that index onward.
 * e.g. "https://minio.example.com/avatars/wiki-images/123-ab12cd34.webp"
 *   → "wiki-images/123-ab12cd34.webp"
 */
function wikiMinioKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const i = url.indexOf('wiki-images/');
  return i >= 0 ? url.slice(i) : null;
}

/** Check whether an object already exists in MinIO (non-throwing). */
async function headExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /admin/migration/backfill-images
 *
 * Re-fetches wiki image objects from their Fandom CDN source_url and uploads
 * them into prod MinIO.  Needed after a DB-only migration where the image
 * objects could not be transferred (e.g. Cloudflare 100 MB body cap).
 *
 * Body (optional JSON):
 *   { camp?: boolean }  — if true, also attempts camp_items images (default: false;
 *                         camp images self-ingest on first load anyway).
 *
 * Responds 202 immediately; the mirror run is fire-and-forget.
 * Progress and final counts are logged (audit: 'migration-key').
 */
async function backfillImages(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const includeCamp = Boolean((req.body as { camp?: boolean } | undefined)?.camp);
  const operationId = randomUUID();

  logger.info(
    { audit: 'migration-key', action: 'backfill-images', includeCamp, sourceIp: req.ip, timestamp: new Date().toISOString() },
    'Migration: backfill-images started',
  );

  res.status(202).json({ data: { status: 'started' } });

  void runtime.required('migration:backfill-images', async () => {
    // ── 1. Wiki images ─────────────────────────────────────────────────────────
    let wikiTotal    = 0;
    let wikiMirrored = 0;
    let wikiSkipped  = 0;
    let wikiFailed   = 0;

    try {
      const rows = await prisma.wikiImage.findMany({
        where:  { sourceUrl: { not: null } },
        select: { id: true, url: true, sourceUrl: true, mime: true },
      });

      wikiTotal = rows.length;
      logger.info({ action: 'backfill-images', wikiTotal }, 'Migration: backfill-images wiki rows queried');

      const iter = rows[Symbol.iterator]();

      async function wikiWorker(): Promise<void> {
        for (;;) {
          const { value: row, done } = iter.next();
          if (done) return;

          const sourceUrl = row.sourceUrl as string; // filtered above (not null)

          // Derive the MinIO key from the stored url; the url column holds the full
          // MinIO public URL after a normal migration (e.g. https://…/wiki-images/<pageId>-<hash8>.webp).
          const key = wikiMinioKey(row.url);
          if (!key) {
            // url doesn't contain 'wiki-images/' — row was never mirrored; we
            // cannot derive a deterministic key without re-downloading and hashing.
            // Skip and count as failed so the operator knows to re-run after a
            // normal backfillWikiImages pass.
            logger.warn({ id: row.id, url: row.url }, '[backfillImages] wiki row has no mirrored url — skip (run backfillWikiImages.ts first)');
            wikiFailed++;
            runtime.recordFailure('migration:backfill-images:wiki', new Error('Accepted image has no deterministic object key'),
              { operationId, rowId: row.id, stage: 'object-key-unresolved' });
            continue;
          }

          try {
            if (await headExists(key)) {
              wikiSkipped++;
              continue;
            }

            if (!isAllowedImageHost(sourceUrl)) {
              logger.warn({ id: row.id, sourceUrl }, '[backfillImages] wiki source_url host not in SSRF allowlist — skip');
              wikiSkipped++;
              continue;
            }

            const result = await fetchRemoteImage(sourceUrl, BACKFILL_MAX_BYTES);
            if (!result) {
              logger.warn({ id: row.id, sourceUrl }, '[backfillImages] wiki fetch failed — skip');
              wikiFailed++;
              runtime.recordFailure('migration:backfill-images:wiki', new Error('Accepted image fetch incomplete'),
                { operationId, rowId: row.id, objectKey: key, stage: 'source-fetch-incomplete' });
              continue;
            }

            const stored = await putToMinio(key, result.buf, result.contentType);
            if (stored) {
              wikiMirrored++;
            } else {
              wikiFailed++;
              runtime.recordFailure('migration:backfill-images:wiki', new Error('Accepted image store unconfirmed'),
                { operationId, rowId: row.id, objectKey: key, stage: 'object-put-result-unknown' });
            }
          } catch (err) {
            runtime.recordFailure('migration:backfill-images:wiki', new Error('Accepted wiki image mirror was not confirmed'), { operationId, rowId: row.id, objectKey: key,
              stage: 'object-mirror-unconfirmed' });
            logger.warn({ err, id: row.id, sourceUrl }, '[backfillImages] wiki per-row error — skip');
            wikiFailed++;
          }
        }
      }

      await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => wikiWorker()));
    } catch (err) {
      runtime.recordFailure('migration:backfill-images:wiki', new Error('Accepted wiki backfill was incomplete'), { operationId, stage: 'source-query-or-run-incomplete' });
      logger.error({ err, action: 'backfill-images' }, 'Migration: backfill-images wiki query/run failed');
    }

    logger.info(
      { audit: 'migration-key', action: 'backfill-images', wiki: { total: wikiTotal, mirrored: wikiMirrored, skipped: wikiSkipped, failed: wikiFailed } },
      'Migration: backfill-images wiki phase complete',
    );

    // ── 2. Camp images (optional) ──────────────────────────────────────────────
    if (!includeCamp) {
      logger.info({ action: 'backfill-images' }, 'Migration: backfill-images camp phase skipped (not requested; camp images self-ingest on first load)');
      return;
    }

    // Camp images self-populate via campImageController on first load; backfill is
    // driven from camp_items.image_key (format: camp-images/<formid>.webp).
    let campTotal    = 0;
    let campMirrored = 0;
    let campSkipped  = 0;
    let campFailed   = 0;

    const CAMP_FORM_ID_RE = /^[0-9a-f]{8}$/i;
    const CAMP_IMAGES_BASE = 'https://mrsblobby.github.io/76-CAMPDatabase/Live/Images/';
    const CAMP_MAX_BYTES   = 5 * 1024 * 1024;

    try {
      // Select all camp_items that have an image_key (the MinIO object key).
      const campRows = await prisma.$queryRaw<Array<{ image_key: string }>>`
        SELECT image_key FROM camp_items WHERE image_key IS NOT NULL AND image_key != ''
      `;

      campTotal = campRows.length;
      logger.info({ action: 'backfill-images', campTotal }, 'Migration: backfill-images camp rows queried');

      const campIter = campRows[Symbol.iterator]();

      async function campWorker(): Promise<void> {
        for (;;) {
          const { value: row, done } = campIter.next();
          if (done) return;

          const key = row.image_key; // e.g. "camp-images/00a1b2c3.webp"

          // Extract formId from the key.
          const match = key.match(/^camp-images\/([0-9a-f]{8})\.webp$/i);
          if (!match) {
            logger.warn({ key }, '[backfillImages] camp key format unexpected — skip');
            campFailed++;
            runtime.recordFailure('migration:backfill-images:camp', new Error('Accepted CAMP object key is invalid'),
              { operationId, objectKey: key, stage: 'object-key-unresolved' });
            continue;
          }
          const formId = match[1].toLowerCase();
          if (!CAMP_FORM_ID_RE.test(formId)) {
            logger.warn({ key, formId }, '[backfillImages] camp formId fails validation — skip');
            campFailed++;
            continue;
          }

              try {
            if (await headExists(key)) {
              campSkipped++;
              continue;
            }

            const sourceUrl = `${CAMP_IMAGES_BASE}${formId}.webp`;

            if (!isAllowedImageHost(sourceUrl)) {
              logger.warn({ key, sourceUrl }, '[backfillImages] camp source host not in SSRF allowlist — skip');
              campSkipped++;
              continue;
            }

            const result = await fetchRemoteImage(sourceUrl, CAMP_MAX_BYTES);
            if (!result) {
              logger.warn({ key, sourceUrl }, '[backfillImages] camp fetch failed — skip');
              campFailed++;
              runtime.recordFailure('migration:backfill-images:camp', new Error('Accepted CAMP image fetch incomplete'),
                { operationId, objectKey: key, stage: 'source-fetch-incomplete' });
              continue;
            }

            const stored = await putToMinio(key, result.buf, result.contentType);
            if (stored) {
              campMirrored++;
            } else {
              campFailed++;
              runtime.recordFailure('migration:backfill-images:camp', new Error('Accepted CAMP image store unconfirmed'),
                { operationId, objectKey: key, stage: 'object-put-result-unknown' });
            }
          } catch (err) {
            runtime.recordFailure('migration:backfill-images:camp', new Error('Accepted CAMP image mirror was not confirmed'), { operationId, objectKey: key, stage: 'object-mirror-unconfirmed' });
            logger.warn({ err, key }, '[backfillImages] camp per-row error — skip');
            campFailed++;
          }
        }
      }

      await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, () => campWorker()));
    } catch (err) {
      runtime.recordFailure('migration:backfill-images:camp', new Error('Accepted CAMP backfill was incomplete'), { operationId, stage: 'source-query-or-run-incomplete' });
      logger.error({ err, action: 'backfill-images' }, 'Migration: backfill-images camp query/run failed');
    }

    logger.info(
      { audit: 'migration-key', action: 'backfill-images', camp: { total: campTotal, mirrored: campMirrored, skipped: campSkipped, failed: campFailed } },
      'Migration: backfill-images camp phase complete',
    );
  }, { operationId, includeCamp }).catch(err => logger.error({ err, operationId }, 'Migration: accepted image backfill failed'));
}

export { runSql, dumpDatabase, restoreDatabase, dumpStorage, restoreStorage, backfillImages };
module.exports = { runSql, dumpDatabase, restoreDatabase, dumpStorage, restoreStorage, backfillImages };
