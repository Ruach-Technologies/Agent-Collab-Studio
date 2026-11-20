import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, getToken, type InvitePreview } from "../lib/api";
import { useHub } from "../lib/store";
import { AvatarPicker, Avatar } from "../components/Avatar";
import { fallbackAvatar, type AvatarId } from "../lib/avatars";
import { ThemePicker } from "../components/ThemePicker";

const CODE = /^achi_[A-Za-z0-9_-]{32}$/;

/** The invite code lives in the link's #fragment, so it never reaches a server log or a Referer header. */
export function readInviteCode(): string | null {
  const code = window.location.hash.replace(/^#/, "");
  return CODE.test(code) ? code : null;
}

const friendly = (error: unknown) =>
  error instanceof ApiError ? error.message : "Something went wrong. Check your connection and try again.";

export default function JoinPage({ onDone }: { onDone: (roomId: string) => void }) {
  const hub = useHub();
  const [code] = useState(readInviteCode);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(code ? null : "This invite link is incomplete. Open the full link from your invitation, or ask for a new one.");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarId>("sprout");
  const [busy, setBusy] = useState(false);
  // A guest who is already signed in on this device gets the room added to their existing login.
  const signedIn = hub.phase === "ready" && hub.me !== null && getToken() !== null;

  useEffect(() => {
    if (!code) return;
    let live = true;
    api.previewInvite(code).then((result) => {
      if (!live) return;
      setPreview(result);
      if (result.suggestedName) { setName(result.suggestedName); setAvatar(fallbackAvatar(result.suggestedName)); }
    }).catch((error: unknown) => { if (live) setProblem(friendly(error)); });
    return () => { live = false; };
  }, [code]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (!code || busy) return;
    setBusy(true); setProblem(null);
    try {
      const result = await api.redeemInvite(code, signedIn ? undefined : name.trim(), signedIn ? undefined : avatar);
      if (result.token) hub.start(result.token, true);
      else await hub.refreshRooms();
      window.history.replaceState(null, "", "/");
      onDone(result.roomId);
    } catch (error) {
      // A signed-in staff token is not a guest login; fall back to joining as a new person.
      setProblem(friendly(error));
    } finally { setBusy(false); }
  };

  return <div className="join">
    <form className="join-card" onSubmit={join}>
      <div className="join-brand">Collab Studio</div>
      {!preview && !problem && <p className="join-lead">Checking your invitation…</p>}
      {preview && <>
        <h1 className="join-title">Join <span className="join-room">{preview.roomName}</span></h1>
        <p className="join-lead">{preview.invitedBy} invited you to build together. You'll see the work happen live and can ask for changes in plain words.</p>
        {signedIn ? <div className="join-me">
          <Avatar id={hub.me?.avatar ?? null} name={hub.me?.name ?? ""} size={40} />
          <div><div className="join-me-name">You're signed in as {hub.me?.name}</div><div className="join-hint">This project will be added to your existing login.</div></div>
        </div> : <>
          <label className="join-label" htmlFor="join-name">Your name</label>
          <input id="join-name" className="join-input" value={name} autoFocus maxLength={40} autoComplete="name"
            onChange={(e) => setName(e.target.value)} placeholder="How should people see you?" />
          <div className="join-label">Pick your character</div>
          <div className="join-picked"><Avatar id={avatar} name={name || "you"} size={56} /><span className="join-hint">This is how you'll appear next to your messages.</span></div>
          <AvatarPicker value={avatar} onChange={setAvatar} label="Pick your character" />
        </>}
        <button className="btn btn-primary join-go" disabled={busy || (!signedIn && !name.trim())}>{busy ? "Joining…" : signedIn ? "Add this project" : "Join the room"}</button>
        <p className="join-fine">This link works once and expires {new Date(preview.expiresAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })}. You'll stay signed in on this browser for a few hours, and can save a passkey to sign back in.</p>
      </>}
      {problem && <div className="join-problem" role="alert">{problem}</div>}
      <ThemePicker className="join-theme" />
    </form>
  </div>;
}
