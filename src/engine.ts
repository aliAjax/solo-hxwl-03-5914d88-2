import { CHANNELS, CHANNEL_ORDER, classify, isOutOfRange, thresholdReason } from "./channels";
import { clearTamperMark, EventLog, EventLogCorruptError, readTamperMark } from "./events";
import { clearState, loadState, saveState, StateCorruptError } from "./persistence";
import { Simulator } from "./simulator";
import {
  LEVEL,
  type ChannelId,
  type ChannelState,
  type Level,
  type LockEpisode,
  type PersistState,
  type Reading,
  type SafetyEvent,
} from "./types";

const STALE_TIMEOUT_MS = 5000;

let episodeSeq = 0;
function newEpisodeId(now: number, failSafe = false): string {
  episodeSeq += 1;
  return `${failSafe ? "FS" : "LK"}-${now.toString(36).toUpperCase()}-${episodeSeq}`;
}

export interface AuthResult {
  ok: boolean;
  detail?: string;
}

export type OperationKind = "hoist" | "rotate";

/**
 * 安全联锁核心：
 * - 每路独立三级评估，多风险并存取最高级、不互相覆盖
 * - 联锁回合：触发(可多路) → 全部解除 → 负责人确认 → 复位
 * - 任一级别为联锁即锁定提升/回转
 * - 启动期持久化或事件流损坏 → 安全联锁
 */
export class SafetyEngine {
  readonly channels: Record<ChannelId, ChannelState>;
  episode: LockEpisode | null = null;
  failsafe = false;
  corruptReasons: string[] = [];
  private log: EventLog;
  private listeners = new Set<() => void>;

  private constructor(log: EventLog) {
    this.log = log;
    this.channels = Object.fromEntries(
      CHANNEL_ORDER.map((id) => [
        id,
        { id, level: LEVEL.SAFE, value: null, updatedAt: 0 } satisfies ChannelState,
      ]),
    ) as Record<ChannelId, ChannelState>;
  }

  static async create(simulator: Simulator): Promise<SafetyEngine> {
    let log: EventLog;
    const corruptReasons: string[] = [];
    try {
      log = await EventLog.create();
    } catch (e) {
      // 事件流损坏（含末尾记录缺失）：隔离重建（哈希链无法信任），进入安全联锁
      log = await EventLog.create();
      corruptReasons.push(e instanceof EventLogCorruptError ? e.reason : "事件流校验失败");
    }
    // 上一次启动已检测到篡改但尚未经负责人复位：继续保持安全联锁
    const mark = readTamperMark();
    if (mark && !corruptReasons.some((r) => r.includes(mark.reason))) {
      corruptReasons.push(mark.reason);
    }

    const engine = new SafetyEngine(log);
    let restored: PersistState | null = null;
    try {
      restored = loadState();
    } catch (e) {
      if (e instanceof StateCorruptError) corruptReasons.push("联锁状态数据损坏");
      else corruptReasons.push("联锁状态读取失败");
      clearState();
    }

    if (corruptReasons.length > 0) {
      engine.corruptReasons = corruptReasons;
      await engine.enterFailSafe(Date.now(), corruptReasons.join("；"));
    } else if (restored) {
      engine.restore(restored);
    }
    return engine;
  }

  // ---------- 启动 / 恢复 ----------

  private restore(s: PersistState): void {
    if (s.openEpisode) this.episode = s.openEpisode;
    for (const id of CHANNEL_ORDER) {
      const r = s.lastReadings[id];
      if (r) this.applyReading(id, r, r.t, false);
    }
    // 恢复后重新核算活动通道（持久化仅作兜底）
    if (this.episode) {
      this.episode.activeChannels = CHANNEL_ORDER.filter((id) => this.channels[id].level === 2);
      this.persist();
    }
  }

  private async enterFailSafe(now: number, reason: string): Promise<void> {
    this.failsafe = true;
    const ep: LockEpisode = {
      id: newEpisodeId(now, true),
      open: true,
      channels: [],
      activeChannels: [],
      triggerValues: {},
      clearValues: {},
      triggeredAt: now,
      clearedAt: now, // 无活动风险通道，等待负责人核查确认
      confirmedAt: null,
      confirmedBy: null,
      regressed: false,
      resetAt: null,
      resetBy: null,
      failSafe: true,
    };
    this.episode = ep;
    await this.log.append({
      t: now,
      type: "FAILSAFE_BOOT",
      level: LEVEL.LOCK,
      detail: reason,
      episodeId: ep.id,
    });
    this.persist();
  }

  // ---------- 数据接入 ----------

  /** 接收一轮读数并处理所有等级迁移 */
  async ingest(readings: Partial<Record<ChannelId, Reading>>, now: number): Promise<void> {
    for (const id of CHANNEL_ORDER) {
      const r = readings[id];
      if (r) await this.applyReadingAsync(id, r, now);
    }
    // 停刷检测
    for (const id of CHANNEL_ORDER) {
      const ch = this.channels[id];
      if (ch.updatedAt > 0 && now - ch.updatedAt > STALE_TIMEOUT_MS && ch.level !== 2) {
        ch.level = LEVEL.LOCK;
        ch.fault = "stale";
        ch.reason = this.faultText("stale");
        await this.enterLock(id, ch.value, now, "stale");
      }
    }
    this.persist();
    this.emit();
  }

