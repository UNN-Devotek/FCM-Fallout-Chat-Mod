/**
 * First-run onboarding overlay (vanilla DOM, same pattern as shell.ts settings).
 * Shown once on fresh install (onboarded === false); never re-shown after Finish/Skip.
 *
 * Steps: account linking (Discord/Steam) → Theme → Identity.
 * On Finish/Skip: calls applyOnboardingSettings() to persist and remount React.
 */

import {
  loadShellSettings,
  applyOnboardingSettings,
  DEFAULT_SHELL_SETTINGS,
} from './shell';
import type { ShellSettings } from './shell';
import {
  TOTAL_STEPS,
  deriveInitialOnboardingState,
  computeNavView,
  nextStepIndex,
  prevStepIndex,
  runFinish,
  reduceFinishResult,
} from './onboarding-core';
import type { OnboardingState } from './onboarding-core';

// THEMES is module-private in shell.ts; duplicated here to avoid changing its public surface.
const THEMES: { id: string; name: string }[] = [
  { id: 'fo76-wasteland', name: 'Fallout 76 (amber)' },
  { id: 'vault-tec-green', name: 'Vault-Tec Green' },
  { id: 'amber', name: 'Amber' },
  { id: 'white', name: 'White' },
];

// Per-theme colors mirrored from admin-dashboard ChatOverlay.tsx BUILTIN_THEMES.
const THEME_COLORS: Record<string, { primary: string; text: string; bg: string; label: string }> = {
  'fo76-wasteland':  { primary: '#C8A840', text: '#E8DFC0', bg: 'rgba(14,10,4,0.97)',  label: 'Amber / Wasteland' },
  'vault-tec-green': { primary: '#18FF62', text: '#18FF62', bg: 'rgba(8,14,8,0.97)',   label: 'Vault-Tec Green' },
  'amber':           { primary: '#FFB000', text: '#FFB000', bg: 'rgba(12,10,4,0.97)',  label: 'Amber' },
  'white':           { primary: '#F0F0F0', text: '#F0F0F0', bg: 'rgba(10,10,12,0.97)', label: 'White' },
};
const DEFAULT_THEME_COLOR = THEME_COLORS['fo76-wasteland'];

function applyPanelTheme(panel: HTMLElement, themeId: string) {
  const tc = THEME_COLORS[themeId] || DEFAULT_THEME_COLOR;
  panel.style.setProperty('--ob-text', tc.text);
  panel.style.setProperty('--ob-accent', tc.primary);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Partial<HTMLElementTagNameMap[K]> & { className?: string },
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) Object.assign(node, attrs);
  for (const k of kids) node.append(k);
  return node;
}

let _backdropEl: HTMLElement | null = null;
// Guard: once finished/skipped in this session, never re-open (even if the
// relay:status re-fire from finish() re-triggers the onboarding check).
let _completed = false;

export function showOnboarding(isDev = false, discordDisplayName = ''): void {
  if (_completed) return;
  try { window.relayBridge.setModalInteractive?.(true); } catch { /* non-fatal */ }
  if (_backdropEl) { _backdropEl.classList.add('open'); return; }
  _backdropEl = buildOnboardingPanel(isDev, discordDisplayName);
  document.body.append(_backdropEl);
  // Small delay so the CSS transition fires.
  requestAnimationFrame(() => _backdropEl?.classList.add('open'));
}

export function hideOnboarding(): void {
  _completed = true;
  _backdropEl?.classList.remove('open');
  try { window.relayBridge.setModalInteractive?.(false); } catch { /* non-fatal */ }
}

