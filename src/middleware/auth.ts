import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { getUserByUid } from '../db/users.ts';

export const SOVEREIGN_ADMIN_EMAIL = 'omralabis@gmail.com';

export function getAdminJwtSecret(): string | null {
  const secret = process.env.ADMIN_JWT_SECRET?.trim() || process.env.SESSION_SECRET?.trim();
  return secret || null;
}

export const VALID_EMPLOYEE_CODES = [
  'EMP001',
  'EMP002',
  'EMP003',
  'EMP004',
  'EMP005',
  'EMP006',
  'EMP007',
  'EMP008',
] as const;

export type ValidEmployeeCode = (typeof VALID_EMPLOYEE_CODES)[number];

export function isValidEmployeeCode(code: string): code is ValidEmployeeCode {
  return (VALID_EMPLOYEE_CODES as readonly string[]).includes(code.trim().toUpperCase());
}

export interface AuthUser {
  uid: string;
  email?: string;
  role: 'admin' | 'staff' | 'driver' | 'customer' | 'employee';
  username?: string;
  displayName?: string;
  emailVerified?: boolean;
  isSuperAdmin?: boolean;
  [key: string]: any;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function hasRole(user: AuthUser | undefined, allowedRoles: Array<AuthUser['role']>): boolean {
  if (!user) return false;
  return allowedRoles.includes(user.role);
}

export const ADMIN_SESSION_COOKIE_NAME = 'amazon_duaa_admin_session';

// Server-side revocation store (keyed by jti -> expiration timestamp ms)
const revokedAdminJtis = new Map<string, number>();

function pruneRevokedAdminTokens(): void {
  const now = Date.now();
  for (const [jti, exp] of revokedAdminJtis.entries()) {
    if (exp <= now) {
      revokedAdminJtis.delete(jti);
    }
  }
}

export function revokeAdminToken(token: string): boolean {
  try {
    pruneRevokedAdminTokens();
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = typeof decoded?.exp === 'number' ? decoded.exp : Date.now() + 7 * 24 * 60 * 60 * 1000;
    const key =
      typeof decoded?.jti === 'string' && decoded.jti
        ? decoded.jti
        : crypto.createHash('sha256').update(token).digest('hex');
    revokedAdminJtis.set(key, exp);
    return true;
  } catch {
    return false;
  }
}

export function clearRevokedAdminTokensForTest(): void {
  revokedAdminJtis.clear();
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export function extractAdminCookieToken(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies[ADMIN_SESSION_COOKIE_NAME];
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  return raw.trim() || null;
}

function isCookieCsrfValid(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!hostHeader) return true;

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  const sourceUrl = originHeader || refererHeader;
  // Require matching Origin/Referer when present on cookie-authenticated mutations
  if (!sourceUrl) {
    return true;
  }
  try {
    const parsed = new URL(sourceUrl);
    return parsed.host.toLowerCase() === hostHeader;
  } catch {
    return false;
  }
}

/**
 * Creates an HMAC-SHA256 signed admin session token with a unique jti for revocation.
 * Requires ADMIN_JWT_SECRET or SESSION_SECRET in environment variables.
 * Token format: base64url(header).base64url(payload).signature
 */
export function createAdminToken(username: string): string {
  const secret = getAdminJwtSecret();
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET or SESSION_SECRET must be configured before issuing admin tokens.');
  }

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days expiry
  const jti = crypto.randomUUID();
  const payload = Buffer.from(
    JSON.stringify({
      sub: username,
      role: 'admin',
      email: SOVEREIGN_ADMIN_EMAIL,
      jti,
      exp,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed admin session token.
 * Returns decoded AuthUser if valid, not revoked, and not expired, null otherwise.
 */
export function verifyAdminToken(token: string): AuthUser | null {
  try {
    const secret = getAdminJwtSecret();
    if (!secret) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
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
    if (decoded.role === 'employee') {
      return null; // Employee tokens must NEVER satisfy verifyAdminToken
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    if (
      (typeof decoded.jti === 'string' && revokedAdminJtis.has(decoded.jti)) ||
      revokedAdminJtis.has(tokenHash)
    ) {
      return null; // Revoked via logout
    }

    return {
      uid: 'admin-super-uid',
      email: decoded.email || SOVEREIGN_ADMIN_EMAIL,
      role: 'admin',
      username: decoded.sub || 'admin',
      displayName: 'مدير المتجر',
      emailVerified: true,
      isSuperAdmin: true,
    };
  } catch {
    return null;
  }
}

export function createEmployeeToken(employeeCode: string): string {
  const normalizedCode = employeeCode.trim().toUpperCase();
  if (!isValidEmployeeCode(normalizedCode)) {
    throw new Error('رمز الموظف غير صالح. الرموز المعتمدة من EMP001 إلى EMP008 فقط.');
  }
  const secret = getAdminJwtSecret();
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET or SESSION_SECRET must be configured before issuing employee tokens.');
  }

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(
    JSON.stringify({
      sub: normalizedCode,
      role: 'employee',
      employeeCode: normalizedCode,
      exp,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

export function verifyEmployeeToken(token: string): AuthUser | null {
  try {
    const secret = getAdminJwtSecret();
    if (!secret) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.exp || Date.now() > decoded.exp) {
      return null;
    }
    if (decoded.role !== 'employee' || typeof decoded.employeeCode !== 'string' || !isValidEmployeeCode(decoded.employeeCode)) {
      return null;
    }

    const code = decoded.employeeCode.trim().toUpperCase();
    return {
      uid: `employee-${code}`,
      role: 'employee',
      username: code,
      displayName: `موظف (${code})`,
      emailVerified: false,
      isSuperAdmin: false,
    };
  } catch {
    return null;
  }
}

function isNonFirebaseJwt(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!header || typeof header !== 'object') return false;
    return header.alg === 'HS256' || !header.kid;
  } catch {
    return false;
  }
}

/**
 * Resolves either a signed Admin/Employee session token or a Firebase ID Token into an RBAC AuthUser.
 * Returns null if the token is invalid or expired.
 */
export async function resolveAuthenticatedUser(token: string): Promise<AuthUser | null> {
  if (!token || token === 'undefined' || token === 'null') {
    return null;
  }

  // 1. Check signed Admin session token
  const adminSession = verifyAdminToken(token);
  if (adminSession) {
    return adminSession;
  }

  // 2. Check signed Employee session token (restricted to employee role only)
  const employeeSession = verifyEmployeeToken(token);
  if (employeeSession) {
    return employeeSession;
  }

  // Never pass expired/unrecognized HS256 admin JWTs or kid-less tokens to Firebase verifyIdToken
  if (isNonFirebaseJwt(token)) {
    return null;
  }

  // 2. Check Firebase ID Token
  const decodedToken = await adminAuth.verifyIdToken(token);
  const email = decodedToken.email?.toLowerCase().trim();
  const isVerifiedSovereign =
    email === SOVEREIGN_ADMIN_EMAIL && decodedToken.email_verified === true;

  let role: AuthUser['role'] = 'customer';
  if (isVerifiedSovereign) {
    role = 'admin';
  } else {
    try {
      const dbUser = await getUserByUid(decodedToken.uid);
      if (
        dbUser &&
        (dbUser.role === 'admin' || dbUser.role === 'staff' || dbUser.role === 'driver')
      ) {
        role = dbUser.role;
      }
    } catch (dbErr) {
      console.warn('[Auth Middleware] Database user query notice:', dbErr);
    }
  }

  return {
    uid: decodedToken.uid,
    email: decodedToken.email,
    displayName: decodedToken.name,
    emailVerified: Boolean(decodedToken.email_verified),
    role,
    isSuperAdmin: role === 'admin' && isVerifiedSovereign,
  };
}

/**
 * Core Authentication Middleware:
 * Strictly verifies either a Bearer token (Firebase ID token / Admin / Employee JWT)
 * or an HttpOnly signed Admin session cookie (with CSRF Origin validation on mutations).
 * Rejects any unauthenticated or invalid request with HTTP 401.
 */
export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.split('Bearer ')[1]?.trim()
      : undefined;
  const cookieToken = extractAdminCookieToken(req);

  if (
    (!bearerToken || bearerToken === 'undefined' || bearerToken === 'null') &&
    !cookieToken
  ) {
    return res.status(401).json({ error: 'Unauthorized: Authentication token is required' });
  }

  if (bearerToken && bearerToken !== 'undefined' && bearerToken !== 'null') {
    try {
      const user = await resolveAuthenticatedUser(bearerToken);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (error: any) {
      console.warn('[Auth Middleware] Bearer verification notice:', error?.message || error);
    }
  }

  if (cookieToken) {
    if (!isCookieCsrfValid(req)) {
      return res.status(403).json({ error: 'Forbidden: Cross-site request blocked (CSRF)' });
    }
    try {
      const cookieUser = await resolveAuthenticatedUser(cookieToken);
      if (cookieUser) {
        req.user = cookieUser;
        return next();
      }
    } catch (error: any) {
      console.warn('[Auth Middleware] Cookie verification notice:', error?.message || error);
    }
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
};

/**
 * Unified RBAC Middleware Factory
 */
export const requireRoles = (...allowedRoles: Array<AuthUser['role']>) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    await requireAuth(req, res, () => {
      if (hasRole(req.user, allowedRoles)) {
        return next();
      }
      // If a lower-privileged Bearer token (e.g. Firebase customer) was sent alongside a valid HttpOnly Admin cookie,
      // allow the verified Admin cookie on admin-authorized endpoints after CSRF check.
      if (allowedRoles.includes('admin')) {
        const cookieToken = extractAdminCookieToken(req);
        if (cookieToken) {
          if (!isCookieCsrfValid(req)) {
            return res.status(403).json({ error: 'Forbidden: Cross-site request blocked (CSRF)' });
          }
          const adminFromCookie = verifyAdminToken(cookieToken);
          if (adminFromCookie) {
            req.user = adminFromCookie;
            return next();
          }
        }
      }
      return res.status(403).json({ error: 'Forbidden: Insufficient RBAC privileges' });
    });
  };
};

export const requireAdmin = requireRoles('admin');
export const requireStaffOrAdmin = requireRoles('admin', 'staff');
export const requireDriverOrStaffOrAdmin = requireRoles('admin', 'staff', 'driver');
export const requireEmployeeOrAdmin = requireRoles('employee', 'admin');