  private applyReading(id: ChannelId, r: Reading, now: number, _emit: boolean): void {
    const cfg = CHANNELS[id];
    const ch = this.channels[id];
    const fault = r.fault ?? (r.v !== null && isOutOfRange(cfg, r.v) ? "out_of_range" : undefined);
    ch.value = r.v;
    ch.updatedAt = r.t || now;
    ch.fault = fault;
    ch.level = fault ? LEVEL.LOCK : classify(cfg, r.v);
    ch.reason = fault ? this.faultText(fault) : thresholdReason(cfg, ch.level);
  }

  private async applyReadingAsync(id: ChannelId, r: Reading, now: number): Promise<void> {
    const cfg = CHANNELS[id];
    const prev = this.channels[id];
    const prevLevel = prev.level;
    const prevFault = prev.fault;

    const fault =
      r.fault ?? (r.v !== null && Number.isFinite(r.v) && isOutOfRange(cfg, r.v)
        ? "out_of_range"
        : r.v !== null && !Number.isFinite(r.v)
          ? "invalid"
          : undefined);
    const level: Level = fault ? LEVEL.LOCK : classify(cfg, r.v);

    prev.value = r.v;
    prev.updatedAt = r.t || now;
    prev.fault = fault;
    prev.level = level;
    prev.reason = fault ? this.faultText(fault) : thresholdReason(cfg, level);

    // 进入联锁
    if (level === 2 && prevLevel !== 2) {
      await this.enterLock(id, fault ? null : r.v, now, fault);
    }
    // 退出联锁
    if (prevLevel === 2 && level !== 2) {
      await this.exitLock(id, r.v, now, !!prevFault);
    }
    // 预警迁移
    if (level === 1 && prevLevel !== 1) {
      await this.log.append({
        t: now, type: "WARN_TRIGGER", level: LEVEL.WARN, channel: id, value: r.v,
        episodeId: this.episode?.id,
      });
    }
    if (prevLevel === 1 && level !== 1) {
      await this.log.append({
        t: now, type: "WARN_CLEAR", level: LEVEL.SAFE, channel: id, value: r.v,
        episodeId: this.episode?.id,
      });
    }
  }

  private faultText(fault: NonNullable<ChannelState["fault"]>): string {
    switch (fault) {
      case "disconnected": return "传感器信号丢失，按联锁处置";
      case "out_of_range": return "读数超物理量程，数据异常";
      case "stale": return "数据长时间不刷新，按联锁处置";
      case "invalid": return "数据无法解析，按联锁处置";
    }
  }

  private async enterLock(
    id: ChannelId, value: number | null, now: number, fault?: ChannelState["fault"],
  ): Promise<void> {
    if (!this.episode || !this.episode.open) {
      this.episode = {
        id: newEpisodeId(now),
        open: true,
        channels: [id],
        activeChannels: [id],
        triggerValues: { [id]: value },
        clearValues: {},
        triggeredAt: now,
        clearedAt: null,
        confirmedAt: null,
        confirmedBy: null,
        regressed: false,
        resetAt: null,
        resetBy: null,
      };
    } else {
      const ep = this.episode;
      if (!ep.channels.includes(id)) ep.channels.push(id);
      if (!ep.activeChannels.includes(id)) ep.activeChannels.push(id);
      ep.triggerValues[id] = value;
      // 已解除待确认 / 已确认待复位期间又出现联锁：确认作废，需重新确认
      if (ep.clearedAt || ep.confirmedAt) {
        ep.regressed = true;
        ep.clearedAt = null;
        ep.confirmedAt = null;
        ep.confirmedBy = null;
      }
    }
    await this.log.append({
      t: now,
      type: fault ? "SENSOR_FAULT" : "LOCK_TRIGGER",
      level: LEVEL.LOCK,
      channel: id,
      value,
      fault,
      channels: [...this.episode.activeChannels],
      episodeId: this.episode.id,
    });
  }

  private async exitLock(id: ChannelId, value: number | null, now: number, wasFault: boolean): Promise<void> {
    const ep = this.episode;
    if (!ep) return;
    ep.clearValues[id] = value;
    ep.activeChannels = ep.activeChannels.filter((c) => c !== id);
    // 每路通道解除都把解除值与时间写入只增事件流
    await this.log.append({
      t: now,
      type: wasFault ? "SENSOR_RECOVER" : "LOCK_CLEAR",
      level: this.channels[id].level,
      channel: id,
      value,
      channels: [...ep.activeChannels],
      episodeId: ep.id,
    });
    if (ep.activeChannels.length === 0 && ep.clearedAt === null) {
      ep.clearedAt = now;
      await this.log.append({
        t: now,
        type: "LOCK_CLEAR",
        level: LEVEL.WARN,
        channels: [...ep.channels],
        detail: "全部风险通道解除，等待值班负责人确认",
        episodeId: ep.id,
      });
    }
  }

