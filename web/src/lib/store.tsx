import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnState, ExecResult, FileEntry, Phase, RepoResult, SandboxInfo, UiAgent, UiEvent, UiExec, UiMessage, UiRoom, WsServerFrame } from "../types";
import { api, ApiError, clearToken, getToken, getWorkspace, saveToken, saveWorkspace, SECURITY_ALERT_EVENT, SESSION_ENDED_EVENT } from "./api";
import { forgetDeviceKey, SESSION_TOKEN } from "./device";
import { normalizeAgent, normalizeEvent, normalizeMessage, normalizeExecResult } from "./normalize";
import { useHubSocket, type SocketStatus } from "./useHubSocket";

export interface EventEntry extends UiEvent { seq: number; key: string; }
export interface HubStore {
  phase: Phase; authError: string | null; start(token: string, remember?: boolean): void; logout(): Promise<void>;
  /** Why a client's session just ended (time limit, signed out elsewhere, wrong browser), for the sign-in screen. */
  sessionEnded: string | null;
  /** Local operator sessions can act in any workspace; ordinary tokens have exactly one. */
  operator: boolean; workspaces: Array<{ id: string; name: string }>; switchWorkspace(id: string): void;
  me: UiAgent | null; conn: ConnState; wsStatus: SocketStatus; wsAttempts: number; wsError: string | null;
  rooms: UiRoom[]; agents: UiAgent[]; events: EventEntry[];
  messagesByRoom: Record<string, UiMessage[]>; membersByRoom: Record<string, string[]>;
  presence: Record<string, string[]>; sandboxes: SandboxInfo[]; localExecsByRoom: Record<string, UiExec[]>;
  agentName(id: string | null | undefined): string; roomName(id: string | null | undefined): string;
  refreshAll(): Promise<void>; refreshRooms(): Promise<void>; refreshAgents(): Promise<void>;
  refreshEvents(): Promise<void>; refreshMessages(roomId: string): Promise<void>;
  refreshSandbox(roomId: string): Promise<void>; provisionSandbox(roomId: string): Promise<void>;
  createRoom(name: string): Promise<boolean>; joinRoom(roomId: string): Promise<boolean>;
  postMessage(roomId: string, body: string, to?: string): Promise<boolean>;
  runExec(roomId: string, sandboxId: string, cmd: string): Promise<ExecResult | null>;
  recordExec(roomId: string, exec: UiExec): void;
  listFiles(sandboxId: string, path: string): Promise<FileEntry[] | null>;
  readFile(sandboxId: string, path: string): Promise<string | null>;
  writeFile(sandboxId: string, path: string, content: string): Promise<boolean>;
  cloneRepo(sandboxId: string, repo: string, ref?: string): Promise<RepoResult | null>;
  errors: Record<string, string>; error(key: string): string | null; clearError(key: string): void;
}
const Context = createContext<HubStore | null>(null);
export function useHub(): HubStore {
  const value = useContext(Context);
  if (!value) throw new Error("useHub must be used within HubProvider");
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
}

