import { useMemo, useState } from "react";
import { CHANNELS } from "../channels";
import { verifyLogIntegrity } from "../events";
import { fmtTime, shortHash } from "../format";
import { EVENT_TYPE_TEXT, type EventType } from "../types";
import { useRig } from "../useRig";

const FILTERS: { key: EventType | "all"; text: string }[] = [
  { key: "all", text: "全部" },
  { key: "LOCK_TRIGGER", text: "联锁" },
  { key: "LOCK_CLEAR", text: "解除" },
  { key: "INTERLOCK_CONFIRM", text: "确认" },
  { key: "CONFIRM_DENIED", text: "拒绝" },
  { key: "SENSOR_FAULT", text: "异常" },
];

export function EventStream() {
  const { engine, now } = useRig();
  const [filter, setFilter] = useState<EventType | "all">("all");
  const [check, setCheck] = useState<null | boolean>(null);

  const events = engine.events();
  const shown = useMemo(() => {
    const list = filter === "all" ? [...events] : events.filter((e) => e.type === filter);
    return list.reverse();
  }, [events, filter, now]);

  async function runVerify() {
    setCheck(await verifyLogIntegrity(engine.events()));
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(engine.events(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rig-safety-events-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <h2>事件流（只增·哈希链防篡改）</h2>
      <div className="integrity">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`tiny ${filter === f.key ? "primary" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.text}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="tiny" onClick={runVerify}>
          完整性校验
        </button>
        <button className="tiny ghost" onClick={exportJson}>
          导出JSON
        </button>
        {check !== null && (
          <span className={`result ${check ? "ok" : "bad"}`}>
            {check ? "✓ 哈希链完整，记录未被修改" : "✗ 校验失败：检测到记录被篡改或损坏"}
          </span>
        )}
      </div>
      <div className="events">
        <table className="events-table">
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>事件</th>
              <th>通道/详情</th>
              <th>操作人</th>
              <th>值</th>
              <th>哈希</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "var(--muted)", textAlign: "center", padding: 24 }}>
                  暂无事件
                </td>
              </tr>
            )}
            {shown.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.t)}</td>
                <td className={`ev-type ev-${e.type}`}>{EVENT_TYPE_TEXT[e.type]}</td>
                <td>
                  {e.channel ? CHANNELS[e.channel].name : e.channels ? e.channels.map((c) => CHANNELS[c].name).join("、") : "—"}
                  {e.detail ? <div style={{ color: "var(--muted)" }}>{e.detail}</div> : null}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{e.operator ?? "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {e.value === null ? "异常" : e.value !== undefined ? `${e.value}` : "—"}
                </td>
                <td className="ev-hash" title={e.hash}>
                  {shortHash(e.hash)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
