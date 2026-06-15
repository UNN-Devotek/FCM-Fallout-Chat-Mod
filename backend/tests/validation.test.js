'use strict';
const { validate, schemas } = require('../src/middleware/validation');

function runValidate(schema, body) {
  const req = { body };
  const res = {};
  let called = false;
  let errorArg = null;
  const next = (err) => { called = true; errorArg = err || null; };
  validate(schema)(req, res, next);
  return { req, called, errorArg };
}

describe('validate middleware — registerUser', () => {
  it('passes valid payload', () => {
    const { errorArg, req } = runValidate(schemas.registerUser, {
      username: 'Wanderer76',
      installToken: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(errorArg).toBeNull();
    expect(req.body.username).toBe('Wanderer76');
  });

  it('rejects missing username', () => {
    const { errorArg } = runValidate(schemas.registerUser, {
      installToken: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(errorArg).not.toBeNull();
    expect(errorArg.status).toBe(400);
    expect(errorArg.errors.some((e) => e.field === 'username')).toBe(true);
  });

  it('rejects invalid installToken (not UUID)', () => {
    const { errorArg } = runValidate(schemas.registerUser, {
      username: 'Bob',
      installToken: 'not-a-uuid',
    });
    expect(errorArg).not.toBeNull();
    expect(errorArg.errors.some((e) => e.field === 'installToken')).toBe(true);
  });

  it('strips unknown fields', () => {
    const { req, errorArg } = runValidate(schemas.registerUser, {
      username: 'Bob',
      installToken: '123e4567-e89b-12d3-a456-426614174000',
      hackerField: 'evil',
    });
    expect(errorArg).toBeNull();
    expect(req.body.hackerField).toBeUndefined();
  });
});

describe('validate middleware — createChannel', () => {
  it('applies default color', () => {
    const { req, errorArg } = runValidate(schemas.createChannel, { name: 'Trading' });
    expect(errorArg).toBeNull();
    expect(req.body.color).toBe('#18FF62');
  });

  it('accepts valid hex color', () => {
    const { errorArg } = runValidate(schemas.createChannel, { name: 'Trading', color: '#FF0000' });
    expect(errorArg).toBeNull();
  });

  it('rejects invalid hex color', () => {
    const { errorArg } = runValidate(schemas.createChannel, { name: 'Trading', color: 'red' });
    expect(errorArg).not.toBeNull();
  });
});

describe('validate middleware — submitReport', () => {
  it('passes valid report', () => {
    const { errorArg } = runValidate(schemas.submitReport, {
      targetUserId: '123e4567-e89b-12d3-a456-426614174000',
      reason: 'Spam',
    });
    expect(errorArg).toBeNull();
  });

  it('rejects missing targetUserId', () => {
    const { errorArg } = runValidate(schemas.submitReport, { reason: 'Spam' });
    expect(errorArg).not.toBeNull();
  });
});
