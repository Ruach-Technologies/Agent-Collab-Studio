import { useEffect, useMemo, useRef, useState } from "react";
import type { UiMessage, UiRoom } from "../types";
import { useHub } from "../lib/store";
import { agentColor } from "../lib/colors";
import { hhmmss } from "../lib/time";
import { Empty, ErrorLine, Pane, Tag } from "../components/bits";

export default function Rooms() {
  const hub = useHub();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newRoom, setNewRoom] = useState("");
  const selected = hub.rooms.find((room) => room.id === selectedId) ?? null;
  return <div className="view">
    <header className="view-head"><h1>rooms</h1><span className="pill pill-dim">{hub.rooms.length}</span><span className="spacer" /><button className="btn" onClick={() => void hub.refreshRooms()}>refresh</button></header>
    {hub.me?.role === "supervisor" && <form className="compose-row" onSubmit={(event) => { event.preventDefault(); if (newRoom.trim()) void hub.createRoom(newRoom.trim()).then((ok) => { if (ok) setNewRoom(""); }); }}>
      <input className="gate-input" aria-label="New room name" placeholder="new room name" maxLength={80} value={newRoom} onChange={(event) => setNewRoom(event.target.value)} />
      <button className="btn" disabled={!newRoom.trim()}>create room</button>{hub.error("create") && <ErrorLine>{hub.error("create")}</ErrorLine>}
    </form>}
    <div className="rooms-layout">
      <Pane title="room roster" className="room-list">
        {hub.error("rooms") ? <ErrorLine onRetry={() => void hub.refreshRooms()}>{hub.error("rooms")}</ErrorLine> : null}
        {hub.rooms.length === 0 ? <Empty>no rooms visible</Empty> : hub.rooms.map((room) => {
          const online = hub.presence[room.id]?.length ?? 0;
          return <button className={`room-row ${selected?.id === room.id ? "active" : ""}`} key={room.id} onClick={() => setSelectedId(room.id)}>
            <span className={`dot ${online ? "dot-on" : "dot-off"}`} /><span className="room-row-main"><span className="room-row-title">{room.name}</span><span className="room-row-sub">/{room.slug}</span></span>{online > 0 && <span className="count">{online}</span>}
          </button>;
        })}
      </Pane>
      {selected ? <RoomDetail room={selected} /> : <Pane title="conversation" grow><Empty>select a room to view conversation</Empty></Pane>}
    </div>
  </div>;
}

function RoomDetail({ room }: { room: UiRoom }) {
  const hub = useHub();
  const messages = hub.messagesByRoom[room.id] ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => { void hub.refreshMessages(room.id); }, [room.id]);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length, following]);
  const knownMembers = hub.membersByRoom[room.id] ?? [];
  const online = new Set(hub.presence[room.id] ?? []);
  return <Pane title={room.name} grow className="room-detail" right={<><span className="dim small">/{room.slug}</span>{room.project && <Tag tone="info">{room.project}</Tag>}</>}>
    <div className="presence-strip">
      {knownMembers.length === 0 ? <span className="muted xsmall">presence updates appear here when received</span> : knownMembers.map((id) => <Member key={id} id={id} online={online.has(id)} />)}
    </div>
    {hub.error(`messages:${room.id}`) && <ErrorLine onRetry={() => void hub.refreshMessages(room.id)}>{hub.error(`messages:${room.id}`)}</ErrorLine>}
    <div className="msg-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 28); }}>
      {messages.length === 0 ? <Empty>no messages yet</Empty> : <ThreadedMessages messages={messages} />}
    </div>
    {hub.me?.role !== "observer" && <><button className="btn" onClick={() => void hub.joinRoom(room.id)}>join room</button><Compose room={room} recipients={knownMembers} /></>}
  </Pane>;
}

function Member({ id, online }: { id: string; online: boolean }) {
  const hub = useHub(); const name = hub.agentName(id); const color = agentColor(name).color;
  return <span className={`chip ${online ? "" : "off"}`} style={{ borderColor: color, color }}><span className="chip-dot" style={{ background: color }} />{name}</span>;
}

function ThreadedMessages({ messages }: { messages: UiMessage[] }) {
  const hub = useHub();
  // Room-wide messages are roots; following DMs visually nest under the active exchange.
  const groups = useMemo(() => {
    const result: Array<{ root: UiMessage; replies: UiMessage[] }> = [];
    for (const message of messages) {
      if (!message.to || result.length === 0) result.push({ root: message, replies: [] });
      else {
        const previous = result[result.length - 1];
        if (previous) previous.replies.push(message);
      }
    }
    return result;
  }, [messages]);
  return <>{groups.map(({ root, replies }) => <div className="thread" key={root.id}><MessageRow message={root} />{replies.map((message) => <MessageRow message={message} reply key={message.id} />)}</div>)}</>;
  function MessageRow({ message, reply = false }: { message: UiMessage; reply?: boolean }) {
    const name = hub.agentName(message.from); const color = agentColor(name).color;
    return <div className={`msg ${reply ? "reply" : ""} ${message.from === hub.me?.id ? "mine" : ""}`}>
      <div className="msg-head"><span className="msg-from" style={{ color }}>{name}</span>{message.to && <span className="dm-arrow">dm → {hub.agentName(message.to)}</span>}<span className="dim xsmall">{hhmmss(message.createdAt)}</span></div>
      <div className="msg-body">{message.body}</div>
    </div>;
  }
}

function Compose({ room, recipients }: { room: UiRoom; recipients: string[] }) {
  const hub = useHub(); const [body, setBody] = useState(""); const [to, setTo] = useState(""); const [sending, setSending] = useState(false);
  const send = async () => { if (!body.trim() || sending) return; setSending(true); const ok = await hub.postMessage(room.id, body.trim(), to || undefined); if (ok) setBody(""); setSending(false); };
  return <div className="compose">
    {hub.error(`post:${room.id}`) && <ErrorLine>{hub.error(`post:${room.id}`)}</ErrorLine>}
    <div className="compose-row"><select className="dm-select" value={to} onChange={(event) => setTo(event.target.value)}><option value="">to: room</option>{recipients.filter((id) => id !== hub.me?.id).map((id) => <option value={id} key={id}>dm: {hub.agentName(id)}</option>)}</select>
    <textarea className="compose-input" rows={2} placeholder="message… Enter to send · Shift+Enter for newline" value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
    <button className="btn btn-primary" disabled={!body.trim() || sending} onClick={() => void send()}>{sending ? "…" : "send"}</button></div>
    <span className="compose-hint">{to ? "direct message" : "room-wide post"}</span>
  </div>;
}
