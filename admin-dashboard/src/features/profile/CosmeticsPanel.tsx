/**
 * CosmeticsPanel — self-service chat appearance editor on the Profile page.
 *
 * Follows ApiTokensPanel's shape exactly (self-contained default export, local style
 * constants matching Profile.tsx conventions, rendered for the profile owner only).
 * Profile has no tab framework and one panel is not a reason to introduce one.
 *
 * Motion is used HERE and deliberately not in ChatOverlay: this is a low-element-count,
 * interaction-driven dashboard surface where orchestrated transitions are worth it.
 * The per-message name effects are pure CSS because the chat feed is virtualized and
 * the Electron overlay runs on top of Fallout 76, where JS animation frames are taken
 * from the game. A CI guard (noMotionInOverlay.test.ts) enforces that split.
 */
import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { api } from '../../services/api';

// ── Styles (matching Profile.tsx conventions) ────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: '6px',
  padding: '20px',
  marginBottom: '20px',
};

const label: React.CSSProperties = {
  fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '1px', marginBottom: '6px',
};

const input: React.CSSProperties = {
  width: '100%', maxWidth: '340px', padding: '8px 10px',
  background: 'var(--bg-dark)', border: '1px solid var(--border-color)',
  borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
};

const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: '4px', cursor: 'pointer',
  border: '1px solid var(--phosphor-color)', background: 'rgba(212,176,64,0.08)',
  color: 'var(--phosphor-color)', fontFamily: 'var(--font-mono)', fontSize: '13px',
};

// ── Types (mirror GET /api/cosmetics/catalog) ────────────────────────────────

type Tier = 'none' | 'supporter' | 'overseer';

interface ColorPreset { id: string; label: string; hex: string; tier: Tier }
interface EffectPreset { id: string; label: string; tier: Tier; description: string; animated: boolean; inGameSupported: boolean }

interface Catalog {
  colors: ColorPreset[];
  effects: EffectPreset[];
  nameRules: { minLength: number; maxLength: number; tagMaxLength: number };
  cooldownMs: Record<Tier, number>;
  inGameSupports: { colors: boolean; tag: boolean; effects: boolean };
}

interface SupporterStatus {
  tier: Tier;
  entitledTier: Tier;
  privilegesActive: boolean;
  hasEntitlement: boolean;
  needsDiscordRejoin: boolean;
  tierLabel: string;
  shopUrl: string | null;
  tierEnabled: boolean;
}

interface Cosmetics {
  displayName: string | null;
  nameColor: string | null;
  effectId: string | null;
  tag: string | null;
  badges: string[];
  stored: {
    customDisplayName: string | null;
    colorPresetId: string | null;
    effectId: string | null;
    customTag: string | null;
    displayNameChangedAt: string | null;
  } | null;
}

const TIER_ORDER: Tier[] = ['none', 'supporter', 'overseer'];
const tierAtLeast = (a: Tier, b: Tier) => TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b);
const TIER_NAME: Record<Tier, string> = { none: 'Free', supporter: 'Supporter', overseer: "Overseer's Circle" };

// ── Component ────────────────────────────────────────────────────────────────

