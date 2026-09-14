import { CHANNELS, formatValue } from "../channels";
import { LEVEL, LEVEL_TEXT, type ChannelId } from "../types";
import { fmtTime } from "../format";
import { useRig } from "../useRig";

const FAULT_TEXT: Record<string, string> = {
  disconnected: "信号丢失",
  out_of_range: "超量程",
  stale: "数据停刷",
  invalid: "数据无效",
};

function barPercent(id: ChannelId, v: number | null): number {
  const cfg = CHANNELS[id];
  if (v === null || !Number.isFinite(v)) return 0;
  const x = cfg.direction === "abs" ? Math.abs(v) : v;
  // 以联锁门限的 1.25 倍为满刻度
  const denom = cfg.lock * 1.25;
  return Math.max(0, Math.min(100, (x / denom) * 100));
}

export function ChannelCard({ id }: { id: ChannelId }) {
  const { engine } = useRig();
  const cfg = CHANNELS[id];
  const ch = engine.channels[id];

  return (
    <div className={`ch lvl-${ch.level}`}>
      <div className="ch-head">
        <span className="ch-name">{cfg.name}</span>
        <span className={`ch-badge lvl-${ch.level}`}>{LEVEL_TEXT[ch.level]}</span>
      </div>
      <div className="ch-value">
        {ch.fault ? "— —" : formatValue(cfg, ch.value).split(" ")[0]}
        <span className="ch-unit"> {ch.fault ? "" : cfg.unit}</span>
        {ch.fault && <span className="fault-tag">{FAULT_TEXT[ch.fault] ?? "异常"}</span>}
      </div>
      <div className="bar">
        <i style={{ width: `${barPercent(id, ch.value)}%` }} />
      </div>
      <div className="ch-th">
        <span>预警 ≥ {cfg.warn}</span>
        <span>联锁 ≥ {cfg.lock}</span>
      </div>
      <div className="ch-reason">{ch.fault ? ch.reason : ch.reason ?? cfg.advice[LEVEL.SAFE]}</div>
      <div className="ch-time">
        {ch.updatedAt ? `更新 ${fmtTime(ch.updatedAt)}` : "等待数据…"} · 量程 {cfg.range[0]}~{cfg.range[1]}
        {cfg.unit}
      </div>
    </div>
  );
}
