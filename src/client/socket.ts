import type { ClientMessage, ServerMessage } from "../shared/protocol";

const PING_MS = 30_000;
const encoder = new TextEncoder();

export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const m = JSON.parse(text);
    return m && typeof m.t === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}

/** Exponential backoff starting at 250 ms, capped at 5 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(5000, 250 * 2 ** attempt);
}

export interface ConnectionHandlers {
  onOpen(): void;
  onClose(): void;
  onMessage(m: ServerMessage): void;
  onOutput(bytes: Uint8Array): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly url: string, private readonly h: ConnectionHandlers) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_MS);
      this.h.onOpen();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = parseServerMessage(e.data);
        if (m) this.h.onMessage(m);
      } else {
        this.h.onOutput(new Uint8Array(e.data as ArrayBuffer));
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.h.onClose();
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), backoffDelay(this.attempt++));
      }
    };
    ws.onerror = () => ws.close();
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendInput(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encoder.encode(data));
  }

  /** Permanently close; no reconnect. */
  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Simulate a dropped connection (tests only). Reconnect logic still runs. */
  dropForTest(): void {
    this.ws?.close();
  }
}
