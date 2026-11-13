// ESLint — the recommended rules of ESLint and typescript-eslint, over everything this repo runs.
// Formatting is Prettier's (.prettierrc), never a lint rule.
import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/", ".build/", "node_modules/", "test/.tmp/", "test/.perf/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
