import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import firebaseConfig from '../../firebase-applet-config.json';
import { adminAuth } from '../lib/firebase-admin.ts';
import { getOrCreateFirebaseUser, getUserById } from '../db/users.ts';

export interface AuthenticatedUser {
  id: string;
  uid: string;
  email: string;
  name: string;
  institution: string;
  role: string;
  authProvider: string;
  consentAnalytics: boolean;
  consentRetention: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export function isProductionEnv(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production' || (process.env.ENVIRONMENT || '').toLowerCase() === 'production';
}

export function isDemoAllowed(): boolean {
  if (isProductionEnv()) {
    return false;
  }
  if ((process.env.ENABLE_DEMO_WORKSPACE || '').toLowerCase() === 'false') {
    return false;
  }
  return process.env.DEMO_MODE_ENABLED !== 'false';
}

export function getJwtSecret(): string {
  const envSecret = (process.env.JWT_SECRET || '').trim();
  const insecure = ['change-me', 'replace-with', 'ephemeral', 'dev-only'];
  if (isProductionEnv()) {
    if (!envSecret || envSecret.length < 32 || insecure.some((m) => envSecret.toLowerCase().includes(m))) {
      throw new Error('JWT_SECRET must be at least 32 characters and non-default in production.');
    }
    return envSecret;
  }
  return envSecret || 'researchforge-dev-ephemeral-secret';
}

export function signSessionToken(payload: { sub: string; email: string; provider?: string }): string {
  return jwt.sign({ ...payload, token_use: 'rf_local_session' }, getJwtSecret(), { expiresIn: '24h' });
}

export function validateFirebaseDecodedClaims(
  decoded: Record<string, any> | null | undefined,
  expectedProjectId: string = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId || ''
): { uid: string; email?: string; name?: string } | null {
  if (!decoded || typeof decoded !== 'object') return null;
  const uid = decoded.uid || decoded.user_id || decoded.sub;
  const sub = decoded.sub || uid;
  if (!uid || !sub || uid !== sub) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp !== 'number' || decoded.exp <= nowSec) return null;
  if (typeof decoded.iat === 'number' && decoded.iat > nowSec + 300) return null;
  if (typeof decoded.auth_time === 'number' && decoded.auth_time > nowSec + 300) return null;

  if (expectedProjectId) {
    const expectedIss = `https://securetoken.google.com/${expectedProjectId}`;
    if (decoded.aud !== expectedProjectId || decoded.iss !== expectedIss) {
      return null;
    }
  }
  return {
    uid: String(uid),
    email: typeof decoded.email === 'string' ? decoded.email : undefined,
    name: typeof decoded.name === 'string' ? decoded.name : undefined,
  };
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing authentication token.' });
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty authentication token.' });
  }

  // 1. Verify local session JWT (permitted only for local or non-production demo accounts)
  let localJwtDecoded: { sub?: string; email?: string; token_use?: string } | null = null;
  try {
    localJwtDecoded = jwt.verify(token, getJwtSecret()) as { sub?: string; email?: string; token_use?: string };
  } catch {
    localJwtDecoded = null;
  }

  if (localJwtDecoded?.sub) {
    const dbUser = await getUserById(localJwtDecoded.sub);
    if (dbUser) {
      if (dbUser.authProvider === 'firebase') {
        return res.status(401).json({ error: 'Firebase accounts must authenticate using a valid Firebase ID token.' });
      }
      if (dbUser.authProvider === 'demo' && !isDemoAllowed()) {
        return res.status(403).json({ error: 'Demo workspace sessions are disabled in production.' });
      }
      req.user = {
        id: dbUser.id,
        uid: dbUser.uid,
        email: dbUser.email,
        name: dbUser.name,
        institution: dbUser.institution,
        role: dbUser.role,
        authProvider: dbUser.authProvider,
        consentAnalytics: dbUser.consentAnalytics,
        consentRetention: dbUser.consentRetention,
      };
      return next();
    }
  }

  // 2. Verify live Firebase ID token via firebase-admin
  try {
    const checkRevoked = process.env.FIREBASE_CHECK_REVOKED === 'true';
    const rawDecoded = await adminAuth.verifyIdToken(token, checkRevoked);
    const claims = validateFirebaseDecodedClaims(rawDecoded);
    if (!claims) {
      return res.status(401).json({ error: 'Invalid Firebase token claims.' });
    }
    const dbUser = await getOrCreateFirebaseUser(claims.uid, claims.email || '', claims.name);
    req.user = {
      id: dbUser.id,
      uid: dbUser.uid,
      email: dbUser.email,
      name: dbUser.name,
      institution: dbUser.institution,
      role: dbUser.role,
      authProvider: dbUser.authProvider,
      consentAnalytics: dbUser.consentAnalytics,
      consentRetention: dbUser.consentRetention,
    };
    return next();
  } catch (error) {
    console.error('Error verifying authentication token:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired authentication token.' });
  }
};
