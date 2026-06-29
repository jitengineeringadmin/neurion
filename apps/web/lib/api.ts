export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8091';

let accessToken: string | null = null;

export function setToken(token: string | null): void {
  accessToken = token;
  if (typeof window !== 'undefined') {
    if (token) localStorage.setItem('neurion_token', token);
    else localStorage.removeItem('neurion_token');
  }
}

export function getToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window !== 'undefined') accessToken = localStorage.getItem('neurion_token');
  return accessToken;
}

async function refresh(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!res.ok) return false;
  const data = (await res.json()) as { accessToken: string };
  setToken(data.accessToken);
  return true;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
  });
  if (res.status === 401 && retry && (await refresh())) return api<T>(path, init, false);
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return (text ? JSON.parse(text) : {}) as T;
}

// Unauthenticated GET for public endpoints (no Bearer, no refresh) — used by the
// public landing-adjacent pages (network dashboard, etc.).
export async function publicApi<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, { headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface SseHandlers {
  onEvent: (event: string, data: any) => void;
}

export async function streamSSE(path: string, body: unknown, handlers: SseHandlers): Promise<void> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('no stream body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data) {
        try {
          handlers.onEvent(event, JSON.parse(data));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const streamChat = (body: unknown, handlers: SseHandlers) => streamSSE('/chat/stream', body, handlers);
export const streamAgent = (goal: string, handlers: SseHandlers, model?: string, cwd?: string) =>
  streamSSE('/agent/stream', { goal, model, cwd }, handlers);
