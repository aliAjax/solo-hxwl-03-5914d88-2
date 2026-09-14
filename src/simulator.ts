import { CHANNELS, type ChannelConfig } from "./channels";
import type { ChannelId, Reading, SensorFault } from "./types";

/** 单通道模拟模式 */
export type SimMode =
  | "normal" // 正常波动
  | "warn" // 稳定在预警区
  | "lock" // 稳定在联锁区
  | "disconnected" // 信号丢失
  | "out_of_range" // 超物理量程
  | "stale" // 数据停刷
  | "invalid"; // 无法解析

/** 一次性注入：覆盖下一轮读数（测试临界值用），null 表示清除注入 */
export interface Injection {
  value: number | null;
  fault?: SensorFault;
  /** 生效轮数，默认 1 */
  rounds?: number;
}

function valueForMode(cfg: ChannelConfig, mode: SimMode): number {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  switch (mode) {
    case "normal":
      // 保证不越过预警门限
      return cfg.baseline + rnd(-1, 1) * cfg.jitter;
    case "warn": {
      const span = cfg.lock - cfg.warn;
      return cfg.direction === "low"
        ? cfg.warn - span * 0.35
        : cfg.warn + span * 0.35;
    }
    case "lock": {
      const span = cfg.lock - cfg.warn;
      return cfg.direction === "low"
        ? cfg.lock - span * 0.25
        : cfg.lock + span * 0.3;
    }
    case "out_of_range":
      return cfg.range[1] + rnd(20, 80);
    default:
      return cfg.baseline;
  }
}

export class Simulator {
  private modes: Record<ChannelId, SimMode> = {
    wind: "normal",
    tilt: "normal",
    load: "normal",
    gas: "normal",
  };
  private injections = new Map<ChannelId, Injection>();

  setMode(id: ChannelId, mode: SimMode): void {
    this.modes[id] = mode;
    if (mode !== "normal") this.injections.delete(id);
  }

  getMode(id: ChannelId): SimMode {
    return this.modes[id];
  }

  /** 注入指定工程量（NaN 按无效数据处理），默认持续 1 轮 */
  inject(id: ChannelId, value: number | null, fault?: SensorFault, rounds = 1): void {
    this.injections.set(id, { value, fault, rounds });
  }

  /** 产生一轮读数；返回有新数据的通道（stale 通道不在其中） */
  tick(now: number): Partial<Record<ChannelId, Reading>> {
    const out: Partial<Record<ChannelId, Reading>> = {};
    (Object.keys(CHANNELS) as ChannelId[]).forEach((id) => {
      const cfg = CHANNELS[id];
      const mode = this.modes[id];
      if (mode === "stale") return; // 停刷：上层按超时判异常

      const inj = this.injections.get(id);
      if (inj) {
        out[id] = { t: now, v: inj.value, fault: inj.fault ?? (inj.value === null ? "invalid" : undefined) };
        const left = (inj.rounds ?? 1) - 1;
        if (left <= 0) this.injections.delete(id);
        else this.injections.set(id, { ...inj, rounds: left });
        return;
      }

      switch (mode) {
        case "disconnected":
          out[id] = { t: now, v: null, fault: "disconnected" };
          break;
        case "invalid":
          out[id] = { t: now, v: null, fault: "invalid" };
          break;
        case "out_of_range": {
          const v = valueForMode(cfg, "out_of_range");
          out[id] = { t: now, v, fault: "out_of_range" };
          break;
        }
        default:
          out[id] = { t: now, v: valueForMode(cfg, mode) };
      }
    });
    return out;
  }
}

export const SIM_MODE_TEXT: Record<SimMode, string> = {
  normal: "正常",
  warn: "预警区",
  lock: "联锁区",
  disconnected: "信号丢失",
  out_of_range: "超量程",
  stale: "数据停刷",
  invalid: "无效数据",
};
