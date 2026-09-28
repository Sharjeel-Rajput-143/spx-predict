import "server-only";
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
let warned = false;

function getKey(): Buffer {
  const secret = process.env.ALERTS_ENCRYPTION_KEY;
  if (!secret) {
    if (!warned) {
      console.warn(
        "[automations] ALERTS_ENCRYPTION_KEY is not set - using an insecure, hard-coded dev key. " +
          "Set a real secret before storing any real webhook URL.",
      );
      warned = true;
    }
    return crypto.createHash("sha256").update("spx-predict-dev-only-insecure-key").digest();
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/** AES-256-GCM, stored as "iv:authTag:ciphertext" (all base64). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** "https://app.optionalpha.com/hook/••••••17" - same convention Option Alpha itself uses. */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments.pop() ?? "";
    const visibleTail = last.slice(-2);
    const maskedLast = visibleTail ? `••••••${visibleTail}` : "••••••";
    const prefix = segments.length ? `/${segments.join("/")}` : "";
    return `${u.protocol}//${u.host}${prefix}/${maskedLast}`;
  } catch {
    return "••••••";
  }
}
