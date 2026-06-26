/**
 * Release-announcement copy + links (pure, unit-tested).
 *
 * Extracted from discordService so the @everyone ping, the env-aware download
 * links, and the Nexus endorsement copy can be tested without loading discord.js.
 * The download URLs come from the environment-aware `releaseDownloadUrls` module,
 * so dev/QA announcements link to the dev host instead of prod (where the dev
 * artifacts 404).
 */

import { windowsZipUrl, linuxZipUrl } from './releaseDownloadUrls';

/** Message content above the embed — pings the whole Updates channel. Requires
 *  `allowedMentions: { parse: ['everyone'] }` on send AND the bot to hold
 *  "Mention Everyone" in that channel (otherwise it posts but doesn't ping). */
export const RELEASE_PING = '@everyone';

/** FCM's Nexus Mods page (default); overridable so a different mod id can be set. */
export const DEFAULT_NEXUS_MOD_URL = 'https://www.nexusmods.com/fallout76/mods/4082';
export function nexusModUrl(): string {
  return process.env.NEXUS_MOD_URL || DEFAULT_NEXUS_MOD_URL;
}

/** The human "download page" link (prod default; a non-prod stack can override). */
export function downloadPageUrl(): string {
  return process.env.DOWNLOAD_PAGE_URL || 'https://falloutchatmod.com';
}

/** Embed "Download" field value — env-aware direct ZIP links + the download page. */
export function releaseDownloadFieldValue(version: string): string {
  return `🪟 [Windows](${windowsZipUrl(version)})  ·  🐧 [Linux (Proton)](${linuxZipUrl(version)})  ·  [Download page](${downloadPageUrl()})`;
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
