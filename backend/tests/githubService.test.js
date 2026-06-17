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
    svc._resetCaches();
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

  it('addIssueToProject resolves the project node id then mutates', async () => {
    global.fetch
      .mockResolvedValueOnce(gqlResponse({ data: { user: { projectV2: { id: 'PROJ2' } } } }))
      .mockResolvedValueOnce(gqlResponse({ data: { addProjectV2ItemById: { item: { id: 'ITEM1' } } } }));

    const itemId = await svc.addIssueToProject(2, 'NODE17');

    expect(itemId).toBe('ITEM1');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const firstVars = JSON.parse(global.fetch.mock.calls[0][1].body).variables;
    expect(firstVars).toEqual({ login: 'UNN-Devotek', number: 2 });
    const secondVars = JSON.parse(global.fetch.mock.calls[1][1].body).variables;
    expect(secondVars).toEqual({ projectId: 'PROJ2', contentId: 'NODE17' });
  });

  it('caches the project node id across calls', async () => {
    global.fetch
      .mockResolvedValueOnce(gqlResponse({ data: { user: { projectV2: { id: 'PROJ2' } } } }))
      .mockResolvedValueOnce(gqlResponse({ data: { addProjectV2ItemById: { item: { id: 'A' } } } }))
      .mockResolvedValueOnce(gqlResponse({ data: { addProjectV2ItemById: { item: { id: 'B' } } } }));

    await svc.addIssueToProject(2, 'N1');
    await svc.addIssueToProject(2, 'N2');

    // 1 project lookup + 2 mutations = 3 (not 4) — lookup was cached.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('addIssueToProject surfaces GraphQL errors', async () => {
    global.fetch.mockResolvedValueOnce(
      gqlResponse({ errors: [{ message: 'Resource not accessible by personal access token' }] }),
    );
    await expect(svc.addIssueToProject(2, 'N1')).rejects.toThrow(/not accessible/);
  });

  it('addLabels is a no-op for an empty list', async () => {
    await svc.addLabels(5, []);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
