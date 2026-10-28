# Chat gateway

The gateway keeps the existing native transports: Claude Code's local inbox
socket and `codex queue --thread` for Codex. It does not type into terminals.
Codex's documented app-server offers structured turns and streamed events, but
using it as the session owner would change the lifecycle of the existing
`--no-daemon` tabs. This change optimizes delivery without taking ownership of
those sessions or modifying their permission settings.

References: [Codex queue](https://learn.chatgpt.com/docs/developer-commands#codex-queue),
[Codex app-server](https://learn.chatgpt.com/docs/app-server).

## What changes

A repeat wake carries the sender/provenance header and new messages, without
repeating the reply or formatting instructions. Standing rules are shared with
the rules panel, sent at join, and communication-rule updates are sent once to
existing conversations. `mux rules --chat <id>` retrieves the current rules, mode and pinned brief,
including revisions that were already sent. Automatic compaction detection is
not implemented: after compaction, this command can restore the chat context.
Sleep-timeout compensation is also separate from the gateway changes.
Plain prose is the default; formatting is used when it makes the answer clearer.
Every wake includes a short `mux rules` recovery hint. Batch headings are neutral;
each entry keeps its original human/peer/room provenance header. These deliberate
redundancies preserve authority and recovery when earlier context was compacted.

Adjacent queued messages for the same room and recipient share a packet, up to
20 messages / 48,000 UTF-8 body bytes. Codex still receives only one packet at a
time while idle. Another room, an oversized message, a pause or a blind round
cannot be bypassed. Every original message retains its delivery state; a packet
shares the receipt probe and advances the cursor only after adapter success.
Already handed-off native queue messages cannot be recalled or merged.

Short human context stays inline, including instructions between batched
messages in chronological order. Background peer posts become exact message
references. Larger human context is explicitly required and fetched with
`mux read --chat <id> --since <id> --before <id> --human`. Cursor reads go forward,
filter out room notices when requested, retain blind-round restrictions, and
provide the next cursor when another page is needed. Pages have a 48,000-byte
body budget, except that one long message is returned intact.

Exceptionally large serialized packets use a small mailbox wake with the
standing rules, pinned brief, and a required paginated read. Its receipt probe
matches that emitted header. Context is never silently summarized or truncated.

## Measurements

A synthetic fixture compared this change with commit `3620e6d`, using the same
small messages and an already welcomed agent:

- Single steady wake: 250 to 138 UTF-8 bytes (45% reduction).
- Six queued messages: six wakes / 1,629 bytes to one wake / 715 bytes (56%).
- First join in the same fixture: 1,808 to 1,531 bytes (15%).

These are transport measurements, not token, quota, latency or cost claims.
On-demand context costs bytes when fetched. Claude Code can add its own peer
message framing, which this measurement does not include or control.

The live activity row says an agent is *working*, with animated dots. It uses
online running state from existing hooks, which includes reasoning and tools;
it does not claim to detect actual typing or expose private reasoning. It clears
for idle, permission/input waits, offline, replaced and departed agents, and
respects reduced-motion preferences.
