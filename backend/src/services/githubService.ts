import { runRequiredMutation } from '../lib/requiredEffects';
import { beginRuntimeFetch as fetch } from '../runtime/nativeFetch';
/**
 * Thin GitHub API client for the Discord ticketing feature.
 *
 * Uses native fetch (Node 18+) — no Octokit dependency. Recent Octokit is
 * ESM-only and fights this CommonJS/Jest codebase; the slice of GitHub we need
 * (issues, comments, labels, milestones via REST; issue delete via GraphQL) is a
 * handful of HTTP calls, so a tiny hand-rolled client keeps deps at zero and
 * mocks cleanly in tests (jest can stub global.fetch).
 *
 * Auth: GITHUB_PAT. Boards are populated by GitHub's Auto-add workflows keyed off
 * labels (fine-grained PATs cannot write user-owned Projects v2), so this client
 * has no project-write methods.
 */
import env from '../config/environment';
import logger from '../config/logger';

const API = 'https://api.github.com';
const GQL = 'https://api.github.com/graphql';

export function isConfigured(): boolean {
  return !!env.GITHUB_PAT && !!env.GITHUB_OWNER && !!env.GITHUB_REPO;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fcm-discord-bot',
  };
}

async function rest<T = any>(method: string, path: string, body?: unknown, expectedStatus?: number): Promise<T> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new Error(`GitHub REST ${method} -> HTTP ${res.status}`);
  }
  if (expectedStatus !== undefined && res.status !== expectedStatus) throw new Error('GitHub REST mutation status is unconfirmed');
  return json as T;
}

class GitHubGraphQLResponseError extends Error {}
class GitHubDeleteRefusedError extends Error {}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function labelNamesEqual(requested: string, actual: string): boolean {
  // Unicode simple case folding matches GitHub label names without locale,
  // whitespace or normalization changes. Escape literals and require the full name.
  const literal = requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${literal}(?![\\s\\S])`, 'iu').test(actual);
}
function usableIssueUrl(value: unknown): value is string {
  if (!nonBlank(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

/** Only an explicit permission refusal of this mutation permits close fallback.
 * Invalid/partial results and transport failures leave deletion unconfirmed. */
export function isIssueDeleteRefused(error: unknown): boolean {
  return error instanceof GitHubDeleteRefusedError;
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  let json: unknown;
  try { json = await res.json(); }
  catch { throw new GitHubGraphQLResponseError('GitHub GraphQL response is not valid JSON'); }
  if (!res.ok) throw new GitHubGraphQLResponseError(`GitHub GraphQL HTTP ${res.status}`);
  if (!isRecord(json)) throw new GitHubGraphQLResponseError('GitHub GraphQL response is not an object');
  if (json.errors !== undefined) {
    if (!Array.isArray(json.errors)) throw new GitHubGraphQLResponseError('GitHub GraphQL errors result is invalid');
    if (json.errors.length) {
      const deleteRefused = isRecord(json.data) && json.data.deleteIssue === null
        && json.errors.every(error => isRecord(error) && error.type === 'FORBIDDEN'
          && Array.isArray(error.path) && error.path.length === 1 && error.path[0] === 'deleteIssue');
      if (deleteRefused) throw new GitHubDeleteRefusedError('GitHub issue deletion was refused');
      throw new GitHubGraphQLResponseError('GitHub GraphQL mutation result is unconfirmed');
    }
  }
  if (!isRecord(json.data)) throw new GitHubGraphQLResponseError('GitHub GraphQL data result is missing');
  return json.data;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface CreatedIssue {
  number: number;
  nodeId: string;
  htmlUrl: string;
  title: string;
}

/** Create an issue in the configured repo. Labels are best-effort (created on the fly by GitHub). */
export async function createIssue(input: { title: string; body: string; labels?: string[] }): Promise<CreatedIssue> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  const payload = {
    title: input.title.slice(0, 256),
    body: input.body,
    labels: input.labels && input.labels.length ? input.labels : undefined,
  };
  return runRequiredMutation('domain', 'a966caf2677d409297655a99', { stage: 'github-issue-create-unconfirmed' }, async () => {
    const data = await rest<unknown>('POST', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, payload, 201);
    if (!isRecord(data) || !positiveInteger(data.number) || !nonBlank(data.node_id) || !usableIssueUrl(data.html_url) || !nonBlank(data.title)) {
      throw new Error('GitHub issue creation identity is missing or invalid');
    }
    return { number: data.number, nodeId: data.node_id, htmlUrl: data.html_url, title: data.title };
  });
}

/** Add a comment to an existing issue. Returns the created comment id. */
export async function addIssueComment(issueNumber: number, body: string): Promise<number> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  return runRequiredMutation('domain', 'e93e2c8d2ddf4882aad2817', { issueNumber, stage: 'github-comment-create-unconfirmed' }, async () => {
    const data = await rest<unknown>('POST', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, { body }, 201);
    if (!isRecord(data) || !positiveInteger(data.id)) throw new Error('GitHub comment creation identity is missing or invalid');
    return data.id;
  });
}

/** Add labels to an issue (idempotent on GitHub's side). */
export async function addLabels(issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.length) return;
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  await runRequiredMutation('domain', 'c165a46c2ae94312be8d9f97', { issueNumber, stage: 'github-labels-write-unconfirmed' },
    async () => {
      const data = await rest<unknown>('POST', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, { labels }, 200);
      if (!Array.isArray(data) || !data.every(label => isRecord(label) && positiveInteger(label.id) && nonBlank(label.name))
        || !labels.every(name => data.some(label => labelNamesEqual(name, label.name)))) throw new Error('GitHub requested labels are unconfirmed');
    });
}

/** List open repo milestones (for the optional ticket milestone picker). */
export async function listOpenMilestones(): Promise<Array<{ number: number; title: string }>> {
  const data = await rest<any[]>(
    'GET',
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/milestones?state=open&per_page=25&sort=due_on&direction=asc`,
  );
  return Array.isArray(data) ? data.map((m) => ({ number: m.number, title: m.title })) : [];
}

