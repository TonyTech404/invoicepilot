import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '../../shared/types';
import { api } from './lib/api';

interface SessionState {
  session: Session | null;
  update: (patch: Partial<Pick<Session, 'myob_mode' | 'idempotency_guard'>>) => Promise<void>;
  reset: () => Promise<void>;
  /** Bumped whenever the workspace changes, so pages refetch. */
  version: number;
}

const Ctx = createContext<SessionState | null>(null);

// A first visit creates the workspace, so it must be requested exactly once,
// even when React runs effects twice in development.
let first: Promise<Session> | null = null;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    first ??= api<Session>('/session');
    first.then(setSession).catch(() => setSession(null));
  }, []);

  const update = useCallback(async (patch: Partial<Pick<Session, 'myob_mode' | 'idempotency_guard'>>) => {
    setSession(await api<Session>('/settings', { method: 'PUT', json: patch }));
  }, []);

  const reset = useCallback(async () => {
    setSession(await api<Session>('/reset', { method: 'POST' }));
    setVersion((v) => v + 1);
  }, []);

  return <Ctx.Provider value={{ session, update, reset, version }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