function buildOnboardingPanel(isDev = false, passedDiscordDisplayName = ''): HTMLElement {
  const s = loadShellSettings();
  const state: OnboardingState = deriveInitialOnboardingState(s, passedDiscordDisplayName);

  let currentStep = 0;

  // ── Root backdrop (same structure as #shell-settings-backdrop) ──
  const backdrop = el('div', { id: 'shell-onboarding-backdrop' });

  // ── Panel ──
  const panel = el('div', { id: 'shell-onboarding' });
  backdrop.append(panel);
  applyPanelTheme(panel, state.themeId);

  // ── Header ──
  const head = el('div', { className: 'ob-head' });
  head.append(el('span', { className: 'ob-title' }, 'FALLOUT CHAT MOD'));
  head.append(el('span', { className: 'ob-subtitle' }, 'First-Run Setup'));
  const stepLbl = el('span', { className: 'ob-step' }, `Step 1 of ${TOTAL_STEPS}`);
  head.append(stepLbl);
  panel.append(head);

  // ── Progress bar ──
  const progressWrap = el('div', { className: 'ob-progress' });
  const progressBar = el('div', { className: 'ob-progress-fill' });
  progressWrap.append(progressBar);
  panel.append(progressWrap);

  // ── Body (scrollable; step panels swapped in/out) ──
  const body = el('div', { className: 'ob-body' });
  panel.append(body);

  // ── Footer ──
  const footer = el('div', { className: 'ob-footer' });
  const backBtn = el('button', { className: 'ob-fbtn ob-back' }, '◀  BACK');
  const noteEl = el('span', { className: 'ob-foot-note' });
  const nextBtn = el('button', { className: 'ob-fbtn ob-next' }, 'NEXT  ▶');
  footer.append(backBtn, noteEl, nextBtn);
  panel.append(footer);

  const discordStep = buildStepDiscord(state);
  const identityStep = buildStepIdentity(state, true);
  const steps: HTMLElement[] = [
    discordStep,
    // Theme step re-tints the modal live (text + accent) when a theme is picked.
    buildStepTheme(state, () => applyPanelTheme(panel, state.themeId)),
    identityStep,
  ];

  const updateProgress = () => {
    const view = computeNavView(currentStep);
    progressBar.style.width = `${view.pct}%`;
    stepLbl.textContent = view.stepLabel;
    backBtn.style.display = view.backHidden ? 'none' : '';
    nextBtn.textContent = view.nextLabel;
  };

  const showStep = (idx: number) => {
    body.replaceChildren(steps[idx]);
    currentStep = idx;
    updateProgress();
    // Fire the prefill callback when the identity step becomes visible.
    if (idx === 2) {
      const prefill = (steps[idx] as any).__fcmPrefill as (() => void) | undefined;
      prefill?.();
    }
  };

  backBtn.addEventListener('click', () => {
    if (currentStep > 0) showStep(prevStepIndex(currentStep));
  });

  let finishing = false;
  const doFinish = async () => {
    if (finishing) return;
    finishing = true;
    nextBtn.setAttribute('disabled', 'disabled');
    noteEl.textContent = '';
    noteEl.classList.remove('warn');

    const result = await finish(state);
    const directive = reduceFinishResult(state, result);

    noteEl.textContent = directive.note;
    noteEl.classList.toggle('warn', directive.warn);
    if (directive.skipNameOnNextFinish) state.skipNameOnNextFinish = true;

    if (directive.dismiss) {
      hideOnboarding();
      return;
    }
    // Name taken — re-enable for another press.
    finishing = false;
    if (directive.disabled) nextBtn.setAttribute('disabled', 'disabled');
    else nextBtn.removeAttribute('disabled');
  };

  nextBtn.addEventListener('click', () => {
    if (currentStep < TOTAL_STEPS - 1) showStep(nextStepIndex(currentStep));
    else void doFinish();
  });

  // Init
  showStep(0);

  return backdrop;
}

