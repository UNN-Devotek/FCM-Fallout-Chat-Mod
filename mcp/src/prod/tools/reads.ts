/**
 * Read-only prod MCP tools — no side effects, no confirm required.
 */
import { fcmAdminGet } from "../../shared/prodClient.js";

// ── health ────────────────────────────────────────────────────────────────────

export const healthGetDef = {
  name: "fcm_health_get",
  description: "Check the production backend health status.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function healthGetHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/health");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── version ───────────────────────────────────────────────────────────────────

export const versionGetDef = {
  name: "fcm_version_get",
  description: "Get the production backend version.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function versionGetHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/version");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── channels ─────────────────────────────────────────────────────────────────

export const channelsListDef = {
  name: "fcm_channels_list",
  description: "List all channels (including archived) in production.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function channelsListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/channels");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── commands ─────────────────────────────────────────────────────────────────

export const commandsListDef = {
  name: "fcm_commands_list",
  description: "List all chat commands (enabled and disabled) in production.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function commandsListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/commands");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── users ─────────────────────────────────────────────────────────────────────

export const usersListDef = {
  name: "fcm_users_list",
  description: "List registered users. Supports limit and offset for pagination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max users to return (default 50, max 100)" },
      offset: { type: "number", description: "Pagination offset (default 0)" },
    },
    required: [],
  },
};

export async function usersListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { limit, offset } = args as { limit?: number; offset?: number };
  const params: Record<string, string> = {};
  if (limit !== undefined) params.limit = String(limit);
  if (offset !== undefined) params.offset = String(offset);
  const data = await fcmAdminGet("/api/mcp-admin/users", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const usersGetDef = {
  name: "fcm_users_get",
  description: "Get a single user by ID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: { type: "string", description: "The user's UUID" },
    },
    required: ["userId"],
  },
};

