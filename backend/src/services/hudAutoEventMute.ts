import prisma from '../config/prisma';
import { bindRequiredTransactionClient, createRequiredAudit, isPrismaAtomicRefusal, isRowCountNoChange, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';

export const GLOBAL_HUD_AUTO_EVENT_MUTE_KEY = 'hud_auto_events_muted_globally';

export async function getGlobalHudAutoEventMute(): Promise<boolean> {
  const setting = await prisma.moderationSetting.findUnique({
    where: { key: GLOBAL_HUD_AUTO_EVENT_MUTE_KEY }, select: { value: true },
  });
  return setting?.value === 'true';
}

export async function setGlobalHudAutoEventMute(actorId: string, muted: boolean): Promise<void> {
  const key = GLOBAL_HUD_AUTO_EVENT_MUTE_KEY;
  const value = String(muted);
  await runRequiredTransaction('moderation', 'global-hud-auto-event-mute:transaction',
    { stage: 'transaction-completion-unconfirmed' }, () => prisma.$transaction(async tx => {
      bindRequiredTransactionClient(tx);
      await runRequiredMutation('moderation', 'global-hud-auto-event-mute:initialize',
        { stage: 'primary-write-unconfirmed' }, () => tx.moderationSetting.createMany({
          data: { key, value: 'false' }, skipDuplicates: true,
        }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      const { count } = await runRequiredMutation('moderation', 'global-hud-auto-event-mute:update',
        { stage: 'primary-write-unconfirmed' }, () => tx.moderationSetting.updateMany({
          where: { key, value: { not: value } }, data: { value },
        }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      if (count === 0) return;

      await createRequiredAudit(tx.auditLog, {
        data: {
          actorId,
          action: muted ? 'mute_hud_auto_events_globally' : 'unmute_hud_auto_events_globally',
          targetType: 'moderation_setting',
          metadata: { key, value: muted },
        },
      }, {}, tx);
    }), { confirmedRollback: isPrismaAtomicRefusal });
}
