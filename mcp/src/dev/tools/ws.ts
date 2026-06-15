import { fcmGet } from "../../shared/client.js";

export const wsSnapshotDef = {
  name: "fcm_ws_snapshot",
  description: "Get a snapshot of current WebSocket connections.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function wsSnapshotHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/ws/snapshot");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const wsCountDef = {
  name: "fcm_ws_count",
  description: "Get the current WebSocket connection count.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function wsCountHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/ws/count");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
