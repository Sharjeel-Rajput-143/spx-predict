import "server-only";
import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF-hardening for user-supplied webhook URLs. Two layers:
 *  1. reject obviously-private hosts/IP literals outright (localhost, 127/8,
 *     RFC1918 ranges, link-local) before ever making a request.
 *  2. resolve the hostname and reject if it points at a private address.
 *
 * This is deliberately not full DNS-rebinding protection (which needs to
 * pin the resolved IP for the actual request, not just re-check it here) -
 * a reasonable middle ground given this only ever POSTs a small JSON body
 * to a URL the user explicitly typed in, and never follows redirects
 * (see webhookQueue.ts's `redirect: "manual"`).
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return false;
}

export type UrlCheck = { ok: true } | { ok: false; reason: string };

export function isWellFormedHttpsUrl(rawUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Webhook URLs must start with https://." };
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) return { ok: false, reason: "That host isn't allowed." };
  if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) return { ok: false, reason: "That host isn't allowed." };
  return { ok: true };
}

/** Full check including a DNS lookup - use before saving and again right before delivery. */
export async function isSafeWebhookUrl(rawUrl: string): Promise<UrlCheck> {
  const basic = isWellFormedHttpsUrl(rawUrl);
  if (!basic.ok) return basic;

  const { hostname } = new URL(rawUrl);
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.length === 0) return { ok: false, reason: "Could not resolve that host." };
    if (records.some((r) => isPrivateIp(r.address))) {
      return { ok: false, reason: "That host resolves to a private address and isn't allowed." };
    }
  } catch {
    return { ok: false, reason: "Could not resolve that host." };
  }
  return { ok: true };
}
