/**
 * Mutating prod MCP tools — ALL require confirm: true.
 * The confirm guard is checked both here (client side) and in the backend
 * (server side) for defence-in-depth.
 */
import {
  fcmAdminPost,
  fcmAdminPatch,
  fcmAdminDelete,
} from "../../shared/prodClient.js";

const CONFIRM_REFUSED = {
  content: [
    {
      type: "text" as const,
      text: "Action not confirmed. Show the user exactly what will happen (target, content, and irreversible effects) and set confirm: true only after they explicitly approve.",
    },
  ],
};

// ── messages ──────────────────────────────────────────────────────────────────

export const messagesSendDef = {
  name: "fcm_messages_send",
  description:
    "Send a message to a production channel as the MCP token owner. IRREVERSIBLE — the message is immediately broadcast to all connected clients. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: { type: "string", description: "Target channel UUID" },
      content: { type: "string", description: "Message content (max 500 chars)" },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the user what will be sent first.",
      },
    },
    required: ["channelId", "content", "confirm"],
  },
};

export async function messagesSendHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, content, confirm } = args as {
    channelId: string; content: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/messages/send", { channelId, content, confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const messagesDeleteDef = {
  name: "fcm_messages_delete",
  description:
    "Soft-delete a message in production. The message is hidden from all clients immediately. IRREVERSIBLE. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      messageId: { type: "string", description: "Message UUID to delete" },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the user the message ID and content first.",
      },
    },
    required: ["messageId", "confirm"],
  },
};

export async function messagesDeleteHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { messageId, confirm } = args as { messageId: string; confirm: boolean };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminDelete(`/api/mcp-admin/messages/${messageId}`, { confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── bans ──────────────────────────────────────────────────────────────────────

export const bansCreateDef = {
  name: "fcm_bans_create",
  description:
    "Ban a user in production. The ban immediately disconnects the user and prevents re-login. IRREVERSIBLE without a ban reversal. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: { type: "string", description: "Target user UUID" },
      reason: { type: "string", description: "Reason for the ban" },
      category: {
        type: "string",
        description: "Ban category (e.g. harassment, cheating, spam, other)",
      },
      expiresAt: {
        type: "string",
        description: "ISO 8601 expiry date. Omit for permanent ban.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the user's name, reason, and duration first.",
      },
    },
    required: ["userId", "reason", "confirm"],
  },
};

export async function bansCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { userId, reason, category, expiresAt, confirm } = args as {
    userId: string; reason: string; category?: string; expiresAt?: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/bans", {
    userId, reason, category, expiresAt, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const bansReverseDef = {
  name: "fcm_bans_reverse",
  description:
    "Reverse (unban) an existing ban. The user will be able to log in again immediately. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      banId: { type: "string", description: "Ban record UUID" },
      reverseReason: { type: "string", description: "Reason for reversal" },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the ban details first.",
      },
    },
    required: ["banId", "confirm"],
  },
};

export async function bansReverseHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { banId, reverseReason, confirm } = args as {
    banId: string; reverseReason?: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost(`/api/mcp-admin/bans/${banId}/reverse`, {
    reverseReason, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── mutes ─────────────────────────────────────────────────────────────────────

export const mutesCreateDef = {
  name: "fcm_mutes_create",
  description:
    "Mute a user in production (they can still read but cannot send messages). Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: { type: "string", description: "Target user UUID" },
      reason: { type: "string", description: "Reason for the mute" },
      durationMinutes: {
        type: "number",
        description: "Duration in minutes. Omit for indefinite mute.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true. Show user name, reason, and duration first.",
      },
    },
    required: ["userId", "reason", "confirm"],
  },
};

export async function mutesCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { userId, reason, durationMinutes, confirm } = args as {
    userId: string; reason: string; durationMinutes?: number; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/mutes", {
    userId, reason, durationMinutes, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const mutesDeleteDef = {
  name: "fcm_mutes_delete",
  description:
    "Unmute a user in production. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: { type: "string", description: "User UUID to unmute" },
      confirm: {
        type: "boolean",
        description: "Must be true.",
      },
    },
    required: ["userId", "confirm"],
  },
};

