# FCM HUD Mod 2.10.134 production release plan

**Status:** Published on 2026-09-26. The release owner confirmed 2.10.134
laptop typing, `/help`, an event shortcut, and a giveaway command, including
the expected HUD feed and Discord results. Dev and Prod CI Summaries passed,
including the complete Ruffle harness. The production overlay smoke test and
VirusTotal gate passed before HUD publication.

This HUD-only update replaced the public Nexus HUD 2.10.125 Main version with
2.10.134; the previous version is archived. The desktop overlay stays at
1.4.2, and provider DLLs are separate.

## Public patch notes

- Fixed text entry for affected Windows xScal users with the opt-in
  `xscalInputMode=shared` HUDModLoader editor. Set it in `Data/FCMChat.ini` and
  restart the game. Native input remains the default where it works.
- Added private `/help`, `/event help`, `/mod help`, and `/giveaway` guides to
  the HUD feed. `/help` lists general commands and points to the separate event
  and staff guides. Each line can be selected with Up/Down and scrolls with chat.
- Added all 33 seeded event shortcuts to the HUD. Starting an event from
  General announces it in Events and its mapped Discord channel, subject to
  the existing enabled-command and cooldown rules.
- Added HUD giveaway start, list, last, join, leave, and stop commands.
  Giveaway cards and winners appear in the originating channel and its mapped
  Discord channel. Join confirmations and creator-rejection messages are
  private to the submitting player.

## Silent Discord advance announcement — posted

Post to the production Updates channel with the HUD notification role only,
`allowed_mentions` restricted to that role, and Discord's
`SUPPRESS_NOTIFICATIONS` flag. Use the brand color `#F1C40F` for an embed. This
is an advance notice, so omit a version-specific download link until the file
is available.

Posted by the production bot to Updates on 2026-09-26 as
[message 1553332645008646155](https://discord.com/channels/1479229109929381940/1479531502567166066/1553332645008646155).
The returned Discord flags value was `4096` (`SUPPRESS_NOTIFICATIONS`). The
advance message was no longer retrievable after the final release notice;
the final notice below is live and silent.

> **FCM HUD Mod 2.10.134 is coming soon**
>
> The next optional in-game HUD update fixes text entry for affected Windows
> xScal users with a shared editor option. It also adds private slash help,
> event shortcuts, and giveaway commands in the HUD. Event announcements and
> giveaway cards and winners will appear in their mapped Discord channels.
> We will post the download and installation notes when the release is live.

## Publication sequence

1. **Passed by owner report:** fresh native 2.10.134 laptop typing, `/help`,
   event shortcut and giveaway command behavior, with feed and Discord results.
   The package guide documents further ZFE/game-only acceptance limits; the
   simulator does not prove them.
2. Merge the tested Dev tree into Prod. Wait for CI, CodeQL and the hosted
   production deploy to finish and verify the backend's event/giveaway paths.
3. Build the production-target unified website and Nexus ZIPs from the exact
   merged commit. Verify both embed the tested BA2, have Prod link/relay stamps,
   and the Nexus ZIP contains no executable or script files.
4. Post the silent advance announcement above if it has not already been sent.
5. Upload the production HUD ZIP to the website and verify its served size and
   hash. Publish the Nexus HUD ZIP as a Main replacement of the existing HUD
   file, preserving its description and archiving only the previous HUD version
   after the new one becomes available. Do not alter overlay file groups.
6. Register the HUD-only website release using the existing overlay version,
   URLs and `releaseTarget=hud`, with `suppressNotifications=true` for its
   final Discord release announcement. Verify the release feed, Nexus file,
   and Discord message.

## Publication record

- Prod merge: `2879deba37d4c7dc110d41f7b51293f1c6da4bb6`; Prod CI run
  `36233456997` passed its required Summary. Production auto-deploy and
  health checks passed.
- Website ZIP: [FCM HUD Mod 2.10.134](https://falloutchatmod.com/downloads/electron/FCM%20HUD%20Mod-2.10.134%20%28PROD%29.zip),
  11,999,048 bytes, SHA-256
  `1965a462570b938a19b423b9aea45b1023f0fb5107ded55c61b8099b910f20d3`.
  The served download matched this hash.
- Nexus: [Fallout Chat Mod files](https://www.nexusmods.com/fallout76/mods/4082?tab=files),
  stable HUD group `7929660`, new Main version ID `11123965320340`;
  2.10.125 is archived. No overlay file group was changed.
- Release feed: `/api/releases` reports HUD 2.10.134 with the website ZIP and
  preserves overlay 1.4.2.
- Final [Discord release notice](https://discord.com/channels/1479229109929381940/1479531502567166066/1553342584632385589)
  posted to Updates with the HUD role only. Its flags include
  `SUPPRESS_NOTIFICATIONS` (`4096`), and its Download field links the live ZIP.
