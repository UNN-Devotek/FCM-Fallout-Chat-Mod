import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation, runRequiredEffect, isConfirmedObjectRefusal } from '../lib/requiredEffects';
import { createHash, randomUUID } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import type { LookupAddress } from 'dns';
import https from 'https';
import type { IncomingMessage } from 'http';
import type { LookupFunction } from 'net';
import { fileTypeFromBuffer } from 'file-type';
import prisma from '../config/prisma';
import env from '../config/environment';
import { deleteEmbedAsset, uploadEmbedAsset } from '../config/storage';
import { isPublicNetworkAddress as isPublicIp } from './publicNetworkAddressPolicy';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEADLINE_MS = 15_000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
} as const;
const TEXT_TYPES = { 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json' } as const;

export class EmbedAssetError extends Error {
  constructor(message: string, readonly status = 422, readonly rejectionClass: EmbedAssetRejectionClass = 'unknown') { super(message); }
}
export type EmbedAssetRejectionClass = 'scheme' | 'dns' | 'private_address' | 'redirect' | 'content_type' | 'size' | 'decode' | 'upstream' | 'unknown';

type Address = { address: string; family: 4 | 6 };
type Deps = {
  lookup: (hostname: string) => Promise<Address[]>;
  request: typeof https.request;
  now: () => number;
  upload: typeof uploadEmbedAsset;
  remove: typeof deleteEmbedAsset;
};

const defaultDeps: Deps = {
  lookup: async hostname => (await dnsLookup(hostname, { all: true, verbatim: true }))
    .filter((item): item is Address => item.family === 4 || item.family === 6),
  request: https.request,
  now: Date.now,
  upload: uploadEmbedAsset,
  remove: deleteEmbedAsset,
};

function parseRemoteUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EmbedAssetError('A valid HTTPS image URL is required', 400, 'scheme'); }
  if (url.protocol !== 'https:') throw new EmbedAssetError('Only HTTPS image URLs are allowed', 422, 'scheme');
  if (url.username || url.password) throw new EmbedAssetError('URL credentials are not allowed', 422, 'scheme');
  if (url.hash) throw new EmbedAssetError('URL fragments are not allowed', 422, 'scheme');
  if (url.port && url.port !== '443') throw new EmbedAssetError('Only the default HTTPS port is allowed', 422, 'scheme');
  if (!url.hostname || url.hostname.endsWith('.')) throw new EmbedAssetError('Malformed host', 422, 'dns');
  return url;
}

async function resolvePublic(hostname: string, deps: Deps): Promise<Address[]> {
  let addresses: Address[];
  try { addresses = await deps.lookup(hostname); } catch { throw new EmbedAssetError('Image host could not be resolved', 422, 'dns'); }
  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
    throw new EmbedAssetError('Image host resolves to a non-public address', 422, 'private_address');
  }
  return addresses;
}