export function HubProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [phase, setPhase] = useState<Phase>(token ? "verifying" : "no-token");
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [me, setMe] = useState<UiAgent | null>(null);
  const [operator, setOperator] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspace, setWorkspace] = useState<string | null>(() => getWorkspace());
  const [rooms, setRooms] = useState<UiRoom[]>([]);
  const [agents, setAgents] = useState<UiAgent[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, UiMessage[]>>({});
  const [membersByRoom, setMembersByRoom] = useState<Record<string, string[]>>({});
  const [presence, setPresence] = useState<Record<string, string[]>>({});
  const [sandboxes, setSandboxes] = useState<SandboxInfo[]>([]);
  const [localExecsByRoom, setLocalExecsByRoom] = useState<Record<string, UiExec[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const seen = useRef(new Set<string>());
  const setError = useCallback((key: string, error: unknown) => setErrors((current) => ({ ...current, [key]: errorMessage(error) })), []);
  const clearError = useCallback((key: string) => setErrors((current) => {
    if (!(key in current)) return current;
    const next = { ...current }; delete next[key]; return next;
  }), []);

  const ingestEvents = useCallback((incoming: UiEvent[]) => {
    const fresh: EventEntry[] = [];
    for (const event of incoming) {
      const key = event.wireId ? `wire:${event.wireId}` : event.id;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh.push({ ...event, seq: ++sequence.current, key });
    }
    if (seen.current.size > 6000) seen.current = new Set([...seen.current].slice(-3000));
    if (fresh.length) setEvents((current) => [...current, ...fresh].sort((a, b) => a.wireId - b.wireId).slice(-1500));
  }, []);
  const ingestMessages = useCallback((incoming: UiMessage[]) => setMessagesByRoom((current) => {
    const next = { ...current };
    for (const message of incoming) {
      const rows = next[message.roomId] ?? [];
      next[message.roomId] = [...rows.filter((row) => row.id !== message.id), message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return next;
  }), []);
  const recordExec = useCallback((roomId: string, exec: UiExec) => setLocalExecsByRoom((current) => ({
    ...current, [roomId]: [exec, ...(current[roomId] ?? []).filter((item) => item.id !== exec.id)].slice(0, 50),
  })), []);

  const refreshRooms = useCallback(async () => {
    try { setRooms(await api.listRooms()); clearError("rooms"); } catch (error) { setError("rooms", error); }
  }, [clearError, setError]);
  const refreshAgents = useCallback(async () => {
    try { setAgents(await api.listAgents()); clearError("agents"); } catch (error) { setError("agents", error); }
  }, [clearError, setError]);
  const refreshEvents = useCallback(async () => {
    try { ingestEvents(await api.listEvents()); clearError("events"); } catch (error) { setError("events", error); }
  }, [clearError, ingestEvents, setError]);
  const refreshMessages = useCallback(async (roomId: string) => {
    try {
      const [messages, members] = await Promise.all([api.listMessages(roomId), api.listMembers(roomId)]);
      ingestMessages(messages);
      setMembersByRoom((current) => ({ ...current, [roomId]: members }));
      clearError(`messages:${roomId}`);
    } catch (error) { setError(`messages:${roomId}`, error); }
  }, [clearError, ingestMessages, setError]);
  const refreshSandbox = useCallback(async (roomId: string) => {
    try {
      const sandbox = await api.sandboxStatus(roomId);
      setSandboxes((current) => [...current.filter((item) => item.roomId !== roomId), ...(sandbox ? [sandbox] : [])]);
      if (sandbox) {
        const rows = await api.listExecs(sandbox.id);
        const execs = rows.map((raw) => {
          const row = raw as Record<string, unknown>; const result = normalizeExecResult(row);
          return { id: result.execId, cmd: String(row.cmd), ...result, actorId: String(row.agent_id), createdAt: String(row.created_at) };
        });
        setLocalExecsByRoom((current) => ({ ...current, [roomId]: execs }));
      }
      clearError(`sandbox:${roomId}`);
    } catch (error) { setError(`sandbox:${roomId}`, error); }
  }, [clearError, setError]);
  const refreshAll = useCallback(async () => { await Promise.all([refreshRooms(), refreshAgents(), refreshEvents()]); }, [refreshRooms, refreshAgents, refreshEvents]);

  const onFrame = useCallback((frame: WsServerFrame) => {
    if (frame.t === "hello.ok") {
      const agent = frame.agent !== null && typeof frame.agent === "object" ? frame.agent as Record<string, unknown> : {};
      // The socket greeting carries no profile, so keep the avatar and guest flag from /whoami.
      const greeted = normalizeAgent({ ...agent, workspace_name: frame.workspace?.name });
      setMe((current) => ({ ...greeted, avatar: current?.avatar ?? greeted.avatar, guest: current?.guest ?? greeted.guest })); void refreshAll();
    }
    else if (frame.t === "presence") setPresence((current) => ({ ...current, [frame.room_id]: frame.online }));
    else if (frame.t === "message.created") ingestMessages([normalizeMessage(frame.message)]);
    else if (frame.t === "event") {
      const event = normalizeEvent(frame.event);
      if (!event) return;
      ingestEvents([event]);
      if (event.type === "message.created" && event.detail?.message) ingestMessages([normalizeMessage(event.detail.message)]);
      if (event.type === "room.created") void refreshRooms();
      if (event.type === "room.joined" && event.roomId) void refreshMessages(event.roomId);
      if (event.type.startsWith("sandbox.") && event.roomId) void refreshSandbox(event.roomId);
    } else if (frame.t === "security.alert") window.dispatchEvent(new CustomEvent(SECURITY_ALERT_EVENT, { detail: frame.alert }));
    else if (frame.t === "error") setError("ws", `${frame.code}: ${frame.message}`);
  }, [ingestEvents, ingestMessages, refreshAll, refreshRooms, refreshMessages, refreshSandbox, setError]);
  const socket = useHubSocket(phase === "ready" ? token : null, onFrame, operator ? workspace : null);
  const conn: ConnState = socket.status === "open" ? "live" : socket.status === "connecting" ? (socket.attempts ? "reconnecting" : "connecting") : "offline";

  useEffect(() => {
    if (!token) return;
    let live = true;
    void api.whoami().then((agent) => {
      if (!live) return;
      setMe(agent); setOperator(agent.operator);
      if (agent.operator) {
        // Pin the resolved workspace so REST and the live socket agree on scope.
        if (agent.workspaceId && agent.workspaceId !== getWorkspace()) { saveWorkspace(agent.workspaceId); setWorkspace(agent.workspaceId); }
        void api.listWorkspaces().then((list) => { if (live) setWorkspaces(list); }).catch(() => { if (live) setWorkspaces([]); });
      } else if (getWorkspace()) { saveWorkspace(null); setWorkspace(null); }
      setPhase("ready"); void refreshAll();
    }).catch((error: unknown) => {
      if (!live) return;
      // The owner's workspace was deleted: fall back to another one instead of signing out.
      if (error instanceof ApiError && error.code === "WORKSPACE_NOT_FOUND" && getWorkspace()) { saveWorkspace(null); setWorkspace(null); return; }
      const client = error instanceof ApiError && error.status === 401 && token !== null && SESSION_TOKEN.test(token);
      setAuthError(client ? null : errorMessage(error)); setPhase(client ? "no-token" : "bad-token"); clearToken(); setToken(null); saveWorkspace(null); setWorkspace(null);
    });
    return () => { live = false; };
  }, [token, workspace, refreshAll, recheck]);
  useEffect(() => {
    if (phase !== "ready") return;
    for (const room of rooms) void refreshSandbox(room.id);
  }, [rooms, phase, refreshSandbox]);

  const start = useCallback((next: string, remember = false) => { saveWorkspace(null); setWorkspace(null); saveToken(next, remember); setAuthError(null); setSessionEnded(null); setToken(next); setPhase("verifying"); }, []);
  const clearData = useCallback(() => {
    setRooms([]); setAgents([]); setEvents([]); setMessagesByRoom({}); setMembersByRoom({});
    setPresence({}); setSandboxes([]); setLocalExecsByRoom({}); setErrors({}); seen.current.clear(); sequence.current = 0;
  }, []);
  const logout = useCallback(async () => {
    // A client's sign-out ends the session on the hub (and puts their sidekick to sleep), then
    // forgets this browser's key so nothing left behind can be used.
    const current = getToken();
    if (current && SESSION_TOKEN.test(current)) { try { await api.signOutSession(); } catch { /* already over */ } await forgetDeviceKey(); }
    clearToken(); saveWorkspace(null); setWorkspace(null); setOperator(false); setWorkspaces([]);
    setToken(null); setPhase("no-token"); setAuthError(null); setSessionEnded(null); setMe(null); clearData();
  }, [clearData]);
  useEffect(() => {
    const ended = (event: Event) => {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code ?? "SESSION_ENDED";
      // The owner key still works when only its workspace went away: check again, which falls back
      // to another workspace (or shows the sign-in screen if the key itself was revoked).
      if (code === "ACCESS_ENDED" && /^acho_/.test(getToken() ?? "")) {
        clearData(); setMe(null); saveWorkspace(null); setWorkspace(null); setPhase("verifying"); setRecheck((n) => n + 1); return;
      }
      setSessionEnded(code === "SESSION_EXPIRED" ? "Your session reached its time limit. Sign in again to pick up where you left off."
        : code === "PROOF_REQUIRED" || code === "PROOF_INVALID" ? "This sign-in belongs to a different browser. Sign in again here."
          : code === "ACCESS_ENDED" ? "This sign-in no longer works. Sign in again with a current key or link."
            : "Your session ended. Sign in again to pick up where you left off.");
      void forgetDeviceKey();
      clearToken(); setToken(null); setPhase("no-token"); setAuthError(null); setMe(null); clearData();
    };
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
  }, [clearData]);
  // Nothing from the previous workspace may remain on screen while the next one loads.
  const switchWorkspace = useCallback((id: string) => {
    if (!operator || id === workspace) return;
    clearData(); setMe(null); saveWorkspace(id); setWorkspace(id); setPhase("verifying");
  }, [clearData, operator, workspace]);
  const createRoom = useCallback(async (name: string) => {
    try { await api.createRoom(name); await refreshRooms(); clearError("create"); return true; } catch (error) { setError("create", error); return false; }
  }, [clearError, refreshRooms, setError]);
  const provisionSandbox = useCallback(async (roomId: string) => {
    try { await api.provisionSandbox(roomId); await refreshSandbox(roomId); clearError(`sandbox:${roomId}`); } catch (error) { setError(`sandbox:${roomId}`, error); }
  }, [clearError, refreshSandbox, setError]);
  const joinRoom = useCallback(async (roomId: string) => {
    try { await api.joinRoom(roomId); await refreshMessages(roomId); clearError(`join:${roomId}`); return true; } catch (error) { setError(`join:${roomId}`, error); return false; }
  }, [clearError, refreshMessages, setError]);
  const postMessage = useCallback(async (roomId: string, body: string, to?: string) => {
    try { ingestMessages([await api.postMessage(roomId, body, to)]); clearError(`post:${roomId}`); return true; } catch (error) { setError(`post:${roomId}`, error); return false; }
  }, [clearError, ingestMessages, setError]);
  const runExec = useCallback(async (roomId: string, sandboxId: string, cmd: string) => {
    try {
      const result = await api.sandboxExec(sandboxId, cmd);
      recordExec(roomId, { id: result.execId, cmd, ...result, actorId: me?.id ?? null, createdAt: new Date().toISOString() });
      clearError("exec"); return result;
    } catch (error) { setError("exec", error); return null; }
  }, [clearError, me?.id, recordExec, setError]);
  const listFiles = useCallback(async (id: string, path: string) => {
    try { const result = await api.listFiles(id, path); clearError("files"); return result; } catch (error) { setError("files", error); return null; }
  }, [clearError, setError]);
  const readFile = useCallback(async (id: string, path: string) => {
    try { const result = await api.readFile(id, path); clearError("files"); return result; } catch (error) { setError("files", error); return null; }
  }, [clearError, setError]);
  const writeFile = useCallback(async (id: string, path: string, content: string) => {
    try { await api.writeFile(id, path, content); clearError("save"); return true; } catch (error) { setError("save", error); return false; }
  }, [clearError, setError]);
  const cloneRepo = useCallback(async (id: string, repo: string, ref?: string) => {
    try { const result = await api.cloneRepo(id, repo, ref); clearError("repo"); return result; } catch (error) { setError("repo", error); return null; }
  }, [clearError, setError]);
  const agentName = useCallback((id: string | null | undefined) => agents.find((item) => item.id === id)?.name ?? id ?? "", [agents]);
  const roomName = useCallback((id: string | null | undefined) => rooms.find((item) => item.id === id)?.name ?? id ?? "", [rooms]);
  const value = useMemo<HubStore>(() => ({
    phase, authError, sessionEnded, start, logout, operator, workspaces, switchWorkspace, me, conn, wsStatus: socket.status, wsAttempts: socket.attempts, wsError: socket.lastError,
    rooms, agents, events, messagesByRoom, membersByRoom, presence, sandboxes, localExecsByRoom,
    agentName, roomName, refreshAll, refreshRooms, refreshAgents, refreshEvents, refreshMessages, refreshSandbox,
    createRoom, provisionSandbox, joinRoom, postMessage, runExec, recordExec, listFiles, readFile, writeFile, cloneRepo, errors,
    error: (key) => errors[key] ?? null, clearError,
  }), [phase, authError, sessionEnded, start, logout, operator, workspaces, switchWorkspace, me, conn, socket.status, socket.attempts, socket.lastError, rooms, agents, events, messagesByRoom, membersByRoom, presence, sandboxes, localExecsByRoom, agentName, roomName, refreshAll, refreshRooms, refreshAgents, refreshEvents, refreshMessages, refreshSandbox, createRoom, provisionSandbox, joinRoom, postMessage, runExec, recordExec, listFiles, readFile, writeFile, cloneRepo, errors, clearError]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
