/**
 * Release-announcement copy + links (pure, unit-tested).
 *
 * Extracted from discordService so the @everyone ping, the env-aware download
 * links, and the Nexus endorsement copy can be tested without loading discord.js.
 * The download URLs come from the environment-aware `releaseDownloadUrls` module,
 * so dev/QA announcements link to the dev host instead of prod (where the dev
 * artifacts 404).
 */

import type { MessageCreateOptions } from 'discord.js';
import {
  windowsZipUrl,
  linuxZipUrl,
  rawLinuxAppImageUrl,
  rawLinuxDebUrl,
} from './releaseDownloadUrls';

export interface HudModDownload {
  version: string;
  url: string;
}

/** Message content above the embed — pings the whole Updates channel. Requires
 *  `allowedMentions: { parse: ['everyone'] }` on send AND the bot to hold
 *  "Mention Everyone" in that channel (otherwise it posts but doesn't ping). */
export const RELEASE_PING = '@everyone';

/** Message options for a release post's optional whole-channel mention. */
export function releaseAnnouncementMessage(
  mentionEveryone: boolean,
): Pick<MessageCreateOptions, 'content' | 'allowedMentions'> {
  if (!mentionEveryone) return {};
  return {
    content: RELEASE_PING,
    allowedMentions: { parse: ['everyone'] },
  };
}

/** FCM's Nexus Mods page (default); overridable so a different mod id can be set. */
export const DEFAULT_NEXUS_MOD_URL = 'https://www.nexusmods.com/fallout76/mods/4082';
export function nexusModUrl(): string {
  return process.env.NEXUS_MOD_URL || DEFAULT_NEXUS_MOD_URL;
}

/** The human "download page" link (prod default; a non-prod stack can override). */
export function downloadPageUrl(): string {
  return process.env.DOWNLOAD_PAGE_URL || 'https://falloutchatmod.com';
}

/** Embed "Download" field value — env-aware platform links + optional HUD package. */
export function releaseDownloadFieldValue(version: string, hudMod?: HudModDownload): string {
  const links = [
    `🪟 [Windows](${windowsZipUrl(version)})`,
    `🐧 [Linux AppImage](${rawLinuxAppImageUrl(version)})`,
    `[Linux .deb](${rawLinuxDebUrl(version)})`,
    `[Linux ZIP + install docs](${linuxZipUrl(version)})`,
    `[Download page](${downloadPageUrl()})`,
  ];
  if (hudMod) links.push(`[ZFE FCM HUD Mod ZIP v${hudMod.version}](${hudMod.url})`);
  return links.join('  ·  ');
}

/** Embed "Endorse on Nexus" field value — encouragement + the download caveat. */
export function nexusEndorseFieldValue(): string {
  const url = nexusModUrl();
  return (
    `**Enjoying Fallout Chat Mod?** Please take a second to **[endorse it on Nexus](${url})** — ` +
    `endorsements are the single best way to help more Wastelanders find the mod, and it only takes one click. Thank you! ☢️\n\n` +
    `_Heads up — Nexus only lets you endorse after you've downloaded the mod from there at least once._`
  );
}
