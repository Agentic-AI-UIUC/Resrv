import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe, getAuthToken, login as apiLogin, setAuthToken } from "../api/client";

export type Role = "admin" | "staff";

type AuthState = {
  username: string | null;
  role: Role | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then((me) => {
        setUsername(me.username);
        setRole(me.role);
      })
      .catch(() => setAuthToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(u: string, p: string) {
    const res = await apiLogin(u, p);
    setAuthToken(res.token);
    setUsername(res.username);
    setRole(res.role);
  }

  function logout() {
    setAuthToken(null);
    setUsername(null);
    setRole(null);
  }

  return (
    <AuthCtx.Provider value={{ username, role, loading, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
