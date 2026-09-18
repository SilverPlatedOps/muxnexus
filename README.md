# cmux-viewer

A browser client for your local tmux server. Start Claude Code (or anything)
in tmux from cmux on the Mac, then drive the same session from a laptop
browser over Tailscale.

## Run

```sh
bun install
bun run start          # binds to your Tailscale IPv4 on port 7681
bun run start -- --port 8080
bun run dev            # local development: binds 127.0.0.1, restarts on change
bun test
```

`start` resolves the bind address with `tailscale ip -4` and refuses to start
if Tailscale is down. Pass `--host <addr>` to bind elsewhere. There is no
authentication: only expose this on the tailnet.

Open `http://<tailscale-ip>:7681/` from any device on your tailnet.

## Using it with cmux

Both cmux and the browser attach to the same default tmux socket, so a session
created in either place shows up in the other.

- tmux 3.7 defaults to `window-size latest`: whichever client typed or resized
  last sets the window size. If your `~/.tmux.conf` sets `window-size smallest`
  or `aggressive-resize`, the two clients will fight over size and the smaller
  wins.
- The green dot next to a session means another client (usually cmux) is
  attached.
- Detaching in the browser (`C-b d`) or closing the tab leaves the session
  running.

## Keys

| Key | Action |
| --- | --- |
| `Cmd+B` | Toggle the sidebar |
| `Cmd+C` | Copy the selection (no selection: nothing) |
| `Cmd+V` | Paste (bracketed paste, forwarded by tmux) |
| everything else | Sent to tmux, including `C-b` prefix keys |

## cmux smoke test

Run these after any change to the server or PTY layer.

1. In cmux: `tmux new -s work`. Browser: `work` appears within 2 s; attaching
   shows the same shell. Reverse: `+ session` in the browser, then
   `tmux attach -t <name>` in cmux.
2. Resize the browser window. cmux's view of the session must recover on the
   next keystroke there, and vice versa.
3. With cmux attached, the browser shows a green dot on `work`. Detach in cmux:
   the dot clears on the next poll.
4. Kill a window in cmux (`C-b &`): it disappears from the browser sidebar.
   Kill the session from the browser while cmux is attached: cmux's client
   exits with `[exited]`.
5. Run something colourful (`ls -G`, `git diff`) and compare colours in both.
   Enable `set -g mouse on` if you want wheel scrolling to drive tmux history.
6. Start `claude` in a tmux window from cmux. Type a prompt in the browser,
   read the reply in cmux. Resize the browser: Claude's TUI redraws cleanly.