async function resolveBeforeDeadline(hostname: string, deadline: number, deps: Deps): Promise<Address[]> {
  const remaining = deadline - deps.now();
  if (remaining <= 0) throw new EmbedAssetError('Image fetch timed out', 504);
  // A canceled Promise.race deadline would remain unresolved forever. One
  // result owns the timer; the real lookup and its observers still settle even
  // if the deadline wins. An uncompleted lookup therefore remains accounted.
  return new Promise<Address[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmbedAssetError('Image fetch timed out', 504)), remaining);
    resolvePublic(hostname, deps).then(addresses => {
      clearTimeout(timer);
      resolve(addresses);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sameAddresses(left: Address[], right: Address[]): boolean {
  const values = (items: Address[]) => [...new Set(items.map(item => `${item.family}:${item.address}`))].sort().join(',');
  return values(left) === values(right);
}

function makePinnedLookup(addresses: Address[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = typeof options === 'object' ? options.family : 0;
    const eligible = wanted === 4 || wanted === 6
      ? addresses.filter(item => item.family === wanted)
      : addresses;
    if (!eligible.length) {
      callback(new Error('No validated address matched the requested family'), '', 0);
      return;
    }
    if (typeof options === 'object' && options.all) {
      (callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, eligible);
      return;
    }
    const selected = eligible[0]!;
    (callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, selected.address, selected.family);
  };
}

async function requestOnce(url: URL, deadline: number, deps: Deps): Promise<{ status: number; location?: string; body?: Buffer }> {
  const addresses = await resolveBeforeDeadline(url.hostname, deadline, deps);
  const remaining = deadline - deps.now();
  if (remaining <= 0) throw new EmbedAssetError('Image fetch timed out', 504);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: ReturnType<typeof https.request> | undefined;
    let response: IncomingMessage | undefined;
    let requestClosed = false;
    let responseEnded = false;
    let responseClosed = false;
    type Result = { status: number; location?: string; body?: Buffer };
    let outcome: { kind: 'success'; value: Result } | { kind: 'error'; error: unknown } | undefined;
    // Headers, resume(), destroy(), and an error notification are not stream
    // completion. Keep this result (and its total deadline) through the actual
    // request close and response end, or the canceled response's actual close.
    const complete = () => {
      if (settled || !outcome || req && !requestClosed || response && !responseEnded && !responseClosed) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (outcome.kind === 'error') reject(outcome.error); else resolve(outcome.value);
    };
    const finish = (value: Result) => {
      if (settled || outcome?.kind === 'error') return;
      outcome = { kind: 'success', value };
      complete();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      if (outcome?.kind !== 'error') outcome = { kind: 'error', error };
      req?.destroy(error instanceof Error ? error : undefined);
      response?.destroy(error instanceof Error ? error : undefined);
      complete();
    };
    const deadlineTimer = setTimeout(() => fail(new EmbedAssetError('Image fetch timed out', 504)), remaining);
    try { req = deps.request(url, {
      method: 'GET',
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity', 'User-Agent': 'FCM-Embed-Asset-Importer/1.0' },
      lookup: makePinnedLookup(addresses),
    }, async incoming => {
      response = incoming;
      incoming.once('end', () => { responseEnded = true; complete(); });
      incoming.once('close', () => {
        responseClosed = true;
        if (!responseEnded && !outcome) fail(new EmbedAssetError('Image response ended before completion'));
        complete();
      });
      incoming.once('error', fail);
      incoming.once('aborted', () => fail(new EmbedAssetError('Image response was aborted')));
      try {
        const rebound = await resolveBeforeDeadline(url.hostname, deadline, deps);
        if (outcome?.kind === 'error') return;
        if (!sameAddresses(addresses, rebound)) throw new EmbedAssetError('Image host address changed during fetch');
        const status = incoming.statusCode ?? 502;
        const location = incoming.headers.location;
        if (status >= 300 && status < 400) { finish({ status, ...(location ? { location } : {}) }); incoming.resume(); return; }
        if (status !== 200) throw new EmbedAssetError(`Image host returned HTTP ${status}`);
        const encoding = incoming.headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw new EmbedAssetError('Compressed image responses are not accepted');
        const declared = Number(incoming.headers['content-length']);
        if (incoming.headers['content-length'] !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
          throw new EmbedAssetError('Invalid Content-Length from image host');
        }
        if (Number.isFinite(declared) && declared > MAX_BYTES) throw new EmbedAssetError('Image exceeds the 10 MiB limit', 413, 'size');
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on('data', (chunk: Buffer | string) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += data.length;
          if (total > MAX_BYTES) {
            fail(new EmbedAssetError('Image exceeds the 10 MiB limit', 413, 'size'));
          } else chunks.push(data);
        });
        incoming.once('end', () => {
          if (Number.isFinite(declared) && declared !== total) {
            fail(new EmbedAssetError('Image response length did not match Content-Length'));
            return;
          }
          finish({ status, body: Buffer.concat(chunks, total) });
        });
      } catch (error) { fail(error); }
    });
    req.on('error', fail);
    req.once('close', () => {
      requestClosed = true;
      if (!response && !outcome) fail(new EmbedAssetError('Image request ended before a response'));
      complete();
    });
    req.end();
    } catch (error) { fail(error); }
  });
}

