import { createContext, useContext, useEffect, useState } from 'react';
import { api, setToken, getToken } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const out = () => setUser(null);
    window.addEventListener('ss-logout', out);
    return () => window.removeEventListener('ss-logout', out);
  }, []);

  const start = (d) => {
    setToken(d.token);
    setUser(d.user);
  };

  const value = {
    user,
    loading,
    login: async (email, password) => start(await api('/auth/login', { method: 'POST', body: { email, password } })),
    register: async (name, email, password) => start(await api('/auth/register', { method: 'POST', body: { name, email, password } })),
    logout: () => {
      setToken(null);
      setUser(null);
    },
    updateProfile: async (patch) => setUser((await api('/auth/me', { method: 'PATCH', body: patch })).user),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
