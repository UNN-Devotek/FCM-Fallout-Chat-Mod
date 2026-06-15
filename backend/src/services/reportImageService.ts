import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET, ensureBucket } from '../config/storage';
import { fileTypeFromBuffer } from 'file-type';
import crypto from 'crypto';
import logger from '../config/logger';
import env from '../config/environment';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 3;

// Only allow these MIME types (validated by magic bytes, not filename extension)
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

let bucketReady = false;

export class ImageUploadError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}

export async function uploadReportImages(buffers: Buffer[]): Promise<string[]> {
  if (buffers.length === 0) return [];
  if (buffers.length > MAX_FILES) throw new ImageUploadError(`Maximum ${MAX_FILES} images per report.`);

  if (!bucketReady) { await ensureBucket(); bucketReady = true; }

  const urls: string[] = [];
  for (const buf of buffers) {
    if (buf.length > MAX_FILE_SIZE) throw new ImageUploadError('Each image must be under 5 MB.');

    // Validate actual file type from magic bytes — ignoring the filename/Content-Type header
    const detected = await fileTypeFromBuffer(buf);
    if (!detected || !ALLOWED_MIME.has(detected.mime)) {
      throw new ImageUploadError('Only JPEG, PNG, WebP, and GIF images are allowed.');
    }

    // Store under a random UUID key — no user-supplied filename reaches storage
    const key = `report-images/${crypto.randomUUID()}.${MIME_TO_EXT[detected.mime]}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buf,
      ContentType: detected.mime,
      CacheControl: 'public, max-age=31536000',
    }));

    const publicBase = env.MINIO_PUBLIC_URL || `${env.MINIO_ENDPOINT}/${BUCKET}`;
    urls.push(`${publicBase}/${key}`);
    logger.info({ key, mime: detected.mime, size: buf.length }, 'Report image uploaded');
  }

  return urls;
}
