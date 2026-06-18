'use strict';

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn(), create: jest.fn() },
    playerReport: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  },
}));
jest.mock('../src/services/reportImageService', () => ({ uploadReportImages: jest.fn() }));
jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/services/discordService', () => ({ postModAlert: jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../src/config/prisma').default;
const imgs = require('../src/services/reportImageService');
const svc = require('../src/services/playerReportService');

describe('playerReportService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createPlayerReport', () => {
    it('creates the user if missing, sanitizes input, and creates the report', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u1', username: 'discord:1', discordUsername: 'dev' });
      prisma.playerReport.create.mockResolvedValue({ id: 'r1', reportNumber: 1 });

      const out = await svc.createPlayerReport({
        discordId: '1',
        username: 'dev',
        content: '   bad player griefing   ',
        involvedPlayers: '<b>Bob</b> & "Eve"',
      });

      expect(prisma.user.create).toHaveBeenCalled();
      expect(prisma.playerReport.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          content: 'bad player griefing',
          reportType: 'player',
          involvedPlayers: 'bBob/b  Eve',
          status: 'open',
        },
      });
      expect(out).toEqual({
        id: 'r1',
        reportNumber: 1,
        reporterName: 'dev',
        reporterDiscordId: '1',
        involvedPlayers: 'bBob/b  Eve',
      });
    });

    it('reuses an existing user', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u9', username: 'discord:9' });
      prisma.playerReport.create.mockResolvedValue({ id: 'r9' });
      await svc.createPlayerReport({ discordId: '9', content: 'x' });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.playerReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'u9' }) }),
      );
    });
  });

  describe('attachImagesToReport', () => {
    it('uploads up to the remaining slots and merges, capped at 3', async () => {
      prisma.playerReport.findUnique.mockResolvedValue({ id: 'r1', imageUrls: JSON.stringify(['a']) });
      imgs.uploadReportImages.mockResolvedValue(['b', 'c']);
      prisma.playerReport.update.mockResolvedValue({});

      const res = await svc.attachImagesToReport('r1', [Buffer.from('x'), Buffer.from('y'), Buffer.from('z')]);

      // existing 1 → room 2 → only 2 buffers uploaded
      expect(imgs.uploadReportImages).toHaveBeenCalledWith([Buffer.from('x'), Buffer.from('y')]);
      expect(prisma.playerReport.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { imageUrls: JSON.stringify(['a', 'b', 'c']) },
      });
      expect(res).toEqual({ accepted: 2, total: 3, full: true });
    });

    it('is a no-op when the report already has 3 images', async () => {
      prisma.playerReport.findUnique.mockResolvedValue({ id: 'r1', imageUrls: JSON.stringify(['a', 'b', 'c']) });
      const res = await svc.attachImagesToReport('r1', [Buffer.from('x')]);
      expect(imgs.uploadReportImages).not.toHaveBeenCalled();
      expect(prisma.playerReport.update).not.toHaveBeenCalled();
      expect(res).toEqual({ accepted: 0, total: 3, full: true });
    });
  });
});
