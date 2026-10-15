import { isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import { randomBytes } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import https from 'https';
import prisma from '../config/prisma';
import { isPublicNetworkAddress } from './publicNetworkAddressPolicy';

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60 * 1000;
const cimdCache = new Map<string, { expiresAt: number; metadata: McpClientMetadata }>();
type FetchDeps = { lookup: typeof dnsLookup; request: typeof https.request };
const fetchDefaults: FetchDeps = { lookup: dnsLookup, request: https.request };

export class McpClientMetadataError extends Error {}

export interface McpClientMetadata {
  client_id?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

function parseHttps(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new McpClientMetadataError('client_id must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new McpClientMetadataError('client metadata URL must use credential-free HTTPS on the default port');
  }
  return url;
}

export async function fetchClientMetadataJson(url: URL, overrides: Partial<FetchDeps> = {}): Promise<unknown> {
  const deps = { ...fetchDefaults, ...overrides };
  let resolved;
  try { resolved = await deps.lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw new McpClientMetadataError('client metadata host could not be resolved'); }
  const addresses = resolved.filter(a => a.family === 4 || a.family === 6);
  if (!addresses.length || addresses.some(a => !isPublicNetworkAddress(a.address))) throw new McpClientMetadataError('client metadata host is not public');
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof https.request> | undefined;
    let response: import('http').IncomingMessage | undefined;
    let requestClosed = false, responseEnded = false, responseClosed = false, settled = false;
    let outcome: { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | undefined;
    const complete = () => {
      if (settled || !outcome || request && !requestClosed || response && !responseEnded && !responseClosed) return;
      settled = true;
      if (outcome.kind === 'error') reject(outcome.error); else resolve(outcome.value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      if (outcome?.kind !== 'error') outcome = { kind: 'error', error };
      // A rejected header/result or destroy() request does not complete a read.
      // Join the real request close and response end/cancellation close first.
      request?.destroy(error instanceof Error ? error : undefined);
      response?.destroy(error instanceof Error ? error : undefined);
      complete();
    };
    try {
      request = deps.request(url, {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'FCM-MCP-OAuth/1.0' },
        lookup: (_host, options, callback) => {
          const family = typeof options === 'object' ? options.family : 0;
          const eligible = family === 4 || family === 6 ? addresses.filter(a => a.family === family) : addresses;
          if (typeof options === 'object' && options.all) return (callback as Function)(null, eligible);
          const selected = eligible[0];
          if (!selected) return (callback as Function)(new Error('No validated address'));
          return (callback as Function)(null, selected.address, selected.family);
        },
      }, incoming => {
        response = incoming;
        incoming.once('end', () => { responseEnded = true; complete(); });
        incoming.once('close', () => {
          responseClosed = true;
          if (!responseEnded && !outcome) fail(new McpClientMetadataError('client metadata response ended before completion'));
          complete();
        });
        incoming.once('error', fail);
        incoming.once('aborted', () => fail(new McpClientMetadataError('client metadata response was aborted')));
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) return fail(new McpClientMetadataError('client metadata redirects are not allowed'));
        if (status !== 200) return fail(new McpClientMetadataError(`client metadata returned HTTP ${status}`));
        const contentType = String(incoming.headers['content-type'] || '').split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/i.test(contentType)) return fail(new McpClientMetadataError('client metadata must use a JSON media type'));
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) fail(new McpClientMetadataError('client metadata is too large')); else chunks.push(chunk);
        });
        incoming.once('end', () => {
          if (outcome?.kind === 'error') return;
          try { outcome = { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }; complete(); }
          catch { fail(new McpClientMetadataError('client metadata is invalid JSON')); }
        });
      });
      request.on('error', fail);
      request.once('close', () => {
        requestClosed = true;
        if (!response && !outcome) fail(new McpClientMetadataError('client metadata request ended before a response'));
        complete();
      });
      request.setTimeout(TIMEOUT_MS, () => fail(new McpClientMetadataError('client metadata fetch timed out')));
      request.end();
    } catch (error) { fail(error); }
  });
}

export function validateRedirectUri(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new McpClientMetadataError('redirect_uri is invalid'); }
  if (url.hash || url.username || url.password) throw new McpClientMetadataError('redirect_uri contains forbidden components');
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) throw new McpClientMetadataError('redirect_uri must use HTTPS or an HTTP loopback host');
  return raw;
}

function isHttpLoopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost');
}

/**
 * Redirects are byte-exact by default. RFC 8252 permits a native loopback
 * client to register its callback without a port and choose an ephemeral port
 * when it launches its local listener. Codex publishes precisely that metadata.
 */
