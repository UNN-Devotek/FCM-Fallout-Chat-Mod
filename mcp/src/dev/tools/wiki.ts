import { fcmGet } from "../../shared/client.js";

export const wikiSearchDef = {
  name: "fcm_wiki_search",
  description: "Search the Fallout 76 wiki.",
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

export async function wikiSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmGet("/api/mcp/wiki/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const campSearchDef = {
  name: "fcm_camp_search",
  description: "Search camp listings.",
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

export async function campSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmGet("/api/mcp/camp/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
