// Live agents: one lane per sidekick in this project, showing what it was asked, what it is doing
// right now, the commands it ran (with output) and the files it changed.
import { useMemo, useState } from "react";
import { useHub } from "../lib/store";
import type { MemberProfile } from "../lib/api";
import { Avatar } from "../components/Avatar";
import { toActivity } from "./activity";

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
};

export default function LiveAgents({ roomId, members, nameOf }: { roomId: string; members: MemberProfile[]; nameOf: (id: string | null) => string }) {
  const hub = useHub();
  const sidekicks = members.filter((member) => member.sidekickOf);
  if (sidekicks.length === 0) return <div className="la-empty">
    <h2>No sidekicks here yet</h2>
    <p>When someone brings their AI sidekick into this project, you'll watch it work here: what it was asked, the commands it runs and the files it changes.</p>
    <p className="studio-sub">To bring yours, open <b>Overview</b> and use <b>Bring a sidekick</b> in the People panel.</p>
  </div>;
  return <div className="la-grid">{sidekicks.map((sidekick) => <Lane key={sidekick.id} roomId={roomId} sidekick={sidekick} owner={nameOf(sidekick.sidekickOf)} nameOf={nameOf} events={hub.events} />)}</div>;
}

function Lane({ roomId, sidekick, owner, nameOf, events }: {
  roomId: string; sidekick: MemberProfile; owner: string; nameOf: (id: string | null) => string; events: ReturnType<typeof useHub>["events"];
}) {
  const hub = useHub();
  const [open, setOpen] = useState<string | null>(null);
  const mine = useMemo(() => events.filter((event) => event.roomId === roomId && event.actorId === sidekick.id), [events, roomId, sidekick.id]);
  const lastStart = [...mine].reverse().find((event) => event.type === "sidekick.turn.started");
  const lastEnd = [...mine].reverse().find((event) => event.type === "sidekick.turn.finished");
  const working = !!lastStart && (!lastEnd || lastEnd.wireId < lastStart.wireId);
  const now = working ? [...mine].reverse().find((event) => event.type === "sidekick.activity") : undefined;
  const files = useMemo(() => [...new Set(mine.filter((event) => event.type === "file.write" && event.detail?.operation !== "seed")
    .map((event) => String(event.detail?.path ?? "")).filter(Boolean))].slice(-12).reverse(), [mine]);
  const commands = mine.filter((event) => event.type === "sandbox.exec.result").length;
  // What its owner asked most recently: a direct message, or a message that @mentions it.
  const messages = hub.messagesByRoom[roomId] ?? [];
  const asked = [...messages].reverse().find((message) => message.from === sidekick.sidekickOf &&
    (message.to === sidekick.id || message.body.toLowerCase().includes(`@${sidekick.name.toLowerCase()}`)));
  const replied = [...messages].reverse().find((message) => message.from === sidekick.id);
  const timeline = mine.map((event) => toActivity(event, nameOf)).filter((item) => item !== null).reverse().slice(0, 80);

  return <section className={`la-lane${working ? " la-lane-busy" : ""}`} aria-label={`${sidekick.name}'s work`}>
    <header className="la-head">
      <Avatar id={sidekick.avatar} name={sidekick.name} size={44} />
      <div className="la-head-text"><div className="la-name">{sidekick.name}</div><div className="studio-sub">Sidekick of {owner}</div></div>
      <span className={`la-state ${working ? "la-state-busy" : "la-state-idle"}`}>{working ? "Working" : "Idle"}</span>
    </header>
    {working && <div className="la-now"><span className="la-pulse" aria-hidden="true" />{now ? `${sidekick.name} ${String(now.detail?.text ?? "is working")}` : "Getting started…"}</div>}
    <div className="la-facts">
      <div className="la-fact"><span className="studio-small-label">Last asked</span><span className="la-quote">{asked ? asked.body : "Nothing yet"}</span></div>
      {replied && <div className="la-fact"><span className="studio-small-label">Last reply</span><span className="la-quote">{replied.body}</span></div>}
      <div className="la-fact"><span className="studio-small-label">Files changed</span>
        {files.length ? <span className="la-files">{files.map((path) => <code key={path} className="la-file">{path}</code>)}</span> : <span className="studio-sub">None yet</span>}</div>
      <div className="la-fact"><span className="studio-small-label">Commands run</span><span>{commands}</span></div>
    </div>
    <h3 className="la-h">Step by step</h3>
    <ol className="la-steps">
      {timeline.length === 0 && <li className="studio-sub">Nothing yet. Steps appear here the moment it starts.</li>}
      {timeline.map((item) => {
        const expanded = open === item.key;
        return <li key={item.key} className={`la-step la-step-${item.tone}`}>
          <time className="la-time" dateTime={item.createdAt}>{clock(item.createdAt)}</time>
          <div className="la-step-main">
            <div>{item.text}</div>
            {item.output && <button className="studio-link" onClick={() => setOpen(expanded ? null : item.key)} aria-expanded={expanded}>{expanded ? "Hide output" : "Show output"}</button>}
            {expanded && item.output && <pre className="studio-output"><span className="studio-output-cmd">$ {item.output.cmd}</span>{"\n"}{`${item.output.stdout}${item.output.stderr ? `\n${item.output.stderr}` : ""}` || "(no output)"}{"\n"}<span className="studio-output-exit">exit {item.output.exitCode ?? "?"}</span></pre>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
