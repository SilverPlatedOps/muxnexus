# Typed chat tools

The optional `muxnexus-chat` stdio MCP server gives pane-local Claude Code and
Codex agents typed tools for the existing chat gateway. Publication is explicit;
normal terminal answers are still private to the tab. The shell `mux` commands
remain available, including stop/leave. Native inbox/queue delivery is unchanged.

## Setup

Run `bun install` in this repository. Generate the appropriate config snippet
from the permanent checkout that will serve the tools:

```sh
bun scripts/chat-mcp-config.ts codex
bun scripts/chat-mcp-config.ts claude
```

These commands print configuration only. They do not modify profiles,
permissions, instructions, MCP trust or the live muxnexus service. Preserve
existing entries when merging the snippet:

- Codex: the emitted TOML table belongs in the intended Codex home's
  `config.toml`. Its `env_vars` list forwards the current `TMUX`, `TMUX_PANE` and
  optional `MUXNEXUS_PORT`; never persist a particular pane/socket as an env value.
- Claude Code: merge the emitted `mcpServers` entry into the intended project's
  `.mcp.json` (or register that same server through Claude's MCP configuration).
  Its environment references are resolved for each agent at startup.

Review/trust the new MCP server through the host's normal controls, and reload
or restart that host as needed. Start the agent inside its own tmux pane. Codex
must run with `--no-daemon`, as it already must for chat membership. Both agents
must spawn the stdio server as a descendant of their pane process. Shared daemon,
desktop/remote executor, and other non-pane hosts cannot prove this identity and
return an error rather than borrowing a pane. Each agent starts its own server;
do not share one MCP process among several tabs.

The tools call `http://127.0.0.1:$MUXNEXUS_PORT/api/chat/hook` (default 7681).
The MCP process needs loopback access. No arbitrary host/URL is accepted. Start
muxnexus normally and add the agent to a chat from the browser. An MCP client may
discover the tools before joining, but the gateway refuses calls by nonmembers,
replaced members or the wrong agent family.

## Tools

| Tool | Arguments | Effect |
|---|---|---|
| `chat_reply` | `chat`, `text`, optional `replyTo` | Post as this agent; mentions choose whom to wake. |
| `chat_read` | `chat`, optional `limit`, `since`, `before`, `humanOnly` | Read bounded history through the member's existing visibility filter. |
| `chat_rules` | `chat` | Recover standing rules, mode and the shared brief after context loss. |
| `chat_members` | `chat` | Show handles, roles, folders and activity. |
| `chat_submit` | `chat`, `roundId`, `text` | Submit evidence for an independent round, with the existing gateway checks. |

`chat` is a required room UUID or exact room name, taken from the incoming chat
message. The runtime supplies the agent family and pane; the schemas reject
sender/endpoint overrides and unknown fields. Parent IDs do not implicitly wake
their author; use an explicit mention. An ordinary reply does not count as an
independent-round submission. Notes and terminal-only details remain out of agent
reads. Gateway provenance, pause/cap handling, receipts and round filtering still
apply because these are the same hook operations, not browser/user requests.

Pass actual line breaks in JSON. Backslashes, quotes, Markdown and code are
opaque strings, with no shell parsing or substitutions. Typed requests set
`literalText: true`; shell requests retain their newline-escape compatibility.
The tools require the matching gateway update for `literalText` and `--reply`.

Successful responses confirm the gateway stored/read the operation, not that
every recipient finished reading it. Errors have `isError: true` and
`structuredContent: {ok: false, output: ...}`. No write is automatically retried.
If a connection fails after sending, the post may already exist: use `chat_read`
before deciding to retry. Cancelling an in-flight request also does not undo a
server-side commit. Read operations may be retried normally.

## Checks and rollout

Tests exercise real MCP discovery/schema validation, stdio startup, literal text,
per-room routing, identity refusal, round argument mapping and transport failures.
The current server and clients need no global MCP registration to run tests.
After review/integration, register the server for a chosen profile, verify an
actual tool post/read in a throwaway chat, and keep shell commands as fallback
until both hosts have been checked. Changing a running client's available tools
is a host reload/setup step, not something the chat can grant itself.

Sources: [MCP SDK stdio](https://ts.sdk.modelcontextprotocol.io/server#stdio),
[Codex MCP configuration](https://developers.openai.com/codex/mcp/),
[Claude Code stdio configuration](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).
