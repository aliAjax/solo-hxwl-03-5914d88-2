import { CHANNELS } from "../channels";
import { EventLog } from "../events";
import { corruptStateStorage } from "../persistence";
import { SIM_MODE_TEXT, type SimMode } from "../simulator";
import { LEVEL_TEXT, type ChannelId } from "../types";
import { useRig } from "../useRig";

const MODE_BTNS: SimMode[] = ["normal", "warn", "lock", "disconnected", "out_of_range", "stale", "invalid"];

function Row({ id }: { id: ChannelId }) {
  const { setMode, modes, injectReading } = useRig();
  const cfg = CHANNELS[id];
  return (
    <div className="test-row">
      <span className="t-name">{cfg.name}</span>
      <div className="test-btns">
        {MODE_BTNS.map((m) => (
          <button key={m} className={modes[id] === m ? "on" : ""} onClick={() => setMode(id, m)}>
            {SIM_MODE_TEXT[m]}
          </button>
        ))}
        <button onClick={() => injectReading(id, { t: Date.now(), v: cfg.warn })}>
          注入={cfg.warn}（预警临界）
        </button>
        <button onClick={() => injectReading(id, { t: Date.now(), v: cfg.lock })}>
          注入={cfg.lock}（联锁临界）
        </button>
      </div>
    </div>
  );
}

export function TestPanel() {
  const { engine, simulator, setMode, now } = useRig();

  /** 三路同时联锁 + 一路预警：验证并发与最高级展示 */
  function concurrentScenario() {
    setMode("wind", "lock");
    setMode("gas", "lock");
    setMode("load", "warn");
    setMode("tilt", "normal");
  }

  function allNormal() {
    (["wind", "tilt", "load", "gas"] as ChannelId[]).forEach((id) => setMode(id, "normal"));
  }

  /** 注入各通道恰好在联锁门限值上的读数（验证临界值边界） */
  function exactThresholds() {
    (Object.keys(CHANNELS) as ChannelId[]).forEach((id) => {
      simulator.inject(id, CHANNELS[id].lock);
    });
  }

  /** 破坏事件流存储：下次刷新载入即进入安全联锁 */
  function corruptEvents() {
    EventLog.corruptStorage();
  }
  /** 破坏联锁状态存储 */
  function corruptState() {
    corruptStateStorage();
  }

  return (
    <details className="test-panel">
      <summary>测试注入台（模拟量 / 异常 / 数据损坏，仅演示环境使用）</summary>
      <div className="test-body">
        {(Object.keys(CHANNELS) as ChannelId[]).map((id) => (
          <Row key={id} id={id} />
        ))}
        <div className="test-global">
          <button className="primary" onClick={concurrentScenario}>
            并发场景：风+气联锁、载荷预警
          </button>
          <button onClick={exactThresholds}>临界值：四路=联锁门限</button>
          <button onClick={allNormal}>全部恢复正常</button>
          <button className="danger" onClick={corruptEvents}>
            篡改事件流（刷新后验证）
          </button>
          <button className="danger" onClick={corruptState}>
            损坏联锁状态（刷新后验证）
          </button>
        </div>
        <div className="test-note">
          当前全场等级：{LEVEL_TEXT[engine.overallLevel()]}；操作锁定：{engine.isLocked() ? "是" : "否"}。
          「篡改/损坏」按钮破坏 localStorage 后按 F5 刷新，系统应进入红色安全联锁并记录“数据损坏”事件。
          <br />
          每 1 秒采集一轮；停刷模式在 {">"}4 秒无数据后按联锁处置。时间戳：{new Date(now).toLocaleTimeString()}
        </div>
      </div>
    </details>
  );
}
