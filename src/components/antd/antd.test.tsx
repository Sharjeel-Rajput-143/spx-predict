import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Btn, Checkbox, Drawer, Dropdown, InfoTip, Modal, OnOffSwitch, Pill, Switch, TextPromptModal, Toasts } from "@/components/automation/bot/primitives";
import { Card, Segmented } from "@/components/ui";
import { AntdProvider, DARK, LIGHT } from "./AntdProvider";

// The shared UI pieces, now Ant Design's. Server-render tests: no browser, no network. (What a click does is Ant Design's own, and was
// checked in a real browser: a panel opening, Escape closing the top one first, a dropdown closing on a click elsewhere, a toast.)

const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const noop = () => undefined;

describe("buttons", () => {
  it("primary is the blue solid button, danger the red one, secondary the plain outlined one", () => {
    const classes = (out: string) => (out.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(classes(html(<Btn kind="primary">Go</Btn>))).toEqual(expect.arrayContaining(["ant-btn-primary", "ant-btn-color-primary", "ant-btn-variant-solid"]));
    expect(classes(html(<Btn kind="danger">Delete</Btn>))).toEqual(expect.arrayContaining(["ant-btn-primary", "ant-btn-dangerous", "ant-btn-variant-solid"]));
    expect(classes(html(<Btn kind="secondary">Cancel</Btn>))).toEqual(expect.arrayContaining(["ant-btn-default", "ant-btn-variant-outlined"]));
    expect(classes(html(<Btn>Plain</Btn>))).toContain("ant-btn-default"); // secondary is the default
    expect(classes(html(<Btn>Plain</Btn>))).not.toContain("ant-btn-primary");
  });

  it("is a plain button that submits nothing unless it is told to", () => {
    expect(html(<Btn>Go</Btn>)).toContain('type="button"');
    expect(html(<Btn type="submit">Go</Btn>)).toContain('type="submit"');
  });

  it("keeps what it is given: the label, disabled, a title, an aria-label and extra classes (so a Tailwind class can still size it)", () => {
    const out = html(<Btn kind="primary" disabled title="Not yet" aria-label="Save it" className="w-full px-8">Save</Btn>);
    expect(out).toContain("<span>Save</span>");
    expect(out).toContain('disabled=""');
    expect(out).toContain('title="Not yet"');
    expect(out).toContain('aria-label="Save it"');
    expect(out).toMatch(/class="[^"]*\bw-full\b[^"]*\bpx-8\b/);
  });

  it("an enabled button has no disabled attribute", () => {
    expect(html(<Btn onClick={noop}>Go</Btn>)).not.toContain("disabled");
  });
});

describe("cards", () => {
  it("is Ant Design's card with no padding of its own, so a screen's own padding class is the only padding, as before", () => {
    const out = html(<Card className="p-4 space-y-2">Body</Card>);
    expect(out).toContain("ant-card");
    expect(out).toContain('class="ant-card-body" style="padding:0"');
    expect(out).toMatch(/class="[^"]*\bp-4\b[^"]*\bspace-y-2\b/);
    expect(out).toContain("Body");
  });
});

describe("switches", () => {
  it("are real switches that say whether they are on, and what they are for", () => {
    const on = html(<Switch on onChange={noop} label="Bot on/off" />);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Bot on/off"');
    expect(html(<Switch on={false} onChange={noop} label="x" />)).toContain('aria-checked="false"');
  });
  it("can be disabled", () => {
    expect(html(<Switch on onChange={noop} label="x" disabled />)).toMatch(/<button[^>]*disabled/);
  });
  it("the ON/OFF switch spells the state out inside it", () => {
    const off = html(<OnOffSwitch on={false} onChange={noop} label="Kill switch" />);
    expect(off).toContain("ON");
    expect(off).toContain("OFF");
    expect(off).toContain('aria-checked="false"');
    expect(html(<OnOffSwitch on onChange={noop} label="Kill switch" />)).toContain('aria-checked="true"');
  });
});

describe("status labels", () => {
  it.each([
    ["ok", "ant-tag-success"],
    ["error", "ant-tag-error"],
    ["warn", "ant-tag-warning"],
    ["info", "ant-tag-processing"],
    ["skip", "ant-tag-filled"],
    ["neutral", "ant-tag-filled"],
  ] as const)("%s is drawn as %s", (tone, cls) => {
    const out = html(<Pill tone={tone}>label</Pill>);
    expect(out).toContain(cls);
    expect(out).toContain(">label<");
  });
});

describe("checkbox, segmented control, help icon", () => {
  it("a checkbox shows its label and whether it is ticked", () => {
    expect(html(<Checkbox checked onChange={noop} label="Show tags" />)).toMatch(/ant-checkbox-checked[\s\S]*Show tags/);
    expect(html(<Checkbox checked={false} onChange={noop} label="Show tags" />)).not.toContain("ant-checkbox-checked");
  });
  it("the segmented control lists every option and marks the chosen one", () => {
    const out = html(<Segmented options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} value="b" onChange={noop} />);
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out.match(/ant-segmented-item-selected/g)?.length).toBeGreaterThan(0);
    expect(out).toMatch(/ant-segmented-item-selected[^>]*>[\s\S]*?Beta/);
  });
  it("the (i) icon carries its explanation for a screen reader and a keyboard, before anyone hovers", () => {
    const out = html(<InfoTip text="Gross wins divided by gross losses." />);
    expect(out).toContain('aria-label="Gross wins divided by gross losses."');
    expect(out).toContain("<svg");
  });
});

describe("dropdown", () => {
  it("is shut until it is opened: the trigger shows, the menu does not, and the trigger is told so", () => {
    const seen: boolean[] = [];
    const out = html(
      <Dropdown trigger={({ open, toggle }) => (seen.push(open), (<button onClick={toggle}>Open</button>))}>{() => <div>THE MENU</div>}</Dropdown>,
    );
    expect(out).toContain("Open");
    expect(out).not.toContain("THE MENU");
    expect(seen).toEqual([false]);
  });
});

describe("panels, on a server render", () => {
  it("a side panel is a dialog named after its title, with its buttons, body and footer", () => {
    const out = html(<Drawer title="Position details" onClose={noop} headerActions={<button>Extra</button>} footer={<button>Save</button>}>BODY</Drawer>);
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-label="Position details"');
    expect(out).toContain('aria-label="Close"');
    expect(out).toContain("Extra");
    expect(out).toContain("BODY");
    expect(out).toContain("Save");
  });
  it("a side panel has a back arrow only when it has somewhere to go back to", () => {
    expect(html(<Drawer title="T" onClose={noop}>x</Drawer>)).not.toContain('aria-label="Back"');
    expect(html(<Drawer title="T" onClose={noop} onBack={noop}>x</Drawer>)).toContain('aria-label="Back"');
  });
  it("a dialog is named after its title and has its body, a close button and its footer", () => {
    const out = html(<Modal title="Close this position?" onClose={noop} footer={<button>Confirm</button>}>Are you sure</Modal>);
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-label="Close this position?"');
    expect(out).toContain('aria-label="Close"');
    expect(out).toContain("Are you sure");
    expect(out).toContain("Confirm");
    expect(html(<Modal title="T" onClose={noop}>x</Modal>)).not.toContain("<footer>");
  });
  it("the one-line prompt shows its label, its value and a Save that is off while it is empty", () => {
    const out = html(<TextPromptModal title="New account" label="Name" initial="" onSubmit={noop} onClose={noop} />);
    expect(out).toContain("New account");
    expect(out).toContain("Name");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*><span>Save<\/span>/);
    expect(html(<TextPromptModal title="T" label="Name" initial="Paper" onSubmit={noop} onClose={noop} />)).not.toMatch(/<button[^>]*disabled=""[^>]*><span>Save<\/span>/);
    expect(html(<TextPromptModal title="T" label="Name" initial="" allowEmpty onSubmit={noop} onClose={noop} />)).not.toMatch(/<button[^>]*disabled=""[^>]*><span>Save<\/span>/);
  });
  it("toasts draw nothing until there is something to say, and don't fail on a server render", () => {
    expect(() => html(<Toasts items={[]} onDismiss={vi.fn()} />)).not.toThrow();
    expect(() => html(<Toasts items={[{ id: 1, tone: "ok", text: "Saved" }]} onDismiss={vi.fn()} />)).not.toThrow();
  });
});

describe("the provider", () => {
  it("shows what it wraps, and its light and dark themes both use the app's colours", () => {
    expect(html(<AntdProvider><p>inside</p></AntdProvider>)).toContain("inside");
    expect(LIGHT.token?.colorPrimary).toBe(DARK.token?.colorPrimary); // the blue is the same in both
    expect(LIGHT.token?.colorBgBase).not.toBe(DARK.token?.colorBgBase);
  });
});
