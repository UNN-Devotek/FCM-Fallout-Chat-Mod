/** Desktop-only frame-time guard for repeating decorative motion.
 *
 * A transparent always-on-top Chromium surface shares composition time with the
 * game. Even a bounded 10 Hz sampler creates recurring main-thread and paint work,
 * so the desktop overlay holds most decorative CSS animations on their first
 * frame. Glitch stays paused too, but seeks at its four discrete tear boundaries
 * while visible. No frame loop, geometry polling or per-name React updates.
 * Interaction transitions are not selected and continue to run normally.
 */
function scheduleGlitch(animation: Animation, duration: number, delay: number) {
  const started = performance.now();
  // The stepped tear states in shared nameEffects.css; skip the unchanged rest
  // of the cycle, including the wraparound. Each layer has one pending timeout.
  const boundaries = [0.93, 0.95, 0.97, 0.99, 1.93];
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const elapsed = performance.now() - started;
    animation.currentTime = elapsed;
    const position = (((elapsed - delay) % duration) + duration) % duration / duration;
    const next = boundaries.find(boundary => boundary > position) ?? 1.93;
    // Seek just after the boundary: Chromium can round an exact 93% seek to
    // 0.9299999999999999 and otherwise hold the preceding frame until 95%.
    timer = setTimeout(tick, Math.max(1, Math.ceil((next - position) * duration - 0.000001) + 1));
  };
  tick();
  return { duration, delay, stop() { stopped = true; clearTimeout(timer); } };
}

export function observeAmbientMotion(root: HTMLElement, scope: HTMLElement = root) {
  const doc = root.ownerDocument;
  const reduced = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const entries = new Map<Animation, { target: Element; burst?: ReturnType<typeof scheduleGlitch> }>();
  let disposed = false;
  let visible = true;
  const names = new Set(['fcm-typing-dot', 'fcm-unread-pulse', 'fcm-glow-pulse',
    'fcm-crt-flicker', 'fcm-glitch-r', 'fcm-glitch-c', 'fcm-shimmer-highlight', 'fcm-chroma-preview']);
  const sync = () => {
    if (disposed || !scope.getAnimations) return;
    const animations = scope.getAnimations({ subtree: true }).filter(animation =>
      'animationName' in animation && typeof animation.animationName === 'string' && names.has(animation.animationName));
    const next = new Set(animations);
    for (const [animation, entry] of entries) {
      if (!next.has(animation)) {
        entry.burst?.stop(); entry.target.removeAttribute('data-fcm-status-motion'); entries.delete(animation);
      }
    }
    for (const animation of animations) {
      let entry = entries.get(animation);
      if (!entry) {
        const target = animation.effect && 'target' in animation.effect ? animation.effect.target : null;
        if (!(target instanceof Element) || !('animationName' in animation) || typeof animation.animationName !== 'string') continue;
        entry = { target };
        entries.set(animation, entry);
        animation.pause();
        target.setAttribute('data-fcm-status-motion', animation.animationName);
      } else if (animation.playState === 'running') animation.pause();
      if ('animationName' in animation && (animation.animationName === 'fcm-glitch-r' || animation.animationName === 'fcm-glitch-c')) {
        const timing = animation.effect?.getTiming();
        const duration = timing?.duration;
        const delay = timing?.delay ?? 0;
        const active = visible && !doc.hidden && !reduced?.matches
          && !doc.documentElement.classList.contains('fcm-full-auto-hidden')
          && !doc.documentElement.classList.contains('fcm-full-auto-fading')
          && !(root.classList.contains('collapsed') && root.contains(entry.target))
          && !entry.target.closest('[data-fcm-motion-paused],.fcm-no-name-motion');
        const valid = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && Number.isFinite(delay);
        if (entry.burst && (!active || !valid || entry.burst.duration !== duration || entry.burst.delay !== delay)) {
          entry.burst.stop(); entry.burst = undefined;
        }
        if (active && valid) {
          if (!entry.burst) entry.burst = scheduleGlitch(animation, duration, delay);
        } else animation.currentTime = 0;
      } else {
        animation.currentTime = 0;
      }
    }
  };
  const mutations = new MutationObserver(sync);
  mutations.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-fcm-motion-paused'] });
  mutations.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  doc.addEventListener('visibilitychange', sync);
  reduced?.addEventListener('change', sync);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    mutations.disconnect();
    doc.removeEventListener('visibilitychange', sync);
    reduced?.removeEventListener('change', sync);
    doc.defaultView?.removeEventListener('pagehide', dispose);
    for (const entry of entries.values()) { entry.burst?.stop(); entry.target.removeAttribute('data-fcm-status-motion'); }
    entries.clear();
  };
  doc.defaultView?.addEventListener('pagehide', dispose);
  sync();
  return { dispose, setVisible(value: boolean) { visible = value; sync(); } };
}