/** Set (or clear, with null) an issue's milestone. */
export async function setIssueMilestone(issueNumber: number, milestoneNumber: number | null): Promise<void> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  await runRequiredMutation('domain', '017cf9c103934cfa8d95fb95', { issueNumber, stage: 'github-milestone-write-unconfirmed' },
    async () => {
      const data = await rest<unknown>('PATCH', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}`, { milestone: milestoneNumber }, 200);
      if (!isRecord(data) || !positiveInteger(data.number) || data.number !== issueNumber || (milestoneNumber === null ? data.milestone !== null
        : !isRecord(data.milestone) || !positiveInteger(data.milestone.number) || data.milestone.number !== milestoneNumber)) throw new Error('GitHub requested milestone is unconfirmed');
    });
}

/** Close an issue (state=closed). */
export async function closeIssue(issueNumber: number): Promise<void> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  await runRequiredMutation('domain', '6b3b9b7b5d8a4cd8ad581e05', { issueNumber, stage: 'github-issue-close-unconfirmed' }, async () => {
    const data = await rest<unknown>('PATCH', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}`, { state: 'closed' }, 200);
    if (!isRecord(data) || data.number !== issueNumber || data.state !== 'closed') {
      throw new Error('GitHub issue closure result is missing or invalid');
    }
  });
}

/**
 * Permanently delete an issue via GraphQL. Requires elevated repo permissions
 * (delete issues). Only isIssueDeleteRefused permits the closeIssue fallback;
 * a malformed/missing/unknown response never confirms deletion.
 */
export async function deleteIssue(issueNodeId: string): Promise<void> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  await runRequiredMutation('domain', 'b58e213dde7042ce9d5b7a92', { issueNodeId, stage: 'github-issue-delete-unconfirmed' }, async () => {
    const data = await graphql(`mutation($id:ID!){ deleteIssue(input:{ issueId:$id }){ clientMutationId } }`, { id: issueNodeId });
    const payload = data.deleteIssue;
    if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, 'clientMutationId')
      || payload.clientMutationId !== null && typeof payload.clientMutationId !== 'string') {
      throw new GitHubGraphQLResponseError('GitHub issue deletion result is missing or invalid');
    }
  });
}

export default {
  isConfigured,
  isIssueDeleteRefused,
  createIssue,
  addIssueComment,
  addLabels,
  listOpenMilestones,
  setIssueMilestone,
  closeIssue,
  deleteIssue,
};
module.exports = {
  isConfigured,
  isIssueDeleteRefused,
  createIssue,
  addIssueComment,
  addLabels,
  listOpenMilestones,
  setIssueMilestone,
  closeIssue,
  deleteIssue,
};