export async function fetchRemoteImage(rawUrl: string, overrides: Partial<Deps> = {}): Promise<{ buffer: Buffer; finalUrl: URL }> {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + DEADLINE_MS;
  let url = parseRemoteUrl(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(url, deadline, deps);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new EmbedAssetError('Redirect response omitted Location', 422, 'redirect');
      if (redirects >= MAX_REDIRECTS) throw new EmbedAssetError('Too many image redirects', 422, 'redirect');
      url = parseRemoteUrl(new URL(response.location, url).toString());
      continue;
    }
    if (!response.body) throw new EmbedAssetError('Image response was empty');
    return { buffer: response.body, finalUrl: url };
  }
}

export async function importEmbedAsset(sourceUrl: string, creatorDiscordId: string | null, overrides: Partial<Deps> = {}) {
  const { buffer, finalUrl } = await fetchRemoteImage(sourceUrl, overrides);
  const detected = await fileTypeFromBuffer(buffer);
  const ext = detected && ALLOWED_TYPES[detected.mime as keyof typeof ALLOWED_TYPES];
  if (!detected || !ext || !detected.mime.startsWith('image/')) throw new EmbedAssetError('URL did not return a supported PNG, JPEG, WebP, or GIF image', 422, 'content_type');
  return persistAsset(buffer, detected.mime, ext, finalUrl.hostname, creatorDiscordId, overrides);
}

function validateUtf8Text(buffer: Buffer, mimeType: keyof typeof TEXT_TYPES): void {
  if (buffer.includes(0)) throw new EmbedAssetError('Text uploads cannot contain NUL bytes', 422, 'decode');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (mimeType === 'application/json') {
    try { JSON.parse(decoded); } catch { throw new EmbedAssetError('JSON upload is not valid JSON', 422, 'decode'); }
  }
}

export async function uploadPublicAsset(
  base64: string,
  declaredMimeType: string,
  creatorDiscordId: string | null,
  overrides: Partial<Deps> = {},
) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new EmbedAssetError('fileBase64 must be canonical base64', 400, 'decode');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.toString('base64') !== base64) throw new EmbedAssetError('fileBase64 must be canonical base64', 400, 'decode');
  if (!buffer.length) throw new EmbedAssetError('Uploaded file is empty', 400, 'decode');
  if (buffer.length > MAX_BYTES) throw new EmbedAssetError('File exceeds the 10 MiB limit', 413, 'size');
  const normalizedMime = declaredMimeType.trim().toLowerCase().split(';', 1)[0]!;
  const textExt = TEXT_TYPES[normalizedMime as keyof typeof TEXT_TYPES];
  if (textExt) {
    validateUtf8Text(buffer, normalizedMime as keyof typeof TEXT_TYPES);
    return persistAsset(buffer, normalizedMime, textExt, 'mcp-upload', creatorDiscordId, overrides);
  }
  const detected = await fileTypeFromBuffer(buffer);
  const ext = detected && ALLOWED_TYPES[detected.mime as keyof typeof ALLOWED_TYPES];
  if (!detected || !ext || detected.mime !== normalizedMime) {
    throw new EmbedAssetError('File bytes do not match an allowed PNG, JPEG, WebP, GIF, or PDF MIME type', 422, 'content_type');
  }
  return persistAsset(buffer, detected.mime, ext, 'mcp-upload', creatorDiscordId, overrides);
}

