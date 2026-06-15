import React from 'react';

interface ImageLightboxProps {
  /** Full URL of the image to display. */
  src: string;
  /** Called when the user requests to close the lightbox. */
  onClose: () => void;
  /** Optional accent color for the close button and hint text (hex string). */
  accentColor?: string;
  /** Optional alt text for the image. */
  alt?: string;
}

/**
 * A self-contained image lightbox that absolutely fills its nearest
 * `position: relative` ancestor.
 *
 * Features:
 * - Dark backdrop; click backdrop (not image) to close.
 * - Scroll-wheel zooms at the cursor position (1×–8×).
 * - Drag to pan at any zoom; image may be pulled partly out of frame.
 * - Drag vs. click guard: a drag gesture does not trigger close.
 * - ✕ button (top-right) to close.
 * - Keyboard: Esc / Delete / Backspace close.
 * - Zoom + pan reset when `src` changes.
 */
export default function ImageLightbox({ src, onClose, accentColor = '#00FF7F', alt = '' }: ImageLightboxProps) {
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const draggedRef = React.useRef(false);
  const isDragging = dragRef.current !== null;

  // Reset zoom/pan whenever src changes.
  React.useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    dragRef.current = null;
    draggedRef.current = false;
  }, [src]);

  // Close on Esc / Delete / Backspace.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const dimAccent = accentColor + '73'; // ~45% opacity hex

  const btnStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.6)',
    border: `1px solid ${accentColor}55`,
    color: accentColor,
    cursor: 'pointer',
    borderRadius: '3px',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: 1,
    padding: '3px 8px',
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.93)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onWheel={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        const nz = Math.min(8, Math.max(1, zoom * factor));
        const ratio = nz / zoom;
        setPan({ x: mx - (mx - pan.x) * ratio, y: my - (my - pan.y) * ratio });
        setZoom(nz);
      }}
      onMouseDown={(e) => {
        dragRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
        draggedRef.current = false;
      }}
      onMouseMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.mx) > 3 || Math.abs(e.clientY - d.my) > 3) draggedRef.current = true;
        setPan({ x: d.px + (e.clientX - d.mx), y: d.py + (e.clientY - d.my) });
      }}
      onMouseUp={() => { dragRef.current = null; }}
      onMouseLeave={() => { dragRef.current = null; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !draggedRef.current) onClose();
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: isDragging ? 'none' : 'transform 0.08s ease-out',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />

      {/* Close button — top-right.
          stopPropagation on BOTH mousedown and click:
          - mousedown: prevents the backdrop's drag-start handler from capturing
            this click as a drag gesture (which could corrupt dragRef state).
          - click: prevents the backdrop's onClick from receiving the event
            (belt-and-suspenders; the drag guard would also block it, but this
            is cleaner and avoids any edge cases). */}
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close image"
        style={{ ...btnStyle, position: 'absolute', top: '8px', right: '12px', zIndex: 61 }}
      >
        &#10005;
      </button>

      {/* Hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '6px',
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: '9px',
          letterSpacing: '0.04em',
          color: dimAccent,
          pointerEvents: 'none',
        }}
      >
        scroll to zoom &middot; drag to pan &middot; &#10005; to close
      </div>
    </div>
  );
}
