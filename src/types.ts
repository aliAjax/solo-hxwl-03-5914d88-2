// 领域类型定义：钻机现场安全联锁台

/** 三级风险等级（数值越大越严重，用于多风险取最高级） */
export type Level = 0 | 1 | 2;

export const LEVEL = {
  SAFE: 0 as Level,
  WARN: 1 as Level,
  LOCK: 2 as Level,
};

export const LEVEL_TEXT: Record<Level, string> = {
  0: "安全",
  1: "预警",
  2: "联锁",
};

/** 通道标识 */
export type ChannelId = "wind" | "tilt" | "load" | "gas";

/** 传感器读数（模拟器 / 人工注入统一产出） */
export interface Reading {
  /** 采集时刻 epoch ms */
  t: number;
  /** 工程量；null 表示设备故障 / 信号丢失 */
  v: number | null;
  /** 数据质量标记 */
  fault?: SensorFault;
}

export type SensorFault =
  | "disconnected" // 信号丢失 / 设备离线
  | "out_of_range" // 超物理量程
  | "stale" // 数据不刷新
  | "invalid"; // 无法解析的异常数据

/** 单个通道的实时评估结果 */
export interface ChannelState {
  id: ChannelId;
  level: Level;
  value: number | null;
  updatedAt: number;
  fault?: SensorFault;
  /** 越过的门限名称，用于界面提示 */
  reason?: string;
}

/** 事件类型（全部写入只增事件流） */
export type EventType =
  | "LOCK_TRIGGER" // 联锁触发
  | "LOCK_CLEAR" // 风险解除（等待确认）
  | "INTERLOCK_CONFIRM" // 值班负责人确认风险解除
  | "INTERLOCK_RESET" // 联锁复位、操作解锁
  | "WARN_TRIGGER" // 预警开始
  | "WARN_CLEAR" // 预警结束
  | "SENSOR_FAULT" // 传感器异常（按联锁处置）
  | "SENSOR_RECOVER" // 传感器恢复
  | "CONFIRM_DENIED" // 未授权操作被拒绝
  | "FAILSAFE_BOOT" // 恢复数据损坏 → 安全联锁
  | "OPERATION_DENIED"; // 联锁期间操作被拒（可选记录）

export const EVENT_TYPE_TEXT: Record<EventType, string> = {
  LOCK_TRIGGER: "联锁触发",
  LOCK_CLEAR: "风险解除",
  INTERLOCK_CONFIRM: "负责人确认",
  INTERLOCK_RESET: "联锁复位",
  WARN_TRIGGER: "预警开始",
  WARN_CLEAR: "预警结束",
  SENSOR_FAULT: "传感器异常",
  SENSOR_RECOVER: "传感器恢复",
  CONFIRM_DENIED: "未授权操作被拒",
  FAILSAFE_BOOT: "数据损坏·安全联锁",
  OPERATION_DENIED: "操作被联锁拒绝",
};

/** 只增事件流中的一条记录 */
export interface SafetyEvent {
  seq: number;
  t: number;
  type: EventType;
  level: Level;
  channel?: ChannelId;
  /** 触发 / 解除时刻的工程量 */
  value?: number | null;
  fault?: SensorFault;
  /** 涉及的全部通道（联锁触发 / 解除时为当时处于联锁级的通道集合） */
  channels?: ChannelId[];
  /** 操作人 / 确认人（未授权拒绝时为尝试者身份描述） */
  operator?: string;
  /** 拒绝原因（CONFIRM_DENIED / OPERATION_DENIED） */
  detail?: string;
  /** 关联的联锁回合 id */
  episodeId?: string;
  prevHash: string;
  hash: string;
}

/** 一次联锁“回合”：从首次触发到复位 */
export interface LockEpisode {
  id: string;
  open: boolean;
  /** 触发过的通道（并集，不随解除移除，用于追溯） */
  channels: ChannelId[];
  /** 当前仍处于联锁级的通道（含传感器异常通道） */
  activeChannels: ChannelId[];
  /** 各通道触发时的值 */
  triggerValues: Partial<Record<ChannelId, number | null>>;
  /** 各通道最近一次解除时的值 */
  clearValues: Partial<Record<ChannelId, number | null>>;
  triggeredAt: number;
  /** 全部触发通道都恢复安全的时刻 */
  clearedAt: number | null;
  /** 值班负责人确认时刻与确认人 */
  confirmedAt: number | null;
  confirmedBy: string | null;
  /** 确认后是否又出现新的联锁（需要重新确认） */
  regressed: boolean;
  resetAt: number | null;
  resetBy: string | null;
  /** 启动期安全联锁回合 */
  failSafe?: boolean;
}

/** 持久化到 localStorage 的状态 */
export interface PersistState {
  version: number;
  openEpisode: LockEpisode | null;
  /** 当前处于预警级的通道 */
  warnChannels: ChannelId[];
  /** 当前处于异常（联锁级）的通道 */
  faultChannels: ChannelId[];
  /** 各通道最近读数（刷新后界面立刻有值） */
  lastReadings: Partial<Record<ChannelId, Reading>>;
  updatedAt: number;
}

/** 值班负责人账户（演示用，实际应由后端/卡系统认证） */
export interface Supervisor {
  username: string;
  name: string;
  password: string;
}
