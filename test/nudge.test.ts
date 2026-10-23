import { describe, expect, test } from "bun:test";
import type { SessionInfo, SwapNotice } from "../src/shared/protocol";
import { nudgeModel } from "../src/client/nudge";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const notice = (over: Partial<SwapNotice>): SwapNotice => ({
  episode: 1, severity: "urgent", reason: "writes", rate: 22 * MiB, swapUsed: null, written: null, bootTime: null, holders: [], acked: false, at: 0, ...over,
});
const sessions: SessionInfo[] = [{ name: "work", id: "$1", attached: 1, windows: [{ id: "@1", index: 0, name: "content-api", active: true, panes: 1 }] }];

describe("nudgeModel", () => {
  test("only while urgent", () => {
    expect(nudgeModel(null, sessions)).toBeNull();
    for (const severity of ["calm", "busy", "recovered"] as const) expect(nudgeModel(notice({ severity }), sessions)).toBeNull();
  });

  test("says what the trouble is, in the headline and the page title", () => {
    expect(nudgeModel(notice({}), sessions)).toMatchObject({ headline: "● Swap writing 22 MB/s to the SSD", title: "● Swap 22 MB/s · muxnexus" });
    expect(nudgeModel(notice({ reason: "both" }), sessions)!.headline).toBe("● Swap writing 22 MB/s to the SSD");
    expect(nudgeModel(notice({ reason: "pressure" }), sessions)).toMatchObject({ headline: "● Memory pressure", title: "● Memory pressure · muxnexus" });
  });

  test("names the biggest holders, tabs by session and tab, ones it cannot place left out", () => {
    const holders = [
      { kind: "app" as const, name: "IntelliJ IDEA", bytes: 3.2 * GiB },
      { kind: "app" as const, name: "Docker VM · Rancher", bytes: 3.0 * GiB },
      { kind: "tab" as const, name: "@9", bytes: 2 * GiB },
      { kind: "tab" as const, name: "@1", bytes: 1.5 * GiB },
    ];
    expect(nudgeModel(notice({ holders }), sessions)!.holders).toBe("Biggest: IntelliJ IDEA 3.2G · Docker VM · Rancher 3G · work › content-api 1.5G");
    expect(nudgeModel(notice({}), sessions)!.holders).toBe("");
  });

  test("blinks until acknowledged", () => {
    expect(nudgeModel(notice({}), sessions)!.blinking).toBe(true);
    expect(nudgeModel(notice({ acked: true }), sessions)!.blinking).toBe(false);
  });
});
