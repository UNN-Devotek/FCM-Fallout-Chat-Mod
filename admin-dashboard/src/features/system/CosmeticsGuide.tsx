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
import { XSCAL_INPUT_ARTICLE_URL, ZFE_MODDER_GUIDE_URL } from './HudKeybindGuide';

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

      <section aria-label="In-game HUD customization">
        <h2 style={sSection}>IN-GAME HUD CUSTOMIZATION</h2>
        <p style={p}>
          In the updated HUD build, open <strong>F11 → FCM → Customize</strong>.
          These controls change your local HUD, independently of your profile cosmetics.
          They are being prepared for release and are not available in older HUD packages.
        </p>
        <ul style={{ ...p, paddingLeft: '18px' }}>
          <li>Adjust panel width and height independently, and move the panel.</li>
          <li>Adjust input height and input text size. Input width and alignment stay fixed to the widget’s input area, including the ZFE editor drawn over it.</li>
          <li>Adjust feed text size and background opacity.</li>
          <li>Choose panel, tab-box, input-box and border colors under Colors.</li>
          <li>Choose message, input, default name, active/inactive tab and hint font colors. Other players’ chosen name colors remain intact.</li>
          <li>Turn auto-hide on or off independently of its remembered delay; adjust the delay in five-second steps.</li>
          <li>Reset all HUD settings to their defaults.</li>
        </ul>
        <p style={p}>
          Badges, channel tags and their visibility/colors, emojis, the default channel,
          and the available channels are fixed by the HUD. They have no appearance controls.
          You can still switch chat channels normally.
        </p>
        <p style={p}>
          For precise values, edit the <code style={sCode}>[FCMChat]</code> section of{' '}
          <code style={sCode}>Data/FCMChat.ini</code>. Use <code style={sCode}>inputHeight</code>{' '}
          (28–120), <code style={sCode}>inputFontSize</code> (8–47, or 0 for default sizing),{' '}
          <code style={sCode}>bgAlpha</code> (0–1), and color keys such as{' '}
          <code style={sCode}>inputBgColor</code> and <code style={sCode}>inputTextColor</code>{' '}
          with <code style={sCode}>#RRGGBB</code> values. Keep{' '}
          <code style={sCode}>autoHideEnabled=false</code> to disable auto-hide without losing{' '}
          <code style={sCode}>autoHideSec</code>.
        </p>
        <p style={p}>
          F11 changes apply immediately. ZFE saves them in local settings; xScal saves them
          per linked device with the matching backend update. ZFE’s saved F11 settings
          take priority over the INI. Follow the packaged customization guide for reload
          and saved-settings instructions.
        </p>
        <h3 style={sSection}>OPEN-CHAT KEY</h3>
        <p style={p}>
          ZFE users can replace the default <strong>Insert</strong> open-chat key. Keep the two
          shipped settings identical: set <code style={sCode}>openKey=DELETE</code> under{' '}
          <code style={sCode}>[FCMChat]</code> in <code style={sCode}>Data/FCMChat.ini</code>, then
          set <code style={sCode}>OpenChatKey=DELETE</code> under{' '}
          <code style={sCode}>[TextChat]</code> in{' '}
          <code style={sCode}>Data/configuration/zfe.ini</code>. Preserve the other settings and
          keep one <code style={sCode}>[TextChat]</code> section. Restart Fallout 76 afterward.
        </p>
        <p style={p}>
          ZFE accepts <code style={sCode}>INSERT</code>, <code style={sCode}>DELETE</code>,{' '}
          <code style={sCode}>HOME</code>, <code style={sCode}>END</code>,{' '}
          <code style={sCode}>PAGE_DOWN</code> (also <code style={sCode}>PAGEDOWN</code> or{' '}
          <code style={sCode}>PGDN</code>), and one letter or digit. Delete is the recommended
          alternative when Insert conflicts with another mod. Avoid Page Down if you use it to
          switch FCM channels. Letter and digit keys may conflict with gameplay or typing.
          {' '}See the <a href={ZFE_MODDER_GUIDE_URL} target="_blank" rel="noopener noreferrer" style={{ color: gold }}>
            ZFE Modder Guide
          </a> for the extender hotkey surface.
        </p>
        <p style={p}>
          The global <code style={sCode}>zfe.ini</code> value overrides the widget fragment in{' '}
          <code style={sCode}>Data/ZFE/TextChat/fragments</code>. Page Up/Down and Arrow Up/Down
          remain fixed navigation controls; the packaged <code style={sCode}>KEYBINDS.txt</code>{' '}
          explains the other HUD action-name settings.
        </p>
        <p style={p}>
          <strong>xScal is different:</strong> it has no <code style={sCode}>OpenChatKey</code>{' '}
          setting in <code style={sCode}>xscal.ini</code>. The widget maps{' '}
          <code style={sCode}>Data/FCMChat.ini</code> <code style={sCode}>openKey</code> to xScal's
          documented physical input polling, with the named HUDMod action as a fallback. Do not
          add ZFE settings to <code style={sCode}>xscal.ini</code>. xScal's keyboard registration
          does not suppress the key from gameplay, so test for conflicts; its documented
          suppression calls are for gamepad buttons. See the{' '}
          <a href={XSCAL_INPUT_ARTICLE_URL} target="_blank" rel="noopener noreferrer" style={{ color: gold }}>
            xScal Input interface (Nexus article 268)
          </a>.
        </p>
      </section>

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
        <code style={sCode}>/cosmetics</code> for colours, effects, the supporter star and tags, or{' '}
        <code style={sCode}>/name</code> for your free chat name. Replies are only visible to you.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
        <thead><tr><th style={{ ...sTh, width: '210px' }}>Command</th><th style={sTh}>What it does</th></tr></thead>
        <tbody>
          {[
            ['/cosmetics show', 'See what your name currently looks like'],
            ['/name', 'Change your free chat name (no supporter tier or cooldown)'],
            ['/cosmetics color', 'Pick a name colour'],
            ['/cosmetics star', 'Pick the colour of the supporter star (the glyph is always ★)'],
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
            ['Supporter star (★)', 'Yes', 'Yes', 'As text'],
            ['Star colour', 'Yes', 'Yes', 'Yes'],
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
        The supporter marker is always the fixed <code style={sCode}>★</code> glyph. Its
        colour is selected independently from the name colour, and arbitrary text or
        glyphs can never replace it. The star appears only while an active Supporter or
        Overseer's Circle role is present; a saved selection is restored if a supporter
        rejoins the Discord server.
      </p>
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
        Profile, to go back to the default look at any time. To reset only the marker
        colour, use <code style={sCode}>/cosmetics clear field:star</code>.
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
