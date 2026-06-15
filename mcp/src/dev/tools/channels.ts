import { fcmGet } from "../../shared/client.js";

export const channelsListDef = {
  name: "fcm_channels_list",
  description: "List available chat channels.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function channelsListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/channels");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const commandsListDef = {
  name: "fcm_commands_list",
  description: "List available slash commands.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function commandsListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/commands");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
