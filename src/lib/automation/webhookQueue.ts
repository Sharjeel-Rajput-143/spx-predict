/**
 * The order in which webhook calls reach the engine. A call whose live price is not known yet is answered at once and finishes its price lookup behind the answer;
 * without a line to stand in, a later call (whose price was already there) could reach the engine first and the two signals would run in the wrong order: a flip
 * run backwards. So every call of a bot that cannot go straight in waits its turn here, and a call that can go straight in only does so when nobody is waiting.
 *
 * A turn is only the price lookup and the saving of the signal; the engine's own work (the orders) follows behind in the bot's lock, which keeps that order too.
 * On globalThis because Next compiles each route as its own copy of this code, and the line has to be one line.
 */
const g = globalThis as typeof globalThis & { __webhookArrival?: Map<string, { tail: Promise<void>; waiting: number }> };
const lines = (g.__webhookArrival ??= new Map<string, { tail: Promise<void>; waiting: number }>());

/** True when no call of this bot is waiting for its turn, so a call may go straight in without overtaking one. */
export const arrivalIdle = (botId: string): boolean => (lines.get(botId)?.waiting ?? 0) === 0;

/** Runs `turn` after every earlier call of this bot has had its turn. Never rejects: a turn that fails is reported by `onError` and the line goes on. */
export function enqueueArrival(botId: string, turn: () => Promise<void>, onError: (err: unknown) => void = (err) => console.error("[automation] a webhook call failed behind its answer", err)): Promise<void> {
  const line = lines.get(botId) ?? { tail: Promise.resolve(), waiting: 0 };
  lines.set(botId, line);
  line.waiting++;
  const run = line.tail
    .then(turn)
    .catch(onError)
    .finally(() => {
      line.waiting--;
    });
  line.tail = run;
  return run;
}

/** For tests: forget every line. */
export const __resetArrival = (): void => lines.clear();
