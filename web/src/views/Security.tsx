// Security monitoring: what left (or tried to leave) through the sealed network's gate, and the
// alerts that need a person. The operator sees every workspace; a supervisor sees their own.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHub } from "../lib/store";
import { ago, hhmmss } from "../lib/time";
import { Empty, ErrorLine, Pane, Tag, type TagTone } from "../components/bits";
import {
  api, SECURITY_ALERT_EVENT,
  type SecurityAlert, type SecuritySeverity, type SecurityStatus, type SecuritySummary, type SecurityTrafficRow, type SecurityWindow,
} from "../lib/api";

const PROFILES: Array<{ id: string; title: string; allows: string }> = [
  { id: "packages", title: "Dependency installs", allows: "HTTPS to the npm, Yarn and PyPI registries and GitHub downloads. Nothing else, and no install scripts run." },
  { id: "github", title: "GitHub steps", allows: "HTTPS to github.com and codeload.github.com only, for clones and pushes that a person started." },
  { id: "sidekick", title: "Sidekicks", allows: "HTTPS to Anthropic and OpenAI sign-in and model APIs, plus this hub's own /mcp endpoint. Never the Mac, the local network or other sites." },
];
const SEVERITY_TONE: Record<SecuritySeverity, TagTone> = { high: "bad", medium: "warn", low: "info" };
const KIND_LABEL: Record<string, string> = { sidekick: "sidekick", install: "install", git: "GitHub step", exec: "command", room: "workspace", sandbox: "workspace", dev: "dev server", unknown: "unrecognised", gate: "gate" };

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

/** "Gate running · sealed network ok · last log read 5 s ago" */
function statusLine(status: SecurityStatus | null): { text: string; tone: "ok" | "warn" | "bad" | "dim" } {
  if (!status) return { text: "status unknown", tone: "dim" };
  if (!status.enabled) return { text: "Egress gate turned off on this hub (HUB_EGRESS_GATE=off) · nothing to monitor", tone: "dim" };
  if (status.docker === false) return { text: "Docker is not reachable · gate traffic cannot be read", tone: "bad" };
  const parts: string[] = [];
  let tone: "ok" | "warn" | "bad" = "ok";
  if (status.gate.network_ok === false) { parts.push("sealed network not created yet (nothing has needed the internet)"); tone = "warn"; }
  else {
    parts.push(status.gate.running ? "Gate running" : status.gate.running === false ? "Gate NOT running" : "Gate not checked yet");
    if (status.gate.running === false) tone = "bad";
    if (status.gate.network_ok) parts.push("sealed network ok");
  }
  parts.push(status.last_read_at ? `last log read ${ago(status.last_read_at)} ago` : status.monitoring ? "log not read yet" : "collector not running");
  if (!status.monitoring) parts.push("periodic collection off; use refresh");
  if (status.last_error) { parts.push(status.last_error); if (tone === "ok") tone = "warn"; }
  return { text: parts.join(" · "), tone };
}

