// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  applyOptimisticCosmetics,
  createAppearanceRequestGate,
  isLocked,
  problemText,
  retryAppearanceRequest,
  safeSupporterStarColor,
  SUPPORTER_STAR_GLYPH,
  tierAtLeast,
  mountSupporterAppearance,
  type OverlayCosmeticsPayload,
} from '../supporterAppearance';

describe('supporter appearance tier gates', () => {
  it('keeps free options available while locking paid options by their exact tier', () => {
    expect(tierAtLeast('none', 'none')).toBe(true);
    expect(isLocked('none', 'supporter')).toBe(true);
    expect(isLocked('supporter', 'supporter')).toBe(false);
    expect(isLocked('supporter', 'overseer')).toBe(true);
    expect(isLocked('overseer', 'overseer')).toBe(false);
  });

  it('uses the server problem detail instead of hiding a rejected choice', () => {
    expect(problemText({ detail: 'Supporter is required for that colour.' }))
      .toBe('Supporter is required for that colour.');
    expect(problemText({})).toBe('Could not save that change. Please try again.');
  });
});

describe('supporter appearance star contract', () => {
  it('keeps the preview glyph immutable and color input hex-only', () => {
    expect(SUPPORTER_STAR_GLYPH).toBe('★');
    expect(safeSupporterStarColor('supporter', '#58FDFD')).toBe('#58FDFD');
    expect(safeSupporterStarColor('supporter', 'url(https://evil.invalid)')).toBe('#7EA8F7');
    expect(safeSupporterStarColor('overseer', null)).toBe('#FD4DA6');
  });
});

describe('supporter appearance request gate', () => {
  it('permits one picker request at a time, then releases after completion', () => {
    const gate = createAppearanceRequestGate();
    expect(gate.busy).toBe(false);
    expect(gate.tryStart()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.busy).toBe(false);
    expect(gate.tryStart()).toBe(true);
  });
});

function payload(): OverlayCosmeticsPayload {
  return {
    catalog: {
      colors: [
        { id: 'amber', label: 'Amber', hex: '#C8A840', tier: 'none' },
        { id: 'cryo', label: 'Cryo', hex: '#57DBDB', tier: 'supporter' },
      ],
      effects: [
        { id: 'none', label: 'None', description: 'No effect.', tier: 'none', animated: false, inGameSupported: true },
        { id: 'glow-soft', label: 'Soft Glow', description: 'A soft glow.', tier: 'supporter', animated: true, inGameSupported: false },
      ],
    },
    supporter: {
      tier: 'supporter', entitledTier: 'supporter', privilegesActive: true,
      hasEntitlement: true, needsDiscordRejoin: false, tierLabel: 'Supporter',
      entitledTierLabel: 'Supporter', shopUrl: null, isAdminBypass: false,
    },
    cosmetics: {
      nameColor: '#C8A840', starColor: '#7EA8F7', effectId: null, tag: null,
      badges: ['supporter'], stored: {
        colorPresetId: 'amber', customColorHex: null, starColorPresetId: null,
        effectId: null, customTag: null, cosmeticsEnabled: true,
      },
    },
    displayName: 'Wanderer',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  } as Response;
}

function problemResponse(detail: string, status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ detail }),
  } as Response;
}

describe('supporter appearance save lifecycle', () => {
  it('retries transient saves and stops retrying permanent errors', async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await expect(retryAppearanceRequest(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary network failure');
      return 'saved';
    }, { sleep })).resolves.toBe('saved');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    attempts = 0;
    await expect(retryAppearanceRequest(async () => {
      attempts += 1;
      throw { status: 403, detail: 'Supporter required.' };
    }, { sleep })).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });

  it('projects an effect selection into the preview before the server responds', () => {
    const next = applyOptimisticCosmetics(payload(), { effectId: 'glow-soft' });
    expect(next.cosmetics.effectId).toBe('glow-soft');
    expect(next.cosmetics.stored?.effectId).toBe('glow-soft');
  });

  it('clears the saving cursor and busy state after a successful save', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()));
    vi.stubGlobal('fetch', fetchMock);

    const parent = document.createElement('div');
    document.body.append(parent);
    const root = mountSupporterAppearance(parent);
    await vi.waitFor(() => expect(root.querySelector('.ss-cosmetics-effect')).not.toBeNull());

    let resolvePatch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolvePatch = resolve; }));
    const effectButton = [...root.querySelectorAll<HTMLButtonElement>('.ss-cosmetics-effect')]
      .find(button => button.textContent === 'Soft Glow');
    expect(effectButton).toBeDefined();
    effectButton!.click();

    expect(root.dataset.saving).toBe('true');
    expect(root.querySelector('.ss-cosmetics-effect.selected')?.textContent).toBe('Soft Glow');

    resolvePatch(jsonResponse({
      ...payload(),
      cosmetics: {
        ...payload().cosmetics,
        effectId: 'glow-soft',
        stored: { ...payload().cosmetics.stored!, effectId: 'glow-soft' },
      },
    }));
    await vi.waitFor(() => expect(root.dataset.saving).toBe('false'));
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelector('.ss-cosmetics-status')?.textContent).toContain('Saved');
  });

  it('rolls back and clears the saving cursor after a permanent save error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockResolvedValueOnce(problemResponse('That effect is not available to this account.', 403));
    vi.stubGlobal('fetch', fetchMock);

    const parent = document.createElement('div');
    document.body.append(parent);
    const root = mountSupporterAppearance(parent);
    await vi.waitFor(() => expect(root.querySelector('.ss-cosmetics-effect')).not.toBeNull());

    const effectButton = [...root.querySelectorAll<HTMLButtonElement>('.ss-cosmetics-effect')]
      .find(button => button.textContent === 'Soft Glow');
    expect(effectButton).toBeDefined();
    effectButton!.click();

    await vi.waitFor(() => expect(root.querySelector('.ss-cosmetics-status.error')?.textContent)
      .toContain('not available'));
    expect(root.dataset.saving).toBe('false');
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelector('.ss-cosmetics-effect.selected')?.textContent).toBe('None');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
