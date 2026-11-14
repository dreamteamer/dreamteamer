import { scaffoldKey } from "./scaffoldKey.ts"

export function readmeText({
  id,
  pkgName,
  description,
  extension,
}: {
  id: string
  pkgName: string
  description?: string | true
  extension?: boolean
}): string {
  const key = scaffoldKey(id)
  return [
    `# ${pkgName}`,
    "",
    description || "A dreamteamer module.",
    "",
    "```bash",
    `dt install ${pkgName}`,
    ...(extension ? [`dt setup ${id} --input token=<token>   # writes ${key} into .env`] : []),
    "```",
    "",
    "## Developing it",
    "",
    "```bash",
    "dt compile && dt status                  # the inline module is live in this workspace",
    "npm test                                 # node --test on dreamteamer/testing",
    `dt check modules/${id} --alone            # exit 0: publishable`,
    "```",
    "",
    "Writing a module: the `using-dreamteamer` skill, references/writing-a-module.md.",
    "",
  ].join("\n")
}
