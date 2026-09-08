import { describe, expect, it } from 'vitest';
import {
  scheduledEventAccent,
  scheduledEventActionState,
  scheduledEventCountdown,
} from '../scheduledEventPresentation';

describe('scheduled event presentation', () => {
  it('uses semantic lifecycle accents', () => {
    expect(scheduledEventAccent('Upcoming')).toBe('#C8A840');
    expect(scheduledEventAccent('Live')).toBe('#55EFC4');
    expect(scheduledEventAccent('Canceled')).toBe('#FF6B4A');
    expect(scheduledEventAccent('Ended')).toBe('#8A8A8A');
    expect(scheduledEventAccent('Deleted')).toBe('#8A8A8A');
  });

  it('keeps Discord as the only attendance action', () => {
    expect(scheduledEventActionState('Upcoming', 'https://discord.com/events/1/2', true)).toEqual({
      canOpenDiscord: true,
      viewerLabel: 'YOU ARE INTERESTED',
    });
    expect(scheduledEventActionState('Upcoming', 'https://discord.com/events/1/2', null).viewerLabel).toBe('UNLINKED');
    expect(scheduledEventActionState('Upcoming', 'https://discord.com/events/1/2', false).viewerLabel).toBe('NOT INTERESTED');
    expect(scheduledEventActionState('Deleted', 'https://discord.com/events/1/2', false).canOpenDiscord).toBe(false);
  });

  it('only shows a countdown for a future Upcoming event', () => {
    const now = Date.parse('2026-09-08T19:00:00.000Z');
    expect(scheduledEventCountdown('Upcoming', '2026-09-08T20:30:00.000Z', now)).toBe('1h 30m');
    expect(scheduledEventCountdown('Live', '2026-09-08T20:30:00.000Z', now)).toBeNull();
    expect(scheduledEventCountdown('Upcoming', '2026-09-08T18:30:00.000Z', now)).toBeNull();
  });
});
