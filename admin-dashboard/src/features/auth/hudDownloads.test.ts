import { describe, expect, it } from 'vitest';
import { hudDownloads } from './hudDownloads';

describe('HUD provider downloads', () => {
  it('keeps each provider on the published environment and package revision', () => {
    const base = 'https://dev.falloutchatmod.com/downloads/electron/FCM-HUD-2.10.55-dev-r2';
    expect(hudDownloads(base + '-zfe.zip')).toEqual([
      { label: 'ZFE', url: base + '-zfe.zip' },
      { label: 'xScal', url: base + '-xscal.zip' },
    ]);
  });
  it('does not invent sibling files for legacy releases', () => {
    const url = 'https://falloutchatmod.com/downloads/electron/old.zip';
    expect(hudDownloads(url)).toEqual([{ label: 'ZFE / xScal', url }]);
    expect(hudDownloads(null)).toEqual([]);
  });
});
