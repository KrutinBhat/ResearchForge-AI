import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export async function getOrCreateFirebaseUser(uid: string, email: string, name?: string) {
  try {
    const cleanEmail = (email || `${uid}@firebase.local`).toLowerCase().trim();
    const displayName = (name || cleanEmail.split('@')[0] || 'Researcher').trim();

    const existingByUid = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (existingByUid.length > 0) {
      if (existingByUid[0].authProvider === 'demo') {
        throw new Error('Cannot link Firebase credentials to isolated demo workspace.');
      }
      if (existingByUid[0].email !== cleanEmail || existingByUid[0].name !== displayName) {
        const updated = await db
          .update(users)
          .set({ email: cleanEmail, name: displayName, authProvider: 'firebase' })
          .where(eq(users.id, existingByUid[0].id))
          .returning();
        return updated[0];
      }
      return existingByUid[0];
    }

    const existingByEmail = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    if (existingByEmail.length > 0) {
      if (existingByEmail[0].authProvider === 'demo') {
        throw new Error('Cannot link Firebase credentials to isolated demo workspace.');
      }
      const updated = await db
        .update(users)
        .set({ uid, authProvider: 'firebase' })
        .where(eq(users.id, existingByEmail[0].id))
        .returning();
      return updated[0];
    }

    const result = await db
      .insert(users)
      .values({
        id: newId('usr'),
        uid,
        email: cleanEmail,
        name: displayName,
        institution: '',
        role: 'Researcher',
        passwordHash: '',
        authProvider: 'firebase',
        consentAnalytics: false,
        consentRetention: true,
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database query failed in getOrCreateFirebaseUser:', error);
    throw error instanceof Error ? error : new Error('Failed to synchronize researcher profile.');
  }
}

export async function getUserById(id: string) {
  try {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database query failed in getUserById:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}
