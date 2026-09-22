# Smoke test

Run these against a real cmux after any change to the server or PTY layer. They
cover the things unit tests can't: two live tmux clients disagreeing with each
other.

1. In cmux: `tmux new -s work`. Browser: `work` appears within 2 s; attaching
   shows the same shell. Reverse: `+ session` in the browser, then
   `tmux attach -t <name>` in cmux.
2. Resize the browser window. cmux's view of the session must recover on the next
   keystroke there, and vice versa.
3. With cmux attached, the browser shows a green dot on `work`. Detach in cmux:
   the dot clears on the next poll.
4. Kill a window in cmux (`C-b &`): it disappears from the browser sidebar. Kill
   the session from the browser while cmux is attached: cmux's client exits with
   `[exited]`.
5. Run something colourful (`ls -G`, `git diff`) and compare colours in both.
   Enable `set -g mouse on` if you want wheel scrolling to drive tmux history.
6. Start `claude` in a tmux window from cmux. Type a prompt in the browser, read
   the reply in cmux. Resize the browser: Claude's TUI redraws cleanly.
7. Open three tabs in one cmux workspace. The browser lists one session with three
   windows. Switch windows in the browser: no cmux tab changes.
8. Quit cmux and reopen it. The restored tabs re-adopt their windows. Kill the
   session from the browser: every tab drops to a plain shell.

## Terminal layout

Worth a glance after any CSS change, because the terminal is sized by
measurement and the failure modes are quiet:

- The tmux status line at the very bottom must be **fully** visible, not clipped
  to a sliver. The terminal is sized by xterm's fit addon, which reads
  `#terminal`'s own box — padding or a border there wins it a row it has no room
  to draw.
- The terminal must not grow. If the pane creeps downward or flickers, fit and
  the `ResizeObserver` are feeding each other; something in the chain lost its
  height constraint.
- Check both with the tab strip visible and with a single window (strip hidden).

## Sidebar collapse

Toggle the sidebar (`Cmd+B` or the button in the brand header) on a desktop-width
window. The terminal must widen to fill the space, not vanish. `#layout.collapsed`
drops to a single grid column on purpose: a `display: none` sidebar leaves the
grid, so a second declared column would swallow `#main` into a zero-width cell.
