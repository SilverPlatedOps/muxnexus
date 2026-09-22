#!/usr/bin/env bash
# muxnexus setup: check prerequisites, install dependencies, and optionally wire
# the cmux tmux guard into ~/.zshrc. Nothing is installed without a yes.
# Safe to run again: every step checks before it acts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/scripts/cmux-tmux-guard.zsh"
ZSHRC="$HOME/.zshrc"
GUARD_MARKER="muxnexus_tmux_guard"
ALIAS_MARKER="alias muxnexus="

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; X=$'\033[0m'
else
  B=''; D=''; G=''; R=''; Y=''; X=''
fi

# Prompts are read from the controlling terminal, not stdin, so `curl ... | bash`
# can still ask. With no terminal at all (CI) we report and leave the machine alone.
# Opening it is the only honest test: /dev/tty can exist and still fail to open
# when there is no controlling terminal.
INTERACTIVE=0
if { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

missing=0

ok()      { printf '  %s✓%s %-10s %s%s%s\n' "$G" "$X" "$1" "$D" "${2:-}" "$X"; }
absent()  { printf '  %s✗%s %-10s %s\n' "$R" "$X" "$1" "${2:-not found}"; }
optional(){ printf '  %s·%s %-10s %s%s%s\n' "$Y" "$X" "$1" "$D" "${2:-}" "$X"; }

# Copy ~/.zshrc aside once per run, before the first thing that appends to it.
ZSHRC_BACKED_UP=0
backup_zshrc() {
  [ "$ZSHRC_BACKED_UP" -eq 1 ] && return 0
  ZSHRC_BACKED_UP=1
  [ -f "$ZSHRC" ] || return 0
  local backup="$ZSHRC.bak.$(date +%Y%m%d%H%M%S)"
  cp "$ZSHRC" "$backup"
  printf '    %sbacked up to %s%s\n' "$D" "$backup" "$X"
}

confirm() { # confirm <prompt> [Y|N]
  local prompt="$1" default="${2:-Y}" reply
  [ "$INTERACTIVE" -eq 1 ] || return 1
  if [ "$default" = "Y" ]; then prompt="$prompt [Y/n] "; else prompt="$prompt [y/N] "; fi
  read -r -p "  $prompt" reply </dev/tty 2>/dev/null || return 1
  reply="${reply:-$default}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# The command that installs $1 on this machine, or nothing if we cannot tell.
install_cmd() {
  case "$(uname -s)" in
    Darwin) command -v brew >/dev/null 2>&1 && echo "brew install $1" ;;
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $1"
      elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf install -y $1"
      elif command -v pacman  >/dev/null 2>&1; then echo "sudo pacman -S --noconfirm $1"
      fi ;;
  esac
}

# offer <binary> <human name> <fallback instruction>
offer() {
  local bin="$1" name="$2" fallback="$3" cmd
  cmd="$(install_cmd "$bin")"
  if [ -z "$cmd" ]; then
    printf '    %s\n' "$fallback"
    missing=$((missing + 1))
    return
  fi
  if confirm "Install $name with ${cmd%% *}?" Y; then
    printf '    %s→%s %s\n' "$D" "$X" "$cmd"
    if eval "$cmd"; then
      ok "$bin" "installed"
    else
      printf '    install failed, run it yourself: %s\n' "$cmd"
      missing=$((missing + 1))
    fi
  else
    printf '    skipped — install it later with: %s\n' "$cmd"
    missing=$((missing + 1))
  fi
}

printf '\n%smuxnexus setup%s\n\n' "$B" "$X"

# --- bun: required, and installs itself without a package manager --------------
if command -v bun >/dev/null 2>&1; then
  ok bun "$(bun --version 2>/dev/null)"
else
  absent bun
  if confirm "Install bun from bun.sh?" Y; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 && ok bun "$(bun --version)" || missing=$((missing + 1))
  else
    printf '    skipped — see https://bun.sh\n'
    missing=$((missing + 1))
  fi
fi

# --- tmux: required ------------------------------------------------------------
if command -v tmux >/dev/null 2>&1; then
  ok tmux "$(tmux -V 2>/dev/null | awk '{print $2}')"
else
  absent tmux
  offer tmux tmux "install tmux from your package manager, then run this again"
fi

# --- tailscale: optional, and its macOS packaging is ambiguous enough that we
#     only ever point at the download page -------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  ok tailscale "$(tailscale version 2>/dev/null | head -1)"
else
  optional tailscale "not found — optional"
  printf '    %sonly needed for the default bind address; --host works without it%s\n' "$D" "$X"
  printf '    %shttps://tailscale.com/download%s\n' "$D" "$X"
fi

# --- cmux: optional, only affects workspace mirroring --------------------------
if command -v cmux >/dev/null 2>&1; then
  ok cmux "workspace mirror available"
else
  optional cmux "not found — optional, muxnexus drives plain tmux too"
fi

if [ "$missing" -gt 0 ]; then
  printf '\n%s%d prerequisite(s) still missing.%s Install them and run this again.\n\n' "$R" "$missing" "$X"
  exit 1
fi

# --- dependencies --------------------------------------------------------------
printf '\n'
( cd "$ROOT" && bun install )

# --- optional: the cmux guard --------------------------------------------------
printf '\n%sOptional:%s the cmux guard makes new cmux tabs open inside tmux, so the\n' "$B" "$X"
printf 'browser can attach to them. It appends 6 lines to ~/.zshrc.\n\n'

if [ ! -r "$GUARD" ]; then
  printf '  %sguard script not found at %s — skipping%s\n' "$D" "$GUARD" "$X"
elif [ -f "$ZSHRC" ] && grep -q "$GUARD_MARKER" "$ZSHRC"; then
  ok "~/.zshrc" "already wired"
elif confirm "Wire it up?" N; then
  backup_zshrc
  # Single-quoted formats keep $TMUX and friends literal in the written file.
  {
    printf '\n# muxnexus: run cmux tabs inside tmux so the browser can attach to them.\n'
    printf 'if [[ -o interactive && -z "$TMUX" && -n "$CMUX_PANEL_ID" && -z "$NO_TMUX" ]] && command -v tmux >/dev/null \\\n'
    printf '   && [[ -r "%s" ]]; then\n' "$GUARD"
    printf '  source "%s"\n' "$GUARD"
    printf '  %s\n' "$GUARD_MARKER"
    printf 'fi\n'
  } >> "$ZSHRC"
  ok "~/.zshrc" "guard added — open a new shell to pick it up"
else
  printf '    skipped — see docs/cmux-internals.md to add it later\n'
fi

# --- optional: the muxnexusctl alias -------------------------------------------
printf '\n%sOptional:%s a `muxnexus` alias for starting and stopping the server by\n' "$B" "$X"
printf 'hand — %smuxnexus start | stop | restart | status | logs%s.\n\n' "$D" "$X"

if [ -f "$ZSHRC" ] && grep -q "$ALIAS_MARKER" "$ZSHRC"; then
  ok "~/.zshrc" "alias already set"
elif confirm "Add the alias?" Y; then
  backup_zshrc
  printf '\n# muxnexus: manual control of the server.\n%s"%s"\n' "$ALIAS_MARKER" "$ROOT/scripts/muxnexusctl" >> "$ZSHRC"
  ok "~/.zshrc" "alias added — open a new shell to pick it up"
else
  printf '    skipped — run %s directly instead\n' "./scripts/muxnexusctl"
fi

# --- done ----------------------------------------------------------------------
printf '\n%sReady.%s Start it with:\n\n    bun run start\n\n' "$B" "$X"
if command -v tailscale >/dev/null 2>&1; then
  ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$ip" ] && printf 'then open %shttp://%s:7681/%s from any device on your tailnet.\n\n' "$B" "$ip" "$X"
fi
