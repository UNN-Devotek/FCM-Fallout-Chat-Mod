import { fcmGet } from "../../shared/client.js";

export const releasesListDef = {
  name: "fcm_releases_list",
  description: "List overlay releases.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function releasesListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/releases");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
