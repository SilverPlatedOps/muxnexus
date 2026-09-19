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
  [[ -z "$name" ]] && name="root"   # basename of "/" is empty; "" is a legal but untargetable tmux name
  print -r -- "${name//[.:]/_}"
}

# The tab-session name for this cmux tab.
muxnexus_tab_name() {
  local base="$1" id="${CMUX_SURFACE_ID:-}"
  [[ -z "$id" ]] && id="$$"
  print -r -- "${base}~${id[1,8]}"
}

# The session group the base belongs to, or the base name when ungrouped or absent.
# tmux keeps #{session_group} at the name the base had when the group was formed,
# so a renamed base still resolves to its real group.
#   usage: muxnexus_group_of <socket-path> <base>
muxnexus_group_of() {
  local sock="$1" base="$2" g
  g="$(tmux -S "$sock" list-sessions -F '#{session_name}	#{session_group}' 2>/dev/null | awk -F'\t' -v b="$base" '$1==b {print $2; exit}')"
  print -r -- "${g:-$base}"
}

# Which window of <base> this tab should show: the lowest-index window not
# currently shown by an attached tab session of the group; if every window is
# taken, a new one is created and its index printed.
#   usage: muxnexus_pick_window <socket-path> <base>
muxnexus_pick_window() {
  local sock="$1" base="$2"
  local -a shown windows
  local grp; grp="$(muxnexus_group_of "$sock" "$base")"
  # current window of each *attached* member of the group other than the base itself
  shown=(${(f)"$(tmux -S "$sock" list-sessions -F '#{session_group}	#{session_name}	#{session_attached}	#{window_index}' 2>/dev/null \
    | awk -F'\t' -v g="$grp" -v b="$base" '$1==g && $2!=b && $3>0 {print $4}')"})
  windows=(${(f)"$(tmux -S "$sock" list-windows -t "=$base" -F '#{window_index}' 2>/dev/null)"})
  local w
  for w in "${windows[@]}"; do
    if (( ${shown[(Ie)$w]} == 0 )); then print -r -- "$w"; return 0; fi
  done
  local made; made="$(tmux -S "$sock" new-window -d -P -F '#{window_index}' -t "=$base" -c "$PWD" 2>/dev/null)"
  [[ -n "$made" ]] || return 1
  print -r -- "$made"
}

# The whole flow. Attaches (blocks until the tab closes or detaches), then
# removes this tab's session. Windows stay in the base.
muxnexus_tmux_guard() {
  local sock="${MUXNEXUS_TMUX_SOCKET:-$HOME/.cmux/local-tmux/server.sock}"
  local base; base="$(muxnexus_base_name)"
  local win created=0
  if ! tmux -S "$sock" has-session -t "=$base" 2>/dev/null; then
    # An orphaned group (base killed, tabs alive) keeps the base's name as its group: rejoin it.
    local orphan; orphan="$(tmux -S "$sock" list-sessions -F '#{session_name}	#{session_group}' 2>/dev/null | awk -F'\t' -v b="$base" '$2==b {print $1; exit}')"
    if [[ -n "$orphan" ]]; then
      tmux -S "$sock" new-session -d -t "=$orphan" -s "$base" || return 1
    else
      tmux -S "$sock" new-session -d -s "$base" -c "$PWD" || return 1
      created=1
    fi
  fi
  if (( created )); then win=0; else win="$(muxnexus_pick_window "$sock" "$base")"; fi
  [[ -n "$win" ]] || return 1
  local tab; tab="$(muxnexus_tab_name "$base")"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null   # a stale one from a crashed tab
  tmux -S "$sock" new-session -d -t "=$base" -s "$tab" || return 1
  tmux -S "$sock" select-window -t "=$tab:$win"
  tmux -S "$sock" attach-session -t "=$tab"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null
}
