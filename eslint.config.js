// ESLint — the recommended rules of ESLint and typescript-eslint, over everything this repo runs.
// Formatting is Prettier's (.prettierrc), never a lint rule.
//
// Plain JavaScript on purpose: ESLint loads a .js config natively, while a .ts config needs either an
// extra package (jiti) or an unstable CLI flag — and the VS Code extension passes neither, so a .ts
// config lints from `npm run lint` and silently not at all in the editor. Type-checked via `checkJs`.
import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig(
  { ignores: ["dist/", ".build/", "node_modules/", "test/.tmp/", "test/.perf/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } } },
  // `const { omitted, ...rest } = x` is how a key is dropped, and a leading `_` (`for (const _ of it)`)
  // says unused on purpose — neither is an unused variable
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  }
)
