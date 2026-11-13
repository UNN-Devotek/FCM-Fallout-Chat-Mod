/** Finish hiding only after the browser completes the visible body transition. */
export function afterHideTransition(
  body: HTMLElement,
  property: 'opacity' | 'clip-path',
  finish: () => void,
): () => void {
  let active = true;
  let frame: number | null = requestAnimationFrame(() => {
    frame = null;
    // getAnimations flushes pending styles, including a transition whose first
    // painted frame was delayed. A wall-clock timer cannot observe that delay.
    const transitions = body.getAnimations().filter(animation =>
      'transitionProperty' in animation && animation.transitionProperty === property);
    // Reversing on wake rejects finished; consume that rejection even after
    // cancellation has revoked this hide's authority to resize the window.
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (!active) return;
      active = false;
      finish();
    });
  });
  return () => {
    active = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
