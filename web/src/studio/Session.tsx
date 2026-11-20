// Client sessions in the Studio: how long this sign-in lasts, the passkeys that can renew it, the
// staff "sign-in link" button, and the pages a client sees when signing back in.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, ApiError, type SessionInfo } from "../lib/api";
import { useHub } from "../lib/store";
import { ThemePicker } from "../components/ThemePicker";

const friendly = (error: unknown, fallback: string) => {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) return "Passkey sign-in was cancelled.";
  return error instanceof ApiError && error.message ? error.message : fallback;
};
const left = (until: string, now: number) => {
  const minutes = Math.max(0, Math.round((new Date(until).getTime() - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Saves a passkey on this device for the signed-in client. */
export async function addPasskey(): Promise<void> {
  const options = await api.passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
  await api.passkeyRegisterVerify(response, deviceLabel());
}
function deviceLabel(): string {
  const agent = navigator.userAgent;
  const os = /iPhone|iPad/.test(agent) ? "iPhone or iPad" : /Android/.test(agent) ? "Android" : /Mac/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : "This device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "browser";
  return `${os} · ${browser}`;
}

/** Signs a client in with a passkey saved on this device (or a phone nearby). */
export async function signInWithPasskey(): Promise<{ token: string }> {
  const { challengeId, options } = await api.passkeyLoginOptions();
  const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return api.passkeyLoginVerify(challengeId, response);
}

export function useSessionInfo(enabled: boolean): { info: SessionInfo | null; reload: () => void } {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const reload = useCallback(() => { if (enabled) api.session().then(setInfo, () => setInfo(null)); }, [enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { info, reload };
}

/** In the "me" menu: the countdown, passkeys, and what happens when time is up. */
export function SessionPanel() {
  const { info, reload } = useSessionInfo(true);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  if (!info?.session) return null;
  const add = async () => {
    setBusy(true); setProblem(null);
    try { await addPasskey(); reload(); } catch (error) { setProblem(friendly(error, "Saving the passkey didn't finish. Try again.")); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setProblem(null);
    try { await api.removePasskey(id); reload(); } catch (error) { setProblem(friendly(error, "Could not remove that passkey.")); }
  };
  return <div className="studio-popover-foot session-panel">
    <div className="session-line"><span className="session-dot" />Signed in until <b>{clock(info.session.expiresAt)}</b> <span className="session-left">({left(info.session.expiresAt, now)} left)</span></div>
    <p className="session-note">For safety you're signed out every {info.cycleHours} hours. Your work and your sidekick's progress are kept; sign in again to pick up where you left off.</p>
    <div className="studio-small-label">Passkeys</div>
    {info.passkeys.length === 0 ? <p className="session-note">No passkey yet. Save one so you can sign back in yourself, with Face ID, Touch ID or your device PIN.</p>
      : <ul className="session-keys">{info.passkeys.map((key) => <li key={key.id}>
        <span>{key.label ?? "Passkey"}<span className="session-left"> · {key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : `added ${new Date(key.createdAt).toLocaleDateString()}`}</span></span>
        <button className="btn btn-small" onClick={() => void remove(key.id)}>Remove</button></li>)}</ul>}
    <button className="btn" disabled={busy} onClick={() => void add()}>{busy ? "Waiting for your device…" : info.passkeys.length ? "Add another passkey" : "Save a passkey"}</button>
    {problem && <div className="session-problem" role="alert">{problem}</div>}
  </div>;
}

/** A one-time nudge after joining or a link sign-in, until the client has a passkey. */
export function PasskeyNudge() {
  const { info, reload } = useSessionInfo(true);
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem("agent-collab-hub.passkey-nudge") === "no"; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (hidden || !info?.session || info.passkeys.length > 0) return null;
  const dismiss = () => { setHidden(true); try { sessionStorage.setItem("agent-collab-hub.passkey-nudge", "no"); } catch { /* fine */ } };
  const add = async () => {
    setBusy(true); setProblem(null);
    try { await addPasskey(); reload(); } catch (error) { setProblem(friendly(error, "Saving the passkey didn't finish. Try again.")); } finally { setBusy(false); }
  };
  return <div className="passkey-nudge" role="status">
    <div><b>Save a passkey for next time.</b> You'll be signed out every {info.cycleHours} hours; a passkey signs you back in with Face ID, Touch ID or your device PIN, no new link needed.</div>
    <div className="studio-row">
      <button className="btn btn-primary" disabled={busy} onClick={() => void add()}>{busy ? "Waiting for your device…" : "Save a passkey"}</button>
      <button className="btn" onClick={dismiss}>Not now</button>
    </div>
    {problem && <div className="session-problem" role="alert">{problem}</div>}
  </div>;
}

/** Staff: makes a one-time sign-in link for a client whose session ended. */
export function SignInLinkButton({ agentId, name }: { agentId: string; name: string }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = async () => {
    setProblem(null); setCopied(false);
    try { const made = await api.signInLink(agentId); setLink({ url: made.url, expiresAt: made.expiresAt }); }
    catch (error) { setProblem(friendly(error, "Could not make a sign-in link.")); }
  };
  const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } };
  if (!link) return <>
    <button className="btn btn-small studio-link-btn" onClick={() => void make()} title={`Make a one-time sign-in link for ${name}`}>Sign-in link</button>
    {problem && <div className="session-problem" role="alert">{problem}</div>}
  </>;
  return <div className="studio-invite studio-signin-link">
    <div className="studio-small-label">Send this to {name}. It works once, on any device, until {clock(link.expiresAt)}.</div>
    <input className="studio-input studio-mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
    <div className="studio-row"><button className="btn btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button><button className="btn" onClick={() => setLink(null)}>Done</button></div>
  </div>;
}

const LINK = /^achl_[A-Za-z0-9_-]{43}$/;
/** The page a sign-in link opens. The code is in the #fragment, so it never reaches a server log. */
export function SignInPage({ onDone }: { onDone: () => void }) {
  const hub = useHub();
  const [code] = useState(() => { const value = window.location.hash.replace(/^#/, ""); return LINK.test(value) ? value : null; });
  const [problem, setProblem] = useState<string | null>(code ? null : "This sign-in link is incomplete. Open the whole link you were sent, or ask for a new one.");
  const [busy, setBusy] = useState(false);
  const go = async (event: FormEvent) => {
    event.preventDefault();
    if (!code || busy) return;
    setBusy(true); setProblem(null);
    try {
      const signed = await api.signInWithLink(code);
      window.history.replaceState(null, "", "/");
      hub.start(signed.token, true);
      onDone();
    } catch (error) { setProblem(friendly(error, "Something went wrong. Check your connection and try again.")); } finally { setBusy(false); }
  };
  return <div className="join"><form className="join-card" onSubmit={go}>
    <div className="join-brand">Collab Studio</div>
    <h1 className="join-title">Sign back in</h1>
    <p className="join-lead">Your project, your chat and your sidekick are where you left them. This link signs you in on this browser.</p>
    {code && <button className="btn btn-primary join-go" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>}
    <p className="join-fine">The link works once and only for a few minutes. Signing in here doesn't sign you out anywhere else.</p>
    {problem && <div className="join-problem" role="alert">{problem}</div>}
    <ThemePicker className="join-theme" />
  </form></div>;
}

/** On the sign-in screen: the client's own way back in. */
export function PasskeySignIn() {
  const hub = useHub();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setProblem(null);
    try { const signed = await signInWithPasskey(); hub.start(signed.token, true); }
    catch (error) { setProblem(friendly(error, "That passkey didn't work here. Ask for a sign-in link instead.")); } finally { setBusy(false); }
  };
  return <div className="gate-client">
    {hub.sessionEnded && <div className="gate-ended" role="status">{hub.sessionEnded}</div>}
    <button type="button" className="btn btn-primary gate-passkey" disabled={busy} onClick={() => void go()}>{busy ? "Waiting for your device…" : "Continue with passkey"}</button>
    <div className="gate-sub">No passkey on this device? Ask the person who invited you for a sign-in link.</div>
    {problem && <div className="gate-error" role="alert">{problem}</div>}
  </div>;
}
