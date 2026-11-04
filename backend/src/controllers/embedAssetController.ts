import type { NextFunction, Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import prisma from '../config/prisma';
import { getEmbedAssetObject } from '../config/storage';
import { createError } from '../middleware/errorHandler';
import { EmbedAssetError, importEmbedAsset } from '../services/embedAssetService';

export async function importDiscordEmbedAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sourceUrl = req.body?.sourceUrl;
  if (typeof sourceUrl !== 'string' || sourceUrl.length > 4096) return next(createError(400, 'sourceUrl is required'));
  if (req.body?.confirm !== true) return next(createError(400, 'confirm must be true to import an external image'));
  const discordUser = (req.session as { discordUser?: { id?: unknown } }).discordUser;
  const creatorDiscordId = typeof discordUser?.id === 'string' ? discordUser.id : null;
  try {
    const asset = await importEmbedAsset(sourceUrl, creatorDiscordId);
    res.status(201).json({ data: asset });
  } catch (error) {
    if (error instanceof EmbedAssetError) return next(createError(error.status, error.message));
    next(error);
  }
}

export async function serveEmbedAsset(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const filename = String(req.params.filename ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      !/^[a-f0-9]{64}\.(png|jpg|webp|gif|pdf|txt|csv|json)$/i.test(filename)) {
    res.status(404).end(); return;
  }
  const sha256 = filename.slice(0, 64).toLowerCase();
  const asset = await prisma.embedAsset.findFirst({ where: { id, sha256, status: 'ready' } });
  if (!asset) { res.status(404).end(); return; }
  if (asset.objectKey !== `embed-assets/${filename.toLowerCase()}`) { res.status(404).end(); return; }
  const object = await getEmbedAssetObject(asset.objectKey);
  if (!object) { res.status(404).end(); return; }
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (!asset.mimeType.startsWith('image/')) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (object.contentLength != null) res.setHeader('Content-Length', String(object.contentLength));
  try {
    // A disconnected output cancels this read-only body. Await its real stream
    // teardown so the HTTP work lease survives until the underlying read closes.
    await pipeline(object.body, res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}
