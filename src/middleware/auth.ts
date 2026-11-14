import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { getUserByUid } from '../db/users.ts';

const ADMIN_SECRET =
  process.env.ADMIN_JWT_SECRET || process.env.SESSION_SECRET || 'amazon-duaa-secure-admin-token-secret-2026';

export interface AuthUser {
  uid: string;
  email?: string;
  role: 'admin' | 'staff' | 'driver' | 'customer';
  username?: string;
  displayName?: string;
  isSuperAdmin?: boolean;
  [key: string]: any;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

/**
 * Creates an HMAC-SHA256 signed admin session token.
 * Token format: base64url(header).base64url(payload).signature
 */
export function createAdminToken(username: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours expiry
  const payload = Buffer.from(
    JSON.stringify({
      sub: username,
      role: 'admin',
      email: 'omralabis@gmail.com',
      exp,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', ADMIN_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed admin session token.
 * Returns decoded AuthUser if valid and not expired, null otherwise.
 */
export function verifyAdminToken(token: string): AuthUser | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', ADMIN_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.exp || Date.now() > decoded.exp) {
      return null; // Expired
    }

    return {
      uid: 'admin-super-uid',
      email: decoded.email || 'omralabis@gmail.com',
      role: 'admin',
      username: decoded.sub || 'admin',
      displayName: 'مدير المتجر',
      isSuperAdmin: true,
    };
  } catch {
    return null;
  }
}

/**
 * Core Authentication Middleware:
 * Strictly verifies either a signed admin session token or a valid Firebase ID token.
 * Rejects any unauthenticated or invalid request with HTTP 401.
 * Never falls back to granting admin permissions to unauthenticated callers.
 */
export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Authentication token is required' });
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token || token === 'undefined' || token === 'null') {
    return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
  }

  // 1. Check for signed Admin session token
  const adminSession = verifyAdminToken(token);
  if (adminSession) {
    req.user = adminSession;
    return next();
  }

  // 2. Check for Firebase ID Token
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    let role: 'admin' | 'staff' | 'driver' | 'customer' = 'customer';

    // omralabis@gmail.com is sovereign administrator
    if (decodedToken.email?.toLowerCase() === 'omralabis@gmail.com') {
      role = 'admin';
    } else {
      try {
        const dbUser = await getUserByUid(decodedToken.uid);
        if (dbUser && (dbUser.role === 'admin' || dbUser.role === 'staff' || dbUser.role === 'driver')) {
          role = dbUser.role as any;
        }
      } catch (dbErr) {
        console.warn('[Auth Middleware] Database user query notice:', dbErr);
      }
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      displayName: decodedToken.name,
      role,
      isSuperAdmin: role === 'admin' && decodedToken.email?.toLowerCase() === 'omralabis@gmail.com',
    };
    return next();
  } catch (error: any) {
    console.warn('[Auth Middleware] Authentication failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

/**
 * Administrator Role Verification Middleware:
 * Requires valid authentication AND role === 'admin' (or sovereign store owner).
 * Rejects non-admin authenticated users with HTTP 403 Forbidden.
 */
export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  await requireAuth(req, res, () => {
    if (req.user?.role === 'admin' || req.user?.email?.toLowerCase() === 'omralabis@gmail.com') {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Administrator privileges required' });
  });
};

/**
 * Staff or Administrator Role Verification Middleware:
 * Allows admin and staff members to access operational and catalog features.
 */
export const requireStaffOrAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  await requireAuth(req, res, () => {
    if (
      req.user?.role === 'admin' ||
      req.user?.role === 'staff' ||
      req.user?.email?.toLowerCase() === 'omralabis@gmail.com'
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Staff or Administrator privileges required' });
  });
};

/**
 * Driver, Staff, or Administrator Role Verification Middleware:
 * Allows delivery updates by authorized drivers, staff, and admins only.
 */
export const requireDriverOrStaffOrAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  await requireAuth(req, res, () => {
    if (
      req.user?.role === 'admin' ||
      req.user?.role === 'staff' ||
      req.user?.role === 'driver' ||
      req.user?.email?.toLowerCase() === 'omralabis@gmail.com'
    ) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Delivery, Staff, or Administrator privileges required' });
  });
};
