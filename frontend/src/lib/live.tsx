import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get } from './api';
import { useAuth } from './auth';

export interface LiveEvent { id: number; at: string; kind: string; message: string }
interface LiveState { events: LiveEvent[]; tick: number; connected: boolean }
const Ctx = createContext<LiveState>({ events: [], tick: 0, connected: false });
export const useLive = () => useContext(Ctx);
/** Changes whenever new activity arrives (throttled) or every 20 s as a fallback; use as an effect/query dependency. */
export const useLiveTick = () => useContext(Ctx).tick;

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    if (!user) { setEvents([]); setConnected(false); return; }
    let es: EventSource | null = null;
    let alive = true;
    get('/api/live/recent').then((r) => alive && setEvents(r.data)).catch(() => {});
    const bump = () => { const n = Date.now(); if (n - last.current > 4000) { last.current = n; setTick((t) => t + 1); } };
    try {
      es = new EventSource('/api/live');
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as LiveEvent;
        setEvents((p) => [ev, ...p].slice(0, 30));
        bump();
      };
    } catch { /* EventSource unavailable: polling below keeps data fresh */ }
    const poll = setInterval(() => setTick((t) => t + 1), 20000);
    return () => { alive = false; es?.close(); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const value = useMemo(() => ({ events, tick, connected }), [events, tick, connected]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
