# muxnexus — cmux shell guard.
# Source this from ~/.zshrc and call `muxnexus_tmux_guard` in every interactive
# cmux shell that is not already inside tmux. Each cmux tab becomes one window of
# the workspace's tmux session, viewed through its own grouped "tab session", so
# two tabs never mirror each other and the browser sees the workspace as one
# session with a row per tab. Functions only; nothing runs on source.

# The base session name for this tab's workspace.
#   1. VIEWER_TMUX_SESSION (set by muxnexus on workspaces it opens for the browser)
#   2. the cmux workspace's custom title, looked up by CMUX_WORKSPACE_ID
#   3. the current directory's basename
# '.' and ':' are not allowed in tmux session names and become '_'.
muxnexus_base_name() {
  local name="${VIEWER_TMUX_SESSION:-}"
  if [[ -z "$name" && -n "${CMUX_WORKSPACE_ID:-}" ]] && command -v cmux >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    name="$(cmux workspace list --json 2>/dev/null | CMUX_WORKSPACE_ID="$CMUX_WORKSPACE_ID" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in d.get("workspaces", []):
    if w.get("id") == os.environ["CMUX_WORKSPACE_ID"] and w.get("has_custom_title") and w.get("custom_title"):
        print(w["custom_title"]); break
' 2>/dev/null)"
  fi
  [[ -z "$name" ]] && name="${PWD:t}"
  print -r -- "${name//[.:]/_}"
}

# The tab-session name for this cmux tab.
muxnexus_tab_name() {
  local base="$1" id="${CMUX_SURFACE_ID:-}"
  [[ -z "$id" ]] && id="$$"
  print -r -- "${base}~${id[1,8]}"
}

# Which window of <base> this tab should show: the lowest-index window not
# currently shown by an attached tab session of the group; if every window is
# taken, a new one is created and its index printed.
#   usage: muxnexus_pick_window <socket-path> <base>
muxnexus_pick_window() {
  local sock="$1" base="$2"
  local -a shown windows
  # current window of each *attached* member of the group other than the base itself
  shown=(${(f)"$(tmux -S "$sock" list-sessions -F '#{session_group}	#{session_name}	#{session_attached}	#{window_index}' 2>/dev/null \
    | awk -F'\t' -v b="$base" '$1==b && $2!=b && $3>0 {print $4}')"})
  windows=(${(f)"$(tmux -S "$sock" list-windows -t "=$base" -F '#{window_index}' 2>/dev/null)"})
  local w
  for w in "${windows[@]}"; do
    if (( ${shown[(Ie)$w]} == 0 )); then print -r -- "$w"; return 0; fi
  done
  tmux -S "$sock" new-window -d -P -F '#{window_index}' -t "=$base" -c "$PWD"
}

# The whole flow. Attaches (blocks until the tab closes or detaches), then
# removes this tab's session. Windows stay in the base.
muxnexus_tmux_guard() {
  local sock="${MUXNEXUS_TMUX_SOCKET:-$HOME/.cmux/local-tmux/server.sock}"
  local base; base="$(muxnexus_base_name)"
  local win created=0
  if ! tmux -S "$sock" has-session -t "=$base" 2>/dev/null; then
    tmux -S "$sock" new-session -d -s "$base" -c "$PWD" || return 1
    created=1
  fi
  if (( created )); then win=0; else win="$(muxnexus_pick_window "$sock" "$base")"; fi
  local tab; tab="$(muxnexus_tab_name "$base")"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null   # a stale one from a crashed tab
  tmux -S "$sock" new-session -d -t "$base" -s "$tab" || return 1
  tmux -S "$sock" select-window -t "=$tab:$win"
  tmux -S "$sock" attach-session -t "=$tab"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null
}
