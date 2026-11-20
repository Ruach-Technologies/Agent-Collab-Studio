// Preview: the project's live development server. Anyone in the project can watch the app being
// built; team members (not observers) can start, stop and restart it. The page itself is served
// from a separate preview address, never from this app's own origin.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useHub } from "../lib/store";
import { api, ApiError } from "../lib/api";

type DevStatus = Awaited<ReturnType<typeof api.devServerStatus>>;

const DEFAULT_CMD = "npm run dev";
// Preview sizes. The frame's width is the page's viewport, so the app's mobile layout shows at Phone.
const DEVICES = { desktop: { label: "Desktop", size: null }, tablet: { label: "Tablet", size: [820, 1180] }, phone: { label: "Phone", size: [390, 844] } } as const;
type Device = keyof typeof DEVICES;
const savedDevice = (): Device => { try { const v = localStorage.getItem("preview-device"); return v === "tablet" || v === "phone" ? v : "desktop"; } catch { return "desktop"; } };
const DEFAULT_PORT = 5173;

const describeError = (error: unknown) => error instanceof ApiError ? error.message : "Something went wrong. Try again.";
const ago = (iso: string | null) => {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export default function DevServer({ roomId }: { roomId: string }) {
  const hub = useHub();
  const sandbox = hub.sandboxes.find((item) => item.roomId === roomId) ?? null;
  const sandboxId = sandbox?.status === "running" ? sandbox.id : null;
  const canControl = hub.operator || (!!hub.me && hub.me.role !== "observer");

  const [status, setStatus] = useState<DevStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [cmd, setCmd] = useState(DEFAULT_CMD);
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [dir, setDir] = useState("");
  const [edited, setEdited] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [runScripts, setRunScripts] = useState(true);
  const [installed, setInstalled] = useState<{ ok: boolean; output: string } | null>(null);
  const [address, setAddress] = useState("/");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>(savedDevice);
  const [landscape, setLandscape] = useState(false);
  const chooseDevice = (next: Device) => { setDevice(next); try { localStorage.setItem("preview-device", next); } catch { /* per-viewer convenience only */ } };
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    if (!sandboxId) return;
    try {
      const next = await api.devServerStatus(sandboxId);
      setStatus(next);
      setError(null);
    } catch (err) { setError(describeError(err)); }
  }, [sandboxId]);

  // Reset when switching projects.
  useEffect(() => { setStatus(null); setFrameUrl(null); setFrameNote(null); setEdited(false); setAddress("/"); setError(null); }, [roomId]);
  // Pre-fill the form from the server's last settings until someone edits it.
  useEffect(() => {
    if (!status || edited) return;
    setCmd(status.cmd); setPort(String(status.port)); setDir(status.dir);
  }, [status, edited]);

  // Poll while the tab is open: quickly while starting, slowly otherwise.
  const state = status?.state ?? null;
  useEffect(() => {
    if (!sandboxId) return;
    void refresh();
    const every = state === "starting" ? 2_000 : 6_000;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, every);
    return () => window.clearInterval(timer);
  }, [sandboxId, state, refresh]);

  // Someone else started or stopped it: refresh straight away.
  const lastDevEvent = useMemo(() => [...hub.events].reverse().find((event) => event.roomId === roomId && event.type.startsWith("devserver.") && event.type !== "devserver.preview.opened")?.key, [hub.events, roomId]);
  useEffect(() => { if (lastDevEvent) void refresh(); }, [lastDevEvent, refresh]);

  useEffect(() => { if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [status?.log, showLog]);

  // A fresh single-use sign-in link for the preview address, for the frame or a new tab.
  const openFrame = useCallback(async (path: string) => {
    if (!sandboxId) return;
    try {
      const ticket = await api.devServerTicket(sandboxId, path);
      setFrameUrl(ticket.url);
      setFrameNote(ticket.url ? null : ticket.message);
    } catch (err) { setFrameUrl(null); setFrameNote(describeError(err)); }
  }, [sandboxId]);

  const running = state === "running";
  const startedAt = status?.startedAt ?? null;
  useEffect(() => {
    if (running && status?.preview.reachable) void openFrame(address);
    if (!running) setFrameUrl(null);
    // Re-open only when the server comes up or is restarted, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, startedAt, status?.preview.reachable]);

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!sandboxId) return;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) { setError("The port must be a number between 1024 and 65535."); return; }
    setBusy("start"); setError(null);
    try {
      await api.startDevServer(sandboxId, { cmd: cmd.trim() || DEFAULT_CMD, port: portNumber, ...(dir.trim() ? { dir: dir.trim() } : {}) });
      setEdited(false);
      await refresh();
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); }
  };
  // Start, the "just press it" way: the hub works out the folder, command and port from the cloned
  // files; packages are installed first when they are missing.
  const autoStart = async () => {
    if (!sandboxId) return;
    setBusy("start"); setError(null); setInstalled(null);
    try {
      setPhase("Looking at the project…");
      const portNumber = Number(port);
      const plan = await api.devServerPlan(sandboxId, Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535 ? portNumber : undefined);
      if (!plan) { setError("There's no app to run yet. Clone a repository from the Workspace tab, or set the command and folder in Settings."); return; }
      if (plan.needsInstall) {
        setPhase(`Installing packages for ${plan.installDir || "the workspace"}… The first time takes a few minutes.`);
        const result = await api.installDependencies(sandboxId, plan.installDir || ".", true);
        if (!result.ok) { setInstalled(result); setShowSettings(true); setError("Installing the app's packages failed. The install output is under Settings."); return; }
      }
      setPhase(`Starting the ${plan.summary}…`);
      await api.startDevServer(sandboxId, { cmd: plan.cmd, port: plan.port, dir: plan.dir });
      setEdited(false);
      await refresh();
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); setPhase(null); }
  };
  const stop = async () => {
    if (!sandboxId) return;
    setBusy("stop"); setError(null);
    try { await api.stopDevServer(sandboxId); await refresh(); } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); }
  };
  const go = (event: FormEvent) => {
    event.preventDefault();
    const path = address.trim().startsWith("/") ? address.trim() : `/${address.trim()}`;
    setAddress(path);
    void openFrame(path);
  };
  const openInTab = async () => {
    if (!sandboxId) return;
    // Open the tab now (inside the click) so it is not blocked, then send it to the preview.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const ticket = await api.devServerTicket(sandboxId, address);
      if (ticket.url && tab) tab.location.href = ticket.url;
      else { tab?.close(); setFrameNote(ticket.message ?? "The preview could not be opened."); }
    } catch (err) { tab?.close(); setFrameNote(describeError(err)); }
  };

  if (!sandbox || sandbox.status !== "running") return <div className="dv-empty">
    <h2>No live preview yet</h2>
    <p>The preview runs inside this project’s shared workspace, which isn’t switched on yet.</p>
    <p className="studio-sub">{hub.operator || hub.me?.role === "supervisor" ? "Set it up from the Workspace tab, then come back here." : "Ask the project’s host to set up the workspace."}</p>
  </div>;

  const headline = !status ? "Checking the preview…"
    : status.state === "running" ? "Live"
    : status.state === "starting" ? "Starting up…"
    : status.state === "exited" ? "Stopped unexpectedly" : "Off";
  const explain = !status ? null
    : status.state === "running" ? `Showing the app as it is right now. Changes the team makes appear here${status.startedBy ? `; started by ${hub.agentName(status.startedBy)} ${ago(status.startedAt)}` : ""}.`
    : status.state === "starting" ? "The app is getting ready. The first start can take a little while."
    : status.state === "exited" ? `The app stopped${status.exitCode !== null ? ` (exit code ${status.exitCode})` : ""}. The log says why. Start works out how to run the project and tries again.`
    : canControl ? "Press Start: it finds the app in the project, installs its packages if needed and runs it here." : "The preview is off. Someone on the team can start it.";

  return <div className="dv">
    <section className="dv-bar" aria-label="Dev server">
      <div className="dv-status">
        <span className={`dv-pill dv-pill-${status?.state ?? "unknown"}`}><span className="dv-dot" aria-hidden="true" />{headline}</span>
        <span className="dv-explain">{phase ?? explain}</span>
      </div>
      <div className="dv-actions">
        {canControl && (status?.state === "stopped" || status?.state === "exited" || !status) && <button className="btn btn-primary" disabled={!!busy || !status} onClick={() => void autoStart()}>{busy === "start" ? "Starting…" : "Start"}</button>}
        {canControl && status && (status.state === "starting" || status.state === "running") && <>
          <button className="btn" disabled={!!busy} onClick={() => void start()}>{busy === "start" ? "Restarting…" : "Restart"}</button>
          <button className="btn btn-danger" disabled={!!busy} onClick={() => void stop()}>{busy === "stop" ? "Stopping…" : "Stop"}</button>
        </>}
        {canControl && <button className="btn" aria-expanded={showSettings} onClick={() => setShowSettings((open) => !open)}>Settings</button>}
        <button className="btn" aria-expanded={showLog} onClick={() => setShowLog((open) => !open)}>{showLog ? "Hide log" : "Log"}</button>
      </div>
    </section>

    {showSettings && canControl && <form className="dv-settings" onSubmit={(event) => void start(event)}>
      <label className="dv-field dv-field-wide"><span className="studio-small-label">Command</span>
        <input className="dv-input" value={cmd} maxLength={512} spellCheck={false} onChange={(e) => { setCmd(e.target.value); setEdited(true); }} placeholder={DEFAULT_CMD} /></label>
      <label className="dv-field"><span className="studio-small-label">Port</span>
        <input className="dv-input" value={port} inputMode="numeric" onChange={(e) => { setPort(e.target.value); setEdited(true); }} placeholder={String(DEFAULT_PORT)} /></label>
      <label className="dv-field"><span className="studio-small-label">Folder</span>
        <input className="dv-input" value={dir} maxLength={200} spellCheck={false} onChange={(e) => { setDir(e.target.value); setEdited(true); }} placeholder="the project folder (automatic)" /></label>
      <button className="btn btn-primary" type="submit" disabled={!!busy}>{status && status.state !== "stopped" ? "Restart with these" : "Start with these"}</button>
      <button className="btn" type="button" disabled={installing || !sandboxId} onClick={() => {
        if (!sandboxId) return;
        setInstalling(true); setInstalled(null);
        api.installDependencies(sandboxId, dir.trim() || ".", runScripts).then(setInstalled, (problem: unknown) => setInstalled({ ok: false, output: problem instanceof Error ? problem.message : "The install did not run." }))
          .finally(() => setInstalling(false));
      }}>{installing ? "Installing… (up to a few minutes)" : "Install dependencies"}</button>
      <label className="dv-check"><input type="checkbox" checked={runScripts} onChange={(e) => setRunScripts(e.target.checked)} /> Run the packages' install scripts (offline)</label>
      <p className="dv-hint">The workspace is sealed off from the internet and from the host's computer. <b>Install dependencies</b> is the one exception: it downloads the folder's npm packages from the public registry, then runs their install scripts with no internet access. The app should listen on the port above.</p>
      {installed && <pre className={installed.ok ? "dv-log dv-install-ok" : "dv-log dv-install-bad"} aria-label="Install output">{installed.output || (installed.ok ? "Done." : "The install failed.")}</pre>}
    </form>}

    {error && <div className="dv-error" role="alert">{error}</div>}
    {status && (status.state === "starting" || status.state === "running") && <p className="dv-hint">Running <code>{status.cmd}</code> in <code>/workspace{status.dir ? `/${status.dir}` : ""}</code> on port {status.port}.</p>}

    {showLog && <pre ref={logRef} className="dv-log" aria-label="Dev server log">{status?.log || "Nothing in the log yet."}</pre>}

    <section className="dv-preview" aria-label="Preview">
      <form className="dv-address" onSubmit={go}>
        <input className="dv-input dv-path" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Page address" spellCheck={false} disabled={!running} />
        <button className="btn" type="submit" disabled={!running}>Go</button>
        <button className="btn" type="button" disabled={!running} onClick={() => void openFrame(address)} title="Reload the preview">Reload</button>
        <button className="btn" type="button" disabled={!running || !status?.preview.reachable} onClick={() => void openInTab()}>Open in new tab</button>
        <span className="dv-devices" role="group" aria-label="Preview size">
          {(Object.keys(DEVICES) as Device[]).map((key) => <button key={key} type="button" className={`btn dv-device${device === key ? " is-on" : ""}`}
            aria-pressed={device === key} onClick={() => chooseDevice(key)}>{DEVICES[key].label}</button>)}
          {device !== "desktop" && <button type="button" className="btn dv-device" aria-pressed={landscape} title="Rotate" onClick={() => setLandscape((on) => !on)}>{landscape ? "Landscape" : "Portrait"}</button>}
        </span>
      </form>
      {running && status && !status.preview.reachable
        ? <div className="dv-placeholder"><p>{status.preview.message ?? "The preview can’t be opened from this computer."}</p></div>
        : running && frameUrl
          ? <div className={`dv-stage dv-stage-${device}`}>
              {(() => {
                const size = DEVICES[device].size;
                const [w, h] = size ? (landscape ? [size[1], size[0]] : size) : [0, 0];
                return <>
                  <iframe key={frameUrl} className={size ? "dv-frame dv-frame-device" : "dv-frame"} src={frameUrl} title="Live preview"
                    style={size ? { width: w, height: h } : undefined}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" />
                  {size && <span className="dv-size">{w} × {h}</span>}
                </>;
              })()}
            </div>
          : <div className="dv-placeholder"><p>{frameNote ?? (running ? "Opening the preview…" : status?.state === "starting" ? "The preview appears here as soon as the app is ready." : "When the preview is running, the app appears here.")}</p></div>}
      {running && status?.preview.localOnly && status.preview.reachable && <p className="dv-hint">This preview opens only in a browser on the hub’s own computer.</p>}
    </section>
  </div>;
}
