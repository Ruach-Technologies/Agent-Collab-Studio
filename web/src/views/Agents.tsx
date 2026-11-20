import { useMemo, useState } from "react";
import { useHub } from "../lib/store";
import { agentColor } from "../lib/colors";
import { ago, hhmmss } from "../lib/time";
import { Empty, ErrorLine, Pane, Tag } from "../components/bits";

const tone: Record<string, "ok" | "info" | "dim"> = { supervisor: "ok", agent: "info", observer: "dim" };

export default function Agents() {
  const hub = useHub(); const [role, setRole] = useState("all"); const [query, setQuery] = useState("");
  const agents = useMemo(() => hub.agents.filter((agent) => (role === "all" || agent.role === role) && (!query.trim() || `${agent.name} ${agent.id}`.toLowerCase().includes(query.trim().toLowerCase()))).sort((a, b) => a.name.localeCompare(b.name)), [hub.agents, role, query]);
  return <div className="view"><header className="view-head"><h1>agents</h1><span className="pill pill-dim">{hub.agents.length} registered</span><span className="spacer" /><select value={role} onChange={(event) => setRole(event.target.value)}><option value="all">all roles</option><option value="supervisor">supervisor</option><option value="agent">agent</option><option value="observer">observer</option></select><input className="search" placeholder="search…" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="btn" onClick={() => void hub.refreshAgents()}>refresh</button></header>
    {hub.error("agents") && <ErrorLine onRetry={() => void hub.refreshAgents()}>{hub.error("agents")}</ErrorLine>}
    <Pane title="roster" grow scroll>{agents.length === 0 ? <Empty>no agents match this roster</Empty> : <table className="roster"><thead><tr><th>agent</th><th>role</th><th>last seen</th><th>token metadata</th><th>created</th></tr></thead><tbody>{agents.map((agent) => { const color = agentColor(agent.name).color; return <tr key={agent.id}><td><span className="agent-name-cell" style={{ color }}>{agent.name}</span><span className="agent-id-cell">{agent.id}</span></td><td><Tag tone={tone[agent.role] ?? "dim"}>{agent.role}</Tag></td><td>{agent.lastSeenAt ? `${hhmmss(agent.lastSeenAt)} · ${ago(agent.lastSeenAt)} ago` : "never"}</td><td className="token-meta">{agent.tokenMeta.length ? agent.tokenMeta.map((item) => `${item.label}: ${item.value}`).join(" · ") : "not exposed"}</td><td className="token-meta">{agent.createdAt ? hhmmss(agent.createdAt) : "—"}</td></tr>; })}</tbody></table>}</Pane>
    <span className="muted xsmall">Identity metadata only. Token values and hashes are never sent to this UI.</span>
  </div>;
}
