#!/usr/bin/env python3
"""Wire scripts/agent-state.sh into a Claude Code profile's settings.json.

Idempotent: running it again changes nothing. The file is backed up once before
the first change, because it is Claude Code's, not ours.

Usage: install-agent-hook.py <config-dir> [...]   (no args: discover profiles)
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
MARKER = "agent-state.sh"


def profiles(home):
    """Profiles are ~/.claude and ~/.claude-* with a projects/ directory."""
    out = []
    for name in sorted(os.listdir(home)):
        if name != ".claude" and not name.startswith(".claude-"):
            continue
        path = os.path.join(home, name)
        if os.path.isdir(os.path.join(path, "projects")):
            out.append(path)
    return out


def wire(config_dir):
    settings = os.path.join(config_dir, "settings.json")
    if not os.path.exists(settings):
        return f"{config_dir}: no settings.json, skipped"
    with open(settings) as f:
        data = json.load(f)
    hooks = data.setdefault("hooks", {})

    added = []
    for event in EVENTS:
        entries = hooks.setdefault(event, [])
        # Already wired: leave it exactly as it is.
        if any(MARKER in h.get("command", "")
               for entry in entries for h in entry.get("hooks", [])):
            continue
        entries.append({"hooks": [{"type": "command",
                                   "command": f'"{SCRIPT}" {event}',
                                   "async": True}]})
        added.append(event)

    if not added:
        return f"{config_dir}: already wired"

    backup = f"{settings}.bak.{time.strftime('%Y%m%d%H%M%S')}"
    shutil.copy2(settings, backup)
    with open(settings, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    return f"{config_dir}: added {', '.join(added)} (backup: {os.path.basename(backup)})"


if __name__ == "__main__":
    dirs = sys.argv[1:] or profiles(os.path.expanduser("~"))
    if not dirs:
        print("no Claude profiles found")
        sys.exit(1)
    for d in dirs:
        print("  " + wire(d))
