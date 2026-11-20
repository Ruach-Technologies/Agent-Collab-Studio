// The project board beside "What's happening": the room's rules, who is who (with each person's
// sidekick under them), the latest actions, and a friendly leaderboard. The numbers come from the
// hub's record of saves and commands in this room only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type Board as BoardData, type BoardPerson, type MemberProfile } from "../lib/api";
import { useHub } from "../lib/store";
import { Avatar } from "../components/Avatar";
import { toActivity } from "./activity";

/** Events that change the board; anything else leaves it as it is. */
const RELOAD = new Set(["file.write", "sandbox.exec.result", "room.rules_updated", "room.joined", "room.left", "sidekick.turn.finished", "sidekick.activity"]);

const ago = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Turns the rules text into headings, bullets and paragraphs. Plain text only; nothing is rendered as HTML. */
function Rules({ text }: { text: string }) {
  const blocks: Array<{ kind: "h" | "p"; text: string } | { kind: "ul"; items: string[] }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "ul") last.items.push(bullet[1]!); else blocks.push({ kind: "ul", items: [bullet[1]!] });
    } else if (line.startsWith("#")) blocks.push({ kind: "h", text: line.replace(/^#+\s*/, "") });
    else blocks.push({ kind: "p", text: line });
  }
  return <div className="bd-rules">{blocks.map((block, index) => block.kind === "ul"
    ? <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
    : block.kind === "h" ? <h4 key={index}>{block.text}</h4> : <p key={index}>{block.text}</p>)}</div>;
}

interface Ranked { id: string; value: number; note: string; }
interface Category { key: string; title: string; how: string; ranked: Ranked[]; }

function leaderboard(people: BoardPerson[]): Category[] {
  const top = (list: Ranked[]) => list.sort((a, b) => b.value - a.value).slice(0, 3);
  const maxLines = Math.max(1, ...people.map((p) => p.linesAdded));
  const skill = (p: BoardPerson) => {
    // Equal parts: how much they wrote (against the top writer), how often their checks pass, how rarely their commands fail.
    const parts = [p.linesAdded / maxLines];
    if (p.checks) parts.push(p.checksPassed / p.checks);
    if (p.commands) parts.push(1 - p.failed / p.commands);
    return parts.reduce((sum, part) => sum + part, 0) / 3;
  };
  return [
    { key: "most", title: "Most code written", how: "Lines added in saved files.",
      ranked: top(people.filter((p) => p.linesAdded > 0).map((p) => ({ id: p.agentId, value: p.linesAdded, note: `${p.linesAdded.toLocaleString()} lines` }))) },
    { key: "clean", title: "Cleanest code", how: "Share of test, lint and type checks that passed.",
      ranked: top(people.filter((p) => p.checks > 0).map((p) => ({ id: p.agentId, value: p.checksPassed / p.checks + p.checks / 1e6, note: `${p.checksPassed} of ${p.checks} checks passed` }))) },
    { key: "errors", title: "Fewest errors", how: "Share of commands that ran without failing.",
      ranked: top(people.filter((p) => p.commands > 0).map((p) => ({ id: p.agentId, value: 1 - p.failed / p.commands + p.commands / 1e6, note: `${pct(p.commands - p.failed, p.commands)} of ${p.commands} ran clean` }))) },
    { key: "skill", title: "Most skilled", how: "All three together: code written, checks passed and clean runs.",
      ranked: top(people.filter((p) => p.linesAdded > 0 || p.commands > 0).map((p) => ({ id: p.agentId, value: skill(p), note: `score ${Math.round(skill(p) * 100)}` }))) },
  ];
}

export default function Board({ roomId, members, staff, nameOf, avatarOf }: {
  roomId: string; members: MemberProfile[]; staff: boolean;
  nameOf: (id: string | null) => string; avatarOf: (id: string | null) => string | null;
}) {
  const hub = useHub();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => { try { setBoard(await api.board(roomId)); } catch { /* keeps the last board */ } }, [roomId]);
  const trigger = useMemo(() => [...hub.events].reverse().find((event) => event.roomId === roomId && RELOAD.has(event.type))?.key, [hub.events, roomId]);
  useEffect(() => { setBoard(null); setEditing(false); }, [roomId]);
  useEffect(() => {
    // Wait for a quiet moment so a burst of saves reloads once.
    const timer = setTimeout(() => void load(), trigger ? 800 : 0);
    return () => clearTimeout(timer);
  }, [load, trigger]);

  const stats = useMemo(() => new Map((board?.people ?? []).map((p) => [p.agentId, p])), [board]);
  const lastAction = (id: string) => {
    const entry = stats.get(id)?.recent[0];
    if (!entry) return null;
    const line = toActivity({ id: `${id}-last`, wireId: 0, type: entry.type, roomId, actorId: id, targetId: null, detail: entry.detail, createdAt: entry.createdAt }, nameOf);
    const text = line?.text ?? (entry.type === "message.created" ? `${nameOf(id)} posted in the chat` : null);
    return text ? { text: text.startsWith(nameOf(id)) ? text.slice(nameOf(id).length).trim() : text, at: entry.createdAt } : null;
  };
  const latest = useMemo(() => (board?.people ?? []).flatMap((p) => p.recent.map((entry, index) => ({ ...entry, agentId: p.agentId, key: `${p.agentId}-${index}` })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8)
    .map((entry) => {
      if (entry.type === "message.created") return { key: entry.key, agentId: entry.agentId, at: entry.createdAt, text: `${nameOf(entry.agentId)}: “${String(entry.detail.body ?? "").slice(0, 90)}”` };
      const line = toActivity({ id: entry.key, wireId: 0, type: entry.type, roomId, actorId: entry.agentId, targetId: null, detail: entry.detail, createdAt: entry.createdAt }, nameOf);
      return line ? { key: entry.key, agentId: entry.agentId, at: entry.createdAt, text: line.text } : null;
    }).filter((item): item is { key: string; agentId: string; at: string; text: string } => item !== null), [board, nameOf, roomId]);

  const people = members.filter((member) => !member.sidekickOf);
  const sidekicksOf = (id: string) => members.filter((member) => member.sidekickOf === id);
  const categories = useMemo(() => leaderboard(board?.people.filter((p) => members.some((m) => m.id === p.agentId)) ?? []), [board, members]);

  const save = async (rules: string | null) => {
    setBusy(true); setProblem(null);
    try { const next = await api.saveRules(roomId, rules); setBoard((current) => current ? { ...current, rules: next.rules, customRules: next.customRules } : current); setEditing(false); }
    catch (error) { setProblem(error instanceof ApiError ? error.message : "Could not save the rules. Try again."); }
    finally { setBusy(false); }
  };

  const who = (member: MemberProfile, sidekick = false) => {
    const last = lastAction(member.id);
    return <li key={member.id} className={sidekick ? "bd-who bd-who-sidekick" : "bd-who"}>
      <Avatar id={avatarOf(member.id)} name={member.name} size={sidekick ? 22 : 28} />
      <div className="bd-who-main">
        <div className="bd-who-name">{member.name}<span className="bd-who-role">{sidekick ? "sidekick" : member.guest ? "client" : member.role === "supervisor" ? "reviewer" : member.role === "observer" ? "watching" : "agent"}</span></div>
        <div className="bd-who-last">{last ? <>{last.text} · <time dateTime={last.at}>{ago(last.at)}</time></> : "No actions yet"}</div>
      </div>
    </li>;
  };

  return <section className="bd" aria-label="Project board">
    <div className="bd-card">
      <div className="bd-card-head"><h3>Workspace rules</h3>
        {staff && !editing && <button className="studio-link" onClick={() => { setDraft(board?.rules ?? ""); setEditing(true); }}>Edit</button>}</div>
      {editing ? <div className="bd-edit">
        <textarea className="studio-input bd-textarea" value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} aria-label="Workspace rules" />
        <p className="sk-fine">Start a line with # for a heading or - for a bullet. Everyone in this project sees these.</p>
        <div className="studio-row"><button className="btn btn-primary btn-small" disabled={busy} onClick={() => void save(draft)}>{busy ? "Saving…" : "Save rules"}</button>
          <button className="btn btn-small" onClick={() => setEditing(false)}>Cancel</button>
          {board?.customRules && <button className="btn btn-small" disabled={busy} onClick={() => void save(null)}>Use the standard rules</button>}</div>
        {problem && <div className="studio-problem">{problem}</div>}
      </div> : board ? <Rules text={board.rules} /> : <div className="studio-empty">Loading…</div>}
    </div>

    <div className="bd-card">
      <div className="bd-card-head"><h3>Who's who</h3><span className="studio-sub">{people.length} {people.length === 1 ? "person" : "people"}</span></div>
      <ul className="bd-list">{people.map((member) => <li key={member.id} className="bd-group"><ul className="bd-list">{who(member)}{sidekicksOf(member.id).map((sk) => who(sk, true))}</ul></li>)}</ul>
    </div>

    <div className="bd-card">
      <div className="bd-card-head"><h3>Latest actions</h3></div>
      {latest.length === 0 ? <div className="studio-empty">Nothing yet.</div> : <ol className="bd-list">
        {latest.map((item) => <li key={item.key} className="bd-latest">
          <Avatar id={avatarOf(item.agentId)} name={nameOf(item.agentId) || "?"} size={20} />
          <span className="bd-latest-text">{item.text}</span><time className="bd-time" dateTime={item.at}>{ago(item.at)}</time>
        </li>)}
      </ol>}
    </div>

    <div className="bd-card">
      <div className="bd-card-head"><h3>Leaderboard</h3><span className="studio-sub">this project</span></div>
      <div className="bd-board">{categories.map((category) => <div key={category.key} className="bd-cat">
        <div className="bd-cat-title">{category.title}</div>
        {category.ranked.length === 0 ? <div className="bd-cat-empty">No one yet</div> : <ol className="bd-rank">
          {category.ranked.map((entry, index) => <li key={entry.id}>
            <span className={`bd-place bd-place-${index + 1}`}>{index + 1}</span>
            <Avatar id={avatarOf(entry.id)} name={nameOf(entry.id) || "?"} size={20} />
            <span className="bd-rank-name">{nameOf(entry.id)}</span><span className="bd-rank-note">{entry.note}</span>
          </li>)}
        </ol>}
        <div className="bd-how">{category.how}</div>
      </div>)}</div>
    </div>
  </section>;
}
