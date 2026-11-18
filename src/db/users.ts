import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export async function getOrCreateFirebaseUser(uid: string, email: string, name?: string) {
  try {
    const cleanEmail = (email || `${uid}@firebase.local`).toLowerCase();
    const displayName = (name || cleanEmail.split('@')[0] || 'Researcher').trim();
    const existingByEmail = await db
      .select()
      .from(users)
      .where(eq(users.email, cleanEmail))
      .limit(1);

    if (existingByEmail.length > 0 && existingByEmail[0].uid !== uid) {
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
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: cleanEmail,
          name: displayName,
          authProvider: 'firebase',
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database query failed in getOrCreateFirebaseUser:', error);
    throw new Error('Failed to synchronize researcher profile.', { cause: error });
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
