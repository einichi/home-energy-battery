import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "data/**", "package-lock.json"],
  },
  js.configs.recommended,
  {
    // Node-side code: CLI, server, tests, and tooling config.
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Browser-side code has no Node globals; it runs as an ES module in the page.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  prettier,
];
