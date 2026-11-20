import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientFrame, WsServerFrame } from "../types";
import { parseServerFrame } from "./normalize";
import { proof, SESSION_TOKEN } from "./device";
import { SESSION_ENDED_EVENT } from "./api";

export type SocketStatus = "connecting" | "open" | "closed" | "error";

export interface HubSocket {
  status: SocketStatus;
  attempts: number;
  lastError: string | null;
  connectedAt: string | null;
  send: (frame: WsClientFrame) => boolean;
}

/** Tokens are sent only in the first frame, never a URL or request log. */
export function wsUrlFromLocation(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/v1/ws`;
}

/**
 * A subscribe-all hub socket with capped exponential reconnect backoff.
 * WebSocket handshakes cannot include arbitrary Authorization headers in a
 * browser; the hello frame carries credentials after the upgrade.
 */
export function useHubSocket(token: string | null, onFrame: (frame: WsServerFrame) => void, workspace: string | null = null): HubSocket {
  const [status, setStatus] = useState<SocketStatus>("closed");
  const [attempts, setAttempts] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const callbackRef = useRef(onFrame);
  callbackRef.current = onFrame;

  const send = useCallback((frame: WsClientFrame) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus("closed");
      setAttempts(0);
      setLastError(null);
      setConnectedAt(null);
      return;
    }

    let disposed = false;
    let retry = 0;
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrlFromLocation());
      } catch {
        setStatus("error");
        setLastError("could not open websocket");
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        // A client session signs its opening frame with the device key, like every HTTP request.
        void (SESSION_TOKEN.test(token) ? proof(token, "WS", "/ws") : Promise.resolve(null)).then((signed) => {
          if (disposed || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ t: "hello", token, ...(signed ? { proof: signed } : {}), ...(workspace ? { workspace } : {}) } satisfies WsClientFrame));
        });
      };
      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;
        const frame = parseServerFrame(event.data);
        if (frame?.t === "hello.ok") {
          retry = 0; setAttempts(0); setStatus("open"); setLastError(null);
          setConnectedAt(new Date().toISOString());
          socket.send(JSON.stringify({ t: "subscribe" } satisfies WsClientFrame));
        }
        if (frame) callbackRef.current(frame);
      };
      socket.onerror = () => {
        if (!disposed) setLastError("socket error");
      };
      socket.onclose = (event) => {
        if (disposed) return;
        setConnectedAt(null);
        setStatus("closed");
        if (event.code === 4009) {
          window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code: event.reason === "Session expired" ? "SESSION_EXPIRED" : "SESSION_ENDED", message: "" } }));
          return;
        }
        // Credentials that no longer work (revoked, or the hub started fresh): stop and sign in again
        // instead of retrying forever.
        if (event.code === 4008 && (event.reason === "Invalid credentials" || event.reason === "Identity no longer authorized")) {
          window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code: "ACCESS_ENDED", message: "" } }));
          return;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(1_000 * 2 ** Math.min(retry, 5), 30_000);
      retry += 1;
      setAttempts(retry);
      clearTimer();
      timerRef.current = window.setTimeout(connect, delay);
    };

    connect();
    return () => {
      disposed = true;
      clearTimer();
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
        socketRef.current = null;
      }
    };
  }, [token, workspace]);

  return { status, attempts, lastError, connectedAt, send };
}
