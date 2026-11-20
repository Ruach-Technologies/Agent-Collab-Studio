// The owner's controls for a live sidekick: how freely it joins in, how chatty it is, its limits,
// a Stop button while it works, and a usage meter for the last hour and day.
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Banter, type LiveMode, type Sidekick } from "../lib/api";

export const LIVE_MODES: Record<LiveMode, { label: string; short: string; help: string }> = {
  live: { label: "Full live", short: "Live", help: "Follows the room and joins in on its own when it has something useful to add. Works for you when you ask." },
  mentions: { label: "When mentioned", short: "Mentions", help: "Replies when anyone @mentions it. Works only for you." },
  owner: { label: "Only me", short: "Only you", help: "Stays quiet unless you ask it something." },
  paused: { label: "Paused", short: "Paused", help: "Does nothing until you turn it back on." },
};
const BANTER: Record<Banter, { label: string; help: string }> = {
  chatty: { label: "Chatty", help: "Friendly updates as it works, up to 6 a job." },
  brief: { label: "Brief", help: "Up to 2 one-line updates a job, no small talk." },
  quiet: { label: "Quiet", help: "No updates; just its final reply." },
};
const TRIGGER = { owner: "you asked", mention: "it was mentioned", live: "joining in" } as const;
const problemText = (error: unknown) => (error instanceof ApiError ? error.message : "That didn't work. Try again.");
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Meter({ label, value, max, detail }: { label: string; value: number; max: number | null; detail?: string }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  const tone = ratio >= 0.9 ? "bad" : ratio >= 0.7 ? "warn" : "ok";
  return <div className="skl-meter">
    <div className="skl-meter-top"><span>{label}</span><span className="skl-meter-num">{compact(value)}{max ? ` / ${compact(max)}` : ""}</span></div>
    <div className="skl-bar" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max ?? undefined}>
      {max ? <span className={`skl-fill skl-fill-${tone}`} style={{ width: `${Math.max(2, ratio * 100)}%` }} /> : <span className="skl-fill skl-fill-none" />}
    </div>
    {detail && <div className="skl-meter-detail">{detail}</div>}
  </div>;
}

