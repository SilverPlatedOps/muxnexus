import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { footprintReader, PHYS_FOOTPRINT_OFFSET, RUSAGE_INFO_V2_SIZE } from "../src/server/footprint";

const HEADER = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/sys/resource.h";

describe("footprintReader", () => {
  const read = footprintReader();

  test("is available on this Mac", () => {
    expect(read).not.toBeNull();
  });

  test("reads this process's footprint, the figure top's MEM column shows", () => {
    const r = read!(process.pid);
    expect("bytes" in r).toBe(true);
    const out = Bun.spawnSync(["top", "-l", "1", "-pid", String(process.pid), "-stats", "mem"]).stdout.toString();
    const m = /^\s*([\d.]+)([KMG])\+?-?\s*$/m.exec(out.trim().split("\n").pop()!)!;
    const top = Number(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as "K" | "M" | "G"];
    // Read a moment apart, so near rather than equal.
    if ("bytes" in r) {
      expect(r.bytes).toBeGreaterThan(top / 2);
      expect(r.bytes).toBeLessThan(top * 2);
    }
  });

  test("another user's process is denied", () => {
    expect(read!(1)).toEqual({ error: "denied" });
  });

  test("a process that has exited is gone", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    expect(read!(p.pid)).toEqual({ error: "gone" });
  });

  test.skipIf(!existsSync(HEADER))("the offset and size match the SDK's rusage_info_v2", () => {
    const src = readFileSync(HEADER, "utf8");
    const body = /struct rusage_info_v2 \{([\s\S]*?)\};/.exec(src)![1];
    const fields = [...body.matchAll(/^\s*(uint8_t|uint64_t)\s+(\w+)(\[(\d+)\])?;/gm)].map((m) => ({
      name: m[2],
      size: m[1] === "uint8_t" ? Number(m[4] ?? 1) : 8,
    }));
    const offset = fields.slice(0, fields.findIndex((f) => f.name === "ri_phys_footprint")).reduce((n, f) => n + f.size, 0);
    expect(offset).toBe(PHYS_FOOTPRINT_OFFSET);
    expect(fields.reduce((n, f) => n + f.size, 0)).toBe(RUSAGE_INFO_V2_SIZE);
  });
});
