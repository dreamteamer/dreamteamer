import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier/flat"
import tseslint from "typescript-eslint"

export default defineConfig(
  { ignores: ["node_modules", "eslint.config.js"] },
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  {
    // the suites read the CLI's JSON output and call node:test's `test` without awaiting it
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  prettier,
)
