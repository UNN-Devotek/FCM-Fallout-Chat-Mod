/** Operator evidence is a disposition ledger, not an SDK error log. Error
 * messages/URLs/SQL often include credentials or chat payloads. */
const ERROR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError',
  'AbortError', 'TimeoutError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError', 'DiscordAPIError', 'HTTPError', 'S3ServiceException']);
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES',
  'EPERM', 'ENOSPC', 'EIO', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ABORT_ERR',
  '23505', '23503', '40001', '40P01', '53300', '57P01', '08006', 'AccessDenied', 'NoSuchKey',
  'NoSuchBucket', 'SlowDown', 'RequestTimeout', 'ServiceUnavailable']);
export function safeDiagnostic(error: unknown, message = 'Required effect failed') {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; errorClass?: unknown; errorCode?: unknown } : {};
  const name = value.name ?? value.errorClass;
  const errorClass = typeof name === 'string' && ERROR_CLASSES.has(name) ? name : 'Error';
  const code = value.code ?? value.errorCode;
  const errorCode = typeof code === 'string' && (ERROR_CODES.has(code) || /^P\d{4}$/.test(code)) ? code
    : typeof code === 'number' && Number.isSafeInteger(code) && code >= 100 && code <= 99999 ? code : undefined;
  return { message, errorClass, ...(errorCode === undefined ? {} : { errorCode }) };
}
const ID_KEYS = new Set(['writerId','id','canonicalId','jobId','partyId','accountId','channelId','guildId','ownerId',
  'issueNodeId','discordThreadId','reportId','reporterId','userId','discordId','operationId','rowId','actorId',
  'targetId','ruleId','messageId','discordMessageId','discordChannelId','deviceId','auditId','relayUserId','artifactId',
  'eventCode','giveawayId','introMessageId','entryId','campItemId','eventId','scheduledEventId','mirrorId','fcmUserId']);
const ENUM_KEYS = new Set(['stage','source','mode','state','action','targetType','outcome','reason','status']);
const NUMBER_KEYS = new Set(['issueNumber','reportNumber','targetCount','pageId','sequence','maxSeq','currentSeq','updatedRows','count','createdAt','childPid']);
const COMMITTED_STAGES = new Set(['required-effect-confirmed', ...['authority','identity','session','oauth','moderation','domain','publication','producer','object','audit']
  .flatMap(business => [`${business}-write-confirmed`, `${business}-transaction-confirmed`])]);
export function safeFailureEvidence(evidence: unknown): Record<string, unknown> | undefined {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (ID_KEYS.has(key) && typeof value === 'string' && /^[A-Za-z0-9_:=.-]{1,160}$/.test(value)) result[key] = value;
    else if (ID_KEYS.has(key) && typeof value === 'number' && Number.isSafeInteger(value)) result[key] = value;
    else if (ENUM_KEYS.has(key) && typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,120}$/.test(value)) result[key] = value;
    else if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (key === 'createdAt' && typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) result[key] = value;
    else if (key === 'committedStages' && Array.isArray(value)) result[key] = value.filter(item => typeof item === 'string' && COMMITTED_STAGES.has(item));
    else if (key === 'committedWriterIds' && Array.isArray(value)) result[key] = value.filter(item => typeof item === 'string' && /^[a-f0-9]{24}$/.test(item));
    else if (key === 'sha256' && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) result[key] = value;
    else if (key === 'objectKeys' && Array.isArray(value)) result[key] = value.filter(item => typeof item === 'string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]{1,160}$/.test(item));
    else if (key === 'includeCamp' && typeof value === 'boolean') result[key] = value;
    else if (key === 'objectKey' && typeof value === 'string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]{1,160}$/.test(value)) result[key] = value;
    else if (key === 'routeTemplate' && typeof value === 'string') result[key] = safeDiscordRoute(value);
  }
  return Object.keys(result).length ? result : undefined;
}
const ROUTE_WORDS = new Set(['channels','guilds','members','roles','messages','reactions','webhooks',
  'interactions','callback','users','applications','commands','permissions','threads','thread-members',
  'pins','bans','invites','scheduled-events','subscribers','bulk-delete','crosspost','@original','@me',
  'voice-states','token']);
export function safeDiscordRoute(route: string): string {
  const parts = route.split(/[?#]/, 1)[0].split('/');
  return parts.map((segment, index) => {
    if (!segment) return '';
    // SDK v10 routes place bearer tokens immediately after webhook/interaction ID.
    if (index === 3 && (parts[1] === 'webhooks' || parts[1] === 'interactions')) return ':token';
    return /^\d{1,22}$/.test(segment) || ROUTE_WORDS.has(segment) ? segment : ':value';
  }).join('/');
}
/** Participants expose counts and trusted identifiers, never raw job failedReason. */
export function safeInspectionFailure(value: unknown): Record<string, unknown> {
  return { ...safeFailureEvidence(value), ...safeDiagnostic(undefined, 'Required participant effect failed') };
}

export function safeInspectionDetail(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(safeInspectionDetail).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (/(error|reason|message|token|secret|url|sql|body|content|route)/i.test(key)) return [];
    const safe = key === 'stalled' && Array.isArray(item)
      ? item.filter(id => typeof id === 'string' && /^[A-Za-z0-9_:=.-]{1,160}$/.test(id)) : safeInspectionDetail(item);
    return safe === undefined ? [] : [[key, safe]];
  }));
}
