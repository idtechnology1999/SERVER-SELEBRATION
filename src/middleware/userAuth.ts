import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface UserAuthRequest extends Request {
  user?: { id: string; email: string; role: string; scope?: string };
}

const USER_ROLES = new Set(['student', 'affiliate']);

// Full login, issued once the email is confirmed.
export function signUserToken(user: { _id: { toString(): string }; email: string }): string {
  return jwt.sign(
    { id: user._id.toString(), email: user.email, role: 'student' },
    process.env.JWT_SECRET as string,
    { expiresIn: '30d' },
  );
}

// Limited token for a buyer who hasn't confirmed their email yet: it only works on the
// sign-up payment/confirmation endpoints, never on the dashboard.
export function signSignupToken(user: { _id: { toString(): string }; email: string }): string {
  return jwt.sign(
    { id: user._id.toString(), email: user.email, role: 'student', scope: 'signup' },
    process.env.JWT_SECRET as string,
    { expiresIn: '2d' },
  );
}

function decode(req: Request, res: Response): UserAuthRequest['user'] | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized — token required' });
    return null;
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET!) as UserAuthRequest['user'];
    if (!decoded || !USER_ROLES.has(decoded.role)) {
      res.status(403).json({ success: false, message: 'Forbidden — user access required' });
      return null;
    }
    return decoded;
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return null;
  }
}

export function requireUserAuth(req: UserAuthRequest, res: Response, next: NextFunction): void {
  const decoded = decode(req, res);
  if (!decoded) return;
  if (decoded.scope === 'signup') {
    res.status(403).json({ success: false, message: 'Please confirm your email first' });
    return;
  }
  req.user = decoded;
  next();
}

export function requireSignupAuth(req: UserAuthRequest, res: Response, next: NextFunction): void {
  const decoded = decode(req, res);
  if (!decoded) return;
  if (decoded.scope !== 'signup') {
    res.status(403).json({ success: false, message: 'This link is only for finishing sign-up' });
    return;
  }
  req.user = decoded;
  next();
}
