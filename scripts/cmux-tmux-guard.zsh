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
muxnexus_workspace_title() {
  local id="${1:-}"
  [[ -z "$id" ]] && return 0
  command -v cmux >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || return 0
  cmux workspace list --json 2>/dev/null | CMUX_WORKSPACE_ID="$id" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in d.get("workspaces", []):
    if w.get("id") == os.environ["CMUX_WORKSPACE_ID"] and w.get("has_custom_title") and w.get("custom_title"):
        print(w["custom_title"]); break
' 2>/dev/null
}

# The label for this tab's workspace: the viewer's name, else cmux's custom title,
# else the directory. Only the first two identify the workspace; the directory is a
# fallback shared by every untitled workspace sitting in the same place.
muxnexus_base_name() {
  local name="${VIEWER_TMUX_SESSION:-}"
  [[ -z "$name" ]] && name="$(muxnexus_workspace_title "${CMUX_WORKSPACE_ID:-}")"
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

# The session this workspace owns, found by the id stamped on it rather than by
# name — a workspace keeps its id across renames, its title does not.
#   usage: muxnexus_session_of_workspace <socket-path> <workspace-id>
muxnexus_session_of_workspace() {
  local sock="$1" id="$2"
  [[ -z "$id" ]] && return 0
  tmux -S "$sock" list-sessions -F '#{session_name}	#{@muxnexus_workspace}' 2>/dev/null \
    | awk -F'\t' -v i="$id" '$2==i {print $1; exit}'
}

# The workspace id stamped on <name>, empty when no workspace claims it.
#   usage: muxnexus_owner_of <socket-path> <name>
muxnexus_owner_of() {
  local sock="$1" name="$2"
  tmux -S "$sock" list-sessions -F '#{session_name}	#{@muxnexus_workspace}' 2>/dev/null \
    | awk -F'\t' -v n="$name" '$1==n {print $2; exit}'
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

# tmux freezes the creating client's environment into the session, so every
# window in it would otherwise inherit the *first* tab's cmux identity: a stale
# surface id makes `cmux` in that pane fail to identify itself, or worse, quietly
# act on whichever other tab still holds it. Refresh the session environment for
# this tab so a window created now carries its own identity. A shell that is
# already running keeps the values it started with; nothing can change that.
#   usage: muxnexus_export_cmux_env <socket-path> <base>
muxnexus_export_cmux_env() {
  local sock="$1" base="$2" v
  for v in CMUX_SURFACE_ID CMUX_WORKSPACE_ID CMUX_PANEL_ID CMUX_PANE_ID; do
    if [[ -n "${(P)v}" ]]; then
      tmux -S "$sock" set-environment -t "=$base" "$v" "${(P)v}" 2>/dev/null
    else
      tmux -S "$sock" set-environment -t "=$base" -u "$v" 2>/dev/null
    fi
  done
}

# The whole flow. Attaches (blocks until the tab closes or detaches), then
# removes this tab's session. Windows stay in the base.
muxnexus_tmux_guard() {
  local sock="${MUXNEXUS_TMUX_SOCKET:-$HOME/.cmux/local-tmux/server.sock}"
  local id="${CMUX_WORKSPACE_ID:-}"
  local want; want="$(muxnexus_base_name)"
  local base win created=0
  base="$(muxnexus_session_of_workspace "$sock" "$id")"
  if [[ -n "$base" ]]; then
    # This workspace already has a session. Carry its name to the current title so
    # a rename retitles the session instead of stranding it. Only a name cmux
    # positively reports may do this: the directory fallback is shared by every
    # untitled workspace, and a momentary lookup failure would otherwise rename a
    # perfectly good session to it.
    local titled="${VIEWER_TMUX_SESSION:-}"
    [[ -z "$titled" ]] && titled="$(muxnexus_workspace_title "$id")"
    titled="${titled//[.:]/_}"
    if [[ -n "$titled" && "$titled" != "$base" ]] && ! tmux -S "$sock" has-session -t "=$titled" 2>/dev/null; then
      tmux -S "$sock" rename-session -t "=$base" -- "$titled" && base="$titled"
    fi
  elif tmux -S "$sock" has-session -t "=$want" 2>/dev/null \
       && { [[ -z "$id" ]] || [[ -z "$(muxnexus_owner_of "$sock" "$want")" ]]; }; then
    # Unclaimed session of that name: the browser's, a plain tmux one, or one from
    # before workspaces were stamped. Join it, as this guard always has.
    base="$want"
  else
    # Either the name is free, or another workspace holds it and we must not join.
    local orphan=""
    if ! tmux -S "$sock" has-session -t "=$want" 2>/dev/null; then
      # An orphaned group (base killed, tabs alive) keeps the base's name as its group: rejoin it.
      orphan="$(tmux -S "$sock" list-sessions -F '#{session_name}	#{session_group}' 2>/dev/null | awk -F'\t' -v b="$want" '$2==b {print $1; exit}')"
      base="$want"
    else
      base="${want}-${id[1,8]}"
    fi
    if [[ -n "$orphan" ]]; then
      tmux -S "$sock" new-session -d -t "=$orphan" -s "$base" || return 1
    else
      tmux -S "$sock" new-session -d -s "$base" -c "$PWD" || return 1
      created=1
    fi
  fi
  # set-option takes no "=" target prefix; exact names are matched before prefixes.
  [[ -n "$id" ]] && tmux -S "$sock" set-option -t "$base" '@muxnexus_workspace' "$id" 2>/dev/null
  muxnexus_export_cmux_env "$sock" "$base"
  if (( created )); then win=0; else win="$(muxnexus_pick_window "$sock" "$base")"; fi
  [[ -n "$win" ]] || return 1
  # Stamp the window with this cmux tab's surface id so the viewer can show the
  # tab's real title instead of the name tmux derives from the running command.
  [[ -n "${CMUX_SURFACE_ID:-}" ]] && \
    tmux -S "$sock" set-option -w -t "$base:$win" '@muxnexus_surface' "$CMUX_SURFACE_ID" 2>/dev/null
  local tab; tab="$(muxnexus_tab_name "$base")"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null   # a stale one from a crashed tab
  tmux -S "$sock" new-session -d -t "=$base" -s "$tab" || return 1
  tmux -S "$sock" select-window -t "=$tab:$win"
  tmux -S "$sock" attach-session -t "=$tab"
  tmux -S "$sock" kill-session -t "=$tab" 2>/dev/null
}
