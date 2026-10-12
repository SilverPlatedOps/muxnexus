import { expect, test } from "bun:test";
import { createFolded } from "../src/client/folded";

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

test("reads the groups the sidebar already kept folded", () => {
  const store = memoryStore({ "muxnexus.collapsed": JSON.stringify(["work"]) });
  expect(createFolded(store).has("work")).toBe(true);
});

test("a change is remembered and told to every subscriber", () => {
  const store = memoryStore();
  const folded = createFolded(store);
  let told = 0;
  folded.subscribe(() => told++);
  folded.set("work", true);
  expect(folded.has("work")).toBe(true);
  expect(JSON.parse(store.data.get("muxnexus.collapsed")!)).toEqual(["work"]);
  folded.toggle("work");
  expect(folded.has("work")).toBe(false);
  expect(told).toBe(2);
});

test("setting what is already so tells nobody", () => {
  const folded = createFolded(memoryStore());
  let told = 0;
  folded.subscribe(() => told++);
  folded.set("work", false);
  expect(told).toBe(0);
});

test("an unsubscribed listener hears nothing more", () => {
  const folded = createFolded(memoryStore());
  let told = 0;
  const off = folded.subscribe(() => told++);
  off();
  folded.set("work", true);
  expect(told).toBe(0);
});

test("unreadable or unwritable storage still folds, for this page", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const folded = createFolded(broken);
  folded.set("work", true);
  expect(folded.has("work")).toBe(true);
  expect(createFolded(memoryStore({ "muxnexus.collapsed": "{nope" })).keys().size).toBe(0);
});
