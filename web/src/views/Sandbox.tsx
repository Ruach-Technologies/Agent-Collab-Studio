import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, UiEvent, UiExec } from "../types";
import { useHub } from "../lib/store";
import { Empty, Spinner, Tag } from "../components/bits";
import { hhmmss } from "../lib/time";
import GitView from "./GitView";

interface Status { state: string; sandboxId: string | null; image: string | null; }
const detailString = (detail: Record<string, unknown> | null, ...keys: string[]) => {
  for (const key of keys) { const value = detail?.[key]; if (typeof value === "string") return value; }
  return null;
};
function deriveStatus(events: UiEvent[], roomId: string): Status {
  let state = "unprovisioned"; let sandboxId: string | null = null; let image: string | null = null;
  for (const event of events) {
    if (event.roomId !== roomId || !event.type.startsWith("sandbox.")) continue;
    sandboxId = detailString(event.detail, "sandbox_id", "sandboxId", "id") ?? sandboxId;
    image = detailString(event.detail, "image") ?? image;
    if (event.type === "sandbox.requested") state = "provisioning";
    if (event.type === "sandbox.ready") state = "running";
    if (event.type.includes("error")) state = "error";
    if (event.type.includes("stop")) state = "stopped";
  }
  return { state, sandboxId, image };
}

