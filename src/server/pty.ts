import { spawn } from "bun-pty";
import { socketArgs } from "./tmux";

export interface AttachOptions {
  /** A tmux target, used as given: a session id (`$3`) or an exact `=name`. */
  target: string;
  socketName?: string;
  socketPath?: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly exited: boolean;
}

/** Spawn `tmux attach-session` in a PTY. One call per browser client. */
export function attachSession(opts: AttachOptions): PtyHandle {
  const args = [
    ...socketArgs(opts.socketName, opts.socketPath),
    "attach-session",
    "-t",
    opts.target,
  ];

  // Copy the environment, drop TMUX so attaching works from inside tmux/cmux,
  // and force a TERM xterm.js understands.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "TMUX") env[k] = v;
  }
  env.TERM = "xterm-256color";

  const pty = spawn("tmux", args, { name: "xterm-256color", cols: opts.cols, rows: opts.rows, env });

  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    opts.onExit(code);
  };

  pty.onData(opts.onData);
  pty.onExit((e) => finish(e.exitCode));

  return {
    get exited() { return exited; },
    write(data) { if (!exited) pty.write(data); },
    resize(cols, rows) { if (!exited && cols > 0 && rows > 0) pty.resize(cols, rows); },
    kill() { if (!exited) pty.kill(); },
  };
}