export default function SidekickLive({ sidekick, onChange }: { sidekick: Sidekick; onChange: (next: Sidekick) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const s = sidekick.settings;
  const [mode, setMode] = useState<LiveMode>(s.liveMode);
  const [banter, setBanter] = useState<Banter>(s.banter);
  const [perHour, setPerHour] = useState(String(s.jobsPerHour));
  const [perDay, setPerDay] = useState(String(s.jobsPerDay));
  const [steps, setSteps] = useState(String(s.stepsPerJob));
  const [tokens, setTokens] = useState(s.tokensPerDay ? String(s.tokensPerDay) : "");
  useEffect(() => {
    if (open) return;
    setMode(s.liveMode); setBanter(s.banter); setPerHour(String(s.jobsPerHour)); setPerDay(String(s.jobsPerDay)); setSteps(String(s.stepsPerJob)); setTokens(s.tokensPerDay ? String(s.tokensPerDay) : "");
  }, [open, s.liveMode, s.banter, s.jobsPerHour, s.jobsPerDay, s.stepsPerJob, s.tokensPerDay]);

  const act = async (work: () => Promise<Sidekick>) => {
    setBusy(true); setProblem(null);
    try { onChange(await work()); return true; } catch (error) { setProblem(problemText(error)); return false; } finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const whole = (text: string) => Number.parseInt(text, 10);
    void act(() => api.sidekickSettings(sidekick.id, { liveMode: mode, banter, jobsPerHour: whole(perHour), jobsPerDay: whole(perDay), stepsPerJob: whole(steps),
      tokensPerDay: tokens.trim() ? whole(tokens) : null })).then((ok) => { if (ok) setOpen(false); });
  };
  const u = sidekick.usage;
  const paused = s.liveMode === "paused";

  return <div className="skl">
    <div className="skl-row">
      <span className={`skl-mode skl-mode-${s.liveMode}`}><span className="skl-dot" aria-hidden="true" />{LIVE_MODES[s.liveMode].label}</span>
      <span className="skl-banter">{BANTER[s.banter].label}</span>
      <button className="studio-link skl-settings" onClick={() => setOpen(true)}>Live settings</button>
    </div>
    {sidekick.current && <div className="skl-working">
      <span className="la-pulse" aria-hidden="true" />
      <span>Working because {TRIGGER[sidekick.current.trigger]} · {sidekick.current.steps} steps{sidekick.current.posts ? ` · ${sidekick.current.posts} updates` : ""}</span>
      <button className="btn btn-danger btn-small" disabled={busy} onClick={() => void act(() => api.stopSidekick(sidekick.id))}>Stop</button>
    </div>}
    <div className="studio-row">
      {paused
        ? <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void act(() => api.sidekickSettings(sidekick.id, { liveMode: "live" }))}>Go live</button>
        : <button className="btn btn-small" disabled={busy} onClick={() => void act(() => api.stopSidekick(sidekick.id, true))}>{sidekick.current ? "Stop and pause" : "Pause"}</button>}
    </div>
    <div className="skl-usage" aria-label="Usage">
      <div className="studio-small-label">Usage</div>
      <Meter label="Jobs this hour" value={u.hourJobs} max={s.jobsPerHour} />
      <Meter label="Jobs in the last 24 hours" value={u.dayJobs} max={s.jobsPerDay} detail={u.dayLiveJobs ? `${u.dayLiveJobs} of them joining in on its own` : undefined} />
      <Meter label="Tokens in the last 24 hours" value={u.dayTokens} max={s.tokensPerDay}
        detail={[s.tokensPerDay ? null : "No daily cap", u.dayMinutes ? `${u.dayMinutes} min working` : null, u.dayCostUsd !== null && u.dayCostUsd > 0 ? `≈ $${u.dayCostUsd.toFixed(2)} at API prices, covered by your plan` : null].filter(Boolean).join(" · ") || undefined} />
    </div>
    {problem && !open && <div className="studio-problem">{problem}</div>}

    {open && <div className="sk-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <form className="sk-modal skl-modal" role="dialog" aria-modal="true" aria-label="Live settings" onSubmit={save}>
        <div className="sk-modal-head"><h2>{sidekick.name}'s live settings</h2><button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Close</button></div>
        <div className="sk-modal-body">
          <fieldset className="skl-field"><legend className="studio-small-label">How it joins in</legend>
            {(Object.keys(LIVE_MODES) as LiveMode[]).map((id) => <label key={id} className={mode === id ? "skl-choice skl-choice-on" : "skl-choice"}>
              <input type="radio" name="live-mode" checked={mode === id} onChange={() => setMode(id)} />
              <span><b>{LIVE_MODES[id].label}</b><span className="skl-help">{LIVE_MODES[id].help}</span></span>
            </label>)}
          </fieldset>
          <fieldset className="skl-field"><legend className="studio-small-label">Updates while it works</legend>
            <div className="sk-providers" role="radiogroup" aria-label="Updates while it works">
              {(Object.keys(BANTER) as Banter[]).map((id) => <button key={id} type="button" role="radio" aria-checked={banter === id}
                className={banter === id ? "sk-provider sk-provider-on" : "sk-provider"} onClick={() => setBanter(id)}>{BANTER[id].label}</button>)}
            </div>
            <p className="sk-fine">{BANTER[banter].help}</p>
          </fieldset>
          <fieldset className="skl-field"><legend className="studio-small-label">Limits</legend>
            <div className="skl-limits">
              <label>Jobs per hour<input className="studio-input" type="number" min={1} max={500} required value={perHour} onChange={(e) => setPerHour(e.target.value)} /></label>
              <label>Jobs per day<input className="studio-input" type="number" min={1} max={5000} required value={perDay} onChange={(e) => setPerDay(e.target.value)} /></label>
              <label>Steps per job<input className="studio-input" type="number" min={1} max={200} required value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
              <label>Tokens per day<input className="studio-input" type="number" min={1000} step={1000} placeholder="No cap" value={tokens} onChange={(e) => setTokens(e.target.value)} /></label>
            </div>
            <p className="sk-fine">Every job uses your own {sidekick.provider === "codex" ? "ChatGPT" : "Claude"} plan. When it reaches a limit it takes a break and says so if someone asked it directly.</p>
          </fieldset>
          {problem && <div className="studio-problem">{problem}</div>}
          <div className="studio-row"><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
        </div>
      </form>
    </div>}
  </div>;
}