export function matchesRegisteredRedirectUri(registeredUris: readonly string[], requested: string): boolean {
  if (registeredUris.includes(requested)) return true;
  let callback: URL;
  try { callback = new URL(requested); } catch { return false; }
  if (!isHttpLoopback(callback) || !callback.port || callback.hash || callback.username || callback.password) return false;
  return registeredUris.some(registered => {
    let metadata: URL;
    try { metadata = new URL(registered); } catch { return false; }
    return isHttpLoopback(metadata) && !metadata.port && !metadata.hash && !metadata.username && !metadata.password
      && metadata.hostname === callback.hostname && metadata.pathname === callback.pathname && metadata.search === callback.search;
  });
}

export function validateClientMetadata(value: unknown, options: { cimd?: boolean } = {}): McpClientMetadata {
  if (!value || typeof value !== 'object') throw new McpClientMetadataError('client metadata must be an object');
  const input = value as Record<string, unknown>;
  if (options.cimd) {
    if (typeof input.client_id !== 'string') throw new McpClientMetadataError('CIMD client_id is required');
    const clientUrl = parseHttps(input.client_id);
    if (clientUrl.pathname === '/' || clientUrl.pathname === '') throw new McpClientMetadataError('CIMD client_id URL must include a metadata path');
    if (typeof input.client_name !== 'string' || input.client_name.trim().length < 1 || input.client_name.length > 100) throw new McpClientMetadataError('CIMD client_name must contain 1-100 characters');
  }
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 10) throw new McpClientMetadataError('redirect_uris must contain 1-10 exact URLs');
  const redirects = input.redirect_uris.map(value => { if (typeof value !== 'string') throw new McpClientMetadataError('redirect URI must be a string'); return validateRedirectUri(value); });
  if (new Set(redirects).size !== redirects.length) throw new McpClientMetadataError('redirect_uris must be unique');
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== 'none') throw new McpClientMetadataError('only public clients are supported');
  if (input.grant_types !== undefined && (!Array.isArray(input.grant_types) || input.grant_types.some(v => v !== 'authorization_code' && v !== 'refresh_token'))) throw new McpClientMetadataError('unsupported grant_type');
  if (input.response_types !== undefined && (!Array.isArray(input.response_types) || input.response_types.some(v => v !== 'code'))) throw new McpClientMetadataError('only code response_type is supported');
  return { redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(typeof input.client_id === 'string' ? { client_id: input.client_id } : {}), ...(typeof input.client_name === 'string' ? { client_name: input.client_name.slice(0, 100) } : {}) };
}

type ClientDb = Pick<typeof prisma.mcpOAuthClient, 'findUnique' | 'upsert'>;
export async function resolveOAuthClient(clientId: string, options: { fetch?: Partial<FetchDeps>; now?: () => number; db?: ClientDb } = {}) {
  return runRequiredBundle('oauth', 'mcpClientMetadataService:f8fc32ba82ac', async () => {
  const now = options.now ?? Date.now;
  const db = options.db ?? prisma.mcpOAuthClient;
  const stored = await db.findUnique({ where: { clientId } });
  if (stored?.disabledAt) throw new McpClientMetadataError('client is disabled');
  // DCR identifiers are random server-issued values. CIMD documents use a
  // deliberately short bounded cache; expiry forces DNS and document refresh.
  if (stored && !clientId.startsWith('https://')) return stored;
  const url = parseHttps(clientId);
  const cached = cimdCache.get(clientId);
  const metadata = cached && cached.expiresAt > now() ? cached.metadata : validateClientMetadata(await fetchClientMetadataJson(url, options.fetch), { cimd: true });
  if (!metadata.client_id || metadata.client_id !== clientId) throw new McpClientMetadataError('CIMD client_id must be present and exactly match its document URL');
  cimdCache.set(clientId, { metadata, expiresAt: now() + CACHE_MS });
  return runRequiredMutation('oauth', '31b9f62012cbc25a1cbb29af', { stage: 'primary-write-unconfirmed' }, () => db.upsert({ where: { clientId }, create: { clientId, metadata: metadata as object, redirectUris: metadata.redirect_uris }, update: { metadata: metadata as object, redirectUris: metadata.redirect_uris, disabledAt: null } }), isPrismaAtomicRefusal, undefined, undefined);

  });
}

export function clearCimdCacheForTests(): void { cimdCache.clear(); }

export async function registerOAuthClient(input: unknown, db: Pick<typeof prisma.mcpOAuthClient, 'create'> = prisma.mcpOAuthClient) {
  return runRequiredBundle('oauth', 'mcpClientMetadataService:67e52f2b937c', async () => {
  if (input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'client_id')) {
    throw new McpClientMetadataError('client_id is assigned by the authorization server');
  }
  const metadata = validateClientMetadata(input);
  const clientId = `fcm_client_${randomBytes(24).toString('base64url')}`;
  await runRequiredMutation('oauth', '6f4b9bb869e95ec019ce21ff', { stage: 'primary-write-unconfirmed' }, () => db.create({ data: { clientId, metadata: metadata as object, redirectUris: metadata.redirect_uris } }), isPrismaAtomicRefusal, undefined, undefined);
  return { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };

  });
}
