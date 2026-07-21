/**
 * Copilot WebSocket client — one socket per open dock (workflow OR agent
 * editor; the socket is per-WORKSPACE, each `user_message` frame names its
 * surface + entity), typed frames from @invisible-string/shared,
 * exponential-backoff reconnect, torn down on dispose. The WebSocket
 * constructor is injectable so tests can drive a scripted fake without a
 * network.
 */
import {
  parseCopilotServerFrame,
  type CopilotClientFrame,
  type CopilotServerFrame,
} from "@invisible-string/shared";

import { API_BASE_URL } from "../api-client";

export type CopilotSocketStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** Minimal structural WebSocket (matches the DOM class; fakeable in tests). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CopilotSocketOptions {
  workspaceId: string;
  onFrame: (frame: CopilotServerFrame) => void;
  onStatus?: (status: CopilotSocketStatus) => void;
  createWebSocket?: WebSocketFactory;
  /** Base backoff in ms (doubles per attempt, capped). Tests shrink this. */
  backoffBaseMs?: number;
}

const BACKOFF_CAP_MS = 15_000;
const WS_OPEN = 1;

export function copilotSocketUrl(
  workspaceId: string,
  base: string = API_BASE_URL,
): string {
  const url = new URL(`/workspaces/${workspaceId}/copilot`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class CopilotSocket {
  private ws: WebSocketLike | null = null;
  private disposed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: CopilotSocketOptions;
  private readonly url: string;

  constructor(options: CopilotSocketOptions) {
    this.options = options;
    this.url = copilotSocketUrl(options.workspaceId);
    this.connect();
  }

  private setStatus(status: CopilotSocketStatus): void {
    this.options.onStatus?.(status);
  }

  private connect(): void {
    if (this.disposed) return;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const factory =
      this.options.createWebSocket ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let ws: WebSocketLike;
    try {
      ws = factory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.disposed || this.ws !== ws) return;
      this.attempts = 0;
      this.setStatus("open");
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.disposed || this.ws !== ws) return;
      const frame = parseCopilotServerFrame(event.data);
      if (frame) this.options.onFrame(frame);
    });
    ws.addEventListener("close", () => {
      if (this.disposed || this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close always follows error; reconnect is scheduled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.setStatus("reconnecting");
    const base = this.options.backoffBaseMs ?? 500;
    const delay = Math.min(base * 2 ** this.attempts, BACKOFF_CAP_MS);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** True when a frame can be sent right now. */
  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  send(frame: CopilotClientFrame): boolean {
    if (!this.isOpen || this.ws === null) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "copilot closed");
    } catch {
      // already closed
    }
    this.setStatus("closed");
  }
}
