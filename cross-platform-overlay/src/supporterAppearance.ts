/**
 * Native Settings → Appearance editor for chat cosmetics.
 *
 * This is intentionally small vanilla DOM rather than a second React surface. The
 * Electron shell owns its settings panel, while the chat itself remains the one
 * shared ChatOverlay component. The API returns the exact catalog and entitlement
 * state used by the website and Discord command, and writes still go through
 * cosmeticsService.applyCosmetics on the backend.
 */

export type SupporterTier = 'none' | 'supporter' | 'overseer';

export interface ColorPreset {
  id: string;
  label: string;
  hex: string;
  tier: SupporterTier;
}

export interface EffectPreset {
  id: string;
  label: string;
  description: string;
  tier: SupporterTier;
  animated: boolean;
  inGameSupported: boolean;
}

export interface OverlayCosmeticsPayload {
  catalog: { colors: ColorPreset[]; effects: EffectPreset[] };
  supporter: {
    tier: SupporterTier;
    entitledTier: SupporterTier;
    privilegesActive: boolean;
    hasEntitlement: boolean;
    needsDiscordRejoin: boolean;
    tierLabel: string;
    entitledTierLabel: string;
    shopUrl: string | null;
  };
  cosmetics: {
    nameColor: string | null;
    effectId: string | null;
    tag: string | null;
    stored: {
      colorPresetId: string | null;
      customColorHex: string | null;
      effectId: string | null;
      customTag: string | null;
      cosmeticsEnabled: boolean;
    } | null;
  };
  displayName: string;
}

interface ApiProblem {
  status: number;
  detail: string;
}

const TIER_ORDER: SupporterTier[] = ['none', 'supporter', 'overseer'];
const TIER_NAME: Record<SupporterTier, string> = {
  none: 'Free',
  supporter: 'Supporter',
  overseer: "Overseer's Circle",
};

export function tierAtLeast(actual: SupporterTier, required: SupporterTier): boolean {
  return TIER_ORDER.indexOf(actual) >= TIER_ORDER.indexOf(required);
}

export function isLocked(actual: SupporterTier, required: SupporterTier): boolean {
  return !tierAtLeast(actual, required);
}

export function problemText(problem: unknown): string {
  if (problem && typeof problem === 'object' && 'detail' in problem && typeof problem.detail === 'string') {
    return problem.detail;
  }
  return 'Could not save that change. Please try again.';
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const json = await response.json().catch(() => null) as { data?: T; detail?: string; title?: string } | null;
  if (!response.ok) {
    throw {
      status: response.status,
      detail: json?.detail || json?.title || `Request failed (${response.status}).`,
    } satisfies ApiProblem;
  }
  return (json?.data ?? json) as T;
}

async function loadCosmetics(): Promise<OverlayCosmeticsPayload> {
  return request<OverlayCosmeticsPayload>('/api/overlay/cosmetics');
}

