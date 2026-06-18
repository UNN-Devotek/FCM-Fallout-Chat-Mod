import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

export interface AuthUser {
  id: string;
  username: string;
  discordDisplayName?: string;
  role: string;
  avatar?: string;
  fo76Name?: string;    // FO76 in-game name if linked
  avatarUrl?: string;   // Pre-built Discord CDN URL from backend
}

// Roles that are allowed to use the "view as role" switcher. Only real
// owners/admins may preview the site as a lower role.
const IMPERSONATOR_ROLES = ['owner', 'admin'];
const VIEW_AS_STORAGE_KEY = 'fo76.viewAsRole';

interface AuthContextValue {
  /** Effective user — role is overridden while impersonating. Everything that
   *  gates on `user.role` (route guards, nav, per-page isAdmin checks) reads
   *  this, so flipping `viewAsRole` re-skins the whole app instantly. */
  user: AuthUser | null;
  /** The actual signed-in user, never overridden. */
  realUser: AuthUser | null;
  realRole: string | null;
  /** Non-null only while previewing as another role. */
  viewAsRole: string | null;
  setViewAsRole: (role: string | null) => void;
  /** True when the real user is an owner/admin and may use the switcher. */
  canImpersonate: boolean;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [realUser, setRealUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAsRole, setViewAsRoleState] = useState<string | null>(() => {
    try { return sessionStorage.getItem(VIEW_AS_STORAGE_KEY); } catch { return null; }
  });

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetch('/auth/me', { credentials: 'include', signal: ctrl.signal })
      .then((r) => r.json())
      .then(({ data }) => { if (!cancelled) setRealUser(data); })
      .catch(() => { if (!cancelled) setRealUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  const canImpersonate = !!realUser && IMPERSONATOR_ROLES.includes(realUser.role);

  // If the real user isn't allowed to impersonate (or logged out), drop any
  // stale override so a non-privileged session can never inherit one.
  useEffect(() => {
    if (!loading && !canImpersonate && viewAsRole) {
      setViewAsRoleState(null);
      try { sessionStorage.removeItem(VIEW_AS_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [loading, canImpersonate, viewAsRole]);

  const setViewAsRole = useCallback((role: string | null) => {
    setViewAsRoleState(role);
    try {
      if (role) sessionStorage.setItem(VIEW_AS_STORAGE_KEY, role);
      else sessionStorage.removeItem(VIEW_AS_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  const login = useCallback(() => {
    window.location.href = '/auth/discord';
  }, []);

  const logout = useCallback(async () => {
    await fetch('/auth/logout');
    setViewAsRole(null);
    setRealUser(null);
  }, [setViewAsRole]);

  const user = useMemo<AuthUser | null>(() => {
    if (!realUser) return null;
    if (canImpersonate && viewAsRole) return { ...realUser, role: viewAsRole };
    return realUser;
  }, [realUser, canImpersonate, viewAsRole]);

  return (
    <AuthContext.Provider
      value={{
        user,
        realUser,
        realRole: realUser?.role ?? null,
        viewAsRole: canImpersonate ? viewAsRole : null,
        setViewAsRole,
        canImpersonate,
        loading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
