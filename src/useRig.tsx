import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { currentSession, login as doLogin, logout as doLogout, type Session } from "./auth";
import { SafetyEngine, type OperationKind } from "./engine";
import { Simulator, type SimMode } from "./simulator";
import type { ChannelId, Reading } from "./types";

const TICK_MS = 1000;

interface RigContextValue {
  ready: boolean;
  engine: SafetyEngine;
  simulator: Simulator;
  session: Session | null;
  login: (u: string, p: string) => boolean;
  logout: () => void;
  /** 动作后统一刷帧 */
  act: <T>(p: Promise<T>) => Promise<T>;
  attemptOp: (op: OperationKind) => Promise<{ ok: boolean; detail?: string }>;
  setMode: (id: ChannelId, mode: SimMode) => void;
  injectReading: (id: ChannelId, r: Reading, rounds?: number) => void;
  modes: Record<ChannelId, SimMode>;
  now: number;
}

const RigContext = createContext<RigContextValue | null>(null);

export function RigProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<SafetyEngine | null>(null);
  const simulatorRef = useRef<Simulator | null>(null);
  const initRef = useRef<Promise<SafetyEngine> | null>(null);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(() => currentSession());
  const [modes, setModes] = useState<Record<ChannelId, SimMode>>({
    wind: "normal", tilt: "normal", load: "normal", gas: "normal",
  });
  const [now, setNow] = useState(() => Date.now());

  if (!initRef.current) {
    const simulator = new Simulator();
    simulatorRef.current = simulator;
    // promise 缓存：StrictMode 双渲染只创建一个引擎（事件流只追加一次）
    initRef.current = SafetyEngine.create(simulator).then((engine) => {
      engineRef.current = engine;
      return engine;
    });
    void initRef.current.then(() => setReady(true));
  }

  const bump = useCallback(() => setNow(Date.now()), []);

  useEffect(() => {
    if (!ready) return;
    const engine = engineRef.current!;
    const sim = simulatorRef.current!;
    const unsub = engine.subscribe(bump);
    const timer = setInterval(() => {
      const t = Date.now();
      void engine.ingest(sim.tick(t), t);
      setNow(t);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, [ready, bump]);

  const value = useMemo<RigContextValue | null>(() => {
    const engine = engineRef.current;
    const simulator = simulatorRef.current!;
    if (!engine) return null;
    const act = async <T,>(p: Promise<T>): Promise<T> => {
      const r = await p;
      bump();
      return r;
    };
    return {
      ready,
      engine,
      simulator,
      session,
      login: (u, p) => {
        const s = doLogin(u, p);
        if (s) {
          setSession(s);
          return true;
        }
        return false;
      },
      logout: () => {
        doLogout();
        setSession(null);
      },
      act,
      attemptOp: (op) => act(engine.attemptOperation(op)),
      setMode: (id, mode) => {
        simulator.setMode(id, mode);
        setModes({ ...simulatorExportModes(simulator) });
      },
      injectReading: (id, r, rounds) => {
        simulator.inject(id, r.v, r.fault, rounds ?? 1);
      },
      modes,
      now,
    };
  }, [ready, session, modes, now, bump]);

  if (!ready || !value) {
    return (
      <div className="boot">
        <div className="boot-card">
          <div className="boot-spinner" />
          <p>正在校验事件流与联锁状态…</p>
        </div>
      </div>
    );
  }

  return <RigContext.Provider value={value}>{children}</RigContext.Provider>;
}

function simulatorExportModes(sim: Simulator): Record<ChannelId, SimMode> {
  return {
    wind: sim.getMode("wind"),
    tilt: sim.getMode("tilt"),
    load: sim.getMode("load"),
    gas: sim.getMode("gas"),
  };
}

export function useRig(): RigContextValue {
  const ctx = useContext(RigContext);
  if (!ctx) throw new Error("useRig must be used inside RigProvider");
  return ctx;
}
