# Chat consolidation, notes and search

Status: prototype updated for user review; production implementation has not started.
Owner for the later implementation: Claude, after the user reviews the prototype.

Preview: http://127.0.0.1:17690/
Source: `prototypes/chat-consolidation/`.

## Outcome

Give the conversation more room, keep agent switching quick, and make chat
knowledge easy to keep and retrieve. Desktop is the current scope. Match the
existing muxnexus palette and retain scoped searches and Next waiting / Cmd+J.

## Reviewable prototype

- One header holds the chat title, agent terminal switches, Find in chat, and
  Chat details. The same agent buttons switch an open terminal panel.
- Claude and Codex logos identify the agent family. The prototype starts with
  four agents so duplicate logos can be evaluated; the top toggle switches
  between two and four agents. Stable handles and role labels distinguish
  individuals without relying on color or a different invented shape.
- Chat details has Setup and Notes views. Setup holds mode, shared brief,
  membership and delivery/context diagnostics; Notes is the user's scratchpad.
- Chat notes save locally in the prototype. They are separate from agent
  instructions. Share as brief opens an editable preview and requires explicit
  confirmation before replacing the existing brief. It does not wake agents.
- Global search includes chat names, messages, chat notes and sample sessions.
  Results show a matching excerpt, author and date/time where applicable.
  Selecting a message scrolls to and highlights it; selecting a note opens Notes.
- Find in chat uses the same search surface with the current-chat scope and
  messages selected. Everything / This chat and result-type controls change the
  search. Cmd+F opens current-chat search; Cmd+Shift+K opens global search.
- Per-message actions appear on hover or keyboard focus. Usage details expand
  on demand. Compact spacing and monospace prose can be compared in the demo.

The prototype uses one sample chat, local storage and simulated sessions/status.
It does not demonstrate server persistence, network failures, real multi-chat
search, archived-chat navigation or concurrent edits. No sample is live data.
The sidebar plus explicitly resets the sample; production must retain real New
chat behavior. Prototype local-storage values must not be migrated into real data.

## Phase 1 — consolidate the live chat UI

Primary files: `src/client/chat/ui.ts`, `context.ts`, `activity.ts`,
`src/client/style.css`.

1. Consolidate the three header rows. Preserve double-click and keyboard rename.
2. Make Chat details a single side panel with Setup and Notes. Reuse existing
   mode/brief/handoff workflows rather than duplicating handlers.
3. Keep working/idle/input/offline states visible, including narrow desktop
   widths. Preserve screen-reader announcements and reduced motion.
   Use actual agent logos consistently in header switches, message avatars,
   members, recipients, handoff choices and search results. Vendor vetted assets
   with source/license attribution rather than loading a third-party image on
   every view. Adjacent text supplies the accessible name; decorative logos have
   empty alt text. Keep text fallback if an asset fails.
4. Move message handoff and terminal details into accessible actions/details.
   Keep a discoverable way to start a handoff without selecting a message.
5. Preserve all existing functions: independent round start/end and submission
   status, pause/resume/stop where present, archive/delete/reconnect, membership,
   deliveries, images, Markdown, recipient selection and terminal controls.
   The simplified demo does not show every production action; audit their new
   homes before removing the old toolbar.
6. Improve prose readability while keeping code/commands monospace. User review
   determines default density/type; don't ship the prototype's comparison strip.

### Several agents from the same family or model

- Identity is the existing immutable member handle (`claude1`, `claude2`,
  `codex1`, `codex2`), not the logo, role, process ID or current model. Handles
  are already never reused within a chat. Keep them visible and usable for
  mentions. A role such as Builder, Reviewer or Investigator is extra context,
  not an identity key; roles can change.
- Two Claude agents use the same Claude logo; two Codex agents use the same
  Codex logo. Do not invent a different brand symbol or recolor it to imply a
  different model. Status has its own text/dot and selected state has a border
  or fill. Color remains supplemental.
- Show role/profile/repository in the expanded member/terminal context and
  tooltips where available. A precise model name may be shown only when supplied
  by reliable runtime metadata. Agent family and underlying model are different
  concepts; never guess the latter from the logo or handle.
- With many members, preserve a one-click route to the active/recent agents and
  provide keyboard-reachable overflow for the rest. The prototype uses a
  horizontally scrollable agent strip at narrower desktop widths; review an
  overflow picker before production if that proves awkward. Keep the active
  agent visible when switching. Do not add a second independent selector to the
  terminal panel.
- Regression checks: two same-family agents post distinct messages; switching,
  mentions, handoff and search target the exact handle. Removing/reconnecting a
  member must not transfer another member's label or history. Test 2, 4 and 8+
  member layouts; preserve full labels in accessible names and tooltips.

## Phase 2 — persistent notes owned by a chat

Primary files: `src/shared/chat.ts`, `src/shared/protocol.ts`,
`src/server/chat/{model,service,store}.ts`, `src/server/server.ts`, and a focused
client note component. Reuse the existing editor when practical.

Proposed representation: optional `Chat.notes = {text, rev, updatedAt}`. Existing
saved chats load as empty notes. Use the chat UUID, not member/window/process
identity. Persist using the existing serialized atomic chat store. Start with a
documented 100,000-character limit, enforced client and server side. Keep notes
out of lightweight chat summaries.

- One editable document per chat in v1. User-owned, separate from window notes
  and shared brief. Member replacement or terminal closure does not affect it.
- Debounced autosave with explicit Saving / Saved / Unsaved / Conflict states.
  Saved means a server acknowledgment, not just a socket send. Request IDs and
  chat IDs scope acknowledgments; edits must not bleed into a newly selected chat.
