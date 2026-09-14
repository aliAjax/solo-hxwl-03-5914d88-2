import { useState } from "react";
import { CHANNELS } from "../channels";
import { fmtTime } from "../format";
import { useRig } from "../useRig";

function Step({
  index,
  title,
  state,
}: {
  index: string;
  title: string;
  state: "done" | "active" | "todo";
}) {
  return (
    <div className={`flow-step ${state}`}>
      <span className="dot">{state === "done" ? "✓" : index}</span>
      <span>{title}</span>
    </div>
  );
}

export function InterlockPanel() {
  const { engine, session, act, attemptOp } = useRig();
  const ep = engine.episode;
  const locked = engine.isLocked();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const active = ep?.activeChannels ?? [];
  const allCleared = !!ep && active.length === 0 && ep.clearedAt !== null;
  const confirmed = !!ep?.confirmedAt;

  const stepState = (n: 1 | 2 | 3 | 4): "done" | "active" | "todo" => {
    if (!ep) return "todo";
    if (n === 1) return "done";
    if (n === 2) return allCleared ? "done" : "active";
    if (n === 3) return confirmed ? "done" : allCleared ? "active" : "todo";
    if (n === 4) return confirmed ? "active" : "todo";
    return "todo";
  };

  async function doConfirm() {
    const r = await act(
      engine.confirm(session ? session.name : "未登录用户", session ? session.role : "viewer"),
    );
    setMsg(r.ok ? { ok: true, text: "已确认风险解除，可执行复位" } : { ok: false, text: r.detail ?? "确认失败" });
  }

  async function doReset() {
    const r = await act(
      engine.reset(session ? session.name : "未登录用户", session ? session.role : "viewer"),
    );
    setMsg(r.ok ? { ok: true, text: "联锁已复位，提升与回转恢复" } : { ok: false, text: r.detail ?? "复位失败" });
  }

  async function tryOp(op: "hoist" | "rotate") {
    const r = await attemptOp(op);
    setMsg(r.ok ? { ok: true, text: op === "hoist" ? "提升操作允许" : "回转操作允许" } : { ok: false, text: r.detail ?? "操作被锁定" });
  }

  return (
    <section className="panel">
      <h2>操作联锁与复位</h2>

      {engine.failsafe && (
        <div className="failsafe-note">
          ⚠ 失效安全状态：{engine.corruptReasons.join("、")}。系统已自动锁定提升与回转，请现场核查设备与数据后确认复位。
        </div>
      )}

      <div className="oplocks">
        <div className={`oplock ${locked ? "locked" : "free"}`}>
          <div className="op-icon">{locked ? "⛔" : "✅"}</div>
          <div className="op-state">{locked ? "已锁定" : "允许"}</div>
          <div className="op-name">提升（卷扬）</div>
          <button className="tiny" style={{ marginTop: 8 }} onClick={() => tryOp("hoist")}>
            试操作
          </button>
        </div>
        <div className={`oplock ${locked ? "locked" : "free"}`}>
          <div className="op-icon">{locked ? "⛔" : "✅"}</div>
          <div className="op-state">{locked ? "已锁定" : "允许"}</div>
          <div className="op-name">回转（转盘）</div>
          <button className="tiny" style={{ marginTop: 8 }} onClick={() => tryOp("rotate")}>
            试操作
          </button>
        </div>
      </div>

      <div className="flow">
        <Step index="1" title={`联锁触发${ep ? `：${ep.channels.map((c) => CHANNELS[c].name).join("、")}` : ""}`} state={stepState(1)} />
        <Step
          index="2"
          title={
            active.length > 0
              ? `等待风险解除（剩余 ${active.length} 路：${active.map((c) => CHANNELS[c].name).join("、")}）`
              : "全部风险通道已解除"
          }
          state={stepState(2)}
        />
        <Step
          index="3"
          title={confirmed ? `值班负责人已确认：${ep?.confirmedBy}` : "值班负责人确认风险解除"}
          state={stepState(3)}
        />
        <Step index="4" title="复位联锁，恢复提升与回转" state={stepState(4)} />
      </div>

      <div className="actions">
        <button className="primary" disabled={!ep} onClick={doConfirm}>
          确认风险解除
        </button>
        <button className="safe-btn" disabled={!ep} onClick={doReset}>
          复位联锁
        </button>
      </div>

      <div className={`msg-line ${msg && !msg.ok ? "err" : "ok"}`}>{msg?.text ?? ""}</div>

      {ep && (
        <div className="ep-meta">
          <div>回合编号：<b>{ep.id}</b>{ep.failSafe && <span className="fault-tag" style={{ marginLeft: 8 }}>安全联锁</span>}</div>
          <div>触发时间：<b>{fmtTime(ep.triggeredAt)}</b></div>
          <div>
            触发值：
            <b>
              {ep.channels
                .map((c) => {
                  const tv = ep.triggerValues[c];
                  return `${CHANNELS[c].name}=${tv === null || tv === undefined ? "异常" : `${tv.toFixed(tv < 10 ? 2 : 1)}${CHANNELS[c].unit}`}`;
                })
                .join("，")}
            </b>
          </div>
          {ep.clearedAt && !ep.failSafe && (
            <div>
              解除时间/值：
              <b>
                {fmtTime(ep.clearedAt)}（
                {ep.channels
                  .map((c) => {
                    const cv = ep.clearValues[c];
                    return `${CHANNELS[c].name}=${cv === null || cv === undefined ? "异常" : `${cv.toFixed(cv < 10 ? 2 : 1)}${CHANNELS[c].unit}`}`;
                  })
                  .join("，")}
                ）
              </b>
            </div>
          )}
          {ep.regressed && <div style={{ color: "#ff8f86" }}>确认前风险反复，已重新计时，须再次确认</div>}
          {!session && <div>未登录：确认/复位将被拒绝并记录；请值班负责人登录</div>}
        </div>
      )}
    </section>
  );
}
