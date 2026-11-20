import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommit, GitCommitDetail, GitOverview } from "../types";
import { api, ApiError } from "../lib/api";
import { useHub } from "../lib/store";
import { Empty, Spinner, Tag } from "../components/bits";

const LANE = 12, ROW = 24, COLORS = ["var(--lane-1)", "var(--lane-2)", "var(--lane-3)", "var(--lane-4)", "var(--lane-5)", "var(--lane-6)"];
interface GraphRow { col: number; top: Array<[number, number]>; bottom: Array<[number, number]>; width: number; }

/** Assign each commit a lane and the line segments entering and leaving its row (commits arrive newest first, parents after children). */
function layoutGraph(commits: GitCommit[]): GraphRow[] {
  let lanes: Array<string | null> = [];
  return commits.map((commit) => {
    let col = lanes.indexOf(commit.sha);
    if (col === -1) { col = lanes.indexOf(null); if (col === -1) { col = lanes.length; lanes.push(null); } }
    const top: Array<[number, number]> = [];
    lanes.forEach((sha, x) => { if (sha !== null) top.push([x, sha === commit.sha ? col : x]); });
    const next = lanes.map((sha) => sha === commit.sha ? null : sha);
    const bottom: Array<[number, number]> = [];
    next.forEach((sha, x) => { if (sha !== null) bottom.push([x, x]); });
    commit.parents.forEach((parent, index) => {
      let target = next.indexOf(parent);
      if (target === -1) {
        target = index === 0 && next[col] === null ? col : next.indexOf(null);
        if (target === -1) { target = next.length; next.push(null); }
        next[target] = parent;
      }
      bottom.push([col, target]);
    });
    const width = Math.max(lanes.length, next.length, col + 1);
    while (next.length && next[next.length - 1] === null) next.pop();
    lanes = next;
    return { col, top, bottom, width };
  });
}

function Graph({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => lane * LANE + LANE / 2, mid = ROW / 2;
  return <svg className="git-graph" width={width * LANE} height={ROW} aria-hidden="true">
    {row.top.map(([from, to], index) => <line key={`t${index}`} x1={x(from)} y1={0} x2={x(to)} y2={mid} stroke={COLORS[from % COLORS.length]} />)}
    {row.bottom.map(([from, to], index) => <line key={`b${index}`} x1={x(from)} y1={mid} x2={x(to)} y2={ROW} stroke={COLORS[to % COLORS.length]} />)}
    <circle cx={x(row.col)} cy={mid} r={3.5} fill={COLORS[row.col % COLORS.length]} />
  </svg>;
}

const short = (sha: string) => sha.slice(0, 7);
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const message = (error: unknown) => error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);

/**
 * Branches, commit graph and per-commit files of the clones in a room's
 * workspace. It stays mounted while hidden so the selected commit survives
 * switching between the graph and the commit/diff tab.
 */
