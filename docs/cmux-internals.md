# muxnexus and cmux

How muxnexus and cmux end up looking at the same tmux, and what to expect when
they disagree. None of this is required reading to use muxnexus against a plain
tmux server — see the [README](../README.md) for that.

cmux's local-tmux feature runs its own tmux server. `cmux local-tmux list` shows
its sessions, and muxnexus drives that server by default, so a session created in
either place shows up in the other.

## Workspaces, tabs, sessions, windows

- A cmux **workspace** is a tmux **session**. Its name is the first of:
  `VIEWER_TMUX_SESSION` (set by the mirror on workspaces the browser opens), the
  workspace's custom title, the current directory's basename, and `root` when the
  shell starts at `/`. `.` and `:` become `_`.
- The name is only a **label**. A workspace is identified by `CMUX_WORKSPACE_ID`,
  stamped on its session as the `@muxnexus_workspace` option, and the guard looks
  the session up by that stamp before anything else. Two consequences:
  - Renaming a workspace **retitles its session** rather than stranding it and
    starting a second one. tmux keeps user options across a rename.
  - Two untitled workspaces in the same directory want the same name, so the
    second gets `<name>-<id8>` instead of joining the first. Without this they
    would share one session and show each other's consoles.

  A session with no stamp — the browser's, a plain tmux one, or one predating the
  stamp — is adopted by name and stamped on the way through.
- A cmux **tab** is a tmux **window** in that session. Each tab views the session
  through its own grouped tab session (`<name>~<id>`), so two tabs never show the
  same window. The browser lists the session once with one row per tab; tab
  sessions are hidden.
- Closing a tab or quitting cmux leaves the windows running. Reopened tabs
  re-adopt the lowest free window; new tabs get new windows.
- Killing a session in the browser kills every tab attached to it.
- If the base session is killed from outside while tabs remain, the browser shows
  the oldest tab's session name until a new tab recreates the base; closing the
  last such tab then ends the windows too.

## The workspace mirror

The mirror runs when muxnexus is driving cmux's own tmux **and** the `cmux` CLI is
on `PATH`. With it running, creating a session in the browser opens a cmux
workspace attached to it, renaming retitles it, and killing closes it.

Both conditions are checked at startup, and the result is printed:
`cmux workspace mirror: on|off`.

## The shell guard

For a cmux tab to be visible to the browser, the shell in it has to be inside
tmux. The guard does that: it runs on interactive cmux shells that aren't already
in tmux and attaches them to the right session.

`./scripts/install.sh` offers to wire this up for you, with the correct absolute
path for wherever you cloned the repo, and backs up `~/.zshrc` first. To do it by
hand instead, append this — substituting your own clone path:

```sh
if [[ -o interactive && -z "$TMUX" && -n "$CMUX_PANEL_ID" && -z "$NO_TMUX" ]] && command -v tmux >/dev/null \
   && [[ -r "$HOME/github/muxnexus/scripts/cmux-tmux-guard.zsh" ]]; then
  source "$HOME/github/muxnexus/scripts/cmux-tmux-guard.zsh"
  muxnexus_tmux_guard
fi
```

Set `NO_TMUX=1` in a shell's environment to skip the guard entirely and get a
plain shell.

## Things worth knowing

- tmux 3.7 defaults to `window-size latest`: whichever client typed or resized
  last sets the window size. If your `~/.tmux.conf` sets `window-size smallest` or
  `aggressive-resize`, the two clients will fight over size and the smaller wins.
- The green dot next to a session means another client (usually cmux) is attached.
- Detaching in the browser (`C-b d`) or closing the tab leaves the session
  running.

## Ordering

The sidebar's order is muxnexus's own, not cmux's. tmux has no session ordering
-- `list-sessions` sorts by name -- so each session carries `@muxnexus_order`, an
integer written by the server when you reorder. It lives in tmux rather than the
browser so every client agrees: reorder on the Mac and the iPad already knows.
A session with no stamp sorts after the stamped ones, so one created outside
muxnexus lands at the end rather than in the middle.

Windows need no stamp. tmux orders them natively by `window_index`, and
reordering uses `swap-window`: `move-window` refuses an occupied target index
("index in use"), while selection sort reaches any order in at most n-1 swaps
with every intermediate state valid. Window options ride along with the window,
so `@muxnexus_surface` -- and therefore a tab's cmux title -- survives a reorder.

Because `swap-window` moves windows *between* indices, an index names a slot and
never the window in it. Anything that has to identify a window across a reorder
uses `#{window_id}` (`@3`), which is what `WindowInfo.id` carries -- so every
window command from the browser (select, rename, kill, reorder) names the window
by id.

Sessions are addressed by id too (`$3`), never by name. tmux accepts `.` and `:`
in a session name but splits a target on them: `=api.v2` is session `api`,
window `v2`, and no trailing colon rescues `a:b`. The id also survives a rename,
which is how the server notices that the session a browser is attached to has
been renamed -- in cmux, with `C-b $`, or from another browser -- and tells it.

None of this is visible to cmux: reordering tabs here does not reorder cmux's,
and session order is invisible there. cmux exposes no verb to set either.
