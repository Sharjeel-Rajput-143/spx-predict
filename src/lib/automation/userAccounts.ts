import "server-only";
import { userIdForEmail } from "@/lib/auth/users";
import { usersStore } from "./store";
import type { User } from "./types";

/** Notes a sign-in in `users`: the row is made the first time, and its last sign-in time kept up to date. Everything the user
 * creates afterwards points at this row by its id. */
export function recordSignIn(email: string, now: number = Date.now()): User {
  const normalised = email.trim().toLowerCase();
  const id = userIdForEmail(normalised);
  const existing = usersStore.get(id);
  if (existing) return usersStore.update(id, { email: normalised, lastLoginAt: now }) ?? existing;
  return usersStore.insert({ id, email: normalised, createdAt: now, lastLoginAt: now });
}
