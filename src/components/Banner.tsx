import { CHANNELS, CHANNEL_ORDER } from "../channels";
import { LEVEL, LEVEL_TEXT } from "../types";
import { useRig } from "../useRig";

export function Banner() {
  const { engine } = useRig();
  const level = engine.overallLevel();
  const cls = level === LEVEL.LOCK ? "lock" : level === LEVEL.WARN ? "warn" : "safe";

  const active = engine.activeLockChannels();
  const warns = CHANNEL_ORDER.filter((id) => engine.channels[id].level === LEVEL.WARN);
  const faults = CHANNEL_ORDER.filter((id) => engine.channels[id].fault);

  let desc = "四路监测均在安全区间，提升与回转允许操作";
  if (level === LEVEL.WARN) desc = "存在预警项，保持关注并按预案处置；预警不锁定操作";
  if (level === LEVEL.LOCK)
    desc = engine.failsafe
      ? "启动校验失败，已按失效安全原则锁定全部作业，待负责人核查"
      : "已触发安全联锁，提升与回转自动锁定，风险解除并经负责人确认后方可复位";

  return (
    <div className={`banner ${cls}`} role="status" aria-live="assertive">
      <span className="lamp" />
      <div>
        <div className="b-title">{LEVEL_TEXT[level]}</div>
        <div className="b-desc">{desc}</div>
      </div>
      <div className="spacer" style={{ flex: 1 }} />
      <div className="b-chips">
        {active.map((id) => (
          <span className="chip lock" key={id}>
            ⛔ {CHANNELS[id].name}联锁
          </span>
        ))}
        {warns.map((id) => (
          <span className="chip warn" key={id}>
            ⚠ {CHANNELS[id].name}预警
          </span>
        ))}
        {faults.map((id) => (
          <span className="chip lock" key={`f-${id}`}>
            ✕ {CHANNELS[id].name}传感器异常
          </span>
        ))}
      </div>
    </div>
  );
}
