#!/usr/bin/env python3
"""Wire scripts/agent-state.sh into a Claude Code profile's settings.json, and
into Codex's hooks.json.

Idempotent: running it again changes nothing. The file is backed up once before
the first change, because it is Claude Code's (or Codex's), not ours.

Usage: install-agent-hook.py <config-dir> [...]   (no args: discover profiles)
A directory named .codex* is taken as a Codex home.
"""
import json
import os
import shutil
import sys
import time

EVENTS = [
    "PermissionRequest", "PreToolUse", "PostToolUse", "UserPromptSubmit",
    "Notification", "Stop", "StopFailure", "SessionStart", "SessionEnd",
]
SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "agent-state.sh")
# Codex shares Claude Code's hook events, less StopFailure, which it has none of.
CODEX_EVENTS = [e for e in EVENTS if e != "StopFailure"]
MARKER = "agent-state.sh"


def profiles(home):
    """Profiles are ~/.claude and ~/.claude-* with a projects/ directory, plus ~/.codex."""
    out = []
    for name in sorted(os.listdir(home)):
        if name != ".claude" and not name.startswith(".claude-"):
            continue
        path = os.path.join(home, name)
        if os.path.isdir(os.path.join(path, "projects")):
            out.append(path)
    codex = os.path.join(home, ".codex")
    if os.path.isdir(codex):
        out.append(codex)
    return out


def add_hooks(hooks, events, command):
    """Append our entry to each event that lacks one; the events it was added to."""
    added = []
    for event in events:
        entries = hooks.setdefault(event, [])
        # Already wired: leave it exactly as it is.
        if any(MARKER in h.get("command", "")
               for entry in entries for h in entry.get("hooks", [])):
            continue
        entries.append({"hooks": [command(event)]})
        added.append(event)
    return added


def save(path, data, existed):
    """Write `data` back, backing up what was there first. The backup's name, or None."""
    backup = None
    if existed:
        backup = f"{path}.bak.{time.strftime('%Y%m%d%H%M%S')}"
        shutil.copy2(path, backup)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return backup


def wire(config_dir):
    settings = os.path.join(config_dir, "settings.json")
    if not os.path.exists(settings):
        return f"{config_dir}: no settings.json, skipped"
    with open(settings) as f:
        data = json.load(f)
    added = add_hooks(data.setdefault("hooks", {}), EVENTS, lambda event: {
        "type": "command", "command": f'"{SCRIPT}" {event}', "async": True})

    if not added:
        return f"{config_dir}: already wired"

    backup = save(settings, data, True)
    return f"{config_dir}: added {', '.join(added)} (backup: {os.path.basename(backup)})"


def wire_codex(codex_home):
    """Codex keeps hooks in their own file, which may not exist yet."""
    path = os.path.join(codex_home, "hooks.json")
    existed = os.path.exists(path)
    data = {}
    if existed:
        with open(path) as f:
            data = json.load(f)
    # No "async": the script returns in milliseconds, and Codex's own schema is
    # the thing an unknown key could trip.
    added = add_hooks(data.setdefault("hooks", {}), CODEX_EVENTS, lambda event: {
        "type": "command", "command": f'"{SCRIPT}" {event} codex'})

    if not added:
        return f"{codex_home}: already wired"

    backup = save(path, data, existed)
    note = f"backup: {os.path.basename(backup)}" if backup else "created hooks.json"
    return (f"{codex_home}: added {', '.join(added)} ({note})\n"
            f"    Codex runs new hooks only once you trust them: open codex and review them in /hooks")


if __name__ == "__main__":
    dirs = sys.argv[1:] or profiles(os.path.expanduser("~"))
    if not dirs:
        print("no Claude profiles found")
        sys.exit(1)
    for d in dirs:
        codex = os.path.basename(os.path.normpath(d)).startswith(".codex")
        print("  " + (wire_codex(d) if codex else wire(d)))
