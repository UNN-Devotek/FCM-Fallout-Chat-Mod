// Unit tests for game-process detection helpers (isGameProcess / GAME_PROCESSES).
// These cover the Xbox Game Pass support added in the Project76_GamePass fix and
// ensure future exe additions don't silently break detection.

import core from '../overlay-core.js';

const { GAME_PROCESSES, isGameProcess } = core;

describe('GAME_PROCESSES', () => {
  it('includes the standard Steam/Bethesda.net exe', () => {
    expect(GAME_PROCESSES).toContain('Fallout76');
  });

  it('includes the Xbox Game Pass / Microsoft Store exe', () => {
    expect(GAME_PROCESSES).toContain('Project76_GamePass');
  });

  it('is an array', () => {
    expect(Array.isArray(GAME_PROCESSES)).toBe(true);
  });
});

describe('isGameProcess', () => {
  // ── Standard install ──────────────────────────────────────────────────────

  it('matches Fallout76 (exact case)', () => {
    expect(isGameProcess('Fallout76')).toBe(true);
  });

  it('matches fallout76 (lowercase)', () => {
    expect(isGameProcess('fallout76')).toBe(true);
  });

  it('matches FALLOUT76 (uppercase)', () => {
    expect(isGameProcess('FALLOUT76')).toBe(true);
  });

  it('matches Fallout76.exe (with extension)', () => {
    expect(isGameProcess('Fallout76.exe')).toBe(true);
  });

  it('matches fallout76.exe (lowercase with extension)', () => {
    expect(isGameProcess('fallout76.exe')).toBe(true);
  });

  it('matches FALLOUT76.EXE (uppercase with extension)', () => {
    expect(isGameProcess('FALLOUT76.EXE')).toBe(true);
  });

  // ── Xbox Game Pass / Microsoft Store ──────────────────────────────────────

  it('matches Project76_GamePass (exact case)', () => {
    expect(isGameProcess('Project76_GamePass')).toBe(true);
  });

  it('matches project76_gamepass (lowercase)', () => {
    expect(isGameProcess('project76_gamepass')).toBe(true);
  });

  it('matches PROJECT76_GAMEPASS (uppercase)', () => {
    expect(isGameProcess('PROJECT76_GAMEPASS')).toBe(true);
  });

  it('matches Project76_GamePass.exe (with extension)', () => {
    expect(isGameProcess('Project76_GamePass.exe')).toBe(true);
  });

  it('matches project76_gamepass.exe (lowercase with extension)', () => {
    expect(isGameProcess('project76_gamepass.exe')).toBe(true);
  });

  it('matches PROJECT76_GAMEPASS.EXE (uppercase with extension)', () => {
    expect(isGameProcess('PROJECT76_GAMEPASS.EXE')).toBe(true);
  });

  // ── Non-matches — must not produce false positives ─────────────────────────

  it('rejects an unrelated process', () => {
    expect(isGameProcess('chrome')).toBe(false);
  });

  it('rejects a partial match (Fallout76Custom)', () => {
    expect(isGameProcess('Fallout76Custom')).toBe(false);
  });

  it('rejects a partial match (Fallout76Custom.exe)', () => {
    expect(isGameProcess('Fallout76Custom.exe')).toBe(false);
  });

  it('rejects a partial match (.ini file opened in an editor)', () => {
    expect(isGameProcess('Fallout76.ini')).toBe(false);
  });

  it('rejects Fallout4 (different game)', () => {
    expect(isGameProcess('Fallout4')).toBe(false);
  });

  it('rejects a bare substring "76"', () => {
    expect(isGameProcess('76')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isGameProcess('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isGameProcess(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isGameProcess(undefined)).toBe(false);
  });

  // ── GAME_PROCESSES drives isGameProcess exhaustively ──────────────────────
  // Each entry in the array must match (with and without .exe suffix).

  it.each(GAME_PROCESSES)('GAME_PROCESSES entry "%s" is detected by isGameProcess', (proc) => {
    expect(isGameProcess(proc)).toBe(true);
    expect(isGameProcess(proc + '.exe')).toBe(true);
    expect(isGameProcess(proc.toLowerCase())).toBe(true);
    expect(isGameProcess(proc.toUpperCase())).toBe(true);
    expect(isGameProcess(proc.toLowerCase() + '.exe')).toBe(true);
    expect(isGameProcess(proc.toUpperCase() + '.EXE')).toBe(true);
  });
});
