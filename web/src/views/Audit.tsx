import { useMemo } from "react";
import type { UiEvent } from "../types";
import { useHub } from "../lib/store";
import { hhmmss } from "../lib/time";
import { Empty, Pane, Tag } from "../components/bits";

const audit = (event: UiEvent) => event.type.startsWith("auth.") || event.type === "ratelimit.hit";
const severity = (event: UiEvent): [string, "ok" | "warn" | "bad"] => event.type === "auth.ok" ? ["OK", "ok"] : event.type === "ratelimit.hit" ? ["LIMIT", "warn"] : ["DENIED", "bad"];

export default function Audit() {
  const hub = useHub();
  const events = useMemo(() => hub.events.filter(audit).slice().reverse(), [hub.events]);
  const denials = events.filter((event) => event.type !== "auth.ok").length;
  return <div className="view"><header className="view-head"><h1>audit</h1><span className="pill pill-dim">{events.length} security events</span><span className={`pill ${denials ? "pill-bad" : "pill-dim"}`}>{denials} denials/limits</span><span className="spacer" /><button className="btn" onClick={() => void hub.refreshEvents()}>refresh</button></header>
    <Pane title="auth / denial / rate-limit" grow scroll right={<span className="muted small">ws {hub.wsStatus}</span>}>
      {hub.error("events") && <div className="error-line">{hub.error("events")}</div>}
      {events.length === 0 ? <Empty>no audit events</Empty> : <table className="roster"><thead><tr><th>time</th><th>severity</th><th>type</th><th>actor</th><th>detail</th></tr></thead><tbody>{events.map((event) => { const [label, tone] = severity(event); return <tr key={event.key}><td>{hhmmss(event.createdAt)}</td><td><Tag tone={tone}>{label}</Tag></td><td>{event.type}</td><td>{hub.agentName(event.actorId) || "—"}</td><td className="token-meta">{event.detail ? JSON.stringify(event.detail) : "—"}</td></tr>; })}</tbody></table>}
    </Pane>
  </div>;
}
