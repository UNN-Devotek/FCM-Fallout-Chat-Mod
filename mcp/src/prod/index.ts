/**
 * FCM Prod MCP Server — stdio transport.
 *
 * Base URL: HARDCODED to https://falloutchatmod.com
 * Auth: FCM_MCP_TOKEN env var (must be a prod-env token)
 * Scope: OWNER-ONLY — full read + admin mutation surface.
 *
 * Start:
 *   FCM_MCP_TOKEN=fcm_mcp_... node dist/prod/index.js
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── read tools ────────────────────────────────────────────────────────────────
import {
  healthGetDef, healthGetHandler,
  versionGetDef, versionGetHandler,
  channelsListDef, channelsListHandler,
  commandsListDef, commandsListHandler,
  usersListDef, usersListHandler,
  usersGetDef, usersGetHandler,
  usersSearchDef, usersSearchHandler,
  messagesListDef, messagesListHandler,
  messagesSearchDef, messagesSearchHandler,
  partiesListDef, partiesListHandler,
  releasesListDef, releasesListHandler,
  auditLogListDef, auditLogListHandler,
  reportsListDef, reportsListHandler,
  bansListDef, bansListHandler,
  nameBlacklistListDef, nameBlacklistListHandler,
  communityStatsDef, communityStatsHandler,
  wsSnapshotDef, wsSnapshotHandler,
  wsCountDef, wsCountHandler,
  wikiSearchDef, wikiSearchHandler,
  campSearchDef, campSearchHandler,
  moderationSettingsDef, moderationSettingsHandler,
} from "./tools/reads.js";

// ── mutation tools ────────────────────────────────────────────────────────────
import {
  messagesSendDef, messagesSendHandler,
  messagesDeleteDef, messagesDeleteHandler,
  bansCreateDef, bansCreateHandler,
  bansReverseDef, bansReverseHandler,
  mutesCreateDef, mutesCreateHandler,
  mutesDeleteDef, mutesDeleteHandler,
  kicksDef, kicksHandler,
  reportsResolveDef, reportsResolveHandler,
  releasesCreateDef, releasesCreateHandler,
  nameBlacklistAddDef, nameBlacklistAddHandler,
  nameBlacklistRemoveDef, nameBlacklistRemoveHandler,
  channelsCreateDef, channelsCreateHandler,
  channelsUpdateDef, channelsUpdateHandler,
  channelsArchiveDef, channelsArchiveHandler,
  commandsCreateDef, commandsCreateHandler,
  commandsUpdateDef, commandsUpdateHandler,
  commandsDeleteDef, commandsDeleteHandler,
} from "./tools/mutations.js";

const toolDefs = [
  // reads
  healthGetDef,
  versionGetDef,
  channelsListDef,
  commandsListDef,
  usersListDef,
  usersGetDef,
  usersSearchDef,
  messagesListDef,
  messagesSearchDef,
  partiesListDef,
  releasesListDef,
  auditLogListDef,
  reportsListDef,
  bansListDef,
  nameBlacklistListDef,
  communityStatsDef,
  wsSnapshotDef,
  wsCountDef,
  wikiSearchDef,
  campSearchDef,
  moderationSettingsDef,
  // mutations
  messagesSendDef,
  messagesDeleteDef,
  bansCreateDef,
  bansReverseDef,
  mutesCreateDef,
  mutesDeleteDef,
  kicksDef,
  reportsResolveDef,
  releasesCreateDef,
  nameBlacklistAddDef,
  nameBlacklistRemoveDef,
  channelsCreateDef,
  channelsUpdateDef,
  channelsArchiveDef,
  commandsCreateDef,
  commandsUpdateDef,
  commandsDeleteDef,
];

type ToolHandler = (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const toolHandlers: Record<string, ToolHandler> = {
  // reads
  fcm_health_get: healthGetHandler,
  fcm_version_get: versionGetHandler,
  fcm_channels_list: channelsListHandler,
  fcm_commands_list: commandsListHandler,
  fcm_users_list: usersListHandler,
  fcm_users_get: usersGetHandler,
  fcm_users_search: usersSearchHandler,
  fcm_messages_list: messagesListHandler,
  fcm_messages_search: messagesSearchHandler,
  fcm_parties_list: partiesListHandler,
  fcm_releases_list: releasesListHandler,
  fcm_audit_log_list: auditLogListHandler,
  fcm_reports_list: reportsListHandler,
  fcm_bans_list: bansListHandler,
  fcm_name_blacklist_list: nameBlacklistListHandler,
  fcm_community_stats: communityStatsHandler,
  fcm_ws_snapshot: wsSnapshotHandler,
  fcm_ws_count: wsCountHandler,
  fcm_wiki_search: wikiSearchHandler,
  fcm_camp_search: campSearchHandler,
  fcm_moderation_settings: moderationSettingsHandler,
  // mutations
  fcm_messages_send: messagesSendHandler,
  fcm_messages_delete: messagesDeleteHandler,
  fcm_bans_create: bansCreateHandler,
  fcm_bans_reverse: bansReverseHandler,
  fcm_mutes_create: mutesCreateHandler,
  fcm_mutes_delete: mutesDeleteHandler,
  fcm_kicks_create: kicksHandler,
  fcm_reports_resolve: reportsResolveHandler,
  fcm_releases_create: releasesCreateHandler,
  fcm_name_blacklist_add: nameBlacklistAddHandler,
  fcm_name_blacklist_remove: nameBlacklistRemoveHandler,
  fcm_channels_create: channelsCreateHandler,
  fcm_channels_update: channelsUpdateHandler,
  fcm_channels_archive: channelsArchiveHandler,
  fcm_commands_create: commandsCreateHandler,
  fcm_commands_update: commandsUpdateHandler,
  fcm_commands_delete: commandsDeleteHandler,
};

const server = new Server(
  { name: "fcm-prod", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await handler(args ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
