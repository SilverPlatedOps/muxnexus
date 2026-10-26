#!/bin/sh
# muxnexus: carry an agent's `mux …` call out of its sandbox to the chat server.
#
# Installed as a PreToolUse hook (Claude Code: matcher Bash; Codex: every
# tool), with the agent kind as the first argument. It runs before every shell
# command an agent makes, so the common case -- not a mux call -- must cost
# nothing: one `case` on the raw payload and out. A mux call is handed to
# `scripts/mux.ts hook`, which posts it and prints the PreToolUse output that
# swaps the command for one printing the reply. Hooks run outside the agent's
# sandbox (Codex says so when you trust them), which is the point.

[ -n "$TMUX_PANE" ] || exit 0
payload=$(cat 2>/dev/null)
case "$payload" in
  *'"command"'*mux*) ;;
  *) exit 0 ;;
esac

agent="${1:-claude}"

# Under Codex only `--no-daemon` runs hooks in the tab's own process; in the
# shared daemon $TMUX_PANE names some other pane. Same check as agent-state.sh.
in_pane() {
  command -v tmux >/dev/null 2>&1 || return 1
  top=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_pid}' 2>/dev/null) || return 1
  [ -n "$top" ] || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$top" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}
[ "$agent" = codex ] && ! in_pane && exit 0

command -v bun >/dev/null 2>&1 || exit 0
root=$(cd "$(dirname "$0")/.." && pwd)
printf '%s' "$payload" | exec bun "$root/scripts/mux.ts" hook "$agent"
