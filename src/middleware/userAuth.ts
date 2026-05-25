import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface UserAuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

const USER_ROLES = new Set(['student', 'affiliate']);

export function requireUserAuth(req: UserAuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized — token required' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; email: string; role: string };
    if (!USER_ROLES.has(decoded.role)) {
      res.status(403).json({ success: false, message: 'Forbidden — user access required' });
      return;
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
