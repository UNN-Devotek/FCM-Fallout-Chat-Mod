import React from 'react';
import './chat-embeds.css';

/**
 * ChatInlineEmbed — shared INLINE embed for STATIC, broadcast-to-everyone chat
 * messages (wiki shares, party invites, …).
 *
 * STANDARD (see also ChatEmbedCard):
 *   • Ephemeral / sender-only responses (e.g. /nukecodes, /serverstatus) → boxed
 *     `ChatEmbedCard`.
 *   • Static messages everyone sees (persisted + broadcast) → this inline embed,
 *     rendered AS THE MESSAGE CONTENT through the normal message renderer, so the
 *     channel tag + sender name match every other message exactly.
 *
 * Composes: [icon] [lead text] [title (link/glow)] [badge] [· meta] [action]
 */

export interface ChatInlineEmbedProps {
  /** Hex accent color (theme primary, or a party's color). */
  accent: string;
  /** Leading glyph, e.g. "◈" (wiki) or "✦" (party). */
  icon?: React.ReactNode;
  /** Freeform lead text before the title (e.g. "invited everyone to join"). */
  children?: React.ReactNode;
  /** The bold entity name (item / party). */
  title?: React.ReactNode;
  onTitleClick?: () => void;
  titleGlow?: boolean;
  /** Small bordered kind pill after the title. */
  badge?: string;
  /** Trailing "· label" link (e.g. attribution). */
  meta?: { label: React.ReactNode; onClick?: () => void; title?: string };
  /** Trailing interactive slot (e.g. a JOIN button). */
  action?: React.ReactNode;

  /** Base font size (px) — drives the small-text custom property. */
  fontSize: number;
  /** Dim color for separators (rgba string). */
  dimText?: string;
}

export const ChatInlineEmbed: React.FC<ChatInlineEmbedProps> = ({
  accent, icon, children, title, onTitleClick, titleGlow, badge, meta, action, fontSize, dimText,
}) => {
  const vars = {
    '--fcm-accent': accent,
    '--fcm-fs-sm': `${Math.max(8, fontSize - 3)}px`,
    ...(dimText ? { '--fcm-dim': dimText } : {}),
  } as React.CSSProperties;

  const titleClass =
    'fcm-inline__title' +
    (onTitleClick ? ' fcm-inline__title--link' : '') +
    (titleGlow ? ' fcm-inline__title--glow' : '');

  return (
    <span className="fcm-inline" style={vars}>
      {icon != null && <span className="fcm-inline__icon">{icon}</span>}
      {children}
      {title != null && (
        onTitleClick ? (
          <span
            className={titleClass}
            role="button"
            tabIndex={0}
            title="Open in the overlay"
            onClick={onTitleClick}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTitleClick(); } }}
          >{title}</span>
        ) : (
          <span className={titleClass}>{title}</span>
        )
      )}
      {badge && <span className="fcm-inline__badge">{badge}</span>}
      {meta && (
        <>
          <span className="fcm-inline__sep">&middot;</span>
          <span
            className="fcm-inline__meta"
            role="button"
            tabIndex={0}
            title={meta.title}
            onClick={meta.onClick}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && meta.onClick) meta.onClick(); }}
          >{meta.label}</span>
        </>
      )}
      {action && <span className="fcm-inline__action">{action}</span>}
    </span>
  );
};

export default ChatInlineEmbed;
