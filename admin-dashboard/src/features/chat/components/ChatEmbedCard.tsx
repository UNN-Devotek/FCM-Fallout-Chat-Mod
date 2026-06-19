import React from 'react';
import './chat-embeds.css';

/**
 * ChatEmbedCard — shared, fully-responsive card for every chat-feed embed
 * (wiki_share, party_invite, nuke_codes, server_status, …).
 *
 * STANDARD: this is the only chat component that uses a stylesheet instead of
 * inline styles — true "one row when wide, wrap as it narrows" behavior needs
 * CSS container queries (see chat-embeds.css), which can't be expressed inline.
 * The component only sets content + the `--fcm-*` custom properties.
 *
 * Anatomy:
 *   • Header (flex-wrap, single line when wide): tag · title · badges · meta · actions
 *   • Body grid (optional): label→value fields, auto-fit 1–2 columns
 *   • Footer (optional): freeform node below the grid
 */

export interface ChatEmbedField {
  label: string;
  value: React.ReactNode;
  /** Optional extra style for the value cell (e.g. fontFamily: monospace). */
  valueStyle?: React.CSSProperties;
}

export interface ChatEmbedCardProps {
  /** Hex color driving the accent rail, badge, title, glow, and tints. */
  accent: string;
  /** Optional leading glyph rendered LARGER than the tag text (e.g. "☢", "▣", "⌂"). */
  icon?: string;
  /** Small all-caps tag at the header left (text only, e.g. "NUKE CODES"). */
  tag: string;

  title: React.ReactNode;
  /** Click handler for the title (adds pointer + underline + focus ring). */
  onTitleClick?: () => void;
  /** Adds an accent text-shadow glow on the title. */
  titleGlow?: boolean;

  /** Small pill badges after the title. */
  badges?: string[];
  /** Inline meta that sits in the header when wide, wraps down when narrow
      (e.g. an attribution link). */
  inlineMeta?: React.ReactNode;
  /** Action element pinned right (button, etc.); drops to its own row when narrow. */
  actions?: React.ReactNode;

  /** Label/value pairs rendered as an auto-fitting grid. */
  fields?: ChatEmbedField[];
  /** Force the fields grid into a single column regardless of card width. */
  singleColumn?: boolean;
  /** Freeform node below the grid. */
  footer?: React.ReactNode;

  // Theme pass-through (kept for parity / future use).
  hexAlpha: (hex: string, alpha: number) => string;
  fontFamily: string;
  fontSize: number;
  /** Dim text color for meta/labels. */
  dimText?: string;
  /** If provided, renders a "Send to chat" button pinned to the bottom-right. */
  onShareToChat?: () => void;
  /** Disables the "Send to chat" button (e.g. during the post cooldown). */
  shareDisabled?: boolean;
}

export const ChatEmbedCard: React.FC<ChatEmbedCardProps> = ({
  accent,
  icon,
  tag,
  title,
  onTitleClick,
  titleGlow = false,
  badges,
  inlineMeta,
  actions,
  fields,
  footer,
  singleColumn = false,
  fontFamily,
  fontSize,
  dimText,
  onShareToChat,
  shareDisabled = false,
}) => {
  // Theme-driven values flow in as CSS custom properties; layout lives in CSS.
  const rootVars = {
    '--fcm-accent': accent,
    '--fcm-ff': fontFamily,
    '--fcm-fs': `${fontSize}px`,
    '--fcm-fs-sm': `${Math.max(8, fontSize - 3)}px`,
    ...(dimText ? { '--fcm-dim': dimText } : {}),
  } as React.CSSProperties;

  const titleClass =
    'fcm-embed__title' +
    (onTitleClick ? ' fcm-embed__title--link' : '') +
    (titleGlow ? ' fcm-embed__title--glow' : '');

  return (
    <div className="fcm-embed" style={rootVars}>
      <div className="fcm-embed__header">
        {/* fontFamily is set directly on both tag and title (not via var(--fcm-ff))
            so their computed font is provably identical — CSS custom property
            resolution in inline styles can differ from class-rule inheritance in
            some Chromium/Electron contexts, causing a perceived font mismatch. */}
        {icon ? <span className="fcm-embed__icon" aria-hidden="true">{icon}</span> : null}
        {tag ? <span className="fcm-embed__tag" style={{ fontFamily }}>{tag}</span> : null}

        {onTitleClick ? (
          <span
            className={titleClass}
            style={{ fontFamily }}
            role="button"
            tabIndex={0}
            onClick={onTitleClick}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTitleClick(); } }}
          >{title}</span>
        ) : (
          <span className={titleClass} style={{ fontFamily }}>{title}</span>
        )}

        {badges && badges.map((b, i) => (
          <span key={i} className="fcm-embed__badge">{b}</span>
        ))}

        {inlineMeta && <span className="fcm-embed__meta">{inlineMeta}</span>}

        {actions && <div className="fcm-embed__actions">{actions}</div>}
      </div>

      {fields && fields.length > 0 && (
        <div className={`fcm-embed__grid${singleColumn ? ' fcm-embed__grid--single' : ''}`}>
          {fields.map((f, i) => (
            <div className="fcm-embed__field" key={i}>
              <span className="fcm-embed__label">{f.label}</span>
              <span className="fcm-embed__value" style={f.valueStyle}>{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {footer && <div className="fcm-embed__footer">{footer}</div>}

      {onShareToChat && (
        <div className="fcm-embed__share">
          <button
            className="fcm-embed__share-btn"
            style={{ fontFamily, opacity: shareDisabled ? 0.4 : undefined, cursor: shareDisabled ? 'default' : 'pointer' }}
            onClick={shareDisabled ? undefined : onShareToChat}
            disabled={shareDisabled}
            title={shareDisabled ? 'Please wait a minute between shares' : undefined}
          >{shareDisabled ? 'Shared — cooling down…' : 'Send to chat ↗'}</button>
        </div>
      )}
    </div>
  );
};

export default ChatEmbedCard;
