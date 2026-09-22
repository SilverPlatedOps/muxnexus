# muxnexus

**What if the laptop could just… stay home?**

cmux runs Claude Code inside tmux on my Mac. The sessions live on that Mac, which
meant the Mac came with me everywhere — a 14" MacBook Pro in a bag, carried across
town for a twenty-minute terminal session. (Maybe I'm the only one who finds it
heavy. Just me? Okay.)

But tmux doesn't care where I am. Those sessions keep running whether I'm sitting
at the desk or not. The only missing piece was a way to reach them that wasn't
another laptop.

So that's what this is: a web UI for the tmux server already running on your
machine. Reach it over Tailscale or Cloudflare Access from an iPad, a lighter
laptop, a phone — and you land in the same sessions cmux is looking at. The iPad
can keep something playing in the other half of the screen, which the MacBook was
never going to let me do gracefully.

## Setup

```sh
git clone https://github.com/SilverPlatedOps/muxnexus.git && cd muxnexus
./scripts/install.sh
```

The script checks for bun, tmux and Tailscale, offers to install whatever is
missing — one confirmation each, nothing installed behind your back — pulls
dependencies, and optionally wires the cmux guard into your `~/.zshrc` (it backs
the file up first). Safe to run again; it checks before it acts.

Then start it:

```sh
bun run start
```

Open the URL it prints from any device on your tailnet.

> **There is no authentication. None.** The tailnet is the auth. Don't put this on
> a public interface.

### Running it

| Command | What it does |
| --- | --- |
| `bun run start` | Binds your Tailscale IPv4 on port 7681 |
| `bun run start -- --port 8080` | Serve on another port |
| `bun run start -- --host 127.0.0.1` | Bind somewhere other than the tailnet; repeatable |
| `bun run start -- --socket <path>` | Drive a specific tmux server |
| `bun run start -- --allow-host <name>` | Answer to another hostname; repeatable |
| `bun run dev` | Binds 127.0.0.1, restarts on change |
| `bun run setup` | The install script again |
| `bun test` | Tests |

`start` resolves the bind address with `tailscale ip -4` and refuses to start if
Tailscale is down. Pass `--host <addr>` to bind elsewhere — Cloudflare Access in
front of `127.0.0.1` works just as well.

It listens on your Tailscale address *and* on loopback, so `localhost` works at
the desk while the tailnet serves everything else. `--host` may be repeated to
add more; a wildcard (`0.0.0.0`) is left alone, since it covers loopback already
and answers on every network the machine later joins -- it warns about that.

It answers to the addresses it is bound to, to loopback, and to this machine's
MagicDNS name — so reaching it from a phone by name works without setting
anything up. Any other name needs `--allow-host`, which is what a reverse proxy
on its own domain wants. The names it will answer to are printed at startup.

That list is a DNS-rebinding guard, not authentication. It stops a page on the
public internet from pointing its own domain at your tailnet address and driving
your terminal through your browser. Comparing `Origin` to `Host` cannot do this
on its own: an attacker serving from their domain on this port controls both
headers, and they agree.

### Manual control

`bun run start` holds the terminal. For a server you start once and leave alone,
the installer can add a `muxnexus` alias (or call `./scripts/muxnexusctl`):

```sh
muxnexus start            # background, detached; pass server args after --
muxnexus stop
muxnexus restart
muxnexus status
muxnexus logs             # tail -f the log
```

It keeps a pidfile and log under `~/.local/state/muxnexus/`, and `stop` also
finds a server you started some other way.

### Which tmux server

muxnexus drives exactly one tmux server, chosen at startup:

1. `--socket <path>`, if you passed it (tmux's `-S`).
2. Otherwise cmux's own server at `~/.cmux/local-tmux/server.sock`, when that
   socket exists — so the browser and cmux share one set of sessions with no
   extra setup.
3. Otherwise tmux's default socket. **cmux is not required.**

Whichever it picks is printed at startup.

## Why not something that exists

- **cmux's iPhone app** — in beta, but it's an app to install and pair, and there's
  no web client. That's the gap this fills.
- **[Orca](https://github.com/stablyai/orca)** — its unit of work is a git worktree.
  Mine is the terminal I already had open.
- **Claude's own apps** — they render the session *as an app*. I want the terminal,
  because that's where everything else I run already lives.

### About the name

Not affiliated with [cmux](https://github.com/manaflow-ai/cmux), and not trying to
be the official anything. cmux is excellent and the people building it deserve
every bit of credit they get — "nexus" is just the bridge I needed. If their mobile
story grows into this, use theirs.

## Keys

| Key | Action |
| --- | --- |
| `Cmd+B` | Toggle the sidebar |
| `Cmd+F` | Find in scrollback |
| `Cmd+C` | Copy the selection (no selection: nothing) |
| `Cmd+V` | Paste (bracketed paste, forwarded by tmux) |
| everything else | Sent to tmux, including `C-b` prefix keys |

## Using it with cmux

cmux's local-tmux feature runs its own tmux server (`cmux local-tmux list` shows
its sessions). muxnexus uses that server by default, so a session created in
either place shows up in the other, and the browser can open cmux workspaces to
match.

The details — how workspaces map to sessions, what the guard does, and the tmux
sizing caveats worth knowing — are in
[docs/cmux-internals.md](docs/cmux-internals.md).

## Docs

- [docs/cmux-internals.md](docs/cmux-internals.md) — workspace/session mapping,
  the `~/.zshrc` guard, tmux sizing behaviour
- [docs/smoke-test.md](docs/smoke-test.md) — the checklist to run after touching
  the server or PTY layer

## Licence

[MIT](LICENSE). Do what you like with it.
