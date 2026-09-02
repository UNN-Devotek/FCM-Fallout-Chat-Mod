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
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { api } from '../../services/api';
import { supporterBadge, supporterStarColor, SUPPORTER_STAR_GLYPH } from '../chat/supporterBadge';

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
  nameColor: string | null;
  starColor: string | null;
  effectId: string | null;
  tag: string | null;
  badges: string[];
  stored: {
    colorPresetId: string | null;
    starColorPresetId: string | null;
    effectId: string | null;
    customTag: string | null;
  } | null;
}

const TIER_ORDER: Tier[] = ['none', 'supporter', 'overseer'];
const tierAtLeast = (a: Tier, b: Tier) => TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b);
const TIER_NAME: Record<Tier, string> = { none: 'Free', supporter: 'Supporter', overseer: "Overseer's Circle" };

// ── Component ────────────────────────────────────────────────────────────────

export default function CosmeticsPanel({ userId, previewName }: { userId: string; previewName: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');

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

  const currentColor = cosmetics?.nameColor ?? null;
  const currentEffect = cosmetics?.effectId ?? null;
  const currentStar = supporterBadge(cosmetics?.badges);

  // The same stored tag is editable in the overlay's Settings → Appearance panel.
  // Sync only when the server value changes (initial load or another surface update),
  // never by deriving the input value on every render and erasing in-progress typing.
  useEffect(() => {
    setTagDraft(cosmetics?.stored?.customTag ?? '');
  }, [cosmetics?.stored?.customTag]);

  const { freeColors, paidColors } = useMemo(() => ({
    freeColors: (catalog?.colors ?? []).filter(c => c.tier === 'none'),
    paidColors: (catalog?.colors ?? []).filter(c => c.tier !== 'none'),
  }), [catalog]);

  // Also the kill switch: when SUPPORTER_TIER_ENABLED is false the whole
  // /api/cosmetics + /api/supporter router 404s, the catalog query fails, and the panel
  // renders nothing at all. No separate feature flag is threaded through the client —
  // the server simply does not offer the feature, which is the harder thing to get
  // wrong. Same reason the panel does not render a "coming soon" placeholder.
  if (!catalog) return null;

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
          name={previewName || 'YourName'} color={currentColor} effect={currentEffect} tag={cosmetics?.tag ?? null}
          starTier={currentStar?.tier ?? null} starColor={cosmetics?.starColor ?? null} />
        <PreviewRow bg="rgba(10,10,10,0.55)" caption="Overlay (translucent)"
          name={previewName || 'YourName'} color={currentColor} effect={currentEffect} tag={cosmetics?.tag ?? null}
          starTier={currentStar?.tier ?? null} starColor={cosmetics?.starColor ?? null} />
        {/* In-game deliberately previews WITHOUT the effect — Scaleform cannot render
            glow/animation, so showing it here would misrepresent what users get. */}
        <PreviewRow bg="#0a0a0a" caption="In-game HUD"
          name={previewName || 'YourName'} color={currentColor} effect={null} tag={cosmetics?.tag ?? null}
          starTier={currentStar?.tier ?? null} starColor={cosmetics?.starColor ?? null} />
      </div>

      {/* ── Supporter star colour ───────────────────────────────────────── */}
      <div style={{ marginBottom: '20px' }}>
        <div style={label}>Supporter star colour</div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          The supporter marker is always a star. Choose its colour independently from your name colour.
        </p>
        <Swatches presets={freeColors} current={cosmetics?.stored?.starColorPresetId ?? null} tier={tier}
          onPick={id => save.mutate({ starColorPresetId: id })} />
        <div style={{ ...label, marginTop: '14px' }}>Supporter star colours</div>
        <Swatches presets={paidColors} current={cosmetics?.stored?.starColorPresetId ?? null} tier={tier}
          onPick={id => save.mutate({ starColorPresetId: id })} shopUrl={status?.shopUrl ?? null} />
        <button type="button" disabled={save.isPending}
          onClick={() => save.mutate({ starColorPresetId: null })}
          style={{ ...btn, marginTop: '10px', fontSize: '12px' }}>
          Use tier default
        </button>
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

      {/* ── Overseer tag ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '12px' }}>
        <div style={label}>Custom tag — shows everywhere, including in-game</div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Overseer's Circle can add a short tag before the name. The game HUD renders
          the plain text tag even though it cannot render desktop visual effects.
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch', maxWidth: '360px' }}>
          <input
            aria-label="Custom tag"
            value={tagDraft}
            maxLength={16}
            disabled={!tierAtLeast(tier, 'overseer') || save.isPending}
            placeholder={tierAtLeast(tier, 'overseer') ? 'e.g. VAULT 76' : "Overseer's Circle required"}
            onChange={e => setTagDraft(e.target.value)}
            style={{
              flex: 1, minWidth: 0, padding: '7px 9px', borderRadius: '4px',
              border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
              color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '13px',
              opacity: tierAtLeast(tier, 'overseer') ? 1 : 0.45,
            }}
          />
          <button
            type="button"
            disabled={!tierAtLeast(tier, 'overseer') || save.isPending}
            onClick={() => save.mutate({ customTag: tagDraft.trim() || null })}
            style={{ ...btn, opacity: tierAtLeast(tier, 'overseer') ? 1 : 0.45 }}
          >
            Save tag
          </button>
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

function PreviewRow({ bg, caption, name, color, effect, tag, starTier, starColor }: {
  bg: string; caption: string; name: string;
  color: string | null; effect: string | null; tag: string | null;
  starTier: 'supporter' | 'overseer' | null; starColor: string | null;
}) {
  return (
    <div style={{ minWidth: '210px' }}>
      <div style={{ ...label, marginBottom: '4px' }}>{caption}</div>
      <div style={{
        background: bg, padding: '9px 11px', borderRadius: '4px',
        border: '1px solid var(--border-color)', fontFamily: 'var(--font-mono)', fontSize: '13px',
      }}>
        {tag && <span className="fcm-name-tag" style={{ color: color ?? '#f0e8cc' }}>[{tag}]</span>}
        <span className="fcm-name-identity">
          {starTier && <span className={`fcm-name-badge fcm-name-badge--${starTier}`} data-fcm-supporter-star="true"
            aria-label={starTier === 'overseer' ? "Overseer's Circle" : 'Supporter'}
            style={{ color: supporterStarColor([starTier], starColor) ?? undefined }}>
            {SUPPORTER_STAR_GLYPH}
          </span>}
          <span
            className={effect ? `fcm-name-fx--${effect}` : undefined}
            data-fcm-name={name}
            style={{
              fontWeight: effect === 'outline-heavy' ? 900 : 'bold',
              color: color ?? '#f0e8cc',
              ['--fcm-name-color' as string]: color ?? '#f0e8cc',
              ['--fcm-name-outline' as string]: '0 0 2px #000, 0 0 3px #000',
            } as React.CSSProperties}
          >
            {name}
          </span>
        </span>
        <span style={{ color: '#c0a870' }}>: hey wanderer</span>
      </div>
    </div>
  );
}
