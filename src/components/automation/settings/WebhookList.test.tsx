import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditWebhookDrawer, NewWebhookDrawer, WebhookIntro, WebhookRow } from "./WebhookList";
import { WebhooksSection, type SettingsData, type WebhookView } from "./sections";

const noop = () => undefined;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

const hook = (over: Partial<WebhookView> = {}): WebhookView => ({
  id: "wh-1",
  name: "BullishNDX",
  path: `/hook/${"•".repeat(12)}c0de`,
  attached: true,
  botId: "ndx_ema_bias",
  botName: "NDX Bias Bot",
  underlying: "NDX",
  direction: "bullish",
  active: true,
  createdAt: 1,
  lastTriggeredAt: null,
  triggerCount: 0,
  ...over,
});
const settings = { webhook: { path: "/api/webhook/tradingview", secretSet: true, bots: [] }, executor: { venue: "mock" } } as unknown as SettingsData;

describe("Settings > Webhooks, laid out like Option Alpha's", () => {
  it("opens with what a webhook is, the once-a-minute rule, and the keep-it-secret box", () => {
    const out = html(<WebhookIntro />);
    expect(out).toContain("Webhooks allow you to trigger automations in your bots");
    expect(out).toContain("Each webhook can be triggered a maximum of 1 time per minute. Calls made more than once per minute are ignored.");
    expect(out).toContain("Keep your webhooks secret and safe.");
    expect(out).toContain("public version control repositories");
  });

  it("has a New Webhook button, and no inline create form any more", () => {
    const out = html(<WebhooksSection data={settings} origin="http://localhost:3000" hooks={[]} />);
    expect(out).toContain(">New Webhook<");
    expect(out).not.toContain("Create webhook");
    expect(out).not.toContain("A call means");
    expect(out).not.toContain("No webhooks yet");
  });

  it("New Webhook is a slide-over with Name, its helper line, and Create", () => {
    const out = html(<NewWebhookDrawer onCreate={async () => null} onClose={noop} />);
    for (const t of ["New Webhook", "Name", "You&#x27;ll use this name to reference it in your bots.", ">Create<", 'role="dialog"']) expect(out, t).toContain(t);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Create<\/button>/); // nothing typed yet
  });

  it("each webhook shows its name, Test Hook, a pencil, Usages, and the URL line with a copy icon (masked)", () => {
    const out = html(<WebhookRow hook={hook()} origin="http://localhost:3000" onEdit={noop} onDelete={noop} testSlot={<span>TEST-FORM</span>} />);
    expect(out).toContain("BullishNDX");
    expect(out).toContain(">Test Hook<");
    expect(out).toContain('aria-label="Edit BullishNDX"');
    expect(out).toContain("Usages:");
    expect(out).toContain("1 bot");
    expect(out).toContain("Attached to the Bullish trigger of NDX Bias Bot");
    expect(out).toContain("URL:");
    expect(out).toContain("http://localhost:3000/hook/••••••••••••c0de");
    expect(out).toContain('aria-label="Copy webhook URL"');
    expect(out).not.toContain("TEST-FORM"); // the test form opens on click
    expect(out).toContain('aria-label="Delete BullishNDX"'); // a trash can even while it is in use: deleting detaches it first
  });

  it("an unused webhook shows 'Usages: 0 bots', a grey Test Hook that isn't a button, and a trash can", () => {
    const out = html(<WebhookRow hook={hook({ attached: false, botId: null, botName: null, direction: null })} origin="" onEdit={noop} onDelete={noop} />);
    expect(out).toContain("0 bots");
    expect(out).not.toContain("<details");
    expect(out).toMatch(/<span class="text-sm text-faint"[^>]*>Test Hook<\/span>/);
    expect(out).not.toMatch(/<button[^>]*>Test Hook<\/button>/);
    expect(out).toContain('aria-label="Delete BullishNDX"');
  });

  it("the pencil opens Edit Webhook: rename, and switch on or off (delete is the trash can on its row)", () => {
    const out = html(<EditWebhookDrawer hook={hook()} onRename={async () => null} onToggle={noop} onClose={noop} />);
    for (const t of ["Edit Webhook", 'value="BullishNDX"', ">Save<", ">Switch off<"]) expect(out, t).toContain(t);
    expect(out).not.toContain(">Delete<");
    expect(html(<EditWebhookDrawer hook={hook({ active: false })} onRename={async () => null} onToggle={noop} onClose={noop} />)).toContain(">Switch on<");
  });

  it("the list never contains a full token", () => {
    const out = html(<WebhooksSection data={settings} origin="http://localhost:3000" hooks={[hook(), hook({ id: "wh-2", name: "BearishNDX", direction: "bearish" })]} />);
    expect(out).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe("light mode is the default", () => {
  it("the page starts light, and only a saved 'dark' choice (made with the theme button) switches it", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('style={{ colorScheme: "light" }}');
    expect(layout).not.toMatch(/<html[^>]*className="dark"/);
    expect(layout).toContain('localStorage.getItem("spx-predict:theme")==="dark"');
    const provider = read("src/components/GameProvider.tsx");
    expect(provider).toContain('useState<Theme>("light")');
    expect(provider).not.toContain("setTheme(saved.theme)"); // the old auto-saved "dark" is ignored
    expect(provider).toContain("localStorage.setItem(THEME_KEY, next)");
  });
});
