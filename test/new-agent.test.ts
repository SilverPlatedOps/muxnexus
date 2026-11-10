import { expect, test } from "bun:test";
import { buildRequest, groupAccount, nameFromFolder, workspaceName } from "../src/client/new-agent";

test("the workspace name is the group as a tag, then the name", () => {
  expect(workspaceName("shop-api", "Work")).toBe("[Work] shop-api");
  expect(workspaceName("  notes ", null)).toBe("notes");
  expect(workspaceName("my.app", null)).toBe("my-app");
});

test("the name defaults to the folder's last part", () => {
  expect(nameFromFolder("~/github/shop-api/")).toBe("shop-api");
  expect(nameFromFolder("")).toBe("");
});

test("a group spends the Claude account named like it, else the default", () => {
  expect(groupAccount("Work", ["personal", "work"])).toBe("work");
  expect(groupAccount("Side", ["personal", "work"])).toBeNull();
  expect(groupAccount(null, ["work"])).toBeNull();
});

test("the request carries only what applies to the agent picked", () => {
  expect(buildRequest({ name: "", folder: "~/github/shop-api", group: "Work", agent: "claude", profile: "work" }))
    .toEqual({ name: "[Work] shop-api", folder: "~/github/shop-api", agent: "claude", profile: "work" });
  expect(buildRequest({ name: "x", folder: "", group: null, agent: "codex", profile: "work" })).toEqual({ name: "x", agent: "codex" });
  expect(buildRequest({ name: "sh", folder: "~", group: null, agent: "shell", profile: null })).toEqual({ name: "sh", folder: "~" });
  expect(buildRequest({ name: "", folder: "", group: null, agent: "shell", profile: null })).toBeNull();
  expect(buildRequest({ name: " ", folder: "", group: "Work", agent: "shell", profile: null })).toBeNull();
});