  // ---------- 授权操作 ----------

  /** 值班负责人确认风险解除 */
  async confirm(operator: string, role: string, now = Date.now()): Promise<AuthResult> {
    const ep = this.episode;
    if (!ep || !ep.open) return { ok: false, detail: "当前无联锁回合" };
    if (role !== "supervisor") {
      await this.deny(operator, "确认", "非值班负责人无权确认", now);
      this.emit();
      return { ok: false, detail: "仅值班负责人可确认，本次尝试已记录" };
    }
    if (ep.activeChannels.length > 0 || ep.clearedAt === null) {
      await this.deny(operator, "确认", `仍有 ${ep.activeChannels.length} 路风险未解除`, now);
      this.emit();
      return { ok: false, detail: "风险尚未全部解除，不能确认" };
    }
    if (ep.confirmedAt) return { ok: false, detail: "已确认，请执行复位" };
    ep.confirmedAt = now;
    ep.confirmedBy = operator;
    await this.log.append({
      t: now, type: "INTERLOCK_CONFIRM", level: LEVEL.WARN,
      channels: [...ep.channels], operator, episodeId: ep.id,
    });
    this.persist();
    this.emit();
    return { ok: true };
  }

  /** 确认后复位，恢复提升/回转 */
  async reset(operator: string, role: string, now = Date.now()): Promise<AuthResult> {
    const ep = this.episode;
    if (!ep || !ep.open) return { ok: false, detail: "当前无联锁回合" };
    if (role !== "supervisor") {
      await this.deny(operator, "复位", "非值班负责人无权复位", now);
      this.emit();
      return { ok: false, detail: "仅值班负责人可复位，本次尝试已记录" };
    }
    if (!ep.confirmedAt) {
      await this.deny(operator, "复位", "未经风险解除确认", now);
      this.emit();
      return { ok: false, detail: "须先确认风险解除，才能复位" };
    }
    ep.open = false;
    ep.resetAt = now;
    ep.resetBy = operator;
    await this.log.append({
      t: now, type: "INTERLOCK_RESET", level: LEVEL.SAFE,
      channels: [...ep.channels], operator, episodeId: ep.id,
    });
    this.episode = null;
    this.failsafe = false;
    // 经值班负责人复位后，历史完整性破坏视为已处置，清除持续标记
    clearTamperMark();
    this.persist();
    this.emit();
    return { ok: true };
  }

  /** 联锁期间尝试提升 / 回转操作 */
  async attemptOperation(op: OperationKind, now = Date.now()): Promise<AuthResult> {
    if (!this.isLocked()) return { ok: true };
    const ep = this.episode!;
    await this.log.append({
      t: now,
      type: "OPERATION_DENIED",
      level: LEVEL.LOCK,
      detail: op === "hoist" ? "联锁期间尝试提升，已锁定" : "联锁期间尝试回转，已锁定",
      channels: [...ep.activeChannels],
      episodeId: ep.id,
    });
    this.emit();
    return { ok: false, detail: "安全联锁生效中，操作已被锁定" };
  }

  private async deny(operator: string, action: string, reason: string, now: number): Promise<void> {
    await this.log.append({
      t: now,
      type: "CONFIRM_DENIED",
      level: LEVEL.LOCK,
      operator: operator || "未登录用户",
      detail: `${action}被拒：${reason}`,
      episodeId: this.episode?.id,
    });
  }

  // ---------- 派生状态 ----------

  isLocked(): boolean {
    return !!this.episode?.open;
  }

  /** 全场等级：多路并存取最高级；联锁回合未复位前始终为联锁 */
  overallLevel(): Level {
    if (this.isLocked()) return LEVEL.LOCK;
    return CHANNEL_ORDER.reduce<Level>(
      (m, id) => (this.channels[id].level > m ? this.channels[id].level : m),
      LEVEL.SAFE,
    );
  }

  activeLockChannels(): ChannelId[] {
    return this.episode?.activeChannels ?? [];
  }

  events(): readonly SafetyEvent[] {
    return this.log.list();
  }

  // ---------- 持久化 / 订阅 ----------

  private persist(): void {
    const s: PersistState = {
      version: 1,
      openEpisode: this.episode,
      warnChannels: CHANNEL_ORDER.filter((id) => this.channels[id].level === 1),
      faultChannels: CHANNEL_ORDER.filter((id) => this.channels[id].level === 2),
      lastReadings: Object.fromEntries(
        CHANNEL_ORDER.map((id) => [
          id,
          { t: this.channels[id].updatedAt, v: this.channels[id].value, fault: this.channels[id].fault },
        ]),
      ),
      updatedAt: Date.now(),
    };
    try {
      saveState(s);
    } catch {
      // 存储不可写（隐私模式等）：内存联锁仍生效，不放宽安全状态
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
