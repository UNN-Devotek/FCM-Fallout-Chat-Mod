/**
 * wikiImageService — download wiki images, compute sha256, derive aspect ratio,
 * and mirror to MinIO under the wiki-images/ prefix.
 *
 * Used exclusively by wikiIngestionService (ingestion-only, never request paths).
 * On MinIO failure: returns imageUrl=null, keeps imageSourceUrl, never throws.
 */

import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from '../config/storage';
import { isAllowedImageHost, ensureBucketOnce, fetchRemoteImage } from '../lib/imageStorage';
import logger from '../config/logger';
import env from '../config/environment';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB safety cap

export type ImageAspect = 'ultrawide' | 'portrait' | 'square' | 'unknown';

export interface WikiImageResult {
  imageUrl:        string | null;
  imageMime:       string | null;
  imageWidth:      number | null;
  imageHeight:     number | null;
  imageAspect:     ImageAspect;
  imageSourceUrl:  string | null;
}

/** Derive the aspect bucket from pixel dimensions. */
export function deriveImageAspect(
  width:  number | null | undefined,
  height: number | null | undefined,
): ImageAspect {
  if (!width || !height || width <= 0 || height <= 0) return 'unknown';
  const ratio = width / height;
  if (ratio >= 2.2)            return 'ultrawide';
  if (height / width >= 1.3)   return 'portrait';
  return 'square';
}

/**
 * Download an image from `sourceUrl`, compute its sha256, and upload it to
 * MinIO under `wiki-images/<pageId>-<hash8>.webp` (content-addressed).
 * Skips the upload when the derived key already matches `existingHash`.
 *
 * Returns a result object — never throws.
 */
export async function mirrorWikiImage(
  pageId:        number,
  sourceUrl:     string,
  existingHash:  string | null,
  width?:        number | null,
  height?:       number | null,
): Promise<WikiImageResult> {
  const fallback: WikiImageResult = {
    imageUrl:       null,
    imageMime:      null,
    imageWidth:     width  ?? null,
    imageHeight:    height ?? null,
    imageAspect:    deriveImageAspect(width, height),
    imageSourceUrl: sourceUrl,
  };

  // SSRF allowlist check — reject hosts not on the allowlist
  if (!isAllowedImageHost(sourceUrl)) {
    logger.warn({ sourceUrl, pageId }, '[wikiImage] rejected: host not in SSRF allowlist');
    return fallback;
  }

  try {
    const result = await fetchRemoteImage(sourceUrl, MAX_IMAGE_BYTES);
    if (!result) return fallback;

    const { buf, contentType } = result;

    const hash   = crypto.createHash('sha256').update(buf).digest('hex');
    const hash8  = hash.slice(0, 8);

    // Skip upload when hash unchanged (same key in MinIO = same file)
    if (existingHash && existingHash === hash) {
      // Re-derive the URL from the hash — don't trust any cached url field
      const publicBase = env.MINIO_PUBLIC_URL || `${env.MINIO_ENDPOINT}/${BUCKET}`;
      const key        = `wiki-images/${pageId}-${hash8}.webp`;
      return {
        imageUrl:       `${publicBase}/${key}`,
        imageMime:      contentType,
        imageWidth:     width  ?? null,
        imageHeight:    height ?? null,
        imageAspect:    deriveImageAspect(width, height),
        imageSourceUrl: sourceUrl,
      };
    }

    await ensureBucketOnce();

    const key = `wiki-images/${pageId}-${hash8}.webp`;
    await s3.send(new PutObjectCommand({
      Bucket:       BUCKET,
      Key:          key,
      Body:         buf,
      ContentType:  contentType,
      CacheControl: 'public, max-age=31536000',
    }));

    const publicBase = env.MINIO_PUBLIC_URL || `${env.MINIO_ENDPOINT}/${BUCKET}`;
    logger.debug({ pageId, key, mime: contentType, bytes: buf.length }, '[wikiImage] uploaded');

    return {
      imageUrl:       `${publicBase}/${key}`,
      imageMime:      contentType,
      imageWidth:     width  ?? null,
      imageHeight:    height ?? null,
      imageAspect:    deriveImageAspect(width, height),
      imageSourceUrl: sourceUrl,
    };
  } catch (err) {
    logger.warn({ err, pageId, sourceUrl }, '[wikiImage] mirror failed (non-fatal), using fallback');
    return fallback;
  }
}
