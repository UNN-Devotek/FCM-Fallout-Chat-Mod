'use strict';
const { errorHandler, createError } = require('../src/middleware/errorHandler');

describe('createError', () => {
  it('creates an error with status and message', () => {
    const err = createError(404, 'Not found');
    expect(err.message).toBe('Not found');
    expect(err.status).toBe(404);
    expect(err).toBeInstanceOf(Error);
  });

  it('merges additional options', () => {
    const err = createError(400, 'Bad request', { errors: [{ field: 'name', message: 'required' }] });
    expect(err.errors).toHaveLength(1);
  });
});

describe('errorHandler middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { method: 'GET', url: '/test' };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    process.env.NODE_ENV = 'test';
  });

  it('responds with RFC 7807 format', () => {
    const err = createError(400, 'Validation failed');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('title');
    expect(body.status).toBe(400);
    expect(body.detail).toBe('Validation failed');
  });

  it('defaults to 500 when no status set', () => {
    const err = new Error('boom');
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('includes errors array when present', () => {
    const err = createError(400, 'Bad', { errors: [{ field: 'x', message: 'required' }] });
    errorHandler(err, req, res, next);
    const body = res.json.mock.calls[0][0];
    expect(body.errors).toHaveLength(1);
  });
});
