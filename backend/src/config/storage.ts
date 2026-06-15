import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import env from './environment';
import logger from './logger';

const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT, // defaults to http://minio:9700 (see environment.ts)
  region: 'us-east-1',
  credentials: {
    accessKeyId: env.MINIO_ROOT_USER,
    secretAccessKey: env.MINIO_ROOT_PASSWORD,
  },
  forcePathStyle: true, // required for MinIO
});

const BUCKET = env.MINIO_BUCKET || 'avatars';

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    logger.info({ bucket: BUCKET }, 'Created MinIO bucket');
  }
}

async function uploadAvatar(discordId: string, imageBuffer: Buffer, contentType: string): Promise<string> {
  const key = `avatars/${discordId}.png`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: imageBuffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=86400',
  }));
  // Return the public URL path
  const publicBase = env.MINIO_PUBLIC_URL || `${env.MINIO_ENDPOINT}/${BUCKET}`;
  return `${publicBase}/${key}`;
}

/**
 * Fetch a stored avatar object for streaming back to the client. Returns the
 * readable body + content type, or null when the object does not exist (so the
 * route can serve a 404 / default). Key matches uploadAvatar: avatars/<id>.png.
 */
async function getAvatarObject(discordId: string): Promise<{ body: Readable; contentType: string; contentLength?: number } | null> {
  const key = `avatars/${discordId}.png`;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType || 'image/png',
      contentLength: out.ContentLength,
    };
  } catch {
    // NoSuchKey / NoSuchBucket / transport error → treat as missing.
    return null;
  }
}

/**
 * Store a party chat image in MinIO and return the served URL path.
 * Key format: party-images/<uuid>.<ext>
 */
async function uploadPartyImage(
  imageId: string,
  ext: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  const key = `party-images/${imageId}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: imageBuffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=86400',
  }));
  // Return a path served through our own domain (see /party-images/:id route in server.ts).
  return `/party-images/${imageId}.${ext}`;
}

/**
 * Fetch a stored party image object for streaming. Returns body + content-type,
 * or null when the object does not exist.
 */
async function getPartyImageObject(
  imageId: string,
  ext: string,
): Promise<{ body: Readable; contentType: string; contentLength?: number } | null> {
  const key = `party-images/${imageId}.${ext}`;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType || 'application/octet-stream',
      contentLength: out.ContentLength,
    };
  } catch {
    return null;
  }
}

export { s3, BUCKET, ensureBucket, uploadAvatar, getAvatarObject, uploadPartyImage, getPartyImageObject };
