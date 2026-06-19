/**
 * Client Performance Metrics — REMOVED (privacy + simplification).
 *
 * Telemetry/performance collection has been removed. This endpoint is retained
 * ONLY as a 410 Gone tombstone so already-installed desktop clients stop posting
 * cleanly without error noise. No data is stored, no auth/rate-limit needed.
 */
import { Router, Request, Response } from 'express';

const ingestRouter = Router();

ingestRouter.all('*', (_req: Request, res: Response): void => {
  res.status(410).json({
    type: 'https://fo76chat.app/errors/410',
    title: 'Gone',
    status: 410,
    detail: 'Client metrics collection has been removed.',
  });
});

export { ingestRouter };
