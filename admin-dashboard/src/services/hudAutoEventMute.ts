export const GLOBAL_HUD_MUTE_PATH = '/api/moderation/hud-auto-event-mute';

export function accountHudMutePath(userId: string): string {
  return `/api/moderation/users/${encodeURIComponent(userId)}/hud-auto-event-mute`;
}
