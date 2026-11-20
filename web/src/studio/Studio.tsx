// Collab Studio: the client-facing room. People on the left, the conversation in the middle and
// the work happening live on the right. The ops console stays available to staff.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useHub } from "../lib/store";
import { api, getToken, type MemberProfile } from "../lib/api";
import { SESSION_TOKEN } from "../lib/device";
import { PasskeyNudge, SessionPanel, SignInLinkButton } from "./Session";
import { Avatar, AvatarPicker, resolveAvatar } from "../components/Avatar";
import { ThemePicker } from "../components/ThemePicker";
import { agentColor } from "../lib/colors";
import type { AvatarId } from "../lib/avatars";
import { toActivity, type Activity } from "./activity";
import type { UiMessage } from "../types";
import Sandbox from "../views/Sandbox";
import { StudioLogo } from "./StudioLogo";
import SidekickCard from "./SidekickCard";
import LiveAgents from "./LiveAgents";
import Board from "./Board";
import DevServer from "./DevServer";

const ROOM_KEY = "agent-collab-hub.studio.room";
const readRoom = () => { try { return localStorage.getItem(ROOM_KEY); } catch { return null; } };
const saveRoom = (id: string) => { try { localStorage.setItem(ROOM_KEY, id); } catch { /* storage unavailable */ } };

const clock = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const roleLabel = (member: MemberProfile) =>
  member.sidekickOf ? "Sidekick" : member.guest ? "Client" : member.role === "supervisor" ? "Reviewer" : member.role === "observer" ? "Watching" : "Agent";

type Tab = "overview" | "workspace" | "preview" | "agents";
const TAB_KEY = "agent-collab-hub.studio.tab";
const DOCK_KEY = "agent-collab-hub.studio.dock";
const readTab = (): Tab => { try { const v = localStorage.getItem(TAB_KEY); return v === "workspace" || v === "preview" || v === "agents" ? v : "overview"; } catch { return "overview"; } };
const readDock = (): number => { try { const v = Number(localStorage.getItem(DOCK_KEY)); return Number.isFinite(v) && v >= 120 ? v : 300; } catch { return 300; } };

