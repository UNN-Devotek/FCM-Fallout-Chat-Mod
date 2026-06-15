import { fcmGet } from "../../shared/client.js";

export const partiesListDef = {
  name: "fcm_parties_list",
  description: "List active parties.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function partiesListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/parties");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const usersSearchDef = {
  name: "fcm_users_search",
  description: "Search users by display name or username.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: {
        type: "string",
        description: "Search query",
      },
    },
    required: ["q"],
  },
};

export async function usersSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmGet("/api/mcp/users/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
