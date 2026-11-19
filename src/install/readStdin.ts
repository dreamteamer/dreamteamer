import fs from "node:fs"

// A hook is not a person: it does not type a target, it hands the engine a JSON object on stdin and
// reads whatever comes back on stdout. Two of this file's verbs grow that form, and one function
// parses the payload for both.

/**
 * The hook's payload, read to EOF. fd 0 rather than a stream, because every caller here is
 * synchronous and a hook's stdin is a pipe that the harness closes.
 *
 * ⚠ A TTY DOES NOT COME BACK EMPTY — IT BLOCKS FOREVER (measured). `readFileSync(0)` on a terminal
 * waits for an EOF the operator has no reason to know he must send, so `dt install --hook` typed
 * by hand hung silently with no prompt and no output: the worst failure shape a CLI has, because
 * there is nothing to read and nothing to search for. So the terminal case is refused BEFORE the
 * read. `isTTY` is a parameter so the refusal can be tested without a pty. A closed or unreadable
 * descriptor still comes back empty, and `readHookInput` names that one.
 */
export function readStdin(isTTY: boolean = process.stdin.isTTY): string {
  if (isTTY) throw new Error("--hook reads the harness's JSON on stdin — nothing is piped")
  try {
    return fs.readFileSync(0, "utf8")
  } catch {
    return ""
  }
}
