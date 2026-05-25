import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps any async route handler so unhandled errors go to Express error middleware
export function asyncHandler(fn: (req: any, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
