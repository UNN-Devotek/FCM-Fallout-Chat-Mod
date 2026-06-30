const express = require('express');
const request = require('supertest');

describe('POST /api/player-list', () => {
  let app;
  let validatePlayerList;
  let setServerPlayers;
  let setServerPlayersForSession;
  let setServerPlayersForUser;

  beforeEach(() => {
    jest.resetModules();

    validatePlayerList = jest.fn((_endpoint, players) => players);
    setServerPlayers = jest.fn().mockResolvedValue();
    setServerPlayersForSession = jest.fn().mockResolvedValue();
    setServerPlayersForUser = jest.fn().mockResolvedValue();

    jest.doMock('../src/config/logger', () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    jest.doMock('../src/middleware/requireClientAuth', () => ({
      requireClientAuth: (req, _res, next) => {
        req.user = { id: 'user-1' };
        next();
      },
    }));
    jest.doMock('../src/middleware/rateLimiter', () => ({
      playerListLimiter: (_req, _res, next) => next(),
    }));
    jest.doMock('../src/services/playerListService', () => ({
      __esModule: true,
      validatePlayerList,
      setServerPlayers,
      setServerPlayersForSession,
      setServerPlayersForUser,
    }));

    const router = require('../src/routes/playerList').default;
    app = express();
    app.use(express.json());
    app.use('/api/player-list', router);
  });

  test('stores endpoint, session, and user snapshots when provided', async () => {
    await request(app)
      .post('/api/player-list')
      .send({ endpoint: 'world-1', sessionId: 'sess-1', players: ['Alpha', 'Bravo'] })
      .expect(204);

    expect(validatePlayerList).toHaveBeenCalledWith('world-1', ['Alpha', 'Bravo']);
    expect(setServerPlayers).toHaveBeenCalledWith('world-1', ['Alpha', 'Bravo']);
    expect(setServerPlayersForSession).toHaveBeenCalledWith('sess-1', ['Alpha', 'Bravo'], 'world-1');
    expect(setServerPlayersForUser).toHaveBeenCalledWith('user-1', ['Alpha', 'Bravo'], 'world-1');
  });

  test('still caches a user snapshot when only players are provided', async () => {
    await request(app)
      .post('/api/player-list')
      .send({ players: ['Solo'] })
      .expect(204);

    expect(validatePlayerList).toHaveBeenCalledWith('', ['Solo']);
    expect(setServerPlayers).not.toHaveBeenCalled();
    expect(setServerPlayersForSession).not.toHaveBeenCalled();
    expect(setServerPlayersForUser).toHaveBeenCalledWith('user-1', ['Solo'], null);
  });
});
