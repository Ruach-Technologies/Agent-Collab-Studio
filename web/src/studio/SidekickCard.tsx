// "Your sidekick": bring an AI helper (Claude or ChatGPT), pick its character, and sign it in.
// Sign-in happens on the provider's own site. Claude shows a code the owner pastes back, which goes
// straight to the sidekick's private container; ChatGPT shows a one-time code the owner types on
// OpenAI's page. The hub keeps neither.
import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Sidekick } from "../lib/api";
import { useHub } from "../lib/store";
import { Avatar, AvatarPicker } from "../components/Avatar";
import { fallbackAvatar, type AvatarId } from "../lib/avatars";
import SidekickLive, { LIVE_MODES } from "./SidekickLive";

type Provider = "claude" | "codex";
const PROVIDERS: Record<Provider, { label: string; account: string; plan: string }> = {
  claude: { label: "Claude", account: "Claude", plan: "a Claude Pro or Max plan" },
  codex: { label: "ChatGPT (Codex)", account: "ChatGPT", plan: "a ChatGPT plan that includes Codex" },
};
const providerOf = (value: string): Provider => (value === "codex" ? "codex" : "claude");
const message = (error: unknown) => error instanceof ApiError ? error.message : "Something went wrong. Try again.";
const suggestName = (owner: string) => `${owner.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 28) || "My"} sidekick`;
interface SignInStep { url: string; code: string | null; method: "paste" | "device"; }

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="sk-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sk-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sk-modal-head"><h2>{title}</h2><button type="button" className="btn btn-small" onClick={onClose} aria-label="Close">Close</button></div>
      {children}
    </div>
  </div>;
}

