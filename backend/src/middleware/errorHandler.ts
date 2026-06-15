import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

export interface AppError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  title?: string;
  errors?: Array<{ field: string; message: string }>;
}

/**
 * RFC 7807 Problem Details error response
 */
function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  if (status >= 500) {
    logger.error({ err, req: { method: req.method, url: req.url } }, 'Server error');
  }

  res.status(status).json({
    type: err.type || `https://fo76chat.app/errors/${status}`,
    title: err.title || httpStatusTitle(status),
    status,
    detail: isProduction && status >= 500 ? 'An unexpected error occurred.' : (err.message || 'Unknown error'),
    ...(err.errors && { errors: err.errors }),
  });
}

function httpStatusTitle(status: number): string {
  const titles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  };
  return titles[status] || 'Error';
}

function createError(status: number, message: string, opts: Record<string, any> = {}): AppError {
  const err: AppError = new Error(message);
  err.status = status;
  Object.assign(err, opts);
  return err;
}

export { errorHandler, createError };
module.exports = { errorHandler, createError };