export async function mutesDeleteHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { userId, confirm } = args as { userId: string; confirm: boolean };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminDelete(`/api/mcp-admin/mutes/${userId}`, { confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── kicks ─────────────────────────────────────────────────────────────────────

export const kicksDef = {
  name: "fcm_kicks_create",
  description:
    "Kick a user from production (disconnects them; they can reconnect). Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: { type: "string", description: "Target user UUID" },
      reason: { type: "string", description: "Reason for the kick" },
      confirm: {
        type: "boolean",
        description: "Must be true. Show user name and reason first.",
      },
    },
    required: ["userId", "reason", "confirm"],
  },
};

export async function kicksHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { userId, reason, confirm } = args as {
    userId: string; reason: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/kicks", { userId, reason, confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── reports ───────────────────────────────────────────────────────────────────

export const reportsResolveDef = {
  name: "fcm_reports_resolve",
  description:
    "Resolve or dismiss a player report. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      reportId: { type: "string", description: "Report UUID" },
      status: {
        type: "string",
        description: "New status: resolved | dismissed",
      },
      resolution: {
        type: "string",
        description: "Optional resolution notes",
      },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the report details first.",
      },
    },
    required: ["reportId", "status", "confirm"],
  },
};

export async function reportsResolveHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { reportId, status, resolution, confirm } = args as {
    reportId: string; status: string; resolution?: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPatch(`/api/mcp-admin/reports/${reportId}`, {
    status, resolution, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── releases ──────────────────────────────────────────────────────────────────

export const releasesCreateDef = {
  name: "fcm_releases_create",
  description:
    "Publish a new overlay release. This sets the auto-update feed for all users. IRREVERSIBLE — once published users will be prompted to update. Requires confirm: true. Always run smoke-test and VirusTotal gate before confirming.",
  inputSchema: {
    type: "object" as const,
    properties: {
      version: { type: "string", description: "Semantic version (e.g. 1.4.0)" },
      downloadUrl: { type: "string", description: "URL of the installer binary" },
      releaseNotes: { type: "string", description: "Markdown release notes" },
      confirm: {
        type: "boolean",
        description:
          "Must be true. Confirm smoke-test + VirusTotal gate have both passed before setting this.",
      },
    },
    required: ["version", "downloadUrl", "releaseNotes", "confirm"],
  },
};

export async function releasesCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { version, downloadUrl, releaseNotes, confirm } = args as {
    version: string; downloadUrl: string; releaseNotes: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/releases", {
    version, downloadUrl, releaseNotes, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── name blacklist ────────────────────────────────────────────────────────────

export const nameBlacklistAddDef = {
  name: "fcm_name_blacklist_add",
  description:
    "Add a pattern to the username blacklist. Takes effect immediately. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "The string or regex pattern to block" },
      matchType: {
        type: "string",
        description: "How the pattern is matched: exact | contains | regex (default: exact)",
      },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the pattern before confirming.",
      },
    },
    required: ["pattern", "confirm"],
  },
};

export async function nameBlacklistAddHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { pattern, matchType, confirm } = args as {
    pattern: string; matchType?: string; confirm: boolean;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/name-blacklist", {
    pattern, matchType, confirm,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const nameBlacklistRemoveDef = {
  name: "fcm_name_blacklist_remove",
  description:
    "Remove a pattern from the username blacklist by ID. Takes effect immediately. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      entryId: { type: "string", description: "Blacklist entry UUID" },
      confirm: {
        type: "boolean",
        description: "Must be true. Show the pattern and ID first.",
      },
    },
    required: ["entryId", "confirm"],
  },
};

