import { runRequiredMutation } from '../lib/requiredEffects';
import { runtime } from '../runtime';
import { createHash, randomUUID } from 'crypto';
import prisma from '../config/prisma';
import logger from '../config/logger';
import type { McpActor } from '../mcp/actor';
import type { Prisma } from '@prisma/client';

export type McpOutcome = 'attempt' | 'success' | 'failure' | 'partial' | 'denied';
export type McpMetric = 'oauth' | 'role_denial' | 'refresh' | 'tool_call' | 'media_rejection' | 'discord_latency';

const ALLOWED_LABELS = {
  oauth: { outcome: ['success', 'failure'] },
  role_denial: { reason: ['missing_role', 'banned', 'verification_unavailable', 'unknown'] },
  refresh: { outcome: ['success', 'failure', 'reuse'] },
  tool_call: { outcome: ['success', 'failure', 'partial', 'denied'] },
  media_rejection: { reason: ['scheme', 'dns', 'private_address', 'redirect', 'content_type', 'size', 'decode', 'upstream', 'unknown'] },
  discord_latency: { outcome: ['success', 'failure'] },
} as const;

type Labels = Record<string, string>;
type MetricPoint = { count: number; totalMs: number; maxMs: number };
const metrics = new Map<string, MetricPoint>();
const alerts = new Map<string, number[]>();
const MCP_TOOL_LABELS = new Set([
  'embed_create', 'embed_update', 'embed_delete', 'embed_send', 'embed_asset_import',
  'embeds_create', 'embeds_update', 'embeds_delete', 'embeds_send',
  'reaction_role_panel_delete', 'reaction_role_panels_list', 'discord_context_get', 'embeds_list', 'embeds_get',
  'reaction_role_panels_delete', 'embed_preview', 'context_get', 'action_search', 'action_read', 'action_write', 'unknown',
]);
const DENIAL_REASONS = new Set(['disabled', 'origin', 'content_type', 'protocol_version', 'body_size', 'malformed_json', 'missing_bearer', 'invalid_token', 'insufficient_scope', 'rate_limit', 'confirmation_required', 'role_gate']);
const safeTool = (value: string | undefined) => MCP_TOOL_LABELS.has((value ?? '').replace(/^fcm_/, '')) ? (value ?? '').replace(/^fcm_/, '') : 'unknown';
const safeTarget = (value: string | number | null | undefined): string | number => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : 'unknown';
  if (typeof value !== 'string') return 'unknown';
  return /^\d{15,22}$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : 'unknown';
};

export function classifyMcpRoleDenial(reason: string): 'missing_role' | 'banned' | 'verification_unavailable' | 'unknown' {
  if (reason === 'role_missing') return 'missing_role';
  if (reason === 'banned') return 'banned';
  if (reason === 'verification_unavailable') return 'verification_unavailable';
  return 'unknown';
}

function boundedLabels(metric: McpMetric, labels: Labels): Labels {
  const allowed = ALLOWED_LABELS[metric] as Record<string, readonly string[]>;
  const result: Labels = {};
  for (const [key, values] of Object.entries(allowed)) {
    const value = labels[key] ?? 'unknown';
    result[key] = values.includes(value) ? value : 'unknown';
  }
  if (metric === 'tool_call') result.tool = MCP_TOOL_LABELS.has(labels.tool ?? '') ? labels.tool : 'unknown';
  return result;
}

