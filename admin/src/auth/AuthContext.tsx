import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { api, ApiError, login as apiLogin, tokens } from "../api/client";
import type { Membership, User } from "../types";

interface AuthState {
  user: User | null;
  memberships: Membership[];
  activeOrg: string | null;
  platformAdmin: boolean;
  loading: boolean;
  sessionError: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  acceptSession: (access: string, refresh: string) => Promise<void>;
  switchOrg: (orgId: string) => void;
  reload: () => Promise<void>;
}

const ORG_KEY = "sg.org";

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const authEpoch = useRef(0);
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrg, setActiveOrg] = useState<string | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    const epoch = ++authEpoch.current;
    setSessionError(null);
    if (!tokens.access) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const me = await api.get<{
        user: User;
        memberships: Membership[];
        platform_admin?: boolean;
      }>("/api/me");
      if (epoch !== authEpoch.current) return;
      setUser(me.user);
      setMemberships(me.memberships);
      const stored = localStorage.getItem(ORG_KEY);
      const valid = me.memberships.find((m) => m.org_id === stored);
      setActiveOrg(valid?.org_id ?? me.memberships[0]?.org_id ?? null);
      setPlatformAdmin(!!me.platform_admin);
    } catch (error) {
      if (epoch === authEpoch.current) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          tokens.clear();
          queryClient.clear();
          setUser(null);
          setMemberships([]);
          setActiveOrg(null);
          setPlatformAdmin(false);
        } else {
          // Keep the session and in-memory drafts, but App blocks protected
          // routes until /api/me succeeds again. Never confuse downtime with
          // revoked credentials or silently replay the user's write operations.
          setSessionError("Die Verbindung zu FireFlint ist gerade nicht verfügbar. Bitte versuche es erneut.");
        }
      }
    } finally {
      if (epoch === authEpoch.current) setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      queryClient.clear();
      await apiLogin(email, password);
      setLoading(true);
      await loadMe();
    },
    [loadMe, queryClient],
  );

  const acceptSession = useCallback(async (access: string, refresh: string) => {
    queryClient.clear();
    tokens.set(access, refresh);
    setLoading(true);
    await loadMe();
    if (!tokens.access) throw new Error("Die Sitzung konnte nicht geladen werden. Bitte melde dich erneut an.");
  }, [loadMe, queryClient]);

  const logout = useCallback(() => {
    authEpoch.current += 1;
    setSessionError(null);
    queryClient.clear();
    tokens.clear();
    localStorage.removeItem(ORG_KEY);
    setUser(null);
    setMemberships([]);
    setActiveOrg(null);
    setPlatformAdmin(false);
  }, [queryClient]);

  const switchOrg = useCallback((orgId: string) => {
    queryClient.clear();
    localStorage.setItem(ORG_KEY, orgId);
    setActiveOrg(orgId);
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, memberships, activeOrg, platformAdmin, loading, sessionError, login, logout, acceptSession, switchOrg, reload: loadMe }),
    [user, memberships, activeOrg, platformAdmin, loading, sessionError, login, logout, acceptSession, switchOrg, loadMe],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** The active org id, asserted present (use inside authed routes). */
export function useOrg(): string {
  const { activeOrg } = useAuth();
  if (!activeOrg) throw new Error("no active org");
  return activeOrg;
}
