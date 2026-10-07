import crypto from "node:crypto";

/** A user's id is a reference other records carry. It comes from the email, so it is the same on every machine and every
 * restart, and nothing has to be looked up to know whose a record is. */
export const userIdForEmail = (email: string): string => `u_${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;

/** The email of the one login set in the environment (APP_LOGIN_EMAIL); "operator" when none is set, as in the session cookie. */
export const ownerEmail = (): string => (process.env.APP_LOGIN_EMAIL ?? "").trim().toLowerCase() || "operator";

/** The owner: the login from the environment. Records with no user id (made before users existed) belong to it. */
export const ownerUserId = (): string => userIdForEmail(ownerEmail());
