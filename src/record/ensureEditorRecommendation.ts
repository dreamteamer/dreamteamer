import path from "node:path"
import fs from "node:fs"
import { EDITOR_RECOMMENDATIONS } from "./workspace.ts"

export function ensureEditorRecommendation(
  root: string,
  warn: (message: string) => void = console.warn
): "written" | "present" | "left" | "merged" {
  const file = path.join(root, ".vscode", "extensions.json")
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ recommendations: EDITOR_RECOMMENDATIONS }, null, "\t") + "\n")
    return "written"
  }
  const text = fs.readFileSync(file, "utf8")
  const missing = EDITOR_RECOMMENDATIONS.filter(id => !text.toLowerCase().includes(id.toLowerCase()))
  if (!missing.length) return "present"
  const ids = missing.join(", ")
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    warn(
      `⚠ .vscode/extensions.json does not recommend ${ids} and is not plain JSON, so it was left alone — add ${missing.length > 1 ? "the ids" : "the id"} to its "recommendations" by hand`
    )
    return "left"
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`⚠ .vscode/extensions.json is not an object — left alone; add ${ids} to "recommendations" by hand`)
    return "left"
  }
  parsed.recommendations = [...(Array.isArray(parsed.recommendations) ? parsed.recommendations : []), ...missing]
  fs.writeFileSync(file, JSON.stringify(parsed, null, "\t") + "\n")
  return "merged"
}