export async function nameBlacklistRemoveHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { entryId, confirm } = args as { entryId: string; confirm: boolean };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminDelete(`/api/mcp-admin/name-blacklist/${entryId}`, { confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── channels (mutations) ──────────────────────────────────────────────────────

export const channelsCreateDef = {
  name: "fcm_channels_create",
  description:
    "Create a new channel in production. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Channel name" },
      color: { type: "string", description: "Hex color (default #ecbb51)" },
      parentId: { type: "string", description: "Parent channel UUID (optional)" },
      sortOrder: { type: "number", description: "Sort position (default 0)" },
      discordRelay: { type: "boolean", description: "Enable Discord relay (default false)" },
      allowGifs: { type: "boolean", description: "Allow GIFs (default true)" },
      allowEmojis: { type: "boolean", description: "Allow emojis (default true)" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["name", "confirm"],
  },
};

export async function channelsCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { name, color, parentId, sortOrder, discordRelay, allowGifs, allowEmojis, confirm } =
    args as {
      name: string; color?: string; parentId?: string; sortOrder?: number;
      discordRelay?: boolean; allowGifs?: boolean; allowEmojis?: boolean; confirm: boolean;
    };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/channels", {
    name, color, parentId, sortOrder, discordRelay, allowGifs, allowEmojis,
  });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const channelsUpdateDef = {
  name: "fcm_channels_update",
  description:
    "Update a channel's properties in production. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: { type: "string", description: "Channel UUID" },
      name: { type: "string" },
      color: { type: "string" },
      sortOrder: { type: "number" },
      discordRelay: { type: "boolean" },
      allowGifs: { type: "boolean" },
      allowEmojis: { type: "boolean" },
      isArchived: { type: "boolean" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["channelId", "confirm"],
  },
};

export async function channelsUpdateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, confirm, ...updates } = args as {
    channelId: string; confirm: boolean; [key: string]: unknown;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPatch(`/api/mcp-admin/channels/${channelId}`, updates);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const channelsArchiveDef = {
  name: "fcm_channels_archive",
  description:
    "Archive (soft-delete) a channel. Messages are preserved but the channel is hidden. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: { type: "string", description: "Channel UUID to archive" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["channelId", "confirm"],
  },
};

export async function channelsArchiveHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, confirm } = args as { channelId: string; confirm: boolean };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminDelete(`/api/mcp-admin/channels/${channelId}`, { confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── commands (mutations) ──────────────────────────────────────────────────────

export const commandsCreateDef = {
  name: "fcm_commands_create",
  description:
    "Create a new chat command in production. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      trigger: { type: "string", description: "The command trigger (e.g. /wiki)" },
      description: { type: "string" },
      actionType: { type: "string" },
      cooldownSec: { type: "number" },
      requiresArgs: { type: "boolean" },
      alias: { type: "string" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["trigger", "confirm"],
  },
};

export async function commandsCreateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { confirm, ...body } = args as { confirm: boolean; [key: string]: unknown };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPost("/api/mcp-admin/commands", body);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const commandsUpdateDef = {
  name: "fcm_commands_update",
  description:
    "Update a chat command in production. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      commandId: { type: "string", description: "Command UUID" },
      trigger: { type: "string" },
      description: { type: "string" },
      actionType: { type: "string" },
      cooldownSec: { type: "number" },
      requiresArgs: { type: "boolean" },
      alias: { type: "string" },
      enabled: { type: "boolean" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["commandId", "confirm"],
  },
};

export async function commandsUpdateHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { commandId, confirm, ...updates } = args as {
    commandId: string; confirm: boolean; [key: string]: unknown;
  };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminPatch(`/api/mcp-admin/commands/${commandId}`, updates);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const commandsDeleteDef = {
  name: "fcm_commands_delete",
  description:
    "Permanently delete a chat command. Requires confirm: true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      commandId: { type: "string", description: "Command UUID" },
      confirm: { type: "boolean", description: "Must be true." },
    },
    required: ["commandId", "confirm"],
  },
};

export async function commandsDeleteHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { commandId, confirm } = args as { commandId: string; confirm: boolean };
  if (confirm !== true) return CONFIRM_REFUSED;
  const data = await fcmAdminDelete(`/api/mcp-admin/commands/${commandId}`, { confirm });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
