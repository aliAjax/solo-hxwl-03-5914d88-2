import type { PersistState } from "./types";

const STATE_KEY = "rig-safety.state.v1";
export const STATE_VERSION = 1;

export class StateCorruptError extends Error {
  constructor() {
    super("persisted state corrupted");
    this.name = "StateCorruptError";
  }
}

/** 基础结构校验，挡住截断/手改/版本不符的数据 */
function validate(s: unknown): s is PersistState {
  if (!s || typeof s !== "object") return false;
  const p = s as Record<string, unknown>;
  if (p.version !== STATE_VERSION) return false;
  if (typeof p.updatedAt !== "number") return false;
  if (!isStringArray(p.warnChannels) || !isStringArray(p.faultChannels)) return false;
  if (p.openEpisode !== null && typeof p.openEpisode !== "object") return false;
  if (p.openEpisode) {
    const ep = p.openEpisode as Record<string, unknown>;
    if (typeof ep.id !== "string" || typeof ep.open !== "boolean") return false;
    if (!Array.isArray(ep.channels) || !Array.isArray(ep.activeChannels)) return false;
  }
  if (!p.lastReadings || typeof p.lastReadings !== "object") return false;
  return true;
}

function isStringArray(x: unknown): boolean {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

export function saveState(state: PersistState): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

/** 读取持久化状态；损坏 / 不可解析时抛出，由上层进入安全联锁 */
export function loadState(): PersistState | null {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STATE_KEY);
    throw new StateCorruptError();
  }
  if (!validate(parsed)) {
    localStorage.removeItem(STATE_KEY);
    throw new StateCorruptError();
  }
  return parsed;
}

export function clearState(): void {
  localStorage.removeItem(STATE_KEY);
}

/** 仅供测试：写入截断/垃圾数据模拟状态损坏 */
export function corruptStateStorage(): void {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw && raw.length > 40) {
    localStorage.setItem(STATE_KEY, raw.slice(0, Math.floor(raw.length / 2)));
  } else {
    localStorage.setItem(STATE_KEY, "{broken");
  }
}