export async function usersGetHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { userId } = args as { userId: string };
  const data = await fcmAdminGet(`/api/mcp-admin/users/${userId}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const usersSearchDef = {
  name: "fcm_users_search",
  description: "Search users by username, Discord username, or display name.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: { type: "string", description: "Search query" },
    },
    required: ["q"],
  },
};

export async function usersSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmAdminGet("/api/mcp-admin/users/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── messages ──────────────────────────────────────────────────────────────────

export const messagesListDef = {
  name: "fcm_messages_list",
  description: "List recent messages in a channel (includes deleted messages).",
  inputSchema: {
    type: "object" as const,
    properties: {
      channelId: { type: "string", description: "Channel UUID" },
      limit: { type: "number", description: "Max messages (default 50, max 100)" },
    },
    required: ["channelId"],
  },
};

export async function messagesListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { channelId, limit } = args as { channelId: string; limit?: number };
  const params: Record<string, string> = { channelId };
  if (limit !== undefined) params.limit = String(limit);
  const data = await fcmAdminGet("/api/mcp-admin/messages", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const messagesSearchDef = {
  name: "fcm_messages_search",
  description: "Full-text search messages by content. Optionally filter by channelId.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: { type: "string", description: "Search query" },
      channelId: { type: "string", description: "Optional channel UUID filter" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    required: ["q"],
  },
};

export async function messagesSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q, channelId, limit } = args as { q: string; channelId?: string; limit?: number };
  const params: Record<string, string> = { q };
  if (channelId) params.channelId = channelId;
  if (limit !== undefined) params.limit = String(limit);
  const data = await fcmAdminGet("/api/mcp-admin/messages/search", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── parties ───────────────────────────────────────────────────────────────────

export const partiesListDef = {
  name: "fcm_parties_list",
  description: "List active parties in production.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function partiesListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/parties");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── releases ──────────────────────────────────────────────────────────────────

export const releasesListDef = {
  name: "fcm_releases_list",
  description: "List recent overlay releases.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function releasesListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/releases");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── audit log ────────────────────────────────────────────────────────────────

export const auditLogListDef = {
  name: "fcm_audit_log_list",
  description: "List audit log entries. Filterable by actor, action, date range.",
  inputSchema: {
    type: "object" as const,
    properties: {
      actor: { type: "string", description: "Filter by actor user ID" },
      action: { type: "string", description: "Filter by action name (partial match)" },
      from: { type: "string", description: "ISO 8601 start date" },
      to: { type: "string", description: "ISO 8601 end date" },
      limit: { type: "number", description: "Max entries (default 50, max 200)" },
    },
    required: [],
  },
};

export async function auditLogListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { actor, action, from, to, limit } = args as {
    actor?: string; action?: string; from?: string; to?: string; limit?: number;
  };
  const params: Record<string, string> = {};
  if (actor) params.actor = actor;
  if (action) params.action = action;
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit !== undefined) params.limit = String(limit);
  const data = await fcmAdminGet("/api/mcp-admin/audit-log", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── reports ───────────────────────────────────────────────────────────────────

export const reportsListDef = {
  name: "fcm_reports_list",
  description: "List player reports. Filter by status: open, resolved, dismissed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "Filter by status (open | resolved | dismissed)" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    required: [],
  },
};

export async function reportsListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { status, limit } = args as { status?: string; limit?: number };
  const params: Record<string, string> = {};
  if (status) params.status = status;
  if (limit !== undefined) params.limit = String(limit);
  const data = await fcmAdminGet("/api/mcp-admin/reports", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── bans ──────────────────────────────────────────────────────────────────────

export const bansListDef = {
  name: "fcm_bans_list",
  description: "List ban records.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max results (default 50)" },
    },
    required: [],
  },
};

export async function bansListHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { limit } = args as { limit?: number };
  const params: Record<string, string> = {};
  if (limit !== undefined) params.limit = String(limit);
  const data = await fcmAdminGet("/api/mcp-admin/bans", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── name blacklist ────────────────────────────────────────────────────────────

export const nameBlacklistListDef = {
  name: "fcm_name_blacklist_list",
  description: "List username blacklist patterns.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function nameBlacklistListHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/name-blacklist");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── community stats ───────────────────────────────────────────────────────────

export const communityStatsDef = {
  name: "fcm_community_stats",
  description: "Get community statistics for a time range.",
  inputSchema: {
    type: "object" as const,
    properties: {
      range: {
        type: "string",
        description: "Time range: all | 90d | 60d | 30d | 7d | 1d (default 90d)",
      },
    },
    required: [],
  },
};

export async function communityStatsHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { range } = args as { range?: string };
  const params: Record<string, string> = {};
  if (range) params.range = range;
  const data = await fcmAdminGet("/api/mcp-admin/community-stats", params);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── ws ────────────────────────────────────────────────────────────────────────

export const wsSnapshotDef = {
  name: "fcm_ws_snapshot",
  description: "Get a snapshot of all active WebSocket clients.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function wsSnapshotHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/ws/snapshot");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const wsCountDef = {
  name: "fcm_ws_count",
  description: "Get total active WebSocket client count.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function wsCountHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/ws/count");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── wiki / camp ───────────────────────────────────────────────────────────────

export const wikiSearchDef = {
  name: "fcm_wiki_search",
  description: "Search the Fallout 76 wiki database.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: { type: "string", description: "Search query" },
    },
    required: ["q"],
  },
};

export async function wikiSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmAdminGet("/api/mcp-admin/wiki/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export const campSearchDef = {
  name: "fcm_camp_search",
  description: "Search the CAMP item database.",
  inputSchema: {
    type: "object" as const,
    properties: {
      q: { type: "string", description: "Search query" },
    },
    required: ["q"],
  },
};

export async function campSearchHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { q } = args as { q: string };
  const data = await fcmAdminGet("/api/mcp-admin/camp/search", { q });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── moderation settings ───────────────────────────────────────────────────────

export const moderationSettingsDef = {
  name: "fcm_moderation_settings",
  description: "Get current moderation settings.",
  inputSchema: { type: "object" as const, properties: {}, required: [] },
};

export async function moderationSettingsHandler(
  _args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const data = await fcmAdminGet("/api/mcp-admin/moderation-settings");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
