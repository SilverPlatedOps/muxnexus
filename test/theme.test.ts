import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveAppearance, THEME_KEY } from "../src/client/theme";

test("the address wins, then the saved choice; system follows the OS; nothing saved stays dark", () => {
  expect(resolveAppearance(null, null, false)).toBe("dark");
  expect(resolveAppearance("light", null, true)).toBe("light");
  expect(resolveAppearance("dark", null, false)).toBe("dark");
  expect(resolveAppearance("system", null, false)).toBe("light");
  expect(resolveAppearance("system", null, true)).toBe("dark");
  expect(resolveAppearance("light", "dark", false)).toBe("dark");
  expect(resolveAppearance("dark", "light", true)).toBe("light");
  // Anything else in either place is ignored.
  expect(resolveAppearance("sepia", null, false)).toBe("dark");
  expect(resolveAppearance("system", "system", false)).toBe("light");
});

/** The script in index.html's head, which paints the appearance before the app's code loads. */
function headScript(): string {
  const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const inline = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(inline).toHaveLength(1);
  // Before the stylesheet, or the first paint is in the wrong colours.
  expect(head.indexOf("<script>")).toBeLessThan(head.indexOf('href="./style.css"'));
  return inline[0]![1]!;
}

test("index.html's head script picks what resolveAppearance picks", () => {
  const code = headScript();
  expect(code).toContain(JSON.stringify(THEME_KEY));
  const run = new Function("location", "localStorage", "matchMedia", "document", code);
  for (const saved of [null, "dark", "light", "system", "sepia"]) {
    for (const asked of [null, "dark", "light", "system"]) {
      for (const osDark of [true, false]) {
        const root = { dataset: {} as Record<string, string> };
        run(
          { search: asked ? `?theme=${asked}` : "" },
          { getItem: (k: string) => (k === THEME_KEY ? saved : null) },
          (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" ? osDark : false }),
          { documentElement: root },
        );
        expect(`${saved} ${asked} ${osDark} -> ${root.dataset.theme}`).toBe(`${saved} ${asked} ${osDark} -> ${resolveAppearance(saved, asked, osDark)}`);
      }
    }
  }
});

test("index.html's head script still paints when storage throws: dark, or what the address asks", () => {
  const run = new Function("location", "localStorage", "matchMedia", "document", headScript());
  for (const [search, want] of [["", "dark"], ["?theme=light", "light"]] as const) {
    const root = { dataset: {} as Record<string, string> };
    run({ search }, { getItem: () => { throw new Error("private window"); } }, () => ({ matches: false }), { documentElement: root });
    expect(root.dataset.theme).toBe(want);
  }
});
