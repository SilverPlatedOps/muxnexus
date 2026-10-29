import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ABOUT } from "../src/client/display";

const NOTICE = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");

test("the About notice carries the credit NOTICE asks modified versions to keep", () => {
  const credit = NOTICE.match(/"(muxnexus by [^"(]+?)\s*\((https:[^)]+)\)"/);
  expect(credit).not.toBeNull();
  const [, name, url] = credit!;
  expect(ABOUT.text).toContain(name);
  expect(ABOUT.links.map((l) => l.href)).toContain(url);
});

test("the About notice says what the AGPL asks of an on-screen notice", () => {
  expect(ABOUT.text).toContain("© 2026");
  expect(ABOUT.text).toContain("under the GNU AGPL");
  expect(ABOUT.text).toContain("no warranty");
  expect(ABOUT.links.find((l) => l.label === "Licence")?.href).toBe("/licence");
});
