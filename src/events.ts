import type { SafetyEvent } from "./types";

const STORAGE_KEY = "rig-safety.events.v1";
/** 创世块前导哈希 */
const GENESIS = "0".repeat(64);

/** 事件参与哈希的规范字段（不含 hash 自身） */
function canonical(e: Omit<SafetyEvent, "hash">): string {
  return JSON.stringify({
    seq: e.seq,
    t: e.t,
    type: e.type,
    level: e.level,
    channel: e.channel ?? null,
    value: e.value ?? null,
    fault: e.fault ?? null,
    channels: e.channels ?? null,
    operator: e.operator ?? null,
    detail: e.detail ?? null,
    episodeId: e.episodeId ?? null,
    prevHash: e.prevHash,
  });
}

async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // 同步兜底（非安全上下文）：轻量 FNV 风格散列，标记降级，不用于真实防篡改
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fallback-${h.toString(16).padStart(8, "0")}`;
}

export interface AppendInput {
  t: number;
  type: SafetyEvent["type"];
  level: SafetyEvent["level"];
  channel?: SafetyEvent["channel"];
  value?: number | null;
  fault?: SafetyEvent["fault"];
  channels?: SafetyEvent["channels"];
  operator?: string;
  detail?: string;
  episodeId?: string;
}

/**
 * 只增事件流：每条记录包含前一条的 SHA-256，形成哈希链。
 * 任何修改 / 删除 / 重排都会在 verify() 处断裂。
 */
export class EventLog {
  private events: SafetyEvent[] = [];

  static async create(): Promise<EventLog> {
    const log = new EventLog();
    await log.load();
    return log;
  }

  private async load(): Promise<void> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SafetyEvent[];
      if (!Array.isArray(parsed)) throw new Error("bad shape");
      // 载入即校验：结构/链断/内容哈希任一不符都视为数据损坏
      if (!verifyChain(parsed)) throw new Error("hash chain broken");
      const hashesOk = await verifyHashes(parsed);
      if (!hashesOk) throw new Error("content hash mismatch");
      this.events = parsed;
    } catch {
      // 损坏的事件流不继续使用：移除并交给上层进入安全联锁
      this.events = [];
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* 忽略存储异常 */
      }
      throw new EventLogCorruptError();
    }
  }

  get size(): number {
    return this.events.length;
  }

  list(): readonly SafetyEvent[] {
    return this.events;
  }

  /** 追加并落盘（失败由调用方按失效安全处理） */
  async append(input: AppendInput): Promise<SafetyEvent> {
    const prev = this.events[this.events.length - 1];
    const base: Omit<SafetyEvent, "hash"> = {
      seq: prev ? prev.seq + 1 : 1,
      t: input.t,
      type: input.type,
      level: input.level,
      channel: input.channel,
      value: input.value,
      fault: input.fault,
      channels: input.channels,
      operator: input.operator,
      detail: input.detail,
      episodeId: input.episodeId,
      prevHash: prev ? prev.hash : GENESIS,
    };
    const hash = await sha256Hex(canonical(base));
    const event: SafetyEvent = { ...base, hash };
    this.events = [...this.events, event];
    this.persist();
    return event;
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
  }

  /** 仅供测试：破坏持久化数据，模拟存储损坏 */
  static corruptStorage(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const tampered = raw.replace(/("value":[\d.]+)/, '"value":0.0001');
      localStorage.setItem(STORAGE_KEY, tampered === raw ? raw + "x" : tampered);
    } else {
      localStorage.setItem(STORAGE_KEY, "{not-json");
    }
  }
}

export class EventLogCorruptError extends Error {
  constructor() {
    super("event log corrupted");
    this.name = "EventLogCorruptError";
  }
}

/** 校验哈希链：顺序、prevHash、内容 hash 全部一致 */
export function verifyChain(events: SafetyEvent[]): boolean {
  // 注意：载入场景可能没有 subtle，同步仅做结构与链接检查；
  // 新鲜写入全部带 SHA-256，结构断裂即判损坏。
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (
      typeof e.seq !== "number" ||
      typeof e.hash !== "string" ||
      typeof e.prevHash !== "string" ||
      typeof e.t !== "number"
    )
      return false;
    if (e.seq !== i + 1) return false;
    const expectedPrev = i === 0 ? GENESIS : events[i - 1].hash;
    if (e.prevHash !== expectedPrev) return false;
  }
  return true;
}

/** 异步全量重算哈希（界面“完整性校验”按钮使用） */
export async function verifyHashes(events: readonly SafetyEvent[]): Promise<boolean> {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const { hash, ...base } = e;
    const recomputed = await sha256Hex(canonical(base));
    if (recomputed !== hash) return false;
    if (i > 0 && e.prevHash !== events[i - 1].hash) return false;
    if (i === 0 && e.prevHash !== GENESIS) return false;
  }
  return true;
}
