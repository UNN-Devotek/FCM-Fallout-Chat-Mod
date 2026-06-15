import { fcmPost } from "../../shared/client.js";

export const simStreamStartDef = {
  name: "fcm_sim_stream_start",
  description:
    "Start a simulated message stream in the dev environment. MUTATION — requires confirm: true. Show the user the parameters before calling.",
  inputSchema: {
    type: "object" as const,
    properties: {
      count: {
        type: "number",
        description: "Number of messages to simulate (optional)",
      },
      intervalMs: {
        type: "number",
        description: "Interval between messages in milliseconds (optional)",
      },
      channelId: {
        type: "string",
        description: "Target channel ID (optional)",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to execute.",
      },
    },
    required: ["confirm"],
  },
};

export async function simStreamStartHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { count, intervalMs, channelId, confirm } = args as {
    count?: number;
    intervalMs?: number;
    channelId?: string;
    confirm: boolean;
  };
  if (confirm !== true) {
    return {
      content: [
        {
          type: "text",
          text: "Action not confirmed. Set confirm: true after showing the user the simulation parameters and receiving their approval.",
        },
      ],
    };
  }
  const body: Record<string, unknown> = {};
  if (count !== undefined) body["count"] = count;
  if (intervalMs !== undefined) body["intervalMs"] = intervalMs;
  if (channelId !== undefined) body["channelId"] = channelId;
  const data = await fcmPost("/api/mcp/sim/stream", body);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const simUsersCreateDef = {
  name: "fcm_sim_users_create",
  description:
    "Create simulated users in the dev environment. MUTATION — requires confirm: true. Show the user what will be created before calling.",
  inputSchema: {
    type: "object" as const,
    properties: {
      count: {
        type: "number",
        description: "Number of simulated users to create (optional)",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to execute.",
      },
    },
    required: ["confirm"],
  },
};

export async function simUsersCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { count, confirm } = args as { count?: number; confirm: boolean };
  if (confirm !== true) {
    return {
      content: [
        {
          type: "text",
          text: "Action not confirmed. Set confirm: true after showing the user what will be created and receiving their approval.",
        },
      ],
    };
  }
  const body: Record<string, unknown> = {};
  if (count !== undefined) body["count"] = count;
  const data = await fcmPost("/api/mcp/sim/users", body);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