export default function Studio({ initialRoom, onOpenConsole }: { initialRoom?: string | null; onOpenConsole?: () => void }) {
  const hub = useHub();
  const staff = hub.operator || hub.me?.role === "supervisor";
  // Invited clients sign in with a device-bound session that ends every few hours.
  const clientSession = SESSION_TOKEN.test(getToken() ?? "");
  const [roomId, setRoomId] = useState<string | null>(initialRoom ?? readRoom());
  const [profiles, setProfiles] = useState<Record<string, MemberProfile[]>>({});
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (next: Tab) => { setTabState(next); try { localStorage.setItem(TAB_KEY, next); } catch { /* storage unavailable */ } };
  const [dock, setDock] = useState(readDock);
  const [chatOpen, setChatOpen] = useState(true);

  // Pick a room the viewer can see; remember the choice per device.
  const room = hub.rooms.find((item) => item.id === roomId) ?? hub.rooms[0] ?? null;
  useEffect(() => { if (room && room.id !== roomId) setRoomId(room.id); }, [room, roomId]);
  useEffect(() => { if (room) saveRoom(room.id); }, [room]);

  const loadProfiles = useCallback(async (id: string) => {
    try { const list = await api.memberProfiles(id); setProfiles((current) => ({ ...current, [id]: list })); } catch { /* shown via membership state */ }
  }, []);
  useEffect(() => {
    if (!room) return;
    void hub.refreshMessages(room.id); void loadProfiles(room.id); void hub.refreshSandbox(room.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  // People-related events refresh the roster without a reload.
  const lastPeopleEvent = useMemo(() => [...hub.events].reverse().find((event) => event.roomId === room?.id &&
    ["room.joined", "room.left", "invite.redeemed", "agent.updated", "sidekick.signed_in"].includes(event.type))?.key, [hub.events, room?.id]);
  useEffect(() => { if (room && lastPeopleEvent) void loadProfiles(room.id); }, [lastPeopleEvent, room, loadProfiles]);

  const members = room ? profiles[room.id] ?? [] : [];
  const online = new Set(room ? hub.presence[room.id] ?? [] : []);
  const isMember = !!hub.me && members.some((member) => member.id === hub.me!.id);
  const memberOf = (id: string | null) => members.find((member) => member.id === id);
  const nameOf = useCallback((id: string | null) => members.find((member) => member.id === id)?.name ?? hub.agentName(id), [members, hub]);
  const avatarOf = (id: string | null) => (id === hub.me?.id && myAvatar) ? myAvatar : memberOf(id)?.avatar ?? null;
  const meAvatar = myAvatar ?? memberOf(hub.me?.id ?? null)?.avatar ?? hub.me?.avatar ?? null;
  const agentsWorking = useMemo(() => {
    if (!room) return 0;
    const state = new Map<string, boolean>();
    for (const event of hub.events) if (event.roomId === room.id && event.actorId && (event.type === "sidekick.turn.started" || event.type === "sidekick.turn.finished")) state.set(event.actorId, event.type === "sidekick.turn.started");
    return [...state.values()].filter(Boolean).length;
  }, [hub.events, room]);

  const chooseAvatar = async (id: AvatarId) => {
    setMyAvatar(id);
    try { await api.updateAvatar(id); if (room) void loadProfiles(room.id); } catch { setMyAvatar(null); }
  };
  // Drag the bar above the chat to resize it; the size is remembered on this device.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY; const startHeight = dock;
    const move = (e: PointerEvent) => setDock(Math.round(Math.min(window.innerHeight * 0.75, Math.max(120, startHeight + (startY - e.clientY)))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setDock((height) => { try { localStorage.setItem(DOCK_KEY, String(height)); } catch { /* storage unavailable */ } return height; }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  if (!hub.me) return <div className="studio-loading">Connecting…</div>;
  return <div className="studio" style={{ ["--dock-h" as string]: chatOpen ? `${dock}px` : "44px" }}>
    <header className="studio-top">
      <div className="studio-brand"><StudioLogo size={34} />Collab Studio
        {hub.me.workspaceName && <span className="studio-org">{hub.me.workspaceName}</span>}</div>
      <nav className="studio-projects" aria-label="Projects">
        {hub.rooms.map((item) => <button key={item.id} className={item.id === room?.id ? "studio-project studio-project-on" : "studio-project"}
          aria-current={item.id === room?.id ? "page" : undefined} onClick={() => setRoomId(item.id)}>{item.name}</button>)}
      </nav>
      <div className="studio-top-right">
        <span className={`studio-live studio-live-${hub.conn}`}><span className="studio-live-dot" />{hub.conn === "live" ? "Live" : hub.conn === "offline" ? "Offline" : "Connecting…"}</span>
        <div className="studio-me">
          <button className="studio-me-btn" onClick={() => setPicking((open) => !open)} aria-expanded={picking} title="Change your character">
            <Avatar id={meAvatar} name={hub.me.name} size={30} /><span className="studio-me-name">{hub.me.name}</span>
          </button>
          {picking && <div className="studio-popover" role="dialog" aria-label="Your character">
            <div className="studio-popover-head">Your character<button className="btn btn-small" onClick={() => setPicking(false)}>Done</button></div>
            <AvatarPicker value={resolveAvatar(meAvatar, hub.me.name)} onChange={(id) => void chooseAvatar(id)} label="Your character" />
            <div className="studio-popover-foot"><ThemePicker /></div>
            {clientSession && <SessionPanel />}
            {hub.operator && hub.workspaces.length > 0 && <label className="studio-popover-foot studio-small-label">Workspace
              <select className="studio-select" value={hub.me.workspaceId ?? ""} onChange={(e) => { setPicking(false); hub.switchWorkspace(e.target.value); }}>
                {hub.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>}
            <div className="studio-popover-foot">
              {staff && onOpenConsole && <button className="btn" onClick={onOpenConsole}>Open ops console</button>}
              <button className="btn" onClick={() => void hub.logout()}>Sign out</button>
            </div>
          </div>}
        </div>
      </div>
    </header>

    {clientSession && <PasskeyNudge />}
    {!room ? <div className="studio-empty-all">
      <h2>No projects yet</h2>
      <p>{staff ? "Create a room in the ops console, then invite your client from here." : "Ask the person who invited you to add you to a project."}</p>
    </div> : <>
      <nav className="studio-tabs" role="tablist" aria-label="Project views">
        {([["overview", "Overview"], ["workspace", "Workspace"], ["preview", "Preview"], ["agents", "Live agents"]] as const).map(([id, label]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "studio-tab studio-tab-on" : "studio-tab"} onClick={() => setTab(id)}>
            {label}{id === "agents" && agentsWorking > 0 && <span className="studio-tab-badge" title="Sidekicks working now">{agentsWorking} working</span>}
          </button>)}
      </nav>
      <main className="studio-main">
        {tab === "overview" && <div className="studio-overview">
          <People members={members} online={online} me={hub.me.id} roomId={room.id} staff={staff} nameOf={nameOf} onPeopleChanged={() => void loadProfiles(room.id)} />
          <Work roomId={room.id} nameOf={nameOf} avatarOf={avatarOf} staff={staff} members={members} />
        </div>}
        {tab === "workspace" && <div className="studio-workspace-tab"><Sandbox key={room.id} roomId={room.id} embedded /></div>}
        {tab === "preview" && <div className="studio-preview-tab"><DevServer key={room.id} roomId={room.id} /></div>}
        {tab === "agents" && <div className="studio-agents-tab"><LiveAgents roomId={room.id} members={members} nameOf={nameOf} /></div>}
      </main>
      <section className={chatOpen ? "studio-dock" : "studio-dock studio-dock-closed"} aria-label="Chat">
        {chatOpen && <div className="studio-dock-grip" onPointerDown={startResize} role="separator" aria-orientation="horizontal" aria-label="Resize chat" title="Drag to resize" />}
        <Chat key={room.id} roomId={room.id} roomName={room.name} messages={hub.messagesByRoom[room.id] ?? []} members={members}
          me={hub.me.id} isMember={isMember || staff} canJoin={!isMember && staff} nameOf={nameOf} avatarOf={avatarOf}
          open={chatOpen} onToggle={() => setChatOpen((value) => !value)} />
      </section>
    </>}
  </div>;
}

function People({ members, online, me, roomId, staff, nameOf, onPeopleChanged }: { members: MemberProfile[]; online: Set<string>; me: string; roomId: string; staff: boolean; nameOf: (id: string | null) => string; onPeopleChanged: () => void }) {
  const order = [...members].sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.name.localeCompare(b.name));
  return <aside className="studio-people" aria-label="People in this project">
    <h2 className="studio-h">People <span className="studio-count">{members.length}</span></h2>
    <ul className="studio-people-list">
      {order.map((member) => <li key={member.id} className="studio-person">
        <span className="studio-person-art"><Avatar id={member.avatar} name={member.name} size={34} />
          <span className={online.has(member.id) ? "studio-presence studio-presence-on" : "studio-presence"} title={online.has(member.id) ? "Online" : "Away"} /></span>
        <span className="studio-person-text"><span className="studio-person-name">{member.name}{member.id === me && <span className="studio-you"> (you)</span>}</span>
          <span className={`studio-role studio-role-${roleLabel(member).toLowerCase()}`}>{member.sidekickOf ? `Sidekick of ${member.sidekickOf === me ? "you" : nameOf(member.sidekickOf)}` : roleLabel(member)}</span>
          {staff && member.guest && !member.sidekickOf && member.id !== me && <SignInLinkButton agentId={member.id} name={member.name} />}</span>
      </li>)}
    </ul>
    <SidekickCard onChanged={() => onPeopleChanged()} />
    {staff && <InviteBox roomId={roomId} />}
  </aside>;
}

function InviteBox({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [link, setLink] = useState<{ url: string; shareable: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setOpen(false); setLink(null); setLabel(""); }, [roomId]);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setProblem(null); setCopied(false);
    try {
      const invite = await api.createInvite(roomId, label.trim() || undefined);
      // The hub only knows its own address; in the browser the page's origin is the one to share.
      const url = invite.url && invite.shareable ? invite.url : `${window.location.origin}/join#${invite.code}`;
      setLink({ url, shareable: invite.shareable });
    } catch (error) { setProblem(error instanceof Error ? error.message : "Could not create the invite"); }
  };
  const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } };
  if (!open) return <button className="btn studio-invite-btn" onClick={() => setOpen(true)}>+ Invite someone</button>;
  return <div className="studio-invite">
    {!link ? <form onSubmit={create}>
      <label className="studio-small-label" htmlFor="invite-label">Who is it for? (optional)</label>
      <input id="invite-label" className="studio-input" value={label} maxLength={80} placeholder="e.g. Dana from Acme" onChange={(e) => setLabel(e.target.value)} />
      <div className="studio-row"><button className="btn btn-primary">Create link</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
    </form> : <>
      <div className="studio-small-label">Send this link. It works once and expires in 7 days.</div>
      <input className="studio-input studio-mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
      {!link.shareable && <div className="studio-note">This address only works on this computer until the hub has a public address.</div>}
      <div className="studio-row"><button className="btn btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button><button className="btn" onClick={() => { setLink(null); setLabel(""); }}>Another</button><button className="btn" onClick={() => setOpen(false)}>Close</button></div>
    </>}
    {problem && <div className="studio-problem">{problem}</div>}
  </div>;
}

function Chat({ roomId, roomName, messages, members, me, isMember, canJoin, nameOf, avatarOf, open, onToggle }: {
  roomId: string; roomName: string; messages: UiMessage[]; members: MemberProfile[]; me: string; isMember: boolean; canJoin: boolean;
  nameOf: (id: string | null) => string; avatarOf: (id: string | null) => string | null; open: boolean; onToggle: () => void;
}) {
  const hub = useHub();
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  // "Message" on the sidekick card points the chat at the sidekick and puts the cursor here.
  useEffect(() => {
    const aim = (event: Event) => {
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      if (!agentId || !members.some((member) => member.id === agentId)) return;
      setTo(agentId);
      if (!open) onToggle();
      setTimeout(() => box.current?.focus(), 50);
    };
    window.addEventListener("studio:message-to", aim);
    return () => window.removeEventListener("studio:message-to", aim);
  }, [members, open, onToggle]);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages.length]);
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    if (await hub.postMessage(roomId, body, to || undefined)) { setDraft(""); stick.current = true; }
    setSending(false);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  const error = hub.error(`post:${roomId}`);
  const latest = messages[messages.length - 1];
  return <div className="studio-chat">
    <div className="studio-chat-head"><h2 className="studio-h">Chat</h2><span className="studio-sub">{roomName}</span>
      {!open && latest && <span className="studio-chat-peek">{nameOf(latest.from)}: {latest.body}</span>}
      <button className="btn btn-small studio-chat-toggle" onClick={onToggle} aria-expanded={open}>{open ? "Hide chat" : "Show chat"}</button></div>
    {open && <>
    <div className="studio-messages" ref={list} onScroll={() => { const el = list.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {messages.length === 0 ? <div className="studio-empty">
        <p className="studio-empty-title">Nothing here yet</p>
        <p>Say hello, or describe what you'd like built. Everyone in the project sees it live.</p>
      </div> : messages.map((message, index) => {
        const previous = messages[index - 1];
        const grouped = previous && previous.from === message.from && previous.to === message.to &&
          new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
        const name = nameOf(message.from) || "Someone";
        return <article key={message.id} className={`studio-msg${grouped ? " studio-msg-grouped" : ""}${message.from === me ? " studio-msg-mine" : ""}`}>
          <div className="studio-msg-art">{!grouped && <Avatar id={avatarOf(message.from)} name={name} size={36} />}</div>
          <div className="studio-msg-main">
            {!grouped && <div className="studio-msg-meta"><span className="studio-msg-name" style={{ color: agentColor(name).color }}>{name}</span>
              {message.to && <span className="studio-msg-to">to {message.to === me ? "you" : nameOf(message.to)}</span>}
              <time className="studio-msg-time" dateTime={message.createdAt}>{clock(message.createdAt)}</time></div>}
            <div className="studio-msg-body">{message.body}</div>
          </div>
        </article>;
      })}
    </div>
    {canJoin ? <div className="studio-composer studio-composer-join">
      <span>You're viewing this project. Join to take part in the conversation.</span>
      <button className="btn btn-primary" onClick={() => void hub.joinRoom(roomId)}>Join project</button>
    </div> : isMember ? <form className="studio-composer" onSubmit={send}>
      <textarea ref={box} className="studio-textarea" rows={2} value={draft} placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} aria-label="Message" maxLength={8000} />
      <div className="studio-composer-row">
        <label className="studio-to">To <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Everyone</option>
          {members.filter((member) => member.id !== me).map((member) => <option key={member.id} value={member.id}>{member.name}{member.sidekickOf ? (member.sidekickOf === me ? " (your sidekick)" : ` (${nameOf(member.sidekickOf)}'s sidekick)`) : ""}</option>)}
        </select></label>
        {error && <span className="studio-problem">{error}</span>}
        <button className="btn btn-primary" disabled={!draft.trim() || sending}>{sending ? "Sending…" : "Send"}</button>
      </div>
    </form> : null}
    </>}
  </div>;
}

function Work({ roomId, nameOf, avatarOf, staff, members }: { roomId: string; nameOf: (id: string | null) => string; avatarOf: (id: string | null) => string | null; staff: boolean; members: MemberProfile[] }) {
  const hub = useHub();
  const sandbox = hub.sandboxes.find((item) => item.roomId === roomId) ?? null;
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const activity = useMemo(() => hub.events.filter((event) => event.roomId === roomId)
    .map((event) => toActivity(event, nameOf)).filter((item): item is Activity => item !== null).reverse().slice(0, 150), [hub.events, roomId, nameOf]);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!sandbox || !cmd.trim() || running) return;
    setRunning(true);
    const result = await hub.runExec(roomId, sandbox.id, cmd.trim());
    setRunning(false);
    if (result) setCmd("");
  };
  const status = sandbox?.status ?? "unprovisioned";
  return <aside className="studio-work" aria-label="Live activity">
    <div className="studio-workspace">
      <div className="studio-workspace-line">
        <span className={`studio-ws-dot studio-ws-${status}`} />
        <span className="studio-workspace-title">Shared workspace</span>
        <span className="studio-sub">{status === "running" ? "Ready" : status === "provisioning" ? "Starting…" : status === "unprovisioned" ? "Not set up" : status === "stopped" ? "Stopped" : "Problem"}</span>
      </div>
      {status === "unprovisioned" && staff && <button className="btn" onClick={() => void hub.provisionSandbox(roomId)}>Set up workspace</button>}
      {status === "running" && hub.me?.role !== "observer" && <form className="studio-run" onSubmit={run}>
        <input className="studio-input studio-mono" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Run a command, e.g. ls" aria-label="Command to run in the shared workspace" />
        <button className="btn btn-primary" disabled={!cmd.trim() || running}>{running ? "Running…" : "Run"}</button>
      </form>}
      {hub.error("exec") && <div className="studio-problem">{hub.error("exec")}</div>}
    </div>
    <div className="studio-split">
    <div className="studio-split-col">
    <h2 className="studio-h studio-activity-h">What's happening</h2>
    <ol className="studio-activity">
      {activity.length === 0 && <li className="studio-empty">Activity shows up here as people and agents work.</li>}
      {activity.map((item) => {
        const name = nameOf(item.actorId);
        const expanded = open === item.key;
        return <li key={item.key} className={`studio-act studio-act-${item.tone}`}>
          <span className="studio-act-art">{item.actorId ? <Avatar id={avatarOf(item.actorId)} name={name || "?"} size={24} /> : <span className="studio-act-sys" aria-hidden="true" />}</span>
          <div className="studio-act-main">
            <div className="studio-act-text">{item.text}</div>
            <div className="studio-act-meta"><time dateTime={item.createdAt}>{clock(item.createdAt)}</time>
              {item.output && <button className="studio-link" onClick={() => setOpen(expanded ? null : item.key)} aria-expanded={expanded}>{expanded ? "Hide output" : "Show output"}</button>}
              {item.link && <a className="studio-link" href={item.link.href} target="_blank" rel="noreferrer noopener">{item.link.label}</a>}
            </div>
            {expanded && item.output && <pre className="studio-output">
              <span className="studio-output-cmd">$ {item.output.cmd}</span>{"\n"}
              {item.output.stdout || item.output.stderr ? `${item.output.stdout}${item.output.stderr ? `${item.output.stdout ? "\n" : ""}${item.output.stderr}` : ""}` : "(no output)"}
              {"\n"}<span className="studio-output-exit">{item.output.timedOut ? "stopped: took too long" : `exit ${item.output.exitCode ?? "?"}${item.output.durationMs !== null ? ` · ${(item.output.durationMs / 1000).toFixed(1)}s` : ""}`}</span>
            </pre>}
          </div>
        </li>;
      })}
    </ol>
    </div>
    <div className="studio-split-col studio-split-board"><Board roomId={roomId} members={members} staff={staff} nameOf={nameOf} avatarOf={avatarOf} /></div>
    </div>
  </aside>;
}
