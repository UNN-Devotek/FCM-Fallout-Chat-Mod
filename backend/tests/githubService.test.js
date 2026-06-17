'use strict';

/**
 * Unit tests for githubService (native-fetch GitHub client). global.fetch is
 * stubbed so no network calls are made.
 */

jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: {
    GITHUB_PAT: 'test-pat',
    GITHUB_OWNER: 'UNN-Devotek',
    GITHUB_REPO: 'FCM-Fallout-Chat-Mod',
    GITHUB_PROJECT_BUGS_NUMBER: 2,
    GITHUB_PROJECT_ROADMAP_NUMBER: 3,
  },
}));
jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function restResponse(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => JSON.stringify(jsonBody),
    json: async () => jsonBody,
  };
}
function gqlResponse(dataOrErrors) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(dataOrErrors),
    json: async () => dataOrErrors,
  };
}

describe('githubService', () => {
  let svc;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/config/environment', () => ({
      __esModule: true,
      default: {
        GITHUB_PAT: 'test-pat',
        GITHUB_OWNER: 'UNN-Devotek',
        GITHUB_REPO: 'FCM-Fallout-Chat-Mod',
        GITHUB_PROJECT_BUGS_NUMBER: 2,
        GITHUB_PROJECT_ROADMAP_NUMBER: 3,
      },
    }));
    jest.mock('../src/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    svc = require('../src/services/githubService');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('isConfigured is true with a PAT + owner + repo', () => {
    expect(svc.isConfigured()).toBe(true);
  });

  it('createIssue POSTs to the issues endpoint and maps the response', async () => {
    global.fetch.mockResolvedValueOnce(
      restResponse(201, { number: 17, node_id: 'NODE17', html_url: 'https://gh/17', title: 'Boom' }),
    );

    const issue = await svc.createIssue({ title: 'Boom', body: 'desc', labels: ['bug'] });

    expect(issue).toEqual({ number: 17, nodeId: 'NODE17', htmlUrl: 'https://gh/17', title: 'Boom' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/UNN-Devotek/FCM-Fallout-Chat-Mod/issues');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-pat');
    expect(JSON.parse(opts.body)).toMatchObject({ title: 'Boom', body: 'desc', labels: ['bug'] });
  });

  it('createIssue throws on a non-2xx response', async () => {
    global.fetch.mockResolvedValueOnce(restResponse(422, { message: 'Validation failed' }));
    await expect(svc.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/422.*Validation failed/);
  });

  it('addLabels is a no-op for an empty list', async () => {
    await svc.addLabels(5, []);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('listOpenMilestones maps the REST response', async () => {
    global.fetch.mockResolvedValueOnce(
      restResponse(200, [
        { number: 1, title: 'v1.0', extra: 'ignored' },
        { number: 2, title: 'v1.1' },
      ]),
    );
    const ms = await svc.listOpenMilestones();
    expect(ms).toEqual([
      { number: 1, title: 'v1.0' },
      { number: 2, title: 'v1.1' },
    ]);
    expect(global.fetch.mock.calls[0][0]).toContain('/milestones?state=open');
  });

  it('setIssueMilestone PATCHes the issue with the milestone number', async () => {
    global.fetch.mockResolvedValueOnce(restResponse(200, { number: 5 }));
    await svc.setIssueMilestone(5, 2);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/UNN-Devotek/FCM-Fallout-Chat-Mod/issues/5');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ milestone: 2 });
  });

  it('setIssueMilestone clears the milestone with null', async () => {
    global.fetch.mockResolvedValueOnce(restResponse(200, { number: 5 }));
    await svc.setIssueMilestone(5, null);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ milestone: null });
  });

  it('closeIssue PATCHes state=closed', async () => {
    global.fetch.mockResolvedValueOnce(restResponse(200, { number: 9, state: 'closed' }));
    await svc.closeIssue(9);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/UNN-Devotek/FCM-Fallout-Chat-Mod/issues/9');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ state: 'closed' });
  });

  it('deleteIssue sends the deleteIssue GraphQL mutation', async () => {
    global.fetch.mockResolvedValueOnce(gqlResponse({ data: { deleteIssue: { clientMutationId: null } } }));
    await svc.deleteIssue('NODE9');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    const body = JSON.parse(opts.body);
    expect(body.query).toContain('deleteIssue');
    expect(body.variables).toEqual({ id: 'NODE9' });
  });

  it('deleteIssue surfaces GraphQL FORBIDDEN (caller falls back to close)', async () => {
    global.fetch.mockResolvedValueOnce(gqlResponse({ errors: [{ message: 'Must have admin access to delete' }] }));
    await expect(svc.deleteIssue('NODE9')).rejects.toThrow(/admin access/);
  });
});
