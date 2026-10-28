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

## Chat and global search

Use disposable chats and test workspaces for these checks:

- Post Markdown with a heading, list, table, fenced code and file reference.
  Copy returns the exact code. HTML stays text and images don't load remotely.
  Select text or expand a long answer, then receive another message: selection,
  expanded sections and scroll position should survive.
- Double-click chat names in both the sidebar and header. Rename the correct
  chat; Escape cancels; Rename in the menu remains keyboard-accessible.
- Use the Terminals buttons to switch agents beside the chat. Their selected
  state follows the terminal; switching does not alter message recipients.
- Change activity and save a brief, then wake an agent. It gets the changed
  rules/brief once. A new conversation in the same member tab gets the brief
  again. Saving a brief while disconnected keeps the dialog and text; success
  closes only after confirmation.
- Hand off selected text with explicit recipients, repository and revision.
  The preview matches the excerpt. Mentions inside a diff wake no extra agents.
- Start an independent round with two test agents. Ordinary `mux say` posts
  stay withheld and don't count as submissions. The round-specific `mux submit`
  command counts; peer answers stay hidden from delivery and `mux read` until
  reveal. End before a queued kickoff sends: that kickoff is cancelled.
  Automatic completion must not clear a stop or pose as a human instruction.
- Open global search with Cmd+Shift+K, including from the chat composer. Search
  note contents from a closed window and open that exact note. Arrow keys,
  Enter and Escape work; Cmd+K and existing scoped searches keep their behavior.
- In the agent picker, verify the preflight folder/account/role, tab through its
  fields without escaping the dialog, then press Escape and check focus returns.