export default function SidekickCard({ onChanged }: { onChanged?: () => void }) {
  const hub = useHub();
  const me = hub.me;
  const [sidekick, setSidekick] = useState<Sidekick | null | undefined>(undefined);
  const [mode, setMode] = useState<"idle" | "create" | "signin" | "remove">("idle");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarId>("robo");
  const [provider, setProvider] = useState<Provider>("claude");
  const [step, setStep] = useState<SignInStep | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => { try { const next = await api.mySidekick(); setSidekick(next); return next; } catch { setSidekick(null); return null; } }, []);
  useEffect(() => { void load(); }, [load]);
  // Follow the sidekick's own events (working, finished, signed in) without polling.
  const lastOwnEvent = sidekick ? [...hub.events].reverse().find((event) => event.actorId === sidekick.agentId && event.type.startsWith("sidekick."))?.key : undefined;
  useEffect(() => { if (lastOwnEvent) void load(); }, [lastOwnEvent, load]);
  // ChatGPT finishes sign-in on its own once the owner approves; check back until it has.
  useEffect(() => {
    if (mode !== "signin" || step?.method !== "device") return;
    const timer = setInterval(() => { void load().then((next) => { if (next?.signIn === "signed_in") { setMode("idle"); setStep(null); onChanged?.(); } }); }, 3000);
    return () => clearInterval(timer);
  }, [mode, step?.method, load, onChanged]);

  if (!me || me.role === "observer" || sidekick === undefined) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setProblem(null);
    try { await work(); } catch (error) { setProblem(message(error)); } finally { setBusy(false); }
  };
  const begin = async (id: string) => { setCode(""); setCopied(false); setStep(await api.sidekickSignIn(id)); };
  const create = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    const created = await api.createSidekick(name.trim(), avatar, provider);
    setSidekick(created); setMode("signin"); setStep(null); onChanged?.();
    // Go straight on to sign-in; starting the sidekick can take a few seconds.
    await begin(created.id);
  }); };
  const startSignIn = () => void run(async () => { setMode("signin"); await begin(sidekick!.id); });
  const finish = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    setSidekick(await api.sidekickCode(sidekick!.id, code.trim())); setMode("idle"); setStep(null); setCode("");
  }); };
  // Closing the sign-in also ends it on the sidekick's side, so ChatGPT stops waiting for approval.
  const close = () => { setMode("idle"); setStep(null); if (sidekick) void api.sidekickCancelSignIn(sidekick.id).then(setSidekick, () => undefined); };

  if (!sidekick) {
    if (mode !== "create") return <div className="sk-card sk-invite">
      <div className="sk-title">Bring your AI sidekick</div>
      <p className="sk-text">Add your own Claude or ChatGPT to this project. It works in the shared workspace when you ask, on your own plan.</p>
      <button className="btn btn-primary" onClick={() => { setMode("create"); setName(suggestName(me.name)); setAvatar(fallbackAvatar(`${me.name}-sidekick`)); }}>Bring a sidekick</button>
    </div>;
    return <Modal title="Bring your AI sidekick" onClose={() => setMode("idle")}><form className="sk-modal-body" onSubmit={create}>
      <div className="studio-small-label">Which AI?</div>
      <div className="sk-providers" role="radiogroup" aria-label="AI provider">
        {(Object.keys(PROVIDERS) as Provider[]).map((id) => <button key={id} type="button" role="radio" aria-checked={provider === id}
          className={provider === id ? "sk-provider sk-provider-on" : "sk-provider"} onClick={() => setProvider(id)}>{PROVIDERS[id].label}</button>)}
      </div>
      <p className="sk-fine">Needs {PROVIDERS[provider].plan}. It runs on your own account and plan.
        {provider === "codex" && <> Before you start, turn on <b>device code sign-in</b> in your ChatGPT settings under Security.</>}</p>
      <label className="studio-small-label" htmlFor="sk-name">Name</label>
      <input id="sk-name" className="studio-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      <div className="studio-small-label">Pick its character</div>
      <div className="sk-picked"><Avatar id={avatar} name={name || "sidekick"} size={44} /><span className="sk-text">{name || "Your sidekick"} · {PROVIDERS[provider].label}</span></div>
      <AvatarPicker value={avatar} onChange={setAvatar} label="Sidekick character" />
      {problem && <div className="studio-problem">{problem}</div>}
      <div className="studio-row"><button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? "Adding…" : "Add sidekick"}</button>
        <button type="button" className="btn" onClick={() => setMode("idle")}>Cancel</button></div>
    </form></Modal>;
  }

  const kind = PROVIDERS[providerOf(sidekick.provider)];
  const ready = sidekick.signIn === "signed_in";
  return <div className="sk-card">
    <div className="sk-head">
      <Avatar id={sidekick.avatar} name={sidekick.name} size={40} />
      <div className="sk-head-text"><div className="sk-title">{sidekick.name}</div>
        <div className="sk-kind">{kind.label}</div>
        <div className={`sk-state ${sidekick.working ? "sk-state-busy" : ready ? "sk-state-ok" : "sk-state-off"}`}>
          {sidekick.working ? "Working…" : ready ? "Ready" : `Needs ${kind.account} sign-in`}</div></div>
    </div>
    {ready && mode !== "remove" && <>
      <p className="sk-text">{sidekick.settings.liveMode === "live" ? <>It follows the room and joins in on its own. Give it work by picking <b>{sidekick.name}</b> in "To" or typing <b>@{sidekick.name}</b>; only you can direct it. Say <b>@{sidekick.name} stop</b> to stop it.</>
        : <>{LIVE_MODES[sidekick.settings.liveMode].help} Ask it with <b>@{sidekick.name}</b> or pick it in "To".</>}</p>
      <SidekickLive sidekick={sidekick} onChange={setSidekick} />
      <div className="studio-row"><button className="btn btn-primary btn-small" onClick={() => window.dispatchEvent(new CustomEvent("studio:message-to", { detail: { agentId: sidekick.agentId } }))}>Message {sidekick.name}</button></div>
      <div className="studio-row"><button className="btn btn-small" disabled={busy} onClick={() => void run(async () => { await api.sidekickSignOut(sidekick.id); await load(); })}>Sign out of {kind.account}</button>
        <button className="btn btn-small" onClick={() => setMode("remove")}>Remove</button></div>
    </>}
    {!ready && mode !== "signin" && mode !== "remove" && <>
      <p className="sk-text">Sign it in with your {kind.account} account. You'll approve on {kind.account}'s own website.</p>
      <div className="studio-row"><button className="btn btn-primary" disabled={busy} onClick={startSignIn}>{busy ? "Starting…" : `Sign in to ${kind.account}`}</button>
        <button className="btn btn-small" onClick={() => setMode("remove")}>Remove</button></div>
    </>}
    {!ready && mode === "signin" && !step && <div className="studio-row"><button className="btn btn-primary" disabled={busy} onClick={startSignIn}>{busy ? "Starting your sidekick…" : `Sign in to ${kind.account}`}</button></div>}
    {!ready && mode === "signin" && step?.method === "paste" && <Modal title={`Sign ${sidekick.name} in to ${kind.account}`} onClose={close}><form className="sk-steps sk-modal-body" onSubmit={finish}>
      <ol className="sk-list">
        <li><a className="btn btn-primary sk-open" href={step.url} target="_blank" rel="noreferrer noopener">Open {kind.account} sign-in</a></li>
        <li>Approve access, then copy the code {kind.account} shows you.</li>
        <li><label className="studio-small-label" htmlFor="sk-code">Paste the code here</label>
          <input id="sk-code" className="studio-input studio-mono" value={code} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} /></li>
      </ol>
      <div className="studio-row"><button className="btn btn-primary" disabled={busy || code.trim().length < 4}>{busy ? "Checking…" : "Finish sign-in"}</button>
        <button type="button" className="btn" onClick={close}>Cancel</button></div>
      <p className="sk-fine">Your sidekick runs on your {kind.account} plan. The code goes straight to your sidekick and isn't kept by this site.</p>
      {problem && <div className="studio-problem">{problem}</div>}
    </form></Modal>}
    {!ready && mode === "signin" && step?.method === "device" && <Modal title={`Sign ${sidekick.name} in to ${kind.account}`} onClose={close}><div className="sk-steps sk-modal-body">
      <ol className="sk-list">
        <li>In ChatGPT, make sure <b>device code sign-in</b> is turned on (Settings → Security).</li>
        <li><a className="btn btn-primary sk-open" href={step.url} target="_blank" rel="noreferrer noopener">Open ChatGPT sign-in</a></li>
        <li>Enter this code there:
          <div className="sk-device"><code className="sk-device-code">{step.code ?? "…"}</code>
            {step.code && <button type="button" className="btn btn-small" onClick={() => { void navigator.clipboard.writeText(step.code!).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "Copied" : "Copy"}</button>}</div></li>
        <li>Approve, then come back here. This finishes by itself.</li>
      </ol>
      <div className="sk-waiting"><span className="la-pulse" aria-hidden="true" />Waiting for you to approve in ChatGPT…</div>
      <div className="studio-row"><button type="button" className="btn" onClick={close}>Cancel</button></div>
      <p className="sk-fine">Your sidekick runs on your ChatGPT plan. This site never sees your ChatGPT password or sign-in.</p>
      {problem && <div className="studio-problem">{problem}</div>}
    </div></Modal>}
    {mode === "remove" && <div className="sk-steps">
      <p className="sk-text">Remove {sidekick.name}? It leaves every project and its {kind.account} sign-in is deleted.</p>
      <div className="studio-row"><button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { await api.removeSidekick(sidekick.id); setSidekick(null); setMode("idle"); onChanged?.(); })}>Remove sidekick</button>
        <button className="btn" onClick={() => setMode("idle")}>Keep it</button></div>
    </div>}
    {problem && mode !== "signin" && <div className="studio-problem">{problem}</div>}
  </div>;
}