/** `roomId` pins the view to one project (the Studio's Workspace tab); `embedded` drops the console chrome. */
export default function Sandbox({ roomId: pinned, embedded = false }: { roomId?: string; embedded?: boolean } = {}) {
  const hub = useHub(); const [roomId, setRoomId] = useState<string | null>(null);
  const room = hub.rooms.find((item) => item.id === (pinned ?? roomId)) ?? (pinned ? null : hub.rooms[0] ?? null);
  const statuses = useMemo(() => Object.fromEntries(hub.rooms.map((item) => {
    const record = hub.sandboxes.find((sandbox) => sandbox.roomId === item.id);
    return [item.id, record ? { state: record.status, sandboxId: record.id, image: record.image } : deriveStatus(hub.events, item.id)];
  })), [hub.rooms, hub.events, hub.sandboxes]);
  const status = room ? statuses[room.id] : null;
  const eventExecs = useMemo<UiExec[]>(() => room ? hub.events.filter((event) => event.roomId === room.id && event.type === "sandbox.exec").map((event) => ({ id: `event-${event.key}`, cmd: detailString(event.detail, "cmd") ?? "command", exitCode: Number(detailString(event.detail, "exitCode", "exit_code") ?? "") || null, stdout: detailString(event.detail, "stdout") ?? "", stderr: detailString(event.detail, "stderr") ?? "", durationMs: Number(detailString(event.detail, "durationMs", "duration_ms") ?? "") || 0, timedOut: false, actorId: event.actorId, createdAt: event.createdAt })) : [], [room, hub.events]);
  const execs = room ? hub.localExecsByRoom[room.id] ?? eventExecs : [];
  const [selectedExec, setSelectedExec] = useState<string | null>(null);
  const selected = execs.find((item) => item.id === selectedExec) ?? execs[0] ?? null;
  const [command, setCommand] = useState(""); const [running, setRunning] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const provision = async () => { if (!room) return; setProvisioning(true); await hub.provisionSandbox(room.id); setProvisioning(false); };
  const run = async () => { if (!room || !status?.sandboxId || !command.trim()) return; setRunning(true); const result = await hub.runExec(room.id, status.sandboxId, command.trim()); if (result) setCommand(""); setRunning(false); };
  // VS Code-style arrangement: explorer and a tabbed main area on top, the
  // terminal beneath, and the room containers as a tab row along the bottom.
  const [tab, setTab] = useState<"code" | "graph" | "review">("code");
  const [gitOpened, setGitOpened] = useState(false);
  const show = (next: "code" | "graph" | "review") => { if (next !== "code") setGitOpened(true); setTab(next); };
  const scope = status?.sandboxId ?? room?.id ?? "none";
  return <div className={embedded ? "view view-embedded" : "view"}>{!embedded && <header className="view-head"><h1>sandbox</h1><span className="muted">{room ? `${room.name} · ` : ""}per-room containers · live workspace</span></header>}
    <div className={embedded ? "ide ide-embedded" : "ide"}>
      <div className="ide-top">
        <Workspace key={scope} sandboxId={status?.sandboxId ?? null} roomId={room?.id ?? null} codeVisible={tab === "code"} onOpenFile={() => setTab("code")} />
        <div className="ide-tabs pane-head" role="tablist" aria-label="Workspace views">
          {([["code", "code"], ["graph", "git graph"], ["review", "commit & diff"]] as const).map(([id, label]) =>
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => show(id)}>{label}</button>)}
        </div>
        {gitOpened && <GitView key={`git:${scope}`} sandboxId={status?.sandboxId ?? null} roomId={room?.id ?? null} mode={tab === "code" ? null : tab} onReview={() => setTab("review")} />}
      </div>
      <section className="ide-terminal pane">
        <header className="pane-head"><span className="pane-title">{room ? `terminal · ${room.name}` : "terminal"}</span><span className="pane-right">{status?.sandboxId ? <Tag>{status.sandboxId}</Tag> : <span className="muted small">id pending</span>}</span></header>
        <div className="term-body">
          <div className="term-left">
            {room && (hub.me?.role === "supervisor" || hub.operator) && status?.state !== "running" && <button className="btn btn-primary" disabled={provisioning} onClick={() => void provision()}>{provisioning ? "provisioning…" : "provision sandbox"}</button>}
            {room && hub.error(`sandbox:${room.id}`) && <div className="error-line">{hub.error(`sandbox:${room.id}`)}</div>}
            {status?.sandboxId && hub.me?.role !== "observer" ? <div className="exec-composer"><input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} placeholder="command" spellCheck={false} /><button className="btn" disabled={!command.trim() || running} onClick={() => void run()}>{running ? "…" : "run"}</button></div> : <div className="empty">sandbox id appears after provision events</div>}
            {status?.sandboxId && <div className="muted xsmall term-hint">each command starts in /workspace — chain steps with &amp;&amp;, e.g. cd repo &amp;&amp; git status</div>}
            {hub.error("exec") && <div className="error-line">{hub.error("exec")}</div>}
            <div className="exec-list">{execs.length === 0 ? <Empty>no recorded execs</Empty> : execs.map((exec) => <button key={exec.id} className={`exec-row ${selected?.id === exec.id ? "active" : ""}`} onClick={() => setSelectedExec(exec.id)}><span className="grow"><span className={exec.exitCode === 0 ? "exit-ok" : exec.exitCode === null ? "exit-unknown" : "exit-bad"}>exit {exec.exitCode ?? "?"}</span><span className="ellip">{exec.cmd}</span></span><span className="muted small">{exec.durationMs}ms · {hhmmss(exec.createdAt)}</span></button>)}</div>
          </div>
          <div className="term-right">
            {selected ? <div className="exec-output">{selected.timedOut && <span className="error-line">command timed out</span>}<span className="sub-head">stdout</span><pre>{selected.stdout || "(empty)"}</pre><span className="sub-head">stderr</span><pre className="err-text">{selected.stderr || "(empty)"}</pre></div> : <Empty>select a command to see its output</Empty>}
          </div>
        </div>
      </section>
      {!embedded && <nav className="ide-rooms" aria-label="Room containers">{hub.rooms.length === 0 ? <span className="muted small">no rooms</span> : hub.rooms.map((item) => { const itemStatus = statuses[item.id] ?? { state: "unprovisioned", sandboxId: null, image: null }; return <button key={item.id} className={`room-tab ${room?.id === item.id ? "active" : ""}`} onClick={() => setRoomId(item.id)}><span className={`dot ${itemStatus.state === "running" ? "dot-on" : itemStatus.state === "error" ? "dot-bad" : itemStatus.state === "provisioning" ? "dot-warn" : "dot-off"}`} /><span className="ellip">{item.name}</span><Tag tone={itemStatus.state === "running" ? "ok" : itemStatus.state === "error" ? "bad" : itemStatus.state === "provisioning" ? "warn" : "dim"}>{itemStatus.state}</Tag></button>; })}</nav>}
    </div>
  </div>;
}

