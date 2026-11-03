import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post, setCsrf } from './api';

export interface User {
  id: number; username: string; fullName: string; email: string; role: string; roleName: string;
  staffId: number | null; departmentId: number | null; permissions: string[];
}
interface LabInfo { mode: 'secure' | 'vulnerable'; banner: string }
interface AuthState {
  user: User | null; lab: LabInfo; loading: boolean; backendDown: boolean;
  login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; refresh: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const DEFAULT_LAB: LabInfo = { mode: 'secure', banner: 'ACADEMIC SECURITY LAB — SYNTHETIC DATA ONLY — NOT FOR CLINICAL USE' };
const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [lab, setLab] = useState<LabInfo>(DEFAULT_LAB);
  const [loading, setLoading] = useState(true);
  const [backendDown, setBackendDown] = useState(false);

  const apply = (s: any) => { setCsrf(s.csrfToken); setUser(s.authenticated ? s.user : null); if (s.lab) setLab(s.lab); };
  const refresh = useCallback(async () => {
    try { apply(await get('/api/auth/session')); setBackendDown(false); } catch { setBackendDown(true); }
    setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<AuthState>(() => ({
    user, lab, loading, backendDown, refresh,
    login: async (username, password) => {
      const r = await post('/api/auth/login', { username, password });
      setCsrf(r.csrfToken); setUser(r.user);
    },
    logout: async () => { await post('/api/auth/logout'); await refresh(); },
    can: (...perms) => !!user && perms.some((p) => user.permissions.includes(p)),
  }), [user, lab, loading, backendDown, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('medicore-theme', next ? 'dark' : 'light'); } catch { /* storage may be unavailable */ }
    setDark(next);
  };
  return { dark, toggle };
}
