import { expect, test } from "bun:test";
import { editResult } from "../src/client/inline-edit";

test("editResult saves trimmed changes, refuses no-ops and unwanted empties", () => {
  expect(editResult("ELF", "  elf-api ", false)).toBe("elf-api");
  expect(editResult("ELF", "ELF", false)).toBeNull();
  expect(editResult("ELF", " ELF ", false)).toBeNull();
  expect(editResult("ELF", "   ", false)).toBeNull();
  expect(editResult("reviewer", "", true)).toBe("");
  expect(editResult("", "", true)).toBeNull();
});
