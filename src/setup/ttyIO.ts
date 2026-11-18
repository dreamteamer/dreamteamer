import readline from "node:readline/promises"
import type { SetupIO } from "./types.ts"

// ---- the verb -----------------------------------------------------------------------------------

/** The terminal's prompt and y/n, on one readline — `dt setup` and `dt install` share it. */
export function ttyIO(): SetupIO & { close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return { prompt: ttyPrompt(rl), ask: ttyAsk(rl), close: () => rl.close() }
}

/** an EOF (Ctrl-D) at a prompt is no answer — the input stays missing (exit 3), the action declined — never a crash */
const question = async (rl: readline.Interface, text: string): Promise<string> => {
  try {
    return (await rl.question(text)).trim()
  } catch {
    return ""
  }
}

const ttyPrompt =
  (rl: readline.Interface): SetupIO["prompt"] =>
  async (input, def) => {
    const hint = def !== undefined ? ` [${def}]` : input.required ? " (required)" : " (enter to skip)"
    const answer = await question(rl, `${input.prompt ?? input.title ?? input.id}${hint}: `)
    return answer === "" ? def : answer
  }

const ttyAsk =
  (rl: readline.Interface): SetupIO["ask"] =>
  async (action, kinds) => {
    const effects = (action.effects ?? []).map(e => `${e.kind}: ${e.detail}`).join("\n    ")
    const answer = (
      await question(rl, `${action.title} — ${kinds.join(", ")}\n    ${effects}\n  run it? [y/N] `)
    ).toLowerCase()
    return answer === "y" || answer === "yes"
  }
