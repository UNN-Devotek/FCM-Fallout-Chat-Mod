/**
 * MinIO storage for ban evidence (separate bucket so it has its own ACL +
 * lifecycle from avatars). Backend-proxied reads via /api/moderation/bans/
 * :id/evidence/:fileId — no public URLs, no signed-URL juggling.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import env from '../config/environment';
import logger from '../config/logger';

const BUCKET = 'ban-evidence';

const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: env.MINIO_ROOT_USER, secretAccessKey: env.MINIO_ROOT_PASSWORD },
  forcePathStyle: true,
});

let bucketReady: Promise<void> | null = null;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      logger.info({ bucket: BUCKET }, 'Created ban-evidence bucket');
    }
  })();
  return bucketReady;
}

export interface UploadedEvidence { objectKey: string; mime: string; sizeBytes: number }

/**
 * Sniff the actual image type from the first ~16 bytes (magic numbers) so we
 * don't trust the uploader's multer-reported MIME. Returns null when the bytes
 * don't match any whitelisted image format — caller should reject.
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG  : 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
      && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return 'image/png';
  }
  // JPEG : FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return 'image/jpeg';
  }
  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
      && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'image/gif';
  }
  // WebP : "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * Upload a piece of ban evidence to MinIO. Verifies the actual file content
 * via magic-byte sniffing — the client-declared MIME from multer is IGNORED.
 * Returns the canonical MIME we detected (so the DB row stores ground truth).
 * Throws if the bytes don't match a whitelisted image format.
 */
export async function uploadEvidence(buf: Buffer, _clientMime: string): Promise<UploadedEvidence> {
  const actualMime = sniffImageMime(buf);
  if (!actualMime) {
    throw new Error('Uploaded file is not a valid PNG/JPEG/GIF/WebP image');
  }
  await ensureBucket();
  const ext = actualMime === 'image/png' ? 'png'
            : actualMime === 'image/gif' ? 'gif'
            : actualMime === 'image/webp' ? 'webp'
            : 'jpg';
  const objectKey = `${randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: objectKey, Body: buf, ContentType: actualMime }));
  return { objectKey, mime: actualMime, sizeBytes: buf.length };
}

export async function downloadEvidence(objectKey: string): Promise<{ stream: Readable; mime?: string; sizeBytes?: number } | null> {
  await ensureBucket();
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey }));
    return { stream: r.Body as Readable, mime: r.ContentType, sizeBytes: r.ContentLength };
  } catch (err) {
    logger.warn({ err, objectKey }, 'ban evidence not found');
    return null;
  }
}

export async function deleteEvidence(objectKey: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: objectKey })).catch(() => {});
}

export default { uploadEvidence, downloadEvidence, deleteEvidence };
module.exports = { uploadEvidence, downloadEvidence, deleteEvidence };
