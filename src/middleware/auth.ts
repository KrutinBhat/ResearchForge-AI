import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
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

function getJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && (!envSecret || envSecret.includes('change-me') || envSecret.includes('replace-with'))) {
    throw new Error('JWT_SECRET must be securely configured in production.');
  }
  return envSecret || 'researchforge-dev-ephemeral-secret';
}

export function signSessionToken(payload: { sub: string; email: string }): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
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

  // 1. Try local HS256 researcher JWT first if signed by this app
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as { sub?: string; email?: string };
    if (decoded?.sub) {
      const dbUser = await getUserById(decoded.sub);
      if (dbUser) {
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
  } catch {
    // Fall through to Firebase ID Token verification
  }

  // 2. Verify Firebase ID token via firebase-admin
  try {
    const decodedFirebase = await adminAuth.verifyIdToken(token);
    const dbUser = await getOrCreateFirebaseUser(
      decodedFirebase.uid,
      decodedFirebase.email || '',
      decodedFirebase.name || undefined
    );
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
