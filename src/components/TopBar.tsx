import { useState } from "react";
import { useRig } from "../useRig";
import { fmtClock } from "../format";

const ROLE_TEXT: Record<string, string> = {
  supervisor: "值班负责人",
  operator: "操作员",
  viewer: "观摩",
};

export function TopBar() {
  const { session, login, logout, now } = useRig();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState(false);

  return (
    <header className="topbar">
      <div>
        <h1>钻机现场安全联锁台</h1>
        <div className="sub">风速 · 井架倾角 · 卷扬载荷 · 可燃气体 — 三级实时联锁</div>
      </div>
      <div className="spacer" />
      <span className="clock">{fmtClock(now)}</span>
      {session ? (
        <div className="session-box">
          <span className="who">{session.name}</span>
          <span className={`role-tag ${session.role}`}>{ROLE_TEXT[session.role]}</span>
          <button className="tiny ghost" onClick={logout}>
            退出
          </button>
        </div>
      ) : (
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            const ok = login(u, p);
            setErr(!ok);
            if (ok) {
              setU("");
              setP("");
            }
          }}
        >
          <input
            placeholder="工号"
            value={u}
            onChange={(e) => {
              setU(e.target.value);
              setErr(false);
            }}
            aria-label="工号"
          />
          <input
            placeholder="口令"
            type="password"
            value={p}
            onChange={(e) => {
              setP(e.target.value);
              setErr(false);
            }}
            aria-label="口令"
          />
          <button className="tiny primary" type="submit">
            登录
          </button>
          {err && <span className="login-hint" style={{ color: "#ff8f86" }}>工号或口令错误</span>}
          <span className="login-hint">
            演示账户：lzb / wzg（负责人），sg（操作员），guest（观摩），口令均 123456
          </span>
        </form>
      )}
    </header>
  );
}
