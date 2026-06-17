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

async function rest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg = (json && (json.message as string)) || text || res.statusText;
    throw new Error(`GitHub REST ${method} ${path} -> ${res.status}: ${msg}`);
  }
  return json as T;
}

async function graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!isConfigured()) throw new Error('GitHub integration is not configured (GITHUB_PAT/OWNER/REPO)');
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub GraphQL -> ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors && json.errors.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
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
  const data = await rest<any>('POST', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    title: input.title.slice(0, 256),
    body: input.body,
    labels: input.labels && input.labels.length ? input.labels : undefined,
  });
  return { number: data.number, nodeId: data.node_id, htmlUrl: data.html_url, title: data.title };
}

/** Add a comment to an existing issue. Returns the created comment id. */
export async function addIssueComment(issueNumber: number, body: string): Promise<number> {
  const data = await rest<any>(
    'POST',
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
    { body },
  );
  return data.id;
}

/** Add labels to an issue (idempotent on GitHub's side). */
export async function addLabels(issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.length) return;
  await rest('POST', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, { labels });
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
  await rest('PATCH', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}`, {
    milestone: milestoneNumber,
  });
}

/** Close an issue (state=closed). */
export async function closeIssue(issueNumber: number): Promise<void> {
  await rest('PATCH', `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/${issueNumber}`, { state: 'closed' });
}

/**
 * Permanently delete an issue via GraphQL. Requires elevated repo permissions
 * (delete issues) — may throw FORBIDDEN if the token can't delete; callers should
 * fall back to closeIssue.
 */
export async function deleteIssue(issueNodeId: string): Promise<void> {
  await graphql(`mutation($id:ID!){ deleteIssue(input:{ issueId:$id }){ clientMutationId } }`, { id: issueNodeId });
}

export default {
  isConfigured,
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
  createIssue,
  addIssueComment,
  addLabels,
  listOpenMilestones,
  setIssueMilestone,
  closeIssue,
  deleteIssue,
};
