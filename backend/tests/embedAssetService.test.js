const { PassThrough } = require('stream');

const prismaMock = {
  embedAsset: {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));

const { fileTypeFromBuffer } = require('file-type');
const { embedAssetPolicy, fetchRemoteImage, importEmbedAsset, uploadPublicAsset } = require('../src/services/embedAssetService');

function fakeRequest(responses) {
  return (_url, options, callback) => {
    const request = new PassThrough();
    request.setTimeout = jest.fn();
    request.end = () => {
      const next = responses.shift();
      const response = new PassThrough();
      response.statusCode = next.status ?? 200;
      response.headers = next.headers ?? {};
      response.once('close', () => request.destroy());
      request.once('close', () => response.destroy());
      callback(response);
      if (next.body) response.end(next.body); else response.end();
    };
    // Ensure the implementation pins the socket lookup rather than letting the
    // HTTP client perform an unchecked second DNS resolution.
    expect(options.lookup).toEqual(expect.any(Function));
    return request;
  };
}

function fakeRequestInvokingAllLookup(responses, observed) {
  return (url, options, callback) => {
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      observed.push({ error, addresses });
    });
    return fakeRequest(responses)(url, options, callback);
  };
}

describe('embed asset network policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.embedAsset.create.mockImplementation(async ({ data }) => data);
    prismaMock.embedAsset.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.embedAsset.deleteMany.mockResolvedValue({ count: 1 });
  });
  test.each([
    'http://example.com/a.png',
    'https://user:secret@example.com/a.png',
    'https://example.com:8443/a.png',
    'https://example.com/a.png#fragment',
  ])('rejects unsafe URL %s', url => expect(() => embedAssetPolicy.parseRemoteUrl(url)).toThrow());

  test.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1',
    '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b:1::1', '100::1', '2001::1', '2001:2::1',
    '2001:20::1', '2001:db8::1', '3ffe::1', '3fff::1', '5f00::1', 'fd00::1', 'fe80::1', 'ff00::1',
  ])
    ('blocks non-public address %s', address => expect(embedAssetPolicy.isPublicIp(address)).toBe(false));
  test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    ('permits public address %s', address => expect(embedAssetPolicy.isPublicIp(address)).toBe(true));

  it('honors Node lookup all=true by returning pinned LookupAddress records', async () => {
    const observed = [];
    const pinned = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    await fetchRemoteImage('https://safe.example/image.png', {
      lookup: async () => pinned,
      request: fakeRequestInvokingAllLookup([{ body: Buffer.from('image') }], observed),
    });
    expect(observed).toEqual([{ error: null, addresses: pinned }]);
  });

  it('retains the scalar callback contract when all is not requested', () => {
    const lookup = embedAssetPolicy.makePinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    const callback = jest.fn();
    lookup('safe.example', { family: 4, all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('revalidates every redirect and blocks a private destination', async () => {
    const lookup = jest.fn(async host => host === 'safe.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchRemoteImage('https://safe.example/start', {
      lookup,
      request: fakeRequest([{ status: 302, headers: { location: 'https://private.example/image.png' } }]),
    })).rejects.toThrow('non-public');
  });

  it('fails closed when DNS changes while the response is in flight', async () => {
    const lookup = jest.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    await expect(fetchRemoteImage('https://safe.example/image.png', {
      lookup, request: fakeRequest([{ body: Buffer.from('image') }]),
    })).rejects.toThrow('changed during fetch');
  });

  it('rejects streamed overflow even when Content-Length is absent', async () => {
    const huge = Buffer.alloc(embedAssetPolicy.MAX_BYTES + 1);
    await expect(fetchRemoteImage('https://safe.example/image.png', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ body: huge }]),
    })).rejects.toThrow('10 MiB');
  });

  it('rejects a declared Content-Length over the cap before reading', async () => {
    await expect(fetchRemoteImage('https://safe.example/image.png', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ headers: { 'content-length': String(embedAssetPolicy.MAX_BYTES + 1) }, body: Buffer.alloc(1) }]),
    })).rejects.toThrow('10 MiB');
  });

  it('rejects short and overlong bodies that mismatch Content-Length', async () => {
    const deps = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
    await expect(fetchRemoteImage('https://safe.example/short.png', {
      ...deps, request: fakeRequest([{ headers: { 'content-length': '10' }, body: Buffer.alloc(3) }]),
    })).rejects.toThrow('did not match');
    await expect(fetchRemoteImage('https://safe.example/long.png', {
      ...deps, request: fakeRequest([{ headers: { 'content-length': '2' }, body: Buffer.alloc(3) }]),
    })).rejects.toThrow('did not match');
  });

  it('allows no more than three redirects', async () => {
    const responses = Array.from({ length: 4 }, (_, i) => ({ status: 302, headers: { location: `/hop-${i}` } }));
    await expect(fetchRemoteImage('https://safe.example/start', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest(responses),
    })).rejects.toThrow('Too many');
  });

  it('applies the total deadline while DNS is pending', async () => {
    jest.useFakeTimers();
    try {
      const pending = fetchRemoteImage('https://safe.example/image.png', {
        lookup: () => new Promise(() => {}), request: fakeRequest([]),
      });
      const rejection = expect(pending).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(embedAssetPolicy.DEADLINE_MS + 1);
      await rejection;
    } finally { jest.useRealTimers(); }
  });

  it('sniffs MIME, stores by digest, and deduplicates without a second upload', async () => {
    const bytes = Buffer.from('real-png-bytes');
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const upload = jest.fn().mockResolvedValue(true);
    const deps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ body: bytes }]), upload,
    };
    const first = await importEmbedAsset('https://safe.example/image', 'discord-id', deps);
    expect(first.objectKey).toMatch(/^embed-assets\/[a-f0-9]{64}\.png$/);
    expect(first.originalHost).toBe('safe.example');
    expect(first.status).toBe('ready');
    expect(upload).toHaveBeenCalledTimes(1);

    prismaMock.embedAsset.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.embedAsset.findUnique.mockResolvedValueOnce({ id: 'existing', sha256: 'same', status: 'ready' });
    const second = await importEmbedAsset('https://safe.example/image', 'discord-id', {
      ...deps, request: fakeRequest([{ body: bytes }]),
    });
    expect(second.id).toBe('existing');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('uploads validated base64 files without a network fetch', async () => {
    const bytes = Buffer.from('%PDF-1.7\nexample');
    fileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    const upload = jest.fn().mockResolvedValue(true);
    const asset = await uploadPublicAsset(bytes.toString('base64'), 'application/pdf', 'discord-id', { upload });
    expect(asset).toEqual(expect.objectContaining({ mimeType: 'application/pdf', originalHost: 'mcp-upload', status: 'ready' }));
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^embed-assets\/[a-f0-9]{64}\.pdf$/), bytes, 'application/pdf');
  });

  it('rejects malformed base64, oversized files, MIME spoofing, and unsafe text', async () => {
    await expect(uploadPublicAsset('not base64!', 'text/plain', null)).rejects.toThrow('canonical base64');
    await expect(uploadPublicAsset(Buffer.alloc(embedAssetPolicy.MAX_BYTES + 1).toString('base64'), 'text/plain', null)).rejects.toThrow('10 MiB');
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    await expect(uploadPublicAsset(Buffer.from('fake').toString('base64'), 'application/pdf', null)).rejects.toThrow('do not match');
    await expect(uploadPublicAsset(Buffer.from([0, 1, 2]).toString('base64'), 'text/plain', null)).rejects.toThrow('NUL');
  });

  it('accepts UTF-8 text and valid JSON but rejects invalid JSON', async () => {
    const upload = jest.fn().mockResolvedValue(true);
    await expect(uploadPublicAsset(Buffer.from('hello').toString('base64'), 'text/plain', null, { upload })).resolves.toEqual(expect.objectContaining({ mimeType: 'text/plain' }));
    await expect(uploadPublicAsset(Buffer.from('{"ok":true}').toString('base64'), 'application/json', null, { upload })).resolves.toEqual(expect.objectContaining({ mimeType: 'application/json' }));
    await expect(uploadPublicAsset(Buffer.from('{bad').toString('base64'), 'application/json', null, { upload })).rejects.toThrow('valid JSON');
  });

  it('rejects HTML even when served with an image-style URL', async () => {
    fileTypeFromBuffer.mockResolvedValue(undefined);
    prismaMock.embedAsset.findUnique.mockResolvedValue(null);
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ body: Buffer.from('<html>no</html>') }]), upload: jest.fn(),
    })).rejects.toThrow('supported PNG');
  });

  it('does not insert metadata when object storage upload fails', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    prismaMock.embedAsset.findUnique.mockResolvedValue(null);
    const upload = jest.fn().mockRejectedValue(new Error('storage unavailable'));
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ body: Buffer.from('png') }]), upload,
    })).rejects.toThrow('storage unavailable');
    expect(prismaMock.embedAsset.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'pending' }) }));
    expect(prismaMock.embedAsset.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'pending' }) }));
  });

  it('cleans up only its owned pending claim when publication fails', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const upload = jest.fn().mockResolvedValue(true);
    const remove = jest.fn();
    prismaMock.embedAsset.updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest([{ body: Buffer.from('png') }]), upload, remove,
    })).rejects.toThrow('database unavailable');
    expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^embed-assets\/[a-f0-9]{64}\.png$/));
  });

  it('never compensation-deletes a content-addressed object this request did not create', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    prismaMock.embedAsset.updateMany.mockRejectedValueOnce(new Error('database unavailable'));
    const upload = jest.fn().mockResolvedValue(false); // another importer won If-None-Match
    const remove = jest.fn();
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest([{ body: Buffer.from('png') }]), upload, remove,
    })).rejects.toThrow('database unavailable');
    expect(remove).not.toHaveBeenCalled();
  });

  it('deterministically keeps B from adopting A pending, then lets A safely clean up', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    let releaseUpload;
    const upload = jest.fn(() => new Promise(resolve => { releaseUpload = resolve; }));
    const remove = jest.fn();
    const requestDeps = () => ({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fakeRequest([{ body: Buffer.from('same-image') }]), upload, remove,
    });
    const ownerClaim = {
      id: 'owner-id', status: 'pending', claimToken: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: new Date('2099-01-01T00:00:00Z'),
    };
    prismaMock.embedAsset.create.mockResolvedValueOnce(ownerClaim).mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.embedAsset.findUnique.mockResolvedValueOnce(ownerClaim);
    const owner = importEmbedAsset('https://safe.example/a.png', null, requestDeps());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await expect(importEmbedAsset('https://safe.example/b.png', null, requestDeps())).rejects.toMatchObject({ status: 409 });
    prismaMock.embedAsset.updateMany.mockRejectedValueOnce(new Error('publish failed'));
    releaseUpload(true);
    await expect(owner).rejects.toThrow('publish failed');
    expect(prismaMock.embedAsset.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: 'owner-id', status: 'pending' }) });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns a ready digest winner without uploading from the conflicting importer', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const ready = { id: 'ready-id', sha256: 'digest', status: 'ready' };
    prismaMock.embedAsset.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.embedAsset.findUnique.mockResolvedValueOnce(ready);
    const upload = jest.fn();
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest([{ body: Buffer.from('png') }]), upload,
    })).resolves.toBe(ready);
    expect(upload).not.toHaveBeenCalled();
  });

  it('atomically takes over an expired pending claim and recovers a prior uploaded object', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const expired = {
      id: 'stale-id', sha256: 'digest', status: 'pending', claimToken: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: new Date('2026-01-01T00:00:00Z'), objectKey: `embed-assets/${'a'.repeat(64)}.png`,
    };
    prismaMock.embedAsset.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.embedAsset.findUnique.mockResolvedValueOnce(expired);
    prismaMock.embedAsset.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const upload = jest.fn().mockResolvedValue(false); // crashed owner completed the PUT
    const result = await importEmbedAsset('https://safe.example/image.png', 'new-owner', {
      now: () => new Date('2026-01-01T00:10:00Z').getTime(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest([{ body: Buffer.from('png') }]), upload,
    });
    expect(prismaMock.embedAsset.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'stale-id', status: 'pending', claimToken: expired.claimToken, leaseExpiresAt: { lte: expect.any(Date) } },
      data: { claimToken: expect.any(String), leaseExpiresAt: expect.any(Date) },
    });
    const newToken = prismaMock.embedAsset.updateMany.mock.calls[0][0].data.claimToken;
    expect(prismaMock.embedAsset.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: 'stale-id', status: 'pending', claimToken: newToken },
      data: { status: 'ready', claimToken: null, leaseExpiresAt: null },
    });
    expect(result).toMatchObject({ id: 'stale-id', status: 'ready', claimToken: null, leaseExpiresAt: null });
  });

  it('prevents a stale owner from publishing or deleting after takeover', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    prismaMock.embedAsset.create.mockImplementationOnce(async ({ data }) => ({ ...data, id: 'old-owner-id' }));
    prismaMock.embedAsset.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.embedAsset.deleteMany.mockResolvedValueOnce({ count: 0 });
    const upload = jest.fn().mockResolvedValue(true);
    const remove = jest.fn();
    await expect(importEmbedAsset('https://safe.example/image.png', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: fakeRequest([{ body: Buffer.from('png') }]), upload, remove,
    })).rejects.toThrow('ownership was lost');
    const publishOwner = prismaMock.embedAsset.updateMany.mock.calls[0][0].where.claimToken;
    const cleanupOwner = prismaMock.embedAsset.deleteMany.mock.calls[0][0].where.claimToken;
    expect(cleanupOwner).toBe(publishOwner);
    expect(remove).not.toHaveBeenCalled();
  });
});
