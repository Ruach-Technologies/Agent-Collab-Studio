import type { ReactNode } from "react";
import type { ConnState, UiAgent, ViewId } from "../types";
import { agentColor } from "../lib/colors";
import { ThemePicker } from "./ThemePicker";

const join = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Spinner({ label }: { label?: string }) { return <span className="spinner"><span className="spinner-dot" />{label}</span>; }
export function ErrorLine({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return <div className="error-line"><span>{children}</span>{onRetry && <button className="btn btn-small" onClick={onRetry}>retry</button>}</div>;
}

export type TagTone = "ok" | "warn" | "bad" | "info" | "dim" | "msg";
export function Tag({ tone = "dim", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function Pane({
  title, right, children, className, grow, scroll,
}: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; grow?: boolean; scroll?: boolean;
}) {
  return <section className={join("pane", className, grow && "grow")}>
    {title !== undefined && <header className="pane-head"><span className="pane-title">{title}</span>{right && <span className="pane-right">{right}</span>}</header>}
    <div className={join("pane-body", scroll && "pane-scroll")}>{children}</div>
  </section>;
}

const nav: Array<{ id: ViewId; label: string; glyph: string }> = [
  { id: "feed", label: "Live Feed", glyph: "≡" },
  { id: "rooms", label: "Rooms", glyph: "#" },
  { id: "sandbox", label: "Sandbox", glyph: "▪" },
  { id: "agents", label: "Agents", glyph: "◉" },
  { id: "audit", label: "Audit", glyph: "!" },
  { id: "security", label: "Security", glyph: "⛨" },
];
const label: Record<ConnState, string> = { offline: "offline", connecting: "connecting…", live: "live", reconnecting: "reconnecting…" };

export function Sidebar({
  view, onNavigate, me, conn, roomCount, agentCount, eventCount, onSignOut, workspaces = [], onSwitchWorkspace, onOpenStudio,
}: {
  onOpenStudio?: () => void;
  workspaces?: Array<{ id: string; name: string }>; onSwitchWorkspace?: (id: string) => void;
  view: ViewId; onNavigate: (view: ViewId) => void; me: UiAgent | null; conn: ConnState;
  roomCount: number; agentCount: number; eventCount: number; onSignOut: () => void;
}) {
  const accent = me ? agentColor(me.name).color : undefined;
  return <aside className="sidebar">
    <div className="brand"><span className="brand-name">ACH</span><span className="brand-sub">ops console</span></div>
    {onOpenStudio && <button className="btn btn-primary sidebar-studio" onClick={onOpenStudio}>Open Studio</button>}
    <div className="sidebar-conn"><span className={join("dot", conn === "live" ? "dot-on" : conn === "offline" ? "dot-bad" : "dot-warn")} />{label[conn]}</div>
    <nav className="sidebar-nav">
      {nav.map((item) => <button key={item.id} className={join("nav-item", view === item.id && "nav-active")} onClick={() => onNavigate(item.id)}>
        <span className="nav-glyph">{item.glyph}</span><span className="nav-label">{item.label}</span>
        {item.id === "feed" && eventCount > 0 && <span className="nav-badge">{eventCount > 99 ? "99+" : eventCount}</span>}
      </button>)}
    </nav>
    <div className="sidebar-foot">
      {me ? <><span className="who-name" style={{ color: accent }}>{me.name}</span><span className="who-role">{workspaces.length > 0 ? "operator" : me.role}</span>
        {workspaces.length > 0 && onSwitchWorkspace
          ? <select className="workspace-switch" aria-label="Workspace" value={me.workspaceId ?? ""} onChange={(event) => onSwitchWorkspace(event.target.value)}>
            {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          : <span className="muted xsmall" aria-label="Authenticated workspace" title={me.workspaceId ?? "Legacy hub — upgrade required"}>{me.workspaceName ?? me.workspaceId ?? "Legacy hub"}</span>}
      </> : <span className="muted small">not signed in</span>}
      <div className="sidebar-foot-row"><span className="muted xsmall">{roomCount} rooms · {agentCount} agents</span><button className="btn btn-small" onClick={onSignOut}>sign out</button></div>
      <ThemePicker />
    </div>
  </aside>;
}
