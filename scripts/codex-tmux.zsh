# muxnexus — Codex inside tmux.
# Source this from ~/.zshrc. Inside tmux, `codex` runs so muxnexus can follow it:
#
#   --no-daemon    Codex otherwise runs its hooks in a shared background server
#                  that carries some other terminal's $TMUX_PANE, so the tab
#                  would never show its status or its account badge.
#   inline         Codex otherwise draws on the alternate screen, which never
#                  reaches tmux's history: there is nothing for the wheel to
#                  scroll. Inline, the conversation stays in the pane's history.
#
# Outside tmux Codex is left exactly as it was. A choice made on the command
# line wins: --no-daemon is not passed twice (Codex refuses that), and an
# explicit alternate-screen setting is not overridden.
codex() {
  if [[ -z "$TMUX" ]]; then
    command codex "$@"
    return
  fi
  local -a extra
  (( ${@[(Ie)--no-daemon]} )) || extra+=(--no-daemon)
  [[ "$*" == *--no-alt-screen* || "$*" == *alternate_screen* ]] || extra+=(-c 'tui.alternate_screen="never"')
  command codex "${extra[@]}" "$@"
}
