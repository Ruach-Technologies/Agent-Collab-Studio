import { useEffect, useMemo, useRef, useState } from "react";
import type { EventEntry, } from "../lib/store";
import type { UiEvent } from "../types";
import { useHub } from "../lib/store";
import { agentColor } from "../lib/colors";
import { hhmmss } from "../lib/time";
import { Empty } from "../components/bits";

const TONES: Record<string, string> = {
  "auth.ok": "ok", "auth.denied": "bad", "ratelimit.hit": "bad",
  "room.created": "info", "room.joined": "info", "message.created": "msg",
  "sandbox.requested": "warn", "sandbox.ready": "ok", "sandbox.error": "bad",
  "sandbox.exec.started": "warn", "sandbox.exec.result": "info", "sandbox.exec.denied": "bad",
  "file.read": "dim", "file.write": "info",
  "ws.connect": "dim", "ws.disconnect": "dim",
};
export const eventTone = (type: string) => TONES[type] ?? "dim";

export function describeEvent(event: UiEvent, agentName: (id: string | null) => string, roomName: (id: string | null) => string): string {
  const actor = agentName(event.actorId) || "system";
  const room = roomName(event.roomId) || "hub";
  const detail = event.detail ?? {};
  const text = (key: string) => {
    const value = detail[key];
    return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  };
  switch (event.type) {
    case "room.created": return `${actor} created ${text("name") || room}`;
    case "room.joined": return `${actor} joined ${room}`;
    case "message.created": {
      const message = detail.message as { body?: string; to_agent_id?: string } | undefined;
      return `${actor}${message?.to_agent_id ? ` → ${agentName(message.to_agent_id)}` : ` in ${room}`}: ${message?.body ?? "message"}`;
    }
    case "sandbox.requested": return `${actor} requested sandbox in ${room}`;
    case "sandbox.ready": return `sandbox ready in ${room}`;
    case "sandbox.exec.started": return `${actor} exec ${text("cmd") || "command"} in ${room}`;
    case "sandbox.exec.result": return `${actor} completed exec in ${room} · exit ${text("exit_code")} · ${text("duration_ms")}ms`;
    case "file.read": return `${actor} read ${text("path") || "file"} in ${room}`;
    case "file.write": return `${actor} wrote ${text("path") || "file"} in ${room}`;
    case "auth.ok": return `${actor} authenticated`;
    case "auth.denied": return `authentication denied${text("reason") ? ` — ${text("reason")}` : ""}`;
    case "ratelimit.hit": return `${actor} hit rate limit`;
    case "ws.connect": return `${actor} connected`;
    case "ws.disconnect": return `${actor} disconnected`;
    default: return Object.keys(detail).length ? `${event.type} ${JSON.stringify(detail)}` : event.type;
  }
}

export default function LiveFeed() {
  const hub = useHub();
  const [room, setRoom] = useState("all");
  const [agent, setAgent] = useState("all");
  const [type, setType] = useState("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<EventEntry[] | null>(null);
  const [follow, setFollow] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const source = paused && snapshot ? snapshot : hub.events;
  const filtered = useMemo(() => source.filter((entry) => {
    const event = entry as UiEvent;
    if (room !== "all" && event.roomId !== room) return false;
    if (agent !== "all" && event.actorId !== agent) return false;
    if (type !== "all" && event.type !== type) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${event.type} ${hub.agentName(event.actorId)} ${hub.roomName(event.roomId)} ${JSON.stringify(event.detail ?? {})}`.toLowerCase().includes(needle);
  }), [source, room, agent, type, query, hub]);
  const types = useMemo(() => [...new Set(hub.events.map((event) => event.type))].sort(), [hub.events]);
  useEffect(() => { if (follow && !paused && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [filtered.length, follow, paused]);
  const pause = () => { setSnapshot(hub.events); setPaused(true); };
  const resume = () => { setSnapshot(null); setPaused(false); setFollow(true); };
  const newCount = paused && snapshot ? Math.max(0, hub.events.length - snapshot.length) : 0;
  return <div className="view">
    <header className="view-head"><h1>live feed</h1><span className={`pill pill-${hub.wsStatus === "open" ? "ok" : "warn"}`}>{hub.wsStatus}</span><span className="pill pill-dim">{filtered.length}/{source.length}</span><span className="spacer" />
      <button className={paused ? "btn btn-primary" : "btn"} onClick={paused ? resume : pause}>{paused ? `resume${newCount ? ` +${newCount}` : ""}` : "pause"}</button>
    </header>
    <div className="filterbar">
      <select value={room} onChange={(event) => setRoom(event.target.value)}><option value="all">all rooms</option>{hub.rooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">all agents</option>{hub.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select value={type} onChange={(event) => setType(event.target.value)}><option value="all">all types</option>{types.map((item) => <option key={item}>{item}</option>)}</select>
      <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter events…" />
      <label className="check"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />follow</label>
    </div>
    <div className="feed" ref={feed} onScroll={() => { const el = feed.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 28); }}>
      {filtered.length === 0 ? <Empty>{paused ? "feed paused" : "no events yet"}</Empty> : filtered.map((entry) => {
        const event = entry as UiEvent;
        const name = hub.agentName(event.actorId);
        return <div className={`feed-row tone-${eventTone(event.type)}`} key={entry.key}>
          <span className="feed-ts">{hhmmss(event.createdAt)}</span><span className={`tag tag-${eventTone(event.type)}`}>{event.type}</span>
          {event.roomId && <span className="feed-room">{hub.roomName(event.roomId)}</span>}
          <span className="feed-text">{name && <span className="feed-actor" style={{ color: agentColor(name).color }}>[{name}]</span>} {describeEvent(event, hub.agentName, hub.roomName)}</span>
        </div>;
      })}
    </div>
  </div>;
}
