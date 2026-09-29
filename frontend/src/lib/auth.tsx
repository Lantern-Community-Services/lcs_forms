import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, API_BASE, setSessionLostHandler } from "./api";
import type { PermissionKey, User } from "./types";

/** Holding any of these puts Admin in the navigation. */
export const ADMIN_AREA: PermissionKey[] = [
  "forms.manage", "apps.develop", "sites.manage", "sites.manageRules", "users.manage", "users.manageSite", "integrations.manage", "settings.manage",
];

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * Does the signed-in person's role grant this? Used to hide controls that
   * would only 403. The API enforces the same permission independently — this
   * is about not showing dead buttons, never about security.
   */
  can: (permission: PermissionKey) => boolean;
  /** Leave the SPA and start the Microsoft Entra ID sign-in flow. */
  signInWithMicrosoft: (returnTo?: string, opts?: SignInOptions) => void;
  /** Local prototype only: sign in as a seeded demo account. */
  devSignIn: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface SignInOptions {
  /**
   * Force Microsoft's account picker. Off by default so anyone already signed
   * into Microsoft 365 in this browser goes straight through.
   */
  selectAccount?: boolean;
  /**
   * Whether the session should outlive the browser — the phone sign-in
   * screen's "stay signed in on this phone".
   *
   * Undefined means "don't say", which the backend reads as yes, so the
   * desktop screen (which offers no such choice) keeps the behaviour it had.
   */
  staySignedIn?: boolean;
}

/**
 * Sign-in is Microsoft Entra ID only — there is no password to collect, so
 * there is no login form to submit. The browser navigates to the backend,
 * which redirects to Microsoft and, once the round trip completes, sets the
 * session cookie and sends the browser back into the app.
 */
export function signInWithMicrosoft(returnTo?: string, opts: SignInOptions = {}) {
  const here = `${window.location.pathname}${window.location.search}`;
  const target = returnTo ?? (here.startsWith("/signin") ? "/" : here);
  const params = new URLSearchParams({ returnTo: target });
  if (opts.selectAccount) params.set("prompt", "select_account");
  // Only sent when it is false: the parameter's whole job is to opt out of a
  // persistent session, and the default is already yes.
  if (opts.staySignedIn === false) params.set("stay", "0");
  window.location.href = `${API_BASE}/auth/microsoft?${params}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  /**
   * When any request comes back 401, the session is gone — drop the user so the
   * router's Protected gate sends them to sign in, carrying where they were so
   * they land back on it afterwards.
   *
   * Guarded against repeating: a screen firing six queries produces six 401s,
   * and each must not queue its own redirect.
   */
  const handlingSessionLoss = useRef(false);
  useEffect(() => {
    setSessionLostHandler(() => {
      if (handlingSessionLoss.current) return;
      handlingSessionLoss.current = true;
      setUser(null);
      setLoading(false);
      // Let the render that follows do the navigating, then allow it again so a
      // later sign-in in the same tab still works.
      setTimeout(() => {
        handlingSessionLoss.current = false;
      }, 2000);
    });
    return () => setSessionLostHandler(null);
  }, []);

  async function devSignIn(userId: string) {
    await api.post("/auth/dev-login", { userId });
    await refresh();
  }

  async function logout() {
    await api.post("/auth/logout");
    setUser(null);
  }

  const can = (permission: PermissionKey) => (user?.permissions ?? []).includes(permission);

  return (
    <AuthContext.Provider value={{ user, loading, can, signInWithMicrosoft, devSignIn, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
