import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe, getAuthToken, login as apiLogin, setAuthToken } from "../api/client";

type AuthState = {
  username: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then((me) => setUsername(me.username))
      .catch(() => setAuthToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(u: string, p: string) {
    const res = await apiLogin(u, p);
    setAuthToken(res.token);
    setUsername(res.username);
  }

  function logout() {
    setAuthToken(null);
    setUsername(null);
  }

  return (
    <AuthCtx.Provider value={{ username, loading, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
