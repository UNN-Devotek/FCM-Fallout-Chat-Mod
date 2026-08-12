/**
 * CosmeticsGuide — the user-facing guide to chat appearance and supporting the project.
 *
 * Follows HelpContent's `variant` pattern so ONE component serves both the public
 * landing page and the authenticated dashboard. That matters here more than usual: the
 * repo's `docs/` tree is never rendered on the website (no markdown route, no docs
 * generator, all 82 files are developer-facing), so user documentation has to be TSX or
 * it does not exist as far as users are concerned.
 *
 * Deliberately states the in-game effect limitation up front rather than in fine print.
 * Selling something a user reasonably expects to see where they play, and then not
 * delivering it there, is a fairness problem regardless of what the terms say.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

export type GuideVariant = 'dashboard' | 'public';

interface Props { variant?: GuideVariant }

interface TierInfo { id: string; label: string; priceUsdMonthly: number; colors: number; effects: number }
interface TiersResponse { enabled: boolean; shopUrl: string | null; tiers: TierInfo[] }

export default function CosmeticsGuide({ variant = 'dashboard' }: Props) {
  const isPublic = variant === 'public';

  const gold   = isPublic ? '#C8A840' : 'var(--phosphor-color)';
  const dim    = isPublic ? 'rgba(200,168,64,0.65)' : 'var(--text-secondary)';
  const muted  = isPublic ? 'rgba(200,168,64,0.4)' : 'var(--text-muted, #666)';
  const border = isPublic ? 'rgba(200,168,64,0.18)' : 'rgba(212,176,64,0.12)';
  const codeBg = isPublic ? 'rgba(200,168,64,0.12)' : 'rgba(212,176,64,0.12)';
  const font   = isPublic ? 'Courier New, monospace' : undefined;

  // Fails (and renders nothing) when the tier is switched off server-side — the
  // /api/supporter router 404s entirely in that state.
  const { data: tiers } = useQuery({
    queryKey: ['supporter-tiers'],
    queryFn: () => api.get<TiersResponse>('/api/supporter/tiers'),
    retry: false,
  });

  const sSection: React.CSSProperties = {
    fontSize: '15px', color: dim, margin: '26px 0 8px',
    letterSpacing: '2px', fontWeight: 'bold',
  };
  const sCode: React.CSSProperties = {
    background: codeBg, border: `1px solid ${border}`, borderRadius: '4px',
    padding: '2px 6px', fontFamily: 'Courier New, monospace', fontSize: '13px', color: gold,
  };
  const sTh: React.CSSProperties = {
    padding: '7px 12px', textAlign: 'left', color: dim, fontSize: '13px',
    borderBottom: `1px solid ${border}`, fontWeight: 'bold',
  };
  const sTd: React.CSSProperties = {
    padding: '7px 12px', borderBottom: `1px solid ${border}`,
    fontSize: '13px', verticalAlign: 'top', color: gold,
  };
  const p: React.CSSProperties = { fontSize: '13px', color: dim, marginBottom: '10px', lineHeight: 1.6 };

  return (
    <div style={{ flex: 1, padding: isPublic ? '24px 36px' : '0', overflowY: 'auto', fontFamily: font, color: gold }}>
      <h1 style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '6px' }}>
        CHAT APPEARANCE
      </h1>
      <p style={{ ...p, color: muted, marginBottom: '20px' }}>
        Customise how your name looks in chat. Everything on this page is optional, and
        every chat, moderation and overlay feature works exactly the same whether you
        change anything or not.
      </p>

      <p style={sSection}>TWO WAYS TO CHANGE YOUR APPEARANCE</p>
      <p style={p}>
        Both use the same settings — change something in one place and it updates
        everywhere immediately, including in messages already on screen.
      </p>
      <p style={p}>
        <strong style={{ color: gold }}>On the website:</strong> go to your Profile and
        find the <em>Chat appearance</em> panel. The separate <em>Chat name</em> panel
        above it is free for everyone.
      </p>
      <p style={p}>
        <strong style={{ color: gold }}>In Discord:</strong> use{' '}
        <code style={sCode}>/cosmetics</code> for colours, effects and tags, or{' '}
        <code style={sCode}>/name</code> for your free chat name. Replies are only visible to you.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
        <thead><tr><th style={{ ...sTh, width: '210px' }}>Command</th><th style={sTh}>What it does</th></tr></thead>
        <tbody>
          {[
            ['/cosmetics show', 'See what your name currently looks like'],
            ['/name', 'Change your free chat name (no supporter tier or cooldown)'],
            ['/cosmetics color', 'Pick a name colour'],
            ['/cosmetics effect', 'Pick a name effect (supporters)'],
            ['/cosmetics tag', "Set a tag beside your name (Overseer's Circle)"],
            ['/cosmetics clear', 'Go back to the default look'],
            ['/cosmetics help', 'A short version of this page'],
          ].map(([cmd, desc]) => (
            <tr key={cmd}>
              <td style={sTd}><code style={sCode}>{cmd}</code></td>
              <td style={sTd}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={sSection}>WHERE EACH THING SHOWS UP</p>
      <p style={p}>
        Fallout Chat Mod renders in three places, and they do not all support the same
        things. This is worth reading <em>before</em> you pick an effect.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10px' }}>
        <thead>
          <tr>
            <th style={sTh}>&nbsp;</th>
            <th style={sTh}>Website</th>
            <th style={sTh}>Desktop overlay</th>
            <th style={sTh}>In-game</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Display name', 'Yes', 'Yes', 'Yes'],
            ['Name colour', 'Yes', 'Yes', 'Yes'],
            ['Tag', 'Yes', 'Yes', 'Yes'],
            ['Badge', 'Yes', 'Yes', 'As text'],
            ['Effects (glow, CRT, glitch, shimmer)', 'Yes', 'Yes', 'No'],
          ].map(row => (
            <tr key={row[0]}>
              <td style={{ ...sTd, color: dim }}>{row[0]}</td>
              {row.slice(1).map((cell, i) => (
                <td key={i} style={{ ...sTd, color: cell === 'No' ? muted : gold }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...p, color: muted }}>
        Effects cannot appear in the in-game HUD. The game's interface engine crashes
        outright if a mod tries to apply glow or animation to text, so this is a hard
        limit of Fallout 76 itself rather than something we have chosen to hold back or
        might add later. In-game shows your colour and tag, which is the complete set of
        what the game can draw.
      </p>

      <p style={sSection}>NAME RULES</p>
      <ul style={{ ...p, paddingLeft: '18px' }}>
        <li>2 to 32 characters.</li>
        <li>
          A few characters are removed automatically because they break the in-game chat
          display: <code style={sCode}>~ | " \\ &lt; &gt; &amp;</code>
        </li>
        <li>Names go through the same moderation filter as chat messages.</li>
        <li>
          There is a cooldown between name changes — 30 days normally, 7 days for
          supporters, 24 hours for Overseer's Circle.
        </li>
      </ul>

      <p style={sSection}>TURNING IT OFF</p>
      <p style={p}>
        Use <code style={sCode}>/cosmetics clear</code>, or the reset controls on your
        Profile, to go back to the default look at any time.
      </p>
      <p style={p}>
        If you find other people's animated names distracting while you play, the desktop
        overlay has <em>Disable animated name effects</em> under Settings → Appearance.
        That only changes what <strong style={{ color: gold }}>you</strong> see. Animated
        names also automatically become static if your system has "reduce motion" enabled.
      </p>

      {tiers?.enabled && (
        <>
          <p style={sSection}>SUPPORTING THE PROJECT</p>
          <p style={p}>
            Supporting is entirely optional and funds hosting and development. It only
            changes how your name looks — it never unlocks a feature, gives you an
            advantage, or takes anything away from anyone who does not.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10px' }}>
            <thead>
              <tr>
                <th style={sTh}>Tier</th><th style={sTh}>Price</th>
                <th style={sTh}>Colours</th><th style={sTh}>Effects</th>
              </tr>
            </thead>
            <tbody>
              {tiers.tiers.map(t => (
                <tr key={t.id}>
                  <td style={sTd}>{t.label}</td>
                  <td style={sTd}>{t.priceUsdMonthly === 0 ? 'Free' : `$${t.priceUsdMonthly}/mo`}</td>
                  <td style={sTd}>{t.colors}</td>
                  <td style={sTd}>{t.effects}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ ...p, color: muted }}>
            Subscriptions are handled by Discord, not by us — including billing,
            cancellation and refunds. Manage or cancel yours from Discord's subscription
            settings at any time.
          </p>
          <p style={{ ...p, color: muted }}>
            Supporter perks are delivered through a Discord role, so you need to be in
            the Fallout Chat Mod Discord server for them to be active. If you leave, your
            name goes back to default — but your subscription is remembered, so rejoining
            brings everything back with nothing more to pay.
          </p>
          {tiers.shopUrl && (
            <p style={{ marginTop: '14px' }}>
              <a href={tiers.shopUrl} target="_blank" rel="noreferrer"
                style={{ color: gold, fontWeight: 'bold' }}>
                Support Fallout Chat Mod
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