export default function GitView({ sandboxId, roomId, mode, onReview }: { sandboxId: string | null; roomId: string | null; mode: "graph" | "review" | null; onReview: () => void }) {
  const hub = useHub();
  const canWrite = Boolean(hub.me) && hub.me?.role !== "observer";
  const [repos, setRepos] = useState<string[] | null>(null);
  const [dir, setDir] = useState("");
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [patch, setPatch] = useState<{ path: string; text: string } | null>(null);
  const [target, setTarget] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const mounted = useRef(false); const request = useRef(0); const detailRequest = useRef(0);
  const current = useRef({ dir, selected }); current.current = { dir, selected };

  const loadOverview = useCallback(async (repo: string, quiet = false) => {
    if (!sandboxId || !repo) return;
    const id = ++request.current;
    if (!quiet) setLoading(true);
    try {
      const result = await api.gitLog(sandboxId, repo);
      if (!mounted.current || id !== request.current) return;
      setOverview(result); setError(null);
    } catch (failure) {
      if (!mounted.current || id !== request.current) return;
      setError(message(failure)); if (!quiet) setOverview(null);
    } finally { if (mounted.current && id === request.current) setLoading(false); }
  }, [sandboxId]);
  const loadRepos = useCallback(async () => {
    if (!sandboxId) return;
    try {
      const list = await api.gitRepos(sandboxId);
      if (!mounted.current) return;
      setRepos(list); setError(null);
      const next = list.includes(current.current.dir) ? current.current.dir : list[0] ?? "";
      setDir(next);
      if (next) void loadOverview(next, next === current.current.dir);
      else setOverview(null);
    } catch (failure) { if (mounted.current) { setRepos([]); setError(message(failure)); } }
  }, [loadOverview, sandboxId]);
  useEffect(() => {
    mounted.current = true; void loadRepos();
    return () => { mounted.current = false; request.current++; detailRequest.current++; };
  }, [loadRepos]);

  // Commands, clones and file writes can all move branches or change the working tree.
  const cursor = useRef<number | null>(null); const openedAt = useRef(Date.now()); const timer = useRef(0);
  useEffect(() => {
    const latest = hub.events.reduce((max, event) => Math.max(max, event.wireId), 0);
    if (cursor.current === null) { cursor.current = latest; return; }
    const changed = hub.events.some((event) => event.wireId > cursor.current! && event.roomId === roomId &&
      Date.parse(event.createdAt) >= openedAt.current - 5_000 && (event.type === "sandbox.exec.result" || event.type === "file.write"));
    cursor.current = latest;
    if (changed && !timer.current) timer.current = window.setTimeout(() => { timer.current = 0; if (mounted.current) void loadRepos(); }, 600);
  }, [hub.events, roomId, loadRepos]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const choose = async (sha: string | null) => {
    setSelected(sha); setDetail(null); setPatch(null); onReview();
    if (!sandboxId || !sha) return;
    const id = ++detailRequest.current;
    try {
      const result = await api.gitCommit(sandboxId, dir, sha);
      if (mounted.current && id === detailRequest.current) setDetail(result);
    } catch (failure) { if (mounted.current && id === detailRequest.current) setError(message(failure)); }
  };
  const showPatch = async (path: string) => {
    if (!sandboxId || !selected) return;
    const id = ++detailRequest.current; setPatch({ path, text: "" });
    try {
      const text = await api.gitPatch(sandboxId, dir, selected, path);
      if (mounted.current && id === detailRequest.current) setPatch({ path, text: text || "(no textual changes)" });
    } catch (failure) { if (mounted.current && id === detailRequest.current) { setPatch(null); setError(message(failure)); } }
  };
  const run = async (label: string, work: () => Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>, done: string) => {
    if (action) return;
    setAction(label); setNote(null);
    try {
      const result = await work();
      if (!mounted.current) return;
      const ok = result.exitCode === 0 && !result.timedOut;
      setNote({ ok, text: ok ? done : (result.stderr.trim().split("\n").slice(-2).join(" ") || `git exited ${result.exitCode ?? "?"}`) });
      await loadRepos();
    } catch (failure) { if (mounted.current) setNote({ ok: false, text: message(failure) }); }
    finally { if (mounted.current) setAction(null); }
  };

  const rows = useMemo(() => layoutGraph(overview?.commits ?? []), [overview]);
  const width = Math.min(rows.reduce((max, row) => Math.max(max, row.width), 1), 12);
  const refs = useMemo(() => {
    const map = new Map<string, Array<{ name: string; remote: boolean; current: boolean }>>();
    for (const branch of overview?.branches ?? []) map.set(branch.sha, [...(map.get(branch.sha) ?? []), branch]);
    return map;
  }, [overview]);
  // One entry per branch name: a local branch hides its origin/ twin in the checkout list.
  const targets = useMemo(() => {
    const names = new Set<string>();
    for (const branch of overview?.branches ?? []) names.add(branch.remote ? branch.name.replace(/^[^/]+\//, "") : branch.name);
    return [...names].filter((name) => name !== overview?.branch).sort();
  }, [overview]);
  const changes = overview?.changes ?? [];

  return <section className="ide-main ide-git pane" hidden={mode === null}>
    {!sandboxId ? <Empty>provision a sandbox to see repositories</Empty> : repos === null ? <Spinner label="loading" /> : repos.length === 0 ? <Empty>no git repositories in this workspace yet — clone one from the explorer</Empty> : <>
      <div className="git-bar">
        <select aria-label="Repository" value={dir} onChange={(event) => { setDir(event.target.value); setSelected(null); setDetail(null); setPatch(null); setNote(null); void loadOverview(event.target.value); }}>
          {repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
        </select>
        {overview && <Tag tone="info">{overview.branch ?? "detached HEAD"}</Tag>}
        {overview && canWrite && targets.length > 0 && <>
          <select aria-label="Branch to check out" value={targets.includes(target) ? target : ""} onChange={(event) => setTarget(event.target.value)}>
            <option value="">switch branch…</option>
            {targets.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="btn btn-small" disabled={!targets.includes(target) || action !== null} onClick={() => void run("checkout", () => api.gitCheckout(sandboxId, dir, target), `switched to ${target}`)}>{action === "checkout" ? "switching…" : "checkout"}</button>
        </>}
        {overview?.repo && canWrite && <button className="btn btn-small" disabled={action !== null} title={`Fetch ${overview.repo} from GitHub and fast-forward the current branch`}
          onClick={() => void run("pull", () => hub.cloneRepo(sandboxId, overview.repo!).then((result) => result ?? { exitCode: 1, timedOut: false, stdout: "", stderr: hub.error("repo") ?? "refresh failed" }), "refreshed from GitHub")}>{action === "pull" ? "refreshing…" : "refresh from GitHub"}</button>}
        <span className="spacer" />
        {loading ? <Spinner /> : <button className="btn btn-small" onClick={() => void loadRepos()}>reload</button>}
      </div>
      {note && <div className={note.ok ? "note-line" : "error-line"}>{note.text}</div>}
      {error && <div className="error-line">{error}</div>}
      {overview && mode !== "review" && <div className="git-log">
        {changes.length > 0 && <button className={`git-row ${selected === null ? "active" : ""}`} onClick={() => void choose(null)}>
          <span className="git-graph-pad" style={{ width: width * LANE }} /><span className="grow ellip"><Tag tone="warn">uncommitted</Tag> {changes.length} changed file{changes.length === 1 ? "" : "s"}</span>
        </button>}
        {overview.commits.length === 0 ? <Empty>no commits yet</Empty> : overview.commits.map((commit, index) => <button key={commit.sha} className={`git-row ${selected === commit.sha ? "active" : ""}`} onClick={() => void choose(commit.sha)}>
          <Graph row={rows[index]!} width={width} />
          <span className="grow ellip">
            {commit.sha === overview.head && <Tag tone="ok">HEAD</Tag>}
            {(refs.get(commit.sha) ?? []).map((ref) => <Tag key={ref.name} tone={ref.current ? "info" : ref.remote ? "dim" : "msg"}>{ref.name}</Tag>)}
            {" "}{commit.subject}
          </span>
          <span className="muted small nowrap git-meta">{commit.author} · {short(commit.sha)} · {when(commit.date)}</span>
        </button>)}
      </div>}
      {overview && mode === "review" && <div className="git-review">
        {selected === null ? (changes.length > 0
          ? <div className="git-side"><span className="sub-head viewer-head">uncommitted changes</span><div className="git-files">{changes.map((change) => <div key={change.path} className="git-file"><span className="git-code">{change.code.trim() || "·"}</span><span className="grow ellip">{change.path}</span></div>)}</div></div>
          : <Empty>select a commit in the git graph tab</Empty>)
          : !detail ? <Spinner label="loading commit" /> : <>
            <div className="git-side">
              <span className="sub-head viewer-head"><span className="grow ellip">{short(detail.sha)} · {detail.author} · {when(detail.date)}</span>{detail.parents.length > 1 && <Tag>merge</Tag>}</span>
              <pre className="git-message">{detail.message}</pre>
              <div className="git-files">{detail.files.length === 0 ? <Empty>no file changes</Empty> : detail.files.map((file) => <button key={file.path} className={`git-file ${patch?.path === file.path ? "active" : ""}`} onClick={() => void showPatch(file.path)}>
                <span className="grow ellip">{file.path}</span>
                <span className="git-add">{file.additions === null ? "bin" : `+${file.additions}`}</span><span className="git-del">{file.deletions === null ? "" : `−${file.deletions}`}</span>
              </button>)}</div>
            </div>
            {patch ? <pre className="git-patch">{patch.text ? patch.text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : undefined}>{line}{"\n"}</span>) : "loading…"}</pre>
              : <Empty>select a file to see its diff</Empty>}
          </>}
      </div>}
    </>}
  </section>;
}
