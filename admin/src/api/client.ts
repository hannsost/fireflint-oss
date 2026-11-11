// Typed-ish fetch client with token storage and one-shot refresh (WP1.7).
//
// Tokens live in localStorage. On a 401 the client tries the refresh token
// once. Only an explicitly rejected refresh clears the session; temporary
// network/server failures preserve credentials for an explicit retry.

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8090" : "");
// Cluster-view BFF (separate read-only service; keeps the core kube-free).
// Defaults to :8091 so it does not collide with the core on :8090.
const BFF_URL = (import.meta.env.VITE_BFF_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8091" : "");

const ACCESS_KEY = "sg.access";
const REFRESH_KEY = "sg.refresh";

let sessionVersion = 0;

export const tokens = {
  get version() { return sessionVersion; },
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh?: string) {
    sessionVersion += 1;
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    sessionVersion += 1;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function rawRequest(path: string, init: RequestInit, base = API_URL): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(tokens.access ? { authorization: `Bearer ${tokens.access}` } : {}),
      ...(init.headers || {}),
    },
  });
}

let refreshInFlight: Promise<boolean> | null = null;

async function rotateSession(): Promise<boolean> {
  const version = tokens.version;
  const refresh = tokens.refresh;
  if (!refresh) return false;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new ApiError(res.status, "Die Sitzung konnte vorübergehend nicht geprüft werden.");
  const body = await res.json() as { access_token?: string; refresh_token?: string };
  if (version !== tokens.version || refresh !== tokens.refresh) return false;
  if (typeof body.access_token !== "string" || !body.access_token) return false;
  // Rotating an access token stays within the same authenticated session.
  localStorage.setItem(ACCESS_KEY, body.access_token);
  if (typeof body.refresh_token === "string" && body.refresh_token)
    localStorage.setItem(REFRESH_KEY, body.refresh_token);
  return true;
}

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = rotateSession().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error || res.statusText);
  }
  return body as T;
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  base = API_URL,
): Promise<T> {
  const version = tokens.version;
  const access = tokens.access;
  const sameSession = () => version === tokens.version;
  let res = await rawRequest(path, init, base);
  if (res.status === 401 && tokens.refresh && sameSession()) {
    // Another tab may already have rotated the shared localStorage session.
    // Retry with that access token instead of spending its fresh refresh token.
    if (access !== tokens.access) {
      res = await rawRequest(path, init, base);
    } else if (await tryRefresh()) {
      if (!sameSession()) return parse<T>(res);
      res = await rawRequest(path, init, base);
    } else if (sameSession()) {
      tokens.clear();
    }
  }
  return parse<T>(res);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// Cluster-view BFF (read-only). Same token + refresh, different origin.
export const bff = {
  get: <T>(path: string) => request<T>(path, {}, BFF_URL),
};

/// Resolve an asset path to an absolute URL (relative `/assets/..` -> API base).
export function assetUrl(path: string): string {
  if (!path) return "";
  if (/^https?:\/\//.test(path) || path.startsWith("data:")) return path;
  return `${API_URL}${path}`;
}

/// Multipart upload (sets no content-type so the browser adds the boundary).
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: tokens.access ? { authorization: `Bearer ${tokens.access}` } : {},
      body: form,
    });
  const version = tokens.version;
  const access = tokens.access;
  const sameSession = () => version === tokens.version;
  let res = await send();
  if (res.status === 401 && tokens.refresh && sameSession()) {
    if (access !== tokens.access) res = await send();
    else if (await tryRefresh()) { if (sameSession()) res = await send(); }
    else if (sameSession()) tokens.clear();
  }
  return parse<T>(res);
}

// Login is special: it sets tokens and is not itself authorized.
export async function login(email: string, password: string) {
  const version = tokens.version;
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await parse<{ access_token: string; refresh_token: string; user: unknown }>(res);
  if (version !== tokens.version) throw new Error("Die Sitzung wurde inzwischen gewechselt.");
  tokens.set(body.access_token, body.refresh_token);
  return body;
}
