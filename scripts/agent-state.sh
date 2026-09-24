#!/bin/sh
# muxnexus: stamp this tmux pane with what the agent in it is doing, so the
# sidebar can show which session needs you without reading the screen.
#
# Installed as a Claude Code hook on several events; the event name is the one
# argument. Everything it needs beyond that is in the payload on stdin, matched
# with `case` rather than parsed with jq -- this runs on every tool call, so it
# must cost nothing.
#
# Writes one pane option:
#
#   @muxnexus_agent = "<state> <epoch> <pid>"    e.g. "running 1790242563 61936"
#
# `tmux` needs no socket argument: it takes one from $TMUX, which is set in the
# pane the hook inherits. Outside tmux there is no pane and the script exits.

[ -n "$TMUX_PANE" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

event="${1:-}"
payload=$(cat 2>/dev/null)

# Matched against the raw JSON, so both `"tool_name":"X"` and `"tool_name": "X"`
# have to hit. A false match here would only mis-state a glyph for one turn.
has() {
  case "$payload" in
    *"\"$1\":\"$2\""*|*"\"$1\": \"$2\""*) return 0 ;;
    *) return 1 ;;
  esac
}

case "$event" in
  # The agent is blocked on the human.
  PermissionRequest)
    state=input ;;
  PreToolUse|PostToolUse)
    # Asking the user a question is the tool that means "waiting"; every other
    # tool means a turn is under way. Stamping tool events at all matters
    # because an agent resumed by a background subagent never fires
    # UserPromptSubmit -- tool events are the only sign it woke up.
    if has tool_name AskUserQuestion; then state=input; else state=running; fi ;;
  UserPromptSubmit)
    state=running ;;
  Notification)
    case "$payload" in
      *permission_prompt*|*elicitation_dialog*) state=input ;;
      *idle_prompt*)                            state=done ;;
      *) exit 0 ;;  # some other notification says nothing about state
    esac ;;
  # The turn ended, or a session opened with nothing running in it yet.
  Stop|SessionStart)
    state=done ;;
  SessionEnd)
    tmux set-option -pu -t "$TMUX_PANE" @muxnexus_agent 2>/dev/null
    exit 0 ;;
  *)
    exit 0 ;;
esac

# $PPID is recorded so the server can drop a stamp whose process has gone:
# SessionEnd covers a clean exit, but a killed agent never fires it.
tmux set-option -p -t "$TMUX_PANE" @muxnexus_agent "$state $(date +%s) $PPID" 2>/dev/null
exit 0
