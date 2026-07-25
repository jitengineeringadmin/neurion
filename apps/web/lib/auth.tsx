'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, setToken, isDesktop, prodLogin, setProdToken, localOwnerSession } from './api';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  workspaceId: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api<User>('/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        // Desktop: claim this machine's owner session rather than sending the
        // user to a login form. Nothing local is protected from whoever is
        // already signed into the computer, and an account only starts to
        // matter when the network is involved. The API refuses this on a hosted
        // deployment, where the redirect to /login still happens.
        const claimed = await localOwnerSession();
        if (cancelled) return;
        if (claimed) {
          try {
            setUser(await api<User>('/auth/me'));
          } catch {
            setUser(null);
          }
        } else {
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const res = await api<{ accessToken: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(res.accessToken);
    setUser(res.user);
    // Desktop: the same account also authenticates the production network, so establish
    // that session now (best-effort) — the network lanes (relay, image-on-nodes) then
    // work without a second "connect to the network" prompt.
    if (isDesktop()) void prodLogin(email, password).catch(() => undefined);
  }

  async function register(email: string, password: string, displayName?: string): Promise<void> {
    const res = await api<{ accessToken: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
    setToken(res.accessToken);
    setUser(res.user);
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    setProdToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