export default function Security() {
  const hub = useHub();
  const [windowId, setWindowId] = useState<SecurityWindow>("24h");
  const [workspace, setWorkspace] = useState<string>("");
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [traffic, setTraffic] = useState<SecurityTrafficRow[]>([]);
  const [showAcked, setShowAcked] = useState(false);
  const [decision, setDecision] = useState("");
  const [profile, setProfile] = useState("");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = hub.operator ? (workspace || undefined) : undefined;

  const load = useCallback(async () => {
    try {
      const [nextSummary, nextAlerts, nextTraffic] = await Promise.all([
        api.securitySummary(windowId, scope),
        api.securityAlerts(showAcked ? "all" : "open", scope),
        api.securityTraffic({ workspace: scope, window: windowId, decision: decision || undefined, profile: profile || undefined, source_kind: kind || undefined, limit: 300 }),
      ]);
      setSummary(nextSummary); setAlerts(nextAlerts); setTraffic(nextTraffic); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load security data"); }
  }, [windowId, scope, showAcked, decision, profile, kind]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15_000); return () => clearInterval(timer); }, [load]);
  // New alerts arrive over the live line; reload rather than trusting the pushed copy.
  useEffect(() => { const onAlert = () => void load(); window.addEventListener(SECURITY_ALERT_EVENT, onAlert); return () => window.removeEventListener(SECURITY_ALERT_EVENT, onAlert); }, [load]);

  const refreshNow = async () => {
    setBusy(true);
    try { await api.refreshSecurity(); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Refresh failed"); } finally { setBusy(false); }
  };
  const acknowledge = async (id: string) => {
    try { await api.ackSecurityAlert(id); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not acknowledge"); }
  };

  const status = statusLine(summary?.status ?? null);
  const open = summary?.alerts_open ?? { high: 0, medium: 0, low: 0 };
  const openTotal = open.high + open.medium + open.low;
  const visibleTraffic = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? traffic.filter((row) => `${row.host} ${row.room_name ?? ""} ${row.sidekick_name ?? ""} ${row.container_name ?? ""} ${row.workspace_name ?? ""}`.toLowerCase().includes(needle)) : traffic;
  }, [traffic, query]);
  const where = (row: { workspace_name?: string | null; room_name?: string | null; sidekick_name?: string | null; container_name?: string | null; source_kind?: string; actor_name?: string | null }) =>
    [hub.operator && !scope ? row.workspace_name : null, row.room_name, row.sidekick_name ?? row.actor_name, !row.room_name && !row.sidekick_name ? row.container_name : null].filter(Boolean).join(" · ") || "hub";

  return <div className="view security-view">
    <header className="view-head"><h1>security</h1>
      <span className={`pill ${open.high ? "pill-bad" : openTotal ? "pill-warn" : "pill-ok"}`}>{openTotal} open alert{openTotal === 1 ? "" : "s"}</span>
      <span className="pill pill-dim">{summary?.scope.all_workspaces ? "all workspaces" : "this workspace"}</span>
      <span className="spacer" />
      {hub.operator && <select aria-label="Workspace filter" value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
        <option value="">all workspaces</option>{hub.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
      <select aria-label="Time window" value={windowId} onChange={(event) => setWindowId(event.target.value as SecurityWindow)}>
        <option value="1h">last hour</option><option value="24h">last 24 hours</option><option value="7d">last 7 days</option><option value="30d">last 30 days</option>
      </select>
      <button className="btn" disabled={busy} onClick={() => void refreshNow()}>{busy ? "reading…" : "refresh"}</button>
    </header>
    <div className={`security-status security-status-${status.tone}`} role="status">{status.text}</div>
    {error && <ErrorLine onRetry={() => void load()}>{error}</ErrorLine>}

    <Pane title="alerts" right={<label className="check"><input type="checkbox" checked={showAcked} onChange={(event) => setShowAcked(event.target.checked)} />show acknowledged</label>}>
      {alerts.length === 0 ? <Empty>{showAcked ? "no alerts" : "nothing needs attention"}</Empty> : <ul className="security-alerts">{alerts.map((alert) => <li key={alert.id} className={`security-alert security-alert-${alert.severity}${alert.acknowledged_at ? " security-alert-done" : ""}`}>
        <div className="security-alert-head">
          <Tag tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</Tag>
          <span className="security-alert-title">{alert.title}</span>
          {alert.count > 1 && <span className="pill pill-dim">×{alert.count}</span>}
          <span className="spacer" />
          {alert.acknowledged_at ? <span className="muted xsmall">acknowledged {ago(alert.acknowledged_at)} ago</span>
            : <button className="btn btn-small" onClick={() => void acknowledge(alert.id)}>Acknowledge</button>}
        </div>
        <div className="security-alert-detail">{alert.detail}</div>
        <div className="muted xsmall">{where(alert)} · first {hhmmss(alert.first_seen)} ({ago(alert.first_seen)} ago) · last {hhmmss(alert.last_seen)} · {alert.rule}</div>
      </li>)}</ul>}
    </Pane>

    <div className="security-cards">
      <div className="security-card"><span className="security-card-n">{summary?.allowed ?? 0}</span><span className="muted xsmall">allowed connections</span></div>
      <div className="security-card"><span className={`security-card-n${summary?.denied ? " security-bad" : ""}`}>{summary?.denied ?? 0}</span><span className="muted xsmall">refused</span></div>
      <div className="security-card"><span className="security-card-n">{formatBytes(summary?.bytes_up ?? 0)}</span><span className="muted xsmall">sent out</span></div>
      <div className="security-card"><span className="security-card-n">{formatBytes(summary?.bytes_down ?? 0)}</span><span className="muted xsmall">downloaded</span></div>
    </div>

    <div className="security-grid">
      <Pane title="by destination">
        {!summary?.top_destinations.length ? <Empty>no gate traffic in this window</Empty> : <table className="roster"><thead><tr><th>host</th><th>allowed</th><th>refused</th><th>out</th><th>in</th></tr></thead>
          <tbody>{summary.top_destinations.map((row) => <tr key={row.host}><td className="mono-id">{row.host}</td><td>{row.allowed}</td><td>{row.denied ? <Tag tone="bad">{row.denied}</Tag> : 0}</td><td>{formatBytes(row.bytes_up)}</td><td>{formatBytes(row.bytes_down)}</td></tr>)}</tbody></table>}
      </Pane>
      <Pane title="by room / sidekick">
        {!summary?.top_sources.length ? <Empty>no gate traffic in this window</Empty> : <table className="roster"><thead><tr><th>source</th><th>kind</th><th>allowed</th><th>refused</th><th>out</th></tr></thead>
          <tbody>{summary.top_sources.map((row) => <tr key={row.source_key}><td>{row.sidekick_name ?? row.room_name ?? row.container_name ?? row.source_key}</td>
            <td><Tag tone={row.source_kind === "unknown" ? "bad" : "dim"}>{KIND_LABEL[row.source_kind] ?? row.source_kind}</Tag></td>
            <td>{row.allowed}</td><td>{row.denied ? <Tag tone="bad">{row.denied}</Tag> : 0}</td><td>{formatBytes(row.bytes_up)}</td></tr>)}</tbody></table>}
      </Pane>
    </div>

    <Pane title="traffic" grow scroll right={<span className="muted xsmall">grouped per source, destination and minute · host names only</span>}>
      <div className="filterbar">
        <select aria-label="Decision" value={decision} onChange={(event) => setDecision(event.target.value)}><option value="">allowed and refused</option><option value="allow">allowed</option><option value="deny">refused</option></select>
        <select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value)}><option value="">all profiles</option>{PROFILES.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>
        <select aria-label="Source" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">all sources</option>{["sidekick", "install", "git", "unknown"].map((item) => <option key={item} value={item}>{KIND_LABEL[item]}</option>)}</select>
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter by host, room or sidekick…" />
      </div>
      {visibleTraffic.length === 0 ? <Empty>no matching traffic</Empty> : <table className="roster"><thead><tr><th>time</th><th>decision</th><th>profile</th><th>destination</th><th>from</th><th>count</th><th>out / in</th></tr></thead>
        <tbody>{visibleTraffic.map((row) => <tr key={row.id}>
          <td title={row.first_at}>{hhmmss(row.last_at)}</td>
          <td><Tag tone={row.decision === "deny" ? "bad" : "ok"}>{row.decision === "deny" ? `refused${row.reason ? ` (${row.reason})` : ""}` : "allowed"}</Tag></td>
          <td>{row.profile}</td>
          <td className="mono-id">{row.host}</td>
          <td>{where(row)} <Tag tone={row.source_kind === "unknown" ? "bad" : "dim"}>{KIND_LABEL[row.source_kind] ?? row.source_kind}</Tag></td>
          <td>{row.count}</td>
          <td>{row.bytes_up || row.bytes_down ? `${formatBytes(row.bytes_up)} / ${formatBytes(row.bytes_down)}` : "—"}</td>
        </tr>)}</tbody></table>}
    </Pane>

    <Pane title="what each gate profile allows">
      <ul className="security-profiles">{PROFILES.map((item) => {
        const counts = summary?.by_profile.find((row) => row.profile === item.id);
        return <li key={item.id}><strong>{item.title}</strong> <span className="muted xsmall">({item.id})</span> — {item.allows}
          {counts && <span className="muted xsmall"> · {counts.allowed} allowed, {counts.denied} refused in this window</span>}</li>;
      })}</ul>
      <p className="muted xsmall">Every container that needs the internet sits on a sealed Docker network and leaves only through the gate. Anything refused here never left the machine. Workspace commands and dev servers have no network at all.</p>
    </Pane>
  </div>;
}