/** Before a project has a shared workspace: staff can set it up here, everyone else is told who can. */
function NoWorkspace({ roomId }: { roomId: string | null }) {
  const hub = useHub();
  const [starting, setStarting] = useState(false);
  const staff = hub.operator || hub.me?.role === "supervisor";
  if (!roomId) return <Empty>no project selected</Empty>;
  return <div className="no-workspace">
    <div className="no-workspace-title">No shared workspace yet</div>
    {staff ? <>
      <p className="muted small">Set one up to browse files, run commands and bring in a GitHub repository.</p>
      <button className="btn btn-primary" disabled={starting} onClick={() => { setStarting(true); void hub.provisionSandbox(roomId).finally(() => setStarting(false)); }}>{starting ? "Setting up…" : "Set up workspace"}</button>
    </> : <p className="muted small">The project's host sets this up. Once it's ready you can bring in a GitHub repository here and see every file.</p>}
    {hub.error(`sandbox:${roomId}`) && <div className="error-line">{hub.error(`sandbox:${roomId}`)}</div>}
  </div>;
}

interface DirectoryState { entries?: FileEntry[]; loading: boolean; failed: boolean; }
interface OpenFile { path: string; content: string; version: number; flash: [number, number] | null; }
interface Mark { actorId: string | null; at: number; }
const MARK_TTL_MS = 30_000;
const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

/** Line range of `after` that differs from `before`, ignoring a shared prefix and suffix. */
function changedRange(before: string, after: string): [number, number] | null {
  if (before === after) return null;
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [start, Math.max(endB, start + 1)];
}