// ── Step 3: Identity ──────────────────────────────────────────────────────────
// withPrefill installs __fcmPrefill so the navigator can default the FO76 name
// from the Discord display name when this step becomes visible.
function buildStepIdentity(state: OnboardingState, withPrefill?: boolean): HTMLElement {
  const wrap = el('div', { className: 'ob-step-wrap' });

  wrap.append(el('div', { className: 'ob-sec' }, 'YOUR IDENTITY'));
  wrap.append(el('div', { className: 'ob-note' }, 'Tell us a bit about yourself. You can change these any time in Settings.'));

  const playRow = el('div', { className: 'ob-row ob-toggle-row' });
  const playCheck = el('span', { className: 'ob-check' }, state.playsFo76 ? '✓' : '');
  const playToggle = el('div', { className: 'ob-toggle' });
  playToggle.append(playCheck, document.createTextNode('I play Fallout 76'));
  playToggle.title = 'Enable to enter your in-game character name';
  playRow.append(playToggle);
  wrap.append(playRow);

  const nameSection = el('div', { className: 'ob-name-section' });
  nameSection.append(el('label', { className: 'ob-lbl' }, 'FALLOUT 76 CHARACTER NAME'));
  const nameInput = el('input', {
    type: 'text',
    className: 'ob-input',
    value: state.fo76Name,
    maxLength: 32,
  }) as HTMLInputElement;
  nameInput.placeholder = 'Your in-game name (e.g. Vault Dweller)';
  nameInput.addEventListener('input', () => { state.fo76Name = nameInput.value.trim(); });
  nameSection.append(nameInput);
  nameSection.append(el('div', { className: 'ob-note' },
    'Used as your chat display name. Defaults to your Discord display name if left blank.'
  ));
  wrap.append(nameSection);

  const applyPlayState = () => {
    nameSection.style.display = state.playsFo76 ? '' : 'none';
    playCheck.textContent = state.playsFo76 ? '✓' : '';
  };
  applyPlayState();

  playToggle.addEventListener('click', () => {
    state.playsFo76 = !state.playsFo76;
    applyPlayState();
    if (state.playsFo76 && !nameInput.value.trim()) {
      const discordDefault = state.discordDisplayName || state.discordName;
      if (discordDefault) {
        nameInput.value = discordDefault;
        state.fo76Name = discordDefault;
      }
    }
  });

  if (withPrefill) {
    (wrap as any).__fcmPrefill = () => {
      // Only prefill when: no name typed yet AND Discord is linked.
      if (nameInput.value.trim()) return;
      const discordDefault = state.discordDisplayName || state.discordName;
      if (!discordDefault) return;
      nameInput.value = discordDefault;
      state.fo76Name = discordDefault;
      if (!state.playsFo76) {
        state.playsFo76 = true;
        applyPlayState();
      }
    };
  }

  return wrap;
}

// ── Step 2: Theme ─────────────────────────────────────────────────────────────
function buildStepTheme(state: OnboardingState, onThemeChange: () => void): HTMLElement {
  const wrap = el('div', { className: 'ob-step-wrap' });

  wrap.append(el('div', { className: 'ob-sec' }, 'CHOOSE A THEME'));
  wrap.append(el('div', { className: 'ob-note' }, 'Pick the color theme for the chat overlay. You can change this later in Settings → Appearance.'));

  const themeGrid = el('div', { className: 'ob-theme-grid' });

  const cards: HTMLElement[] = [];
  for (const theme of THEMES) {
    const tc = THEME_COLORS[theme.id] || DEFAULT_THEME_COLOR;
    const card = el('div', { className: 'ob-theme-card' });
    card.dataset.themeId = theme.id;
    if (theme.id === state.themeId) card.classList.add('selected');

    const preview = el('div', { className: 'ob-theme-preview' });
    preview.style.borderColor = tc.primary + '55';
    preview.style.background = tc.bg;

    const previewTab = el('div', { className: 'ob-theme-tab' });
    previewTab.style.color = tc.primary;
    previewTab.style.borderBottomColor = tc.primary + '44';
    previewTab.textContent = 'FALLOUT 76';
    preview.append(previewTab);

    const previewMsg = el('div', { className: 'ob-theme-msg' });
    previewMsg.style.color = tc.primary + 'CC';
    previewMsg.append(el('span', { className: 'ob-theme-user' }, 'Devotek: '));
    previewMsg.append(document.createTextNode('Hey wasteland!'));
    previewMsg.querySelector('.ob-theme-user')!.setAttribute('style', `color: ${tc.primary}; font-weight: bold;`);
    preview.append(previewMsg);

    const previewInput = el('div', { className: 'ob-theme-input' });
    previewInput.style.borderTopColor = tc.primary + '33';
    previewInput.style.color = tc.primary + '55';
    previewInput.textContent = 'Type a message...';
    preview.append(previewInput);

    card.append(preview);
    card.append(el('div', { className: 'ob-theme-name' }, tc.label));

    card.addEventListener('click', () => {
      state.themeId = theme.id;
      cards.forEach(c => c.classList.toggle('selected', c.dataset.themeId === theme.id));
      onThemeChange();
    });

    cards.push(card);
    themeGrid.append(card);
  }

  wrap.append(themeGrid);
  return wrap;
}

