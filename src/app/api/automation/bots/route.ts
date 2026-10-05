import { NextRequest, NextResponse } from "next/server";
import { cloneBot, createBot, createEmptyBot, createFromTemplate, getBotStaticConfig, isKnownBot, validateInputs } from "@/lib/automation/bots";
import { badRequest, guarded, readJson, unauthorized } from "@/lib/automation/routeAuth";
import { listAccounts, summarizeAllBots } from "@/lib/automation/summary";
import { templatesStore } from "@/lib/automation/store";
import type { BotInputs, BotSafeguards } from "@/lib/automation/types";

export async function GET(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return NextResponse.json({ bots: summarizeAllBots(), accounts: listAccounts(), templates: templatesStore.all().sort((a, b) => b.createdAt - a.createdAt) });
}

/**
 * Create a bot. `mode` picks how:
 *  - "empty":    name + account + allocation only (it can't trade until its inputs are set)
 *  - "clone":    copy of `sourceId`, with its own name/account/allocation
 *  - "template": from `templateId`, with its own name/account/allocation
 *  - omitted:    explicit full `inputs` (every trading input required)
 */
export async function POST(req: NextRequest) {
  const denied = unauthorized(req);
  if (denied) return denied;
  return guarded(async () => {
    const body = await readJson(req);
    const basics = {
      name: String(body.name ?? ""),
      accountId: String(body.accountId ?? ""),
      allocationLimit: Number(body.allocationLimit),
      group: typeof body.group === "string" ? body.group : null,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    };
    const created = (id: string) => NextResponse.json({ bot: { id, name: basics.name || getName(id) } }, { status: 201 });

    if (body.mode === "empty") return created(createEmptyBot(basics).id);
    if (body.mode === "template") return created(createFromTemplate(String(body.templateId ?? ""), basics).id);
    if (body.mode === "clone") {
      const sourceId = String(body.sourceId ?? "");
      if (!isKnownBot(sourceId)) return badRequest("The bot to clone doesn't exist.", 404);
      if (!basics.name.trim()) return badRequest("Name is required.");
      return created(cloneBot(sourceId, { name: basics.name, accountId: basics.accountId || undefined, allocationLimit: Number.isFinite(basics.allocationLimit) ? basics.allocationLimit : undefined }).id);
    }

    const inputs = body.inputs as BotInputs | undefined;
    if (!inputs || typeof inputs !== "object") return badRequest("inputs are required.");
    const problem = validateInputs(inputs);
    if (problem) return badRequest(problem);
    const bot = createBot({ inputs, group: basics.group, tags: basics.tags, safeguards: (body.safeguards as BotSafeguards | undefined) ?? undefined });
    return created(bot.id);
  });
}

function getName(id: string): string {
  try {
    return getBotStaticConfig(id).name;
  } catch {
    return id;
  }
}