export default function CosmeticsPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { data: catalog } = useQuery({
    queryKey: ['cosmetics-catalog'],
    queryFn: () => api.get<Catalog>('/api/cosmetics/catalog'),
  });
  const { data: status } = useQuery({
    queryKey: ['supporter-status'],
    queryFn: () => api.get<SupporterStatus>('/api/supporter/status'),
  });
  const { data: cosmetics } = useQuery({
    queryKey: ['cosmetics', userId],
    queryFn: () => api.get<Cosmetics>(`/api/users/${userId}/cosmetics`),
    enabled: !!userId,
  });

  const tier: Tier = status?.tier ?? 'none';

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<Cosmetics>(`/api/users/${userId}/cosmetics`, patch),
    onSuccess: (_d, patch) => {
      setError(null);
      setSaved(Object.keys(patch)[0] ?? 'saved');
      window.setTimeout(() => setSaved(null), 1800);
      void qc.invalidateQueries({ queryKey: ['cosmetics', userId] });
    },
    onError: (e: unknown) => {
      setSaved(null);
      setError(e instanceof Error ? e.message : 'Could not save that change.');
    },
  });

  const currentName = nameDraft ?? cosmetics?.stored?.customDisplayName ?? '';
  const currentColor = cosmetics?.nameColor ?? null;
  const currentEffect = cosmetics?.effectId ?? null;

  const { freeColors, paidColors } = useMemo(() => ({
    freeColors: (catalog?.colors ?? []).filter(c => c.tier === 'none'),
    paidColors: (catalog?.colors ?? []).filter(c => c.tier !== 'none'),
  }), [catalog]);

  if (!catalog) return null;

  const nameTooLong = currentName.length > catalog.nameRules.maxLength;

  return (
    <section style={card}>
      <h2 style={{ fontSize: '16px', marginBottom: '4px', color: 'var(--phosphor-color)' }}>
        Chat appearance
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px' }}>
        Change how your name looks in chat. You can also do all of this from Discord with{' '}
        <code>/cosmetics</code> — both use the same settings.
      </p>

      {/* Entitled but not in the Discord: privileges are paused, not lost. */}
      <AnimatePresence>
        {status?.needsDiscordRejoin && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            style={{
              padding: '10px 12px', marginBottom: '16px', borderRadius: '4px',
              border: '1px solid var(--warning)', background: 'rgba(255,187,34,0.08)',
              color: 'var(--warning)', fontSize: '13px',
            }}
          >
            Your {TIER_NAME[status.entitledTier]} perks are paused because you are not
            currently in the Discord server. Rejoin and they come straight back — you do
            not need to buy anything again.
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Live preview ────────────────────────────────────────────────── */}
      <div style={{ ...label }}>Preview</div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
        <PreviewRow bg="#1e1908" caption="Website / dashboard"
          name={currentName || 'YourName'} color={currentColor} effect={currentEffect} tag={cosmetics?.tag ?? null} />
        <PreviewRow bg="rgba(10,10,10,0.55)" caption="Overlay (translucent)"
          name={currentName || 'YourName'} color={currentColor} effect={currentEffect} tag={cosmetics?.tag ?? null} />
        {/* In-game deliberately previews WITHOUT the effect — Scaleform cannot render
            glow/animation, so showing it here would misrepresent what users get. */}
        <PreviewRow bg="#0a0a0a" caption="In-game HUD"
          name={currentName || 'YourName'} color={currentColor} effect={null} tag={cosmetics?.tag ?? null} />
      </div>

      {/* ── Display name ───────────────────────────────────────────────── */}
      <div style={{ marginBottom: '20px' }}>
        <div style={label}>Display name</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...input, borderColor: nameTooLong ? 'var(--danger)' : 'var(--border-color)' }}
            value={currentName}
            maxLength={catalog.nameRules.maxLength + 8}
            placeholder="Leave empty to use your default name"
            onChange={e => setNameDraft(e.target.value)}
          />
          <span style={{ fontSize: '12px', color: nameTooLong ? 'var(--danger)' : 'var(--text-muted)' }}>
            {currentName.length}/{catalog.nameRules.maxLength}
          </span>
          <button
            style={{ ...btn, opacity: nameTooLong || save.isPending ? 0.5 : 1 }}
            disabled={nameTooLong || save.isPending}
            onClick={() => save.mutate({ displayName: currentName.trim() || null })}
          >
            Save name
          </button>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
          You can change your name once every{' '}
          {Math.round((catalog.cooldownMs[tier] ?? 0) / 86_400_000)} days on your current tier.
        </p>
      </div>

      {/* ── Colours ────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '20px' }}>
        <div style={label}>Colour — shows everywhere, including in-game</div>
        <Swatches presets={freeColors} current={cosmetics?.stored?.colorPresetId ?? null} tier={tier}
          onPick={id => save.mutate({ colorPresetId: id })} />

        <div style={{ ...label, marginTop: '14px' }}>Supporter colours</div>
        <Swatches presets={paidColors} current={cosmetics?.stored?.colorPresetId ?? null} tier={tier}
          onPick={id => save.mutate({ colorPresetId: id })} shopUrl={status?.shopUrl ?? null} />
      </div>

      {/* ── Effects ────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '12px' }}>
        <div style={label}>Effects — website and desktop overlay only</div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          The game's UI engine cannot draw glows or animation, so in-game shows your
          colour and tag only. This is a limitation of the game, not of your tier.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {catalog.effects.map(fx => {
            const unlocked = tierAtLeast(tier, fx.tier);
            return (
              <motion.button
                key={fx.id}
                whileHover={unlocked ? { scale: 1.03 } : undefined}
                whileTap={unlocked ? { scale: 0.97 } : undefined}
                title={unlocked ? fx.description : `${TIER_NAME[fx.tier]} — ${fx.description}`}
                onClick={() => unlocked ? save.mutate({ effectId: fx.id }) : undefined}
                style={{
                  ...btn,
                  cursor: unlocked ? 'pointer' : 'not-allowed',
                  // Locked options stay VISIBLE and frosted, never hidden — you should
                  // be able to see what a tier buys before buying it.
                  opacity: unlocked ? 1 : 0.4,
                  filter: unlocked ? 'none' : 'grayscale(0.8)',
                  borderColor: currentEffect === fx.id ? 'var(--phosphor-color)' : 'var(--border-color)',
                  background: currentEffect === fx.id ? 'rgba(212,176,64,0.18)' : 'rgba(212,176,64,0.04)',
                }}
              >
                {fx.label}{!unlocked && ` · ${TIER_NAME[fx.tier]}`}
              </motion.button>
            );
          })}
        </div>
      </div>

      {status?.tierEnabled && status.shopUrl && tier !== 'overseer' && (
        <p style={{ fontSize: '13px', marginTop: '14px' }}>
          <a href={status.shopUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--phosphor-color)' }}>
            Support the project
          </a>{' '}
          <span style={{ color: 'var(--text-muted)' }}>
            — every chat, moderation and overlay feature stays free. Supporting only
            changes how your name looks.
          </span>
        </p>
      )}

      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '12px' }}>
            {error}
          </motion.p>
        )}
        {saved && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ color: 'var(--phosphor-color)', fontSize: '13px', marginTop: '12px' }}>
            Saved.
          </motion.p>
        )}
      </AnimatePresence>
    </section>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Swatches({ presets, current, tier, onPick, shopUrl }: {
  presets: ColorPreset[]; current: string | null; tier: Tier;
  onPick: (id: string) => void; shopUrl?: string | null;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {presets.map(c => {
        const unlocked = tierAtLeast(tier, c.tier);
        return (
          <motion.button
            key={c.id}
            whileHover={unlocked ? { scale: 1.12 } : undefined}
            whileTap={unlocked ? { scale: 0.94 } : undefined}
            title={unlocked ? c.label : `${c.label} — ${TIER_NAME[c.tier]}${shopUrl ? '' : ''}`}
            aria-label={c.label}
            onClick={() => unlocked && onPick(c.id)}
            style={{
              width: '30px', height: '30px', borderRadius: '4px', background: c.hex,
              cursor: unlocked ? 'pointer' : 'not-allowed',
              opacity: unlocked ? 1 : 0.35,
              filter: unlocked ? 'none' : 'grayscale(0.7)',
              border: current === c.id ? '2px solid var(--text-primary)' : '1px solid var(--border-color)',
            }}
          />
        );
      })}
    </div>
  );
}

function PreviewRow({ bg, caption, name, color, effect, tag }: {
  bg: string; caption: string; name: string;
  color: string | null; effect: string | null; tag: string | null;
}) {
  return (
    <div style={{ minWidth: '210px' }}>
      <div style={{ ...label, marginBottom: '4px' }}>{caption}</div>
      <div style={{
        background: bg, padding: '9px 11px', borderRadius: '4px',
        border: '1px solid var(--border-color)', fontFamily: 'var(--font-mono)', fontSize: '13px',
      }}>
        {tag && <span className="fcm-name-tag" style={{ color: color ?? '#f0e8cc' }}>[{tag}]</span>}
        <span
          className={effect ? `fcm-name-fx--${effect}` : undefined}
          data-fcm-name={name}
          style={{
            fontWeight: 'bold',
            color: color ?? '#f0e8cc',
            ['--fcm-name-color' as string]: color ?? '#f0e8cc',
            ['--fcm-name-outline' as string]: '0 0 2px #000, 0 0 3px #000',
          } as React.CSSProperties}
        >
          {name}
        </span>
        <span style={{ color: '#c0a870' }}>: hey wanderer</span>
      </div>
    </div>
  );
}