// ── Step 1: account linking ───────────────────────────────────────────────────
function buildStepDiscord(state: OnboardingState, _isDev = false, _onDevLogin?: () => void): HTMLElement {
  const wrap = el('div', { className: 'ob-step-wrap' });

  wrap.append(el('div', { className: 'ob-sec' }, 'LINK AN ACCOUNT'));

  const joinRow = el('div', { className: 'ob-discord-btns' });
  const joinBtn = el('button', { className: 'ob-fbtn ob-discord-join' }, 'JOIN THE DISCORD SERVER');
  joinBtn.title = 'Opens the Fallout Chat Mod Discord invite in your browser';
  joinBtn.addEventListener('click', () => {
    window.relayBridge.openExternal?.('https://discord.gg/NJBJqyvRJC');
  });
  joinRow.append(joinBtn);
  wrap.append(joinRow);
  wrap.append(el('div', { className: 'ob-note ob-note-warn' },
    'You must be a member of the Fallout Chat Mod Discord server to use the chat. Join the server first, then link your account below.'
  ));

  wrap.append(el('div', { className: 'ob-note' }, 'Linking your Discord account gives you a verified chat identity and lets you keep your chat history if you reinstall. This is optional — you can link later from Settings.'));

  const statusRow = el('div', { className: 'ob-discord-status' });
  const dot = el('span', { className: 'ob-dot' });
  const statusText = el('span', { className: 'ob-discord-text' });
  statusRow.append(dot, statusText);
  wrap.append(statusRow);

  const profileCard = el('div', { className: 'ob-discord-profile' });
  profileCard.style.cssText = 'display:none; align-items:center; gap:10px; padding:10px 12px; background:rgba(255,255,255,0.04); border-radius:4px; margin-top:4px;';

  const avatarEl = el('img') as HTMLImageElement;
  avatarEl.style.cssText = 'width:36px; height:36px; border-radius:50%; object-fit:cover; flex-shrink:0;';
  avatarEl.alt = '';

  const profileText = el('div', { style: 'display:flex; flex-direction:column; gap:2px;' } as any);
  const profileName = el('div', { style: 'font-size:13px; font-weight:bold;' } as any);
  const profileHandle = el('div', { style: 'font-size:10px; opacity:0.6;' } as any);
  profileText.append(profileName, profileHandle);
  profileCard.append(avatarEl, profileText);
  wrap.append(statusRow, profileCard);

  const btnRow = el('div', { className: 'ob-discord-btns' });
  const noteEl = el('div', { className: 'ob-note ob-note-discord' },
    'After clicking LINK DISCORD, authorize in the browser, then click REFRESH STATUS.'
  );

  const renderStatus = () => {
    if (state.discordLinked) {
      statusRow.classList.add('linked');
      const displayName = state.discordDisplayName || state.discordName;
      statusText.textContent = '✓ Discord linked';
      const avatarUrl = (state as OnboardingState & { discordAvatarUrl?: string }).discordAvatarUrl;
      if (avatarUrl) {
        avatarEl.src = avatarUrl;
        avatarEl.style.display = 'block';
      } else {
        avatarEl.style.display = 'none';
      }
      profileName.textContent = displayName || '';
      profileHandle.textContent = state.discordName && state.discordName !== displayName ? `@${state.discordName}` : '';
      profileCard.style.display = 'flex';
      btnRow.style.display = 'none';
      noteEl.style.display = 'none';
    } else {
      statusRow.classList.remove('linked');
      statusText.textContent = 'Not linked';
      profileCard.style.display = 'none';
      btnRow.style.display = 'flex';
      noteEl.style.display = '';
    }
  };
  const linkBtn = el('button', { className: 'ob-fbtn ob-discord-link' }, 'LINK DISCORD');
  linkBtn.title = 'Opens Discord in your browser to authorize this install';
  linkBtn.addEventListener('click', () => { window.relayBridge.linkDiscord?.(); });

  const refreshBtn = el('button', { className: 'ob-fbtn' }, 'REFRESH STATUS');
  refreshBtn.title = 'Re-check whether Discord was linked';
  refreshBtn.addEventListener('click', () => {
    refreshBtn.textContent = '…'; refreshBtn.setAttribute('disabled', 'disabled');
    window.relayBridge.refreshDiscordStatus?.();
    setTimeout(() => { refreshBtn.textContent = 'REFRESH STATUS'; refreshBtn.removeAttribute('disabled'); }, 3000);
  });

  btnRow.append(linkBtn, refreshBtn);
  wrap.append(btnRow, noteEl);

  renderStatus();

  window.relayBridge.onDiscordStatus?.((status) => {
    state.discordLinked = status.linked;
    state.discordName = status.discordName || '';
    const extStatus = status as typeof status & { discordDisplayName?: string; discordAvatarUrl?: string };
    if (extStatus.discordDisplayName) state.discordDisplayName = extStatus.discordDisplayName;
    if (extStatus.discordAvatarUrl) (state as OnboardingState & { discordAvatarUrl?: string }).discordAvatarUrl = extStatus.discordAvatarUrl;
    if (status.linked && !state.fo76Name) {
      state.fo76Name = state.discordDisplayName || state.discordName;
    }
    renderStatus();
  });

  // Steam is a second, independent provider. It is intentionally rendered next
  // to Discord rather than replacing it: either verified account satisfies the
  // overlay gate, and users can link both to the same FCM account.
  const steamStatusRow = el('div', { className: 'ob-discord-status' });
  const steamDot = el('span', { className: 'ob-dot' });
  const steamStatusText = el('span', { className: 'ob-discord-text' });
  steamStatusRow.append(steamDot, steamStatusText);
  wrap.append(el('div', { className: 'ob-sec' }, 'STEAM ACCOUNT'), steamStatusRow);

  const steamBtnRow = el('div', { className: 'ob-discord-btns' });
  const steamNote = el('div', { className: 'ob-note ob-note-discord' },
    'After clicking LINK STEAM, authorize in the browser, then click REFRESH STATUS.'
  );
  const renderSteamStatus = () => {
    const linked = state.steamLinked;
    steamStatusRow.classList.toggle('linked', linked);
    steamStatusText.textContent = linked ? '✓ Steam linked' : 'Not linked';
    steamBtnRow.style.display = linked ? 'none' : 'flex';
    steamNote.style.display = linked ? 'none' : '';
  };
  const steamLinkBtn = el('button', { className: 'ob-fbtn ob-steam-link' }, 'LINK STEAM');
  steamLinkBtn.title = 'Opens Steam in your browser to authorize this install';
  steamLinkBtn.addEventListener('click', () => { window.relayBridge.linkSteam?.(); });
  const steamRefreshBtn = el('button', { className: 'ob-fbtn' }, 'REFRESH STATUS');
  steamRefreshBtn.title = 'Re-check whether Steam was linked';
  steamRefreshBtn.addEventListener('click', () => {
    steamRefreshBtn.textContent = '…'; steamRefreshBtn.setAttribute('disabled', 'disabled');
    window.relayBridge.refreshSteamStatus?.();
    setTimeout(() => { steamRefreshBtn.textContent = 'REFRESH STATUS'; steamRefreshBtn.removeAttribute('disabled'); }, 3000);
  });
  steamBtnRow.append(steamLinkBtn, steamRefreshBtn);
  wrap.append(steamBtnRow, steamNote);
  renderSteamStatus();

  window.relayBridge.onSteamStatus?.((status) => {
    state.steamLinked = !!(status.steamLinked ?? status.linked);
    renderSteamStatus();
  });

  return wrap;
}

// Returns { nameTaken: true } when the FO76 name belongs to another user;
// all other settings are still saved and onboarding stays open.
async function finish(state: OnboardingState): Promise<{ nameTaken: boolean }> {
  return runFinish(state, {
    applyOnboardingSettings: (patch) => applyOnboardingSettings(patch as Partial<ShellSettings>),
    setIdentityName: window.relayBridge.setIdentityName?.bind(window.relayBridge),
    notifyOnboardingComplete: window.relayBridge.notifyOnboardingComplete?.bind(window.relayBridge),
    notifyChatActive: window.relayBridge.notifyChatActive?.bind(window.relayBridge),
  });
}
