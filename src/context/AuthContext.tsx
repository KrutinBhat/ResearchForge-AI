import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase';
import { apiFetch, getAuthToken, setAuthToken } from '../lib/api';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  institution: string;
  role: string;
  consentAnalytics: boolean;
  consentRetention: boolean;
}

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { name: string; email: string; password: string; institution?: string; role?: string }) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  loginDemo: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const token = await getAuthToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch<{ user: UserProfile }>('/api/auth/me');
      setUser(data.user);
    } catch {
      setAuthToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const idToken = await fbUser.getIdToken();
          setAuthToken(idToken, true);
          const data = await apiFetch<{ user: UserProfile }>('/api/auth/firebase', {
            method: 'POST',
            body: JSON.stringify({ idToken }),
          });
          setUser(data.user);
        } catch {
          setAuthToken(null);
          setUser(null);
        } finally {
          setLoading(false);
        }
      } else {
        await refreshUser();
      }
    });
    return () => unsub();
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const data = await apiFetch<{ token: string; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setAuthToken(data.token, false);
    setUser(data.user);
  };

  const register = async (payload: { name: string; email: string; password: string; institution?: string; role?: string }) => {
    const data = await apiFetch<{ token: string; user: UserProfile }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setAuthToken(data.token, false);
    setUser(data.user);
  };

  const loginWithGoogle = async () => {
    const cred = await signInWithPopup(auth, googleAuthProvider);
    const idToken = await cred.user.getIdToken();
    setAuthToken(idToken, true);
    const data = await apiFetch<{ user: UserProfile }>('/api/auth/firebase', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    setUser(data.user);
  };

  const loginDemo = async () => {
    const data = await apiFetch<{ token: string; user: UserProfile }>('/api/auth/demo', {
      method: 'POST',
    });
    setAuthToken(data.token, false);
    setUser(data.user);
  };

  const logout = async () => {
    setAuthToken(null);
    setUser(null);
    try {
      if (auth.currentUser) {
        await signOut(auth);
      }
    } catch {
      // ignore firebase signout error
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, loginWithGoogle, loginDemo, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
