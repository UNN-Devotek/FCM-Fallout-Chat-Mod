/**
 * partyImageController.ts
 *
 * POST /api/parties/upload-image
 *
 * Accepts a multipart/form-data upload with a single field named "image".
 * Validates MIME type (image/* only) and file size (≤ 8 MB), then stores
 * the image in MinIO under the party-images/ prefix and returns a public URL
 * served from our own domain via GET /party-images/:id.
 *
 * Auth: requireClientAuth (X-Auth-Token session header).
 * Rate-limit: partyImageUploadLimiter (10 uploads / min per token).
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { uploadPartyImage } from '../config/storage';
import logger from '../config/logger';

const ALLOWED_MIME_PREFIX = 'image/';
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

// Map common MIME types to file extensions for the stored key.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function extForMime(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? 'bin';
}

/**
 * POST /api/parties/upload-image
 * Requires: requireClientAuth middleware + multer memoryStorage (done in the router).
 */
export async function uploadPartyImageHandler(req: Request, res: Response): Promise<void> {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ error: 'No image file provided. Send a multipart/form-data request with field "image".' });
    return;
  }

  const mime = (file.mimetype || '').toLowerCase();
  if (!mime.startsWith(ALLOWED_MIME_PREFIX)) {
    res.status(415).json({ error: `Unsupported media type "${mime}". Only image/* files are accepted.` });
    return;
  }

  if (file.size > MAX_BYTES) {
    res.status(413).json({ error: `Image too large (${file.size} bytes). Maximum is ${MAX_BYTES / (1024 * 1024)} MB.` });
    return;
  }

  const imageId = uuidv4();
  const ext = extForMime(mime);

  try {
    const servedUrl = await uploadPartyImage(imageId, ext, file.buffer, mime);
    logger.info({ userId: req.user?.id, imageId, mime, bytes: file.size }, '[party-image] uploaded');
    res.status(201).json({ url: servedUrl });
  } catch (err) {
    logger.error({ err, userId: req.user?.id, imageId }, '[party-image] MinIO upload failed');
    res.status(500).json({ error: 'Image upload failed. Please try again.' });
  }
}
