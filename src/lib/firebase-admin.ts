import fs from 'fs';
import { cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

function normalizeServiceAccount(parsed: any): ServiceAccount | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const copy: Record<string, any> = { ...parsed };
  if (typeof copy.private_key === 'string' && copy.private_key.includes('\\n')) {
    copy.private_key = copy.private_key.replace(/\\n/g, '\n');
  }
  if (typeof copy.privateKey === 'string' && copy.privateKey.includes('\\n')) {
    copy.privateKey = copy.privateKey.replace(/\\n/g, '\n');
  }
  return copy as ServiceAccount;
}

export function resolveServiceAccount(rawInput?: string): ServiceAccount | null {
  let raw = (rawInput ?? process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (!raw) return null;
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    const inner = raw.slice(1, -1).trim();
    if (inner) raw = inner;
  }
  try {
    if (raw.startsWith('{')) {
      return normalizeServiceAccount(JSON.parse(raw));
    }
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
      return normalizeServiceAccount(JSON.parse(fs.readFileSync(raw, 'utf8')));
    }
    const compact = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      return normalizeServiceAccount(JSON.parse(decoded));
    }
  } catch (err) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err);
  }
  return null;
}

if (!getApps().length) {
  const projectId = (process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId || '').trim();
  const sa = resolveServiceAccount();
  if (sa) {
    initializeApp({
      credential: cert(sa),
      ...(projectId ? { projectId } : {}),
    });
  } else {
    initializeApp({
      ...(projectId ? { projectId } : {}),
    });
  }
}

export const adminAuth = getAuth();

