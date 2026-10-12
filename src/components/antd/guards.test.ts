import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DARK, LIGHT } from "./AntdProvider";

// Things that must stay true however the screens change: the colours are the app's own, Ant Design's styles sit under Tailwind's utilities,
// and no Ant Design code is ever pulled into the part of the app that takes alerts and trades.

const root = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const walk = (dir: string): string[] =>
  readdirSync(path.join(root, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
const sources = (dir: string) => walk(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));

describe("the colours", () => {
  const css = read("src/app/globals.css");
  const block = (selector: string) => {
    const m = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
    return Object.fromEntries([...(m?.[1] ?? "").matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
  };

  it("light: Ant Design's colours are the ones in globals.css", () => {
    const v = block(":root");
    expect(LIGHT.token).toMatchObject({
      colorPrimary: v.accent,
      colorSuccess: v.up,
      colorError: v.down,
      colorBgBase: v.surface,
      colorBgLayout: v.bg,
      colorTextBase: v.text,
      colorTextSecondary: v.muted,
      colorTextTertiary: v.faint,
      colorBorder: v.border,
    });
  });

  it("dark: the same, from the .dark colours", () => {
    const v = block(".dark");
    expect(DARK.token).toMatchObject({
      colorPrimary: v.accent,
      colorSuccess: v.up,
      colorError: v.down,
      colorBgBase: v.surface,
      colorBgElevated: v["surface-2"],
      colorBgLayout: v.bg,
      colorTextBase: v.text,
      colorTextSecondary: v.muted,
      colorTextTertiary: v.faint,
      colorBorder: v.border,
    });
  });
});

describe("styles", () => {
  it("Ant Design's layer sits between Tailwind's base and its utilities, declared before Tailwind is imported, so a Tailwind class always wins", () => {
    const css = read("src/app/globals.css");
    const order = css.indexOf("@layer theme, base, antd, components, utilities;");
    expect(order).toBeGreaterThanOrEqual(0);
    expect(order).toBeLessThan(css.indexOf('@import "tailwindcss"'));
  });

  it("the whole app is inside the Ant Design provider, which puts its styles in that layer", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("<AntdProvider>");
    expect(layout.indexOf("<AntdProvider>")).toBeLessThan(layout.indexOf("<AppShell>"));
    expect(read("src/components/antd/AntdProvider.tsx")).toMatch(/<AntdRegistry layer>/);
  });
});

describe("the part of the app that takes alerts and trades never loads Ant Design or any screen", () => {
  const pull = /from\s+["'](antd|antd\/[^"']*|@ant-design\/[^"']*|@\/components\/[^"']*|react-dom[^"']*)["']/;
  it.each(["src/lib", "src/app/api", "src/app/hook"])("%s", (dir) => {
    let files: string[] = [];
    try {
      files = sources(dir);
    } catch {
      /* a folder that doesn't exist has nothing in it */
    }
    const offenders = files.filter((f) => pull.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it("and neither does the gate in front of the app", () => {
    expect(read("src/proxy.ts")).not.toMatch(pull);
  });
});

describe("buttons", () => {
  it("no plain <button> is still styled with the old button classes (only a link may be)", () => {
    const offenders = sources("src").filter((f) => /<button[^>]*buttonClass/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