async function saveCosmetics(patch: Record<string, unknown>): Promise<OverlayCosmeticsPayload> {
  return request<OverlayCosmeticsPayload>('/api/overlay/cosmetics', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * Add a self-service supporter appearance panel to the overlay's native settings.
 * A disabled feature returns 404 and is removed without leaving a "coming soon"
 * shell; the production kill switch therefore stays indistinguishable from no
 * feature at all.
 */
export function mountSupporterAppearance(parent: HTMLElement): HTMLElement {
  const root = node('div', 'ss-cosmetics');
  parent.append(root);

  const renderLoading = () => {
    root.replaceChildren(node('div', 'ss-cosmetics-loading', 'Checking chat appearance…'));
  };

  const renderError = (error: unknown) => {
    const problem = error as Partial<ApiProblem>;
    if (problem.status === 404) {
      root.remove();
      return;
    }
    root.replaceChildren(
      node('div', 'ss-sec', 'CHAT APPEARANCE'),
      node('div', 'ss-cosmetics-error',
        problem.status === 401
          ? 'Sign in through Settings → Identity to customise your chat appearance.'
          : problemText(error)),
    );
  };

  const render = (data: OverlayCosmeticsPayload, feedback = '') => {
    const tier = data.supporter.tier;
    const stored = data.cosmetics.stored;
    root.replaceChildren();
    root.append(
      node('div', 'ss-sec', 'CHAT APPEARANCE'),
      node('div', 'ss-note', 'Your name colour, effects and tag use the same settings as your website profile and Discord /cosmetics command.'),
    );

    const tierLine = node('div', 'ss-cosmetics-tier');
    tierLine.append(node('span', 'ss-cosmetics-tier-label', `Discord tier: ${data.supporter.tierLabel}`));
    if (data.supporter.needsDiscordRejoin) {
      tierLine.append(node('span', 'ss-cosmetics-paused', `Perks paused — rejoin Discord to restore ${data.supporter.entitledTierLabel}.`));
    } else if (tier === 'none') {
      tierLine.append(node('span', 'ss-cosmetics-subtle', 'Free colours are ready now.')); 
    } else {
      tierLine.append(node('span', 'ss-cosmetics-active', 'Role active — paid options are unlocked.'));
    }
    const refresh = node('button', 'ss-fbtn ss-cosmetics-refresh', 'REFRESH') as HTMLButtonElement;
    refresh.type = 'button';
    refresh.title = 'Recheck your signed-in Discord account and role status';
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { render(await loadCosmetics(), 'Role status refreshed.'); }
      catch (err) { renderError(err); }
    });
    tierLine.append(refresh);
    root.append(tierLine);

    const preview = node('div', 'ss-cosmetics-preview');
    const previewName = node('span', data.cosmetics.effectId ? `fcm-name-fx--${data.cosmetics.effectId}` : '');
    const colour = data.cosmetics.nameColor || 'var(--shell-text, #E8DFC0)';
    previewName.style.color = colour;
    previewName.style.setProperty('--fcm-name-color', colour);
    previewName.style.setProperty('--fcm-name-outline', '0 0 2px #000, 0 0 3px #000');
    previewName.dataset.fcmName = data.displayName || 'YourName';
    previewName.textContent = data.displayName || 'YourName';
    if (data.cosmetics.tag) preview.append(node('span', 'ss-cosmetics-tag', `[${data.cosmetics.tag}] `));
    preview.append(previewName, document.createTextNode(': preview message'));
    root.append(node('div', 'ss-cosmetics-caption', 'Desktop preview'), preview);

    const state = node('div', feedback ? 'ss-cosmetics-status saved' : 'ss-cosmetics-status');
    state.textContent = feedback;

    const mutate = async (patch: Record<string, unknown>, control?: HTMLButtonElement) => {
      if (control) control.disabled = true;
      state.className = 'ss-cosmetics-status';
      state.textContent = 'Saving…';
      try {
        render(await saveCosmetics(patch), 'Saved. The chat updates without reconnecting.');
      } catch (err) {
        if (control) control.disabled = false;
        state.className = 'ss-cosmetics-status error';
        state.textContent = problemText(err);
      }
    };

    const colourGroup = (title: string, colors: ColorPreset[]) => {
      root.append(node('div', 'ss-cosmetics-label', title));
      const list = node('div', 'ss-cosmetics-swatches');
      colors.forEach((preset) => {
        const locked = isLocked(tier, preset.tier);
        const button = node('button', `ss-cosmetics-swatch${locked ? ' locked' : ''}${stored?.colorPresetId === preset.id ? ' selected' : ''}`) as HTMLButtonElement;
        button.type = 'button';
        button.style.background = preset.hex;
        button.title = locked ? `${preset.label} — ${TIER_NAME[preset.tier]} required` : `${preset.label} · ${preset.hex}`;
        button.setAttribute('aria-label', button.title);
        if (locked) {
          button.disabled = true;
          button.append(node('span', 'ss-cosmetics-lock', '🔒'));
        } else {
          button.addEventListener('click', () => void mutate({ colorPresetId: preset.id }, button));
        }
        list.append(button);
      });
      root.append(list);
    };

    colourGroup('COLOUR — everywhere, including the in-game HUD', data.catalog.colors.filter(c => c.tier === 'none'));
    colourGroup('SUPPORTER COLOURS', data.catalog.colors.filter(c => c.tier !== 'none'));

    root.append(node('div', 'ss-cosmetics-label', 'EFFECTS — desktop overlay and website only'));
    root.append(node('div', 'ss-note', 'The game HUD shows your solid colour and tag only; its UI engine cannot render glow or animation.'));
    const effects = node('div', 'ss-cosmetics-effects');
    data.catalog.effects.forEach((effect) => {
      const locked = isLocked(tier, effect.tier);
      const button = node('button', `ss-cosmetics-effect${locked ? ' locked' : ''}${stored?.effectId === effect.id || (!stored?.effectId && effect.id === 'none') ? ' selected' : ''}`, effect.label) as HTMLButtonElement;
      button.type = 'button';
      button.title = locked ? `${effect.description} ${TIER_NAME[effect.tier]} required.` : effect.description;
      if (locked) {
        button.disabled = true;
        button.append(document.createTextNode(` · ${TIER_NAME[effect.tier]}`));
      } else {
        button.addEventListener('click', () => void mutate({ effectId: effect.id }, button));
      }
      effects.append(button);
    });
    root.append(effects);

    root.append(node('div', 'ss-cosmetics-label', 'OVERSEER TAG — everywhere, including the in-game HUD'));
    const tagRow = node('div', 'ss-cosmetics-tag-row');
    const tagInput = node('input', 'ss-cosmetics-tag-input') as HTMLInputElement;
    tagInput.type = 'text';
    tagInput.maxLength = 16;
    tagInput.value = stored?.customTag || '';
    tagInput.placeholder = isLocked(tier, 'overseer') ? "Overseer's Circle required" : 'e.g. VAULT 76';
    tagInput.disabled = isLocked(tier, 'overseer');
    const tagSave = node('button', 'ss-fbtn', 'SAVE TAG') as HTMLButtonElement;
    tagSave.type = 'button';
    tagSave.disabled = isLocked(tier, 'overseer');
    tagSave.addEventListener('click', () => void mutate({ customTag: tagInput.value.trim() || null }, tagSave));
    tagRow.append(tagInput, tagSave);
    root.append(tagRow);

    if (data.supporter.shopUrl && tier !== 'overseer') {
      const support = node('a', 'ss-cosmetics-support', 'VIEW SUPPORTER TIERS') as HTMLAnchorElement;
      support.href = data.supporter.shopUrl;
      support.target = '_blank';
      support.rel = 'noreferrer';
      root.append(support);
    }
    root.append(state);
  };

  renderLoading();
  void loadCosmetics().then(data => render(data)).catch(renderError);
  return root;
}
