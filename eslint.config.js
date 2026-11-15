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
  },
  // The tests are checked permissively (tsconfig.test.json): they are not the engine, and a test may
  // poke at shapes the public types deliberately do not offer. test/types/consumer.ts is excluded — it
  // is the public-API contract and keeps the strict rules above.
  {
    files: ["test/**/*.ts"],
    ignores: ["test/types/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-this-alias": "off",
      "no-empty": "off",
      "no-unused-vars": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-async-promise-executor": "off",
      "prefer-const": "off",
    },
  }
)
