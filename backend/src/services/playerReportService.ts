/**
 * Player-report intake for the Discord "Report a Player" button. Writes straight
 * to the same `player_reports` table the website form uses (the bot runs in-process
 * with the backend, so no HTTP/auth hop) and fires the existing mod-log alert.
 * Mirrors playerReportsController.createPlayerReportWeb.
 */
import crypto from 'crypto';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { uploadReportImages } from './reportImageService';
import {
  clampReportContent,
  sanitizeInvolvedPlayers,
  capImageUrls,
  remainingImageSlots,
  REPORT_IMAGE_MAX,
} from './playerReportHelpers';

interface DiscordReporter {
  discordId: string;
  username?: string | null;
  displayName?: string | null;
  avatar?: string | null;
}

/** Resolve (or lazily create) the User row for a Discord identity — mirrors the controller. */
async function resolveUserByDiscordId(r: DiscordReporter) {
  let user = await prisma.user.findFirst({ where: { discordId: r.discordId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        username: `discord:${r.discordId}`,
        installToken: crypto.randomUUID(),
        discordId: r.discordId,
        discordUsername: r.username ?? null,
        discordDisplayName: r.displayName ?? null,
        discordAvatar: r.avatar || null,
      },
    });
  }
  return user;
}

export interface CreatedPlayerReport {
  id: string;
  reportNumber: number;
  reporterName: string;
  reporterDiscordId: string;
  involvedPlayers: string | null;
}

/** Create a player report from a Discord submission + fire the mod-log alert. */
export async function createPlayerReport(input: DiscordReporter & {
  content: string;
  involvedPlayers?: string | null;
}): Promise<CreatedPlayerReport> {
  const user = await resolveUserByDiscordId(input);
  const content = clampReportContent(input.content);
  const involved = sanitizeInvolvedPlayers(input.involvedPlayers);

  const report = await prisma.playerReport.create({
    data: { userId: user.id, content, reportType: 'player', involvedPlayers: involved, status: 'open' },
  });

  const reporterName = user.discordDisplayName || user.discordUsername || user.username || input.discordId;
  // Mod-log alert (fire-and-forget). Lazy-require to avoid an import cycle
  // (discordService -> ticketService -> playerReportService -> discordService).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postModAlert } = require('./discordService') as { postModAlert: (d: any) => Promise<unknown> };
    postModAlert({
      title: '🚩 Player Report Submitted (Discord)',
      color: '#F1C40F',
      fields: [
        { name: 'Reporter', value: String(reporterName), inline: true },
        { name: 'Type', value: 'player', inline: true },
        { name: 'Content', value: content.slice(0, 1500) },
        ...(involved ? [{ name: 'Involved Players', value: involved.slice(0, 1024) }] : []),
      ],
      timestamp: true,
      footerText: `Report ID: ${report.id}`,
    }).catch(() => {});
  } catch {
    /* discordService not ready — non-fatal */
  }

  logger.info({ reportId: report.id, number: report.reportNumber, by: input.discordId }, 'player-report: created');
  return {
    id: report.id,
    reportNumber: report.reportNumber,
    reporterName: String(reporterName),
    reporterDiscordId: input.discordId,
    involvedPlayers: involved,
  };
}

/** Link a report to its Discord lockdown thread (so dropped screenshots attach to it). */
export async function setReportThreadId(reportId: string, threadId: string): Promise<void> {
  await prisma.playerReport.update({ where: { id: reportId }, data: { discordThreadId: threadId } }).catch((err) =>
    logger.warn({ err, reportId }, 'player-report: failed to set thread id'),
  );
}

/** Find the open report bound to a Discord thread, if any. */
export async function findReportByThread(threadId: string) {
  return prisma.playerReport.findFirst({ where: { discordThreadId: threadId } });
}

export interface AttachResult {
  accepted: number;
  total: number;
  full: boolean;
}

/**
 * Upload image buffers to MinIO and attach their URLs to a report, capped at
 * REPORT_IMAGE_MAX total. Returns how many were accepted and whether it's now full.
 */
export async function attachImagesToReport(reportId: string, buffers: Buffer[]): Promise<AttachResult> {
  const report = await prisma.playerReport.findUnique({ where: { id: reportId } });
  if (!report) return { accepted: 0, total: 0, full: false };

  let existing: string[] = [];
  try {
    existing = report.imageUrls ? (JSON.parse(report.imageUrls) as string[]) : [];
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }

  const room = remainingImageSlots(existing.length);
  if (room <= 0) return { accepted: 0, total: existing.length, full: true };

  const urls = await uploadReportImages(buffers.slice(0, room));
  const { merged } = capImageUrls(existing, urls);
  await prisma.playerReport.update({ where: { id: reportId }, data: { imageUrls: JSON.stringify(merged) } });
  logger.info({ reportId, accepted: urls.length, total: merged.length }, 'player-report: images attached');
  return { accepted: urls.length, total: merged.length, full: merged.length >= REPORT_IMAGE_MAX };
}

/** Update a report's status (open | reviewed | closed). */
export async function setReportStatus(reportId: string, status: string): Promise<void> {
  await prisma.playerReport.update({ where: { id: reportId }, data: { status } });
}

/** Permanently delete a report row. */
export async function deleteReport(reportId: string): Promise<void> {
  await prisma.playerReport.delete({ where: { id: reportId } });
}

export default { createPlayerReport, setReportThreadId, findReportByThread, attachImagesToReport, setReportStatus, deleteReport };
module.exports = { createPlayerReport, setReportThreadId, findReportByThread, attachImagesToReport, setReportStatus, deleteReport };
