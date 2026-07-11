"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuthUser, OutletDto, TenantSummaryDto } from "@stello/shared";
import { api, hasToken, setToken } from "@/lib/api";

interface Session {
  user: AuthUser | null;
  outlets: OutletDto[];
  outlet: OutletDto | null;
  tenant: TenantSummaryDto | null;
  loading: boolean;
  setOutlet: (o: OutletDto | null) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used within <SessionProvider>");
  return c;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [outlets, setOutlets] = useState<OutletDto[]>([]);
  const [outlet, setOutlet] = useState<OutletDto | null>(null);
  const [tenant, setTenant] = useState<TenantSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [me, list, tenantSummary] = await Promise.all([api.me(), api.outlets(), api.getTenant()]);
      setUser(me);
      setOutlets(list);
      setOutlet((prev) => prev ?? (list.length === 1 ? list[0] : null));
      setTenant(tenantSummary);
    } catch {
      setToken(null);
      setUser(null);
      setOutlets([]);
      setOutlet(null);
      setTenant(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken()) void refresh();
    else setLoading(false);
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password);
      setToken(res.accessToken);
      setLoading(true);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setOutlets([]);
    setOutlet(null);
    setTenant(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, outlets, outlet, tenant, loading, setOutlet, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
