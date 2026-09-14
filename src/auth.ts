import type { Supervisor } from "./types";

/**
 * 演示账户。现场实现应对接工控账号/人员卡/Key，
 * 授权判定必须在服务端或联锁控制器侧完成，前端只做最小身份闸门。
 */
export const USERS: (Supervisor & { role: "supervisor" | "operator" | "viewer" })[] = [
  { username: "lzb", name: "李值班（值班负责人）", password: "123456", role: "supervisor" },
  { username: "wzg", name: "王班长（值班负责人）", password: "123456", role: "supervisor" },
  { username: "sg", name: "赵司钻（操作员）", password: "123456", role: "operator" },
  { username: "guest", name: "观摩人员", password: "123456", role: "viewer" },
];

export type Role = "supervisor" | "operator" | "viewer";

export interface Session {
  username: string;
  name: string;
  role: Role;
  loginAt: number;
}

const SESSION_KEY = "rig-safety.session.v1";

export function login(username: string, password: string): Session | null {
  const u = USERS.find((x) => x.username === username.trim() && x.password === password);
  if (!u) return null;
  const session: Session = { username: u.username, name: u.name, role: u.role, loginAt: Date.now() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function currentSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s.username || !s.role) return null;
    return s;
  } catch {
    return null;
  }
}
