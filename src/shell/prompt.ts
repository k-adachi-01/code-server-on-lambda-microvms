// Confirmation prompt (shell, R10.1–R10.5). Uses node:readline/promises
// directly (no prompt library). The TTY flag and the underlying ask function
// are injectable so tests never touch a real terminal.

import { createInterface } from "node:readline/promises";

export interface ConfirmDeps {
  /** Whether stdin is an interactive terminal. */
  isTTY: boolean;
  /** `--yes` was passed (treat the prompt as approved, R10.4). */
  assumeYes: boolean;
  /** Ask a yes/no question and resolve to the raw answer. Injected in tests. */
  ask?: (question: string) => Promise<string>;
}

/**
 * Ask the user to confirm an action.
 *
 * - `--yes` => approved without prompting (R10.4).
 * - non-TTY without `--yes` => rejected (caller exits 2, R10.5).
 * - TTY => prompt; only "y"/"yes" (case-insensitive) approves.
 */
export async function confirm(message: string, deps: ConfirmDeps): Promise<boolean> {
  if (deps.assumeYes) return true;
  if (!deps.isTTY) return false;

  const ask =
    deps.ask ??
    (async (q: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    });

  const answer = (await ask(`${message} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