- Use an expected revision for updates. A stale edit is rejected with the latest
  revision; keep the user's draft and offer review/retry rather than silently
  overwriting another browser's work. Serialize revision check and save together.
- Commit the saved revision durably before publishing it or indexing its text.
  Existing handlers mutate cached chat objects before saving; do not copy that
  pattern for notes. Coordinate with other chat mutations, including new posts,
  through the service's transaction/serialization boundary so a slow note save
  cannot overwrite a newer message. Disk failure leaves authoritative cached
  state/revision and search unchanged; the client keeps its unsaved draft.
- Preserve unsaved drafts through disconnect/reload and recover them per chat.
  Reconcile against the current server revision before resending. Disk failure
  retains unsaved text and exposes retry; never display a false Saved state.
- Notes survive archiving and restarting. Deleting a chat uses existing delete
  confirmation and deletes its notes together with it.
- No notes in agent wakes, `mux read`, `mux rules`, context counters or peer
  messages. Notes APIs/search are browser-facing, not additional agent tools.
- Share as brief uses selected text when available, otherwise the document.
  Preview can be edited to the existing 4,000-character brief limit. Make
  replacement of the current brief explicit; cancellation changes neither.
  Extend the existing brief update path with a correlated request ID and expected
  brief revision, checked at commit. Today success is inferred from a pushed chat
  update; it is not a correlated acknowledgment. Return explicit success/error
  for the new flow, and reject a changed brief with a conflict/refresh preview
  rather than overwriting another browser's edits. Keep legacy callers compatible
  while updating the normal brief editor to use the same protection. Original
  notes remain intact, and sharing does not automatically wake agents.

## Phase 3 — genuine chat search

Primary files: `src/client/global-search.ts`, global-search wiring in `app.ts`,
chat navigation in `src/client/chat/ui.ts`, shared protocol, chat service/store.

1. Extend global result types with chat, chat-message and chat-note. Keep current
   workspace, terminal and window-note results. Stop calling a surface Search
   everything while silently omitting chats.
2. Search persisted chat names, message `text`, and chat note text. Case-insensitive
   literal matching for v1; no regex evaluation, embeddings or external service.
   Exclude terminal `tabText`, delivery internals and image bytes/filenames from
   message search in v1. Show source kind, chat name, author/date and a safe
   matching excerpt. Never render result text through unsafe HTML.
3. Search beyond the currently loaded transcript: implement a bounded server-side
   browser request, with request ID, query, current-chat ID if scoped, result
   types, and cursor. Suggested limits: query <=256 characters, <=50 results per
   page and excerpt <=240 characters. Return stable IDs, not whole transcripts.
   Debounce input and ignore stale responses. Cache/index in memory if needed,
   invalidating on message/note edits, rename, archive and delete; measure before
   adding a database or dependency.
4. Include archived chats with a visible Archived label and explicit navigation;
   opening a result must not silently unarchive a chat. Search the user's saved
   posts, including round posts visible to the user, only through the browser
   path. This must not expose blind posts or private notes through agent reads.
5. Message hits carry `{chatId, messageId}`. Open the chat and load the relevant
   history range before scrolling/highlighting/focusing the message. Handle a
   deleted chat/message or stale result with a useful message and refresh action.
   A note hit opens the correct chat's Notes view and retains unsaved work in the
   previous chat. Show loading, empty and server-error states distinctly.
6. Retain the sidebar's name-only chat filter. Add Find in chat via a labeled
   header button and Cmd+F scoped to the active chat. Do not intercept Cmd+F
   inside terminal/editor/search contexts that own it. Global Cmd+Shift+K stays
   unchanged; current scoped Cmd+K and Cmd+J continue working.
7. Both search scopes share one results component. Scope and kind must be clear;
   changing to This chat must never leave results from another chat on screen.

## Acceptance and validation

- Old saved chats load without a migration or data loss. Window notes continue
  working. Notes survive restart/archive and stay attached to their chat.
- Two-browser stale revisions, reconnect, disk-save failure, reload recovery and
  switching chats while a save is pending cannot lose or misattribute edits.
- Editing notes causes zero agent delivery. Share cancellation causes zero brief
  changes; confirmed sharing updates the brief only and honors its size limit.
- Global search finds a chat by title, a historical message outside the loaded
  page, a newly saved note and an archived chat. Navigation highlights the exact
  matching message. Scoped search never returns another chat's content.
- Search updates after new messages, note changes, rename and delete. Test
  pagination, Unicode, literal punctuation, stale replies, no matches, failures,
  HTML-looking text and independent-round privacy boundaries.
- Keyboard: focus-visible message menus, dialogs labeled with Escape/restore,
  current-chat search shortcut ownership and terminal switching. Check 1000,
  1224 and 1440 desktop widths with setup/notes/terminal panels open.
- Run `bun test`, `bunx tsc --noEmit`, client build, and real browser flows.
  Add focused regression tests for new persistence/search contracts rather than
  tests mirroring markup. Run tmux-dependent suites serially to avoid shared
  socket contention. Report any live-agent behavior not exercised.

## Handoff to Claude

After prototype approval, ask Claude to implement one bounded phase at a time.
Give this plan and the prototype directory, plus current uncommitted gateway
work as context. Claude should first report proposed field/protocol changes and
file ownership so parallel changes don't overlap. Keep production changes
reviewable; request Codex review before the next phase. No push, deployment or
destructive data migration is included in this plan's authorization.