export function recordMcpMetric(metric: McpMetric, labels: Labels, latencyMs = 0): void {
  const safe = boundedLabels(metric, labels);
  const key = `${metric}:${Object.entries(safe).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
  const point = metrics.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  point.count += 1;
  point.totalMs += Math.max(0, Math.round(latencyMs));
  point.maxMs = Math.max(point.maxMs, Math.max(0, Math.round(latencyMs)));
  metrics.set(key, point);
}

export function getMcpOperationalSnapshot(): ReadonlyArray<{ metric: McpMetric; labels: Labels } & MetricPoint> {
  return [...metrics.entries()].map(([key, point]) => {
    const [metric, serialized = ''] = key.split(':', 2);
    const labels = Object.fromEntries(serialized.split(',').filter(Boolean).map(pair => pair.split('=', 2)));
    return { metric: metric as McpMetric, labels, ...point };
  });
}

export function resetMcpOperationalStateForTests(): void { metrics.clear(); alerts.clear(); }

export function pseudonymizeMcpId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function auditMcpDenial(input: { correlationId: string; reason: string; tool?: string; target?: string | number | null; actorDiscordId?: string; clientId?: string; grantId?: string }): void {
  const event = redactMcpData({ event: 'mcp_denial', correlationId: input.correlationId, reason: DENIAL_REASONS.has(input.reason) ? input.reason : 'unknown',
    tool: safeTool(input.tool), target: safeTarget(input.target), actorDiscordId: input.actorDiscordId ?? 'unknown',
    clientId: input.clientId ?? 'unknown', grant: input.grantId ? pseudonymizeMcpId(input.grantId) : 'unknown' });
  logger.warn(event, 'MCP request denied');
  recordMcpMetric('tool_call', { tool: input.tool ?? 'unknown', outcome: 'denied' });
}

export function noteMcpSecurityEvent(kind: 'refresh_reuse' | 'ssrf_rejection' | 'role_gate_failure' | 'mutation_error'): void {
  const now = Date.now();
  logger.warn({ event: 'mcp_security_event', kind }, 'MCP security event');
  const windowMs = 5 * 60_000;
  const recent = (alerts.get(kind) ?? []).filter(at => now - at <= windowMs);
  recent.push(now); alerts.set(kind, recent);
  const threshold = kind === 'refresh_reuse' ? 1 : kind === 'ssrf_rejection' ? 3 : kind === 'role_gate_failure' ? 5 : 5;
  if (recent.length === threshold || (recent.length > threshold && recent.length % threshold === 0)) {
    logger.warn({ event: 'mcp_operational_alert', kind, count: recent.length, windowSeconds: windowMs / 1000 }, 'MCP operational alert threshold reached');
  }
}

const SENSITIVE_KEY = /(authorization|code|token|secret|password|api.?key|bytes?|content|body)/i;
export function redactMcpData(value: unknown, key = ''): Prisma.InputJsonValue {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.href;
      }
    } catch { /* not a URL */ }
    return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactMcpData(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([k, v]) => [k, redactMcpData(v, k)]));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null) return '[null]';
  return String(value);
}

export interface McpAuditIntent { id: string; createdAt: Date; startedAt: number }

export async function beginMcpMutationAudit(actor: McpActor, action: string, targetType: string, target: string | number | null, details: Record<string, unknown> = {}): Promise<McpAuditIntent> {
  const correlationId = actor.correlationId ?? randomUUID();
  const user = await prisma.user.findUnique({ where: { discordId: actor.discordId }, select: { id: true } }).catch(() => null);
  const audit = await runRequiredMutation('audit', '3f6d9d39b4be17e63eab51b1', { auditId: correlationId, discordId: actor.discordId, stage: 'mutation-audit-intent-unconfirmed' }, () => prisma.auditLog.create({ data: {
    id: correlationId, actorId: user?.id ?? null, action: `mcp_${action}`, targetType,
    reason: `${action} attempted`, metadata: redactMcpData({ correlationId, actorDiscordId: actor.discordId, clientId: actor.clientId, grant: pseudonymizeMcpId(actor.grantId), tool: action, outcome: 'attempt', target, ...details }),
  }, select: { id: true, createdAt: true } }));
  return { ...audit, startedAt: Date.now() };
}

export async function finalizeMcpMutationAudit(audit: McpAuditIntent, actor: McpActor, action: string, target: string | number | null, outcome: 'success' | 'failure' | 'partial', details: Record<string, unknown> = {}): Promise<boolean> {
  return runtime.required('mcp:audit-finalize', async () => {
  const latencyMs = Date.now() - audit.startedAt;
  recordMcpMetric('tool_call', { tool: action, outcome }, latencyMs);
  if (outcome === 'failure') noteMcpSecurityEvent('mutation_error');
  for (let attempt = 1; attempt <= 2; attempt += 1) try {
    await prisma.auditLog.update({ where: { id_createdAt: { id: audit.id, createdAt: audit.createdAt } }, data: {
      reason: `${action} ${outcome}`, metadata: redactMcpData({ correlationId: audit.id, actorDiscordId: actor.discordId, clientId: actor.clientId, grant: pseudonymizeMcpId(actor.grantId), tool: action, outcome, target, latencyMs, ...details }),
    } });
    logger.info(redactMcpData({ event: 'mcp_mutation', correlationId: audit.id, clientId: actor.clientId, actorDiscordId: actor.discordId, grant: pseudonymizeMcpId(actor.grantId), tool: action, target, outcome, latencyMs }), 'MCP mutation completed');
    return true;
  } catch (error) {
    if (attempt === 2) runtime.recordFailure('mcp:audit-finalize', error, { auditId: audit.id, discordId: actor.discordId,
      action, targetId: typeof target === 'string' ? target : undefined, outcome, stage: 'mutation-audit-finalization-unconfirmed' });
    if (attempt === 2) logger.error({ correlationId: audit.id, tool: action, outcome }, 'MCP mutation audit finalization failed');
  }
  return false;
  });
}
