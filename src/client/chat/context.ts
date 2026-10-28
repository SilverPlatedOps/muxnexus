import { CHAT_MODES, MODE_HINT, type Chat, type ChatMode } from "../../shared/chat";
import type { ClientMessage } from "../../shared/protocol";
import { renderMarkdown } from "./markdown";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag); e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, action: () => void) {
  const b = node("button", "chat-btn", text); b.type = "button"; b.onclick = action; return b;
}

/** Task controls keep user-owned context separate from the message transcript. */
export function createChatContext(send: (m: ClientMessage) => boolean) {
  const el = node("section", "chat-context");
  let chat: Chat | null = null;
  let signature = "";
  let briefOpen = false;
  let statsOpen = false;
  let contextChat: string | null = null;
  let pending: { chatId: string; acknowledged(c: Chat): boolean; done(): void; fail(message: string): void } | null = null;

  function dialog(title: string) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const d = node("dialog", "chat-task-dialog");
    const form = node("form", "chat-task-form");
    const h = node("h2", "", title); h.id = "chat-task-title";
    d.setAttribute("aria-labelledby", h.id);
    const body = node("div", "chat-task-body");
    const foot = node("footer", "chat-task-foot");
    const dismiss = () => { pending = null; d.close(); d.remove(); previous?.focus({ preventScroll: true }); };
    foot.append(button("Cancel", dismiss));
    form.append(h, body, foot); d.append(form); document.body.append(d);
    d.addEventListener("cancel", (e) => { e.preventDefault(); dismiss(); });
    d.addEventListener("keydown", (e) => { e.stopPropagation(); });
    d.showModal();
    const status = node("p", "chat-task-status"); status.setAttribute("role", "status");
    foot.prepend(status);
    return { body, foot, form, dismiss, status };
  }
  function submit(d: ReturnType<typeof dialog>, go: HTMLButtonElement, message: ClientMessage & { id: string }, acknowledged: (c: Chat) => boolean) {
    if (go.disabled) return;
    if (!send(message)) { d.status.textContent = "Not sent: reconnect first. Your text is kept here."; return; }
    go.disabled = true;
    const controls = d.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
    controls.forEach((c) => { c.disabled = true; });
    d.status.textContent = "Waiting for confirmation…";
    pending = { chatId: message.id, acknowledged, done: d.dismiss, fail(message) { go.disabled = false; controls.forEach((c) => { c.disabled = false; }); d.status.textContent = message; } };
  }
  function field(parent: HTMLElement, label: string, value = "", multi = false) {
    const l = node("label", "chat-task-field", label);
    const i = multi ? node("textarea", "") : node("input", "");
    i.value = value;
    if (i instanceof HTMLTextAreaElement) i.rows = 5;
    l.append(i); parent.append(l); return i;
  }
  function editBrief() {
    if (!chat) return;
    const c = chat;
    const d = dialog("Shared task brief");
    d.body.append(node("p", "chat-task-hint", "Your goal, constraints, decisions and open questions. Agents receive changes on their next wake. They can propose edits in chat."));
    const i = field(d.body, "Brief · up to 4,000 characters", c.brief?.text ?? "", true);
    i.maxLength = 4000;
    d.body.append(node("p", "chat-task-hint", "Leave empty to clear the brief. Saving does not wake agents."));
    const save = button("Save brief", () => {}); save.type = "submit"; save.classList.add("pri"); d.foot.append(save);
    d.form.onsubmit = (e) => { e.preventDefault(); submit(d, save, { t: "chat-brief", id: c.id, text: i.value }, (next) => (next.brief?.text ?? "") === i.value.trim()); };
    i.focus();
  }
  function startRound() {
    if (!chat) return;
    const c = chat;
    const d = dialog("Independent investigation");
    d.body.append(node("p", "chat-task-hint", "Each agent posts evidence before seeing the other answers. Answers reveal when all participants submit, or you end the round. Existing conversation context and shared files remain accessible."));
    const topic = field(d.body, "Question to investigate", "", true); topic.required = true; topic.maxLength = 8000;
    const go = button("Start round", () => {}); go.type = "submit"; go.classList.add("pri"); d.foot.append(go);
    d.form.onsubmit = (e) => { e.preventDefault(); if (!topic.value.trim()) return; submit(d, go, { t: "chat-round", id: c.id, action: "start", topic: topic.value.trim() }, (next) => next.round?.state === "open" && next.round.topic === topic.value.trim()); };
    topic.focus();
  }
  function handoff(excerpt = "", label = "Selected excerpt") {
    if (!chat) return;
    const c = chat;
    const d = dialog("Hand off context");
    d.body.append(node("p", "chat-task-hint", "Choose who receives this excerpt and give them a specific question. Mentions inside the excerpt do not choose recipients."));
    const recipients = node("fieldset", "chat-task-recipients"); recipients.append(node("legend", "", "Send to"));
    const boxes = c.members.filter((m) => m.kind !== "user" && !m.left).map((m) => {
      const l = node("label", ""); const box = node("input", ""); box.type = "checkbox"; box.value = m.handle;
      l.append(box, ` ${m.handle}`); recipients.append(l); return box;
    });
    d.body.append(recipients);
    const source = field(d.body, "Source label", label); source.required = true;
    const question = field(d.body, "Question / review scope", "", true); question.required = true;
    const content = field(d.body, "Excerpt or diff", excerpt, true); content.required = true; content.maxLength = 24000;
    const repo = field(d.body, "Repository (optional)");
    const revision = field(d.body, "Commit / revision (optional)");
    const preview = node("details", "chat-handoff-preview"); preview.append(node("summary", "", "Preview excerpt"));
    let rendered = renderMarkdown(content.value); preview.append(rendered);
    content.oninput = () => { const next = renderMarkdown(content.value); rendered.replaceWith(next); rendered = next; };
    d.body.append(preview);
    const error = node("p", "chat-task-error"); error.setAttribute("role", "alert"); d.body.append(error);
    const go = button("Send handoff", () => {}); go.type = "submit"; go.classList.add("pri"); d.foot.append(go);
    d.form.onsubmit = (e) => {
      e.preventDefault(); const to = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!to.length) { error.textContent = "Choose at least one agent."; boxes[0]?.focus(); return; }
      if (!question.value.trim() || !content.value.trim()) { error.textContent = "Enter a question and an excerpt."; return; }
      source.value = source.value.trim() || "Selected excerpt";
      const before = c.nextId;
      submit(d, go, { t: "chat-handoff", id: c.id, to, question: question.value.trim(), excerpt: content.value, label: source.value.trim(), ...(repo.value.trim() ? { repo: repo.value.trim() } : {}), ...(revision.value.trim() ? { revision: revision.value.trim() } : {}) }, (next) => next.messages.some((m) => m.id >= before && m.from === "user" && m.handoff?.label === source.value.trim() && m.text.includes(content.value.replace(/\n+$/, ""))));
    };
    question.focus();
  }
  return {
    el, handoff,
    failed(message: string) { pending?.fail(message); pending = null; },
    update(next: Chat | null) {
      if (next && pending?.chatId === next.id && pending.acknowledged(next)) pending.done();
      if (contextChat === next?.id) {
        briefOpen = el.querySelector<HTMLDetailsElement>(".chat-brief-preview")?.open ?? briefOpen;
        statsOpen = el.querySelector<HTMLDetailsElement>(".chat-context-stats")?.open ?? statsOpen;
      }
      chat = next;
      if (contextChat !== next?.id) { briefOpen = false; statsOpen = false; contextChat = next?.id ?? null; }
      const key = JSON.stringify(next ? [next.id, next.mode, next.brief, next.round, next.members.map((m) => [m.handle, m.left, m.modeSent, m.briefSent, m.payload])] : null);
      if (key === signature) return; signature = key;
      el.replaceChildren(); el.hidden = !next;
      if (!next) return;
      const select = node("select", "chat-mode"); select.setAttribute("aria-label", "Chat activity");
      for (const mode of ["general", ...CHAT_MODES]) {
        const o = node("option", "", mode[0]!.toUpperCase() + mode.slice(1)); o.value = mode; select.append(o);
      }
      select.value = next.mode ?? "general";
      select.title = next.mode ? MODE_HINT[next.mode] : "General chat rules";
      select.onchange = () => {
        if (!send({ t: "chat-mode", id: next.id, mode: select.value === "general" ? null : select.value as ChatMode })) select.value = next.mode ?? "general";
      };
      const brief = button(next.brief?.text ? `Brief · v${next.brief.rev}` : "Add brief", editBrief);
      const hand = button("Hand off…", () => handoff());
      hand.disabled = next.round?.state === "open" || !next.members.some((m) => m.kind !== "user" && !m.left);
      if (hand.disabled) hand.title = next.round?.state === "open" ? "Reveal the independent round before sharing context" : "Add an agent first";
      el.append(node("h3", "chat-details-label", "Mode"), select, node("h3", "chat-details-label", "Brief and handoff"), brief, hand);
      if (next.mode === "investigate" || next.round?.state === "open") {
        const round = button(next.round?.state === "open" ? "Reveal answers" : "Independent round…", () => {
          if (next.round?.state === "open") send({ t: "chat-round", id: next.id, action: "end" }); else startRound();
        });
        round.disabled = next.round?.state !== "open" && next.members.filter((m) => m.kind !== "user" && !m.left).length < 2;
        if (round.disabled) round.title = "Add at least two agents to start an independent round";
        el.append(round);
      }
      if (next.round?.state === "open") el.append(node("span", "chat-task-hint", `${next.round.submitted.length}/${next.round.participants.length} submitted · peer answers withheld`));
      else if (next.mode) el.append(node("span", "chat-task-hint", MODE_HINT[next.mode]));
      const measured = next.members.filter((m) => m.kind !== "user" && m.payload);
      if (measured.length) {
        const stats = node("details", "chat-context-stats"); stats.open = statsOpen; stats.ontoggle = () => { statsOpen = stats.open; }; stats.append(node("summary", "", "Context sent"));
        for (const m of measured) stats.append(node("p", "chat-task-hint", `${m.handle}: ${m.payload!.count} wakes · ${m.payload!.bytes.toLocaleString()} bytes total · ${m.payload!.last.toLocaleString()} bytes last wake`));
        stats.append(node("p", "chat-task-hint", "UTF-8 payload bytes from muxnexus, not tokens or the agent’s full context. Recorded from this update onward."));
        el.append(stats);
      }
      if (next.brief?.text) {
        const details = node("details", "chat-brief-preview"); details.open = briefOpen; details.ontoggle = () => { briefOpen = details.open; }; details.append(node("summary", "", "Task brief"), renderMarkdown(next.brief.text));
        const pending = next.members.filter((m) => m.kind !== "user" && !m.left && (m.briefSent ?? 0) !== next.brief!.rev).map((m) => m.handle);
        details.append(node("p", "chat-task-hint", pending.length ? `Pending next wake: ${pending.join(", ")}` : "Sent to all current agents; delivery does not mean read."));
        el.append(details);
      }
    },
  };
}
