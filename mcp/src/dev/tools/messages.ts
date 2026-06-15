import { fcmGet, fcmPost } from "../../shared/client.js";

export const messagesListDef = {
  name: "fcm_messages_list",
  description: "List recent messages in a channel.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: {
        type: "string",
        description: "The channel ID to list messages from",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (optional)",
      },
    },
    required: ["channelId"],
  },
};

export async function messagesListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, limit } = args as { channelId: string; limit?: number };
  const params: Record<string, string> = { channelId };
  if (limit !== undefined) {
    params["limit"] = String(limit);
  }
  const data = await fcmGet("/api/mcp/messages", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const messagesSendDef = {
  name: "fcm_messages_send",
  description:
    "Send a message to a channel. MUTATION — requires confirm: true. Pass confirm: true only after you have shown the user what will be sent and they have approved.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: {
        type: "string",
        description: "The channel ID to send the message to",
      },
      content: {
        type: "string",
        description: "The message content",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to execute. Show the user what will be sent first.",
      },
    },
    required: ["channelId", "content", "confirm"],
  },
};

export async function messagesSendHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, content, confirm } = args as {
    channelId: string;
    content: string;
    confirm: boolean;
  };
  if (confirm !== true) {
    return {
      content: [
        {
          type: "text",
          text: "Action not confirmed. Set confirm: true after showing the user what will be sent and receiving their approval.",
        },
      ],
    };
  }
  const data = await fcmPost("/api/mcp/messages/send", { channelId, content });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
