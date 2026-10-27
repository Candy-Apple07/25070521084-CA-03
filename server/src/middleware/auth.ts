// Session tokens live in an httpOnly cookie, so page scripts can never read them.

import type { CookieOptions, NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';

export const COOKIE = 'obsidian_session';

function cookieOptions(): CookieOptions {
  // A client on another origin needs SameSite=None (which in turn requires Secure).
  const crossSite = config.production && !!config.clientOrigin;
  return {
    httpOnly: true,
    secure: config.production,
    sameSite: crossSite ? 'none' : 'lax',
    path: '/',
  };
}

export function startSession(res: Response, userId: string) {
  const token = jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: `${config.sessionDays}d` });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: config.sessionDays * 24 * 60 * 60 * 1000 });
}

export function endSession(res: Response) {
  res.clearCookie(COOKIE, cookieOptions());
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

/** Rejects the request with 401 unless it carries a valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[COOKIE];
  if (typeof token !== 'string') return void res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string' || !payload.sub) throw new Error('bad token');
    req.userId = payload.sub;
    next();
  } catch {
    endSession(res);
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}
