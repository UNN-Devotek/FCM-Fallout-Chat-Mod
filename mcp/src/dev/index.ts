import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { healthGetDef, healthGetHandler, versionGetDef, versionGetHandler } from "./tools/health.js";
import { wikiSearchDef, wikiSearchHandler, campSearchDef, campSearchHandler } from "./tools/wiki.js";
import { channelsListDef, channelsListHandler, commandsListDef, commandsListHandler } from "./tools/channels.js";
import { messagesListDef, messagesListHandler, messagesSendDef, messagesSendHandler } from "./tools/messages.js";
import { partiesListDef, partiesListHandler, usersSearchDef, usersSearchHandler } from "./tools/parties.js";
import { wsSnapshotDef, wsSnapshotHandler, wsCountDef, wsCountHandler } from "./tools/ws.js";
import { simStreamStartDef, simStreamStartHandler, simUsersCreateDef, simUsersCreateHandler } from "./tools/sim.js";
import { releasesListDef, releasesListHandler } from "./tools/releases.js";

const toolDefs = [
  healthGetDef,
  versionGetDef,
  wikiSearchDef,
  campSearchDef,
  channelsListDef,
  commandsListDef,
  messagesListDef,
  messagesSendDef,
  partiesListDef,
  usersSearchDef,
  wsSnapshotDef,
  wsCountDef,
  simStreamStartDef,
  simUsersCreateDef,
  releasesListDef,
];

type ToolHandler = (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const toolHandlers: Record<string, ToolHandler> = {
  fcm_health_get: healthGetHandler,
  fcm_version_get: versionGetHandler,
  fcm_wiki_search: wikiSearchHandler,
  fcm_camp_search: campSearchHandler,
  fcm_channels_list: channelsListHandler,
  fcm_commands_list: commandsListHandler,
  fcm_messages_list: messagesListHandler,
  fcm_messages_send: messagesSendHandler,
  fcm_parties_list: partiesListHandler,
  fcm_users_search: usersSearchHandler,
  fcm_ws_snapshot: wsSnapshotHandler,
  fcm_ws_count: wsCountHandler,
  fcm_sim_stream_start: simStreamStartHandler,
  fcm_sim_users_create: simUsersCreateHandler,
  fcm_releases_list: releasesListHandler,
};

const server = new Server(
  { name: "fcm-dev", version: "0.1.0" },
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