function Workspace({ sandboxId, roomId, codeVisible, onOpenFile }: { sandboxId: string | null; roomId: string | null; codeVisible: boolean; onOpenFile: () => void }) {
  const hub = useHub();
  const canWrite = Boolean(hub.me) && hub.me?.role !== "observer";
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<string[]>(["."]);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [repo, setRepo] = useState(""); const [ref, setRef] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneNote, setCloneNote] = useState<{ ok: boolean; text: string } | null>(null);
  const mounted = useRef(false); const requests = useRef(new Map<string, number>()); const fileRequest = useRef(0);
  // Latest values for the event-driven refresh, which must not resubscribe on every keystroke.
  const live = useRef({ file, draft, follow, directories, meId: hub.me?.id ?? null });
  live.current = { file, draft, follow, directories, meId: hub.me?.id ?? null };
  const dirty = draft !== null && draft !== file?.content;

  const load = useCallback(async (path: string, silent = false) => {
    if (!sandboxId) return;
    const request = (requests.current.get(path) ?? 0) + 1; requests.current.set(path, request);
    if (!silent) setDirectories((current) => ({ ...current, [path]: { loading: true, failed: false } }));
    const result = await hub.listFiles(sandboxId, path);
    if (!mounted.current || requests.current.get(path) !== request) return;
    setDirectories((current) => ({ ...current, [path]: { entries: result ?? undefined, loading: false, failed: result === null } }));
  }, [hub.listFiles, sandboxId]);
  useEffect(() => {
    mounted.current = true; if (sandboxId) void load(".");
    return () => { mounted.current = false; requests.current.clear(); fileRequest.current++; };
  }, [load, sandboxId]);

  /** `quiet` keeps the current view in place while the newer content loads. */
  const open = useCallback(async (path: string, quiet = false) => {
    if (!sandboxId) return;
    const request = ++fileRequest.current;
    if (!quiet) { setBusy(true); setFile(null); setDraft(null); setStale(null); }
    const content = await hub.readFile(sandboxId, path);
    if (!mounted.current || request !== fileRequest.current) return;
    setBusy(false);
    if (content === null) return;
    setFile((previous) => ({
      path, content, version: (previous?.version ?? 0) + 1,
      flash: previous?.path === path ? changedRange(previous.content, content) : null,
    }));
  }, [hub.readFile, sandboxId]);
  const select = (path: string) => {
    if (dirty && !window.confirm("Discard unsaved edits?")) return;
    onOpenFile(); void open(path);
  };
  const toggle = (path: string) => { setExpanded((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]); if (!directories[path]?.entries && !directories[path]?.loading) void load(path); };

  // Live updates: agent writes and finished commands refresh the tree and the
  // open file. Only events newer than this view are applied, so history is not replayed.
  const cursor = useRef<number | null>(null); const openedAt = useRef(Date.now());
  const queue = useRef({ dirs: new Set<string>(), all: false, file: null as string | null, open: null as string | null, timer: 0 });
  const flush = useCallback(() => {
    const pending = queue.current; const state = live.current;
    queue.current = { dirs: new Set(), all: false, file: null, open: null, timer: 0 };
    if (!mounted.current) return;
    const loaded = Object.keys(state.directories);
    for (const path of pending.all ? loaded : loaded.filter((item) => pending.dirs.has(item))) void load(path, true);
    if (state.draft !== null) { if (pending.file) setStale(pending.file); return; }
    if (pending.open && pending.open !== state.file?.path) {
      const ancestors: string[] = [];
      for (let dir = parentOf(pending.open); dir !== "."; dir = parentOf(dir)) ancestors.push(dir);
      setExpanded((current) => [...new Set([...current, ...ancestors])]);
      for (const dir of ancestors) if (!state.directories[dir]) void load(dir);
      void open(pending.open, true);
    } else if ((pending.file || pending.all) && state.file) void open(state.file.path, true);
  }, [load, open]);
  useEffect(() => {
    const latest = hub.events.reduce((max, event) => Math.max(max, event.wireId), 0);
    if (cursor.current === null) { cursor.current = latest; return; }
    const pending = queue.current; const fresh: Record<string, Mark> = {}; let touched = false;
    for (const event of hub.events) {
      if (event.wireId <= cursor.current || event.roomId !== roomId || Date.parse(event.createdAt) < openedAt.current - 5_000) continue;
      const path = event.detail?.path;
      if (event.type === "file.write" && event.detail?.outcome === "success" && typeof path === "string") {
        fresh[path] = { actorId: event.actorId, at: Date.now() };
        pending.dirs.add(parentOf(path));
        if (path === live.current.file?.path) pending.file = hub.agentName(event.actorId) || "an agent";
        else if (live.current.follow && event.actorId !== live.current.meId) pending.open = path;
        touched = true;
      } else if (event.type === "sandbox.exec.result") { pending.all = true; touched = true; }
    }
    cursor.current = latest;
    if (Object.keys(fresh).length) setMarks((current) => ({ ...current, ...fresh }));
    if (touched && !pending.timer) pending.timer = window.setTimeout(flush, 250);
  }, [hub.events, hub.agentName, roomId, flush]);
  useEffect(() => () => window.clearTimeout(queue.current.timer), []);
  useEffect(() => {
    if (!Object.keys(marks).length) return;
    const timer = window.setTimeout(() => setMarks((current) => Object.fromEntries(Object.entries(current).filter(([, mark]) => Date.now() - mark.at < MARK_TTL_MS))), 5_000);
    return () => window.clearTimeout(timer);
  }, [marks]);

  const save = async () => {
    if (!sandboxId || !file || draft === null || saving) return;
    setSaving(true);
    const saved = await hub.writeFile(sandboxId, file.path, draft);
    if (!mounted.current) return;
    setSaving(false);
    if (saved) { setFile({ ...file, content: draft, version: file.version + 1, flash: null }); setDraft(null); setStale(null); }
  };
  const clone = async () => {
    if (!sandboxId || !repo.trim() || cloning) return;
    setCloning(true); setCloneNote(null);
    const result = await hub.cloneRepo(sandboxId, repo.trim(), ref.trim() || undefined);
    if (!mounted.current) return;
    setCloning(false);
    if (!result) return;
    const ok = result.exitCode === 0 && !result.timedOut;
    setCloneNote({ ok, text: ok ? `${result.action === "update" ? "updated" : "cloned into"} ${result.dir}/` : (result.timedOut ? "clone timed out" : result.stderr.trim().split("\n").slice(-2).join(" ") || `git exited ${result.exitCode ?? "?"}`) });
    if (ok) { setRepo(""); setRef(""); void load(".", true); }
  };

  const mark = file ? marks[file.path] : undefined;
  const lines = file ? file.content.split("\n") : [];
  return <>
    <section className="ide-explorer pane">
      <header className="pane-head"><span className="pane-title">explorer</span><span className="pane-right">
        {sandboxId && <Tag tone={hub.conn === "live" ? "ok" : "warn"}>{hub.conn === "live" ? "live" : "paused"}</Tag>}
        {busy ? <Spinner /> : <button className="btn btn-small" disabled={!sandboxId || directories["."]?.loading} onClick={() => void load(".")}>refresh files</button>}
      </span></header>
      <div className="pane-body">
        {sandboxId && canWrite && <form className="clone-form" onSubmit={(event) => { event.preventDefault(); void clone(); }}>
          <input aria-label="GitHub repository" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="GitHub owner/repo or URL" spellCheck={false} />
          <input aria-label="Branch or tag" className="clone-ref" value={ref} onChange={(event) => setRef(event.target.value)} placeholder="branch" spellCheck={false} />
          <button className="btn btn-small" disabled={!repo.trim() || cloning}>{cloning ? "cloning…" : "clone"}</button>
        </form>}
        {cloneNote && <div className={cloneNote.ok ? "note-line" : "error-line"}>{cloneNote.text}</div>}
        {hub.error("repo") && <div className="error-line">{hub.error("repo")}</div>}
        {!sandboxId ? <NoWorkspace roomId={roomId} /> : <div className="tree"><div className="tree-scroll"><Rows path="." depth={0} directories={directories} expanded={expanded} toggle={toggle} open={select} retry={load} selected={file?.path ?? null} marks={marks} /></div></div>}
        {hub.error("files") && <div className="error-line">{hub.error("files")}</div>}
        {sandboxId && <label className="follow small explorer-foot"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />follow agents</label>}
      </div>
    </section>
    <section className="ide-main ide-code pane" hidden={!codeVisible}>
      <div className="viewer">{file ? <>
        <span className="sub-head viewer-head"><span className="grow ellip">{file.path}{dirty ? " •" : ""}</span>
          {mark && <span className="edited-by">edited by {hub.agentName(mark.actorId) || "hub"}</span>}
          {canWrite && (draft === null
            ? <button className="btn btn-small" onClick={() => setDraft(file.content)}>edit</button>
            : <><button className="btn btn-small btn-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "saving…" : "save"}</button><button className="btn btn-small" disabled={saving} onClick={() => { setDraft(null); if (stale) { setStale(null); void open(file.path, true); } }}>cancel</button></>)}
        </span>
        {stale && <div className="error-line">changed by {stale} while you were editing — saving overwrites it <button className="btn btn-small" onClick={() => { setDraft(null); setStale(null); void open(file.path, true); }}>load theirs</button></div>}
        {hub.error("save") && <div className="error-line">{hub.error("save")}</div>}
        {draft === null
          ? <pre>{file.content ? lines.map((line, index) => <span key={`${file.version}:${index}`} className={file.flash && index >= file.flash[0] && index < file.flash[1] ? "line-changed" : undefined}>{line}{index < lines.length - 1 ? "\n" : ""}</span>) : "(empty file)"}</pre>
          : <textarea className="editor" aria-label={`Edit ${file.path}`} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); void save(); } }} />}
      </> : <Empty>{sandboxId ? "select a file in the explorer" : "no sandbox yet"}</Empty>}</div>
    </section>
  </>;
}
function Rows({ path, depth, directories, expanded, toggle, open, retry, selected, marks }: { path: string; depth: number; directories: Record<string, DirectoryState>; expanded: string[]; toggle: (path: string) => void; open: (path: string) => void; retry: (path: string) => void; selected: string | null; marks: Record<string, Mark>; }) {
  const directory = directories[path];
  if (!directory || directory.loading) return <Spinner label="loading" />;
  if (directory.failed) return <div className="error-line">could not load workspace <button className="btn btn-small" onClick={() => retry(path)}>retry {path === "." ? "workspace" : path}</button></div>;
  const list = directory.entries ?? [];
  if (!list.length) return <Empty>empty directory</Empty>;
  const changed = Object.keys(marks);
  return <>{[...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)).map((entry) => {
    const recent = entry.isDir ? changed.some((item) => item.startsWith(`${entry.path}/`)) : entry.path in marks;
    return <div key={entry.path}><button className={`file-row ${selected === entry.path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => entry.isDir ? toggle(entry.path) : open(entry.path)}><span className="caret">{entry.isDir ? expanded.includes(entry.path) ? "▾" : "▸" : ""}</span><span className="fname">{entry.name}{entry.isDir ? "/" : ""}</span>{recent && <span className="changed-dot" title="recently edited" />}{!entry.isDir && entry.size !== null && <span className="fsize">{entry.size}B</span>}</button>{entry.isDir && expanded.includes(entry.path) && <Rows path={entry.path} depth={depth + 1} directories={directories} expanded={expanded} toggle={toggle} open={open} retry={retry} selected={selected} marks={marks} />}</div>;
  })}</>;
}
