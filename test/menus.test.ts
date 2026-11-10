import { expect, test } from "bun:test";
import { agentMenu, chatMenu, groupMenu, memberMenu, workspaceMenu, type AgentTarget, type Menu } from "../src/client/menus";

const labels = (m: Menu) => m.sections.map((s) => s.map((i) => i.label));
const elf: AgentTarget = { name: "ELF", kind: "claude", account: "work", folder: "~/github/elf-api", isWorkspace: true, current: true, archived: false, beside: true };

test("one-tab agent: full menu, spec order", () => {
  expect(labels(agentMenu(elf))).toEqual([
    ["Open beside"], ["Note"], ["New tab", "Start chat with…", "Change account…"],
    ["Rename…", "Move to group…"], ["Archive"], ["Kill…"],
  ]);
  expect(agentMenu(elf).sub).toBe("Claude · work · ~/github/elf-api");
  expect(agentMenu(elf).sections[2][0].children!.map((i) => i.label)).toEqual(["Claude", "Codex", "Shell"]);
});

test("a tab of a 2+ tab workspace: no workspace-level items", () => {
  expect(labels(agentMenu({ ...elf, isWorkspace: false, current: false }))).toEqual([
    ["Open", "Open beside"], ["Note"], ["Start chat with…", "Change account…"], ["Rename…"], ["Kill…"],
  ]);
});

test("codex and shell: inapplicable items are disabled with a reason", () => {
  const codex = agentMenu({ ...elf, kind: "codex" }).sections.flat();
  expect(codex.find((i) => i.action === "change-account")!.disabled).toBe("Codex uses its own login");
  const sh = agentMenu({ ...elf, kind: "shell" }).sections.flat();
  expect(sh.find((i) => i.action === "start-chat")!.disabled).toBe("A shell can't join a chat");
  expect(sh.find((i) => i.action === "change-account")!.disabled).toBe("A shell spends nothing");
  const far = agentMenu({ ...elf, beside: "Only tabs of the workspace on screen, for now" }).sections.flat();
  expect(far.find((i) => i.action === "open-beside")!.disabled).toBe("Only tabs of the workspace on screen, for now");
});

test("archived workspace offers Unarchive; kill confirms in words", () => {
  const m = agentMenu({ ...elf, archived: true });
  expect(m.sections.flat().some((i) => i.action === "unarchive")).toBe(true);
  expect(m.sections.at(-1)![0]).toMatchObject({ label: "Kill…", danger: true, confirm: "Kill ELF? Claude stops and its tab closes.", confirmLabel: "Kill" });
});

test("member menu: chat items first, agent part without Note; gone member shrinks", () => {
  const m = memberMenu({ handle: "claude2", role: "author", present: true, agent: { ...elf, current: false } });
  expect(labels(m)[0]).toEqual(["Note", "Terminal", "Change role…", "Replace…", "Remove from chat…"]);
  expect(m.sections[0][2].hint).toBe("author");
  expect(m.sections.flat().filter((i) => i.action === "note")).toHaveLength(0);
  expect(m.sections.flat().find((i) => i.action === "kill")!.confirm).toEndWith("It also leaves the chat.");
  expect(m.sections.flat().find((i) => i.action === "remove")!.confirm).toBe("Remove claude2 from this chat?");
  expect(labels(memberMenu({ handle: "x", present: false, agent: null }))).toEqual([["Reconnect", "Replace…", "Remove from chat…"]]);
});

test("workspace, group and chat menus", () => {
  const ws = workspaceMenu({ name: "Shop", tabs: 2, archived: false });
  expect(labels(ws)).toEqual([["New tab"], ["Rename…", "Move to group…"], ["Archive"], ["Kill workspace…"]]);
  expect(ws.sections[3][0]).toMatchObject({ hint: "2 tabs", confirm: "Kill Shop? Its 2 tabs close.", danger: true });
  expect(ws.sub).toBe("Workspace · 2 tabs");
  expect(labels(groupMenu({ name: "Work", folded: false }))).toEqual([["New agent in this group…"], ["Rename group…"], ["Fold"]]);
  expect(labels(groupMenu({ name: "Work", folded: true }))[2]).toEqual(["Unfold"]);
  expect(labels(chatMenu({ name: "storefront", archived: false, current: false, members: 2 }))).toEqual([["Open"], ["Chat notes", "Settings"], ["Rename…"], ["Archive"], ["Delete…"]]);
  const archived = chatMenu({ name: "old", archived: true, current: true, members: 1, shutdown: "Also shut down claude1" });
  expect(labels(archived)).toEqual([["Chat notes", "Settings"], ["Rename…"], ["Reopen"], ["Delete…"]]);
  expect(archived.sections.at(-1)![0]).toMatchObject({ option: "Also shut down claude1", confirmLabel: "Delete", confirm: 'Delete "old" for good? Its messages go. Its agents keep running.' });
});
