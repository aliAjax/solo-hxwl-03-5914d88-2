import type { SafetyEvent } from "./types";

const STORAGE_KEY = "rig-safety.events.v1";
/** 链尾锚点：独立于事件流保存“最后一条”的序号与哈希，用于发现末尾记录缺失 */
const ANCHOR_KEY = "rig-safety.events.anchor.v1";
/** 已检测到的完整性破坏标记（负责人复位前持续保留，跨刷新） */
const TAMPER_KEY = "rig-safety.events.tamper.v1";
/** 创世块前导哈希 */
const GENESIS = "0".repeat(64);

interface Anchor {
  seq: number;
  hash: string;
}
export interface TamperMark {
  reason: string;
  detectedAt: number;
}

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

function readAnchor(): Anchor | null {
  try {
    const raw = localStorage.getItem(ANCHOR_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Anchor;
    return typeof a?.seq === "number" && typeof a?.hash === "string" ? a : null;
  } catch {
    return null;
  }
}

function writeAnchor(events: SafetyEvent[]): void {
  const tail = events[events.length - 1];
  if (tail) localStorage.setItem(ANCHOR_KEY, JSON.stringify({ seq: tail.seq, hash: tail.hash }));
  else localStorage.removeItem(ANCHOR_KEY);
}

/** 记录完整性破坏（跨刷新保留，负责人复位后清除） */
function markTampered(reason: string): void {
  try {
    const mark: TamperMark = { reason, detectedAt: Date.now() };
    localStorage.setItem(TAMPER_KEY, JSON.stringify(mark));
  } catch {
    /* 存储不可用时忽略；本次启动仍会进入安全联锁 */
  }
}

export function readTamperMark(): TamperMark | null {
  try {
    const raw = localStorage.getItem(TAMPER_KEY);
    return raw ? (JSON.parse(raw) as TamperMark) : null;
  } catch {
    return null;
  }
}

export function clearTamperMark(): void {
  try {
    localStorage.removeItem(TAMPER_KEY);
  } catch {
    /* 忽略 */
  }
}

export class EventLogCorruptError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`event log corrupted: ${reason}`);
    this.name = "EventLogCorruptError";
    this.reason = reason;
  }
}

/**
 * 只增事件流：每条记录包含前一条的 SHA-256，形成哈希链；
 * 另有独立链尾锚点记录最后一条的序号与哈希。
 * - 修改 / 删除中间记录 → 哈希链断裂
 * - 删除末尾记录（链仍自洽）→ 链尾与锚点不一致
 * 任一不符都判损坏：隔离数据、置篡改标记，交由上层进入安全联锁。
 */
export class EventLog {
  private events: SafetyEvent[] = [];

  static async create(): Promise<EventLog> {
    const log = new EventLog();
    await log.load();
    return log;
  }

  private async load(): Promise<void> {
    const raw = localStorage.getItem(STORAGE_KEY);
    const anchor = readAnchor();
    if (raw === null) {
      // 空事件流却留有锚点/事件丢失，也算不一致
      if (anchor) this.quarantine("事件流数据丢失，链尾锚点仍存在");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine("事件流数据无法解析");
      throw new EventLogCorruptError("事件流数据无法解析");
    }
    if (!Array.isArray(parsed)) {
      this.quarantine("事件流结构损坏");
      throw new EventLogCorruptError("事件流结构损坏");
    }
    const events = parsed as SafetyEvent[];

    if (events.length === 0) {
      if (anchor) {
        this.quarantine("事件流末尾记录缺失（记录总数与锚点不一致）");
        throw new EventLogCorruptError("事件流末尾记录缺失（记录总数与锚点不一致）");
      }
      return;
    }

    // 结构/链断/内容哈希
    if (!verifyChain(events)) {
      this.quarantine("事件流哈希链断裂（记录被删除、重排或改写）");
      throw new EventLogCorruptError("事件流哈希链断裂（记录被删除、重排或改写）");
    }
    if (!(await verifyHashes(events))) {
      this.quarantine("事件流记录内容与哈希不符（记录被篡改）");
      throw new EventLogCorruptError("事件流记录内容与哈希不符（记录被篡改）");
    }

    // 链尾锚点：总数与最后一条哈希必须一致 —— 末尾删除一条或多条都会在此暴露
    const tail = events[events.length - 1];
    if (!anchor) {
      this.quarantine("链尾锚点丢失，无法确认末尾记录完整");
      throw new EventLogCorruptError("链尾锚点丢失，无法确认末尾记录完整");
    }
    if (anchor.seq !== tail.seq || anchor.hash !== tail.hash) {
      const missing = anchor.seq - tail.seq;
      const reason =
        missing > 0
          ? `事件流末尾记录缺失：锚点 ${anchor.seq} 条，实际 ${tail.seq} 条，少 ${missing} 条`
          : "事件流链尾与锚点不一致（末尾记录被删除或替换）";
      this.quarantine(reason);
      throw new EventLogCorruptError(reason);
    }

    this.events = events;
  }

  /** 隔离损坏数据：保留标记、清空可用数据，后续追加从新链开始 */
  private quarantine(reason: string): void {
    this.events = [];
    markTampered(reason);
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ANCHOR_KEY);
    } catch {
      /* 忽略存储异常 */
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
    // 先写事件流，再写链尾锚点；任何中断只会导向更严格的安全联锁
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
    writeAnchor(this.events);
  }

  /** 仅供测试：改写一条记录内容（链仍自洽但内容哈希对不上） */
  static corruptStorage(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const tampered = raw.replace(/("value":[\d.]+)/, '"value":0.0001');
      localStorage.setItem(STORAGE_KEY, tampered === raw ? raw + "x" : tampered);
    } else {
      localStorage.setItem(STORAGE_KEY, "{not-json");
    }
  }

  /** 仅供测试：仅删除最后一条记录，锚点保持不动（模拟末尾丢失） */
  static truncateTailStorage(count = 1): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw) as SafetyEvent[];
    for (let i = 0; i < count && arr.length > 0; i++) arr.pop();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }
}

/** 校验哈希链：顺序、prevHash、内容 hash 全部一致 */
export function verifyChain(events: SafetyEvent[]): boolean {
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

/** 异步全量重算哈希（内容与链均重算） */
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

/**
 * 界面完整性校验：哈希链重算 + 链尾锚点一致 + 无未处置篡改标记。
 * 末尾记录缺失（剩余链仍自洽）也会在此报失败。
 */
export async function verifyLogIntegrity(events: readonly SafetyEvent[]): Promise<boolean> {
  if (readTamperMark()) return false;
  if (!(await verifyHashes(events))) return false;
  const anchor = readAnchor();
  if (events.length === 0) return anchor === null;
  const tail = events[events.length - 1];
  return !!anchor && anchor.seq === tail.seq && anchor.hash === tail.hash;
}
