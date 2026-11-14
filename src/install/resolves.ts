import fs from "node:fs"

// ---- the impure half: observe this checkout, run the plan, print the board -----------------

// ⚠ BOTH OF THESE FOLLOW SYMLINKS, and that is the whole point. A DANGLING link is exactly what a
// moved or deleted primary leaves behind, and it is the one state where "there is a symlink here"
// and "this checkout has the file" disagree. Reading it as present would print `✔ linked to the
// primary` over a file that cannot be opened — the board lying about the one step nobody eyeballs.
// So: present means it RESOLVES, and a link counts as a link only when it resolves too.
export const resolves = (p: string): boolean => fs.existsSync(p)
