export type ScheduledEventStatus = 'Upcoming' | 'Live' | 'Ended' | 'Canceled' | 'Deleted';

export interface ScheduledEventActionState {
  readonly canOpenDiscord: boolean;
  readonly viewerLabel: 'YOU ARE INTERESTED' | 'NOT INTERESTED' | 'UNLINKED' | null;
}

export function scheduledEventAccent(status: ScheduledEventStatus): string {
  switch (status) {
    case 'Live': return '#55EFC4';
    case 'Canceled': return '#FF6B4A';
    case 'Ended':
    case 'Deleted': return '#8A8A8A';
    case 'Upcoming': return '#C8A840';
  }
}

export function scheduledEventActionState(
  status: ScheduledEventStatus,
  discordEventUrl: string | null,
  isViewerInterested?: boolean | null,
): ScheduledEventActionState {
  return {
    canOpenDiscord: !!discordEventUrl && status !== 'Deleted',
    viewerLabel: isViewerInterested === true
      ? 'YOU ARE INTERESTED'
      : isViewerInterested === false
        ? 'NOT INTERESTED'
        : isViewerInterested === null
          ? 'UNLINKED'
          : null,
  };
}

export function scheduledEventCountdown(
  status: ScheduledEventStatus,
  startUtc: string | null,
  nowMs: number = Date.now(),
): string | null {
  if (status !== 'Upcoming' || !startUtc) return null;
  const startMs = new Date(startUtc).getTime();
  if (!Number.isFinite(startMs) || startMs <= nowMs) return null;
  const minutes = Math.ceil((startMs - nowMs) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ''}`;
}
