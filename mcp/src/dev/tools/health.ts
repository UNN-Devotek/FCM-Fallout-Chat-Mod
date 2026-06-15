import { fcmGet } from "../../shared/client.js";

export const healthGetDef = {
  name: "fcm_health_get",
  description: "Check the FCM backend health status.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function healthGetHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/health");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const versionGetDef = {
  name: "fcm_version_get",
  description: "Get the FCM backend version.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function versionGetHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmGet("/api/mcp/version");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
