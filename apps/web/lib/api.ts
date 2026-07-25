export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8091";

// The production network API. In the desktop the app talks to a LOCAL embedded API
// (API_BASE = localhost), but its node pool is empty — community nodes live on the
// production API. The "network" lane relays to PROD_BASE: a separate prod session.
export const PROD_BASE = "https://neurionproject.org";
export const isDesktop = (): boolean =>
  typeof window !== "undefined" &&
  API_BASE !== PROD_BASE &&
  /localhost|127\.0\.0\.1/.test(API_BASE);

let prodToken: string | null = null;
export function getProdToken(): string | null {
  if (prodToken) return prodToken;
  if (typeof window !== "undefined")
    prodToken = localStorage.getItem("neurion_prod_token");
  return prodToken;
}
export function setProdToken(token: string | null): void {
  prodToken = token;
  if (typeof window !== "undefined") {
    if (token) localStorage.setItem("neurion_prod_token", token);
    else localStorage.removeItem("neurion_prod_token");
  }
}
/** Sign in to the production network (separate account from the local one). */
export async function prodLogin(
  email: string,
  password: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${PROD_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return false;
    setProdToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}
/** Authenticated call against the production API (used by the desktop network lane). */
export async function prodApi<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${PROD_BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getProdToken() ? { Authorization: `Bearer ${getProdToken()}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return (text ? JSON.parse(text) : {}) as T;
}

let accessToken: string | null = null;

export function setToken(token: string | null): void {
  accessToken = token;
  if (typeof window !== "undefined") {
    if (token) localStorage.setItem("neurion_token", token);
    else localStorage.removeItem("neurion_token");
  }
}

export function getToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window !== "undefined")
    accessToken = localStorage.getItem("neurion_token");
  return accessToken;
}

async function refresh(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { accessToken: string };
  setToken(data.accessToken);
  return true;
}

/**
 * Desktop: sign in as this machine's owner, with no login screen.
 *
 * Nothing local needs protecting from the person already sitting at the
 * computer, and an account only starts to mean something once other people are
 * involved — sharing the node, earning NRN, being paid. Those still go through
 * prodLogin() against the production network, which is a separate identity.
 *
 * Returns false on a hosted deployment, where the API refuses this outright.
 */
export async function localOwnerSession(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/local-session`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return false;
    setToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

/** A usable session, obtained without prompting when this is the desktop app. */
export async function ensureSession(): Promise<boolean> {
  if (getToken()) return true;
  if (await refresh()) return true;
  return localOwnerSession();
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(init.headers ?? {}),
    },
    credentials: "include",
  });
  if (res.status === 401 && retry && (await refresh()))
    return api<T>(path, init, false);
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return (text ? JSON.parse(text) : {}) as T;
}

// Unauthenticated GET for public endpoints (no Bearer, no refresh) — used by the
// public landing-adjacent pages (network dashboard, etc.).
export async function publicApi<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface SseHandlers {
  onEvent: (event: string, data: any) => void;
}

export async function streamSSE(
  path: string,
  body: unknown,
  handlers: SseHandlers,
): Promise<void> {
  const request = () =>
    fetch(`${API_BASE}/api${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      credentials: "include",
      body: JSON.stringify(body),
    });
  let res = await request();
  if (res.status === 401 && (await refresh())) res = await request();
  if (!res.ok) {
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as {
        message?: string | string[];
        error?: string;
      };
      const message = Array.isArray(parsed.message)
        ? parsed.message.join(", ")
        : parsed.message;
      throw new Error(message || parsed.error || `HTTP ${res.status}`);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(raw || `HTTP ${res.status}`);
      throw error;
    }
  }
  if (!res.body) throw new Error("no stream body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
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

export const streamChat = (body: unknown, handlers: SseHandlers) =>
  streamSSE("/chat/stream", body, handlers);
export const streamAgent = (
  goal: string,
  handlers: SseHandlers,
  model?: string,
  cwd?: string,
  extra?: {
    computeMode?: string;
    networkModel?: string;
    relayBase?: string;
    relayToken?: string;
    confineToCwd?: boolean;
    autoApprove?: boolean;
    parentRunId?: string;
  },
) => streamSSE("/agent/stream", { goal, model, cwd, ...extra }, handlers);

export const startAgent = (
  goal: string,
  model?: string,
  cwd?: string,
  extra?: {
    computeMode?: string;
    networkModel?: string;
    relayBase?: string;
    relayToken?: string;
    confineToCwd?: boolean;
    autoApprove?: boolean;
    parentRunId?: string;
  },
) =>
  api<{ runId: string; status: string; reused?: boolean }>("/agent/runs", {
    method: "POST",
    body: JSON.stringify({ goal, model, cwd, ...extra }),
  });
