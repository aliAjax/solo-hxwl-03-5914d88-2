import type { ChannelId, Level } from "./types";

/** 通道元数据与三级门限 */
export interface ChannelConfig {
  id: ChannelId;
  name: string;
  unit: string;
  /** 工程量程（超出即异常数据，按联锁处置） */
  range: [number, number];
  /** 正常值中心（模拟器围绕其波动） */
  baseline: number;
  /** 正常波动幅度 */
  jitter: number;
  /** 预警门限：|value| 达到 warn 进入预警 */
  warn: number;
  /** 联锁门限：|value| 达到 lock 进入联锁 */
  lock: number;
  /** 分级方向：high=越大越危险，low=越小越危险，abs=按绝对值 */
  direction: "high" | "low" | "abs";
  /** 停留在此等级的建议话术 */
  advice: Record<Level, string>;
}

export const CHANNELS: Record<ChannelId, ChannelConfig> = {
  wind: {
    id: "wind",
    name: "风速",
    unit: "m/s",
    range: [0, 80],
    baseline: 9,
    jitter: 2.5,
    warn: 13.8, // 6 级风
    lock: 20.7, // 8 级风，停止高处/起升作业
    direction: "high",
    advice: {
      0: "风力正常，作业可继续",
      1: "接近大风门限，减少高处起升，关注气象",
      2: "大风联锁：立即停止起升与回转，钻具就位",
    },
  },
  tilt: {
    id: "tilt",
    name: "井架倾角",
    unit: "°",
    range: [-15, 15],
    baseline: 0.4,
    jitter: 0.25,
    warn: 1.5,
    lock: 3.0,
    direction: "abs",
    advice: {
      0: "井架姿态正常",
      1: "倾角偏大，检查地基与支腿，停止大载荷起升",
      2: "倾侧联锁：停止提升/回转，人员撤离危险区",
    },
  },
  load: {
    id: "load",
    name: "卷扬载荷",
    unit: "kN",
    range: [0, 2500],
    baseline: 620,
    jitter: 90,
    warn: 1000,
    lock: 1400, // 额定起重量上限
    direction: "high",
    advice: {
      0: "载荷在额定范围内",
      1: "接近额定载荷，减速运行、禁止急刹急起",
      2: "超载联锁：提升已锁定，落钩卸载后确认",
    },
  },
  gas: {
    id: "gas",
    name: "可燃气体",
    unit: "%LEL",
    range: [0, 100],
    baseline: 4,
    jitter: 1.6,
    warn: 25,
    lock: 50, // 爆炸下限 50%LEL，停工断电（非防爆设备）
    direction: "high",
    advice: {
      0: "可燃气体浓度正常",
      1: "浓度预警，加强通风，检测泄漏点",
      2: "浓度联锁：停止一切作业，切断火源，全员撤离",
    },
  },
};

export const CHANNEL_ORDER: ChannelId[] = ["wind", "tilt", "load", "gas"];

/** 按门限评估工程量；返回 0 安全 / 1 预警 / 2 联锁 */
export function classify(cfg: ChannelConfig, v: number | null | undefined): Level {
  if (v === null || v === undefined || Number.isNaN(v)) return 2;
  const x = cfg.direction === "abs" ? Math.abs(v) : v;
  if (cfg.direction === "low") {
    if (x <= cfg.lock) return 2;
    if (x <= cfg.warn) return 1;
    return 0;
  }
  if (x >= cfg.lock) return 2;
  if (x >= cfg.warn) return 1;
  return 0;
}

/** 越过的门限说明 */
export function thresholdReason(cfg: ChannelConfig, level: Level): string {
  if (level === 2)
    return cfg.direction === "low"
      ? `≤ ${cfg.lock}${cfg.unit} 触发联锁`
      : `≥ ${cfg.lock}${cfg.unit} 触发联锁`;
  if (level === 1)
    return cfg.direction === "low"
      ? `≤ ${cfg.warn}${cfg.unit} 进入预警`
      : `≥ ${cfg.warn}${cfg.unit} 进入预警`;
  return "恢复安全区间";
}

/** 传感器读数是否超物理量程（异常数据） */
export function isOutOfRange(cfg: ChannelConfig, v: number): boolean {
  return Number.isNaN(v) || v < cfg.range[0] || v > cfg.range[1];
}

export function formatValue(cfg: ChannelConfig, v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${v.toFixed(v < 10 ? 2 : 1)} ${cfg.unit}`;
}
