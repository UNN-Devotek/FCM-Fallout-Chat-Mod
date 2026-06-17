/**
 * Thin GitHub API client for the Discord ticketing feature.
 *
 * Uses native fetch (Node 18+) — no Octokit dependency. Recent Octokit is
 * ESM-only and fights this CommonJS/Jest codebase; the slice of GitHub we need
 * (create issue, comment, label via REST; add-to-Project-v2 via GraphQL) is a
 * handful of HTTP calls, so a tiny hand-rolled client keeps deps at zero and
 * mocks cleanly in tests (jest can stub global.fetch).
 *
 * Auth: GITHUB_PAT (fine-grained PAT owned by UNN-Devotek). Projects v2 is
 * GraphQL-only and requires the token's "Projects: read & write" permission.
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

// --- Projects v2 (GraphQL) -------------------------------------------------

const projectIdCache = new Map<number, string>();

/** Resolve (and cache) a user-owned Project v2 node id from its number. */
export async function getProjectNodeId(projectNumber: number): Promise<string> {
  const cached = projectIdCache.get(projectNumber);
  if (cached) return cached;
  const data = await graphql<{ user: { projectV2: { id: string } | null } }>(
    `query($login:String!, $number:Int!){ user(login:$login){ projectV2(number:$number){ id } } }`,
    { login: env.GITHUB_OWNER, number: projectNumber },
  );
  const id = data?.user?.projectV2?.id;
  if (!id) throw new Error(`Project v2 #${projectNumber} not found for ${env.GITHUB_OWNER}`);
  projectIdCache.set(projectNumber, id);
  return id;
}

/**
 * Add an issue (by its GraphQL node id) to a Project v2 board. Returns the
 * project item id. Idempotent: re-adding an existing item returns its id.
 */
export async function addIssueToProject(projectNumber: number, issueNodeId: string): Promise<string> {
  const projectId = await getProjectNodeId(projectNumber);
  const data = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($projectId:ID!, $contentId:ID!){
       addProjectV2ItemById(input:{ projectId:$projectId, contentId:$contentId }){ item { id } }
     }`,
    { projectId, contentId: issueNodeId },
  );
  const itemId = data?.addProjectV2ItemById?.item?.id;
  if (!itemId) throw new Error('addProjectV2ItemById returned no item id');
  return itemId;
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

/** Test-only: clear the project-id cache between cases. */
export function _resetCaches(): void {
  projectIdCache.clear();
}

export default {
  isConfigured,
  createIssue,
  addIssueComment,
  addLabels,
  getProjectNodeId,
  addIssueToProject,
  listOpenMilestones,
  setIssueMilestone,
  closeIssue,
  deleteIssue,
  _resetCaches,
};
module.exports = {
  isConfigured,
  createIssue,
  addIssueComment,
  addLabels,
  getProjectNodeId,
  addIssueToProject,
  listOpenMilestones,
  setIssueMilestone,
  closeIssue,
  deleteIssue,
  _resetCaches,
};
