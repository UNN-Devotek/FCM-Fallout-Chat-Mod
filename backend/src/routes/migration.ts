import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { clientIp } from '../utils/clientIp';
import { runSql, dumpDatabase, restoreDatabase, dumpStorage, restoreStorage, backfillImages } from '../controllers/migrationController';

/**
 * Strict rate limiter for migration endpoints: 10 requests / 15 min per IP.
 * These are heavyweight, privileged operations — the key gate is the primary
 * security control; this limiter is a backstop against accidental hammering.
 */
const migrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Migration endpoint rate limit exceeded.',
  },
});

const router = Router();

router.use(migrationLimiter);

// Raw body for restore (the SQL dump may be large; set limit to 512 MB).
// The json body parser in server.ts only captures JSON payloads; the restore
// endpoint reads raw text, so we use express.raw() locally.
import express from 'express';
router.post(
  '/restore',
  express.raw({ type: ['text/plain', 'application/sql', 'application/octet-stream'], limit: '512mb' }),
  restoreDatabase,
);

router.post('/sql', runSql);
router.post('/dump', dumpDatabase);

// Object-store (MinIO) dump — streams a .tar of wiki-images/ + camp-images/
router.post('/storage/dump', dumpStorage);

// Object-store restore — raw stream body (no body-parser; global express.json() only
// fires for application/json, so callers must send application/x-tar or
// application/octet-stream to avoid accidental buffering).
router.post('/storage/restore', restoreStorage);

// Re-fetch wiki (and optionally camp) images from their Fandom/mrsblobby source
// into prod MinIO.  Body: { camp?: boolean }  Responds 202 immediately.
router.post('/backfill-images', express.json({ limit: '1mb' }), backfillImages);

export default router;
module.exports = router;