async function persistAsset(buffer: Buffer, mimeType: string, ext: string, originalHost: string, creatorDiscordId: string | null, overrides: Partial<Deps>) {
  return runRequiredBundle('domain', 'embedAssetService:90af29e21f49', async () => {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const objectKey = `embed-assets/${sha256}.${ext}`;
  const id = randomUUID();
  const claimToken = randomUUID();
  const now = new Date((overrides.now ?? defaultDeps.now)());
  const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
  const publicUrl = `${env.FCM_PUBLIC_BASE_URL.replace(/\/$/, '')}/embed-assets/${id}/${sha256}.${ext}`;
  let claim;
  try {
    claim = await runRequiredMutation('domain', 'f643ae8c1a12a2818925c02e', { stage: 'primary-write-unconfirmed', rowId: id }, () => prisma.embedAsset.create({ data: {
      id, sha256, objectKey, publicUrl, mimeType, byteSize: buffer.length,
      originalHost, creatorDiscordId, status: 'pending', claimToken, leaseExpiresAt,
    } }), isPrismaAtomicRefusal, undefined, undefined);
  } catch (error: unknown) {
    const isConflict = typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
    if (!isConflict) throw error;
    const competing = await prisma.embedAsset.findUnique({ where: { sha256 } });
    if (competing?.status === 'ready') return competing;
    if (competing?.status === 'pending') {
      if (!competing.claimToken || !competing.leaseExpiresAt || competing.leaseExpiresAt > now) {
        throw new EmbedAssetError('An import of this image is already in progress', 409);
      }
      const takeover = await runRequiredMutation('domain', '5c4c1ba38dbbf6aea7724e87', { stage: 'primary-write-unconfirmed', rowId: competing.id }, () => prisma.embedAsset.updateMany({
        where: {
          id: competing.id, sha256, status: 'pending', claimToken: competing.claimToken,
          leaseExpiresAt: { lte: now },
        },
        data: {
          claimToken, leaseExpiresAt, mimeType, byteSize: buffer.length,
          originalHost, creatorDiscordId,
        },
      }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
      if (takeover.count !== 1) throw new EmbedAssetError('An import of this image is already in progress', 409);
      claim = { ...competing, claimToken, leaseExpiresAt, mimeType, byteSize: buffer.length, originalHost, creatorDiscordId };
    } else {
      throw error;
    }
  }
  let createdObject = false;
  try {
    createdObject = await runRequiredEffect('embed-asset:managed-upload', { objectKey, sha256, rowId: claim.id,
      stage: 'managed-asset-put-unconfirmed' }, () => (overrides.upload ?? defaultDeps.upload)(objectKey, buffer, mimeType), isConfirmedObjectRefusal,
      undefined, result => result === false);
    const published = await runRequiredMutation('domain', '1ce15e6b0379a1ee1d88639f', { stage: 'primary-write-unconfirmed', rowId: claim.id }, () => prisma.embedAsset.updateMany({
      where: { id: claim.id, sha256, status: 'pending', claimToken },
      data: { status: 'ready', claimToken: null, leaseExpiresAt: null },
    }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (published.count !== 1) throw new Error('Embed asset ownership was lost before publication');
    return { ...claim, status: 'ready', claimToken: null, leaseExpiresAt: null };
  } catch (error) {
    const released = await runRequiredMutation('domain', 'a35d31730631af62c52d95ad', { stage: 'primary-write-unconfirmed', rowId: claim.id }, () => prisma.embedAsset.deleteMany({ where: { id: claim.id, sha256, status: 'pending', claimToken } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (createdObject && released.count === 1) await runRequiredEffect('embed-asset:managed-remove', { objectKey, sha256, rowId: claim.id,
      stage: 'managed-asset-remove-unconfirmed' }, () => (overrides.remove ?? defaultDeps.remove)(objectKey), isConfirmedObjectRefusal);
    throw error;
  }

  });
}

export const embedAssetPolicy = { MAX_BYTES, MAX_REDIRECTS, DEADLINE_MS, CLAIM_LEASE_MS, isPublicIp, parseRemoteUrl, makePinnedLookup };
