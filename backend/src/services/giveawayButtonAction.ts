export type GiveawayButtonAction = 'join' | 'leave' | 'stop';

export function parseGiveawayButtonId(customId: string): { action: GiveawayButtonAction; shortId: string } | null {
  const match = /^fcm:giveaway:(join|leave|stop):([A-HJ-NP-Z2-9]{6})$/.exec(customId);
  return match ? { action: match[1] as GiveawayButtonAction, shortId: match[2] } : null;
}

export interface GiveawayButtonService {
  joinGiveaway(shortId: string, userId: string, displayName: string): Promise<{ entryCount: number }>;
  leaveGiveaway(shortId: string, userId: string): Promise<{ entryCount: number }>;
  cancelGiveaway(shortId: string, userId: string, isMod: boolean): Promise<void>;
}

export async function executeGiveawayButton(
  button: { action: GiveawayButtonAction; shortId: string },
  user: { id: string; displayName: string; isMod: boolean },
  service: GiveawayButtonService,
): Promise<string> {
  const { action, shortId } = button;
  if (action === 'join') {
    const result = await service.joinGiveaway(shortId, user.id, user.displayName);
    return `Entered giveaway ${shortId}. Entries: ${result.entryCount}.`;
  }
  if (action === 'leave') {
    const result = await service.leaveGiveaway(shortId, user.id);
    return `Left giveaway ${shortId}. Entries: ${result.entryCount}.`;
  }
  await service.cancelGiveaway(shortId, user.id, user.isMod);
  return `Giveaway ${shortId} cancelled.`;
}
