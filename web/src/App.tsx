import { useState, type FormEvent } from "react";
import type { ViewId } from "./types";
import { HubProvider, useHub } from "./lib/store";
import { Sidebar } from "./components/bits";
import { ThemePicker } from "./components/ThemePicker";
import LiveFeed from "./views/LiveFeed";
import Rooms from "./views/Rooms";
import Sandbox from "./views/Sandbox";
import Agents from "./views/Agents";
import Audit from "./views/Audit";
import Security from "./views/Security";
import Studio from "./studio/Studio";
import JoinPage from "./studio/JoinPage";
import { PasskeySignIn, SignInPage } from "./studio/Session";
import "./studio/studio.css";

type Mode = "studio" | "console";
const MODE_KEY = "agent-collab-hub.mode";
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === "console" ? "console" : "studio"; } catch { return "studio"; } };
const saveMode = (mode: Mode) => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ } };

export default function App() {
  return <HubProvider><Shell /></HubProvider>;
}

function Shell() {
  const hub = useHub();
  const [view, setView] = useState<ViewId>("feed");
  const [joining, setJoining] = useState(() => window.location.pathname === "/join");
  const [joinedRoom, setJoinedRoom] = useState<string | null>(null);
  const [linkSignIn, setLinkSignIn] = useState(() => window.location.pathname === "/signin");
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (next: Mode) => { saveMode(next); setModeState(next); };
  // Clients only ever see the Studio; the ops console is for staff.
  const staff = hub.operator || hub.me?.role === "supervisor" || hub.me?.role === "observer";
  if (linkSignIn) return <SignInPage onDone={() => { setLinkSignIn(false); setModeState("studio"); }} />;
  if (joining) return <JoinPage onDone={(roomId) => { setJoinedRoom(roomId); setJoining(false); setModeState("studio"); }} />;
  // Switching workspace as the operator re-verifies without dropping back to the token gate.
  if (hub.phase !== "ready" && !(hub.phase === "verifying" && hub.operator)) return <TokenGate />;
  if (mode === "studio" || !staff) return <Studio initialRoom={joinedRoom} onOpenConsole={staff ? () => setMode("console") : undefined} />;
  return <div className="shell">
    <Sidebar onOpenStudio={() => setMode("studio")} view={view} onNavigate={setView} me={hub.me} conn={hub.conn} roomCount={hub.rooms.length} agentCount={hub.agents.length} eventCount={hub.events.length} onSignOut={hub.logout} workspaces={hub.operator ? hub.workspaces : []} onSwitchWorkspace={hub.switchWorkspace} />
    <main className="main">
      {view === "feed" && <LiveFeed />}
      {view === "rooms" && <Rooms />}
      {view === "sandbox" && <Sandbox />}
      {view === "agents" && <Agents />}
      {view === "audit" && <Audit />}
      {view === "security" && <Security />}
    </main>
  </div>;
}

function TokenGate() {
  const hub = useHub();
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) hub.start(token.trim());
  };
  return <div className="gate"><form className="gate-panel" onSubmit={submit}>
    <div className="gate-title">Collab Studio</div>
    <div className="gate-sub">Opening an invitation? Use the link you were sent.</div>
    <PasskeySignIn />
    <div className="gate-divider"><span>Staff</span></div>
    <input className="gate-input" type="password" autoComplete="off" spellCheck={false} placeholder="paste bearer token" value={token} onChange={(event) => setToken(event.target.value)} />
    <button className="btn" disabled={!token.trim()}>{hub.phase === "verifying" ? "connecting…" : "connect"}</button>
    {hub.authError && <div className="gate-error">{hub.authError}</div>}
    <p className="gate-note">A staff token is kept in sessionStorage for this tab only and is never shown after connecting. Client sign-ins are tied to this browser and end every few hours.</p>
    <ThemePicker className="gate-theme" />
  </form></div>;
}
