import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // PostgreSQL constraint violations
  const pgErr = err as any;
  if (pgErr.code === '23505') {
    res.status(409).json({ error: 'Duplicate entry', detail: pgErr.detail });
    return;
  }
  if (pgErr.code === '23503') {
    res.status(400).json({ error: 'Foreign key constraint failed', detail: pgErr.detail });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
